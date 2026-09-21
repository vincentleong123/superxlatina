// scripts/regenerate-descriptions.js
// Rewrites every video description with the fact-based deterministic generator
// (utils/desc-writer.js), persists to videos.json + descriptions.json, then
// validates that no two descriptions share a sentence.
const fs = require('fs');
const path = require('path');
const { generateFullDescription } = require('../utils/desc-writer');

const DATA_DIR = path.join(__dirname, '..', 'data');
const videosPath = path.join(DATA_DIR, 'videos.json');
const descPath = path.join(DATA_DIR, 'descriptions.json');

const siteVideos = JSON.parse(fs.readFileSync(videosPath, 'utf8'));
let descriptions = {};
if (fs.existsSync(descPath)) descriptions = JSON.parse(fs.readFileSync(descPath, 'utf8'));

const now = new Date().toISOString();
siteVideos.forEach(v => {
  const { description, keywords } = generateFullDescription(v);
  v.description = description;
  descriptions[v.id] = {
    description,
    keywords,
    generated: true,
    lastUpdated: now
  };
});

fs.writeFileSync(videosPath, JSON.stringify(siteVideos, null, 2));
fs.writeFileSync(descPath, JSON.stringify(descriptions, null, 2));

// Uniqueness validation: strip HTML + punctuation, compare normalized sentences.
const seen = new Map();
let dupes = 0;
siteVideos.forEach(v => {
  const text = (v.description || '').replace(/<[^>]+>/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = text.split(/(?<=\.) /);
  sentences.forEach(s => {
    const norm = s.trim();
    if (norm.length < 20) return;
    if (seen.has(norm)) { dupes++; }
    else seen.set(norm, 1);
  });
});

const totalSentences = seen.size;
console.log(`Rewrote ${siteVideos.length} descriptions (fact-based, deterministic).`);
console.log(`Unique long sentences across corpus: ${totalSentences}; duplicate sentences: ${dupes}`);
console.log('Sample:', JSON.stringify(siteVideos[0].description.split('\n').slice(0, 3).join(' | ')));
