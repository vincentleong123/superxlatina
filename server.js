const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Loki = require('lokijs');

// Transformer — hotlink engine for external tube sources (see utils/transformer.js)
const transformer = require('./utils/transformer');

// Ingest — bulk-import external video URLs (see utils/ingest.js)
const ingest = require('./utils/ingest');

// Thumb — cached origin-image store (see utils/thumb.js)
const thumb = require('./utils/thumb');

// xcdn — live sync of the shared CDN library (clean entries only, stable
// rewritten titles, snapshot fallback, hot-swap without restart).
const xcdn = require('./utils/xcdn');

const app = express();
app.set('trust proxy', 1);          // Cloudflare tunnel → use real visitor IP (X-Forwarded-For)
app.disable('x-powered-by');        // hide Express fingerprint
const server = http.createServer(app);

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const PREVIEW_FOLDER = 'C:/Users/User/Desktop/hentai_previews';

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const IMPORTS_DIR = path.resolve(__dirname, config.importsFolder ? config.importsFolder : 'data/imports');
const PORT = process.env.PORT || config.port || 7005;
const IS_PROD = process.env.NODE_ENV === 'production';
const SITE_BASE = config.siteUrl || (IS_PROD ? 'https://superxlatina.com' : `http://localhost:${PORT}`);

// Transformer engine init (hotlink proxy for external sources)
transformer.init(Object.assign({
  enabled: true,
  secret: config.tokenSecret || '',
  fallbackSecret: config.tokenSecret || '',
  hostReferers: config.transformer?.hostReferers || {}
}, config.transformer || {}));

// Resolver registry + browser fallback (renders JS-challenged pages like
// newsexwap.com so imports get real titles/thumbnails).
const resolvers = require('./utils/resolvers');
resolvers.init({ browser: config.browser || {} });

// Cached thumbnail store (see utils/thumb.js) — downloads each origin image
// once through the throttled transformer, then serves it from disk forever.
thumb.init(config);
try { fs.mkdirSync(IMPORTS_DIR, { recursive: true }); } catch (e) {}

// ── Admin auth ──────────────────────────────────────────────────────────────
// Cookie-based admin session (HMAC-signed, time-limited). Any /admin route or
// /api/* mutation requires a valid session signed with the configured
// adminPassword; a raw password or forged cookie is rejected with 401.
const ADMIN_COOKIE = 'sxh_admin';
const ADMIN_SESSION_HOURS = 12;
const adminKey = crypto.createHash('sha256').update('superxlatina-admin:' + (config.adminPassword || '')).digest();

function adminSign(ts) {
  return crypto.createHmac('sha256', adminKey).update(String(ts)).digest('hex');
}

function adminCookieValid(raw) {
  if (!raw || typeof raw !== 'string') return false;
  const dot = raw.indexOf('.');
  if (dot <= 0) return false;
  const ts = parseInt(raw.slice(0, dot), 10);
  const sig = raw.slice(dot + 1);
  if (!ts || isNaN(ts)) return false;
  const now = Date.now();
  if (ts > now || now - ts > ADMIN_SESSION_HOURS * 3600 * 1000) return false;
  const expected = adminSign(ts);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readAdminSession(req) {
  try {
    return adminCookieValid(req.cookies && req.cookies[ADMIN_COOKIE]);
  } catch (e) { return false; }
}

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(compression());

// Helmet — keep CSP off (views use inline scripts/styles), but allow
// cross-origin media so video/thumbnail tags work on tube sites & players.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: false
}));

// In-memory rate limiter — bot-aware, no extra deps.
// Whitelist your own IPs here (config.json → trustedIps) so you are never blocked.
const rlStore = new Map();
const RL_WINDOW = 60000;       // 1 minute
const RL_MAX = 600;            // dynamic pages / API
const RL_STATIC_MAX = 5000;    // static files (css/js/img) — generous for media-heavy pages
const TRUSTED_IPS = new Set((config.trustedIps || []).map(s => String(s).trim()));
const BOT_PATTERNS = [
  /googlebot/i, /bingbot/i, /yandex/i, /baiduspider/i, /duckduckbot/i,
  /facebookexternalhit/i, /linkedinbot/i, /whatsapp/i, /telegrambot/i,
  /applebot/i, /crawl/i, /spider/i, /robot/i, /mediapartners/i
];
function isBot(ua) {
  return !!ua && BOT_PATTERNS.some(re => re.test(ua));
}
// Media streams (/videos range fetches, /thumbnails) are served straight from
// disk + CDN cache; throttling them just breaks hover previews and playback.
// /t is the Transformer proxy (external hotlinks) — same treatment.
const RL_MEDIA_PATHS = ['/videos', '/thumbnails', '/previews', '/t', '/tx'];
function rateLimit(req, res, next) {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  if (TRUSTED_IPS.has(ip)) return next();
  if (isBot(req.get('User-Agent'))) return next(); // never block search engines
  if (RL_MEDIA_PATHS.some(p => req.path === p || req.path.startsWith(p + '/'))) return next();
  const now = Date.now();
  if (!rlStore.has(ip)) rlStore.set(ip, []);
  const arr = rlStore.get(ip).filter(t => now - t < RL_WINDOW);
  const max = /\.\w+$/.test(req.path) ? RL_STATIC_MAX : RL_MAX;
  if (arr.length >= max) {
    console.warn(`[rate-limit] blocked ${ip} (${arr.length}/${max}/min) — ${req.method} ${req.path}`);
    return res.status(429).send('Too many requests — please slow down.');
  }
  arr.push(now);
  rlStore.set(ip, arr);
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of rlStore) {
    const f = ts.filter(t => now - t < RL_WINDOW);
    f.length ? rlStore.set(k, f) : rlStore.delete(k);
  }
}, 300000);

app.use(rateLimit);

// Canonical-domain guard — `www.superxlatina.com` and old `*.superxlatina.site`
// → 301 to apex `https://superxlatina.com` (no duplicate-content signals).
app.use((req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();
  if (host && /(?:^|\.)superxlatina\.(?:com|site)$/i.test(host) && host !== 'superxlatina.com') {
    return res.redirect(301, 'https://superxlatina.com' + req.originalUrl);
  }
  next();
});

// Global response headers — SEO + privacy + FLoC opt-out.
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  if (!req.path.startsWith('/admin') && !req.path.startsWith('/api') && !req.path.startsWith('/videos') && !req.path.startsWith('/t') && !req.path.startsWith('/tx')) {
    res.setHeader('X-Robots-Tag', 'index, follow, max-snippet:-1, max-image-preview:large');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d', etag: true }));
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Admin session: no password — the dashboard is open by design.
app.use((req, res, next) => { req.isAdmin = readAdminSession(req); next(); });

// ── Media routes ─────────────────────────────────────────────────────────────
// Videos: cross-origin embeddable, byte-range supported, NEVER indexed.
const videoFolders = config.videoFolders || (config.videoFolder ? [config.videoFolder] : []);
app.use('/videos', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'public, max-age=604800, must-revalidate');
  next();
});
videoFolders.forEach(folder => {
  if (fs.existsSync(folder)) {
    app.use('/videos', express.static(folder));
  }
});

// Thumbnails: cross-origin embeddable, long-cached, remain indexable
// (they power video rich-results and image previews in search).
app.use('/thumbnails', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
  next();
});
if (config.thumbnailsFolder && fs.existsSync(config.thumbnailsFolder)) {
  app.use('/thumbnails', express.static(config.thumbnailsFolder));
}

