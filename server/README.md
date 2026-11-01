# Media server

The drawer's **Torrents** (LG and Samsung) searches qBittorrent and plays a torrent while it downloads, through
`tools/media_server.py`. Here both run in Docker, on a computer at home or on a VPS, and every TV uses the same one.

## Install

On this computer (a Mac with Docker Desktop open):

```
server/deploy.sh
python3 webos/build.py && python3 webos/install.py <TV IP>
```

On a VPS instead, with SSH access by key (`ssh-copy-id root@<VPS IP>` once): `server/deploy.sh root@<VPS IP>`.

`deploy.sh` copies this folder and `tools/media_server.py` to `~/freemytv-server` (on a VPS, `/opt/freemytv`), where
`setup.sh` makes qBittorrent's password and the TVs' token (in `.env` there, only there) and starts both containers.
Then it writes `media_server` and `media_token` in your `config.properties`. Run it again to update: the password,
the token and the downloads stay.

At home, the TVs reach the server only while the computer is awake with Docker Desktop open (Docker Desktop's
*Start when you sign in* brings it back after a restart; the containers start with it). Its address can change:
reserve it in the router, or run `deploy.sh` again and reinstall on the TVs.

## What's open, and to whom

- **8090**: the media server. Each request needs the token (`?t=`), so only your TVs get in. It's plain HTTP: the token
  and the video travel unencrypted.
- **6881** (TCP and UDP): qBittorrent's other peers.
- qBittorrent's **Web UI**: http://localhost:&lt;QB_WEBUI_PORT&gt;, only on that machine (user `admin`, password
  `QB_PASSWORD`, both in `.env`; the port is the first free one from 8081, and `setup.sh` prints the address). On a VPS,
  through a tunnel: `ssh -L <port>:127.0.0.1:<port> root@<VPS IP>`, then the same address.

## Search plugins

qBittorrent searches only with the plugins you add: in the Web UI, **Search** > **Search plugins** > **Install a new
one** (a plugin's `.py` address). Without any, the TV says so.

## Disk, and sharing

A torrent shares while it downloads, as BitTorrent does, and goes on for a day after it finishes (a day to watch it);
then qBittorrent removes it, files included (`Session\GlobalMaxSeedingMinutes` in
`qbittorrent/qBittorrent/qBittorrent.conf`, in minutes). Downloads are in `downloads/` beside it.

What a torrent shares is tied to your internet address: share only what you're allowed to. Many VPS providers don't
allow BitTorrent at all.
