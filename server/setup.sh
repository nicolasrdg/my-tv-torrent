#!/usr/bin/env bash
# Runs where the media server goes, in the folder deploy.sh fills (~/freemytv-server here, /opt/freemytv on a VPS):
# Docker when it's missing (Linux), the password and token once, qBittorrent's settings once, then both containers.
# Run again, it updates and restarts them, keeping the password, the token and the downloads.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  if [ "$(uname)" != Linux ]; then
    echo "Docker isn't running: install Docker Desktop (docker.com), open it, and run this again." >&2
    exit 1
  fi
  echo "Installing Docker (get.docker.com)..."
  curl -fsSL https://get.docker.com | sh
fi

random() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

if [ ! -f .env ]; then
  (umask 077; printf 'QB_PASSWORD=%s\nMEDIA_TOKEN=%s\n' "$(random 16)" "$(random 24)" > .env)
  echo "Made .env: qBittorrent's password and the TVs' token (kept only here)."
fi
# qBittorrent's Web UI, on this machine only: the first free port from 8081 (8080 and others are often taken).
if ! grep -q '^QB_WEBUI_PORT=' .env; then
  port=8081
  while (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; do port=$((port + 1)); done
  echo "QB_WEBUI_PORT=$port" >> .env
fi
QB_PASSWORD="$(sed -n 's/^QB_PASSWORD=//p' .env)"
MEDIA_TOKEN="$(sed -n 's/^MEDIA_TOKEN=//p' .env)"

# qBittorrent's settings, before its first start: the Web UI's user (admin, the password in .env, as qBittorrent stores
# it: PBKDF2-SHA512, 100000 rounds), downloads in /downloads, and finished torrents removed with their files a day
# after they finish (a day to watch them), so the disk doesn't fill up and the sharing stops.
conf=qbittorrent/qBittorrent/qBittorrent.conf
if [ ! -f "$conf" ]; then
  mkdir -p "$(dirname "$conf")" downloads
  hash="$(docker run --rm -e P="$QB_PASSWORD" python:3.12-slim-bookworm python3 -c '
import base64, hashlib, os
salt = os.urandom(16)
key = hashlib.pbkdf2_hmac("sha512", os.environ["P"].encode(), salt, 100000, 64)
print(base64.b64encode(salt).decode() + ":" + base64.b64encode(key).decode())')"
  cat > "$conf" <<EOF
[BitTorrent]
Session\DefaultSavePath=/downloads/
Session\Port=6881
Session\QueueingSystemEnabled=false
Session\GlobalMaxSeedingMinutes=1440
Session\ShareLimitAction=RemoveWithContent

[LegalNotice]
Accepted=true

[Preferences]
Downloads\SavePath=/downloads/
WebUI\Port=$(sed -n 's/^QB_WEBUI_PORT=//p' .env)
WebUI\Username=admin
WebUI\Password_PBKDF2="@ByteArray($hash)"
EOF
  if [ "$(uname)" = Linux ]; then chown -R 1000:1000 qbittorrent downloads; fi   # Docker Desktop maps the owner itself
  echo "Wrote qBittorrent's settings."
fi

docker compose up -d --build

# The ports the TVs and the other peers use, when ufw guards the VPS (Docker's own ports skip it, but not everywhere).
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q 'Status: active'; then
  ufw allow 8090/tcp >/dev/null
  ufw allow 6881 >/dev/null
fi

printf 'Waiting for the media server'
for _ in $(seq 1 60); do
  if answer="$(curl -fs "http://127.0.0.1:8090/status?t=$MEDIA_TOKEN")" && [ -n "$answer" ]; then
    echo; echo "Media server up: $answer"
    echo "qBittorrent's Web UI: http://localhost:$(sed -n 's/^QB_WEBUI_PORT=//p' .env) (admin, QB_PASSWORD in $PWD/.env)"
    exit 0
  fi
  printf '.'
  sleep 2
done
echo; echo "The media server didn't answer. Its log:"
docker compose logs --tail 30 media
exit 1
