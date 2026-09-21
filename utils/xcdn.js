const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const state = {
  opts: null,
  rows: [],
  titles: {},
  blacklist: new Set(),
  dead: new Set(),
  deadMeta: {},
  onUpdates: [],
  timer: null,
  started: false,
  lastFetchError: null,
  lastFetchMs: 0
};

function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, {
      headers: { Accept: 'application/json', 'User-Agent': 'xcdn-sync/1.0' }
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > 64e6) { req.destroy(new Error('response too large')); }
      });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.setTimeout(timeoutMs || 15000, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

function readJson(fp, fallback) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { return fallback; }
}

function writeJson(fp, obj) {
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(obj, null, 2));
  } catch (e) {}
}

function absUrl(base, rel) {
  if (!rel) return '';
  return /^https?:\/\//i.test(rel) ? rel : base.replace(/\/+$/, '') + rel;
}

function matchHost(sourceUrl, hosts) {
  if (!sourceUrl || !hosts || !hosts.length) return false;
  let host = '';
  try { host = new URL(sourceUrl).hostname.toLowerCase(); } catch (e) { return false; }
  return hosts.some((h) => {
    const hc = String(h).toLowerCase().replace(/^\.+/, '');
    return hc && (host === hc || host.endsWith('.' + hc));
  });
}

// Extract the tiered CDN source (id) synchronously from a raw API row:
// prefers an explicit `source.url`, else falls back to decoding the masked
// `/t/<token>` (shared WPS Transformer secret) so origin hosts can be
// filtered even when the API does not expose `source`.
const crypto = require('crypto');
function _decryptToken(token, secret) {
  if (!token || !secret) return null;
  const buf = Buffer.from(String(token), 'base64url');
  if (buf.length < 28) return null;
  const key = crypto.createHash('sha256').update(secret).digest();
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  try { return d.update(buf.subarray(28), null, 'utf8') + d.final('utf8'); } catch (e) { return null; }
}
function rowSourceUrl(o, opts) {
  if (o.source && o.source.url) return o.source.url;
  const video = o.video || '';
  const m = /\/t\/([^\/?#]+)/.exec(video);
  if (!m) return '';
  const plain = _decryptToken(m[1], opts.tokenSecret);
  if (!plain) return '';
  try { const obj = JSON.parse(plain); if (obj && obj.u) return obj.u; } catch (e) {}
  return '';
}

function cleanRow(o, opts) {
  if (!o || !o.id) return null;
  if (!o.thumbnail) return null;
  if (state.blacklist.has(String(o.id))) return null;
  if (state.dead.has(String(o.id))) return null;
  const srcUrl = rowSourceUrl(o, opts);
  if (opts.hostFilter && opts.hostFilter.length && !matchHost(srcUrl, opts.hostFilter)) return null;
  if (opts.blockedHosts && opts.blockedHosts.length && matchHost(srcUrl, opts.blockedHosts)) return null;
  if (opts.source === 'file' && !srcUrl) return null;
  if (opts.source === 'api' && !o.video) return null;
  return o;
}

function emit() {
  for (const fn of state.onUpdates) {
    try { fn(state.rows); } catch (e) {}
  }
}

function finalizeRows(raw) {
  const opts = state.opts;
  const clean = raw.map((r) => cleanRow(r, opts)).filter(Boolean);

  const titles = state.titles;
  let maxNum = 0;
  for (const t of Object.values(titles)) {
    const m = /(\d+)$/.exec(String(t));
    if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
  }
  clean.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded) || (a.id < b.id ? -1 : 1));
  for (const r of clean) {
    if (!titles[r.id]) {
      maxNum += 1;
      titles[r.id] = opts.prefix + ' ' + String(maxNum).padStart(4, '0');
    }
  }
  writeJson(opts.titlesFile, titles);

  const rows = clean.map((r) => {
    const src = r.source || {};
    return {
      id: r.id,
      title: titles[r.id] || r.title || r.id,
      video: opts.source === 'api' ? absUrl(opts.cdnBase, r.video) : '',
      preview: opts.source === 'api' && r.preview ? absUrl(opts.cdnBase, r.preview) : '',
      thumbnail: r.thumbnail ? absUrl(opts.cdnBase, '/img/' + r.id) : '',
      views: r.views || 0,
      duration: r.duration || '',
      uploaded: r.uploaded || new Date().toISOString(),
      category: r.category || 'Video',
      tags: r.tags || [],
      srcUrl: rowSourceUrl(r, opts) || src.url || '',
      srcReferer: src.referer || '',
      srcType: src.type || '',
      external: true
    };
  });

  return rows;
}

