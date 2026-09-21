const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv', '.flv', '.m4v'];

function scanFolder(folderPath) {
  const results = [];
  if (!fs.existsSync(folderPath)) return results;

  const items = fs.readdirSync(folderPath, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path.join(folderPath, item.name);
    if (item.isDirectory()) {
      if (!item.name.startsWith('.')) {
        results.push(...scanFolder(fullPath));
      }
    } else if (item.isFile()) {
      const ext = path.extname(item.name).toLowerCase();
      if (VIDEO_EXTS.includes(ext)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function getVideoId(filePath) {
  const name = path.basename(filePath, path.extname(filePath));
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 80) || 'video-' + Date.now();
}

function titleFromFilename(filePath) {
  const name = path.basename(filePath, path.extname(filePath));
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\.(mp4|mov|avi|mkv|webm)$/i, '')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase())
    .substring(0, 100) || 'Untitled Video';
}

function getVideoDuration(filePath) {
  try {
    const output = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`,
      { timeout: 10000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
    );
    const seconds = parseFloat(output.trim());
    if (isNaN(seconds)) return '0:30';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  } catch {
    return '0:30';
  }
}

function getFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function findExistingThumb(thumbnailPath, videoId) {
  if (!fs.existsSync(thumbnailPath)) return null;
  const base = videoId.toLowerCase();
  try {
    for (const file of fs.readdirSync(thumbnailPath)) {
      const lower = file.toLowerCase();
      const stem = lower.replace(/\.(jpg|jpeg|webp)$/, '');
      if (stem === base) return '/thumbnails/' + file;
    }
  } catch (e) {}
  return null;
}

function getDurationSeconds(filePath) {
  try {
    const output = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}" 2>&1`,
      { timeout: 10000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
    );
    const seconds = parseFloat(output.trim());
    return isNaN(seconds) ? 0 : seconds;
  } catch {
    return 0;
  }
}

function formatTs(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Score a candidate frame by luma brightness (reject black/white), contrast
// and colorfulness so we skip intros, black screens and credits.
function getFrameScore(videoPath, t) {
  try {
    const output = execSync(
      `ffmpeg -loglevel error -ss ${t} -i "${videoPath}" -frames:v 1 -vf "scale=160:-1,signalstats,metadata=print:file=-" -f null - 2>&1`,
      { timeout: 20000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
    );
    const yavg = parseFloat((output.match(/YAVG=([\d.]+)/) || [])[1]);
    if (isNaN(yavg)) return null;
    const ymax = parseFloat((output.match(/YMAX=([\d.]+)/) || [])[1]) || 0;
    const ymin = parseFloat((output.match(/YMIN=([\d.]+)/) || [])[1]) || 0;
    const satavg = parseFloat((output.match(/SATAVG=([\d.]+)/) || [])[1]) || 0;
    let score = 100 - Math.abs(yavg - 140);
    score += (Math.min(ymax - ymin, 255) / 255) * 25;
    score += (satavg / 255) * 15;
    return score;
  } catch {
    return null;
  }
}

function renderThumb(videoPath, t, outFile) {
  execSync(
    `ffmpeg -loglevel error -ss ${t} -i "${videoPath}" -frames:v 1 -vf "scale=640:-2,unsharp=5:5:0.5,eq=brightness=0.03:saturation=1.15:contrast=1.05" -q:v 2 -y "${outFile}" 2>&1`,
    { timeout: 30000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
  );
}

function thumbLuma(outFile) {
  try {
    const output = execSync(
      `ffmpeg -loglevel error -i "${outFile}" -vf "signalstats,metadata=print:file=-" -f null - 2>&1`,
      { timeout: 15000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
    );
    return parseFloat((output.match(/YAVG=([\d.]+)/) || [])[1]);
  } catch {
    return 0;
  }
}

function smartThumbnail(videoPath, videoId, thumbnailPath) {
  try {
    if (!fs.existsSync(thumbnailPath)) {
      fs.mkdirSync(thumbnailPath, { recursive: true });
    }
    const existing = findExistingThumb(thumbnailPath, videoId);
    const outName = existing ? existing.replace('/thumbnails/', '') : videoId + '.jpg';
    const outFile = path.join(thumbnailPath, outName);

    const dur = getDurationSeconds(videoPath);
    const fractions = dur > 15 ? [0.08, 0.16, 0.25, 0.33, 0.42, 0.50, 0.58, 0.66, 0.75, 0.83] : [0.15, 0.35, 0.55];
    const scored = [];
    for (const frac of fractions) {
      const t = formatTs(Math.max(dur * frac, 1));
      const s = getFrameScore(videoPath, t);
      if (s !== null) scored.push({ t, s });
    }
    scored.sort((a, b) => b.s - a.s);
    if (!scored.length) scored.push({ t: dur > 15 ? formatTs(dur * 0.25) : '00:00:01', s: 0 });

    let brightest = null; // { t, luma }
    for (const cand of scored) {
      renderThumb(videoPath, cand.t, outFile);
      const luma = thumbLuma(outFile);
      if (!isNaN(luma) && (!brightest || luma > brightest.luma)) {
        brightest = { t: cand.t, luma };
      }
      if (luma >= 28 && luma <= 230) return '/thumbnails/' + outName;
    }
    // Video is dark/bright throughout → keep the brightest rendered frame.
    if (brightest) renderThumb(videoPath, brightest.t, outFile);
    return '/thumbnails/' + outName;
  } catch {
    return '';
  }
}

function generateThumbnail(videoPath, thumbnailPath, videoId) {
  const existing = findExistingThumb(thumbnailPath, videoId);
  if (existing) return existing;
  return smartThumbnail(videoPath, videoId, thumbnailPath);
}

function loadExistingIndex(indexPath) {
  if (!fs.existsSync(indexPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch {
    return [];
  }
}

function categorizeByFilename(name) {
  const lower = name.toLowerCase();
  if (/\b(uncensored|no-censor|raw)\b/.test(lower)) return 'General';
  if (/\b(censored|censor)\b/.test(lower)) return 'Censored';
  if (/\b(3d|cg)\b/.test(lower)) return '3D';
  if (/\b(cosplay|costume)\b/.test(lower)) return 'Cosplay';
  if (/\b(ai|animated|animation)\b/.test(lower)) return 'AI';
  return 'General';
}

function extractTags(name, category) {
  const tags = new Set();
  const lower = name.toLowerCase();

  if (category && category !== 'General') tags.add(category.toLowerCase());

  const tagMap = {
    'homemade': ['homemade', 'latina', 'real'],
    'amateur': ['amateur', 'latina', 'raw'],
    'solo': ['solo', 'latina', 'cam'],
    'latina milf': ['milf', 'latina', 'mature'],
    'latina college': ['college', 'latina', 'party'],
    'public outdoor': ['public', 'outdoor', 'latina'],
    'latina threesome': ['threesome', 'latina', 'mfm'],
    'brazilian': ['brazilian', 'latina', 'rio'],
    'colombian': ['colombian', 'latina', 'medellin']
  };

  if (tagMap[category.toLowerCase()]) {
    tagMap[category.toLowerCase()].forEach(t => tags.add(t));
  }

  const commonWords = ['latina', 'hd', 'amateur', 'milf', 'threesome', 'blowjob', 'anal', 'public', 'solo', 'creampie', 'pov', 'webcam'];
  commonWords.forEach(w => {
    if (lower.includes(w)) tags.add(w);
  });

  return [...tags].slice(0, 8);
}

const nlpWriter = require('./nlp-writer');

function generateDescription(title, category) {
  return nlpWriter.generateFullDescription(title, category);
}

async function scanAndIndex(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const videoFolders = config.videoFolders || (config.videoFolder ? [config.videoFolder] : []);
  const thumbFolder = config.thumbnailsFolder;
  const indexPath = path.join(path.dirname(configPath), 'videos.json');
  const descPath = path.join(path.dirname(configPath), 'descriptions.json');

  const files = [];
  for (const folder of videoFolders) {
    if (fs.existsSync(folder)) {
      files.push(...scanFolder(folder));
    }
  }

  if (!files.length) {
    return { error: 'No video folders found', videos: [] };
  }
  const existing = loadExistingIndex(indexPath);
  const existingMap = new Map(existing.map(v => [v.filePath, v]));
  const existingDesc = loadExistingIndex(descPath);
  const descMap = new Map(Object.entries(existingDesc));

  const results = [];
  for (const filePath of files) {
    const normalizedPath = filePath.replace(/\\/g, '/');

    if (existingMap.has(normalizedPath)) {
      const existingVideo = existingMap.get(normalizedPath);
      existingVideo.views = (existingVideo.views || 0) + 0;
      results.push(existingVideo);
      continue;
    }

    const id = getVideoId(filePath);
    const dur = getVideoDuration(filePath);
    const title = titleFromFilename(filePath);
    const cat = categorizeByFilename(filePath);
    const baseTags = extractTags(filePath, cat);
    const thumb = generateThumbnail(filePath, thumbFolder, id);
    const stats = fs.statSync(filePath);
    const nlpResult = generateDescription(title, cat);
    const desc = nlpResult.description;
    const nlpKeywords = nlpResult.keywords || [];
    const allTags = [...new Set([...baseTags, ...nlpKeywords])].slice(0, 8);

    const videoEntry = {
      id,
      title,
      video: '/videos/' + path.basename(filePath),
      filePath: normalizedPath,
      thumbnail: thumb,
      views: 0,
      duration: dur,
      uploaded: stats.birthtime?.toISOString() || stats.mtime.toISOString(),
      category: cat,
      tags: allTags,
      description: desc,
      featured: false
    };

    descMap.set(id, {
      description: desc,
      keywords: nlpKeywords,
      generated: true,
      lastUpdated: new Date().toISOString()
    });

    results.push(videoEntry);
  }

  // Write videos.json
  fs.writeFileSync(indexPath, JSON.stringify(results, null, 2));

  // Write descriptions.json
  const descObj = {};
  for (const [key, val] of descMap) {
    descObj[key] = val;
  }
  fs.writeFileSync(descPath, JSON.stringify(descObj, null, 2));

  return {
    total: results.length,
    new: results.length - existing.length,
    videos: results
  };
}

module.exports = { scanAndIndex, scanFolder, getVideoDuration, getDurationSeconds, smartThumbnail, generateThumbnail };
