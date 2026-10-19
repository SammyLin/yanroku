# Build spec (contract between files)

Go 1.26, single binary, `package main` at repo root, module `yanroku` (app renamed from noteapp to Tally). Go-ified from a Python prototype (kept at `$SCRATCH/py-ref/` during initial build for porting prompts and ACP details).

Deps (keep to these):
- `modernc.org/sqlite` (pure Go, driver name `sqlite`)
- `github.com/k2-fsa/sherpa-onnx-go-macos` (speaker diarization, prebuilt dylibs, cgo)
- stdlib for everything else (net/http ServeMux patterns, embed, encoding/json, os/exec, log/slog).

External tools: `ffmpeg`, `whisper-cli` (brew whisper-cpp, Metal GPU).

## Files and ownership

| File | Owns |
|---|---|
| `config.go` | DONE, do not edit: `Config`, `loadConfig()`, `loadDotEnv(path)`. |
| `main.go` | CLI (calls `loadDotEnv(".env")` then `loadConfig()`): `yanroku` / `yanroku serve [-addr 127.0.0.1:8000]`, `yanroku ingest <folder>`, `yanroku models` (download models). |
| `db.go` | Open SQLite (`DATA_DIR/noteapp.db`, WAL, foreign_keys, busy_timeout 5000), schema init, `*sql.DB` shared (safe across goroutines; `SetMaxOpenConns(1)` acceptable). |
| `api.go` | HTTP handlers, `//go:embed static` UI, `/media/{id}` via `http.ServeFile` (Range). |
| `worker.go` | Single worker goroutine: queue polling, startup reset, runs `process` / `summarize`. |
| `pipeline.go` | `process(ctx, id)`: ffmpeg, STT, diarize, merge, cleanup, title. `summarize(...)`. Templates, languages, prompts. |
| `stt.go` | `type Segment struct{Start, End float64; Text string}`; `transcribeLocal(ctx, wav) ([]Segment, error)` (whisper-cli) and `transcribeGroq(ctx, wav) ([]Segment, error)`; selected by `STT_PROVIDER`. |
| `diarize.go` | `diarize(wavPath string) ([]Turn, error)` with `Turn{Start, End float64; Speaker int}` via sherpa-onnx; `assignSpeakers(segs, turns)`. |
| `models.go` | `downloadModels`: whisper ggml + sherpa-onnx diarization models, skip if present, download to tmp then rename. |
| `acp.go` | `acpAsk` (see signatures). |
| `*_test.go` | One small test per non-trivial pure function (segment splitting / speaker assignment, .env parsing, ACP message loop against a fake agent script). |
| `static/index.html` | UI (already written; keep API contract so it works unchanged). |

## Go signatures (cross-file contract)

```go
// pipeline.go
func process(ctx context.Context, db *sql.DB, cfg Config, id int64) error
func summarize(ctx context.Context, db *sql.DB, cfg Config, recID int64, templateID, lang string) (string, error)
type Template struct{ ID, Name, Prompt string }
type Language struct{ ID, Name string }
var templates []Template // [{meeting, 會議摘要, ...}]
var languages []Language
// stt.go
type Segment struct{ Start, End float64; Text string } // seconds
func transcribe(ctx context.Context, cfg Config, wavPath string) ([]Segment, error) // dispatches on cfg.STTProvider
// diarize.go
type Turn struct{ Start, End float64; Speaker int }
func diarize(cfg Config, wavPath string) ([]Turn, error) // returns nil, nil when disabled or models missing (log once)
func assignSpeakers(segs []Segment, turns []Turn) []int     // speaker index per segment; all 0 when turns empty
func splitCollapsed(cfg Config, wavPath string, segs []Segment, spk []int) []int // 1 speaker found → 2-means on per-sentence embeddings; split only if clearly apart
// models.go
func downloadModels(ctx context.Context, cfg Config) error // idempotent; whisper + sherpa-onnx models into DataDir/models
// acp.go
func acpAsk(ctx context.Context, cfg Config, prompt string) (string, error)
// db.go
func openDB(dataDir string) (*sql.DB, error)
```

## Config (env / `.env`)

| Var | Default | Meaning |
|---|---|---|
| `DATA_DIR` | `data` | storage root |
| `STT_PROVIDER` | `local` | `local` (whisper-cli) or `groq` |
| `WHISPER_MODEL` | `$DATA_DIR/models/ggml-large-v3-turbo.bin` | ggml model for whisper-cli |
| `WHISPER_LANG` | `zh` | `auto` for detection |
| `GROQ_API_KEY` | – | required when `STT_PROVIDER=groq` |
| `GROQ_MODEL` | `whisper-large-v3` | or `whisper-large-v3-turbo` |
| `DIARIZE` | `1` | `0` disables (single speaker) |
| `NUM_SPEAKERS` | `0` | 0 = auto (clustering threshold) |
| `ACP_AGENT` | `claude-agent-acp` | shlex-ish split on spaces |

`.env.example` documents all of these. `.env` is gitignored.

## Storage layout

```
data/
  noteapp.db
  models/                 whisper ggml + sherpa-onnx diarization models (yanroku models downloads them)
  rec/<id>/source.<ext>   original upload
  rec/<id>/audio.wav      16 kHz mono s16 PCM for STT/diarization
  rec/<id>/play.m4a       AAC 64k mono for browser playback
  acp/                    cwd for ACP agent sessions
```

## Schema

