#!/usr/bin/env python3
"""Free My TV's media server: the LG and Samsung home screen's Torrents (web/media.js) search qBittorrent through it and
play a torrent while it downloads, on any TV.

With qBittorrent beside it in Docker, on this computer or a VPS: server/deploy.sh (see server/README.md). By hand:

    pip3 install qbittorrent-api
    QBITTORRENTAPI_USERNAME=admin QBITTORRENTAPI_PASSWORD=... MEDIA_TOKEN=... python3 tools/media_server.py --qb http://127.0.0.1:8081

In qBittorrent, Preferences > Web UI: turn it on (port 8081 here; 8080 is qBittorrent's default) with a user name and
password, which go in the two variables above (qbittorrent-api reads them; they're never written anywhere). Search
needs search plugins in qBittorrent (View > Search Engine > Search plugins). Then put this server's address and the
token in config.properties (media_server=http://<its IP>:8090, media_token=...), build and install again.

MEDIA_TOKEN (or --token): every request must carry it as ?t=..., the TV's way (a video's address can't carry headers).
Without one, anyone who reaches the port can use your qBittorrent: leave it out only on a home network.

What it answers (JSON, open to the TV's file:// page):
  GET /status                   qBittorrent's version
  GET /search?q=...             qBittorrent's search with its enabled plugins, the most seeded first
  GET /torrents                 what qBittorrent has, the newest first
  GET /play?url=...             adds a torrent (magnet or .torrent link): sequential, first and last pieces first
  GET /progress?hash=...        its biggest video, and how much of it is ready from the start
  GET /stream/<hash>/<file>/... that file, with HTTP ranges; a range not downloaded yet waits for it
Only files of torrents in qBittorrent are served, never any other path. qBittorrent keeps sharing what it downloads,
as with any torrent.
"""
import argparse
import hashlib
import hmac
import json
import os
import re
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urljoin, urlparse

try:
    import qbittorrentapi
    import requests   # comes with qbittorrent-api
except ImportError:
    sys.exit('The media server needs qbittorrent-api: pip3 install qbittorrent-api')

TYPES = {'.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
         '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.ts': 'video/mp2t', '.m2ts': 'video/mp2t',
         '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.wmv': 'video/x-ms-wmv'}
PLAYS = ('.mp4', '.m4v', '.mkv', '.webm', '.mov', '.ts', '.m2ts')   # what LG and Samsung play in a web page
READY = 16 * 1024 * 1024   # bytes from a video's start (and its last piece) before the TV starts it
CHUNK = 1024 * 1024
WAIT = 120                 # seconds a range waits for its pieces; then the connection ends and the TV asks again
TAG = 'freemytv'           # torrents added from the TV: only theirs get their other files skipped
MAX_TORRENT = 10 * 1024 * 1024   # a bigger .torrent link isn't read here

qb = None
token = ''                 # what ?t= must be, when set
lock = threading.Lock()    # the client is one requests session: one call at a time
picked = {}                # hash -> the file index played, chosen once
pieces = {}                # hash -> (when, piece states), read at most twice a second


class Refused(Exception):
    """An answer for the TV: its message is shown there."""


def api(name, **kw):
    with lock:
        try:
            return getattr(qb, name)(**kw)
        except qbittorrentapi.LoginFailed:
            raise Refused("qBittorrent refused the user name or password.")
        except qbittorrentapi.APIConnectionError:
            raise Refused("qBittorrent isn't answering: open it, with its Web UI on.")


def torrent(h):
    found = api('torrents_info', torrent_hashes=h)
    if not found:
        raise Refused('That torrent is no longer in qBittorrent.')
    return found[0]


def piece_states(h):
    hit = pieces.get(h)
    if hit and time.time() - hit[0] < 0.5:
        return hit[1]
    states = list(api('torrents_piece_states', torrent_hash=h))
    pieces[h] = (time.time(), states)
    return states


