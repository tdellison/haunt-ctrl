const fs   = require('fs');
const path = require('path');

const CACHE_DIR   = path.join(__dirname, 'cache', 'audio');
const VOICES_FILE = path.join(__dirname, 'blackout-voices.json');
const MODEL_ID    = 'eleven_multilingual_v2';

const LINES = [
  { id: 'jasper',  text: '...hello?' },
  { id: 'edgar',   text: 'this is new' },
  { id: 'lenora',  text: 'nobody did' },
  { id: 'evelina', text: "it's getting stronger" },
];

async function main() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) { console.error('ELEVENLABS_API_KEY is not set'); process.exit(1); }
  const voices = JSON.parse(fs.readFileSync(VOICES_FILE, 'utf8').replace(/^\uFEFF/, ''));
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  for (const line of LINES) {
    const out = path.join(CACHE_DIR, `${line.id}-blackout.mp3`);
    process.stdout.write(`${line.id}: "${line.text}" ... `);
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voices[line.id]}`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: line.text, model_id: MODEL_ID }),
    });
    if (!res.ok) { console.log('FAILED'); console.error(`  ${res.status}: ${await res.text()}`); process.exit(1); }
    fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    console.log(`${path.basename(out)}  (${fs.statSync(out).size} bytes)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
