#!/usr/bin/env bash
# Puts the media server (qBittorrent and tools/media_server.py, in Docker) on this computer or on a VPS, then points
# this build at it, writing media_server and media_token in config.properties (the token isn't shown).
#
#   server/deploy.sh                      # here, in ~/freemytv-server (Docker Desktop on a Mac)
#   server/deploy.sh root@203.0.113.7     # on a VPS, in /opt/freemytv
#
# Then build and install on each TV: python3 webos/build.py && python3 webos/install.py <TV IP>
set -euo pipefail
cd "$(dirname "$0")/.."
files="server/docker-compose.yml server/Dockerfile server/setup.sh tools/media_server.py"

if [ $# -eq 0 ]; then
  dir="$HOME/freemytv-server"
  mkdir -p "$dir"
  cp $files "$dir/"
  bash "$dir/setup.sh"
  token="$(sed -n 's/^MEDIA_TOKEN=//p' "$dir/.env")"
  # This computer's address on the home network, which the TVs use.
  host="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | cut -d' ' -f1)"
  [ -n "$host" ] || { echo "Couldn't find this computer's network address." >&2; exit 1; }
else
  target="$1"
  host="${target#*@}"
  ssh "$target" 'mkdir -p /opt/freemytv'
  scp -q $files "$target:/opt/freemytv/"
  ssh "$target" 'bash /opt/freemytv/setup.sh'
  token="$(ssh "$target" "sed -n 's/^MEDIA_TOKEN=//p' /opt/freemytv/.env")"
fi

[ -f config.properties ] || cp config.example.properties config.properties
MEDIA_TOKEN="$token" python3 - "http://$host:8090" <<'EOF'
import os, re, sys
values = {'media_server': sys.argv[1], 'media_token': os.environ['MEDIA_TOKEN']}
text = open('config.properties', encoding='utf-8').read()
for key, value in values.items():
    line = '%s=%s' % (key, value)
    if re.search(r'(?m)^%s=.*$' % key, text):
        text = re.sub(r'(?m)^%s=.*$' % key, lambda m: line, text)
    else:
        text = text.rstrip('\n') + '\n' + line + '\n'
open('config.properties', 'w', encoding='utf-8').write(text)
EOF
echo "config.properties: media_server=http://$host:8090 and media_token set."
echo "Now, for each TV: python3 webos/build.py && python3 webos/install.py <TV IP>"