```sql
CREATE TABLE IF NOT EXISTS recordings(
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  filename TEXT NOT NULL,          -- original filename
  duration_s REAL,
  status TEXT NOT NULL DEFAULT 'queued',  -- queued|converting|transcribing|cleaning|done|error
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS speakers(
  id INTEGER PRIMARY KEY,
  recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  label TEXT NOT NULL,             -- SPEAKER_00 from pyannote, or 'custom'
  display_name TEXT NOT NULL       -- default: 'Speaker 1', 'Speaker 2' ...
);
CREATE TABLE IF NOT EXISTS people(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  last_used_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS segments(
  id INTEGER PRIMARY KEY,
  recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  speaker_id INTEGER REFERENCES speakers(id),
  text_raw TEXT NOT NULL,
  text_clean TEXT                  -- NULL until cleanup; UI falls back to text_raw
);
CREATE INDEX IF NOT EXISTS seg_rec ON segments(recording_id, start_ms);
CREATE TABLE IF NOT EXISTS summaries(
  id INTEGER PRIMARY KEY,
  recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,
  language TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',  -- queued|running|done|error
  content_md TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## Pipeline (`process`)

Updates `recordings.status`; idempotent (delete this recording's segments/speakers before insert, in one tx). Returns error on failure (worker sets status=error + message).

1. `converting`: one ffmpeg call → `audio.wav` (16k mono s16) + `play.m4a`; duration from wav size.
2. `transcribing`:
   - local: `whisper-cli -m $WHISPER_MODEL -f audio.wav -l zh --prompt "<Traditional Chinese prompt>" -oj -of <tmp>` (plus `-ml`/`-sow` or token-level JSON `-ojf` as needed to get sentence-sized segments with good timestamps; pick flags by testing). Parse JSON `transcription[].offsets.from/to` (ms) + `text`.
   - groq: ffmpeg split `audio.wav` into ≤10 min FLAC 16k mono chunks (< 25 MB), POST each to `https://api.groq.com/openai/v1/audio/transcriptions` (multipart: file, model, language, prompt, `response_format=verbose_json`, `timestamp_granularities[]=segment`), offset segment times by chunk start, retry 429/5xx with backoff honoring `retry-after`.
   - Split long segments at `。！？!?` proportionally by character position if no finer timestamps (keep it simple).
   - diarize (if `DIARIZE=1` and models present, else single speaker): sherpa-onnx OfflineSpeakerDiarization (pyannote segmentation-3.0 onnx + 3D-Speaker/NeMo embedding onnx), clustering threshold ~0.5 unless NUM_SPEAKERS>0. Assign each segment the speaker with max time overlap; no overlap → nearest turn.
   - Files over 30 min are diarized in 30 min chunks (sherpa clusters all ~1 s windows at once, O(n²) memory); chunk speakers are linked to global ones by cosine of a ≤60 s embedding (> 0.5 joins). Samples are read from `audio.wav` on demand, not via `sherpa.ReadWave` (which holds the file twice).
   - Insert speakers (display_name `Speaker N` by first appearance, label `SPEAKER_00`...) and segments (`text_raw`).
3. `cleaning`: ACP cleanup in batches of ~60 lines `"<segment_id>\t<text>"` (+ a few read-only context lines); prompt: fix punctuation and obvious ASR errors, convert to Traditional Chinese (台灣用語), keep English, never merge/split lines; parse by id, tolerate code fences; failures are logged, non-fatal. Port prompts from py-ref/pipeline.py.
4. Auto title via ACP (≤ 20 chars, zh-TW), only if title still equals filename stem; non-fatal.
5. `done`.

`summarize(ctx, recordingID, templateID, language) (string, error)`: transcript `[mm:ss] Name: text` (clean fallback raw) → template prompt → markdown.
Templates: `meeting` = 會議摘要. Languages: `zh-TW` 繁體中文（台灣）, `en` English, `ja` 日本語.

## ACP client (`acpAsk`)

Port of py-ref/acp.py (tested working with claude-agent-acp 0.37.0): JSON-RPC 2.0 newline-delimited over stdio; `initialize` (protocolVersion 1, fs read/write false, terminal false) → `session/new` {cwd, mcpServers: [], `_meta` that disables tools, replaces system prompt, and skips loading user `~/.claude` settings — copy exactly from py-ref} → `session/prompt`. Accumulate `agent_message_chunk` text; done on prompt response; stopReason != end_turn → error. Agent requests: `session/request_permission` → cancelled; others → -32601. Drain stderr (keep tail for errors). Kill process on return (exec.CommandContext + timeout). Global mutex serializes calls. Prepend "Answer directly... do not use tools" line.

## API (`api.go`)

All JSON. Static: `GET /` → `static/index.html`; `GET /media/{id}` → `play.m4a` with HTTP Range support (Starlette FileResponse).

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/recordings?q=&trash=0` | list: `{id,title,filename,duration_s,status,error,created_at,deleted_at,has_summary}` newest first; `q` matches title or segment text |
| POST | `/api/recordings` | multipart `files` (multiple) → `[{id,...}]`, each saved to `data/rec/<id>/source.<ext>`, status queued |
| GET | `/api/recordings/{id}` | `{recording, speakers:[{id,label,display_name}], segments:[{id,start_ms,end_ms,speaker_id,text_raw,text_clean}], summaries:[...]}` |
| PATCH | `/api/recordings/{id}` | `{title?}` rename |
| DELETE | `/api/recordings/{id}` | soft delete (set deleted_at); `?purge=1` hard delete + files (409 while uploading/converting/transcribing/cleaning) |
| POST | `/api/recordings/{id}/restore` | clear deleted_at |
| POST | `/api/recordings/{id}/retranscribe` | status → queued; 409 unless status is done/error |
| PATCH | `/api/segments/{id}` | `{text}` → sets text_clean |
| POST | `/api/segments/{id}/speaker` | `{name, scope: "segment"\|"all"}`. `all`: update that speaker's display_name. `segment`: find speaker in same recording with that display_name, else create one (label 'custom'); repoint segment. Both upsert `people(name)` last_used_at. Returns full detail like GET recording. |
| GET | `/api/people` | recently used names, `[name]` by last_used_at desc, limit 20 |
| GET | `/api/templates` | `{templates:[{id,name}], languages:[{id,name}]}` |
| POST | `/api/recordings/{id}/summaries` | `{template_id, language}` → creates summary row status queued, returns it |
| DELETE | `/api/summaries/{id}` | delete |

Worker (`worker.go`): one goroutine started on serve. Loop: pick oldest `recordings.status='queued' AND deleted_at IS NULL` → `process`; else oldest `summaries.status='queued'` → run summarize; else sleep 2 s. On startup, reset recordings in converting/transcribing/cleaning → queued and summaries running → queued. ponytail: single worker; STT saturates GPU anyway.

CLI: `yanroku ingest <folder>` — recursively register audio/video files (by extension) not already ingested (match on original filename + size), copy into data/rec, status queued. `noteapp serve [-addr 127.0.0.1:8000]` (default when no args). `yanroku models` downloads missing models into data/models (whisper ggml-large-v3-turbo from huggingface ggerganov/whisper.cpp, sherpa-onnx segmentation + embedding models from k2-fsa GitHub releases).

## UI (`static/index.html`)

Own visual design. Clean, neutral, CJK-friendly font stack, light/dark via `prefers-color-scheme`.

- Left: library list (title, datetime, duration mm:ss / h:mm:ss, status badge, summary icon), search box, "All / Trash" toggle. Poll list every 3 s while any item not done/error.
- Import: button + whole-window drag-drop, `<input type=file multiple accept="audio/*,video/*,.ogg,.opus,.oga,.rmvb,.rm,.divx,.ts,.m2ts,.3gp,.f4v,.asr">`, upload progress via XHR.
- Detail: title (click to rename), ⋯ menu (Re-transcribe, Move to trash / Restore, Delete forever in trash). Tabs: Transcript | Summary.
- Transcript tab: `<audio>` with custom controls (play/pause, −15 s, +15 s, speed 0.75–2×, seekable progress, time). Banner "Transcript cleaned up · View original" toggles raw/clean. Segments list: `mm:ss · Speaker` + text; active segment highlighted on `timeupdate` and scrolled into view (unless user scrolled recently); click segment text → seek `start_ms/1000` and play. Hover: edit (inline contenteditable → PATCH) and copy icons.
- Speaker popover (native `<dialog>` or positioned div): input, recently used names (click fills), radios this segment / all segments (default all), Cancel/Save → POST, re-render from response. Speaker colors stable per speaker_id.
- Summary tab: template select + language select (default zh-TW) + "Generate"; list of summaries with status; render markdown with `marked` from `https://cdn.jsdelivr.net/npm/marked/marked.min.js`, sanitize by escaping HTML before (set `marked` to not render raw HTML). Poll while queued/running. Copy button.
- Status of processing shown in detail when not done.

