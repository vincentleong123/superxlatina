/* Batch-generate tiny hover-preview clips for every video in data/videos.json.
   Cuts 12s..20s of the original at 360p into a faststart MP4 (~50-150KB each),
   so the gallery/player preview engine can fetch a whole file in one hit
   instead of a multi-MB range chunk. Idempotent: skips existing outputs.
   Usage: node generate-previews.js */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DATA_DIR = path.join(__dirname, 'data');
const OUT_DIR = 'C:/Users/User/Desktop/hentai_previews';
const VIDEO_ROOT = 'C:/Users/User/Desktop/hentai_videos';
const PREVIEW_START = 12;  // seconds into the original (matches getPreviewTime)
const PREVIEW_LEN = 8;     // seconds of clip

if (!fs.existsSync(DATA_DIR)) { console.error('data/ not found'); process.exit(1); }
fs.mkdirSync(OUT_DIR, { recursive: true });

const videos = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'videos.json'), 'utf8'));
let ok = 0, skip = 0, fail = 0;

for (const v of videos) {
  const src = (v.filePath || path.join(VIDEO_ROOT, v.id + '.mp4')).replace(/\\/g, '/');
  const out = path.join(OUT_DIR, v.id + '.mp4');
  if (fs.existsSync(out) && fs.statSync(out).size > 0) { skip++; continue; }
  if (!fs.existsSync(src)) { console.log('MISSING ' + src); fail++; continue; }
  try {
    execFileSync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-ss', String(PREVIEW_START), '-i', src,
      '-t', String(PREVIEW_LEN), '-an',
      '-vf', 'scale=-2:360',
      '-c:v', 'libx264', '-crf', '30', '-preset', 'veryfast',
      '-movflags', '+faststart', out
    ], { stdio: 'ignore' });
    const kb = Math.round(fs.statSync(out).size / 1024);
    console.log('OK ' + v.id + ' (' + kb + 'KB)');
    ok++;
  } catch (e) {
    console.log('FAIL ' + v.id);
    fail++;
  }
}
console.log('done: ' + ok + ' generated, ' + skip + ' skipped, ' + fail + ' failed');
