<div align="center">
  <img src="docs/logo.svg" alt="Yanroku logo" width="96" />
  <h1>Yanroku 言錄</h1>
  <p><b>AI voice notes you host yourself: speaker-labelled transcripts and summaries.</b><br>Your audio lives in your Cloudflare account, your Mac does the transcription, and the Claude Code or Codex you already pay for writes the summaries.</p>
</div>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/github/license/SammyLin/yanroku?style=flat-square" /></a>
  <a href="runner/go.mod"><img alt="Go" src="https://img.shields.io/github/go-mod/go-version/SammyLin/yanroku?filename=runner%2Fgo.mod&style=flat-square" /></a>
  <a href="#architecture"><img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare_Workers-D1_%2B_R2-F38020?style=flat-square" /></a>
  <a href="#self-host"><img alt="Self-host" src="https://img.shields.io/badge/self--host-Apple_Silicon_runner-142D3B?style=flat-square" /></a>
</p>

<p align="center">
  English | <a href="docs/README.zh-TW.md">繁體中文</a>
</p>

![Yanroku: transcript view with speaker timeline](docs/screenshot.png)

> The UI is in Traditional Chinese. Summaries can be written in Traditional Chinese, English or Japanese.

Don't want to run a server? See [Yanroku Cloud](#yanroku-cloud).

## Why

Plaud-style voice recorders and note apps usually keep your meetings on the vendor's servers and charge a subscription for the AI features. Yanroku is the same idea built from parts you already own: a Cloudflare account stores the audio, a Mac transcribes it, and the Claude or ChatGPT plan you already have writes the summaries.

- **Your storage.** Audio sits in your own R2 bucket and metadata in your own D1 database, behind your own Cloudflare Access login.
- **Your hardware.** Speech-to-text runs on your Mac with `whisper.cpp` (Metal), unless you choose Groq.
- **Your AI subscription.** Clean-up, titles, summaries and Ask go through Claude Code or Codex over ACP. No API key, no separate bill.
- **Your code.** Everything that runs is in this repository, under AGPL-3.0.

## Features

