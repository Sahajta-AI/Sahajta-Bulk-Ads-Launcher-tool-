#!/usr/bin/env bash
# Builds the whole launcher server on a fresh Ubuntu 24.04 machine (Oracle Cloud, Arm).
# Safe to run again: it only adds what is missing, then rebuilds and restarts the app.
#
#   curl -fsSL https://raw.githubusercontent.com/<you>/<repo>/main/deploy/bootstrap.sh | REPO_URL=<git url> bash
# or, from a clone:   ./deploy/bootstrap.sh
#
# Optional: RESTORE_FROM=<path or URL of a launcher-*.db.gz backup> restores the database first.
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/ads-launcher}"
REPO_URL="${REPO_URL:-}"
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "1/7 System packages and Docker"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y git curl docker.io docker-compose-v2 netfilter-persistent iptables-persistent sqlite3
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER" || true
DOCKER="sudo docker"

say "2/7 Swap (helps the build on small machines)"
if ! swapon --show | grep -q .; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

say "3/7 Firewall: open ports 80 and 443 (Oracle's Ubuntu image blocks them by default)"
for port in 80 443; do
  if ! sudo iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
    sudo iptables -I INPUT 6 -p tcp --dport "$port" -m state --state NEW -j ACCEPT
  fi
done
sudo netfilter-persistent save

say "4/7 Code"
if [ -f "$(dirname "$0")/../docker-compose.yml" ] && [ -z "$REPO_URL" ]; then
  APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
elif [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  [ -n "$REPO_URL" ] || { echo "Set REPO_URL to the git address of this repo."; exit 1; }
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

say "5/7 Settings (.env)"
if [ ! -f .env ]; then
  cp .env.example .env
  KEY=$(openssl rand -base64 32); SECRET=$(openssl rand -base64 32)
  sed -i "s|^APP_ENCRYPTION_KEY=.*|APP_ENCRYPTION_KEY=$KEY|; s|^AUTH_SECRET=.*|AUTH_SECRET=$SECRET|" .env
  chmod 600 .env
  echo "Created $APP_DIR/.env with new random keys. Fill in the rest (docs/SETUP.md, step 'Server settings'), then run this script again."
  exit 0
fi
chmod 600 .env
grep -q '^DOMAIN=.\+' .env || { echo "DOMAIN is empty in .env"; exit 1; }

say "6/7 Build and start (first build takes about 5-8 minutes)"
if [ -n "${RESTORE_FROM:-}" ]; then
  ./deploy/restore.sh "$RESTORE_FROM"
fi
$DOCKER compose up -d --build
# Each rebuild leaves the old image and build layers behind (about 1-2 GB): remove them.
$DOCKER image prune -f || true
$DOCKER builder prune -f --filter until=24h || true
for i in $(seq 1 60); do
  if $DOCKER compose exec -T app curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then break; fi
  sleep 5
done
$DOCKER compose exec -T app curl -fsS http://127.0.0.1:3000/api/health && echo

say "7/7 Health check every 5 minutes (restarts the app if it stops answering)"
CRON="*/5 * * * * $APP_DIR/deploy/healthcheck.sh >> $APP_DIR/healthcheck.log 2>&1"
( sudo crontab -l 2>/dev/null | grep -v deploy/healthcheck.sh; echo "$CRON" ) | sudo crontab -

DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2)
say "Done. Open https://$DOMAIN"