## Folders (notes directory) — decided 2026-09-30

Nested tree, each recording in at most one folder (NULL = 未分類). Build into the cloud version (web/ D1 + UI).

```sql
CREATE TABLE folders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(parent_id, name)            -- note: NULL parent_ids are not unique in SQLite; enforce top-level uniqueness in code
);
ALTER TABLE recordings ADD COLUMN folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL;
```

Semantics:
- Deleting a folder deletes its subfolders; recordings inside (any depth) move to 未分類 (not trash). UI confirms with count.
- Moving a folder under itself or a descendant → 400 (check ancestry with a recursive CTE).
- Folder view lists recordings in that folder only; 全部 lists all non-trashed; 最近 = all non-trashed, newest first, limit 50; 未分類 = folder_id IS NULL.

API:
| Method | Path | Body / result |
|---|---|---|
| GET | `/api/folders` | flat list `[{id,parent_id,name,count}]` (count = direct non-trashed recordings); UI builds the tree |
| POST | `/api/folders` | `{name, parent_id?}` |
| PATCH | `/api/folders/{id}` | `{name?, parent_id?}` rename / move (parent_id null = top level) |
| DELETE | `/api/folders/{id}` | see semantics |
| GET | `/api/recordings?folder=<id>\|none&view=recent` | filters added to existing list endpoint |
| PATCH | `/api/recordings/{id}` | also accepts `{folder_id}` (null = 未分類) |

UI: sidebar sections 最近 / 全部 / 未分類 / folder tree (expand/collapse, state remembered in localStorage) / 垃圾桶. Folder context menu: 新增子資料夾, 重新命名, 刪除. Recording ⋯ menu: 移到資料夾 (tree picker). Drag a recording onto a folder to move it; drag a folder onto another to nest it. Breadcrumb above the list for the current folder.

Ingest: `runner ingest <dir>` maps each file's relative subdirectory path to a folder path (create missing folders, reuse existing by name at each level); files directly in `<dir>` go to 未分類.

## Cloud version (records.3mi.ai) — decided 2026-09-30, SUPERSEDES the local server parts above

Data lives on Cloudflare; processing on one or more Macs ("runners": this Mac + home Mac, both Apple Silicon). The local SQLite server (runner/api.go, db.go, worker.go) is removed; schema, API shapes and pipeline semantics above still apply, now served by the Worker.

### web/ (Cloudflare Worker, TypeScript)
- No framework; small hand-written router. Dev deps only: wrangler, @cloudflare/workers-types, typescript. Workers Paid plan.
- Bindings: D1 `DB` (database `noteapp`), R2 `AUDIO` (bucket `noteapp-audio`), static assets from `public/` with `run_worker_first: ["/api/*", "/media/*"]`. Custom domain route `records.3mi.ai`.
- Migrations in `web/migrations/` (0001 = schema above + folders + cloud columns). Use `AUTOINCREMENT` for recordings/segments/speakers/summaries ids (never reuse).
- Cloud columns on recordings: `source_key TEXT` (R2 key of original, deleted after processing), `play_key TEXT` (R2 key of play.m4a), `size INTEGER`, `upload_id TEXT`, `runner TEXT`, `lease_until TEXT`. Summaries also get `runner`, `lease_until`.
- R2 keys: `rec/<id>/source.<ext>`, `rec/<id>/play.m4a`.

