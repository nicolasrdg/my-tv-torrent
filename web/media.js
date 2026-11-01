/*
 * Channels and Torrents, from the drawer: a list to pick from, then full-screen video, on LG and Samsung alike.
 *  - Channels: iptv-org's public list for the TV's country (iptv-org.github.io/iptv, iptv_country in config.properties),
 *    streams the TV plays itself. Typing filters the list; ↑ ↓ and the remote's channel keys change channel.
 *  - Torrents (with media_server in config.properties): search and play through tools/media_server.py on a computer
 *    with qBittorrent, which streams the file while it downloads, from its start.
 * While a list or the video is up, home.js hands the keys here (Media.key).
 * Plain ES5: older TVs run a Chromium from 2015-2017 (webOS 3 and 4, Tizen 3).
 */
var Media = (function () {
  'use strict';

  var SERVER = (CONFIG.mediaServer || '').replace(/\/+$/, '');
  var TOKEN = CONFIG.mediaToken || '';
  var COUNTRY = (CONFIG.iptvCountry || Place.country || 'US').toLowerCase();
  var samsung = typeof window.tizen !== 'undefined' && !!window.tizen.tvinputdevice;
  // The remote's media keys: play, pause, play/pause (Samsung), stop, and channel up and down (LG 33/34, Samsung 427/428).
  var K = {play: 415, pause: 19, playPause: 10252, stop: 413, chUp: samsung ? 427 : 33, chDown: samsung ? 428 : 34};

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, parent, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  function setClass(e, c, on) {
    var has = (' ' + e.className + ' ').indexOf(' ' + c + ' ') >= 0;
    if (on && !has) e.className = (e.className ? e.className + ' ' : '') + c;
    else if (!on && has) e.className = (' ' + e.className + ' ').replace(' ' + c + ' ', ' ').replace(/^\s+|\s+$/g, '');
  }

  /** GET; done(error, text). The server's own message, when it gives one, is the error's. */
  function get(url, timeout, done) {
    var x = new XMLHttpRequest(), over = false;
    x.open('GET', url, true);
    x.timeout = timeout;
    x.onreadystatechange = function () {
      if (x.readyState !== 4 || over) return;
      over = true;
      if (x.status === 200) { done(null, x.responseText); return; }
      var message = x.status ? 'HTTP ' + x.status : 'no connection';
      try { message = JSON.parse(x.responseText).error || message; } catch (e) {}
      done(new Error(message));
    };
    x.ontimeout = x.onerror = function () { if (!over) { over = true; done(new Error('no connection')); } };
    x.send();
  }

  function getJSON(url, timeout, done) {
    get(url, timeout, function (err, text) {
      if (err) { done(err); return; }
      var json;
      try { json = JSON.parse(text); } catch (e) { done(e); return; }
      done(null, json);
    });
  }

  /** An address on the media server, with its token (media_token) when it has one. */
  function server(path) {
    return SERVER + path + (TOKEN ? (path.indexOf('?') < 0 ? '?' : '&') + 't=' + encodeURIComponent(TOKEN) : '');
  }

  function size(bytes) {
    if (!(bytes > 0)) return '';
    return bytes >= 1e9 ? (bytes / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(bytes / 1e6)) + ' MB';
  }

  function clock(s) {
    if (!(s >= 0) || s === Infinity) return '';
    s = Math.floor(s);
    var h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  // MARK: - The list: a field to type in, then what it found

  var mode = null;   // 'channels' or 'torrents' while the list or the video is up
  var items = [];    // what the list shows: {label, value, play}
  var focus = 0;     // 0 is the field
  // Only the rows on screen are drawn, under the field, which stays: a country's 400 channels as rows took the TV's
  // older Chromium a moment on every letter typed and every move.
  var SHOWN = 8, first = 0;
  var status = '', seq = 0, filterTimer = 0;
  var channels = null;   // iptv-org's list, read once

  function sheet() { return $('mediapick'); }
  function field() { return sheet().querySelector('input'); }
  function typing() { return document.activeElement === field(); }

  function open(m) {
    mode = m;
    focus = 0;
    first = 0;
    items = [];
    status = '';
    seq++;
    var box = sheet().firstChild;
    box.innerHTML = '';
    el('div', 'title', box, m === 'channels' ? tr('Channels') : tr('Torrents'));
    var list = el('div', 'list', box);
    var f = el('input', '', el('div', 'row field', list));
    f.type = 'text';
    f.placeholder = tr('Search');
    f.setAttribute('autocomplete', 'off');
    f.setAttribute('spellcheck', 'false');
    // Channels filters as you type, once the typing pauses: not a whole new list on every letter.
    f.oninput = function () {
      if (mode !== 'channels') return;
      clearTimeout(filterTimer);
      filterTimer = setTimeout(filterChannels, 250);
    };
    pointer(f.parentNode, 0);
    el('div', 'items', list);
    el('div', 'hint', box);
    setClass(sheet(), 'open', true);
    if (m === 'channels') loadChannels(); else loadTorrents();
    render();
  }

  function close() {
    stop();
    clearTimeout(filterTimer);
    if (typing()) field().blur();
    setClass(sheet(), 'open', false);
    mode = null;
    seq++;
  }

  /** The rows on screen under the field, from items[first]; the field itself stays, so the TV's keyboard isn't interrupted. */
  function render() {
    var holder = sheet().querySelector('.items');
    holder.innerHTML = '';
    for (var i = first; i < items.length && i < first + SHOWN; i++) {
      var row = el('div', 'row item', holder);
      el('span', 'name', row, items[i].label);
      if (items[i].value) el('span', 'value', row, items[i].value);
      row.index = i + 1;
      pointer(row, i + 1);
    }
    focusRows();
  }

  function focusRows() {
    var rows = sheet().querySelectorAll('.row');
    for (var i = 0; i < rows.length; i++) setClass(rows[i], 'focus', (rows[i].index || 0) === focus && !playing);
    // Where the focus is in a long list, as the language list says it.
    var at = focus > 0 && items.length > SHOWN ? focus + ' / ' + items.length + '  ·  ' : '';
    sheet().querySelector('.hint').textContent = status || at + tr('OK picks, Back cancels.');
  }

  /** The focus to items[index - 1] (0: the field), the rows shown following it. */
  function focusOn(index) {
    focus = Math.max(0, Math.min(items.length, index));
    var i = focus - 1, was = first;
    if (i >= 0 && i < first) first = i;
    else if (i >= first + SHOWN) first = i - SHOWN + 1;
    first = Math.max(0, Math.min(first, items.length - SHOWN));
    if (first !== was) render(); else focusRows();
  }

  function setStatus(text) {
    status = text;
    if (mode) render();
  }

  function pointer(node, index) {
    node.onmouseover = function () { if (!playing && !typing() && focus !== index) { focus = index; focusRows(); } };
    node.onclick = function () { focus = index; pick(); };
  }

  function pick() {
    if (focus === 0) { field().focus(); return; }
    if (items[focus - 1]) items[focus - 1].play(focus - 1);
  }

  /** OK (or the keyboard's Done) in the field: Torrents searches; Channels already filtered, so to the first one. */
  function done() {
    field().blur();
    if (mode === 'torrents') search(field().value);
    else if (items.length) focusOn(1);
  }

  // MARK: - Channels: iptv-org's playlist for the country

  function loadChannels() {
    if (channels) { filterChannels(); return; }
    setStatus(tr('Searching…'));
    var mine = seq;
    get('https://iptv-org.github.io/iptv/countries/' + COUNTRY + '.m3u', 20000, function (err, text) {
      if (mine !== seq) return;
      if (err) { setStatus(trf("Couldn't search now: {error}", {error: err.message})); return; }
      channels = parseM3U(text);
      status = '';
      filterChannels();
    });
  }

  /** #EXTINF lines (their group-title and the name after the comma), each followed by its stream's address. */
  function parseM3U(text) {
    var lines = text.split(/\r?\n/), out = [], info = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/^\s+|\s+$/g, '');
      if (line.indexOf('#EXTINF') === 0) {
        var group = /group-title="([^"]*)"/.exec(line), quote = line.lastIndexOf('"');
        var name = line.slice(line.indexOf(',', quote > 0 ? quote : 0) + 1);
        group = group ? group[1].split(';')[0] : '';
        info = {name: name.replace(/\s*\[[^\]]*\]/g, '').replace(/\s*\(\d+p\)/g, ''), group: group === 'Undefined' ? '' : group};
      } else if (line && line.charAt(0) !== '#' && info) {
        info.url = line;
        out.push(info);
        info = null;
      }
    }
    out.sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; });
    return out;
  }

  function filterChannels() {
    if (!channels) return;
    var q = field().value.toLowerCase().replace(/^\s+|\s+$/g, '');
    items = [];
    for (var i = 0; i < channels.length && items.length < 500; i++) {
      var c = channels[i];
      if (q && (c.name + ' ' + c.group).toLowerCase().indexOf(q) < 0) continue;
      items.push({label: c.name, value: c.group, url: c.url, play: playChannel});
    }
    focus = Math.min(focus, items.length);
    first = 0;
    status = items.length ? '' : tr('No results.');
    render();
  }

  function playChannel(i) {
    var c = items[i];
    show(c.label, i);
    video.src = c.url;
    video.play();
  }

  // MARK: - Torrents: through tools/media_server.py

  function loadTorrents() {
    setStatus(tr('Connecting…'));
    var mine = seq;
    getJSON(server('/torrents'), 15000, function (err, list) {
      if (mine !== seq || field().value) return;
      if (err) { setStatus(trf("Couldn't search now: {error}", {error: err.message})); return; }
      items = [];
      first = 0;
      for (var i = 0; i < list.length; i++) {
        items.push({label: list[i].name, value: Math.floor(list[i].progress * 100) + '%', hash: list[i].hash, play: playTorrent});
      }
      setStatus('');
    });
  }

  function search(q) {
    if (!q.replace(/\s+/g, '')) { loadTorrents(); return; }
    setStatus(tr('Searching…'));
    var mine = ++seq;
    getJSON(server('/search?q=' + encodeURIComponent(q)), 30000, function (err, list) {
      if (mine !== seq) return;
      if (err) { setStatus(trf("Couldn't search now: {error}", {error: err.message})); return; }
      items = [];
      for (var i = 0; i < list.length; i++) {
        items.push({label: list[i].name, value: list[i].seeds + ' ↑  ·  ' + size(list[i].size), url: list[i].url, play: playTorrent});
      }
      focus = items.length ? 1 : 0;
      first = 0;
      setStatus(items.length ? '' : tr('No results.'));
    });
  }

  function playTorrent(i) {
    var t = items[i];
    show(t.label, i);
    say(tr('Connecting…'));
    var mine = playSeq;
    if (t.hash) { follow(t.hash, mine); return; }
    getJSON(server('/play?url=' + encodeURIComponent(t.url)), 30000, function (err, res) {
      if (mine !== playSeq) return;
      if (err) { say(trf('Error: {error}.', {error: err.message})); return; }
      t.hash = res.hash;   // picked again: no second add
      follow(res.hash, mine);
    });
  }

  /** Asks every second how much is ready from the start; plays once the server says it is. */
  function follow(hash, mine) {
    getJSON(server('/progress?hash=' + hash), 15000, function (err, p) {
      if (mine !== playSeq) return;
      if (err) { say(trf('Error: {error}.', {error: err.message})); return; }
      if (p.stage !== 'ready') {
        var rate = p.speed > 0 ? size(p.speed) + '/s' : '';
        say(tr('Downloading…') + '  ' + (p.percent || 0) + '%' + (rate ? '  ·  ' + rate : '') + '  ·  ' + (p.seeds || 0) + ' ↑');
        playTimer = setTimeout(function () { follow(hash, mine); }, 1000);
        return;
      }
      $('player').querySelector('.name').textContent = p.name;
      video.src = server('/stream/' + hash + '/' + p.file + '/' + encodeURIComponent(p.name));
      video.play();
    });
  }

  // MARK: - The video

  var video = null, playing = false, playIndex = 0, playSeq = 0, playTimer = 0, barTimer = 0, keysAsked = false;

  function show(name, index) {
    stop();
    playing = true;
    playIndex = index;
    if (samsung && !keysAsked) {   // Samsung sends the media and channel keys only to apps that ask for them
      keysAsked = true;
      try { window.tizen.tvinputdevice.registerKeyBatch(['MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaStop', 'ChannelUp', 'ChannelDown']); } catch (e) {}
    }
    var p = $('player');
    p.querySelector('.name').textContent = name;
    p.querySelector('.time').textContent = '';
    setClass(p, 'open', true);
    setClass(document.body, 'playing', true);   // home.css hides what's under the video: the TV stops drawing it
    focusRows();
    say(tr('Connecting…'));
  }

  /** The line under the name; the bar stays up while it has something to say. */
  function say(text) {
    $('player').querySelector('.status').textContent = text;
    bar(!!text);
  }

  function bar(stay) {
    var b = $('player').querySelector('.bar');
    setClass(b, 'on', true);
    clearTimeout(barTimer);
    if (!stay) barTimer = setTimeout(function () { if (!video.paused) setClass(b, 'on', false); }, 4000);
  }

  function stop() {
    playSeq++;
    clearTimeout(playTimer);
    if (!playing) return;
    playing = false;
    video.pause();
    video.removeAttribute('src');
    try { video.load(); } catch (e) {}   // lets go of the stream and the TV's decoder
    setClass($('player'), 'open', false);
    setClass(document.body, 'playing', false);
    focusRows();
  }

  function seek(d) {
    if (!isFinite(video.duration)) return;   // a live channel
    video.currentTime = Math.max(0, Math.min(video.duration - 1, video.currentTime + d));
    bar(false);
  }

  /** Channels: the next (d 1) or previous one in the list, round. */
  function zap(d) {
    if (mode !== 'channels' || !items.length) return;
    var i = (playIndex + d + items.length) % items.length;
    focusOn(i + 1);   // the list follows, for when the video closes
    playChannel(i);
  }

  function makePlayer() {
    var p = $('player');
    video = el('video', '', p);
    var b = el('div', 'bar', p);
    el('div', 'name', b);
    el('div', 'status', b);
    el('div', 'time', b);
    video.addEventListener('playing', function () { say(''); });
    video.addEventListener('waiting', function () { if (playing) say(mode === 'torrents' ? tr('Downloading…') : tr('Connecting…')); });
    video.addEventListener('pause', function () { if (playing) bar(true); });
    video.addEventListener('timeupdate', function () {
      var t = clock(video.currentTime), d = clock(video.duration);
      p.querySelector('.time').textContent = d ? t + ' / ' + d : t;
    });
    video.addEventListener('error', function () {
      if (playing && video.getAttribute('src')) say(trf("Couldn't open {app}.", {app: p.querySelector('.name').textContent}));
    });
  }

  // MARK: - Keys

  /** A key while a list or the video is up: true when it was ours (home.js does nothing more with it). */
  function key(e) {
    if (!mode) return false;
    var k = e.keyCode;
    if (typing()) {   // the keys type; OK or Done searches, Back or Cancel leaves the field (Samsung: 65376, 65385)
      if (k === TV.keys.ok || k === 65376) done();
      else if (k === TV.keys.back || k === 27 || k === 65385) field().blur();
      else if (k === TV.keys.down) { field().blur(); move(1); }
      else return true;
      e.preventDefault();
      return true;
    }
    if (playing) {
      if (k === TV.keys.back || k === 27 || k === 8 || k === K.stop) stop();
      else if (k === TV.keys.ok || k === K.playPause) { if (video.paused) video.play(); else video.pause(); bar(false); }
      else if (k === K.play) video.play();
      else if (k === K.pause) video.pause();
      else if (k === TV.keys.left) seek(-10);
      else if (k === TV.keys.right) seek(30);
      else if (k === TV.keys.up || k === K.chUp) { if (mode === 'channels') zap(-1); else bar(false); }
      else if (k === TV.keys.down || k === K.chDown) { if (mode === 'channels') zap(1); else bar(false); }
      else return true;
      e.preventDefault();
      return true;
    }
    if (k === TV.keys.up) move(-1);
    else if (k === TV.keys.down) move(1);
    else if (k === TV.keys.ok) pick();
    else if (k === TV.keys.back || k === 27 || k === 8) close();
    else return true;
    e.preventDefault();
    return true;
  }

  function move(d) {
    focusOn(focus + d);
  }

  makePlayer();

  return {
    /**
     * Channels and Torrents as apps, first on the shelf (Torrents only with a media server in config.properties):
     * a name, a symbol and a color for their tiles, and what OK does.
     */
    apps: function () {
      var list = [{id: 'freemytv.channels', title: tr('Channels'), symbol: 'tv', color: '#0A84FF', run: function () { open('channels'); }}];
      if (SERVER) list.push({id: 'freemytv.torrents', title: tr('Torrents'), symbol: 'play', color: '#2FB36A', run: function () { open('torrents'); }});
      return list;
    },
    /** A list or the video is up: no screensaver, and the keys come here. */
    active: function () { return !!mode; },
    /** The video is up: the TV's screensaver waits too. */
    playing: function () { return playing && !video.paused; },
    close: function () { if (mode) close(); },
    key: key
  };
})();
