const fs   = require('fs');
const path = require('path');

const VOICES_DIR  = 'C:\\haunt-ctrl-assets\\voices';
const OUT_FILE    = path.join(__dirname, 'blackout-voices.json');
const FOLDERS     = { evelina: 'Evelina', lenora: 'Lenora', jasper: 'Jasper', edgar: 'Edgar' };
const NICE_NAMES  = { evelina: 'Evelina Crowe', lenora: 'Lenora Thorn', jasper: 'Jasper Bones', edgar: 'Edgar Rattle' };
const AUDIO_EXT   = /\.(mp3|wav|m4a|aac|ogg|flac|wma)$/i;
const MIME        = { '.mp3':'audio/mpeg', '.wav':'audio/wav', '.m4a':'audio/mp4', '.aac':'audio/aac', '.ogg':'audio/ogg', '.flac':'audio/flac', '.wma':'audio/x-ms-wma' };

function sampleFor(id) {
  const dir = path.join(VOICES_DIR, FOLDERS[id]);
  if (!fs.existsSync(dir)) return null;
  const file = fs.readdirSync(dir).filter(f => AUDIO_EXT.test(f)).sort()[0];
  return file ? path.join(dir, file) : null;
}

async function cloneOne(id, key) {
  const sample = sampleFor(id);
  if (!sample) return { id, ok: false, why: `no audio in ${path.join(VOICES_DIR, FOLDERS[id])}` };

  const buf  = fs.readFileSync(sample);
  const ext  = path.extname(sample).toLowerCase();
  const form = new FormData();
  form.append('name', `HAUNT ${NICE_NAMES[id]}`);
  form.append('description', `${NICE_NAMES[id]} - HAUNT CTRL v3 yard haunt character`);
  form.append('files', new Blob([buf], { type: MIME[ext] || 'application/octet-stream' }), path.basename(sample));

  const res = await fetch('https://api.elevenlabs.io/v1/voices/add', {
    method: 'POST',
    headers: { 'xi-api-key': key },
    body: form,
  });

  const body = await res.text();
  if (!res.ok) {
    let why = `${res.status} ${res.statusText}`;
    if (res.status === 401 || res.status === 403) why += ' - voice cloning needs a paid plan (or the key lacks permission)';
    return { id, ok: false, why, detail: body.slice(0, 300) };
  }

  let parsed;
  try { parsed = JSON.parse(body); } catch (_) { return { id, ok: false, why: 'unreadable response', detail: body.slice(0, 300) }; }
  if (!parsed.voice_id) return { id, ok: false, why: 'no voice_id in response', detail: body.slice(0, 300) };
  return { id, ok: true, voiceId: parsed.voice_id, sample: path.basename(sample) };
}

async function main() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    console.error('ELEVENLABS_API_KEY is not set:');
    console.error('  $env:ELEVENLABS_API_KEY = "your-key"');
    process.exit(1);
  }

  let out = {};
  if (fs.existsSync(OUT_FILE)) {
    try { out = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch (_) {}
  }

  let failed = 0;
  for (const id of Object.keys(FOLDERS)) {
    if (out[id] && !out[id].startsWith('PASTE_')) {
      console.log(`${id.padEnd(8)} already has ${out[id]} - skipped`);
      continue;
    }
    process.stdout.write(`${id.padEnd(8)} cloning... `);
    const r = await cloneOne(id, key);
    if (r.ok) {
      out[id] = r.voiceId;
      console.log(`${r.voiceId}   (from ${r.sample})`);
      fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), 'utf8');
    } else {
      failed++;
      console.log(`FAILED - ${r.why}`);
      if (r.detail) console.log(`         ${r.detail}`);
    }
  }

  console.log(`\nWrote ${OUT_FILE}`);
  console.log(JSON.stringify(out, null, 2));
  if (failed) {
    console.log(`\n${failed} failed. Fix the cause and re-run - finished ones are skipped.`);
    process.exit(1);
  }
  console.log('\nAll four cloned. Next: node generate-blackout-lines.js');
}

main().catch(e => { console.error(e); process.exit(1); });