### Auth (fail closed)
- Cloudflare Access app on records.3mi.ai: Google login allowing only your own email; one service token per runner (`Service Auth` policy). Configured by the user in the Zero Trust dashboard.
- Worker verifies `Cf-Access-Jwt-Assertion` on every /api and /media request (RS256 via WebCrypto, keys from `https://<ACCESS_TEAM>.cloudflareaccess.com/cdn-cgi/access/certs`, cached; check `aud` contains `ACCESS_AUD`, `exp`). Vars: `ACCESS_TEAM`, `ACCESS_AUD`. If unset → 503 for everything except static assets. Local dev only: `DEV_NO_AUTH=1` in `.dev.vars`.
- Browser identity = JWT `email`; runner identity = JWT `common_name` (service token client id). `/api/runner/*` accepts either (so it can be tested), but runner name comes from the request body.
- Multi-user schema (migration 0011, 2026-10-09): every table but `runners` has `user_id`; user handlers get `uid` and bind it in every statement (another user's row = 404); runner routes act on the job row's `user_id`. Self-host's entry (`src/index.ts`, `accessIdentify`) makes every Access-authenticated request user 1. Who the caller is comes from the entry's `identify` (see "Extending the server" below); `GET /api/config` is public. Tests: `npm run test:isolation` (two users via a fake-identity entry, every route), `npm run test:migrate` (0011 on self-host-shaped data).

### Extending the server (2026-10-11)
The server is a library plus a thin entry. `web/src/app.ts` exports `createWorker(opts)`, `routes` (core routes), `accessIdentify` and `listRunners`; `src/index.ts` is just `export default createWorker({ identify: accessIdentify })`. Another deployment (e.g. the hosted Yanroku Cloud, which pulls this repo in as a git submodule) writes its own entry:

```ts
export type Caller = { uid: number } | { runner: true };
export type Identify<E extends Env = Env> = (req: Request, env: E, path: string, ctx: ExecutionContext) => Promise<Caller | Response>;
export type Route<E extends Env = Env> = [method: string, path: RegExp, handler: Handler<E>];
export interface WorkerOptions<E extends Env = Env> {
  identify: Identify<E>;                          // who is calling; a Response (401/403/503) is returned as is
  extraRoutes?: Route<E>[];                       // matched BEFORE core routes: add routes or override one (same method + regex)
  config?: (env: E) => Record<string, unknown>;   // shallow-merged over GET /api/config {auth_mode:"access", app_name, extensions:[]}
  onScheduled?: ExportedHandler<E>["scheduled"];  // passed through as `scheduled`
}
export function createWorker<E extends Env = Env>(opts: WorkerOptions<E>): ExportedHandler<E>;
```

- Request order: `GET /api/config` (public) → `identify` → CSRF check (`Sec-Fetch-Site` cross-site/same-site on non-GET → 403) → route loop over `[...extraRoutes, ...routes]`; a handler gets `uid` (0 for `{runner:true}`), `HttpError` → its status, anything else → 500.
- `identify` must fail closed and must keep runner routes (`/api/runner/*`) and user routes apart: a runner credential is never a user and vice versa.
- Helpers for entries: `verifyRs256(token, jwksUrl, iss, now)` (`src/auth.ts`, RS256 via a JWKS URL; null on any failure), `sameSecret(a, b)` (`src/http.ts`, constant-time compare), `runIsolation(...)` (`test/isolation.ts`, run it with real tokens and pass the extra routes and their `cases`).
- UI extensions: `/api/config` `extensions` is a list of same-origin script paths (e.g. `["/cloud.js"]`; anything not starting with a single `/` is ignored). `index.html` loads them in order before starting the app, and exposes `window.yanroku`:

| Member | Meaning |
|---|---|
| `config` | the `/api/config` body (`auth_mode`, `app_name`, `extensions`, plus whatever the entry adds) |
| `hold()` | call synchronously while loading: the app does not start after the extensions load |
| `start()` | show `#app` and start the app (idempotent) |
| `hideApp()` | hide `#app` (e.g. while showing a sign-in page) |
| `setTokenProvider(fn)` | `async () => string \| null`; a token becomes `Authorization: Bearer` on every API call and upload part |
| `onUnauthorized(fn)` | called on any 401 instead of the default "登入已過期" alert |
| `h`, `$`, `showAlert`, `toast` | the page's DOM helpers |
| `t(zh, vars)` | UI string in the current language; keyed by the zh-Hant source, `{name}` placeholders, `{n\|one\|other}` plural; a missing key returns the zh source |
| `lang`, `locale` | `'zh-Hant' \| 'en' \| 'ja'` and its Intl locale (`zh-TW` / `en-US` / `ja-JP`) for dates and numbers |
| `setLang(lang)` | persist (`localStorage['yanroku.lang']`) and reload |
| `addMessages(lang, dict)` | add an extension's own strings: `addMessages('en', {'雲端方案': 'Cloud plan'})` |
| `applyI18n(root?)` | translate markup with `data-i18n` (text) / `data-i18n-placeholder` / `-title` / `-aria-label` (empty value = current text is the key) |

- UI language (`web/public/i18n.js`, loaded before the app and the extensions, so `t` works immediately): `?lang=` (persisted) → `localStorage['yanroku.lang']` → `navigator.languages` (zh* → zh-Hant, ja*, en*) → `en`. The picker is in 設定 › 介面. `localStorage['yanroku.i18nDebug']='1'` logs missing keys. Server strings and LLM prompts stay zh; a few Worker/runner messages the UI shows verbatim are in the dictionaries.

  The hashchange router does nothing while `#app` is hidden, so an extension that shows its own page owns the hash then. The header and nav each have an empty `<div data-user hidden>` slot for an account menu. Self-host lists no extensions, so the app starts as it always did.

### Uploads (R2 multipart through the Worker; no S3 keys needed)
Part size 50 MiB (last part smaller); Worker never buffers more than one part.
| Method | Path | Body / result |
|---|---|---|
| POST | `/api/uploads` | `{filename, size, folder_id?}` → creates recording (status `uploading`, title = filename stem), R2 multipart → `{recording_id, part_size}` |
| PUT | `/api/uploads/{recording_id}/{part}` | raw bytes of part (1-based) → `{etag}` |
| POST | `/api/uploads/{recording_id}/complete` | `{parts:[{part,etag}]}` → completes, status `queued` |
| DELETE | `/api/uploads/{recording_id}` | abort, delete row |
Old `POST /api/recordings` multipart is removed. UI uploads files sequentially-per-file with 3 parts in flight, retry each part up to 3×, progress per file.

`GET /media/{id}`: stream `play_key` from R2 with Range support (206, Content-Range, Accept-Ranges) — iOS Safari requires correct Range handling.

### Runner API (jobs with leases; multiple runners safe)
Lease 10 min, extended by heartbeat. A job whose lease expired is claimable again.
| Method | Path | Body / result |
|---|---|---|
| POST | `/api/runner/claim` | `{runner}` → atomically claims the oldest queued (or lease-expired in-progress) recording, else summary. `{job:null}` or `{job:{kind:"recording", id, filename, source_size}}` / `{job:{kind:"summary", id, recording_id, template_id, language, transcript}}` (transcript = `[mm:ss] Name: text` lines, built by Worker) |
| POST | `/api/runner/{kind}/{id}/heartbeat` | `{runner, status?}` → extends lease, sets status (converting/transcribing/cleaning); 409 if lease lost (runner must abort) |
| GET | `/api/runner/recordings/{id}/source` | streams original from R2 (Range ok) |
| PUT | `/api/runner/recordings/{id}/play` | streams play.m4a body; if > 90 MiB runner uses `?part=N` multipart form: `POST .../play/start`, `PUT .../play?part=N`, `POST .../play/complete` |
| POST | `/api/runner/recordings/{id}/transcript` | `{runner, duration_s, speakers:[{label,display_name}], segments:[{start_ms,end_ms,speaker:<index into speakers>,text_raw}]}` → replaces speakers+segments (D1 batch, chunked to stay under limits) → `{segment_ids:[...]}` in order |
| POST | `/api/runner/recordings/{id}/clean` | `{runner, items:[{id,text_clean}], title?}` (title only applied if still equal to filename stem) |
| POST | `/api/runner/recordings/{id}/done` | `{runner}` → status done, delete source from R2, clear lease |
| POST | `/api/runner/{kind}/{id}/fail` | `{runner, error}` → status error |
| POST | `/api/runner/summaries/{id}/result` | `{runner, content_md}` → done |
Runner still runs cleanup + title via local ACP between `transcript` and `done`, heartbeating.

### runner/ (Go)
- Config (`runner/.env`): `API_BASE=https://records.3mi.ai`（維護者的值；自架時必填自己的網址）, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` (sent as `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers), `RUNNER_NAME` (default hostname), plus the existing STT/diarize/ACP vars. `DATA_DIR` holds models and a work dir (`work/<id>/`, deleted after each job).
- Commands: `yanroku run` (default: loop claim → process → sleep 10 s when idle; graceful on SIGINT/SIGTERM: the current job gets 5 s, then is handed back with `POST /api/runner/{recordings|summaries}/{id}/defer` `{seconds:0}` so another runner picks it up at once; a crash is covered by the 10 min lease), `yanroku ingest <dir>` (upload via the multipart API; subfolder path → folder tree via folders API, reuse existing; skip files already uploaded by filename+size via `GET /api/recordings?filename=&size=`), `yanroku models`.
- Pipeline logic (ffmpeg, STT, diarize, split, cleanup batching/parsing, prompts, title) is reused; only DB access is replaced by HTTP calls.

