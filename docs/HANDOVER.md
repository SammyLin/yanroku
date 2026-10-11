# Handover: Self-hosted AI Voice Notes App

> Context doc for Claude Code: goals, decisions and feature spec, 2026-09-30.

## Decisions (answered 2026-09-30)

1. Scope: **personal tool**, single user, no auth/billing.
2. Build vs fork: **from scratch** (OSS projects used as reference only).
3. STT: **local whisper.cpp (`whisper-cli`, Metal) + sherpa-onnx diarization** (no HF token needed); **Groq** Whisper API as alternative (`STT_PROVIDER=groq`).
4. LLM: **local agent over ACP** (Agent Client Protocol, default `claude-agent-acp`).
5. Hosting: **local single Go binary**, files on disk. Language: **Go** (changed from Python 2026-09-30).

## Product direction (2026-10-08)

- Name: **Yanroku 言錄**. History: Tally → Kiroku 記錄 (2026-10-08) → **Yanroku 言錄** (2026-10-11), because the kiroku domains were taken; 言 in the name now matches the 言 in the logo (sound wave flowing into 言, unchanged). Domain yanroku.app (hosted Cloud + app); records.3mi.ai is the owner's self-host. Internal names — `tally` runner binary, launchd label `ai.3mi.tally-runner`, bundle ids `ai.3mi.tally(.share)`, App Group, Xcode targets `Tally` / `KirokuShare`, Workers `noteapp` / `kiroku-cloud`, D1/R2 names — unchanged.
- Repo split (2026-10-11): this public repo (`SammyLin/yanroku`, history carried over from `SammyLin/tally`) is the self-hostable server: Worker (Access mode) + web app + migrations + runner + self-host docs. The iOS app and the hosted Yanroku Cloud (sign-in, multi-user hosting, billing, landing page) live in a private repo that pulls this one in as a git submodule and builds its own Worker entry with `createWorker` (docs/SPEC.md "Extending the server"). Self-host stays the single-user setup in docs/SETUP.md / docs/SELF-HOST.md.

## 1. Goal

Build a web app that takes many audio/video files → transcribes with speaker diarization → lets the user name speakers and play back in sync → generates template-based AI summaries → supports Q&A across all recordings.

Own brand and visual design; existing voice-recorder apps are a feature reference only.

## 3. Feature spec

### 3.1 Library
- Recent files, All files, Unfiled, Trash, folders, search, rename, move to folder.
- List item shows title, datetime, duration, and a status icon (e.g. summary generated).

### 3.2 Import
- "Add audio" → Start recording | Import audio.
- Import dialog: click or drag-drop, **multiple files** (`<input type=file multiple accept="audio/*,video/*,.ogg,.opus,.oga,.rmvb,.rm,.divx,.ts,.m2ts,.3gp,.f4v,.asr">`).
- Max 24 h per file. Accepts video (audio extracted).

### 3.3 Recording detail: three tabs + a "+"
**Transcript**
- Audio player: progress bar, back 15 s / forward 15 s, playback speed.
- Banner: "Transcript cleaned up. **View original**" → store both the raw STT output and the LLM-cleaned version.
- Segments: `timestamp · speaker name` + text. Hovering shows edit-text and copy icons.
- **Speaker rename popover** (click the speaker label):
  - text input + "Recently used names" list
  - radio: *Apply to this segment* / *Apply to all segments from this speaker* (default)
  - Cancel / Save
- File ⋯ menu: Move to folder, **Re-transcribe**, **Name speakers** (bulk), Move to Trash.
- **Edit audio**: waveform editor (later).

**Highlights** — timestamped key moments; click seeks (later).

**Summary**
- Template-based markdown summary; template picker + output language → "Generate now".
- One recording can hold several summaries (one per template).

### 3.4 Ask (global Q&A, RAG, cite recording + timestamp) — later
### 3.5 Template Community — later
### 3.6 AutoFlow / Integrations / Share / Export — later
### 3.7 Billing — out of scope (personal tool)

## 5. Architecture (as built)

See `docs/SPEC.md`.

### Data model (minimum)
- `recordings` (id, title, duration_s, source_uri, status, created_at, deleted_at)
- `speakers` (id, recording_id, label e.g. "SPEAKER_00", display_name)
- `people` (id, name, last_used_at) → "Recently used names"
- `segments` (id, recording_id, start_ms, end_ms, speaker_id, text_raw, text_clean)
  - "Apply to all segments from this speaker" = update `speakers.display_name`
  - "Apply to this segment" = repoint that segment to a different `speaker_id`
- `summaries` (recording_id, template_id, language, content_md, created_at)

## 6. Reference OSS projects

| Repo | Why it matters | Stack | License |
|---|---|---|---|
| murtaza-nasir/speakr | Closest full feature set | Flask + Vue 3 | AGPLv3 — do not copy code |
| rishikanthc/scriberr | Diarization, synced playback, summaries | Go + TS; WhisperX | MIT |
| skyhong2002/localplaud | Whisper + pyannote local pipeline | Python | MIT |
| JoshTickles/openplaud | Speaker naming UI, wavesurfer | Next.js | AGPL-3.0 — do not copy code |

## 7. MVP (milestone 1)

1. Multi-file drag-drop upload + job queue + status list.
2. STT with diarization → transcript view with player sync and click-to-seek.
3. Speaker rename popover (this segment / all segments) + recently used names.
4. One summary template, with language selection (default: Traditional Chinese).
5. Batch run over a local folder of existing recordings.

Later: highlights, template library, global Ask (RAG), audio trim editor, AutoFlow rules, folders, integrations.

## 8. Acceptance checks for the MVP
- Upload 10 mixed files (mp3, m4a, mp4) in one go; all reach "done" without manual retries.
- Segments carry correct start/end times; clicking a segment seeks within ±0.5 s.
- Renaming a speaker "for all segments" updates every segment instantly and survives reload.
- A 60+ minute Mandarin recording produces a readable Traditional Chinese summary.
