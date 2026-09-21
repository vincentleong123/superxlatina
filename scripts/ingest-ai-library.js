// scripts/ingest-ai-library.js
// Ingests the AI/hentai video library from E:\xxaiporn_grab into superxhentai.
//
//   node scripts/ingest-ai-library.js           # dry-run report (no writes)
//   node scripts/ingest-ai-library.js --run     # copy files, thumbs, durations, write videos.json
//   node scripts/ingest-ai-library.js --thumb-only   # (re)generate missing thumbnails only
//   node scripts/ingest-ai-library.js --json-only    # build video entries only (files already staged)
//
// Classification:
//   - EXCLUDE real-person JAV titles (actress names + "JAV" marker) — never host
//     real-person content on the AI/hentai site.
//   - DEDUPE by normalized title (same clip scraped from multiple mirror domains);
//     keep the largest copy.
const fs = require('fs');
const path = require('path');
const { execFileSync, execFile } = require('child_process');

const GRAB_DIR = 'E:/xxaiporn_grab';
const MANIFEST = path.join(GRAB_DIR, 'manifest.json');
const STAGE_DIR = 'E:/superxhentai_ai';
const THUMB_DIR = 'C:/thumbnails';
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

// Real-person JAV actresses present in this library. "Ai X" here is a person's
// name, not the AI-content marker.
const JAV_ACTORS = [
  'ai uehara', 'ai sayama', 'ai wakana', 'ai mizushima', 'ai ootomo',
  'ai okada', 'ai mukai', 'ai qiu', 'ai xi', 'naosima', 'yumi kazama',
  'ai hoshina', 'ai yuumi', 'modelmedia', 'ai himeno', 'ai shirosakia',
  'seto himari', 'ai yuzuki', 'ai nishimura'
];

// Promotional/spam fragments to strip from titles.
const PROMO_PATTERNS = [
  /\s*[-|~]\s*ln\.run\s+\S+/gi,
  /\s*fhrdr\.com\s+go\s+\S+/gi,
  /\s*[-|–]\s*More at\s+[^\[]+/gi,
  /\s*Visit(?:\s+the)?\s+["']?[^"'.\]]*channel[^"'.\]]*["']?/gi,
  /\s*-?\s*(?:Best|Original|greatest)?\s*JAV[^|]*$/gi,
  /\s*-?\s*(?:uncensored\s+)?JAV\s+porn\s+at\s+its\s+best!?$/gi,
  /\s+watch\s+now\s+/gi,
  /\s+\?\?+/g,
];

function slugify(title) {
  const s = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 76);
  return s || 'ai-video-' + Math.floor(Math.random() * 1e6);
}

