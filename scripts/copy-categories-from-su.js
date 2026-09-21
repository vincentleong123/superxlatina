#!/usr/bin/env node
/**
 * copy-categories-from-su.js
 *
 * Copies the category assignments from Project A (su/data/video-index.json)
 * into Project B (data/videos.json). Both projects point at the same video
 * IDs, but A uses a balanced 8-niche system (Uncensored, Ahegao, Futanari,
 * NTR, Yuri, Trap, Tentacle, 3D) while B uses broader categories.
 *
 * This script:
 *   - Normalises IDs (case-insensitive, underscore/hyphen tolerant)
 *   - Copies `category` from A → B for every matched video
 *   - Preserves all other B fields (title, views, tags, descriptions, etc.)
 *   - Leaves B-only videos unchanged
 *
 * Usage: node scripts/copy-categories-from-su.js
 */
const fs = require('fs');
const path = require('path');

const A_PATH = 'C:/Users/User/Desktop/su/data/video-index.json';
const B_PATH = path.join(__dirname, '..', 'data', 'videos.json');
const CATEGORIES_PATH = path.join(__dirname, '..', 'data', 'categories.json');

// ── Helpers ────────────────────────────────────────────────────────────────
function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function normalise(id) {
  return String(id).toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// ── Load ───────────────────────────────────────────────────────────────────
const aVideos = readJSON(A_PATH);
const bVideos = readJSON(B_PATH);
const categories = readJSON(CATEGORIES_PATH);

const validCategories = new Set(Object.values(categories).map(c => c.display));

console.log(`\n  Project A: ${aVideos.length} videos`);
console.log(`  Project B: ${bVideos.length} videos`);

// Build A lookup: normalised ID → category
const aCategoryMap = new Map();
for (const v of aVideos) {
  const key = normalise(v.id);
  if (!validCategories.has(v.category)) {
    console.warn(`  ⚠  A has unknown category "${v.category}" for "${v.id}" — skipped`);
    continue;
  }
  // Only overwrite if we haven't set it yet, or if this one is not "General"
  if (!aCategoryMap.has(key) || v.category !== 'General') {
    aCategoryMap.set(key, v.category);
  }
}

// ── Apply categories ──────────────────────────────────────────────────────
let changed = 0;
let unchanged = 0;
let skipped = 0;
const tally = {};
const aOwnTally = {};

for (const v of aVideos) {
  const c = v.category || 'General';
  aOwnTally[c] = (aOwnTally[c] || 0) + 1;
}

for (const v of bVideos) {
  const key = normalise(v.id);
  const aCat = aCategoryMap.get(key);

  if (aCat && v.category !== aCat) {
    const prev = v.category || 'General';
    v.category = aCat;
    changed++;
  } else {
    unchanged++;
  }

  const c = v.category || 'General';
  tally[c] = (tally[c] || 0) + 1;

  if (!aCat) {
    skipped++;
    console.log(`  ⚠  B-only video: "${v.id}" (stays "${v.category}")`);
  }
}

// ── Write ──────────────────────────────────────────────────────────────────
fs.writeFileSync(B_PATH, JSON.stringify(bVideos, null, 2));

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n  ✅ Applied category from Project A to ${changed} videos`);
console.log(`     ${unchanged} already matched, ${skipped} B-only (kept as-is)\n`);

console.log('  ────────────────────────────────────────────');
console.log('  Category             A-count    B-now');
console.log('  ────────────────────────────────────────────');
const allCats = new Set([...Object.keys(aOwnTally), ...Object.keys(tally)]);
for (const cat of [...allCats].sort()) {
  const ac = aOwnTally[cat] || 0;
  const bc = tally[cat] || 0;
  if (ac || bc) {
    console.log(`  ${cat.padEnd(20)} ${String(ac).padStart(5)}    ${String(bc).padStart(5)}`);
  }
}
console.log('  ────────────────────────────────────────────\n');
console.log('  Done.');

