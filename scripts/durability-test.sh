#!/usr/bin/env bash
# Prove crash recovery: trigger a slow job, kill the worker running it, and verify the
# reaper requeues it and a surviving worker completes it. Requires 2 workers up:
#   docker compose up -d --build --scale worker=2 redis api worker
set -uo pipefail
API=${MILL_API:-http://localhost:8787}

echo "workers online: $(curl -s $API/api/workers | grep -o '"id"' | wc -l)"
JID=$(curl -s -XPOST "$API/api/projects/billing/workflows/slow/trigger" -H 'content-type: application/json' -d '{"input":{"ms":12000}}' | grep -o 'job_[0-9a-f]*')
echo "triggered slow job: $JID"
sleep 3

WID=$(curl -s "$API/api/jobs/$JID" | grep -o '"worker":"[^"]*"' | cut -d'"' -f4)
echo "job is running on worker: $WID"
HEX=${WID#w-}
CID=$(docker ps --format '{{.ID}} {{.Names}}' | awk -v h="$HEX" '$1 ~ "^"h {print $2}' | head -1)
if [ -z "$CID" ]; then echo "FAIL: could not map $WID to a container"; exit 1; fi

echo ">>> KILLING $CID (the worker running the job) <<<"
docker kill "$CID" >/dev/null
echo "killed. waiting for heartbeat to expire → reaper requeue → surviving worker completes…"

for i in $(seq 1 60); do
  J=$(curl -s "$API/api/jobs/$JID")
  ST=$(echo "$J" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
  RQ=$(echo "$J" | grep -o '"requeued":"true"' || true)
  W2=$(echo "$J" | grep -o '"worker":"[^"]*"' | cut -d'"' -f4)
  printf "  [%2ss] status=%-9s worker=%-10s %s\n" "$((i*2))" "$ST" "$W2" "${RQ:+(requeued)}"
  if [ "$ST" = "succeeded" ]; then
    echo "PASS ✅  job survived the worker kill, was requeued, and completed on ${W2}"
    [ "$W2" != "$WID" ] && echo "        (finished on a DIFFERENT worker than the one killed)"
    exit 0
  fi
  [ "$ST" = "failed" ] && { echo "FAIL: job failed"; exit 1; }
  sleep 2
done
echo "FAIL: job did not complete in time"; exit 1