### Web Push (decided 2026-10-07)
- `src/push.ts`, no dependencies: VAPID (RFC 8292, ES256) + `aes128gcm` (RFC 8291). Env: `VAPID_PUBLIC_KEY` (var, base64url uncompressed P-256 point), `VAPID_SUBJECT` (var), `VAPID_PRIVATE_KEY` (secret, base64url raw `d`). Keys unset → no-op, UI hides the toggle.
- Table `push_subscriptions` (migration 0008). `GET /api/push/key` → `{key|null}`, `POST /api/push/subscribe` (body = `PushSubscription.toJSON()`, upsert), `DELETE /api/push/subscribe` `{endpoint}`, `POST /api/push/test`.
- Runner `done` / `fail` / summary `result` → `ctx.waitUntil(notifyJob(...))` to every subscription; never fails the runner request; 404/410 deletes the subscription. Click opens `/#/rec/<id>[/summary]`.
- `public/sw.js` = push + notificationclick only (no caching). iOS needs the home-screen PWA (16.4+).

### UI (web/public/index.html)
- Everything above + folders (see Folders section) + mobile: works at 360 px; library becomes a drawer on narrow screens.
- Record button (MediaRecorder, mic): shows timer + level; on stop uploads via the multipart API (iOS gives audio/mp4, others audio/webm — keep the extension matching the mime). Keep screen awake during recording where supported (Wake Lock API).

## Voiceprints (cross-recording speaker identification) — decided 2026-09-30

Goal: once the user names a speaker, the same voice in later recordings is labelled automatically.

Model: sherpa-onnx speaker embedding already used for diarization (runner/diarize.go, 3D-Speaker CAM++). Embeddings are L2-normalized float arrays stored as JSON text.

Schema (migration 0004):
- `speakers`: add `embedding TEXT` (JSON array, NULL if unknown), `person_id INTEGER REFERENCES people(id) ON DELETE SET NULL`, `auto INTEGER NOT NULL DEFAULT 0` (1 = labelled by voiceprint match, not yet confirmed by the user; 2 = user renamed it to a default `Speaker N` name, i.e. rejected a match — never auto-labelled again).
- `voiceprints(id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE, speaker_id INTEGER NOT NULL UNIQUE REFERENCES speakers(id) ON DELETE CASCADE, embedding TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`.
- `people` rows are reused as persons (name UNIQUE already).

Enrolment (Worker):
- `POST /api/segments/{id}/speaker` with scope `all`: set that speaker's display_name, `person_id` = people(name), `auto=0`; if the speaker has an embedding, upsert its voiceprint (speaker_id unique → person_id, embedding). Renaming to a default-looking name (`Speaker N`) or a different person moves/deletes the voiceprint accordingly. Renaming to a default name sets auto=2. Scope `segment`: the target speaker (existing or new `custom`) gets person_id and auto=0; no voiceprint (no embedding, and backfill skips `custom` speakers). After either scope the recording is re-matched.
- Confirming an auto label = renaming (even to the same name) → auto=0 and enrol.

Matching (Worker, in `POST /api/runner/recordings/{id}/transcript` and after backfill):
- For each speaker of the recording that has an embedding and is not user-confirmed (auto=1, or auto=0 with a default name), score every person = max cosine over that person's voiceprints. Greedy assignment by score, each person at most once per recording. Accept if score ≥ `VOICE_MATCH_THRESHOLD` (var, default 0.75; calibrated on synthetic voices: same voice 0.93–0.96, similar macOS male voices 0.64–0.67, cross-gender ≤ 0.16 — retune on real recordings) and exceeds the runner-up person by ≥ 0.05. Accepted → display_name = person name, person_id, auto=1. Keep it in JS; 192–512 dims × a few hundred prints is trivial.
- Recording detail speakers include `person_id`, `auto`; never return embeddings to the browser.

Runner:
- After diarization, compute one embedding per speaker: mean of embeddings over up to ~60 s of that speaker's longest segments (reuse diarize.go's embedding helper), L2-normalized. Send as `speakers[].embedding` in the transcript POST. Single-speaker fallback still gets an embedding.
- New command `yanroku voiceprints` (backfill): for each done recording whose speakers lack embeddings, download `/api/runner/recordings/{id}/source` (serves play.m4a after the original is deleted), ffmpeg → 16k wav, compute per-speaker embeddings from its segments' time ranges, `POST /api/runner/recordings/{id}/speaker-embeddings {speakers:[{id, embedding}]}` (runner/Access auth, no lease). Worker stores them, enrols speakers whose display_name is not default (links/creates people by name), then re-runs matching for all recordings' unconfirmed speakers.

UI:
- Auto-labelled speaker shows a small「自動」tag next to the name (title: 依聲紋自動辨識，點擊可更正). Popover unchanged; saving confirms.
- Speaker popover "Recently used names" stays; no separate voiceprint management page yet.

## Speaker ID v2 — decided 2026-10-05, SUPERSEDES the Voiceprints model/threshold/runner parts above

Why: campplus scores the same person across recordings lower than two different people (Sammy rec 3 vs rec 8: 0.45), and sherpa over-segments (rec 8: 2 people → 55+ clusters), so prints come from fragments. Evidence: `/private/tmp/claude-501/tally-spk/REPORT.md`. Binary is `yanroku` (`runner/main.go`); commands below are `tally …` run from `runner/`.

