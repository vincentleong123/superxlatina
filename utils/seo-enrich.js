// SEO enrichment for the xcdn external catalog.
//
// The external snapshot rewrites every title to the generic "Super X Latina
// Video NNNN" and carries no category/tags/featured — which leaves every video
// page (title/H1/meta/JSON-LD), the sitemap, keyword hubs and the homepage
// carousel without a single keyword. This module recovers the real, keyword-rich
// metadata from the video slug (id), which the import pipeline derives from the
// origin title.
//
// Pure + deterministic: the same slug always yields the same output, so the
// 2-minute xcdn re-sync never produces crawl churn or repeated changes.

'use strict';

// Tokens introduced by the slugifier for punctuation/entities (see slugs like
// "lbrack-domestic-rsqb" = "[domestic]", "couldn-t", "i-m").
const NOISE_TOKENS = new Set([
  'lbrack', 'rsqb', 'excl', 'comma', 'period', 'sol', 'vert', 'swyp', 'num',
  'section', 'www', 'com', 'net', 'org', 'mp4', 'mov', 'flv', 'hd', 'full',
  'tube', 'wat', 'ex', 'ooo', 'xnnx', 'aswn', 'clip', 'new', 'pornnum'
]);

const STOP_WORDS = new Set([
  'and', 'for', 'the', 'with', 'her', 'his', 'that', 'this', 'you', 'she',
  'they', 'into', 'from', 'but', 'not', 'are', 'was', 'has', 'had', 'over',
  'while', 'when', 'after', 'him', 'them', 'get', 'got', 'gets', 'getting',
  'really', 'very', 'some', 'such', 'onto', 'than', 'then', 'just', 'also',
  'now', 'here', 'there', 'only', 'about', 'like', 'make', 'makes', 'made',
  'take', 'takes', 'taken', 'want', 'wants', 'will', 'would', 'can', 'could',
  'should', 'your', 'yourre', 'our', 'their', 'more', 'most', 'been', 'being',
  'each', 'two', 'one', 'may', 'of', 'in', 'on', 'at', 'to', 'by', 'as', 'an',
  'or', 'if', 'so', 'be', 'it', 'its', 'is', 'do', 'does', 'did', 'no', 'yes',
  'up', 'down', 'out', 'off', 'go', 'goes', 'went', 'all', 'any', 'both',
  'video', 'videos', 'watch', 'movie', 'movies', 'clip', 'clips', 'footage'
]);

const CONTRACTION_WORDS = new Set([
  'i', 'he', 'she', 'it', 'you', 'they', 'we', 'who', 'what', 'when', 'why',
  'how', 'here', 'there', 'that', 'this', 'let', 'couldn', 'wouldn', 'shouldn',
  'don', 'didn', 'doesn', 'isn', 'wasn', 'aren', 'weren', 'can', 'won', 'shan',
  'needn', 'ain', 'mustn', 'o', 'mouth' // 'mouth' not a contraction — kept minimal
]);

function tokenize(slug) {
  return String(slug || '').toLowerCase().trim().split(/[^a-z0-9]+/).filter(Boolean);
}

function isJunk(t) {
  if (!t || t.length < 2) return true;
  if (NOISE_TOKENS.has(t)) return true;
  if (/^\d{2,}$/.test(t)) return true; // bare episode/season numbers
  if (/^[0-9a-f]{8,}$/.test(t)) return true; // long hex-looking tokens
  return false;
}

