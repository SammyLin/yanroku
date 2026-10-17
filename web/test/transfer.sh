#!/bin/sh
# Export / import against real Workers: one with TRANSFER_ENABLED=1 (test/transfer-api.test.ts, then test/transfer-e2e.test.ts
# when present) and one without (every transfer route 404s). Fake identities as in isolation.sh. Run from anywhere: sh web/test/transfer.sh
set -eu
cd "$(dirname "$0")/.."
port=${PORT:-8821}
on=$(mktemp -d "${TMPDIR:-/tmp}/yanroku-transfer.XXXXXX")
off=$(mktemp -d "${TMPDIR:-/tmp}/yanroku-transfer-off.XXXXXX")
for d in "$on" "$off"; do npx wrangler d1 migrations apply noteapp --local --persist-to "$d" >/dev/null; done
npx wrangler dev test/fake-identify.ts --var TRANSFER_ENABLED:1 --port "$port" --inspector-port "$((port + 1))" --local --persist-to "$on" >"$on/dev.log" 2>&1 &
p1=$!
npx wrangler dev test/fake-identify.ts --port "$((port + 2))" --inspector-port "$((port + 3))" --local --persist-to "$off" >"$off/dev.log" 2>&1 &
p2=$!
cleanup() { kill "$p1" "$p2" 2>/dev/null || true; sleep 1; rm -rf "$on" "$off"; }
trap cleanup EXIT INT TERM
for p in "$port" "$((port + 2))"; do
  i=0
  until curl -sf "http://127.0.0.1:$p/api/config" >/dev/null; do
    i=$((i + 1)); [ "$i" -lt 90 ] || { cat "$on/dev.log" "$off/dev.log"; exit 1; }; sleep 1
  done
done
export BASE="http://127.0.0.1:$port" OFF="http://127.0.0.1:$((port + 2))"
for t in test/transfer-api.test.ts test/transfer-e2e.test.ts; do
  [ -f "$t" ] || continue
  node "$t" || { echo "--- wrangler dev log"; tail -40 "$on/dev.log"; exit 1; }
done
