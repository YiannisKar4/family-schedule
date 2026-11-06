#!/usr/bin/env bash
# Runs browser tests against the fake Supabase without restarting it between tests:
# each test starts from clean data via POST /__reset, and the mock stops itself at the end.
#   bash dev/ui-tests.sh [data.sql] test1.cjs test2.cjs …
# With a data.sql the site is on :8190 (API :8191), otherwise on :8090 (API :8091).
set -u
cd "$(dirname "$0")/.."
DATA=""
if [[ "${1:-}" == *.sql ]]; then DATA="$1"; shift; fi
if [ -n "$DATA" ]; then SITE=8190; API=8191; else SITE=8090; API=8091; fi
SITE_PORT=$SITE API_PORT=$API node dev/supabase-mock.mjs $DATA > /dev/null 2>&1 &
for _ in $(seq 1 60); do curl -s "localhost:$SITE/" > /dev/null && break; sleep 0.5; done
status=0
for t in "$@"; do
  curl -s -X POST "localhost:$API/__reset" > /dev/null
  out=$(EXTRA=1 node "$t" 2>&1); code=$?
  echo "$(basename "$t"): $(echo "$out" | tail -1)"
  [ $code -ne 0 ] && { echo "$out" | tail -15; status=1; }
done
curl -s -X POST "localhost:$API/__quit" > /dev/null
exit $status
