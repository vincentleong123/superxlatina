const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const videos = JSON.parse(fs.readFileSync('data/videos.json', 'utf8'));
const jobs = videos.map(v => ({ videoPath: v.filePath, id: v.id }));
const total = jobs.length;
const n = Math.min(4, os.cpus().length || 4);
const chunk = Math.ceil(total / n);
const children = [];

for (let i = 0; i < n; i++) {
  const slice = jobs.slice(i * chunk, (i + 1) * chunk);
  if (!slice.length) continue;
  const lf = path.join(os.tmpdir(), `regen-${process.pid}-${i}.json`);
  fs.writeFileSync(lf, JSON.stringify(slice));
  const child = spawn(process.execPath, ['regen-thumbs-worker.js', lf], { stdio: 'inherit' });
  child.on('exit', code => {
    console.log(`worker ${i} exit=${code}`);
    fs.unlinkSync(lf);
  });
  children.push(child);
}
console.log(`spawned ${children.length} workers for ${total} videos`);
