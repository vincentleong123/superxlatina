// utils/resolvers.js
// Per-source-type resolver registry — ported from wps-transformer-player.
//
// A "real WPS transformer" doesn't assume every site works the same way —
// different origins hide their streams behind different machinery (KTube /
// Kernel-Team flashvars, generic HTML, JSON configs, or a Cloudflare JS
// challenge). Each source is routed to the resolver that fits it best:
//
//   direct / hls   → pass-through (no scraping)
//   embed          → host route table → generic scraper → browser engine
//
// The browser engine (Playwright/Chromium) renders JS-challenged pages
// (e.g. newsexwap.com returns an EMPTY body to plain HTTP clients) so we can
// actually read the page and capture the real media URL. Every resolution
// returns the permanent page source alone; the final signed stream is minted
// at playback time, so expired CDN tokens self-heal.
'use strict';

const transformer = require('./transformer');

let CFG = {
  browser: {
    enabled: true,
    // fall back to a real browser when plain-HTTP scraping yields nothing
    // (empty body / JS challenge / SPA-only markup)
    fallback: true,
    timeoutMs: 45000,
    waitMs: 6000,            // settle time after page load before extracting
    maxConcurrent: 2,        // simultaneous browser tabs
    maxRenders: 60,          // soft cap before recycling the browser
    headless: true
  },
  routes: {}                  // extra host → { type, pattern }.matches } overrides
};

function init(cfg) {
  if (cfg && typeof cfg === 'object') {
    if (cfg.browser) CFG.browser = Object.assign({}, CFG.browser, cfg.browser);
    if (cfg.routes) CFG.routes = Object.assign({}, CFG.routes, cfg.routes);
  }
}
function config() { return CFG; }

// ── host routing ────────────────────────────────────────────────────────────
// Adapters are tried in order until one returns a media URL. The `routes`
// table is consulted first (admin override), then a few well-known handlers,
// then the generic scraper, then the browser engine.

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; }
}

// Try every strategy in order for an embed source. Returns
//   { url, type, referer, ua, via }  or null
async function resolve(source, opts) {
  opts = opts || {};
  const url = source && source.url;
  if (!url) return null;

  // 1. Direct/HLS pass-through — nothing to scrape.
  const st = (source.type || typeFromUrl(url)).toLowerCase();
  if (st === 'direct' || st === 'hls') {
    return {
      url,
      referer: source.referer || '',
      type: st,
      ua: source.ua || '',
      via: 'direct'
    };
  }

  const host = hostOf(url);
  const pageRef = pageOrigin(url);

  // 2a. Host-specific resolvers (cheap, no browser, targeted).
  const byHost = await hostResolver(host, url, source);
  if (byHost) return byHost;

  // 2b. Extract media from the page HTML (cheap, no browser).
  let html = null;
  try {
    html = await transformer.fetchPageText(url, { url, referer: source.referer || '', ua: source.ua || '' });
  } catch (e) {
    html = null;
  }

  if (html && html.length > 0) {
    const byHtml = await fromHtml(html, url, source, pageRef);
    if (byHtml) return byHtml;
  } else if (html && html.length === 0) {
    // Empty body — a strong signal of a Cloudflare JS challenge.
    trace('empty body from ' + url + ' (host ' + host + ')');
  }

  // 3. Browser engine fallback (renders JS, captures network media).
  if (CFG.browser.enabled && CFG.browser.fallback && opts.allowBrowser !== false) {
    const byBrowser = await fromBrowser(url, source, pageRef, opts);
    if (byBrowser) return byBrowser;
  }

  return null;
}

