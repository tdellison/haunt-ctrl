// Report what is actually sitting in the per-character voice folders.
//
//   node check-voices.js
//
// Standalone on purpose: it needs no server running, and it prints the real
// folder contents rather than only what the resolver would pick, so a misnamed
// folder or a stray second take is visible instead of silently ignored.
const fs   = require('fs');
const path = require('path');

const VOICES_DIR = 'C:\\haunt-ctrl-assets\\voices';
const FOLDERS    = { evelina: 'Evelina', lenora: 'Lenora', jasper: 'Jasper', edgar: 'Edgar' };
const AUDIO_EXT  = /\.(mp3|wav|m4a|aac|ogg|flac|wma)$/i;

console.log(`\nVoices root: ${VOICES_DIR}`);
if (!fs.existsSync(VOICES_DIR)) {
  console.log('  MISSING — that folder does not exist.\n');
  process.exit(1);
}

// Anything on disk that we are not looking for is worth showing: a folder named
// "Evelina Crowe" or "evelina " reads fine to a human and not at all to code.
const onDisk = fs.readdirSync(VOICES_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory()).map(d => d.name);
console.log(`Folders present: ${onDisk.join(', ') || '(none)'}\n`);

let missing = 0;
for (const [id, folder] of Object.entries(FOLDERS)) {
  const dir = path.join(VOICES_DIR, folder);
  const label = id.padEnd(8);

  if (!fs.existsSync(dir)) {
    const near = onDisk.find(d => d.toLowerCase().startsWith(id.slice(0, 4)));
    console.log(`${label} MISSING folder ${folder}${near ? `  (did you mean "${near}"?)` : ''}`);
    missing++;
    continue;
  }

  const all   = fs.readdirSync(dir);
  const audio = all.filter(f => AUDIO_EXT.test(f)).sort();

  if (!audio.length) {
    console.log(`${label} NO AUDIO in ${folder}  (contains: ${all.join(', ') || 'nothing'})`);
    missing++;
    continue;
  }

  const pick = audio[0];
  const size = fs.statSync(path.join(dir, pick)).size;
  console.log(`${label} ${pick}  (${size.toLocaleString()} bytes)`);
  if (audio.length > 1) {
    console.log(`${' '.repeat(9)}^ ${audio.length} audio files here — using the first alphabetically.`);
    console.log(`${' '.repeat(9)}  others: ${audio.slice(1).join(', ')}`);
  }
}

console.log(missing ? `\n${missing} character(s) not resolved.\n` : '\nAll four resolved.\n');
process.exit(missing ? 1 : 0);
