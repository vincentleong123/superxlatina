// keyword-seo.js
// Keyword landing-page engine: per-keyword SEO content templates + related-keyword
// internal linkage. Ported from the superbtube keyword system and adapted to the
// Super X Latina data model (tags instead of keywords arrays).

const SEO_CONTENT_TEMPLATES = {
  'homemade': { title: 'Homemade', h1: 'Homemade Latina — Real Couple Videos', emoji: '📱', lang: 'en' },
  'amateur': { title: 'Amateur', h1: 'Amateur Latina — Raw Room Videos', emoji: '🎥', lang: 'en' },
  'solo': { title: 'Solo', h1: 'Latina Solo — Girls Alone Videos', emoji: '🌹', lang: 'en' },
  'milf': { title: 'MILF', h1: 'MILF Latina — Mature Latina Collection', emoji: '🔥', lang: 'en' },
  'college': { title: 'College', h1: 'Latina College — Campus Party Videos', emoji: '🎓', lang: 'en' },
  'public': { title: 'Public Outdoor', h1: 'Public Latina — Outdoor Action Videos', emoji: '🌴', lang: 'en' },
  'outdoor': { title: 'Outdoor', h1: 'Outdoor Latina — Fresh Air Videos', emoji: '🌴', lang: 'en' },
  'threesome': { title: 'Threesome', h1: 'Latina Threesome — Three-Way Fun', emoji: '🎉', lang: 'en' },
  'creampie': { title: 'Creampie', h1: 'Creampie Latina — Cum Inside Videos', emoji: '💦', lang: 'en' },
  'pov': { title: 'POV', h1: 'POV Latina — Point of View Latina', emoji: '👁️', lang: 'en' },
  'bdsm': { title: 'BDSM', h1: 'BDSM Latina — Bondage Latina Videos', emoji: '⛓️', lang: 'en' },
  'gangbang': { title: 'Gangbang', h1: 'Gangbang Latina — Group Latina Videos', emoji: '👥', lang: 'en' },
  'busty': { title: 'Busty', h1: 'Busty Latina — Big Curves Latina', emoji: '🍈', lang: 'en' },
  'big ass': { title: 'Big Ass', h1: 'Big Ass Latina — Thick Curves Videos', emoji: '🍑', lang: 'en' },
  'blowjob': { title: 'Blowjob', h1: 'Latina Blowjob — Oral Pleasure Videos', emoji: '💋', lang: 'en' },
  'anal': { title: 'Anal', h1: 'Anal Latina — Behind the Scenes', emoji: '🎯', lang: 'en' },
  'webcam': { title: 'Webcam', h1: 'Latina Webcam — Live Cam Vibes', emoji: '📹', lang: 'en' },
  'teen': { title: 'Teen', h1: 'Latina Teen — Young Energy Videos', emoji: '✨', lang: 'en' },
  'real': { title: 'Real', h1: 'Real Latina — Unscripted Moments', emoji: '🎬', lang: 'en' },
  'caribbean': { title: 'Caribbean', h1: 'Caribbean Latina — Island Heat Videos', emoji: '🏝️', lang: 'en' },
  'brazilian': { title: 'Brazilian', h1: 'Brazilian Latina — Rio Energy Videos', emoji: '🌺', lang: 'en' },
  'colombian': { title: 'Colombian', h1: 'Colombian Latina — Medellin Vibes', emoji: '💃', lang: 'en' },
};

const NICHE_KEYWORDS = new Set([
  'homemade', 'amateur', 'solo', 'milf', 'college', 'public', 'outdoor',
  'threesome', 'creampie', 'pov', 'bdsm', 'gangbang', 'busty', 'blowjob',
  'anal', 'webcam', 'teen', 'real', 'caribbean', 'brazilian', 'colombian',
  'mfm', 'lesbian', 'tattoo', 'bbw', 'casting', 'hidden cam', 'backyard'
]);

