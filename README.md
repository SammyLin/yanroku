<p align="center"><img src="web/public/icon.svg" width="72" alt=""></p>

<h1 align="center">Yanroku 言錄</h1>

<p align="center">The self-hostable server of Yanroku 言錄, AI voice notes: record or import audio, get a speaker-labelled transcript you can play back in sync, and template-based summaries — written by the Claude Code or Codex you already pay for, with no separate API bill.<br>Yanroku 言錄的自架伺服器：錄音或匯入音訊，轉成分講者、可同步播放的逐字稿，再用你自己的 Claude Code 或 Codex 訂閱產生摘要，不用另外付 AI API 費用。</p>

<p align="center">Don't want to run a server? The hosted <b>Yanroku Cloud</b> and the iOS app are at <a href="https://yanroku.app">yanroku.app</a>. The app also connects to a server you host from this repo.</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/screenshot-dark.png">
  <img src="docs/images/screenshot-light.png" alt="Yanroku: transcript view with speaker timeline">
</picture>

## Features

- **Import anything** — drag in many audio/video files at once, or record in the browser (phone too). Large files upload in parallel parts with retries.
- **Transcripts with speakers** — local `whisper.cpp` (Metal) or Groq Whisper, plus `sherpa-onnx` speaker diarization.
- **Synced playback** — click any line to play from there; the seek bar shows who speaks when.
- **Name speakers once** — rename a speaker for one segment or all of them; voiceprints recognise the same person in later recordings.
- **Summaries and Ask on your own AI subscription** — transcript clean-up, titles, summaries and Ask run through the Claude Code (default) or Codex you are already logged into on the Mac, over ACP. No API key, no extra bill. Speech-to-text and speaker labels stay separate (whisper.cpp / sherpa-onnx, or Groq). Setup: [`docs/SELF-HOST.md` §4.5](docs/SELF-HOST.md#45-用你自己的-ai-訂閱claude-code-或-codex).
- **Folders, search, trash**, a URL for every view, light/dark, works down to 360 px.

## How it works

```
 browser ──▶ Cloudflare Worker (web/) ──▶ D1 (metadata) + R2 (audio)
                     ▲   behind Cloudflare Access
                     │ job queue with leases
 Mac runner (runner/) ─ ffmpeg · whisper-cli · sherpa-onnx · ACP agent
```

- `web/` — Cloudflare Worker in TypeScript, no framework. API, static UI (`web/public/index.html`), D1 migrations.
- `runner/` — Go binary on one or more Apple Silicon Macs. Claims jobs from the Worker, does the heavy lifting locally, pushes results back. Several runners can share the queue.

Audio is stored in your own Cloudflare account and transcribed on your Mac (unless you pick Groq). Transcript clean-up, titles and summaries send the transcript text to whichever model your ACP agent uses.

## Setup

Requirements: a Cloudflare account (Workers Paid for D1/R2 limits), an Apple Silicon Mac with `ffmpeg`, `whisper-cpp`, Go 1.26.

The step-by-step guide (Cloudflare Access, D1/R2, service tokens, runner as a launchd service, phone use) is in [`docs/SELF-HOST.md`](docs/SELF-HOST.md) (Traditional Chinese, with an English summary). Short version:

```sh
# Worker
cd web && npm install
npx wrangler d1 migrations apply noteapp --remote
npx wrangler deploy            # edit wrangler.jsonc first: domain, ACCESS_TEAM, ACCESS_AUD, D1 id

# Runner
cd runner && cp .env.example .env   # API_BASE + Access service token
go run . models                     # downloads whisper + diarization models
go run .                            # start claiming jobs
```

Local development: see [`CLAUDE.md`](CLAUDE.md). Design and API contracts: [`docs/SPEC.md`](docs/SPEC.md).

## Security

The Worker fails closed: without `ACCESS_TEAM` / `ACCESS_AUD` every API call returns 503, and each request's Cloudflare Access JWT is verified. The schema is multi-user (every row carries a `user_id` and every query is scoped by it, covered by a two-user isolation test), but this entry authenticates a single user: everyone who passes Access is that user. Other sign-in schemes plug in through `createWorker` (see "Extending the server" in [`docs/SPEC.md`](docs/SPEC.md)).

## License

[MIT](LICENSE)
