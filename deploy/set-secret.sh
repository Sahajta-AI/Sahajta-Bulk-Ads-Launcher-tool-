#!/usr/bin/env bash
# Puts secrets into .env without showing them on screen or saving them in the shell history.
# Run it on the server, in a real terminal (ssh -t):
#   ./deploy/set-secret.sh AUTH_GOOGLE_SECRET META_APP_SECRET
set -euo pipefail
cd "$(dirname "$0")/.."
[ $# -gt 0 ] || { echo "Usage: ./deploy/set-secret.sh NAME [NAME ...]"; exit 1; }
[ -f .env ] || { echo "No .env yet. Run ./deploy/bootstrap.sh first."; exit 1; }

for NAME in "$@"; do
  case "$NAME" in
    AUTH_GOOGLE_SECRET|META_APP_SECRET|BACKUP_PAR_URL) ;;
    *) echo "Unknown name: $NAME (allowed: AUTH_GOOGLE_SECRET, META_APP_SECRET, BACKUP_PAR_URL)"; exit 1 ;;
  esac
  read -r -s -p "Paste $NAME and press Enter (nothing will show): " VALUE; echo
  VALUE="${VALUE//[$'\t\r\n ']/}"
  if [ -z "$VALUE" ]; then echo "  Nothing pasted. $NAME not changed."; continue; fi
  TMP=$(mktemp)
  grep -v "^$NAME=" .env > "$TMP" || true
  printf '%s=%s\n' "$NAME" "$VALUE" >> "$TMP"
  cat "$TMP" > .env && rm -f "$TMP"
  chmod 600 .env
  echo "  Saved $NAME (${#VALUE} characters)."
done
echo "Done. If the app is already running, restart it: sudo docker compose up -d"