### Models and model id
- Diarization keeps `3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx` (fast, ~1 s per audio-minute). Model id of embeddings made with it: `campplus-zh-cn` (legacy).
- Voiceprints (per-speaker embeddings, backfill) switch to `3dspeaker_speech_eres2net_large_sv_zh-cn_3dspeaker_16k.onnx`, 512 dims, ~111 MB, ~4.4 s per audio-minute. URL: `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_large_sv_zh-cn_3dspeaker_16k.onnx` (sic "recongition"). Model id: `eres2net-large-zh-cn`.
- Runner: `voiceModelURL` + `voiceModelPath(cfg)` (`DATA_DIR/models/<basename>`) next to `embModelURL`/`embModelPath`; `yanroku models` also fetches it. `speakerEmbeddings` and `yanroku voiceprints` use the voice model; `diarize`, `mergeTurns`, `splitCollapsed` keep campplus. Voice model missing → no embeddings (warn), job still succeeds.
- Worker constant `VOICE_MODEL = "eres2net-large-zh-cn"`. Embeddings are compared only when both have `emb_model = VOICE_MODEL`; anything else is stored but never matched, enrolled into matching, or suggested. An embedding posted without `emb_model` is `campplus-zh-cn` (the old home-macmini runner keeps working; its speakers simply get no auto labels until `yanroku voiceprints` re-embeds them).

### Runner → Worker
- `POST /api/runner/recordings/{id}/transcript`: `speakers[]` gains `emb_model` (string, required when `embedding` is set by a new runner). `embedding` = ONE L2-normalized mean per speaker: per-span embeddings (each span L2-normalized) averaged over **all** of the speaker's clean spans (`voiceSpans`: trim 0.25 s / 0.5 s, ≥ 1 s), longest first, capped at `voiceprintSec = 600` (bounds time on very long files), then L2-normalized. No per-segment lists.
- JSON compact: each float rounded to 4 decimals (`math.Round(v*1e4)/1e4`), ≈ 4 KB per speaker, far under D1's 2 MB/value. Worker rejects `embedding` length > 1024 or non-finite (tighten `isEmbedding`), `emb_model` longer than 64 chars.
- `POST /api/runner/recordings/{id}/speaker-embeddings`: items `{id, embedding, emb_model?}` (same defaulting). Worker never overwrites a speaker's `VOICE_MODEL` embedding with one of another model (`UPDATE … WHERE id=? AND recording_id=? AND (emb_model IS NOT ?current OR ?new = ?current)`), so an old runner cannot pollute.
- `GET /api/recordings/{id}` speakers gain `emb_model` (NULL when no embedding); keep `has_embedding` for old runners.

### Schema (migration 0005)
```sql
ALTER TABLE speakers ADD COLUMN emb_model TEXT;                          -- id of the model that made `embedding`
UPDATE speakers SET emb_model='campplus-zh-cn' WHERE embedding IS NOT NULL;
ALTER TABLE speakers ADD COLUMN suggest_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL;
ALTER TABLE speakers ADD COLUMN suggest_score REAL;
ALTER TABLE voiceprints ADD COLUMN emb_model TEXT NOT NULL DEFAULT 'campplus-zh-cn';
```
Multiple prints per person = one per enrolled speaker (unchanged, `speaker_id UNIQUE`); one print per speaker. Enrolment on rename is unchanged except `enrol` copies `emb_model` with `embedding` (insert and ON CONFLICT update). Only `auto=0`, non-default-named, non-`custom` speakers are ever enrolled; auto labels never become prints.

### Matching (Worker `rematch`/`matchSpeakers`)
- Candidates: speakers with `emb_model = VOICE_MODEL`, open = `auto=1`, or `auto=0` with a default `Speaker N` name. `auto=2` (rejected/dismissed) gets neither auto label nor suggestion.
- Prints: only `emb_model = VOICE_MODEL`. Person score = max cosine over that person's prints.
- Auto-label: top score ≥ `VOICE_MATCH_THRESHOLD` (var, **0.65**) and ≥ `MARGIN` (0.05) over the runner-up person; greedy by score, a person at most once per recording (persons confirmed in that recording are taken) → name, person_id, auto=1 (as today).
- Suggest: an open speaker NOT auto-labelled whose top person scores ≥ `VOICE_SUGGEST_THRESHOLD` (var, **0.50**) — including those blocked by threshold, margin or "person already used" — gets `suggest_person_id`, `suggest_score` (rounded to 2 decimals). All other speakers get both NULL. Rematch writes suggest columns only when they change (same guarded UPDATE).
- `wrangler.jsonc` vars: `VOICE_MATCH_THRESHOLD: "0.65"`, `VOICE_SUGGEST_THRESHOLD: "0.50"`. Starting values from 4 people; retune with more labels.
- Recording detail: `speakers[].suggest = {person_id, name, score} | null` (join people). Never return embeddings.

### UI
- Speaker with `suggest`: chip「可能是 X？」next to its name with ✓ and ✕.
  - ✓ = existing `POST /api/segments/{any segment of that speaker}/speaker` `{name: X, scope: "all"}` → confirms, enrols another print, rematches.
  - ✕ = same endpoint with `{name: <its current default name>, scope: "all"}` → auto=2 (existing semantics), suggestion cleared. No new endpoint.
- 「自動」tag for auto=1 unchanged.

### Backfill
- `yanroku voiceprints`: for done recordings, re-embed non-`custom` speakers whose `emb_model` ≠ `eres2net-large-zh-cn` (incl. none) using their current segments; POST with `emb_model`.
- `yanroku voiceprints --recompute`: same, but every non-`custom` speaker of every done recording.
- Worker (speaker-embeddings, unchanged flow): store, re-enrol the recording's confirmed speakers (auto=0, non-default name) with the new embedding — names untouched — then `rematch` all. Old-model prints stay but are ignored. Never renames confirmed speakers or deletes data.
- Rollout: migrate D1 + deploy Worker → build/restart this Mac's runner → `yanroku models` → `yanroku voiceprints --recompute`. Re-run `yanroku voiceprints` after home-macmini processes anything until it is updated.

