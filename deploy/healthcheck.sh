#!/usr/bin/env bash
# Runs from cron every 5 minutes. If the app or the worker stops answering twice in a row,
# restart them. The outside alert (email) comes from the free UptimeRobot check in docs/SETUP.md.
set -uo pipefail
cd "$(dirname "$0")/.."
STATE=/tmp/launcher-health-fails
if sudo docker compose exec -T app curl -fsS -m 10 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
  rm -f "$STATE"
  exit 0
fi
n=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$STATE"
echo "$(date -Is) health check failed ($n)"
if [ "$n" -ge 2 ]; then
  echo "$(date -Is) restarting app and worker"
  sudo docker compose restart app worker
  rm -f "$STATE"
fi
