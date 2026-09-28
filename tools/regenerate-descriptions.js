// Regenerate data/descriptions.json for the live external catalog using the
// SEO-enriched metadata (real slug-derived titles, category, tags). The old
// file was generated when every video was titled "Super X Latina Video NNNN",
// so all 510 descriptions shared the same boilerplate — exactly the kind of
// near-duplicate thin content that drags a site down.
//
// Usage: node tools/regenerate-descriptions.js

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const EXTERNAL_FILE = path.join(DATA_DIR, 'video-index-external.json');
const OUT_FILE = path.join(DATA_DIR, 'descriptions.json');
const enrich = require('../utils/seo-enrich');

if (!fs.existsSync(EXTERNAL_FILE)) {
  console.error('No external snapshot at ' + EXTERNAL_FILE);
  process.exit(1);
}

const videos = JSON.parse(fs.readFileSync(EXTERNAL_FILE, 'utf8'));
const out = {};

videos.forEach((v) => {
  const title = enrich.slugToTitle(v.id) || v.title || v.id;
  const category = enrich.detectCategory(v.id);
  const tags = enrich.detectTags(v.id).slice(0, 6);
  const dur = v.duration || '';
  const tagLine = tags.length
    ? tags.map(t => t.toLowerCase()).join(', ')
    : 'amateur latina';

  // First ~160 chars (what Google uses for the meta description) are unique and
  // keyword-rich on every page.
  const blocks = [];
  blocks.push(`<h2>${escapeHtml(title)}</h2>`);
  blocks.push(`<p>Watch ${escapeHtml(title)} — a ${dur ? dur + ' ' : ''}${category} scene in HD on Super X Latina. This latina video streams instantly with no sign-up, no paywall and no registration required.</p>`);
  blocks.push(`<p>${escapeHtml(title)} is ${category} content featuring ${escapeHtml(tagLine)}. It is part of our curated ${category} collection alongside the rest of the free latina video library on Super X Latina.</p>`);
  blocks.push(`<p>If you enjoy ${escapeHtml(category.toLowerCase().replace(/latina/i, 'latina').trim())} clips, check out the related videos below the player and use the tag links to explore more free HD latina scenes.</p>`);
  blocks.push(`<p style="font-size:13px;color:#9ca3af">Keywords: ${escapeHtml(category.toLowerCase())}, ${escapeHtml(tagLine)}, latina video, latina, HD</p>`);

  out[v.id] = {
    description: blocks.join('\n'),
    keywords: [category.toLowerCase(), ...tags.map(t => t.toLowerCase()), 'latina', 'HD'],
    generated: true,
    lastUpdated: new Date().toISOString()
  };
});

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
console.log(`Regenerated ${Object.keys(out).length} descriptions → ${OUT_FILE}`);