function typeFromUrl(url) {
  if (/\.m3u8(\?|$|#)/i.test(url)) return 'hls';
  if (/\.mp4(\?|$|#|\/)/i.test(url)) return 'direct';
  return 'embed';
}

function pageOrigin(url) {
  try { return new URL(url).origin + '/'; } catch (e) { return ''; }
}

// ── host-specific resolvers ─────────────────────────────────────────────────
// Forward-declared per-origin handlers. These run BEFORE the generic HTML
// scraper because some sites (YouPorn) keep the real media URL out of the
// watch page and expose it only on the embed page / a JSON config.
async function hostResolver(host, url, source) {
  if (host === 'youporn.com' || host.endsWith('.youporn.com')) {
    return youpornResolver(url, source);
  }
  return null;
}

// YouPorn: the /watch/{id}/ page only carries thumbnail/preview clips (the
// ~9s "mediabook" previews) — the actual video is served from /media/hls/ or
// /media/mp4/ behind a signed `?s=` token. That endpoint is declared in the
// VideoConfig block of the /embed/{id}/ page. We rewrite to the embed page,
// scrape the mediaDefinition / videoUrl, and return the HLS stream.
async function youpornResolver(url, source) {
  try {
    const u = new URL(url);
    const idMatch = u.pathname.match(/^\/(?:watch|embed|video)\/(\d+)\/?/);
    if (!idMatch) return null;
    const id = idMatch[1];

    const embedUrl = u.origin + '/embed/' + id + '/';
    const ref = source.referer || u.origin + '/';

    let html = null;
    try {
      html = await transformer.fetchPageText(embedUrl, { url: embedUrl, referer: ref, ua: source.ua || '' });
    } catch (e) {
      return null;
    }
    if (!html || !html.length) return null;

    // Parse the VideoConfig block for mediaDefinition / videoUrl entries.
    const block = html.match(/VideoConfig\s*=\s*\{[\s\S]{0,30000}?\};/i) || html.match(/VideoConfig\s*=\s*\{[\s\S]{0,30000}?\}\s*(?:;|<\/script>|$)/i);
    if (!block) return null;

    const parsed = extractYoupornMedia(block[0]);
    if (!parsed) return null;

    // The /media/hls/?s=... endpoint itself returns a JSON array of quality
    // variants (each with a real .m3u8 videoUrl), NOT an m3u8 — so resolve it
    // to the concrete CDN master playlist before handing it back.
    const streamUrl = await resolveYoupornStream(parsed.url, ref, source.ua || '');
    if (!streamUrl) return null;

    return {
      url: streamUrl,
      referer: ref,
      type: /\.m3u8(\/?[\?#]|$)/i.test(streamUrl) ? 'hls' : 'direct',
      ua: source.ua || '',
      via: 'youporn'
    };
  } catch (e) {
    trace('youporn resolver error: ' + e.message);
    return null;
  }
}

async function resolveYoupornStream(mediaUrl, ref, ua) {
  // It may already be a direct .m3u8 (mp4 endpoint returns JSON too).
  if (/\.m3u8(\/?[\?#]|$)/i.test(mediaUrl)) return mediaUrl;
  if (/\/media\/mp4\//i.test(mediaUrl)) {
    // mp4 endpoint returns a JSON list as well — fall through to parse.
  }
  let text;
  try {
    text = await transformer.fetchPageText(mediaUrl, {
      url: mediaUrl, referer: ref || '', ua
    });
  } catch (e) {
    return null;
  }
  if (!text) return null;

  // JSON array of quality variants, each with a real .m3u8 videoUrl.
  if (/^\s*\[/.test(text)) {
    let arr;
    try {
      arr = JSON.parse(text);
    } catch (e) {
      return null;
    }
    if (!Array.isArray(arr) || !arr.length) return null;
    // Prefer the default/highest quality; otherwise first entry.
    const pick = arr.find(v => v && v.defaultQuality) || arr.find(v => v && /hls/i.test(v.format)) || arr[0];
    if (pick && pick.videoUrl) return decodeEntitiesYp(pick.videoUrl);
    return null;
  }
  // Plain m3u8 playlist body.
  if (/^#EXTM3U/i.test(text)) return mediaUrl;
  return null;
}

// Pull the playable media URL out of the YouPorn VideoConfig JSON. Prefer the
// adaptive HLS master (returns a proper m3u8 with all qualities) over the
// direct MP4 endpoint.
function extractYoupornMedia(blockText) {
  // Locate the mediaDefinition array entries: {"format":...,"videoUrl":"..."}
  const entries = [];
  const re = /\{"format"\s*:\s*"([^"]+)","[^}]*?"videoUrl"\s*:\s*"([^"]+)"/gi;
  let m;
  while ((m = re.exec(blockText))) {
    entries.push({ format: m[1], url: m[2] });
  }

  // Fallback: single videoUrl key inside a mediaDefinition object we couldn't
  // pair cleanly, or a top-level videoUrl.
  if (!entries.length) {
    const single = blockText.match(/"videoUrl"\s*:\s*"([^"]+)"/i);
    if (single) return { url: decodeEntitiesYp(single[1]), type: pickYpType(single[1]) };
    return null;
  }

  // Prefer HLS master when present, else the MP4 endpoint.
  const hls = entries.find(e => /hls/i.test(e.format));
  if (hls && hls.url) return { url: decodeEntitiesYp(hls.url), type: 'hls' };
  if (entries.length && entries[0].url) {
    return { url: decodeEntitiesYp(entries[0].url), type: pickYpType(entries[0].url) };
  }
  return null;
}

function decodeEntitiesYp(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\\\//g, '/');
}

function pickYpType(u) {
  return /\.m3u8(\/?[\?#]|$)/i.test(u) ? 'hls' : 'direct';
}

// ── HTML scraping path ─────────────────────────────────────────────────────
async function fromHtml(html, url, source, pageRef) {
  const referer = source.referer || pageRef;
  const ua = source.ua || '';

  // Generic extraction (KTube flashvars ladder + full-URL scan).
  const urls = transformer.extractStreamUrls(html);
  let picked = urls.m3u8[0] || urls.mp4[0];

  // Host-specific hints that the generic scan may miss / rank poorly.
  if (!picked) picked = hostHint(html, url);

  if (!picked) return null;

  const type = /\.m3u8(\?|$|#)/i.test(picked) ? 'hls' : (/\.mp4(\?|$|#)/i.test(picked) ? 'direct' : 'direct');
  return {
    url: picked,
    referer: referer || pageRef,
    type,
    ua,
    via: 'html'
  };
}

// A few known origins have a stable, self-healing endpoint worth preferring
// over a grabbed CDN link (they hand out a fresh signed URL on each hit).
function hostHint(html, url) {
  const host = hostOf(url);
  const getvid = html.match(/https?:\/\/[^\s"'<>()]+?\/getvid\/[^\s"'<>()]+?\.mp4(?:[^\s"'<>()]*)?/i);
  if (getvid) return getvid[0];
  // kernel-team sites frequently expose a JSON api/config next to the page.
  const jsonApi = html.match(/https?:\/\/[^\s"'<>()]+\/api\/[^\s"'<>()]+\/player_config\.json[^\s"'<>()]*/i);
  if (jsonApi) return jsonApi[0];
  return null;
}

// ── Browser engine path (Playwright) ───────────────────────────────────────
let _browser = null;
let _renders = 0;
let _busy = 0;
let _bootPromise = null;

async function _getBrowser() {
  if (_browser && !_browser.isConnected()) _browser = null;
  if (_browser) return _browser;
  if (_bootPromise) return _bootPromise;
  let playwright;
  try {
    playwright = require('playwright');
  } catch (e) {
    trace('playwright not installed: ' + e.message);
    CFG.browser.enabled = false;
    return null;
  }
  _bootPromise = (async () => {
    try {
      const b = await playwright.chromium.launch({
        headless: CFG.browser.headless,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage']
      });
      _browser = b;
      trace('browser engine online');
    } catch (e) {
      trace('browser launch failed: ' + e.message);
      CFG.browser.enabled = false;
    } finally {
      _bootPromise = null;
    }
    return _browser;
  })();
  return _bootPromise;
}

async function _withConcurrency() {
  while (_busy >= CFG.browser.maxConcurrent) {
    await new Promise(r => setTimeout(r, 60));
  }
  _busy++;
  return () => { _busy--; };
}

async function fromBrowser(url, source, pageRef, opts) {
  try {
    const release = await _withConcurrency();
    try {
      const browser = await _getBrowser();
      if (!browser) return null;
      // recycle after many renders to avoid memory creep
      if (_renders >= CFG.browser.maxRenders) { _renders = 0; try { await browser.close(); } catch (e) {} _browser = null; }

      const context = await browser.newContext({
        userAgent: source.ua || transformer.getUserAgent() || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
        locale: 'en-US',
        extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
      });
      const page = await context.newPage();
      _renders++;

      const cap = (opts && opts.captureMedia) === false;
      const mediaSeen = [];
      if (!cap) {
        page.on('response', r => {
          const u = r.url();
          if (/\.m3u8(\?|$|#)/i.test(u)) mediaSeen.push(u);
          else if (/\.mp4(\?|$|#)/i.test(u)) mediaSeen.push(u);
        });
      }
      page.on('console', () => {});
      page.on('pageerror', () => {});

      const result = await new Promise((resolveP) => {
        let settled = false;
        const done = (val) => { if (!settled) { settled = true; resolveP(val); } };
        const timer = setTimeout(() => done(null), CFG.browser.timeoutMs);

        page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(CFG.browser.timeoutMs, 40000) })
          .then(() => page.waitForTimeout(CFG.browser.waitMs))
          .then(() => page.evaluate(() => {
            // grab <video>/<source>/poster and inline JSON in one pass
            const out = { sources: [], html: document.documentElement.outerHTML, title: document.title };
            document.querySelectorAll('video, source').forEach(el => {
              const s = el.src || el.currentSrc || (el.getAttribute && (el.getAttribute('src') || ''));
              if (s) out.sources.push(s);
            });
            document.querySelectorAll('iframe').forEach(el => { if (el.src) out.sources.push(el.src); });
            return out;
          }))
          .then((info) => {
            clearTimeout(timer);
            if (!info || !info.html) return done(null);
            done({ info, mediaSeen });
          })
          .catch(() => { clearTimeout(timer); done(null); });
      });

      // tear down the tab
      context.close().catch(() => {});
      if (!result) return null;

      let picked = null;
      // highest priority: media URLs captured over the network
      if (!picked && result.mediaSeen && result.mediaSeen.length) picked = pickMedia(result.mediaSeen);
      // then explicit srcs on the page
      if (!picked && result.info.sources && result.info.sources.length) picked = pickMedia(result.info.sources);
      // then re-scan the rendered HTML (flashvars/JSON now populated)
      if (!picked && result.info.html) {
        const urls = transformer.extractStreamUrls(result.info.html);
        picked = urls.m3u8[0] || urls.mp4[0] || hostHint(result.info.html, url);
      }
      if (!picked) return null;

      const type = /\.m3u8(\?|$|#)/i.test(picked) ? 'hls' : 'direct';
      const referer = source.referer || pageRef;
      return { url: picked, referer: referer || pageRef, type, ua: source.ua || '', via: 'browser' };
    } finally {
      release();
    }
  } catch (e) {
    trace('browser resolve error: ' + e.message);
    return null;
  }
}

// pick the most likely *real* media URL from a candidate list (prefer hls/mp4,
// avoid obvious trackers/screenshots/ads)
function pickMedia(list) {
  const seen = new Set();
  const ranked = [];
  for (const raw of list) {
    let u = String(raw || '').trim();
    if (!u || seen.has(u)) continue;
    // strip trailing quotes/braces from scrubbed srcs
    u = u.replace(/["'\]\)>]+$/, '');
    if (!/^(https?:)?\/\//i.test(u)) continue; // allow protocol-relative
    seen.add(u);
    if (/\.(jpg|jpeg|png|webp|gif|avif)(\?|#|$)/i.test(u)) continue;
    if (/ads|track|beacon|analytics|screenshot|preview(_preroll)?\.mp4/i.test(u)) continue;
    // YouPorn "mediabook" clips are short ~9s previews, not the real video.
    if (/_fb\.mp4(\/|$|\?)|360P_360K/i.test(u)) continue;
    let score = 0;
    if (/\/(get_file|getvideo|getvid|files|video|media|stream)/i.test(u)) score -= 8;
    if (/\.m3u8(\?|$|#)/i.test(u)) score -= 6;
    else if (/\.mp4(\?|$|#)/i.test(u)) score -= 5;
    if (/cdn|akamai|cloudfront|b-cdn|vod|m3u8/i.test(u)) score -= 2;
    if (/[?&]secure=|[?&]v-acctoken=|[?&]token=/i.test(u)) score -= 1;
    ranked.push({ u, score });
  }
  ranked.sort((a, b) => a.score - b.score);
  return ranked.length ? ranked[0].u : null;
}

// close the shared browser (call on shutdown)
async function shutdown() {
  if (_browser) { try { await _browser.close(); } catch (e) {} _browser = null; }
}

function trace(msg) {
  if (CFG.debug) console.error('[resolvers] ' + msg);
}

// Convenience: resolve an embed source then hand the caller both the page's
// metadata and the resolved media (used at ingest time so titles/thumbnails
// are populated even when the origin is JS-gated).
async function resolveWithMeta(source, opts) {
  const resolved = await resolve(source, opts);
  let meta = {};
  let html = null;
  try {
    html = await transformer.fetchPageText(source.url, { url: source.url, referer: source.referer || '', ua: source.ua || '' });
  } catch (e) { html = null; }
  if (html && html.length) {
    meta = transformer.extractPageMeta(html, source.url);
  } else if (CFG.browser.enabled) {
    // page was empty (JS challenge) — render it once to pull meta
    meta = await browserMeta(source, opts) || {};
  }
  return { resolved, meta, via: resolved ? resolved.via : '' };
}

async function browserMeta(source, opts) {
  try {
    const release = await _withConcurrency();
    try {
      const browser = await _getBrowser();
      if (!browser) return null;
      const context = await browser.newContext({
        userAgent: source.ua || transformer.getUserAgent() || 'Mozilla/5.0',
        locale: 'en-US'
      });
      const page = await context.newPage();
      _renders++;
      let html = null;
      try {
        await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: Math.min(CFG.browser.timeoutMs, 40000) });
        await page.waitForTimeout(CFG.browser.waitMs);
        html = await page.evaluate(() => document.documentElement.outerHTML);
      } catch (e) {}
      context.close().catch(() => {});
      return html ? transformer.extractPageMeta(html, source.url) : null;
    } finally {
      release();
    }
  } catch (e) {
    return null;
  }
}

module.exports = { init, resolve, resolveWithMeta, shutdown, config, hostOf };