// Preview clips: tiny 8s cuts (see generate-previews.js) fetched whole by the
// hover engine instead of a multi-MB range chunk. Same caching policy as thumbs.
app.use('/previews', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
  next();
});
if (fs.existsSync(PREVIEW_FOLDER)) {
  app.use('/previews', express.static(PREVIEW_FOLDER));
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Auto-scan
const autoScan = require('./utils/auto-scan');
let siteVideos = [];
let externalVideos = [];
let localVideos = [];
const EXTERNAL_INDEX_FILE = path.join(DATA_DIR, 'video-index-external.json');
let descriptions = {};

// External CDN sync (xamateur/hotlinked library). Disabled via config
// `externalSync: false` — superxlatina.com serves only local hentai_videos.
const externalSyncEnabled = config.externalSync !== false;

if (externalSyncEnabled) {
  xcdn.configure({
    source: 'api',
    cdnBase: 'https://cdn.superxlatina.com',
    prefix: 'Super X Latina Video',
    snapshotFile: EXTERNAL_INDEX_FILE,
    dir: DATA_DIR,
    pollMs: 120000,
    blockedHosts: (config.transformer && config.transformer.blockedHosts) || [],
    tokenSecret: config.tokenSecret || (config.transformer && config.transformer.secret) || '',
    blacklistFile: path.join(DATA_DIR, 'hotlink-blacklist.json')
  });
}

function buildPreviewSet() {
  previewReady = new Set();
  if (!fs.existsSync(PREVIEW_FOLDER)) return;
  fs.readdirSync(PREVIEW_FOLDER).forEach(f => {
    if (f.endsWith('.mp4')) previewReady.add(f.replace(/\.mp4$/, ''));
  });
}

function loadData() {
  const vp = path.join(DATA_DIR, 'videos.json');
  if (fs.existsSync(vp)) {
    localVideos = JSON.parse(fs.readFileSync(vp, 'utf8')).filter(v => !(v.source && !v.filePath));
    siteVideos = localVideos;
  }
  const dp = path.join(DATA_DIR, 'descriptions.json');
  if (fs.existsSync(dp)) descriptions = JSON.parse(fs.readFileSync(dp, 'utf8'));
  buildPreviewSet();
  loadExternalIndex();
  applyExternal();
}

function loadExternalIndex() {
  if (!externalSyncEnabled) { externalVideos = []; return; }
  try {
    if (!fs.existsSync(EXTERNAL_INDEX_FILE)) { externalVideos = []; return; }
    externalVideos = JSON.parse(fs.readFileSync(EXTERNAL_INDEX_FILE, 'utf8'));
    console.log(`🌐 [XCDN] Loaded snapshot of ${externalVideos.length} external videos`);
  } catch (err) {
    externalVideos = [];
    console.log(`🌐 [XCDN] Could not load snapshot: ${err.message}`);
  }
}

function saveExternalIndex(entries) {
  externalVideos = entries;
  fs.writeFileSync(EXTERNAL_INDEX_FILE, JSON.stringify(entries, null, 2));
}

// Merge the live xcdn library into siteVideos. External entries never persist
// to videos.json (see persistLocalVideos) so they can't duplicate on reload.
function applyExternal() {
  const base = siteVideos.filter(v => !v.external && !externalVideos.some(e => e.id === v.id));
  siteVideos = base.concat(externalVideos);
}

function persistLocalVideos() {
  fs.writeFileSync(path.join(DATA_DIR, 'videos.json'), JSON.stringify(siteVideos.filter(v => !v.external), null, 2));
}

// Extract the masked origin host for a video: prefers srcUrl, falls back to
// decoding the /t/ token in `video` (shared WPS Transformer secret).
function sourceHost(v) {
  if (!v) return '';
  let url = v.srcUrl || '';
  if (!url && typeof v.video === 'string') {
    const m = /\/t\/([^\/?#]+)/.exec(v.video);
    if (m) {
      const s = transformer.verifyToken(m[1]);
      if (s && s.url) url = s.url;
    }
  }
  if (!url) return '';
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return ''; }
}

// Permanently suppress external videos from this site: drop them from the live
// set + snapshot AND blacklist their ids so the next CDN poll never re-adds
// them. Ids that are not external are left untouched (local videos are
// handled by deleting from videos.json).
function blacklistExternalIds(ids) {
  ids = (ids || []).map(String).filter(Boolean);
  const extIds = ids.filter(id => externalVideos.some(v => v.id === id));
  if (!extIds.length) return ids.length;
  const blFile = path.join(DATA_DIR, 'hotlink-blacklist.json');
  let bl = { comment: 'Exclusion list for auto-sync. Add a master video id (string) here to keep it off this site. Empty by default — everything clean in the wps master gets imported.', videos: [] };
  try { bl = JSON.parse(fs.readFileSync(blFile, 'utf8')); } catch (e) {}
  if (!bl || typeof bl !== 'object') bl = {};
  if (!Array.isArray(bl.videos)) bl.videos = [];
  const set = new Set(bl.videos.map(String));
  extIds.forEach(id => set.add(id));
  bl.videos = Array.from(set);
  fs.writeFileSync(blFile, JSON.stringify(bl, null, 2));
  externalVideos = externalVideos.filter(v => !set.has(v.id));
  saveExternalIndex(externalVideos);
  applyExternal();
  try { xcdn.reloadBlacklist(); } catch (e) {}
  return extIds.length;
}

xcdn.onUpdate((rows) => {
  if (!externalSyncEnabled) { externalVideos = []; return; }
  externalVideos = rows;
  applyExternal();
  console.log(`♻️ [XCDN] ${externalVideos.length} live CDN videos (titles rewritten, no origin leak)`);
});

function getAllVideos() { return siteVideos; }

function saveDescriptions() {
  fs.writeFileSync(path.join(DATA_DIR, 'descriptions.json'), JSON.stringify(descriptions, null, 2));
}

// LokiJS
let db = new Loki(path.join(DATA_DIR, 'database.json'), { autoload: false });
let likesCol;

function initDb() {
  if (fs.existsSync(path.join(DATA_DIR, 'database.json'))) {
    db.loadDatabase({}, () => {
      likesCol = db.getCollection('likes') || db.addCollection('likes');
    });
  } else {
    likesCol = db.addCollection('likes');
  }
}

// Chat server
const nlpWriter = require('./utils/nlp-writer');
const adminName = config.adminName || "Super X Latina Admin";

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Byte offsets for 12s-mark hover previews (perceived-speed range fetch)
const fileSizes = {};
function buildSizeCache() {
  siteVideos.forEach(v => {
    if (v.filePath && fs.existsSync(v.filePath)) {
      try { fileSizes[v.id] = fs.statSync(v.filePath).size; } catch (e) {}
    }
  });
}

// Debounced reload for bulk imports: the admin imports in 10-URL chunks, and
// each chunk used to run loadData()+buildSizeCache() synchronously (a statSync
// loop over the whole library ×N chunks). Coalesce the refreshes so the slow
// work runs once when the import stream settles, not after every chunk.
let reloadTimer = null;
function scheduleReload() {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    loadData();
    buildSizeCache();
  }, 1000);
}

function parseDuration(d) {
  if (!d) return 0;
  const parts = String(d).split(':').map(Number);
  if (parts.length === 3) return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
  if (parts.length === 2) return (parts[0] || 0) * 60 + (parts[1] || 0);
  return Number(d) || 0;
}

// Thumbnail URL for a video. External (embedded) sources are served through the
// /img/:id cache so each origin image is downloaded exactly once and then never
// touched again — the gallery never hotlinks origin CDNs.
function thumbSrc(v) {
  if (!v) return '';
  const isExternal = !!(v.external || v.source || (v.sourceUrl && !v.filePath));
  if (isExternal) return v.thumbnail ? '/img/' + v.id : '';
  return v.thumbnail || '/thumbnails/' + v.id + '.jpg';
}

function slimVideo(v) {
  const dur = parseDuration(v.duration);
  const size = fileSizes[v.id];
  const isExternal = !!(v.external || v.source || (v.sourceUrl && !v.filePath));
  const playback = isExternal
    ? (v.video || transformer.tokenUrl(v.source || v.sourceUrl))
    : (v.video || ('/videos/' + v.id + '.mp4'));
  return {
    id: v.id, title: v.title, video: playback,
    source: v.source || null,
    external: isExternal || undefined,
    thumbnail: thumbSrc(v),
    duration: v.duration, views: v.views, category: v.category,
    tags: v.tags, featured: v.featured, uploaded: v.uploaded,
    dur: dur || undefined,
    size: isExternal ? undefined : (size || undefined),
    pv: (isExternal) ? undefined : ((size && dur) ? Math.round((12 / dur) * size) : undefined),
    preview: isExternal ? undefined : (previewReady.has(v.id) ? ('/previews/' + v.id + '.mp4') : undefined)
  };
}

// Playback URL for a video (local file vs transformed external source)
function playbackUrlFor(video) {
  if (video && video.source) return transformer.tokenUrl(video.source);
  if (video && video.sourceUrl && !video.filePath) return transformer.tokenUrl(video.sourceUrl);
  return (video && video.video) || (video ? '/videos/' + video.id + '.mp4' : '');
}

// Video lookup
function getVideo(id) { return siteVideos.find(v => v.id === id) || externalVideos.find(v => v.id === id); }

function getRelated(video, max = 12) {
  const cats = video.category ? [video.category] : [];
  let related = siteVideos.filter(v => v.id !== video.id && cats.some(c => v.category === c));
  if (related.length < max) {
    related = related.concat(siteVideos.filter(v => v.id !== video.id && !related.includes(v)));
  }
  return related.sort(() => Math.random() - 0.5).slice(0, max);
}

// SEO Generator
const SEOGenerator = require('./utils/seo-generator');
const seo = new SEOGenerator({
  siteName: 'Super X Latina',
  siteUrl: SITE_BASE,
  socialMedia: { twitter: '@superxlatina', facebook: 'superxlatina' }
});

// ── SEO Layer (WordPress/Yoast + Next.js metadata conventions in Express) ──
const seoL = require('./utils/seo-layer');

// Keyword landing-page engine: per-keyword SEO content + related-keyword linkage
const keywordSEO = require('./utils/keyword-seo');
const SEO = config.seo || {};
const SITE_NAME = 'Super X Latina';
const CONTACT_EMAIL = config.contactEmail || 'admin@superxlatina.com';

// Thin-content guards: keyword/category pages with too few videos are served
// but noindexed (never dead links, never doorway pages).
const MIN_KEYWORD_VIDEOS = 5;
const MIN_CATEGORY_VIDEOS = 3;

function categoryCounts() {
  const m = {};
  siteVideos.forEach(v => {
    const c = (v.category || 'General').trim();
    m[c] = (m[c] || 0) + 1;
  });
  return m;
}

function healthyCategories() {
  const counts = categoryCounts();
  return Object.keys(counts).filter(c => counts[c] >= MIN_CATEGORY_VIDEOS).sort((a, b) => counts[b] - counts[a]);
}

