// seo-layer.js
// Express "SEO layer" — ports the proven conventions of Next.js (per-page metadata,
// sitemap.xml/robots.ts route handlers, dynamic OG) and WordPress/Yoast (meta templating,
// canonical, breadcrumbs, schema, sitemaps, redirects, noindex controls) into Express+EJS.
// All copy is config-driven so a niche rebrand is a config edit, not a code edit.

const { SITE_NAME } = require('path') ? {} : {};
const path = require('path');
const fs = require('fs');

// ── H1 sanitizer ─────────────────────────────────────────────────────────
// Proven on xmelayu: vulgar keywords in the H1 cause deindexation. The H1 must be a
// clean keyword paraphrase; the full raw title goes in the H2.
const VULGAR_RE = /\b(sex|sexy|porn|xxx|pussy|dick|fuck|fucking|bitch|slut|whore|cunt|nude|naked|blowjob|handjob|fingering|anal|bdsm|fetish|gangbang|threesome|orgy|masturbat|creampie|squirt|tits|boobs|nipple|milf|latina|pthc|cp)\b/gi;

function sanitizeH1(text) {
  if (!text) return '';
  return String(text)
    .replace(/\.(mp4|webm|mkv)$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(VULGAR_RE, m => m[0] + '*'.repeat(Math.max(m.length - 1, 1)))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function buildVideoTitle(id, extra = '') {
  const clean = String(id || '')
    .replace(/\.(mp4|webm|mkv)$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
  const words = clean.split(/\s+/).filter(w => w.length > 0);
  const core = words.slice(0, 8).join(' ');
  return core ? (extra ? core + extra : core) : 'Video';
}

function seoTitlePair(rawId, siteName) {
  const full = buildVideoTitle(rawId);
  const h1 = sanitizeH1(full.replace(/\s+/g, ' ')) || 'Watch Video';
  return { h1, h2: full, fullTitle: full + (siteName ? ' — ' + siteName : '') };
}

// ── Meta renderer ─────────────────────────────────────────────────────────
// Renders the complete <meta>/<link>/<script> block for a page head.
// Mirrors xx old's proven tag set + Next.js generateMetadata semantics.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderMeta(o) {
  const siteName = o.siteName || 'Super X Latina';
  const siteUrl = (o.siteUrl || '').replace(/\/+$/, '');
  const canonical = o.canonical || siteUrl + '/';
  const title = o.title || siteName;
  const desc = (o.description || '').substring(0, 300);
  const tags = [];
  const abs = (u) => (u && !/^https?:\/\//.test(u) ? siteUrl + u : u || '');

  // robots
  const robots = o.noindex
    ? 'noindex, nofollow'
    : (o.robots || 'index, follow, max-snippet:-1, max-video-preview:large, max-image-preview:large');
  tags.push(`<title>${esc(title)}</title>`);
  tags.push(`<meta name="robots" content="${esc(robots)}">`);
  if (!o.noindex) tags.push(`<meta name="googlebot" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:large">`);
  tags.push(`<link rel="canonical" href="${esc(canonical)}">`);

  // base meta
  if (desc) tags.push(`<meta name="description" content="${esc(desc)}">`);
  if (o.keywords) tags.push(`<meta name="keywords" content="${esc(o.keywords)}">`);
  if (o.author) tags.push(`<meta name="author" content="${esc(o.author)}">`);

  // article time (player pages)
  if (o.publishedTime) tags.push(`<meta property="article:published_time" content="${esc(o.publishedTime)}">`);
  if (o.section) tags.push(`<meta property="article:section" content="${esc(o.section)}">`);
  if (o.tags && o.tags.length) tags.push(`<meta property="article:tag" content="${esc(o.tags.slice(0, 8).join(', '))}">`);

  // OG
  tags.push(`<meta property="og:type" content="${esc(o.ogType || 'website')}">`);
  tags.push(`<meta property="og:title" content="${esc(o.ogTitle || title)}">`);
  if (desc) tags.push(`<meta property="og:description" content="${esc(o.ogDesc || desc)}">`);
  tags.push(`<meta property="og:url" content="${esc(o.ogUrl || canonical)}">`);
  tags.push(`<meta property="og:site_name" content="${esc(siteName)}">`);
  const ogImg = abs(o.ogImage);
  if (ogImg) {
    tags.push(`<meta property="og:image" content="${esc(ogImg)}">`);
    tags.push(`<meta property="og:image:width" content="${esc(o.ogImageWidth || '600')}">`);
    tags.push(`<meta property="og:image:height" content="${esc(o.ogImageHeight || '337')}">`);
    if (o.ogImageAlt) tags.push(`<meta property="og:image:alt" content="${esc(o.ogImageAlt)}">`);
    tags.push(`<link rel="image_src" href="${esc(ogImg)}">`);
  }
  if (o.ogLocale) tags.push(`<meta property="og:locale" content="${esc(o.ogLocale)}">`);
  (o.ogLocaleAlternates || []).forEach(l => tags.push(`<meta property="og:locale:alternate" content="${esc(l)}">`));

  // Twitter
  tags.push(`<meta name="twitter:card" content="${esc(o.twitterCard || 'summary_large_image')}">`);
  if (o.twitterSite) tags.push(`<meta name="twitter:site" content="${esc(o.twitterSite)}">`);
  tags.push(`<meta name="twitter:title" content="${esc(o.twitterTitle || title)}">`);
  if (desc) tags.push(`<meta name="twitter:description" content="${esc((o.twitterDesc || desc).substring(0, 120))}">`);
  if (ogImg) tags.push(`<meta name="twitter:image" content="${esc(ogImg)}">`);
  if (o.twitterPlayer) {
    tags.push(`<meta name="twitter:player" content="${esc(o.twitterPlayer)}">`);
    tags.push(`<meta name="twitter:player:width" content="${esc(o.twitterPlayerWidth || '1280')}">`);
    tags.push(`<meta name="twitter:player:height" content="${esc(o.twitterPlayerHeight || '720')}">`);
  }

  // preloads / perf
  if (o.preloadImage) {
    tags.push(`<link rel="preload" href="${esc(abs(o.preloadImage))}" as="image" fetchpriority="high">`);
  }
  if (o.preloadVideo) {
    tags.push(`<link rel="preload" href="${esc(abs(o.preloadVideo))}" as="video" type="video/mp4">`);
  }
  if (o.rssUrl) tags.push(`<link rel="alternate" type="application/rss+xml" title="${esc(siteName + ' — New Videos')}" href="${esc(abs(o.rssUrl))}">`);

  // favicon + manifest
  tags.push(`<link rel="icon" type="image/svg+xml" href="/favicon.svg">`);
  tags.push(`<link rel="icon" type="image/png" sizes="192x192" href="/favicon-192.png">`);
  tags.push(`<link rel="icon" type="image/x-icon" href="/favicon.ico">`);
  tags.push(`<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">`);
  tags.push(`<link rel="manifest" href="/site.webmanifest">`);

  // JSON-LD
  (o.jsonLd || []).filter(Boolean).forEach(sd => {
    tags.push('<script type="application/ld+json">' + JSON.stringify(sd) + '</script>');
  });

  return tags.join('\n');
}

// ── noindex middleware ───────────────────────────────────────────────────
// WordPress/Yoast equivalent: enforced noindex for non-public paths. robots.txt
// alone is not enough — Google can still index a URL it reached another way.
function noindexPaths(patterns) {
  return (req, res, next) => {
    if (patterns.some(p => typeof p === 'string' ? req.path.startsWith(p) : p.test(req.path))) {
      res.set('X-Robots-Tag', 'noindex, nofollow');
    }
    next();
  };
}

// ── RSS feed (RSS 2.0 + media) ───────────────────────────────────────────
function buildFeed({ siteName, siteUrl, description, videos, max = 100 }) {
  const escXml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  const items = (videos || []).slice(0, max).map(v => {
    const link = siteUrl + '/' + v.id;
    const thumb = (v.thumbnail && !/^https?:/.test(v.thumbnail)) ? siteUrl + v.thumbnail : (v.thumbnail || '');
    return `<item>
  <title>${escXml(v.title)}</title>
  <link>${escXml(link)}</link>
  <guid isPermaLink="true">${escXml(link)}</guid>
  <pubDate>${escXml(new Date(v.uploaded || Date.now()).toUTCString())}</pubDate>
  <description>${escXml((v.description || v.title || '').replace(/<[^>]+>/g, '').substring(0, 300))}</description>
  ${thumb ? `<media:thumbnail url="${escXml(thumb)}"/><media:content url="${escXml(thumb)}" medium="image"/>` : ''}
</item>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>${escXml(siteName)}</title>
  <link>${escXml(siteUrl)}</link>
  <description>${escXml(description || '')}</description>
  <atom:link href="${escXml(siteUrl + '/feed.xml')}" rel="self" type="application/rss+xml"/>
  <lastBuildDate>${escXml(new Date().toUTCString())}</lastBuildDate>
${items}
</channel>
</rss>`;
}

// ── sitemap index + pagination ───────────────────────────────────────────
function buildSitemapIndex({ siteUrl, count, perFile = 50000 }) {
  const files = [];
  files.push(`${siteUrl}/sitemap.xml`);
  if (count > perFile) {
    const pages = Math.ceil(count / perFile);
    for (let i = 2; i <= pages; i++) files.push(`${siteUrl}/sitemap-${i}.xml`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${files.map(f => `  <sitemap><loc>${f}</loc></sitemap>`).join('\n')}
</sitemapindex>`;
}

// ── helpers for JSON-LD blocks (xx old parity) ───────────────────────────
function websiteSchema(siteName, siteUrl, description, alternateNames, inLanguage) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: siteName,
    alternateName: alternateNames || undefined,
    url: siteUrl + '/',
    description: description || undefined,
    potentialAction: {
      '@type': 'SearchAction',
      target: siteUrl + '/?q={search_term_string}',
      'query-input': 'required name=search_term_string'
    },
    inLanguage: inLanguage || ['en']
  };
}

// ── SiteNavigationElement (sitelink eligibility: maps the primary nav for crawlers) ──
// Classic Google form: parallel name[]/url[] arrays for the main-menu links.
function navSchema(items) {
  const list = (items || []).filter(i => i && i.url).slice(0, 12);
  return {
    '@context': 'https://schema.org',
    '@type': 'SiteNavigationElement',
    name: list.map(i => i.name),
    url: list.map(i => i.url)
  };
}

function organizationSchema(siteName, siteUrl, description, sameAs, alternateNames) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: siteName,
    alternateName: alternateNames || undefined,
    url: siteUrl + '/',
    logo: siteUrl + '/favicon.svg',
    description: description || undefined,
    sameAs: (sameAs || []).filter(Boolean)
  };
}

function collectionSchema(name, description, url, totalItems, about, audience) {
  const base = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name,
    description: description || undefined,
    url
  };
  if (totalItems != null) {
    base.mainEntity = {
      '@type': 'ItemList',
      name,
      numberOfItems: totalItems,
      itemListElement: []
    };
  }
  if (about) base.about = { '@type': 'Thing', name: about };
  if (audience) base.audience = { '@type': 'PeopleAudience', suggestedAge: audience === '18+' ? '18+' : undefined };
  return base;
}

function breadcrumbSchema(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: (items || []).map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: it.url
    }))
  };
}

function durToSeconds(d) {
  const s = String(d == null ? '' : d);
  const parts = s.split(':').map(x => parseInt(x, 10) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parseInt(s, 10) || 0;
}

function durToIso(d) {
  const secs = durToSeconds(d);
  if (!secs) return undefined;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  let iso = 'PT';
  if (h) iso += h + 'H';
  if (m) iso += m + 'M';
  iso += s + 'S';
  return iso;
}

function videoSchema({ siteUrl, id, title, description, thumbnail, uploaded, duration, views, embedUrl, contentUrl }) {
  const esc = (s) => String(s || '');
  return {
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: title,
    description: esc(description || '').replace(/<[^>]+>/g, '').substring(0, 300),
    thumbnailUrl: thumbnail && !/^https?:/.test(thumbnail) ? siteUrl + thumbnail : thumbnail,
    uploadDate: uploaded || new Date().toISOString(),
    contentUrl: contentUrl && !/^https?:/.test(contentUrl) ? siteUrl + contentUrl : contentUrl,
    embedUrl: embedUrl || siteUrl + '/' + id,
    mainEntityOfPage: siteUrl + '/' + id,
    duration: durToIso(duration),
    interactionStatistic: views ? {
      '@type': 'InteractionCounter',
      interactionType: 'WatchAction',
      userInteractionCount: views
    } : undefined,
    publisher: { '@type': 'Organization', name: null, url: siteUrl }
  };
}

function faqSchema(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: (items || []).map(i => ({
      '@type': 'Question',
      name: i.q,
      acceptedAnswer: { '@type': 'Answer', text: i.a }
    }))
  };
}

function aboutPageSchema(siteName, url, description) {
  return {
    '@context': 'https://schema.org',
    '@type': 'AboutPage',
    name: siteName,
    url,
    description: description || siteName
  };
}

function contactPageSchema(email, url) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ContactPage',
    url,
    mainEntity: { '@type': 'Organization', name: 'Super X Latina', email }
  };
}

// ── sitemap URL entry (escaped) ──────────────────────────────────────────
function sitemapEntry(siteUrl, permalink, { updated, changefreq, priority } = {}) {
  const escXml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let e = `  <url>\n    <loc>${escXml(siteUrl + permalink)}</loc>\n`;
  if (updated) e += `    <lastmod>${escXml(updated)}</lastmod>\n`;
  if (changefreq) e += `    <changefreq>${escXml(changefreq)}</changefreq>\n`;
  if (priority) e += `    <priority>${escXml(priority)}</priority>\n`;
  e += '  </url>';
  return e;
}

function videoSitemapEntry(siteUrl, permalink, { title, description, thumbnail, duration, uploaded, contentLoc }) {
  const escXml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const thumb = thumbnail && !/^https?:/.test(thumbnail) ? siteUrl + thumbnail : thumbnail;
  let e = `  <url>\n    <loc>${escXml(siteUrl + permalink)}</loc>\n`;
  e += `    <video:video>\n      <video:title>${escXml(title)}</video:title>\n`;
  e += `      <video:description>${escXml((description || title).replace(/<[^>]+>/g, '').substring(0, 300))}</video:description>\n`;
  if (thumb) e += `      <video:thumbnail_loc>${escXml(thumb)}</video:thumbnail_loc>\n`;
  // Google requires ABSOLUTE content_loc — relative /videos/*.mp4 was silently dropped.
  const content = contentLoc && !/^https?:/.test(contentLoc) ? siteUrl + contentLoc : contentLoc;
  if (content) e += `      <video:content_loc>${escXml(content)}</video:content_loc>\n`;
  const durSecs = durToSeconds(duration);
  if (durSecs) e += `      <video:duration>${durSecs}</video:duration>\n`;
  if (uploaded) e += `      <video:publication_date>${escXml(uploaded)}</video:publication_date>\n`;
  e += `      <video:requires_subscription>no</video:requires_subscription>\n    </video:video>\n  </url>`;
  return e;
}

module.exports = {
  renderMeta,
  noindexPaths,
  buildFeed,
  buildSitemapIndex,
  sanitizeH1,
  buildVideoTitle,
  seoTitlePair,
  websiteSchema,
  organizationSchema,
  collectionSchema,
  breadcrumbSchema,
  videoSchema,
  faqSchema,
  aboutPageSchema,
  contactPageSchema,
  sitemapEntry,
  videoSitemapEntry,
  navSchema,
  durToSeconds,
  durToIso
};