// Generic tags that add no internal-link value on a keyword page.
const LINKAGE_STOPWORDS = new Set([
  'latina', 'xxx', 'sex', 'sexual', 'video', 'videos', 'free', 'hd', '1080p',
  'watch', 'online', 'stream', 'streaming', 'porn', 'porno', 'superxlatina',
  'anime', 'ani', 'full', 'best', 'hot', 'scene', 'scenes', 'english', 'eng',
  'hd1080p', '2160p', '4k', 'animation', 'animated'
]);

function titleCase(keyword) {
  return keyword.split(/[\s-]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function generateKeywordContent(keyword, matchedVideos, siteName) {
  const brand = siteName || 'Super X Latina';
  const tpl = SEO_CONTENT_TEMPLATES[keyword];
  const count = matchedVideos.length;
  const totalViews = matchedVideos.reduce((s, v) => s + (v.views || 0), 0);
  const categories = [...new Set(matchedVideos.map(v => v.category).filter(Boolean))];

  const titleWord = tpl ? tpl.title : titleCase(keyword);
  const emoji = tpl ? tpl.emoji : '🔞';

  const h1 = tpl ? tpl.h1 : (keyword === 'latina' ? 'Latina Videos — Free HD Collection' : `${titleWord} Latina Videos`);
  const metaDesc = keyword === 'latina'
    ? `Watch ${count} free latina videos in HD. Homemade, milf & amateur latina collection. Free streaming, updated daily.`
    : `Watch ${count} free ${keyword} latina videos in HD. Amateur, milf & homemade latina collection. Free streaming, updated daily.`;
  const content = `<h2>${emoji} ${h1}</h2>
<p><strong>${brand}</strong> presents our curated collection of <strong>${count} ${keyword} latina videos</strong> — free HD latina content updated daily. Every video is hand-picked for quality.</p>
<p>Whether you are searching for <strong>${keyword} latina</strong>, <strong>${keyword} clips</strong>, or the best <strong>${keyword} collection</strong>, this category delivers the best animated adult content. Our ${keyword} category is updated daily with fresh uploads.</p>${categories.length > 0 ? `
<h3>Top ${keyword} Categories</h3>
<p>Our ${keyword} collection spans multiple categories: ${categories.slice(0, 5).join(', ')}. Each video is hand-picked for quality.</p>` : ''}
<h3>Why Watch ${titleWord} Latina on ${brand}?</h3>
<p><strong>HD Quality:</strong> All videos stream in HD quality with fast loading.<br>
<strong>Updated Daily:</strong> New ${keyword} latina videos added every day.<br>
<strong>FREE Access:</strong> No subscription needed — all content is free to watch.</p>
<p>Browse our complete <a href="/" style="color:#ff2d55">${keyword} latina collection</a> and discover why thousands of viewers choose ${brand}.</p>`;

  return { title: `${h1} | ${brand}`, h1, metaDesc, content, emoji, totalViews };
}

function findRelatedKeywords(keyword, matchedVideos) {
  const freq = {};
  const tagSet = new Set();
  matchedVideos.forEach(v => {
    (v.tags || []).forEach(t => {
      const k = String(t).toLowerCase().trim();
      if (!k) return;
      if (k === keyword) return;
      if (LINKAGE_STOPWORDS.has(k)) return;
      if (/^\d+$/.test(k)) return;
      if (tagSet.has(k)) return;
      tagSet.add(k);
      freq[k] = (freq[k] || 0) + 1;
    });
  });
  const scored = Object.entries(freq).map(([k, n]) => ({
    k, n, boost: NICHE_KEYWORDS.has(k) ? 2 : 0
  }));
  scored.sort((a, b) => (b.n + b.boost) - (a.n + a.boost));
  return scored.slice(0, 12).map(x => x.k);
}

module.exports = {
  SEO_CONTENT_TEMPLATES,
  NICHE_KEYWORDS,
  generateKeywordContent,
  findRelatedKeywords
};