### Diarization (runner/diarize.go)
- Keep sherpa FastClustering threshold 0.5, campplus.
- New `mergeTurns` after all chunks (replaces `linkSpeakers`): chunk-local labels become unique global labels (chunk index offset); embed each turn ≥ 1 s with the campplus extractor already open; cluster mean = duration-weighted sum of normalized turn embeddings; repeatedly merge the most similar pair of clusters while cosine > **0.5**; then fold every cluster with < **30 s** of turns into the most similar cluster ≥ 30 s (skip folding if none is ≥ 30 s). Turns of clusters with no ≥ 1 s turn are dropped (their segments take the nearest turn in `assignSpeakers`). Relabel 0..n-1 by first appearance. Cost ≈ 1 s per audio-minute. One test in `diarize_test.go` on synthetic vectors (merge + fold).
- `diarizeChunkSec = 15 * 60` (was 30 min; sherpa cost grows faster than length, merge links chunks).
- `NumThreads` = performance-core count (`sysctl hw.perflevel0.physicalcpu`, fallback 4) for segmentation and all extractors. Not `runtime.NumCPU()`: on a 4P+6E Mac, 10 onnxruntime threads made sherpa 4x slower than 4 (rec 3, 13 min: 274 s → 66 s for diarize + voiceprint, measured 2026-10-05). Sherpa itself costs ~3 s per audio-minute (sliding windows overlap), not ~1.
- `splitCollapsed` unchanged (only runs on a single-speaker result; not the slowness cause). Never run two runners or a runner + sweep on one Mac.
- Existing recordings keep their old speaker split (no re-diarization); `--recompute` only re-embeds.

## Ask (問問看) — decided 2026-10-07

Cross-recording Q&A: the user asks「志明上個月答應了什麼？」and gets a Markdown answer where every claim cites recording + timestamp. Personal scale (tens to a few hundred recordings): no embeddings, no vector DB; the runner's local LLM (ACP, like summaries) does retrieval in two steps.

### Schema (migration 0009)
`asks(id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT NOT NULL, answer_md TEXT, sources TEXT /* JSON array of recording ids used */, status TEXT NOT NULL DEFAULT 'queued' /* queued|running|done|error */, error TEXT, runner TEXT, lease_until TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`.

### Browser API (`web/src/ask.ts`)
| Method | Path | Body / result |
|---|---|---|
| POST | `/api/asks` | `{question}` (trimmed, 1–1000 chars) → `{id}` |
| GET | `/api/asks` | newest 50: `[{id, question, status, created_at, preview}]` (preview = answer start without citations/markdown, ≤ 120 chars, or null) |
| GET | `/api/asks/{id}` | full row, `sources` parsed, plus `recordings: [{id, title, deleted}]` for sources ∪ cited ids (purged ones absent) |
| DELETE | `/api/asks/{id}` | delete (a runner still working on it gets 409 on result = lease lost) |
| POST | `/api/asks/{id}/retry` | errored ask → queued; 409 otherwise |

### Runner API (`web/src/runner.ts`)
- `POST /api/runner/claim` claims asks FIRST (interactive, short), then recordings, then summaries; same lease semantics (10 min, heartbeat, lease-expired reclaim, defer, fail). Only runners that send `asks: true` get asks (an older runner would fail the unknown kind). Job: `{kind:"ask", id, question, today:"YYYY-MM-DD", index:[{id, title, date, duration_s, speakers:[names with segments], summary: first 300 chars of the newest done summary | null}]}` over all non-deleted done recordings, newest first. `today` and `date` are Taiwan local dates (`+8 hours`; no timezone setting yet).
- `GET /api/runner/asks/{id}/transcripts?ids=1,2,3&runner=<name>` (1–20 ids; runner must hold the lease, which this extends) → `[{id, title, date, transcript}]` in the requested order, skipping deleted/not-done ids; transcript = the summary job's `[mm:ss] Name: text` lines (mm may exceed 59).
- `POST /api/runner/asks/{id}/result` `{runner, answer_md, sources:[ids]}` → done.
- Heartbeat / fail / defer: the generic `/api/runner/{kind}/{id}/…` routes accept `ask(s)`.
- `GET /api/runners`: `queued.asks`; a runner's current job may be `{kind:"ask", id, status, title: question}`.

### Runner (`runner/ask.go`)
1. Prompt with today's date, the question and the index (one JSON line per recording) → LLM returns a JSON array of ≤ 8 ids, most relevant first. `parsePicked` takes the first JSON array in the reply (fences/prose tolerated; numbers, numeric strings or `{id}` objects), keeps only index ids, dedupes, caps at 8.
2. Fetch those transcripts; `fitBudget` keeps them in relevance order within 150k chars (CJK ≈ 1 token/char, stays inside a 200k-token context; dropped ids are logged; a single over-long first transcript is cut). Prompt: answer only from the transcripts, cite `[[<recording_id>@mm:ss]]` (or `h:mm:ss`) right after each claim, answer in the question's language, say plainly when not found. Nothing picked → step 2 still runs with "no relevant recordings" so the "not found" reply is in the question's language.
3. Post `answer_md` (fence-stripped) and `sources` = transcripts actually used.

### UI
- Sidebar「問問看」(message-circle-question icon) under 全部; route `#/ask[/<id>]`. The library pane lists past asks (newest first, status badge, answer preview); main has the question box (Enter sends, Shift+Enter newline), example questions, and the selected ask: question, date, then 排隊中 (with the no-runner notice) / 思考中 / error + 重試 / the answer, plus「參考錄音」chips. Polls every 3 s while any ask is queued/running.
- Citations render as chips「<recording title> mm:ss」linking to `#/all/rec/<id>`; the transcript seeks there (and scrolls to that segment) once it renders. Several ids in one bracket (`[[3@01:00, 4@02:00]]`) are accepted.

### Limits
- Step 1 sees only title, date, speakers and the summary start: a recording without a summary is found only by title/speaker/date. If recall is poor, add a transcript excerpt or a keyword pre-filter (SQL LIKE over segments) to the index.

## Vocabulary suggestions (詞彙建議) — decided 2026-10-07

`settings.vocab` is hand-maintained; the app learns candidates from the user's own transcripts and SUGGESTS them. It never changes `settings.vocab` by itself. Signals: cleanup fixes (`segments.text_raw` → `text_clean`, e.g.「德他」→「Delta」) and recurring proper nouns / jargon. Manual transcript edits are not logged (out of scope).

### Schema (migration 0010)
- `vocab_scans(id, from_id, to_id /* recording id range, inclusive */, status queued|running|done|error, error, runner, lease_until, created_at)`.
- `vocab_suggestions(term PK, misheard /* JSON array of raw variants */, kind product|company|person|term|other, hits, fixes, recordings, status new|added|dismissed, updated_at)`.