function cleanTitle(raw) {
  let t = String(raw || '').replace(/[<>]/g, '').replace(/[`\u0000-\u001f\u007f]/g, '');
  PROMO_PATTERNS.forEach(re => { t = t.replace(re, ' '); });
  t = t.replace(/\s{2,}/g, ' ').replace(/\s+([,;:!?.)])/g, '$1').trim();
  t = t.replace(/^[^A-Za-z0-9\[\]\(]+/, '').trim();
  return t || String(raw || '').trim();
}

function normalizeTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[\[\](){}"]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isJAVTitle(title) {
  const t = title.toLowerCase();
  if (/\bjav\b/.test(t)) return true;
  return JAV_ACTORS.some(a => t.includes(a));
}

function loadManifest() {
  const raw = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  return Object.values(raw);
}

function pickBest(entries) {
  return entries.reduce((best, e) => (e.size >= best.size ? e : best), entries[0]);
}

function analyze() {
  const all = loadManifest().filter(e => e.status === 'ok' && fs.existsSync(e.file));
  const jav = [];
  const kept = [];
  for (const e of all) {
    if (isJAVTitle(e.title)) jav.push(e);
    else kept.push(e);
  }
  const groups = new Map();
  for (const e of kept) {
    const key = normalizeTitle(e.title);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const deduped = [];
  let removed = 0;
  for (const [key, list] of groups) {
    if (list.length > 1) removed += list.length - 1;
    deduped.push(pickBest(list));
  }
  return { all, jav, kept, deduped, removedDupes: removed, groups };
}

function totalSize(entries) {
  return entries.reduce((s, e) => s + (e.size || 0), 0);
}

function report(r) {
  const gb = s => (s / 1e9).toFixed(2) + ' GB';
  console.log('=== AI LIBRARY INGEST REPORT ===');
  console.log(`ok files present : ${r.all.length}`);
  console.log(`excluded (JAV)  : ${r.jav.length}  (${gb(totalSize(r.jav))})`);
  console.log(`after exclude   : ${r.kept.length}`);
  console.log(`dedup removed   : ${r.removedDupes}`);
  console.log(`FINAL to ingest : ${r.deduped.length}  (${gb(totalSize(r.deduped))})`);
  console.log('\n-- excluded titles --');
  const seen = new Set();
  for (const e of r.jav) {
    const k = normalizeTitle(e.title);
    if (seen.has(k)) continue;
    seen.add(k);
    console.log(`  x ${e.title}`);
  }
  console.log('\n-- kept (first 30) --');
  r.deduped.slice(0, 30).forEach(e => console.log(`  + ${e.title}`));
  console.log(`  ... ${Math.max(0, r.deduped.length - 30)} more`);
  // write working plan for --run
  fs.writeFileSync(path.join(ROOT, 'data', 'ai-ingest-plan.json'), JSON.stringify({
    jav: r.jav.map(e => ({ title: e.title, file: e.file })),
    kept: r.deduped.map(e => ({ title: cleanTitle(e.title), file: e.file, size: e.size }))
  }, null, 2));
  console.log('\nplan written to data/ai-ingest-plan.json');
}

function getDuration(filePath) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { timeout: 15000, encoding: 'utf8' });
    const secs = parseFloat(out.trim());
    if (isNaN(secs)) return '0:30';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  } catch {
    return '0:30';
  }
}

function renderThumb(filePath, outFile) {
  // Single frame near ~22% duration, 640w, mild enhance. Fast + good enough.
  execFileSync('ffmpeg', [
    '-loglevel', 'error', '-ss', '22%', '-i', filePath,
    '-frames:v', '1', '-vf', 'scale=640:-2,unsharp=5:5:0.5,eq=brightness=0.03:saturation=1.15:contrast=1.05',
    '-q:v', '2', '-y', outFile
  ], { timeout: 45000, stdio: 'ignore' });
}

function runThumbs(files, concurrency) {
  const pending = [...files];
  let done = 0;
  let failed = 0;
  return new Promise((resolve) => {
    const worker = () => {
      if (!pending.length) return resolve();
      const { id, file } = pending.shift();
      const outFile = path.join(THUMB_DIR, id + '.jpg');
      if (fs.existsSync(outFile)) {
        done++;
        process.stdout.write(`\rthumbs ${done}/${files.length}`);
        return worker();
      }
      try {
        renderThumb(file, outFile);
        done++;
      } catch {
        failed++;
      }
      process.stdout.write(`\rthumbs ${done}/${files.length} (${failed} fail)`);
      worker();
    };
    for (let i = 0; i < concurrency; i++) worker();
  }).then(() => {
    process.stdout.write('\n');
    return { done, failed };
  });
}

async function runDurations(plan) {
  const out = [];
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    p.duration = getDuration(p.stagedFile);
    out.push(p);
    if ((i + 1) % 50 === 0) console.log(`durations ${i + 1}/${plan.length}`);
  }
  return out;
}

function buildEntries(plan) {
  const { generateFullDescription } = require('../utils/desc-writer');
  const entries = [];
  for (const p of plan) {
    const id = p.id || 'ai-' + slugify(p.title);
    const title = p.title.slice(0, 100);
    const tags = [p.category || 'AI', 'hentai', 'ai-generated', ...p.extraTags].filter(Boolean).slice(0, 8);
    const desc = generateFullDescription({ id, title, category: 'AI', tags, duration: p.duration });
    entries.push({
      id,
      title,
      video: '/ai/' + path.basename(p.stagedFile),
      filePath: p.stagedFile.replace(/\\/g, '/'),
      thumbnail: '/thumbnails/' + id + '.jpg',
      views: 0,
      duration: p.duration,
      uploaded: p.uploaded,
      category: 'AI',
      tags,
      description: desc.description,
      featured: false
    });
  }
  return entries;
}

function uniqueIds(plan) {
  const used = new Set();
  for (const p of plan) {
    let id = 'ai-' + slugify(p.title);
    if (used.has(id)) {
      let n = 2;
      while (used.has(id + '-' + n)) n++;
      id = id + '-' + n;
    }
    used.add(id);
    p.id = id;
  }
  return plan;
}

async function stageFiles(plan) {
  if (!fs.existsSync(STAGE_DIR)) fs.mkdirSync(STAGE_DIR, { recursive: true });
  plan = uniqueIds(plan);
  let done = 0;
  for (const p of plan) {
    const target = path.join(STAGE_DIR, p.id + '.mp4');
    p.stagedFile = target;
    if (!fs.existsSync(target)) {
      fs.copyFileSync(p.file, target);
    }
    done++;
    if (done % 50 === 0) console.log(`staged ${done}/${plan.length}`);
  }
  return plan;
}

const mode = process.argv.includes('--run')
  ? 'run'
  : process.argv.includes('--thumb-only')
    ? 'thumb'
    : process.argv.includes('--json-only')
      ? 'json'
      : 'report';

(async () => {
  const r = analyze();
  if (mode === 'report') {
    report(r);
    return;
  }
  const planPath = path.join(DATA_DIR, 'ai-ingest-plan.json');
  let plan = JSON.parse(fs.readFileSync(planPath, 'utf8')).kept.map(p => ({
    title: p.title, file: p.file, size: p.size
  }));

  if (mode === 'run') {
    console.log('staging files...');
    plan = await stageFiles(plan);
    console.log('thumbnails...');
    await runThumbs(plan.map(p => ({ id: p.id, file: p.stagedFile })), 4);
    console.log('durations...');
    plan = await runDurations(plan);
  } else if (mode === 'thumb') {
    console.log('(re)generating thumbnails for staged files...');
    plan = uniqueIds(plan.map(p => ({ ...p, stagedFile: path.join(STAGE_DIR, 'ai-' + slugify(p.title) + '.mp4') })));
    await runThumbs(plan.map(p => ({ id: p.id, file: p.stagedFile })), 4);
    return;
  } else if (mode === 'json') {
    console.log('rebuilding entries from staged files (no thumb/duration gen)...');
    plan = uniqueIds(plan.map(p => ({
      ...p,
      stagedFile: path.join(STAGE_DIR, 'ai-' + slugify(p.title) + '.mp4'),
      duration: getDuration(path.join(STAGE_DIR, 'ai-' + slugify(p.title) + '.mp4'))
    })));
  }

  // extraTags from cleaned title keywords
  for (const p of plan) {
    const words = p.title.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
    const skip = new Set(['hentai', 'ai', 'the', 'and', 'with', 'for', 'xxx', 'sex', 'porn', 'video', 'videos', 'watch', 'free', 'hd', '3d']);
    p.extraTags = [...new Set(words.filter(w => !skip.has(w) && !['animation', 'animated', 'generated'].includes(w)))].slice(0, 5);
    p.category = 'AI';
    p.uploaded = new Date().toISOString();
  }

  const entries = buildEntries(plan);
  const videosPath = path.join(DATA_DIR, 'videos.json');
  const descPath = path.join(DATA_DIR, 'descriptions.json');
  const existing = JSON.parse(fs.readFileSync(videosPath, 'utf8'));
  const existingIds = new Set(existing.map(v => v.id));
  const fresh = entries.filter(v => !existingIds.has(v.id));
  const merged = existing.concat(fresh);
  fs.writeFileSync(videosPath, JSON.stringify(merged, null, 2));

  let descriptions = {};
  if (fs.existsSync(descPath)) descriptions = JSON.parse(fs.readFileSync(descPath, 'utf8'));
  for (const v of fresh) {
    descriptions[v.id] = {
      description: v.description,
      keywords: v.tags,
      generated: true,
      lastUpdated: new Date().toISOString()
    };
  }
  fs.writeFileSync(descPath, JSON.stringify(descriptions, null, 2));

  console.log(`\nDONE. existing=${existing.length} new=${fresh.length} total=${merged.length}`);
  fs.writeFileSync(path.join(DATA_DIR, 'ai-ingest-report.json'), JSON.stringify({
    date: new Date().toISOString(),
    total: merged.length,
    added: fresh.length,
    duplicatesSkipped: entries.length - fresh.length
  }, null, 2));
})();