function keywordMatches(kw) {
  return siteVideos.filter(v =>
    v.title.toLowerCase().includes(kw) ||
    (v.tags || []).some(t => t.toLowerCase().includes(kw)) ||
    (v.category || '').toLowerCase() === kw
  );
}

// Non-public paths: robots.txt alone is not enough — enforce a header so
// Google can never index admin/API/feed resources.
app.use(seoL.noindexPaths(['/admin', '/api']));

// 301 redirect map — add old/brand-variation URLs here (edit when known).
const REDIRECT_MAP = {
  '/xfilipina': '/',
  '/pinay': '/',
  '/arnabku-old': '/'
};

function seoMetaForPage(o) {
  // SiteNavigationElement on every page (sitelink eligibility) — nav mirrors the
  // header dropdown so crawlers always see the same primary menu.
  const jsonLd = (o.jsonLd || []).filter(Boolean).slice();
  const nav = healthyCategories().map(c => ({
    name: c + ' Latina',
    url: SITE_BASE + '/category/' + encodeURIComponent(c.toLowerCase())
  }));
  jsonLd.push(seoL.navSchema(nav));
  return seoL.renderMeta(Object.assign({ siteName: SITE_NAME, siteUrl: SITE_BASE }, o, { jsonLd }));
}

function absUrl(u) {
  return u && !/^https?:\/\//.test(u) ? SITE_BASE + u : u;
}

// Make the category list available to every template (header nav consistency).
app.use((req, res, next) => {
  res.locals.categories = healthyCategories();
  next();
});

// Hero collage — curated brand imagery (served locally from /hero so page one
// instantly communicates the niche; no hotlinking, tiny + lazy below the fold).
const HERO_MEDIA = [
  { src: '/hero/featured.jpg', alt: 'Super X Latina — hand-picked latina HD videos' },
  { src: '/hero/editorial.jpg', alt: 'Latin beauty editorial photo on Super X Latina' },
  { src: '/hero/model1.jpg', alt: 'Latina video still on Super X Latina' },
  { src: '/hero/model2.jpg', alt: 'HD latina model portrait on Super X Latina' }
];

// Routes
app.get('/', (req, res) => {
  const categories = healthyCategories();
  const featured = siteVideos.filter(v => v.featured).slice(0, 6).map(slimVideo);

  const pageSEOTitle = 'Super X Latina — Free HD Latina & Amateur Video Collection';
  const pageSEOText = nlpWriter.generatePageSEO('latina', siteVideos.length);
  const homeMeta = nlpWriter.generatePageSEO('latina', siteVideos.length);

  const firstPage = shuffle(siteVideos).map(slimVideo);

  const homeTitle = SEO.homeTitle || 'Super X Latina — HD Latina Videos';
  const homeDesc = SEO.homeDescription || homeMeta.substring(0, 160);
  const homeCanonical = SITE_BASE + '/';
  const metaHead = seoMetaForPage({
    title: homeTitle,
    description: homeDesc,
    canonical: homeCanonical,
    keywords: SEO.homeKeywords,
    author: SEO.author,
    ogType: 'website',
    ogImage: '/og-image.jpg',
    ogImageAlt: homeTitle,
    ogLocale: 'en_US',
    twitterSite: SEO.twitter,
    rssUrl: '/feed.xml',
    jsonLd: [
      seoL.websiteSchema(SITE_NAME, SITE_BASE, homeDesc, [SEO.identity], ['en']),
      seoL.organizationSchema(SITE_NAME, SITE_BASE, homeDesc, [SEO.twitter]),
      seoL.collectionSchema(homeTitle, homeDesc, homeCanonical, siteVideos.length, SEO.identity)
    ]
  });

  res.render('gallery', {
    title: homeTitle,
    metaDesc: homeDesc,
    seoMeta: metaHead,
    videos: firstPage,
    featured,
    heroImages: HERO_MEDIA,
    categories,
    siteName: SITE_NAME,
    siteUrl: SITE_BASE,
    structuredData: seo.generateStructuredData('organization') + seo.generateStructuredData('website'),
    metaKeywords: 'latina, latina videos, latina HD, latina porn, latina streaming, latina collection, superxlatina, amateur latina',
    totalVideos: siteVideos.length,
    totalPages: Math.ceil(siteVideos.length / FEED_PER_PAGE),
    currentCategory: '',
    isAdminPage: false,
    pageSEOTitle,
    pageSEOText
  });
});

app.get('/admin/login', (req, res) => {
  if (req.isAdmin) return res.redirect('/admin');
  res.render('admin-login', { title: 'Admin Login - Super X Latina', error: '' });
});

app.post('/admin/login', (req, res) => {
  const pass = String(req.body.password || '');
  if (!pass || pass !== (config.adminPassword || '')) {
    return res.status(401).render('admin-login', { title: 'Admin Login - Super X Latina', error: 'Incorrect password.' });
  }
  const ts = Date.now();
  res.cookie(ADMIN_COOKIE, ts + '.' + adminSign(ts), {
    httpOnly: true, sameSite: 'strict',
    maxAge: ADMIN_SESSION_HOURS * 3600 * 1000
  });
  res.redirect('/admin');
});

app.get('/admin/logout', (req, res) => {
  res.clearCookie(ADMIN_COOKIE);
  res.redirect('/admin/login');
});

