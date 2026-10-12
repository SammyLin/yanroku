#!/bin/sh
# Updates this Mac's runner in one go: git pull, build, install, fetch missing models, restart.
#
# Installs into the directory launchd runs the runner from (e.g. ~/tally-runner, a copy outside the repo),
# or into this runner/ directory when there is no launchd service. Override with TALLY_DIR=/path.
# Usage: runner/deploy.sh            (from anywhere)
set -eu
src=$(cd "$(dirname "$0")" && pwd)
label=ai.3mi.tally-runner
dom="gui/$(id -u)"

git -C "$src" pull --ff-only

prog=$(launchctl print "$dom/$label" 2>/dev/null | sed -n 's/^[[:space:]]*program = //p' | head -n 1)
dst=${TALLY_DIR:-$(dirname "${prog:-$src/tally}")}
echo "installing into $dst"
if [ ! -f "$dst/.env" ]; then
  echo "warning: $dst/.env is missing (copy .env.example and fill it in)" >&2
elif ! grep -Eq '^API_BASE=[[:space:]]*[^[:space:]]' "$dst/.env"; then
  echo "warning: API_BASE is empty in $dst/.env; the runner will refuse to start" >&2
fi
mkdir -p "$dst/lib"

# Build/copy to a temp name, then mv into place: overwriting a Mach-O file macOS has already run
# gets the new one SIGKILLed ("killed") on launch. mv swaps in a new file, so it is safe even while running.
cd "$src"
go build -ldflags '-extldflags "-Wl,-rpath,@executable_path/lib"' -o "$dst/tally.new" .
sherpa="$(go list -m -f '{{.Dir}}' github.com/k2-fsa/sherpa-onnx-go-macos)/lib/aarch64-apple-darwin"
for f in libsherpa-onnx-c-api.dylib libonnxruntime.dylib; do
  cp "$sherpa/$f" "$dst/lib/$f.new" && chmod u+w "$dst/lib/$f.new" && mv -f "$dst/lib/$f.new" "$dst/lib/$f"
done
mv -f "$dst/tally.new" "$dst/tally"
echo "built $("$dst/tally" version)"

(cd "$dst" && ./tally models)

# Restart. A job in progress is put back in the queue and picked up again (by this or another runner).
if launchctl print "$dom/$label" >/dev/null 2>&1; then
  launchctl kickstart -k "$dom/$label"
  echo "restarted $label — log: $dst/data/logs/runner.log"
elif pid=$(pgrep -f '^\./tally run$' | head -n 1) && [ -n "$pid" ]; then
  # started by hand (nohup) from $dst; stop it and start the new build the same way
  kill -INT "$pid"
  i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 30 ]; do sleep 1; i=$((i + 1)); done
  mkdir -p "$dst/data/logs"
  # only nohup goes to the background (with "cd && nohup … &" a shell would linger holding our stdout)
  (cd "$dst" || exit 1; nohup ./tally run >> data/logs/runner.log 2>&1 < /dev/null &)
  echo "restarted ./tally run (nohup) — log: $dst/data/logs/runner.log"
else
  echo "no runner running; start it with $src/install-launchd.sh (or: cd $dst && ./tally run)"
fi
