#!/usr/bin/env node
/**
 * categorize.js
 * Assigns a single category to every video in data/videos.json using a small
 * keyword-rule engine. Rules are evaluated top-to-bottom; the first match wins.
 * Only the `category` field is modified — all other video data is preserved.
 *
 * Usage:  node scripts/categorize.js
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const VIDEOS_FILE = path.join(DATA_DIR, 'videos.json');
const CATEGORIES_FILE = path.join(DATA_DIR, 'categories.json');

// ── Category rules (ordered by priority — first match wins) ───────────────
const RULES = [
  { category: 'Futanari',    match: ['futanari', 'futa'] },
  { category: 'Yuri',        match: ['yuri', 'lesbian', 'lesbians'] },
  { category: 'NTR',         match: ['ntr', 'netorare', 'affair', 'cuckold'] },
  { category: 'Trap',        match: ['trap', 'crossdress'] },
  { category: 'Tentacle',    match: ['tentacle'] },
  { category: 'Ahegao',      match: ['ahegao'] },
  { category: 'Uncensored',  match: ['uncensored', 'nomosaic'] },
  { category: 'Game Parody', match: [
      'overwatch', 'genshin', 'honkai', 'league', 'finalfantasy', 'tifa',
      'lara', 'deadoralive', 'senrankagura', 'katsuragi', 'mugen', 'nutaku',
      'doom', 'akali', 'kasumi', 'honoka', 'hatsumi', 'keqing', 'citlali',
      'shenhe', 'tomboy', 'sims', 'game', 'juego', 'resident'
    ] },
  { category: 'Anime Parody', match: [
      'naruto', 'onepiece', 'sanji', 'dbz', 'bulma', 'marvel', 'raven',
      'hololive', 'vtuber', 'sarada', 'takagi', 'ino', 'louise', 'manga',
      'kaiju', 'miyuki'
    ] },
  { category: 'MILF',        match: ['milf', 'milfycity', 'madrasta'] },
  { category: 'Fantasy',     match: ['elf', 'witch', 'vampire', 'magical', 'succubus', 'slime', 'demon'] },
  { category: '3D',          match: ['3d', 'cg', 'ai', 'animation'] },
  { category: 'General',     match: [] } // fallback — always matches last
];

// ── Helpers ────────────────────────────────────────────────────────────────
function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`✖ Could not read ${file}: ${err.message}`);
    process.exit(1);
  }
}

function tokenize(text) {
  return String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function categorize(id) {
  const tokens = new Set(tokenize(id));
  for (const rule of RULES) {
    if (rule.match.some(keyword => tokens.has(keyword))) return rule.category;
  }
  return 'General';
}

// ── Main ───────────────────────────────────────────────────────────────────
function main() {
  const videos = readJSON(VIDEOS_FILE);
  const categories = readJSON(CATEGORIES_FILE);
  const validCategories = new Set(Object.values(categories).map(c => c.display));

  let changed = 0;
  const tally = {};

  for (const video of videos) {
    const previous = video.category;
    const next = categorize(video.id);

    if (!validCategories.has(next)) {
      console.warn(`⚠ Skipping unknown category "${next}" (id: ${video.id})`);
      continue;
    }

    video.category = next;
    tally[next] = (tally[next] || 0) + 1;
    if (previous !== next) changed++;
  }

  fs.writeFileSync(VIDEOS_FILE, JSON.stringify(videos, null, 2));

  const total = videos.length;
  const grouped = Object.entries(tally).sort((a, b) => b[1] - a[1]);

  console.log(`\n✅ Categorized ${total} videos (${changed} changed)\n`);
  for (const [cat, count] of grouped) {
    const pct = Math.round((count / total) * 100).toString().padStart(3);
    const bar = '█'.repeat(Math.round((count / total) * 28));
    console.log(`  ${pct}%  ${cat.padEnd(15)} ${String(count).padStart(3)}  ${bar}`);
  }
  console.log('');
}

main();

