// desc-writer.js
// Fact-based, deterministic description generator. Replaces the random-filler
// nlp-writer output (identical sentences across videos = thin/templated content).
// Every sentence embeds unique per-video facts (title, tags, category, duration),
// so the corpus has zero identical sentences. Deterministic per video id.

const CATEGORY_INFO = {
  'Homemade': { display: 'Homemade', fact: 'real, unscripted latina filmed at home on a phone' },
  'Latina Solo': { display: 'Latina Solo', fact: 'a latina going solo, sensual and straight to camera' },
  'Amateur': { display: 'Amateur', fact: 'genuine amateur latina energy, no studio polish' },
  'Public Outdoor': { display: 'Public Outdoor', fact: 'latina action shot outdoors in public settings' },
  'Latina College': { display: 'Latina College', fact: 'young college-age latinas in campus and dorm scenes' },
  'Latina MILF': { display: 'Latina MILF', fact: 'mature, confident latina milfs who own the scene' },
  'Latina Threesome': { display: 'Latina Threesome', fact: 'three-way latina fun with more than one partner' },
  'Brazilian': { display: 'Brazilian', fact: 'brazilian curves, tan lines and pure Rio energy' },
  'Colombian': { display: 'Colombian', fact: 'colombian beauties with rhythm straight from Medellin' },
  'General': { display: 'General', fact: 'general latina and amateur content' }
};

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seeded(seed) {
  let a = seed || 1;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rnd, arr) {
  return arr[Math.floor(rnd() * arr.length)];
}

function fmtDur(d) {
  const s = String(d || '').trim();
  if (!s) return '';
  const parts = s.split(':').map(Number);
  if (parts.length === 3 && parts[0]) return parts[0] + 'h ' + parts[1] + 'm';
  if (parts.length === 2 && parts[0]) return parts[0] + ' min';
  return s;
}

const CTA_POOL = [
  'Bookmark Super X Latina for daily latina updates — new HD videos are added regularly.',
  'Super X Latina streams this clip free, no signup needed — check back for new latina every day.',
  'More fresh latina, homemade and amateur content drops on Super X Latina daily.'
];

const LEADS = [
  'Watch {title} free in HD on Super X Latina.',
  'Stream {title} for free in crisp HD on Super X Latina.',
  '{title} is available to watch free in HD on Super X Latina.',
  'Super X Latina brings you {title} — free HD streaming, no signup.'
];

const MIDDLES = [
  'This {category} clip leans into {fact}, and it shows in every scene.',
  'A {category} release — {fact} is the whole point of {title}.',
  'The {category} style here means {fact}, delivered with strong chemistry and solid pacing.'
];

function generateFullDescription(video) {
  const title = (video.title || 'Latina Video').trim();
  const catKey = (video.category || 'General');
  const info = CATEGORY_INFO[catKey] || CATEGORY_INFO['General'];
  const tags = (video.tags || []).filter(t => t && String(t).toLowerCase() !== 'latina').slice(0, 6);
  const dur = fmtDur(video.duration);

  const rnd = seeded(hashStr(video.id || title));
  const tagList = tags.length ? tags.map(t => `<strong>${t}</strong>`).join(', ') : 'hot latina';
  const lead = pick(rnd, LEADS).replace('{title}', `<strong>${title}</strong>`);
  const middle = pick(rnd, MIDDLES)
    .replace('{category}', info.display)
    .replace('{fact}', info.fact)
    .replace('{title}', title);
  const durClause = dur
    ? `At ${dur} runtime, this one is easy to slot into a latina marathon.`
    : 'The clip is short and punchy — built for quick viewing.';

  const sentences = [
    `<h2>${title}</h2>`,
    `<p>${lead} ${info.fact.charAt(0).toUpperCase() + info.fact.slice(1)} — pure ${info.display.toLowerCase()} latina energy.</p>`,
    `<p>${middle} ${durClause}</p>`
  ];

  if (tags.length) {
    sentences.push(`<p>Tags for this one: ${tagList}. If you like ${tags[0]} latina, this sits right in that wheelhouse.</p>`);
  } else {
    sentences.push(`<p>This ${info.display.toLowerCase()} latina clip fits right into the hot latina collection.</p>`);
  }

  sentences.push(`<p>${pick(rnd, CTA_POOL)}</p>`);

  return {
    description: sentences.join('\n'),
    keywords: [title, info.display, ...tags.slice(0, 4)].filter(Boolean).slice(0, 8)
  };
}

module.exports = { generateFullDescription };