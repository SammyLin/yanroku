# Yanroku 言錄

Yanroku 言錄 — the self-hostable server of the Yanroku AI voice notes (renamed noteapp → Tally → Kiroku → Yanroku; public repo SammyLin/yanroku, history from SammyLin/tally; the binary is `yanroku` (was `tally`, launchd `ai.3mi.yanroku-runner`); the Worker keeps the name `tally`, D1 `noteapp` / R2 `noteapp-audio` keep theirs). Read `docs/HANDOVER.md` (goals, decisions) and `docs/SPEC.md` (module contracts, schema, API) before changing code. Self-hosting guide for other people: `docs/SELF-HOST.md`; `docs/SETUP.md` is the owner's own deployment.

Layout:
- `web/` — Cloudflare Worker (TypeScript): API, UI (`public/index.html`), D1 migrations. Data lives in D1 + R2, behind Cloudflare Access.
- `runner/` — Go, runs on the Mac: pulls jobs from the Worker, runs ffmpeg / whisper-cli / sherpa-onnx diarization / ACP (local Claude), pushes results back. Config in `runner/.env` (see `.env.example`).
- The iOS app and the hosted Yanroku Cloud (Clerk sign-in, landing page, cloud deploy) live in a private repo that pulls this one in as the `core/` submodule. Nothing cloud-specific belongs here: extend through the seam instead.

Worker seam (`web/src/`): `app.ts` has the routes, the dispatcher and `createWorker({ identify, extraRoutes?, config?, onScheduled? })`; `index.ts` is the self-host entry (`createWorker({ identify: accessIdentify })`). The UI loads the `/api/config` `extensions` scripts and exposes `window.yanroku`. Contract: docs/SPEC.md "Extending the server".

Web checks (run from `web/`): `npx tsc`, `npm test`, `npm run test:isolation` (two users against every route via `test/fake-identify.ts`; a new route needs a case in `test/isolation.ts`), `npm run test:migrate`.

Runner (run from `runner/`):
- Run: `go run .` (= `run`: claim jobs from `API_BASE`; API_BASE is required (no default); runner exits if unset). Batch upload: `go run . ingest <folder>`. Models: `go run . models`.
- Local end-to-end: in `web/`, `npx wrangler d1 migrations apply noteapp --local` then `npx wrangler dev --port 8790` (8787 is taken on this Mac; `.dev.vars` has `DEV_NO_AUTH=1`); run the runner with `API_BASE=http://127.0.0.1:8790`.
- Update a Mac's runner (pull, build, install where launchd runs it, models, restart): `runner/deploy.sh`. The UI's runner status shows each runner's build (git commit), flagging older ones.
- Build by hand (binary must not depend on the Go module cache for the sherpa dylibs; never `cp` over a binary macOS has run — it gets SIGKILLed, use a new file + mv):
  ```sh
  mkdir -p lib && cp "$(go list -m -f '{{.Dir}}' github.com/k2-fsa/sherpa-onnx-go-macos)"/lib/aarch64-apple-darwin/lib{sherpa-onnx-c-api,onnxruntime}.dylib lib/ && chmod u+w lib/*
  go build -ldflags '-extldflags "-Wl,-rpath,@executable_path/lib"' -o yanroku .
  ```
  Ship `yanroku` together with `lib/`.