def layout(h, index):
    """(path on disk or None, size, offset in the torrent, piece size) of one of a torrent's files."""
    t = torrent(h)
    files = sorted(api('torrents_files', torrent_hash=h), key=lambda f: f.index)
    if not 0 <= index < len(files):
        raise Refused('That torrent has no such file.')
    f, piece = files[index], api('torrents_properties', torrent_hash=h).piece_size
    offset = sum(x.size for x in files[:index])
    if offset // piece != f.piece_range[0]:   # padded (v2 and hybrid torrents): each file starts on a piece
        offset = f.piece_range[0] * piece
    path = None
    for root in (t.get('download_path'), t.get('save_path')):   # incomplete files can sit in their own folder
        for name in (f.name, f.name + '.!qB'):
            if root and os.path.isfile(os.path.join(root, name)):
                path = path or os.path.join(root, name)
    return path, f.size, offset, piece


def have(h, start, end, offset, piece):
    """Whether the file's bytes [start, end] are downloaded."""
    states = piece_states(h)
    return all(s == 2 for s in states[(offset + start) // piece:(offset + end) // piece + 1])


def ready_from_start(h, size, offset, piece):
    """How many of the file's bytes are downloaded in a row from its start."""
    states, first = piece_states(h), offset // piece
    i = first
    while i < len(states) and states[i] == 2:
        i += 1
    return max(0, min(size, i * piece - offset))


# MARK: - What the TV asks

def search(q):
    if not q.strip():
        return []
    if not any(p.enabled for p in api('search_plugins')):
        raise Refused('qBittorrent has no search plugins: add them in View > Search Engine.')
    job = api('search_start', pattern=q, plugins='enabled', category='all').id
    try:
        deadline = time.time() + 12
        while time.time() < deadline and api('search_status', search_id=job)[0].status != 'Stopped':
            time.sleep(0.7)
        results = api('search_results', search_id=job, limit=300).results
    finally:
        api('search_stop', search_id=job)
        api('search_delete', search_id=job)
    out, seen = [], set()
    for r in sorted(results, key=lambda r: r.nbSeeders, reverse=True):
        if r.fileUrl in seen:
            continue
        seen.add(r.fileUrl)
        out.append({'name': r.fileName, 'size': r.fileSize, 'seeds': max(0, r.nbSeeders), 'url': r.fileUrl})
    return out[:40]


def torrents():
    return [{'hash': t.hash, 'name': t.name, 'size': t.size, 'progress': t.progress}
            for t in api('torrents_info', sort='added_on', reverse=True)[:40]]


def info_hash(data):
    """A .torrent's v1 info hash (the SHA-1 of its bencoded info), or None when the bytes aren't one."""
    def end(i):   # where the bencoded value starting at i ends
        c = data[i:i + 1]
        if c == b'i':
            return data.index(b'e', i) + 1
        if c in (b'l', b'd'):
            i += 1
            while data[i:i + 1] != b'e':
                i = end(i)
            return i + 1
        colon = data.index(b':', i)
        return colon + 1 + int(data[i:colon])
    try:
        i = 1 if data[:1] == b'd' else len(data)
        while data[i:i + 1] not in (b'e', b''):
            key_end = end(i)
            value_end = end(key_end)
            if data[data.index(b':', i) + 1:key_end] == b'info':
                return hashlib.sha1(data[key_end:value_end]).hexdigest()
            i = value_end
    except (ValueError, IndexError, RecursionError):
        pass
    return None


def fetch_torrent(url):
    """A .torrent link's bytes and the address, which is a magnet when the link redirects to one; no bytes when the
    link can't be read here (qBittorrent tries it then)."""
    try:
        for _ in range(5):
            r = requests.get(url, timeout=15, allow_redirects=False, stream=True)
            if not r.is_redirect:
                break
            url = urljoin(url, r.headers.get('Location', ''))
            if url.startswith('magnet:'):
                return None, url
        data = r.raw.read(MAX_TORRENT + 1, decode_content=True)
        if r.status_code == 200 and len(data) <= MAX_TORRENT and info_hash(data):
            return data, url
    except (requests.RequestException, ValueError):
        pass
    return None, url


def added(answer):
    """torrents_add's answer: "Ok." or "Fails." until qBittorrent 5.1, then counts of what it took."""
    if isinstance(answer, str):
        return answer == 'Ok.'
    return bool(answer.get('success_count') or answer.get('pending_count') or answer.get('added_torrent_ids'))


def play(url):
    data = None
    if url.startswith(('http://', 'https://')):
        data, url = fetch_torrent(url)
    m = re.search(r'btih:([0-9a-fA-F]{40})', url)
    known = info_hash(data) if data else m.group(1).lower() if m else None
    if known and api('torrents_info', torrent_hashes=known):   # already there: picked before, or added by you
        return {'hash': known}
    mark = TAG + '-' + uuid.uuid4().hex[:8]   # how to find it again, whatever its hash (v2 torrents have another)
    source = {'torrent_files': data} if data else {'urls': url}
    answer = api('torrents_add', tags=[TAG, mark], is_sequential_download=True, is_first_last_piece_priority=True,
                 **source)
    if not added(answer):
        raise Refused("qBittorrent couldn't add that torrent.")
    deadline = time.time() + 20
    while time.time() < deadline:
        found = api('torrents_info', tag=mark)
        if found:
            api('torrents_remove_tags', tags=mark, torrent_hashes=found[0].hash)
            return {'hash': found[0].hash}
        time.sleep(0.5)
    raise Refused("qBittorrent couldn't get that torrent.")


def pick(files):
    """The torrent's movie: its biggest video, but one the TVs play (MP4, MKV...) over an AVI or WMV of the same film
    when it's at least a tenth of its size (a lighter copy, not a few-minute sample), and never a "sample" file."""
    ext = lambda f: os.path.splitext(f.name)[1].lower()
    videos = [f for f in files if ext(f) in TYPES]
    videos = [f for f in videos if 'sample' not in os.path.basename(f.name).lower()] or videos or files
    biggest = max(f.size for f in videos)
    plays = [f for f in videos if ext(f) in PLAYS and f.size >= biggest / 10]
    return max(plays or videos, key=lambda f: f.size)


def progress(h):
    t = torrent(h)
    if not t.seq_dl:
        api('torrents_toggle_sequential_download', torrent_hashes=h)
    if not t.f_l_piece_prio:
        api('torrents_toggle_first_last_piece_priority', torrent_hashes=h)
    if t.state in ('pausedDL', 'stoppedDL'):
        api('torrents_start' if hasattr(qb, 'torrents_start') else 'torrents_resume', torrent_hashes=h)
    files = sorted(api('torrents_files', torrent_hash=h), key=lambda f: f.index)
    if not files:   # a magnet without its metadata yet
        return {'stage': 'metadata', 'speed': t.dlspeed, 'seeds': t.num_seeds}
    if h not in picked:
        picked[h] = pick(files).index
        others = [f.index for f in files if f.index != picked[h]]
        if others and TAG in [s.strip() for s in t.tags.split(',')]:   # only what the TV added: leave yours alone
            api('torrents_file_priority', torrent_hash=h, file_ids=others, priority=0)
    index = picked[h]
    path, size, offset, piece = layout(h, index)
    done = ready_from_start(h, size, offset, piece)
    need = min(READY, size)
    ready = path is not None and done >= need and have(h, size - 1, size - 1, offset, piece)
    name = files[index].name
    return {'stage': 'ready' if ready else 'downloading', 'file': index, 'name': os.path.basename(name),
            'percent': int(min(done, need) * 100 / max(1, need)), 'speed': t.dlspeed, 'seeds': t.num_seeds}


# MARK: - HTTP

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        line = re.sub(r'([?&]t=)[^& ]*', r'\1…', fmt % args)   # the token stays out of the log
        sys.stderr.write('%s %s\n' % (self.address_string(), line))

    def send_json(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_HEAD(self):
        self.do_GET(body=False)

    def do_GET(self, body=True):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        if token and not hmac.compare_digest(q.get('t', '').encode('utf-8'), token.encode('utf-8')):
            self.send_json(403, {'error': 'Wrong media_token.'})
            return
        try:
            if url.path.startswith('/stream/'):
                parts = url.path.split('/')
                self.stream(unquote(parts[2]).lower(), int(parts[3]), body)
            elif url.path == '/status':
                self.send_json(200, {'qbittorrent': api('app_version')})
            elif url.path == '/search':
                self.send_json(200, search(q.get('q', '')))
            elif url.path == '/torrents':
                self.send_json(200, torrents())
            elif url.path == '/play':
                self.send_json(200, play(q.get('url', '')))
            elif url.path == '/progress':
                self.send_json(200, progress(q.get('hash', '').lower()))
            else:
                self.send_json(404, {'error': 'Not found.'})
        except Refused as e:
            self.send_json(502, {'error': str(e)})
        except (IndexError, ValueError):
            self.send_json(400, {'error': 'Bad request.'})
        except (BrokenPipeError, ConnectionResetError):
            pass   # the TV seeked or stopped: it asks for another range

    def stream(self, h, index, body):
        path, size, offset, piece = layout(h, index)
        if not path:
            raise Refused("The file isn't on disk yet.")
        start, end, status = 0, size - 1, 200
        m = re.match(r'bytes=(\d*)-(\d*)$', self.headers.get('Range', '').strip())
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = min(size - 1, int(m.group(2))) if m.group(2) else size - 1
            else:   # the last n bytes
                start = max(0, size - int(m.group(2)))
            if start > end:
                self.send_response(416)
                self.send_header('Content-Range', 'bytes */%d' % size)
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            status = 206
        self.send_response(status)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Type', TYPES.get(os.path.splitext(path.replace('.!qB', ''))[1].lower(),
                                                   'application/octet-stream'))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(end - start + 1))
        if status == 206:
            self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
        self.end_headers()
        if not body:
            return
        with open(path, 'rb') as f:
            pos = start
            while pos <= end:
                n = min(CHUNK, end + 1 - pos)
                deadline = time.time() + WAIT
                while True:
                    try:
                        if have(h, pos, pos + n - 1, offset, piece):
                            break
                    except Refused:   # the headers went already: only ending the connection says so
                        deadline = 0
                    if time.time() > deadline:
                        self.close_connection = True
                        return
                    time.sleep(0.5)
                f.seek(pos)
                self.wfile.write(f.read(n))
                pos += n