| | |
|---|---|
| **Record or import** | Record in the browser (phone too), or drag in many audio/video files at once. Large files upload in parallel parts with retries; `yanroku ingest <folder>` batch-uploads from the Mac |
| **Transcripts with speakers** | `whisper.cpp` or Groq Whisper for the text, `sherpa-onnx` for who said what. An AI pass fixes punctuation and obvious recognition errors |
| **Synced playback** | Click any line to play from there; the seek bar shows who speaks when |
| **Voiceprints** | Name a speaker once, for one line or all of them; the same person is labelled automatically in later recordings, or suggested ("可能是 X？") when the match is less certain |
| **Summaries** | Template-based (meeting notes) in Traditional Chinese, English or Japanese, rendered as Markdown |
| **Ask (問問看)** | Ask a question across all your recordings; the answer cites recording and timestamp, and each citation jumps to that moment |
| **Folders, search, trash** | Nested folders, search over titles and transcript text, soft delete with restore |
| **Vocabulary** | A word list that steers recognition and clean-up; Yanroku also suggests terms it learned from your own corrections, and never adds them by itself |
| **Copy as prompt** | Copy the summary and/or transcript (or a selected passage) as a prompt for ChatGPT or Claude, with a length estimate, or download it as `.md` |
| **Runner status** | See which Macs are online, what they are working on, and which ones run an older build |
| **Web Push** | Optional "processing finished" notifications (iOS needs the home-screen web app) |
| **iOS app** | The [Yanroku app](https://yanroku.app) can connect to your own server ("連線到自己的伺服器"). The app is a separate product; this repository is the server |

Light and dark themes, a URL for every view, and layouts down to 360 px wide.

## Your own AI subscription

Transcript clean-up, titles, summaries, Ask and vocabulary suggestions run through an [ACP](https://agentclientprotocol.com) (Agent Client Protocol) agent on the runner's Mac:

- **Claude Code** (default): `npm i -g @agentclientprotocol/claude-agent-acp && claude login`, then `ACP_AGENT=claude-agent-acp`. Needs a plan that includes Claude Code (Pro, Max, …).
- **Codex**: `npm i -g @openai/codex && codex login`, then `ACP_AGENT=npx -y @zed-industries/codex-acp -c model=gpt-5.5`. Needs a ChatGPT plan.

Speech-to-text (whisper.cpp or Groq) and speaker labels (sherpa-onnx) are separate and never go through Claude or Codex. The transcript text is sent to whichever model your ACP agent uses. Details and troubleshooting: [`docs/SELF-HOST.md` §4.5](docs/SELF-HOST.md#45-用你自己的-ai-訂閱claude-code-或-codex).

## Architecture

```
 browser / iOS app ──▶ Cloudflare Worker (web/) ──▶ D1 (metadata) + R2 (audio)
                         ▲  behind Cloudflare Access
                         │  job queue with leases
 Mac runner (runner/) ───┘  ffmpeg · whisper-cli · sherpa-onnx · ACP agent
```

| Path | What it holds |
|---|---|
| `web/` | Cloudflare Worker in TypeScript, no framework: API, static UI (`web/public/index.html`), D1 migrations |
| `runner/` | Go binary for Apple Silicon Macs. Claims jobs from the Worker, does the heavy work locally, pushes results back. Several runners can share the queue |
| `docs/SPEC.md` | Contracts between the Worker, the web app and the runner: schema, API, pipeline |
| `docs/SELF-HOST.md` | The full self-hosting guide |

Audio is stored in your Cloudflare account and transcribed on your Mac (unless you pick Groq).

**Security.** The Worker fails closed: without `ACCESS_TEAM` / `ACCESS_AUD` every API call returns 503, and each request's Cloudflare Access JWT is verified. The schema is multi-user (every row carries a `user_id` and every query is scoped by it, covered by a two-user isolation test), but this entry authenticates a single user: everyone who passes Access is that user. Other sign-in schemes plug in through `createWorker` (see "Extending the server" in [`docs/SPEC.md`](docs/SPEC.md)).

## Self-host

Requirements: a Cloudflare account with your domain on it (Workers Paid recommended for CPU, D1 and R2 limits), and an Apple Silicon Mac that stays awake, with Homebrew.

The step-by-step guide (D1/R2, a wrangler `env` for your deployment, Cloudflare Access with one service token per runner, the runner as a launchd service, connecting the iOS app) is [`docs/SELF-HOST.md`](docs/SELF-HOST.md) (Traditional Chinese, with an English summary). Short version:

```sh
git clone https://github.com/SammyLin/yanroku.git && cd yanroku

# Worker: add your own env (D1 id, R2 bucket, domain, ACCESS_TEAM, ACCESS_AUD) to web/wrangler.jsonc first
cd web && npm install
npx wrangler d1 migrations apply <your-db> --remote --env mine
npx wrangler deploy --env mine

# Runner, on each Mac
brew install go ffmpeg whisper-cpp node
npm i -g @agentclientprotocol/claude-agent-acp && claude login
cd ../runner && cp .env.example .env   # API_BASE + this Mac's Access service token
./deploy.sh                            # build, download models (~1.5 GB), restart if installed
./yanroku run                            # try it in the foreground
sh install-launchd.sh                  # then run it as a launchd service
```

Local development: see [`CLAUDE.md`](CLAUDE.md).

## Configuration

**Runner** (`runner/.env`, see [`runner/.env.example`](runner/.env.example); real environment variables win over the file):

| Variable | Default | |
|---|---|---|
| `API_BASE` | — (required) | Your Worker's URL. The runner refuses to start without it |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | | This Mac's Cloudflare Access service token |
| `RUNNER_NAME` | hostname | Shown as the job owner and in runner status |

`API_BASE` is required and has no default. Set it to your own Worker's URL (for example `https://notes.example.com`). If it is missing, empty or not a valid URL, `yanroku run` exits with an error.
| `STT_PROVIDER` | `local` | `local` = whisper-cli on this Mac; `groq` = Groq Whisper API (audio leaves the Mac) |
| `WHISPER_MODEL` / `WHISPER_LANG` | `data/models/ggml-large-v3-turbo.bin` / `zh` | Local speech-to-text |
| `GROQ_API_KEY` / `GROQ_MODEL` | / `whisper-large-v3` | Required for `groq` |
| `DIARIZE` / `NUM_SPEAKERS` | `1` / `0` | `DIARIZE=0` = single speaker; `NUM_SPEAKERS=0` = detect the count |
| `ACP_AGENT` | `claude-agent-acp` | The ACP agent command (Claude Code or Codex, see above) |
| `ACP_MODEL` | `opus` | Claude Code model alias; ignored by Codex |
| `DATA_DIR` | `data` | Models, work files and logs |
| `RUNNER_TOKEN` | | Only for a multi-user deployment that checks a runner token; leave empty when self-hosting behind Access |

**Worker** (`vars` in your `wrangler.jsonc` env):

| Variable | |
|---|---|
| `ACCESS_TEAM` | `<team>` of `<team>.cloudflareaccess.com`. Unset → the API answers 503 |
| `ACCESS_AUD` | The Access application's audience (AUD) tag |
| `VOICE_MATCH_THRESHOLD` | Minimum voiceprint similarity to label a speaker automatically (`0.65`) |
| `VOICE_SUGGEST_THRESHOLD` | Minimum similarity to suggest a name (`0.50`) |
| `VAPID_PUBLIC_KEY` / `VAPID_SUBJECT`, secret `VAPID_PRIVATE_KEY` | Optional Web Push sender (format in `web/src/push.ts`). Unset → no push |
| `DEV_NO_AUTH` | Local development only (`.dev.vars`). Never set it in production |

## Updating

Back up D1 first (migrations cannot be rolled back), then update in this order: migrations, Worker, runners. A new Worker may need new columns, and a new runner may need new API routes.

```sh
cd yanroku/web
npx wrangler d1 export <your-db> --remote --output backup-$(date +%Y%m%d).sql --env mine
cd .. && git pull && cd web && npm install
npx wrangler d1 migrations apply <your-db> --remote --env mine
npx wrangler deploy --env mine
../runner/deploy.sh          # on every Mac
```

The runner status in the web app flags Macs still running an older build.

## Yanroku Cloud

Don't want to run a server? [Yanroku Cloud](https://yanroku.app) is the hosted version of the same app, with the iOS app, run by the same author.

## Contributing

Bug reports, docs fixes and pull requests are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the checks to run. Contributions are accepted under the [Contributor License Agreement](CLA.md), which you sign once by replying to the bot on your first pull request.

## License

Yanroku's server is licensed under the **GNU Affero General Public License v3.0** ([`LICENSE`](LICENSE)).

- Self-hosting for yourself or your organisation — personal or commercial, modified or not — is free and needs nothing from you.
- If you offer a modified version to other people over a network (for example as a hosted service), the AGPL requires you to make your modified source available to those users.
- Code up to and including commit `7e7a4cc` (2026-10-11) was published under the MIT License; those copies stay MIT. Everything after that commit is AGPL-3.0.
- The official iOS app and Yanroku Cloud (https://yanroku.app) are separate, proprietary products by the same author.