### Scheduling (inside claim, no cron)
- Only runners that send `vocab: true` see the kind; claimed last (after asks, recordings, summaries). An existing queued / lease-expired scan is claimed first; else one is created if due and claimed.
- Unscanned = done, non-deleted recordings with id > max(`to_id` of done scans) and below the lowest id still queued/processing (so a recording finishing late is not skipped). A scan takes the oldest 10.
- Due when ≥ 10 unscanned, or ≥ 1 and no done scan created in the last 24 h; never while a scan is queued/running, and not within 1 h of a failed scan (no retry storm). Scan times are `created_at` (scans take seconds).
- Same lease semantics as other kinds (10 min, heartbeat, defer, fail); a failed scan sends no push.

### Runner API
- Claim job: `{kind:"vocab", id, vocab:[settings.vocab], skip:[terms added/dismissed], recordings:[{id, title, diffs:[{raw, clean}], text}]}`. `diffs` = segments whose letters/digits differ after cleanup (whitespace/punctuation-only changes dropped), ≤ 150 per recording; `text` = cleaned transcript, ≤ 20k chars.
- `POST /api/runner/vocab/{id}/result {runner, terms:[{term, misheard, kind}]}`: terms ≤ 50 chars, misheard ≤ 10; upsert (misheard merged, status kept — added/dismissed never come back), then recount the touched terms over all non-deleted recordings: `hits` = segments whose cleaned text contains the term, `recordings` = distinct recordings among them, `fixes` = those whose raw text contains a misheard variant. Scan → done.
- `GET /api/runners`: `queued.vocab`; a runner's job may be `{kind:"vocab", id, status}` (UI「分析詞彙」).

### Browser API (`web/src/vocab.ts`)
| Method | Path | Body / result |
|---|---|---|
| GET | `/api/vocab/suggestions` | `{suggestions:[{term, misheard, kind, hits, fixes, recordings}], last_scan:{at, status, error}|null, pending}` — status new, hits > 0, not already in `settings.vocab`, by score `fixes*3 + hits + recordings*0.5`, ≤ 50 |
| POST | `/api/vocab/suggestions/add` | `{term}` → appended to the END of `settings.vocab` (409 at 200 terms), status added; returns settings |
| POST | `/api/vocab/suggestions/dismiss` | `{term}` → status dismissed |
| POST | `/api/vocab/scan` | queue a scan now (ignores the 10 / 24 h / 1 h thresholds); 409 if one is queued/running or nothing is unscanned |

Removing an added term from `settings.vocab` later leaves it `added` (no resurrection).

### Runner (`runner/vocab.go`)
One `acpAsk`: the diffs (all recordings) then the transcripts (sharing a 120k-char budget) → JSON array `[{term, misheard, kind}]`, ≤ 30, proper nouns / product, company, person names / jargon / mixed-language terms only. `parseVocab` takes the first JSON array of that shape (fences/prose tolerated), drops empty, > 50 chars, duplicates and terms in vocab/skip (case-insensitive).

### UI
Settings → 詞彙: a「建議加入」list above the vocab editor; each row = term + 「出現 N 次・M 份錄音・曾被聽成「…」」 with 加入 / 忽略, which act immediately (not part of 儲存). 加入 also appends the term to the open editor without touching other unsaved edits. Empty:「還沒有建議。累積更多錄音後會自動分析。」 Muted line: last scan time or error, then「立即分析」only when something is unscanned and no scan is running (「分析中…」while one is, polled every 5 s).

## Transfer (搬家: export / import) — decided 2026-10-17

Move an account between servers (Yanroku Cloud ⇄ self-host ⇄ self-host) with one zip, in 設定 › 搬家. Off unless the
Worker has `TRANSFER_ENABLED=1` (`wrangler.jsonc` vars / `.dev.vars`): off → every route below 404s and `GET /api/config`
reports `transfer: false`, which hides the section.

### Zip (`web/public/zip.js`, `web/public/transfer.js`)
STORE-only zip with zip64, built and read by the browser (Workers' CPU and 100 MB request limits rule out doing it here):
`manifest.json` (`format: "yanroku-export"`, `version: 1`, `exported_at`, `source` origin, `export_id`, `voice_model`,
`counts`), `data.json` (`folders`, `people` with their `voiceprints`, `settings` = stored keys only, `vocab` = decided
suggestions, `asks`, `recordings` = each one's export detail) and `audio/<old id>.m4a` (play.m4a). Ids are the old
server's. Exported: `status='done'` recordings outside the trash; unfinished ones come back as `left_out` and are listed.
`import_key` = `"<source origin>#<old id>"`, kept when an imported recording is exported again.

### Schema (migration 0012)
`recordings.import_key` (unique per user). Status `importing` = an imported row whose play.m4a isn't complete: hidden
from `GET /api/recordings` and folder counts, never claimed by a runner, refused by `POST /api/uploads/:rid/complete`.

### Browser API (`web/src/transfer.ts`, pure rules in `transfer-merge.ts`)
- `GET /api/export` → manifest + folders, people (+ voiceprints), settings, vocab, asks, `recordings: [{id, import_key,
  size, title}]`, `left_out`. `GET /api/export/recordings/:id` → recording, speakers (with embedding), segments, done
  summaries (404 unless done and not trashed). Audio: `GET /media/:id`.
- `POST /api/import/meta` `{manifest, folders, people, settings, vocab}` → `{folders: {old: new}, people: {old: new}}`;
  400 before any write when the manifest isn't ours / version ≠ 1. Folders merge by (parent, name), people by name,
  settings only for keys the account hasn't set (`me` mapped, `vocab` union capped at 200), vocab decisions only for
  new terms.
- `POST /api/import/recordings` `{recording, speakers, segments, summaries, folder_id, people, voiceprints, size}` →
  `{skipped: true, recording_id}` when that `import_key` is already done; a leftover `importing` row is removed and
  redone; otherwise rows go in as `importing` with an R2 multipart upload at `u/<uid>/rec/<rid>/play.m4a` →
  `{recording_id, part_size}`. Parts: `PUT /api/uploads/:rid/:part`.
- `POST /api/import/recordings/:rid/complete` `{parts}` → `play_key` set, `status='done'` (never queued: no runner, no
  Cloud minutes).
- `POST /api/import/asks` `{asks, recordings: {old: new}}` → done asks with `sources` and `[[id@mm:ss]]` citations
  remapped (unmapped ids dropped); an ask with the same question and time is skipped.
- Ids from the client are only used when they are the caller's (folders, people, recordings).

### Tests
`node test/transfer.test.ts` (switch + merge rules), `node test/zip.test.ts`, `sh test/transfer.sh` (routes end to end
on a Worker with and without the switch, then `public/transfer.js` export → import → interrupted → re-run), and the new
routes' cases in `test/isolation.ts`.
