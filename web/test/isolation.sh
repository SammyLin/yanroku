#!/bin/sh
# Two-user isolation suite against core's routes: fresh local D1, `wrangler dev test/fake-identify.ts`, then test/isolation.test.ts.
# Run from anywhere: sh web/test/isolation.sh (PORT defaults to 8811, inspector on PORT+1)
set -eu
cd "$(dirname "$0")/.."
port=${PORT:-8811}
dir=$(mktemp -d "${TMPDIR:-/tmp}/yanroku-isolation.XXXXXX")
npx wrangler d1 migrations apply noteapp --local --persist-to "$dir" >/dev/null
npx wrangler dev test/fake-identify.ts --var TRANSFER_ENABLED:1 --port "$port" --inspector-port "$((port + 1))" --local --persist-to "$dir" >"$dir/dev.log" 2>&1 &
pid=$!
cleanup() { kill "$pid" 2>/dev/null || true; sleep 1; rm -rf "$dir"; }
trap cleanup EXIT INT TERM
i=0
until curl -sf "http://127.0.0.1:$port/api/config" >/dev/null; do
  i=$((i + 1)); [ "$i" -lt 90 ] || { cat "$dir/dev.log"; exit 1; }; sleep 1
done
BASE="http://127.0.0.1:$port" ISOLATION_DB_DIR="$dir" node test/isolation.test.ts || { echo "--- wrangler dev log"; tail -40 "$dir/dev.log"; exit 1; }
