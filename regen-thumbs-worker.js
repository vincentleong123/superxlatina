const fs = require('fs');
const autoScan = require('./utils/auto-scan');

const listFile = process.argv[2];
const list = JSON.parse(fs.readFileSync(listFile, 'utf8'));
let ok = 0;
let fail = 0;
const start = Date.now();
for (const item of list) {
  try {
    const url = autoScan.smartThumbnail(item.videoPath, item.id, 'C:/thumbnails');
    if (url) ok++;
    else fail++;
  } catch (e) {
    fail++;
  }
}
console.log(JSON.stringify({ ok, fail, ms: Date.now() - start }));
