# Contributing to Yanroku

Thanks for helping. Bug reports, docs fixes and pull requests are welcome.

## Before you open a pull request

1. Read [`CLAUDE.md`](CLAUDE.md) (how to run things locally) and [`docs/SPEC.md`](docs/SPEC.md) (contracts between the Worker, the web app and the runner).
2. Keep changes focused; one topic per pull request.
3. Run the checks for what you touched:
   - Worker / web: `cd web && npm test && npx tsc --noEmit`
   - Runner: `cd runner && go vet ./... && go test ./...`
4. Never commit secrets (`.env`, `.dev.vars`, tokens, keys).

## Contributor License Agreement

The server is licensed under AGPL-3.0, and the same author also runs Yanroku Cloud. To keep both possible, every contributor signs the [Contributor License Agreement](CLA.md) once. You keep the copyright to your contribution; the CLA gives the project the right to use it under AGPL-3.0 and under other licenses, including in Yanroku Cloud.

When you open your first pull request, a bot comments with instructions. Sign by replying with the exact sentence it asks for. Your signature is recorded in the `cla-signatures` branch of this repository.