// "you-really-wanted-to-finish-my-pussy-but-you-failed"
//   → "You Really Wanted To Finish My Pussy But You Failed"
// "lbrack-domestic-rsqb-jelly-media-domestic-av-chinese..." → "Jelly Media Domestic Av Chinese"
function slugToTitle(id) {
  const toks = tokenize(id);
  if (!toks.length) return '';
  const out = [];
  let prevKey = '';
  for (const t of toks) {
    if (isJunk(t)) continue;
    if (t.length === 1) {
      if (CONTRACTION_WORDS.has(prevKey) && /[tmsdllvere]/.test(t)) {
        out.push(`'${t}`);
        prevKey = out[out.length - 1];
      }
      continue;
    }
    if (STOP_WORDS.has(t)) { prevKey = t; continue; }
    out.push(t);
    prevKey = t;
  }
  const words = out.slice(0, 10);
  if (words.length < 2) return '';
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Category detection — first matching rule wins. Left as "General" when nothing
// matches so the existing /category/general URL keeps working.
const CATEGORY_RULES = [
  { cat: 'Latina Lesbian', rx: /(^|[^a-z])(lesbian|tribbing|scissor|girl-on-girl|gogirl)/ },
  { cat: 'Latina Anal', rx: /(^|[^a-z])anal\b|anally|anal-sex|ass-fuck/ },
  { cat: 'Latina Blowjob', rx: /(blow.?job|deep.?throat|(^|[^a-z])bj([^a-z]|$)|sucking|swallow|titfuck.*cum)/ },
  { cat: 'Latina Step Fantasy', rx: /step-?(mom|mother|dad|father|sister|brother|daughter|son|family|family-edge)/ },
  { cat: 'Latina MILF', rx: /(^|[^a-z])milf|cougar|mature|housewife|(^|[^a-z])wife|wives/ },
  { cat: 'Latina Teen', rx: /(^|[^a-z])(teen|teens)([^a-z]|$)|1[89].?yo|young|college|student|school-?girl|virgin|first-?time/ },
  { cat: 'Latina Asian', rx: /japan|chinese|\btaiwan|korean|\bthai\b|\basian\b|\bpinay\b|\bindon|indo.?sex|\bang[sy]?/ },
  { cat: 'Latina Big Tits', rx: /(big|huge|large|massive)[\s-]*(tit|boob|breast)|busty|\bjugs\b/ },
  { cat: 'Latina Interracial', rx: /interracial|\bbbc\b|big-?black|black-?cock|black-girl|snowbunny/ },
  { cat: 'Latina Creampie', rx: /creampie|cream-?pie|cums?[\s-]*(in|inside)|internal-?cum|cum-inside/ },
  { cat: 'Latina POV', rx: /(^|[^a-z])pov([^a-z]|$)|point-of-view/ },
  { cat: 'Latina Gangbang', rx: /gang-?bang|\d+[\s-]*(men|guys)|threesome|three-?some|\btrio\b|bukkake|double-?penetrat/ },
  { cat: 'Latina Casting', rx: /casting|audition|doubleview|casting-?call|slutsoncamera/ },
  { cat: 'Latina Solo', rx: /(^|[^a-z])solo([^a-z]|$)|masturbat|fingering|cam-?girl|webcam|licks?-?her|touches?-?her|sol-?o/ },
  { cat: 'Latina Amateur', rx: /amateur|home-?made|home-?video|sex-?tape|(^|[^a-z])real([^a-z]|$)|girlfriend|girl-?friend|\bcouple\b|\bexcl\b|record-?(ed|ing)?/ },
  { cat: 'Latina Public', rx: /public|neighbor|neighbour|stranger|(^|[^a-z])park\b|office|bathroom|classroom|kitchen|shower|beach|pool|locker|stair/ },
  { cat: 'Latina Hentai', rx: /hentai|\banime\b|cartoon|\b2d\b|\bcg\b|tentacle/ },
  { cat: 'Latina Webcam', rx: /(^|[^a-z])cam(s|ming)?([^a-z]|$)|webcam|on-?cam|camzilla|jasmin|chaturbate/ }
];

function detectCategory(slug) {
  const s = String(slug || '').toLowerCase();
  for (const r of CATEGORY_RULES) {
    if (r.rx.test(s)) return r.cat;
  }
  return 'General';
}

// High-value multi-word tags matched against the raw slug, then padded with
// meaningful single tokens. Deterministic and capped so player tag chips stay
// useful instead of 20+ noisy prompts.
const TAG_RULES = [
  ['milf', /(^|[^a-z])milf/],
  ['step fantasy', /step/i],
  ['teen', /1[89].?yo|(^|[^a-z])teen/],
  ['big tits', /(big|huge|large|massive)[\s-]*(tit|boob|breast)|busty/],
  ['amateur', /amateur/],
  ['homemade', /home.?made|home.?video|sex.?tape/],
  ['girlfriend', /girl.?friend|(^|[^a-z])gf([^a-z]|$)/],
  ['couple', /(^|[^a-z])couple/],
  ['webcam', /webcam|(^|[^a-z])cam(s|ming)?([^a-z]|$)/],
  ['solo', /(^|[^a-z])solo/],
  ['masturbation', /masturbat|fingering|rubbing/],
  ['blowjob', /blow.?job|deep.?throat|(^|[^a-z])bj([^a-z]|$)|sucking|swallow|mouth/],
  ['handjob', /hand.?job/],
  ['anal', /(^|[^a-z])anal/],
  ['creampie', /creampie|cum.?in|internal|cum.?inside/],
  ['cumshot', /cumming|ejaculat|cumshot|load/],
  ['lesbian', /lesbian|tribb|girl.?on.?girl/],
  ['pov', /(^|[^a-z])pov/],
  ['threesome', /threesome|three.?some/],
  ['gangbang', /gang.?bang|\d+[\s-]*(men|guys)/],
  ['interracial', /interracial|\bbbc\b|big.?black/],
  ['bbc', /\bbbc\b/],
  ['asian', /(^|[^a-z])asian/],
  ['japanese', /japan|jav/i],
  ['chinese', /chinese|domestic.?av/],
  ['korean', /korean/],
  ['taiwanese', /taiwan/],
  ['pinay', /pinay/],
  ['brunette', /brunette/],
  ['blonde', /blonde|(^|[^a-z])blond/],
  ['redhead', /red.?head|red.?hair/],
  ['big ass', /(big|fat|huge|thick)[\s-]*(ass|booty)|pawg/],
  ['bbw', /\bbbw\b/],
  ['petite', /petite/],
  ['hairy', /hairy/],
  ['tattoo', /tattoo/],
  ['pregnant', /pregnan/],
  ['wife', /(^|[^a-z])wife|wives/],
  ['cheating', /cheat/],
  ['stepmom', /step.?mom|step.?mother/],
  ['stepdaughter', /step.?daughter/],
  ['stepsister', /step.?sister/],
  ['neighbor', /neighbor|neighbour|next.?door/],
  ['office', /(^|[^a-z])office/],
  ['public', /(^|[^a-z])public/],
  ['school', /school.?girl|(^|[^a-z])student|uniform/],
  ['casting', /casting|audition/],
  ['striptease', /(^|[^a-z])strip/],
  ['latina', /latina|latino|\blatin\b|mexican|colombian|brazilian|cuban|vietnamese/],
  ['spanish', /spanish/],
  ['massage', /massage/],
  ['fetish', /fetish/],
  ['compilation', /compilation/],
  ['czech', /czech/],
  ['european', /european|german|french|italian/],
  ['gothic', /goth/],
  ['big cock', /big.?cock|huge.?cock|big.?dick|mandingo|charles.?dera/],
  ['squirt', /squirt/]
];

const TAG_PAD_STOP = new Set(['video', 'videos', 'watch', 'porn', 'xxx', 'sex', 'pussy', 'fuck', 'fucking', 'cock', 'dick', 'cum', 'hot', 'sexy', 'girl', 'girls', 'amateurs', 'movie', 'movies', 'scenes', 'scene', 'nude', 'naked']);

function detectTags(slug) {
  const s = String(slug || '').toLowerCase();
  const tags = [];
  for (const [tag, rx] of TAG_RULES) {
    if (rx.test(s) && !tags.includes(tag)) tags.push(tag);
  }
  if (tags.length >= 8) return tags.slice(0, 8);
  const toks = tokenize(s);
  for (const t of toks) {
    if (tags.length >= 8) break;
    if (isJunk(t)) continue;
    if (TAG_PAD_STOP.has(t)) continue;
    if (STOP_WORDS.has(t)) continue;
    if (tags.includes(t)) continue;
    if (t.length < 3 || t.length > 14) continue;
    tags.push(t);
  }
  return tags.slice(0, 8);
}

// Curated featured strip (top-of-homepage). Ids are verified against the live
// catalog at boot; unknown ids are simply ignored.
let featuredIds = new Set();
function loadFeatured(ids) {
  featuredIds = new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean));
}
function isFeatured(id) { return featuredIds.has(String(id)); }

// Apply enrichment in-place to a video record. Only external (snapshot) videos
// are touched so curated local entries are never clobbered.
function apply(v) {
  if (!v || !v.id) return;
  const isExternal = !!(v.external || v.source || (v.sourceUrl && !v.filePath));
  const genericTitle = /^Super X Latina Video \d+$/i.test(v.title || '');
  if (!isExternal && !genericTitle) return;
  const title = slugToTitle(v.id);
  if (title) v.title = title;
  if (!v.category || /^general$/i.test(v.category)) v.category = detectCategory(v.id);
  if (!v.tags || !v.tags.length) v.tags = detectTags(v.id);
  v.featured = isFeatured(v.id);
}

module.exports = { slugToTitle, detectCategory, detectTags, loadFeatured, isFeatured, apply };