def main():
    global qb, token
    ap = argparse.ArgumentParser(description="Free My TV's media server (qBittorrent search and streaming for the TV).")
    ap.add_argument('--qb', default=os.environ.get('QBITTORRENTAPI_HOST') or 'http://127.0.0.1:8080',
                    help="qBittorrent's Web UI (default %(default)s, or QBITTORRENTAPI_HOST)")
    ap.add_argument('--port', type=int, default=8090, help='port the TVs use (default %(default)s)')
    ap.add_argument('--token', default=os.environ.get('MEDIA_TOKEN', ''), help='the ?t= every request needs (or MEDIA_TOKEN)')
    a = ap.parse_args()
    token = a.token
    if not token:
        print('No MEDIA_TOKEN: anyone who reaches port %d can use qBittorrent. Fine at home, not on a server.' % a.port)
    qb = qbittorrentapi.Client(host=a.qb, REQUESTS_ARGS={'timeout': (5, 30)})
    try:
        print('qBittorrent %s at %s' % (api('app_version'), a.qb))
    except Refused as e:
        print('%s (%s) The server starts anyway.' % (e, a.qb))
    server = ThreadingHTTPServer(('0.0.0.0', a.port), Handler)
    server.daemon_threads = True
    print('Media server on port %d: media_server=http://<this computer\'s IP>:%d in config.properties.' % (a.port, a.port))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