// API: regenerate all descriptions using NLP writer
app.post('/api/rewrite-descriptions', (req, res) => {
  if (!req.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const count = siteVideos.length;
    siteVideos.forEach(v => {
      const result = nlpWriter.generateFullDescription(v.title, v.category);
      v.description = result.description;
      v.tags = [...new Set([...(v.tags || []), ...(result.keywords || [])])].slice(0, 8);
      descriptions[v.id] = {
        description: result.description,
        keywords: result.keywords,
        generated: true,
        lastUpdated: new Date().toISOString()
      };
    });
    saveDescriptions();
    fs.writeFileSync(path.join(DATA_DIR, 'videos.json'), JSON.stringify(siteVideos.filter(v => !v.external), null, 2));
    res.json({ ok: true, total: count, message: `Rewrote ${count} descriptions with NLP` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: preview NLP description for a single video
app.post('/api/rewrite-descriptions/preview', express.json(), (req, res) => {
  if (!req.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { id } = req.body;
    const v = siteVideos.find(x => x.id === id);
    if (!v) return res.status(404).json({ error: 'Video not found' });
    const result = nlpWriter.generateFullDescription(v.title, v.category);
    res.json({ ok: true, description: result.description, keywords: result.keywords });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin', (req, res) => {
  if (!req.isAdmin) return res.redirect('/admin/login');
  const hostCounts = {};
  const videos = siteVideos.map((v) => {
    const h = sourceHost(v);
    hostCounts[h] = (hostCounts[h] || 0) + 1;
    return Object.assign({}, v, { srcHost: h });
  });
  const sourceHosts = Object.keys(hostCounts).sort((a, b) => hostCounts[b] - hostCounts[a]);
  res.render('admin', {
    title: 'Admin Dashboard — Super X Latina',
    totalVideos: videos.length,
    videos: videos,
    sourceHosts: sourceHosts,
    hostCounts: hostCounts,
    siteUrl: SITE_BASE,
    siteName: 'Super X Latina',
    isAdminPage: true,
    adminProfile: {
      name: adminName,
      bio: config.adminBio || 'Latina curator, HD streaming, 24/7 uploads',
      photo: config.adminPhoto || '',
      socialLinks: config.adminSocial || { twitter: '', instagram: '', tiktok: '' }
    }
  });
});

app.get('/about', (req, res) => {
  res.render('page', {
    title: 'About Super X Latina',
    metaDescription: 'Super X Latina — free HD latina and amateur video collection. Updated daily.',
    canonicalUrl: SITE_BASE + '/about',
    seoMeta: seoMetaForPage({
      title: 'About Super X Latina',
      description: 'Super X Latina — free HD latina and amateur video collection. Updated daily.',
      canonical: SITE_BASE + '/about',
      ogType: 'website',
      ogImage: '/og-image.jpg',
      jsonLd: [seoL.organizationSchema(SITE_NAME, SITE_BASE, 'Super X Latina — free HD latina and amateur video collection', [SEO.twitter])]
    }),
    content: '<h1>About Super X Latina</h1><p>Super X Latina is a collection of high-quality latina and amateur videos. We curate the best content for your viewing pleasure.</p><p>Browse our extensive library of HD videos updated daily.</p><h2>Network</h2><p>Super X Latina is part of a network of free adult video platforms, each focused on its own niche:</p><ul><li><a href="https://xmelayu.site">xMelayu</a> — authentic Southeast Asian amateur videos.</li><li><a href="https://superxhentai.com">Super X Hentai</a> — curated HD hentai videos.</li></ul><h2>2257 Statement</h2><p>All models, actors, actresses and other persons that appear in any visual depiction of actual or simulated sexually explicit conduct appearing on this site were over the age of eighteen (18) years at the time of the depiction. Records required by Section 2257 of Title 18 of the U.S. Code and 28 C.F.R. 75 are maintained by the respective content producers. Where no records exist, the content is treated as exempt works of non-commercial origin or is not based on actual persons.</p><h2>Contact</h2><p>For DMCA, privacy or general inquiries, see our <a href="/dmca">DMCA policy</a>, <a href="/privacy-policy">privacy policy</a>, or <a href="/contact">contact page</a>.</p>',
    structuredData: seo.generateStructuredData('organization'),
    siteUrl: SITE_BASE,
    isAdminPage: false
  });
});

// ── SEO routes (must be registered before the /:id catch-all) ──────────────

// 301 redirects
app.use((req, res, next) => {
  if (REDIRECT_MAP[req.path]) return res.redirect(301, REDIRECT_MAP[req.path]);
  next();
});

// RSS feed
app.get('/feed.xml', (req, res) => {
  res.set('Content-Type', 'application/rss+xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(seoL.buildFeed({
    siteName: SITE_NAME,
    siteUrl: SITE_BASE,
    description: SEO.homeDescription,
    videos: siteVideos.map(slimVideo)
  }));
});

// Video sitemap (paginated for large libraries)
function videoSitemapSlice(page) {
  const PER = 50000;
  return siteVideos.slice((page - 1) * PER, page * PER);
}

app.get('/sitemap-index.xml', (req, res) => {
  res.set('Content-Type', 'application/xml');
  res.send(seoL.buildSitemapIndex({ siteUrl: SITE_BASE, count: siteVideos.length }));
});

app.get('/sitemap.xml', (req, res) => {
  res.set('Content-Type', 'application/xml');
  res.set('Cache-Control', 'public, max-age=3600');
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">\n';
  const today = new Date().toISOString().split('T')[0];

  // Static + healthy category pages (thin categories excluded from sitemap)
  const pages = [
    { p: '/', pri: '1.0', freq: 'daily' },
    { p: '/about', pri: '0.6', freq: 'monthly' },
    { p: '/faq', pri: '0.5', freq: 'monthly' },
    { p: '/dmca', pri: '0.5', freq: 'monthly' },
    { p: '/privacy-policy', pri: '0.5', freq: 'monthly' },
    { p: '/terms', pri: '0.5', freq: 'monthly' },
    { p: '/2257', pri: '0.5', freq: 'monthly' },
    { p: '/contact', pri: '0.6', freq: 'monthly' }
  ];
  healthyCategories().forEach(c => {
    pages.push({ p: '/category/' + encodeURIComponent(c.toLowerCase()), pri: '0.8', freq: 'weekly' });
  });
  // Healthy keyword hubs (/k/:kw) — only indexable ones (>= MIN_KEYWORD_VIDEOS).
  // Counts from tags AND title words so descriptive external titles surface hubs.
  const kwCounts = {};
  siteVideos.forEach(v => {
    (v.tags || []).forEach(t => {
      const k = String(t).toLowerCase();
      if (k) kwCounts[k] = (kwCounts[k] || 0) + 1;
    });
    String(v.title || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(w => w.length > 2 && !/^\d+$/.test(w))
      .forEach(w => { kwCounts[w] = (kwCounts[w] || 0) + 1; });
  });
  Object.keys(kwCounts)
    .filter(k => kwCounts[k] >= MIN_KEYWORD_VIDEOS)
    .sort((a, b) => kwCounts[b] - kwCounts[a])
    .slice(0, 40)
    .forEach(k => pages.push({ p: '/k/' + encodeURIComponent(k), pri: '0.6', freq: 'weekly' }));
  pages.forEach(pg => { xml += seoL.sitemapEntry(SITE_BASE, pg.p, { updated: today, changefreq: pg.freq, priority: pg.pri }) + '\n'; });

  // Videos
  videoSitemapSlice(1).forEach(v => {
    const uploadedDate = v.uploaded ? new Date(v.uploaded).toISOString().split('T')[0] : today;
    xml += seoL.videoSitemapEntry(SITE_BASE, '/' + v.id, {
      title: v.title,
      description: v.description || v.title,
      thumbnail: absUrl(thumbSrc(v) || ('/thumbnails/' + v.id + '.jpg')),
      duration: v.duration,
      uploaded: uploadedDate,
      contentLoc: v.video
    }) + '\n';
  });
  xml += '</urlset>';
  res.send(xml);
});

app.get('/sitemap-:n.xml', (req, res) => {
  res.set('Content-Type', 'application/xml');
  const today = new Date().toISOString().split('T')[0];
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">\n';
  videoSitemapSlice(parseInt(req.params.n) || 2).forEach(v => {
    const uploadedDate = v.uploaded ? new Date(v.uploaded).toISOString().split('T')[0] : today;
    xml += seoL.videoSitemapEntry(SITE_BASE, '/' + v.id, {
      title: v.title,
      description: v.description || v.title,
      thumbnail: absUrl(thumbSrc(v) || ('/thumbnails/' + v.id + '.jpg')),
      duration: v.duration,
      uploaded: uploadedDate,
      contentLoc: v.video
    }) + '\n';
  });
  xml += '</urlset>';
  res.send(xml);
});

// Keyword landing pages (/k/:keyword) — cheap topical-cluster pages with
// per-keyword SEO content and related-keyword internal linkage.
// Keywords with < MIN_KEYWORD_VIDEOS videos are served but noindexed so they
// never become thin doorway pages; healthy ones stay indexable.
app.get('/k/:keyword', (req, res) => {
  const kw = req.params.keyword.toLowerCase();
  const matches = keywordMatches(kw);
  if (!matches.length) {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    return res.status(404).render('error', { message: 'Nothing found for that keyword', siteUrl: SITE_BASE, isAdminPage: false });
  }

  const thin = matches.length < MIN_KEYWORD_VIDEOS;
  res.setHeader('X-Robots-Tag', thin ? 'noindex, nofollow' : 'index, follow, max-snippet:-1, max-image-preview:large');
  const seoContent = keywordSEO.generateKeywordContent(kw, matches, SITE_NAME);
  const relatedKeywords = keywordSEO.findRelatedKeywords(kw, matches);
  const title = seoContent.title;
  const desc = seoContent.metaDesc;
  const kwCanonical = SITE_BASE + '/k/' + encodeURIComponent(kw);
  const metaHead = seoMetaForPage({
    title,
    description: desc,
    canonical: kwCanonical,
    noindex: thin,
    keywords: [kw, ...relatedKeywords.slice(0, 5), 'latina', 'amateur porn', 'superxlatina'].join(', '),
    author: SEO.author,
    ogType: 'website',
    ogImage: '/og-image.jpg',
    ogImageAlt: title,
    twitterSite: SEO.twitter,
    rssUrl: '/feed.xml',
    jsonLd: [
      seoL.collectionSchema(title, desc, kwCanonical, matches.length, kw),
      seoL.breadcrumbSchema([
        { name: SITE_NAME, url: SITE_BASE + '/' },
        { name: kw + ' Videos', url: kwCanonical }
      ])
    ]
  });
  res.render('keyword', {
    title,
    metaDesc: desc,
    seoMeta: metaHead,
    keyword: kw,
    heading: seoContent.h1,
    content: seoContent.content,
    emoji: seoContent.emoji,
    relatedKeywords,
    videos: shuffle(matches).slice(0, 60).map(slimVideo),
    total: matches.length,
    siteName: SITE_NAME,
    siteUrl: SITE_BASE,
    isAdminPage: false
  });
});

// FAQ page
app.get('/faq', (req, res) => {
  const faq = SEO.faq || [];
  const content = '<h1>FAQ</h1>' + faq.map(f => `<h2>${f.q}</h2><p>${f.a}</p>`).join('');
  res.render('page', {
    title: 'FAQ — Super X Latina',
    metaDescription: 'Frequently asked questions about Super X Latina.',
    canonicalUrl: SITE_BASE + '/faq',
    seoMeta: seoMetaForPage({
      title: 'FAQ — Super X Latina',
      description: 'Frequently asked questions about Super X Latina.',
      canonical: SITE_BASE + '/faq',
      ogType: 'website',
      ogImage: '/og-image.jpg',
      jsonLd: [seoL.faqSchema(faq)]
    }),
    content,
    structuredData: '',
    siteUrl: SITE_BASE,
    isAdminPage: false
  });
});

app.get('/dmca', (req, res) => {
  const email = CONTACT_EMAIL;
  res.render('page', {
    title: 'DMCA Takedown Policy',
    metaDescription: 'DMCA copyright policy for Super X Latina. How to file a takedown notice for allegedly infringing content.',
    canonicalUrl: SITE_BASE + '/dmca',
    seoMeta: seoMetaForPage({
      title: 'DMCA Takedown Policy — Super X Latina',
      description: 'DMCA copyright policy for Super X Latina. How to file a takedown notice for allegedly infringing content.',
      canonical: SITE_BASE + '/dmca',
      ogType: 'website',
      ogImage: '/og-image.jpg',
      jsonLd: [seoL.aboutPageSchema(SITE_NAME, SITE_BASE + '/dmca', 'DMCA Takedown Policy for Super X Latina.')]
    }),
    content: '<h1>DMCA Takedown Policy</h1>' +
      '<p>Super X Latina respects the intellectual property rights of others and complies with the Digital Millennium Copyright Act (DMCA). We respond to clear and complete notices of alleged copyright infringement.</p>' +
      '<h2>Filing a Takedown Notice</h2>' +
      '<p>If you believe that material hosted on Super X Latina infringes your copyright, please send a written notice to <a href="mailto:' + email + '">' + email + '</a> containing the following information:</p>' +
      '<ul><li>Identification of the copyrighted work claimed to have been infringed.</li>' +
      '<li>Identification of the material that is claimed to be infringing, including the URL(s) of the video page(s) on this site.</li>' +
      '<li>Your contact information — full legal name, mailing address, telephone number and email address.</li>' +
      '<li>A statement that you have a good-faith belief the use is not authorized by the copyright owner, its agent or the law.</li>' +
      '<li>A statement, under penalty of perjury, that the information in the notice is accurate and that you are the copyright owner or authorized to act on the owner\u2019s behalf.</li>' +
      '<li>Your physical or electronic signature.</li></ul>' +
      '<h2>What Happens Next</h2>' +
      '<p>Upon receipt of a valid notice, we will promptly remove or disable access to the allegedly infringing material and notify the uploader. Repeat infringers may have their content removed or be permanently barred.</p>' +
      '<h2>Counter-Notification</h2>' +
      '<p>If your material was removed and you believe it was a mistake or misidentification, you may send a counter-notification to <a href="mailto:' + email + '">' + email + '</a>. It must include your contact details, identification of the removed material, a statement under penalty of perjury that you have a good-faith belief the material was removed by mistake, and your consent to the jurisdiction of your local federal court.</p>',
    structuredData: '',
    siteUrl: SITE_BASE,
    isAdminPage: false
  });
});

app.get('/privacy-policy', (req, res) => {
  const email = CONTACT_EMAIL;
  res.render('page', {
    title: 'Privacy Policy',
    metaDescription: 'Privacy Policy for Super X Latina — what data we collect, how it is used, and your choices.',
    canonicalUrl: SITE_BASE + '/privacy-policy',
    seoMeta: seoMetaForPage({
      title: 'Privacy Policy — Super X Latina',
      description: 'Privacy Policy for Super X Latina — what data we collect, how it is used, and your choices.',
      canonical: SITE_BASE + '/privacy-policy',
      ogType: 'website',
      ogImage: '/og-image.jpg',
      jsonLd: [seoL.aboutPageSchema(SITE_NAME, SITE_BASE + '/privacy-policy', 'Privacy Policy for Super X Latina.')]
    }),
    content: '<h1>Privacy Policy</h1>' +
      '<p>Super X Latina ("we", "us") explains below how we collect, use and protect information when you visit superxlatina.com. This site is intended for adults aged 18 or older. By using the site you confirm you are of legal age.</p>' +
      '<h2>Information We Collect</h2>' +
      '<ul><li><strong>Cookies:</strong> We use a small cookie to keep you signed in to the admin panel. No personal details are required to browse.</li>' +
      '<li><strong>Server logs:</strong> Like most web servers, we log basic technical data such as IP address, browser type and pages visited to operate and secure the service.</li></ul>' +
      '<h2>How We Use Information</h2>' +
      '<p>Information is used to deliver videos, keep the site functional, improve performance and prevent abuse. We do not sell your personal data.</p>' +
      '<h2>Third Parties</h2>' +
      '<p>We may use third-party services (e.g. font providers, analytics, or advertising partners) that set their own cookies or collect their own data under their own policies. Please review their policies for details.</p>' +
      '<h2>Your Choices</h2>' +
      '<p>You may clear cookies through your browser at any time. Video viewing does not require an account or registration.</p>' +
      '<h2>Children</h2>' +
      '<p>This site is strictly for adults and is not directed at minors. We do not knowingly collect data from anyone under 18.</p>' +
      '<h2>Contact</h2>' +
      '<p>Questions about this policy can be sent to <a href="mailto:' + email + '">' + email + '</a>.</p>' +
      '<p>We may update this policy from time to time. Continued use of the site after changes means you accept the updated policy.</p>',
    structuredData: '',
    siteUrl: SITE_BASE,
    isAdminPage: false
  });
});

app.get('/contact', (req, res) => {
  const email = CONTACT_EMAIL;
  res.render('page', {
    title: 'Contact Us',
    metaDescription: 'Contact Super X Latina — for support, DMCA requests, advertising or general inquiries.',
    canonicalUrl: SITE_BASE + '/contact',
    seoMeta: seoMetaForPage({
      title: 'Contact Super X Latina',
      description: 'Contact Super X Latina — for support, DMCA requests, advertising or general inquiries.',
      canonical: SITE_BASE + '/contact',
      ogType: 'website',
      ogImage: '/og-image.jpg',
      jsonLd: [seoL.contactPageSchema(email, SITE_BASE + '/contact')]
    }),
    content: '<h1>Contact Us</h1>' +
      '<p>We reply to all serious inquiries. Send us an email at <a href="mailto:' + email + '">' + email + '</a> and we will get back to you.</p>' +
      '<h2>What to Send Where</h2>' +
      '<ul><li><strong>Copyright / DMCA:</strong> <a href="/dmca">see the DMCA page</a> for the exact details required in a takedown notice.</li>' +
      '<li><strong>Privacy questions:</strong> <a href="/privacy-policy">see the Privacy Policy</a>.</li>' +
      '<li><strong>Anything else:</strong> advertising, feedback, broken links or content suggestions — just email us.</li></ul>' +
      '<h2>Send a Message</h2>' +
      '<p>Clicking the button below opens your email app with everything pre-filled.</p>' +
      '<p><a class="tag" href="mailto:' + email + '?subject=' + encodeURIComponent('Inquiry about Super X Latina') + '&body=' + encodeURIComponent('Hi Super X Latina team,\n\n') + '" style="padding:10px 18px;border-radius:8px;display:inline-block">&#x1F4E9; Email ' + email + '</a></p>',
    structuredData: '',
    siteUrl: SITE_BASE,
    isAdminPage: false
  });
});

app.get('/terms', (req, res) => {
  const email = CONTACT_EMAIL;
  res.render('page', {
    title: 'Terms of Use',
    metaDescription: 'Terms of Use for Super X Latina — rules for using the site, acceptable use, and disclaimers.',
    canonicalUrl: SITE_BASE + '/terms',
    seoMeta: seoMetaForPage({
      title: 'Terms of Use — Super X Latina',
      description: 'Terms of Use for Super X Latina — rules for using the site, acceptable use, and disclaimers.',
      canonical: SITE_BASE + '/terms',
      ogType: 'website',
      ogImage: '/og-image.jpg',
      jsonLd: [seoL.aboutPageSchema(SITE_NAME, SITE_BASE + '/terms', 'Terms of Use for Super X Latina.')]
    }),
    content: '<h1>Terms of Use</h1>' +
      '<p>Welcome to Super X Latina. By accessing or using superxlatina.com (the "Site") you agree to be bound by these Terms of Use and our <a href="/privacy-policy">Privacy Policy</a>. If you do not agree, please do not use the Site.</p>' +
      '<h2>1. Age Restriction</h2>' +
      '<p>The Site contains adult material and is strictly intended for adults aged 18 or older (or the age of majority in your jurisdiction, whichever is higher). By using the Site you confirm that you are of legal age, that viewing adult content is lawful where you are located, and that you will not allow minors to access the Site.</p>' +
      '<h2>2. Acceptable Use</h2>' +
      '<p>You agree not to: (a) use the Site for any unlawful purpose; (b) attempt to bypass, probe or interfere with the Site\u2019s security, rate limiting or delivery infrastructure; (c) scrape, crawl or bulk-download content without our prior written consent; (d) upload, transmit or distribute malware, spam or fraudulent communications; (e) impersonate others or misrepresent your identity; (f) infringe the intellectual property or other rights of any person.</p>' +
      '<h2>3. Intellectual Property</h2>' +
      '<p>All content on the Site, including videos, images, text, logos and graphics, is owned by Super X Latina or its licensors and is protected by copyright and other laws. You may stream content for personal, non-commercial viewing only. You may not reproduce, redistribute, resell or publicly display the content without permission. If you believe your copyright has been infringed, please see our <a href="/dmca">DMCA Policy</a>.</p>' +
      '<h2>4. Third-Party Content</h2>' +
      '<p>The Site may link to or embed content from third parties. Super X Latina does not control third-party content and is not responsible for its accuracy, legality or availability. Third-party sites have their own terms and privacy policies.</p>' +
      '<h2>5. Disclaimer of Warranties</h2>' +
      '<p>The Site is provided "as is" and "as available" without warranties of any kind, whether express or implied, including implied warranties of merchantability, fitness for a particular purpose and non-infringement. We do not warrant that the Site will be uninterrupted, secure or error-free.</p>' +
      '<h2>6. Limitation of Liability</h2>' +
      '<p>To the maximum extent permitted by law, Super X Latina and its operators shall not be liable for any indirect, incidental, special, consequential or punitive damages, or for any loss of profits, data or goodwill, arising out of or in connection with your use of the Site. Our total aggregate liability shall not exceed the amount you paid to use the Site in the twelve (12) months preceding the claim.</p>' +
      '<h2>7. Changes to These Terms</h2>' +
      '<p>We may update these Terms from time to time. Changes take effect when posted. Continued use of the Site after changes are posted means you accept the updated Terms.</p>' +
      '<h2>8. Contact</h2>' +
      '<p>Questions about these Terms can be sent to <a href="mailto:' + email + '">' + email + '</a>.</p>',
    structuredData: '',
    siteUrl: SITE_BASE,
    isAdminPage: false
  });
});

app.get('/2257', (req, res) => {
  const email = '2257@superxlatina.com';
  res.render('page', {
    title: '2257 Compliance Statement',
    metaDescription: '18 U.S.C. § 2257 Compliance Statement for Super X Latina. All models are 18+ years of age with valid identification on file.',
    canonicalUrl: SITE_BASE + '/2257',
    seoMeta: seoMetaForPage({
      title: '2257 Compliance — Super X Latina',
      description: '18 U.S.C. § 2257 Compliance Statement for Super X Latina.',
      canonical: SITE_BASE + '/2257',
      ogType: 'website',
      ogImage: '/og-image.jpg',
      jsonLd: [seoL.aboutPageSchema(SITE_NAME, SITE_BASE + '/2257', '18 U.S.C. § 2257 Compliance Statement for Super X Latina.')]
    }),
    content: '<h1>18 U.S.C. § 2257 Compliance Statement</h1>' +
      '<p><strong>Super X Latina</strong> ("the Site") is a video streaming platform operated from outside the United States. All content displayed on this platform features performers who were <strong>eighteen (18) years of age or older</strong> at the time of the creation of such content.</p>' +
      '<h2>Record-Keeping Requirements</h2>' +
      '<p>In accordance with 18 U.S.C. § 2257 and 28 C.F.R. § 75, all models, actors, actresses and other persons who appear in any visual depiction of actual or simulated sexually explicit conduct appearing on this Site were eighteen (18) years of age or older at the time of the creation of such depictions.</p>' +
      '<h2>Verification Process</h2>' +
      '<p>Prior to publication, all models must provide valid government-issued photo identification (passport, driver\u2019s license or national ID card) demonstrating that they are 18 years of age or older. These records are maintained by the content producer/uploader and are available for inspection by authorized U.S. government agencies upon formal request.</p>' +
      '<h2>Custodian of Records</h2>' +
      '<p>The custodian of records for all visual content displayed on this Site is:<br><strong>Super X Latina Compliance Team</strong><br>Email: <a href="mailto:' + email + '">' + email + '</a><br>Contact us for 2257 documentation requests.</p>' +
      '<h2>Third-Party Content</h2>' +
      '<p>The Site may contain links to or embed content from third-party websites. Super X Latina has no control over and assumes no responsibility for the content, privacy policies or practices of any third-party sites. All third-party content providers are required to maintain their own 2257-compliant record-keeping systems.</p>' +
      '<h2>Content Removal</h2>' +
      '<p>If you believe any content on this Site violates 18 U.S.C. § 2257 or contains non-compliant material, please contact us immediately at <a href="mailto:' + email + '">' + email + '</a> with specific details. We will investigate and remove non-compliant content within 48 hours.</p>',
    structuredData: '',
    siteUrl: SITE_BASE,
    isAdminPage: false
  });
});

app.get('/api/videos', (req, res) => res.json(getAllVideos().map(slimVideo)));
app.get('/api/video/:id', (req, res) => {
  const v = getVideo(req.params.id);
  if (!v) return res.status(404).json({ error: 'Not found' });
  res.json(v);
});

const FEED_PER_PAGE = 1000;
app.get('/api/feed', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 50;
  const category = (req.query.category || '').toLowerCase();
  const search = (req.query.search || '').trim().toLowerCase();
  let pool = getAllVideos();
  if (category) pool = pool.filter(v => v.category?.toLowerCase() === category);
  if (search) {
    pool = pool.filter(v =>
      v.title?.toLowerCase().includes(search) ||
      (v.tags || []).some(t => t.toLowerCase().includes(search)) ||
      v.category?.toLowerCase().includes(search)
    );
  }
  const total = pool.length;
  const totalPages = Math.ceil(total / perPage);
  const start = (page - 1) * perPage;
  const videos = pool.slice(start, start + perPage).map(slimVideo);
  res.json({ videos, page, totalPages, total });
});

app.get('/api/feed-initial', (req, res) => {
  const category = (req.query.category || '').toLowerCase();
  let pool = siteVideos;
  if (category) pool = pool.filter(v => v.category?.toLowerCase() === category);
  const shuffled = shuffle(pool).slice(0, FEED_PER_PAGE);
  res.json({ videos: shuffled.map(slimVideo), total: pool.length });
});

app.post('/api/scan', async (req, res) => {
  try {
    const result = await autoScan.scanAndIndex(CONFIG_PATH);
    loadData();
    buildSizeCache();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/category/:cat', (req, res) => {
  const cat = req.params.cat;
  const filtered = siteVideos.filter(v => v.category?.toLowerCase() === cat.toLowerCase());
  if (!filtered.length) {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    return res.status(404).render('error', { message: 'Category not found', siteUrl: SITE_BASE, isAdminPage: false });
  }

  const thin = filtered.length < MIN_CATEGORY_VIDEOS;
  res.setHeader('X-Robots-Tag', thin ? 'noindex, nofollow' : 'index, follow, max-snippet:-1, max-image-preview:large');
  const title = `${cat} Latina Videos — Super X Latina`;
  const metaDesc = `Watch ${cat} latina videos in HD on Super X Latina. HD content collection.`;

  const pageSEOTitle = `${cat} Latina Videos — Super X Latina`;
  const pageSEOText = nlpWriter.generatePageSEO(cat, filtered.length);

  const firstPage = shuffle(filtered).map(slimVideo);

  const catCanonical = SITE_BASE + '/category/' + encodeURIComponent(cat.toLowerCase());
  const metaHead = seoMetaForPage({
    title,
    description: metaDesc,
    canonical: catCanonical,
    noindex: thin,
    keywords: `latina videos, ${cat.toLowerCase()} videos, superxlatina, HD latina`,
    author: SEO.author,
    ogType: 'website',
    ogImage: '/og-image.jpg',
    ogImageAlt: title,
    ogLocale: 'en_US',
    twitterSite: SEO.twitter,
    rssUrl: '/feed.xml',
    jsonLd: [
      seoL.collectionSchema(title, metaDesc, catCanonical, filtered.length, cat),
      seoL.breadcrumbSchema([
        { name: SITE_NAME, url: SITE_BASE + '/' },
        { name: cat + ' Videos', url: catCanonical }
      ])
    ]
  });

  res.render('gallery', {
    title,
    metaDesc,
    seoMeta: metaHead,
    videos: firstPage,
    featured: [],
    heroImages: HERO_MEDIA,
    categories: healthyCategories(),
    siteName: SITE_NAME,
    siteUrl: SITE_BASE,
    structuredData: seo.generateStructuredData('collection', { name: title, description: metaDesc }) + seo.generateStructuredData('breadcrumb', {
      items: [
        { name: SITE_NAME, url: SITE_BASE + '/' },
        { name: cat + ' Videos', url: SITE_BASE + '/category/' + encodeURIComponent(cat.toLowerCase()) }
      ]
    }),
    metaKeywords: `latina videos, ${cat.toLowerCase()} videos, superxlatina, HD latina, ${cat.toLowerCase()} latina videos`,
    totalVideos: filtered.length,
    totalPages: Math.ceil(filtered.length / FEED_PER_PAGE),
    currentCategory: cat,
    isAdminPage: false,
    pageSEOTitle,
    pageSEOText
  });
});

// Like API
function getLikes(videoId) {
  if (!likesCol) return 0;
  const e = likesCol.findOne({ videoId });
  return e ? e.count : 0;
}

app.post('/api/like/:id', (req, res) => {
  const video = getVideo(req.params.id);
  if (!video) return res.status(404).json({ error: 'Not found' });
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  let entry = likesCol.findOne({ videoId: video.id });
  if (!entry) {
    entry = likesCol.insert({ videoId: video.id, count: 0, ips: [] });
  }
  const idx = entry.ips.indexOf(ip);
  let liked;
  if (idx === -1) {
    entry.ips.push(ip);
    entry.count++;
    liked = true;
  } else {
    entry.ips.splice(idx, 1);
    entry.count--;
    liked = false;
  }
  likesCol.update(entry);
  db.saveDatabase();
  res.json({ videoId: video.id, likes: entry.count, liked });
});

app.post('/api/view/:id', (req, res) => {
  const video = getVideo(req.params.id);
  if (!video) return res.status(404).json({ error: 'Not found' });
  const key = `_viewed_${video.id}`;
  if (req.cookies[key]) return res.json({ views: video.views });
  video.views = (video.views || 0) + 1;
  res.cookie(key, '1', { maxAge: 86400000, httpOnly: true, sameSite: 'lax', secure: req.secure });
  fs.writeFileSync(path.join(DATA_DIR, 'videos.json'), JSON.stringify(siteVideos.filter(v => !v.external), null, 2));
  res.json({ views: video.views });
});

// ═══ TRANSFORMER — masked hotlink proxy for external tube sources ═══
// /t/<token>  → streams an external source through this server (Range-capable).
// /tx/<token> → bare test player page for quick verification.
// Segments carry a trailing media extension (.m3u8/.ts) for ffmpeg; strip it.
app.get('/t/:token', (req, res) => {
  const tok = String(req.params.token).replace(/\.(m3u8|ts|m4s|m4v|mp4|aac)$/i, '');
  const source = transformer.verifyToken(tok);
  if (!source) return res.status(403).set('X-Robots-Tag', 'noindex').json({ error: 'invalid token' });
  transformer.streamProxy(req, res, source);
});

app.get('/tx/:token', (req, res) => {
  const source = transformer.verifyToken(req.params.token);
  if (!source) {
    res.set('X-Robots-Tag', 'noindex');
    return res.status(403).send('<h3>Invalid transformer token</h3>');
  }
  const src = '/t/' + req.params.token;
  res.set('X-Robots-Tag', 'noindex');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Transformer Test</title><style>body{background:#0a0a0b;color:#fff;font-family:system-ui,sans-serif;margin:0;padding:24px;display:flex;flex-direction:column;gap:16px}
video{width:100%;max-width:960px;aspect-ratio:16/9;background:#000;border-radius:12px;border:1px solid #2a2a30}
a{color:#ff2d55;word-break:break-all}</style></head><body>
<h2 style="margin:0">Transformer Test Player</h2>
<video id="v" controls autoplay muted playsinline preload="metadata"></video>
<p style="font-size:12px;color:#9ca3af;word-break:break-all">Playback URL: <a href="${src}">${src}</a></p>
<script src="/js/hls.min.js"></script>
<script>
(function(){
  var src = ${JSON.stringify(src)};
  var v = document.getElementById('v');
  if (window.Hls && Hls.isSupported()) {
    var h = new Hls({ maxBufferLength: 30 });
    h.loadSource(src);
    h.attachMedia(v);
    h.on(Hls.Events.MANIFEST_PARSED, function(){ try{ v.play(); }catch(e){} });
    h.on(Hls.Events.ERROR, function(e,d){ if(d && d.fatal){ h.destroy(); v.setAttribute('src', src); v.load(); } });
  } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
    v.setAttribute('src', src); v.load();
  } else {
    v.setAttribute('src', src); v.load();
  }
})();
</script>
</body></html>`);
});

// ── cached thumbnail proxy (download once from origin, then serve from disk) ─
app.get('/img/:id', (req, res) => {
  const id = String(req.params.id || '').replace(/\.[a-z0-9]+$/i, '');
  const v = getVideo(id);
  if (!v || !v.thumbnail) return res.status(404).end();
  thumb.serve(v, res);
});

// Admin API: resolve/transform a raw URL or <iframe> embed into a masked /t/ URL
app.post('/api/transformer/resolve', express.json(), async (req, res) => {  if (!req.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
  const source = transformer.parseSource(req.body.input);
  if (!source) return res.status(400).json({ error: 'Unrecognized source — paste an http(s) URL or an <iframe> embed code.' });
  if (req.body.referer && transformer.isSafeUrl(req.body.referer)) source.referer = req.body.referer.trim();
  const tok = transformer.signSource(source);
  let info = { ok: false, error: 'not probed', source: null };
  if (source.type !== 'embed') {
    info = await transformer.preflight(source);
  } else {
    // Try to resolve the embed to a real stream so the admin sees what it maps to.
    try {
      const resolved = await transformer.resolveEmbed(source);
      if (resolved) {
        info = await transformer.preflight(resolved);
        info.source = resolved;
      } else {
        info = { ok: false, error: 'Embed page fetched but no video stream found (SPA? try the direct page URL).' };
      }
    } catch (e) {
      info = { ok: false, error: e.message };
    }
  }
  res.json({
    ok: true,
    source,
    token: tok,
    playbackUrl: '/t/' + tok,
    fullUrl: SITE_BASE + '/t/' + tok,
    testPlayer: SITE_BASE + '/tx/' + tok,
    info
  });
});

// Admin API: add an external-source video straight into the library
app.post('/api/transformer/add-video', express.json(), (req, res) => {
  if (!req.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const body = req.body || {};
    const source = transformer.parseSource(body.input || body.source);
    if (!source) return res.status(400).json({ error: 'Invalid source URL/embed.' });
    if (body.referer && transformer.isSafeUrl(body.referer)) source.referer = body.referer.trim();
    const title = String(body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Title is required.' });
    const id = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) ||
      ('ext-' + Math.random().toString(36).slice(2, 10));
    if (getVideo(id)) return res.status(409).json({ error: `A video with id "${id}" already exists.` });
    const category = String(body.category || '').trim() || 'General';
    const entry = {
      id,
      title,
      source,
      video: null,
      filePath: null,
      thumbnail: body.thumbnail ? String(body.thumbnail).trim() : '',
      views: 0,
      duration: body.duration ? String(body.duration).trim() : '0:30',
      uploaded: new Date().toISOString(),
      category,
      tags: (body.tags || '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 8),
      description: body.description ? String(body.description).trim() : `<h2>${title.replace(/[<>&]/g, '')}</h2>\n<p>Watch <strong>${title.replace(/[<>&]/g, '')}</strong> free in HD on Super X Latina.</p>`,
      featured: false
    };
    siteVideos.unshift(entry);
    fs.writeFileSync(path.join(DATA_DIR, 'videos.json'), JSON.stringify(siteVideos.filter(v => !v.external), null, 2));
    res.json({ ok: true, id, playbackUrl: playbackUrlFor(entry), url: SITE_BASE + '/' + id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin API: bulk-import external videos from a URL list / JSON payload
app.post('/api/ingest', express.text({ type: ['text/plain', 'text/x-txt'], limit: '6mb' }), async (req, res) => {
  if (!req.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
  let entries;
  try {
    entries = ingest.parsePayload(req.body);
  } catch (e) {
    return res.status(400).json({ error: 'Could not parse payload: ' + e.message });
  }
  if (!entries.length) return res.status(400).json({ error: 'No URLs found in payload' });
  try {
    const report = await ingest.ingest(entries, { concurrency: 4, timeoutMs: 12000 });
    scheduleReload();
    res.json({ ok: true, ...report });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin API: scan data/imports for *.txt / *.json lists
app.post('/api/ingest/scan', (req, res) => {
  if (!req.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
  const result = ingest.scanImportsFolder(path.join(DATA_DIR, 'imports'));
  scheduleReload();
  res.json({ ok: true, ...result });
});

// Admin API: re-probe missing durations from the real media (tiny ranged reads)
app.post('/api/backfill-durations', async (req, res) => {
  if (!req.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const library = ingest.loadLibrary();
    const missing = library.filter(v => !v.duration && v.source && v.source.url);
    const report = { total: missing.length, updated: 0, failed: 0, errors: [] };
    let cursor = 0;
    const worker = async () => {
      while (cursor < missing.length) {
        const idx = cursor++;
        const v = missing[idx];
        try {
          const dur = await transformer.probeDuration({ url: v.source.url, referer: v.source.referer || '', type: v.source.type, ua: v.source.ua || '' }, 15000);
          if (dur && dur.duration) { v.duration = dur.duration; report.updated++; }
          else report.failed++;
        } catch (e) { report.failed++; report.errors.push({ id: v.id, error: e.message }); }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    if (report.updated) {
      ingest.saveLibrary(library);
      loadData();
      buildSizeCache();
    }
    res.json({ ok: true, ...report });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin API: backfill missing thumbnails — re-resolve the origin page (plain
// fetch first, then the browser engine for JS-gated hosts like newsexwap.com)
// and cache the discovered image into data/thumbs.
app.post('/api/backfill-thumbnails', async (req, res) => {
  if (!req.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const library = ingest.loadLibrary();
    const missing = library.filter(v => !v.thumbnail && v.source && v.source.url);
    const report = { total: missing.length, updated: 0, failed: 0, errors: [] };
    let cursor = 0;
    const worker = async () => {
      while (cursor < missing.length) {
        const idx = cursor++;
        const v = missing[idx];
        try {
          const src = { url: v.source.url, referer: v.source.referer || '', type: v.source.type, ua: v.source.ua || '' };
          const r = await resolvers.resolveWithMeta(src, { allowBrowser: true });
          const thumb = r && r.meta ? (r.meta.thumbnail || '') : '';
          if (thumb) {
            v.thumbnail = thumb;
            const cached = await thumb.downloadToCache(v);
            const cachedAt = thumb.fileFor(v.id);
            if ((cachedAt && fs.existsSync(cachedAt)) || (cached && cached.ok)) report.updated++;
            else report.failed++;
          } else {
            report.failed++;
            report.errors.push({ id: v.id, error: 'no thumbnail found on origin' });
          }
        } catch (e) { report.failed++; report.errors.push({ id: v.id, error: e.message }); }
      }
    };
    await Promise.all(Array.from({ length: 2 }, worker));
    if (report.updated) {
      ingest.saveLibrary(library);
      scheduleReload();
    }
    res.json({ ok: true, ...report });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin API: delete a single video
app.delete('/api/video/:id', (req, res) => {
  if (!req.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
  const id = String(req.params.id);
  const v = siteVideos.find(x => x.id === id);
  if (!v) return res.status(404).json({ error: 'not found' });
  if (v.external) {
    blacklistExternalIds([id]);
  } else {
    siteVideos = siteVideos.filter(x => x.id !== id);
    persistLocalVideos();
  }
  res.json({ ok: true });
});

// Admin API: bulk delete videos — body: { ids: [...] }
app.post('/api/videos/delete', express.json(), (req, res) => {
  if (!req.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String) : [];
  if (!ids.length) return res.status(400).json({ error: 'No ids provided' });
  const set = new Set(ids);
  const local = siteVideos.filter(v => !v.external && set.has(v.id)).map(v => v.id);
  if (local.length) {
    siteVideos = siteVideos.filter(v => !set.has(v.id) || v.external);
    persistLocalVideos();
  }
  const deletedExt = blacklistExternalIds(ids);
  res.json({ ok: true, deleted: local.length + deletedExt });
});

// Admin API: bulk delete videos by source host — body: { host: 'xmateur.com' }
app.post('/api/videos/delete-by-host', express.json(), (req, res) => {
  if (!req.isAdmin) return res.status(401).json({ error: 'Unauthorized' });
  const host = String(req.body && req.body.host || '').trim().toLowerCase().replace(/^\.+/, '');
  if (!host) return res.status(400).json({ error: 'No host provided' });
  const hits = siteVideos.filter(v => sourceHost(v) === host).map(v => v.id);
  if (!hits.length) return res.json({ ok: true, deleted: 0 });
  const set = new Set(hits);
  const local = siteVideos.filter(v => !v.external && set.has(v.id)).map(v => v.id);
  if (local.length) {
    siteVideos = siteVideos.filter(v => !set.has(v.id) || v.external);
    persistLocalVideos();
  }
  const deletedExt = blacklistExternalIds(hits);
  res.json({ ok: true, deleted: local.length + deletedExt });
});

// Import external videos (from wps-transformer-player admin)
app.post('/api/external/import', express.json(), (req, res) => {
  if (!externalSyncEnabled) return res.status(403).json({ error: 'externalSync is disabled in config.json' });
  try {
    const entries = Array.isArray(req.body) ? req.body : [];
    if (!entries.length) return res.status(400).json({ error: 'No entries provided' });
    const existing = new Map(externalVideos.map(v => [v.id, v]));
    let added = 0;
    for (const e of entries) {
      if (!e.id || !e.video) continue;
      if (!existing.has(e.id)) { externalVideos.push(e); existing.set(e.id, e); added++; }
    }
    saveExternalIndex(externalVideos);
    siteVideos = siteVideos.filter(v => !externalVideos.some(e => e.id === v.id)).concat(externalVideos);
    res.json({ ok: true, added, total: externalVideos.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Video player
app.get('/:id', (req, res) => {
  const video = getVideo(req.params.id);
  if (!video) {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.status(404).render('error', { message: 'Video not found', siteUrl: SITE_BASE, isAdminPage: false });
  }
  const related = getRelated(video);
  const desc = video.external ? '' : (descriptions[video.id]?.description || '');
  const keywords = video.tags || [];

  // Prev/Next in library order (array order in videos.json)
  const _idx = siteVideos.findIndex(x => x.id === video.id);
  const prevVideo = _idx > 0 ? siteVideos[_idx - 1] : null;
  const nextVideo = (_idx >= 0 && _idx < siteVideos.length - 1) ? siteVideos[_idx + 1] : null;

  const breadcrumbSchema = seo.generateStructuredData('breadcrumb', {
    items: [
      { name: SITE_NAME, url: SITE_BASE + '/' },
      { name: video.category || 'Videos', url: video.category ? SITE_BASE + '/category/' + encodeURIComponent(video.category.toLowerCase()) : SITE_BASE },
      { name: video.title, url: SITE_BASE + '/' + video.id }
    ]
  });

  // Sanitized H1 (proven on xmelayu: vulgar H1 → deindexation). Full title stays H2.
  const tp = seoL.seoTitlePair(video.external ? (video.title || video.id) : video.id, SITE_NAME);
  const displayTitle = tp.fullTitle;
  const seoH1 = tp.h1;
  const metaDesc = desc ? desc.replace(/<[^>]+>/g, '').substring(0, 160) : `Watch ${video.title} — latina video on Super X Latina.`;
  const canonicalUrl = SITE_BASE + '/' + video.id;
  const thumbAbs = absUrl(thumbSrc(video) || ('/thumbnails/' + video.id + '.jpg'));
  const playbackUrl = playbackUrlFor(video);

  // Speed: pre-resolve external (embed) sources in the background so the first
  // /t/ request from the player hits the warm cache (my timing probe: 2nd
  // resolve = 0ms) instead of paying a cold embed-page fetch + CDN connect
  // twice. This kills the "first play lags / blank until refresh" symptom.
  const isHotlink = !!(video.source || (video.sourceUrl && !video.filePath));
  if (isHotlink && video.source && transformer.resolveEmbed) {
    transformer.resolveEmbed(video.source, 3).catch(() => {});
  }
  const videoPreview = isHotlink ? '' : (previewReady.has(video.id) ? ('/previews/' + video.id + '.mp4') : '');

  const metaHead = seoMetaForPage({
    title: displayTitle,
    description: metaDesc,
    canonical: canonicalUrl,
    keywords: ['latina video', video.category?.toLowerCase(), ...keywords.slice(0, 4)].filter(Boolean).join(', ') + ', superxlatina, HD latina',
    author: SEO.author,
    ogType: 'video.other',
    ogImage: thumbAbs,
    ogImageWidth: 1280,
    ogImageHeight: 720,
    ogImageAlt: displayTitle,
    ogLocale: 'en_US',
    publishedTime: video.uploaded,
    section: video.category,
    tags: keywords,
    twitterSite: SEO.twitter,
    twitterPlayer: canonicalUrl,
    twitterPlayerWidth: 1280,
    twitterPlayerHeight: 720,
    preloadImage: thumbAbs,
    jsonLd: [
      seoL.videoSchema({
        siteUrl: SITE_BASE,
        id: video.id,
        title: displayTitle,
        description: metaDesc,
        thumbnail: thumbAbs,
        uploaded: video.uploaded,
        duration: video.duration,
        views: video.views,
        contentUrl: playbackUrl
      }),
      seoL.breadcrumbSchema([
        { name: SITE_NAME, url: SITE_BASE + '/' },
        { name: video.category || 'Videos', url: video.category ? SITE_BASE + '/category/' + encodeURIComponent(video.category.toLowerCase()) : SITE_BASE },
        { name: displayTitle, url: canonicalUrl }
      ])
    ]
  });

  res.render('player', {
    title: displayTitle,
    metaDesc,
    seoMeta: metaHead,
    seoH1,
    displayTitle,
    video,
    videoThumb: thumbSrc(video) || ('/thumbnails/' + video.id + '.jpg'),
    playbackUrl,
    videoPreview,
    relatedVideos: related.map(slimVideo),
    prevVideo: prevVideo ? { id: prevVideo.id, title: prevVideo.title, thumbnail: thumbSrc(prevVideo) || ('/thumbnails/' + prevVideo.id + '.jpg') } : null,
    nextVideo: nextVideo ? { id: nextVideo.id, title: nextVideo.title, thumbnail: thumbSrc(nextVideo) || ('/thumbnails/' + nextVideo.id + '.jpg') } : null,
    siteName: SITE_NAME,
    siteUrl: SITE_BASE,
    structuredData: seo.generateStructuredData('video', video),
    breadcrumbSchema,
    keywords,
    videoDescription: desc,
    likeCount: getLikes(video.id),
    metaKeywords: 'latina video, ' + video.category?.toLowerCase() + ', ' + keywords.slice(0, 3).join(', ') + ', superxlatina, HD latina',
    isEnglish: false,
    isAdminPage: false
  });
});

// Error handler
app.use((req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.status(404).render('error', { message: 'Page not found', siteUrl: SITE_BASE, isAdminPage: false });
});
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.status(500).render('error', { message: 'Something went wrong', siteUrl: SITE_BASE, isAdminPage: false });
});

// ── import folder watcher (lightweight poll, like wps-transformer-player) ──
// Drop *.txt / *.json URL lists into data/imports — they are picked up one file
// at a time, processed sequentially and slowly (no page fetch, no duration
// probe), then moved to data/imports/done. Never hurries, never gets banned.
let importScanBusy = false;
setInterval(() => {
  if (importScanBusy) return;
  importScanBusy = true;
  try {
    if (fs.readdirSync(IMPORTS_DIR).some(f => /\.(json|txt)$/i.test(f))) {
      const r = ingest.scanImportsFolder(IMPORTS_DIR);
      if (r.report && r.report.added) {
        loadData();
        buildSizeCache();
        console.log(`[ingest] auto-imported ${r.report.added} videos (${r.report.failed} failed)`);
      }
    }
  } catch (e) {}
  importScanBusy = false;
}, 30000);

// Start
(async () => {
  if (externalSyncEnabled) await xcdn.start();
  loadData();
  buildSizeCache();
  initDb();
  if (!siteVideos.length) {
    console.log('No videos found — scanning folder...');
    const result = await autoScan.scanAndIndex(CONFIG_PATH);
    if (result.total) {
      loadData();
      buildSizeCache();
      console.log(`  Indexed ${result.total} videos`);
    }
  }
  server.listen(PORT, () => {
    const memTotal = (os.totalmem() / 1e9).toFixed(1);
    const memUsed = ((os.totalmem() - os.freemem()) / 1e9).toFixed(1);
    console.log(`
  ╔══════════════════════════════════════════════╗
  ║   Super X Latina — HD Latina Videos   ║
  ╠══════════════════════════════════════════════╣
  ║  ${siteVideos.length} videos  │  Port ${PORT}  │  ${IS_PROD ? 'PROD' : 'DEV'}
  ║  ${memUsed}/${memTotal} GB RAM  │  ${os.platform()}
  ╚══════════════════════════════════════════════╝
  Drop URL lists in: ${IMPORTS_DIR}
    `);
  });
})();
