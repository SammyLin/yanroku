#!/bin/sh
# Updates this Mac's runner in one go: git pull, build, install, fetch missing models, restart.
#
# Installs into the directory launchd runs the runner from (e.g. ~/yanroku-runner, a copy outside the repo),
# or into this runner/ directory when there is no launchd service. Override with YANROKU_DIR=/path (TALLY_DIR still works).
# A runner still installed under the pre-rename ai.3mi.tally-runner agent is moved to ai.3mi.yanroku-runner.
# Usage: runner/deploy.sh            (from anywhere)
set -eu
src=$(cd "$(dirname "$0")" && pwd)
label=ai.3mi.yanroku-runner
old=ai.3mi.tally-runner
dom="gui/$(id -u)"

git -C "$src" pull --ff-only

program() { launchctl print "$dom/$1" 2>/dev/null | sed -n 's/^[[:space:]]*program = //p' | head -n 1; }
prog=$(program "$label")
oldprog=$(program "$old")
dst=${YANROKU_DIR:-${TALLY_DIR:-$(dirname "${prog:-${oldprog:-$src/yanroku}}")}}
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
go build -ldflags '-extldflags "-Wl,-rpath,@executable_path/lib"' -o "$dst/yanroku.new" .
sherpa="$(go list -m -f '{{.Dir}}' github.com/k2-fsa/sherpa-onnx-go-macos)/lib/aarch64-apple-darwin"
for f in libsherpa-onnx-c-api.dylib libonnxruntime.dylib; do
  cp "$sherpa/$f" "$dst/lib/$f.new" && chmod u+w "$dst/lib/$f.new" && mv -f "$dst/lib/$f.new" "$dst/lib/$f"
done
mv -f "$dst/yanroku.new" "$dst/yanroku"
echo "built $("$dst/yanroku" version)"

(cd "$dst" && ./yanroku models)

# Pre-rename install: swap the ai.3mi.tally-runner agent for ai.3mi.yanroku-runner (install-launchd.sh removes the old one)
if [ -z "$prog" ] && [ -n "$oldprog" ]; then
  YANROKU_DIR="$dst" sh "$src/install-launchd.sh"
  rm -f "$dst/tally"
  exit 0
fi

# Restart. A job in progress is put back in the queue and picked up again (by this or another runner).
if launchctl print "$dom/$label" >/dev/null 2>&1; then
  launchctl kickstart -k "$dom/$label"
  echo "restarted $label — log: $dst/data/logs/runner.log"
elif pid=$(pgrep -f '^\./(yanroku|tally) run$' | head -n 1) && [ -n "$pid" ]; then
  # started by hand (nohup) from $dst; stop it and start the new build the same way
  kill -INT "$pid"
  i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 30 ]; do sleep 1; i=$((i + 1)); done
  mkdir -p "$dst/data/logs"
  # only nohup goes to the background (with "cd && nohup … &" a shell would linger holding our stdout)
  (cd "$dst" || exit 1; nohup ./yanroku run >> data/logs/runner.log 2>&1 < /dev/null &)
  echo "restarted ./yanroku run (nohup) — log: $dst/data/logs/runner.log"
else
  echo "no runner running; start it with $src/install-launchd.sh (or: cd $dst && ./yanroku run)"
fi