async function fetchRaw() {
  const opts = state.opts;
  if (opts.source === 'file') {
    const master = readJson(opts.masterFile, null);
    if (!master) throw new Error('master file missing: ' + opts.masterFile);
    return Array.isArray(master) ? master : Object.values(master);
  }
  return getJson(opts.apiUrl, opts.timeoutMs);
}

async function refresh() {
  const opts = state.opts;
  reloadBlacklist();
  let raw;
  try {
    raw = await fetchRaw();
  } catch (err) {
    state.lastFetchError = err.message;
    return false;
  }
  // Pull master's resolver-failure list so permanently dead sources drop off
  // the live index instead of lingering as broken cards.
  try {
    const dead = await getJson(opts.deadApiUrl || (opts.apiUrl.replace(/\/api\/videos$/, '/api/videos/broken')), opts.timeoutMs);
    if (Array.isArray(dead)) {
      state.dead = new Set(dead.map((d) => String(d.id)));
      state.deadMeta = dead.reduce((m, d) => { m[String(d.id)] = (d.reason || d.title || 'dead source'); return m; }, {});
    }
  } catch (e) { /* master health flicker is fine — keep last dead list */ }
  const rows = finalizeRows(raw);
  const changed = rows.length !== state.rows.length ||
    rows.some((r, i) => r.id !== (state.rows[i] && state.rows[i].id) ||
      r.title !== (state.rows[i] && state.rows[i].title));
  state.rows = rows;
  state.lastFetchMs = Date.now();
  writeJson(opts.snapshotFile, rows);
  if (changed) emit();
  return true;
}

function configure(opts) {
  state.opts = null;
  state.rows = [];
  state.titles = {};
  state.blacklist = new Set();
  state.started = false;
  state.lastFetchError = null;
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  state.opts = Object.assign({
    source: 'api',
    cdnBase: 'https://cdn.superxlatina.com',
    apiUrl: 'https://cdn.superxlatina.com/api/videos',
    masterFile: '',
    hostFilter: [],
    blockedHosts: [],
    tokenSecret: '',
    blacklistFile: '',
    deadApiUrl: '',
    prefix: 'Video',
    dir: path.join(process.cwd(), 'data'),
    snapshotFile: '',
    titlesFile: '',
    pollMs: 120000,
    timeoutMs: 15000
  }, opts || {});
  if (!state.opts.snapshotFile) state.opts.snapshotFile = path.join(state.opts.dir, 'xcdn-snapshot.json');
  if (!state.opts.titlesFile) state.opts.titlesFile = path.join(state.opts.dir, 'xcdn-titles.json');
  state.titles = readJson(state.opts.titlesFile, {});
  reloadBlacklist();
}

function reloadBlacklist() {
  state.blacklist = new Set();
  if (state.opts && state.opts.blacklistFile) {
    const bl = readJson(state.opts.blacklistFile, null);
    if (bl && bl.videos && Array.isArray(bl.videos)) {
      bl.videos.forEach((id) => state.blacklist.add(String(id)));
    }
  }
}

async function start() {
  if (state.started) return;
  state.started = true;
  const snap = readJson(state.opts.snapshotFile, null);
  if (Array.isArray(snap) && snap.length) state.rows = snap;
  const ok = await refresh();
  if (!ok) {
    emit();
    console.log(`♻️ [XCDN] offline — using last-good snapshot (${state.rows.length} videos) — ${state.lastFetchError}`);
  }
  state.timer = setInterval(refresh, state.opts.pollMs);
  if (state.timer.unref) state.timer.unref();
  return ok;
}

function stop() {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  state.started = false;
}

function rows() { return state.rows; }

function onUpdate(fn) {
  if (typeof fn === 'function') state.onUpdates.push(fn);
}

module.exports = { configure, start, stop, refresh, rows, onUpdate, reloadBlacklist };