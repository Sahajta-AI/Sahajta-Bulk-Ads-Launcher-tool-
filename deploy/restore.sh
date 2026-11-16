#!/usr/bin/env bash
# Restore the database from a backup (a launcher-*.db.gz file, local path or URL).
#   ./deploy/restore.sh https://objectstorage.ap-hyderabad-1.oraclecloud.com/p/<read-PAR>/n/<ns>/b/<bucket>/o/launcher-2026-11-03T....db.gz
# After a restore, running batches resume, and every launch first checks Meta for objects
# it already made (by the [L:...] key in their names), so nothing is created twice.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="${1:?Give the path or URL of a .db.gz backup}"
TMP=$(mktemp -d)
if [[ "$SRC" =~ ^https?:// ]]; then curl -fsSL "$SRC" -o "$TMP/backup.db.gz"; else cp "$SRC" "$TMP/backup.db.gz"; fi
gunzip -c "$TMP/backup.db.gz" > "$TMP/launcher.db"
sqlite3 "$TMP/launcher.db" "PRAGMA integrity_check;" | grep -q '^ok$' || { echo "Backup file is damaged."; exit 1; }
sudo docker compose stop worker app 2>/dev/null || true
sudo docker compose run --rm --no-deps -v "$TMP:/restore" --entrypoint sh app -c \
  'rm -f /data/launcher.db-wal /data/launcher.db-shm && cp /restore/launcher.db /data/launcher.db'
rm -rf "$TMP"
echo "Database restored from $SRC. Start the app with: sudo docker compose up -d"
