// ─── Greeter faces — knows the team, so staff don't get greeted all day ───────
//
// Runs faces.py (OpenCV, fully local) as a helper process and asks it who is
// in a camera frame. Team photos live in greeter/team/<Name>/ on this computer
// only — never uploaded, never sent to Claude or ElevenLabs. Deleting a person
// deletes their folder.
//
// Off until "Recognise team" is switched on in the setup page.

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const TEAM_DIR = path.join(__dirname, 'team');
const VENV_PY = path.join(__dirname, '.venv', 'bin', 'python');

// Folder-safe version of a name ("Todd", "Mary Jo") — letters, digits, space, - and '.
const cleanName = (n) => String(n || '').replace(/[^\p{L}\p{N} '\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);

function createFaces({ log = console.log }) {
  const status = { ready: false, error: null, team: {}, opencv: null };
  let proc = null, nextId = 1, out = '';
  const pending = new Map();

  function start() {
    if (proc) return;
    const py = process.env.FACES_PYTHON || (fs.existsSync(VENV_PY) ? VENV_PY : 'python3');
    proc = spawn(py, [path.join(__dirname, 'faces.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
    out = '';
    proc.stdout.on('data', (d) => {
      out += d;
      let nl;
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl); out = out.slice(nl + 1);
        let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
        if ('ready' in msg) {
          status.ready = msg.ready; status.error = msg.error || null;
          if (msg.team) status.team = msg.team;
          status.opencv = msg.opencv || null;
          log(msg.ready ? `faces: ready (${Object.keys(status.team).length} team member(s))` : `faces: not available — ${msg.error}`);
          continue;
        }
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); clearTimeout(p.timer); msg.ok ? p.resolve(msg) : p.reject(new Error(msg.error)); }
      }
    });
    let errText = '';
    proc.stderr.on('data', (d) => { errText = (errText + d).slice(-400); });
    proc.on('error', (e) => { status.error = e.message; });
    proc.on('exit', () => {
      proc = null; status.ready = false;
      if (!status.error) status.error = errText.trim().split('\n').pop() || 'face helper stopped';
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(status.error)); }
      pending.clear();
    });
  }

  function call(cmd, args = {}, timeoutMs = 5000) {
    if (!proc) start();
    return new Promise((resolve, reject) => {
      if (!proc) return reject(new Error(status.error || 'face helper not running'));
      if (!status.ready && status.error) return reject(new Error(`Face recognition not available: ${status.error}`));
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('face helper timed out')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      proc.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    });
  }

  async function reload() {
    const r = await call('reload', {}, 60000);
    status.team = r.team;
    return status.team;
  }

  return {
    start,
    stop() { if (proc) proc.kill('SIGTERM'); },
    // -> [{ name|null, closest, score, size }]
    async identify(jpeg, { minFace, threshold }) {
      return (await call('identify', { jpeg: jpeg.toString('base64'), minFace, threshold })).faces;
    },
    // Save a team photo — refused unless a face is found in it.
    async addPhoto(name, jpeg) {
      const n = cleanName(name);
      if (!n) throw new Error('Name required');
      const r = await call('check', { jpeg: jpeg.toString('base64') });
      if (!r.faces) throw new Error('No face found in that photo — face the camera, good light');
      const dir = path.join(TEAM_DIR, n);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${Date.now()}.jpg`), jpeg);
      await reload();
      log(`faces: photo added for ${n}`);
      return status.team;
    },
    async removePerson(name) {
      const n = cleanName(name);
      if (!n) throw new Error('Name required');
      fs.rmSync(path.join(TEAM_DIR, n), { recursive: true, force: true });
      await reload();
      log(`faces: ${n} removed (photos deleted)`);
      return status.team;
    },
    teamNames: () => Object.keys(status.team).filter(n => status.team[n].usable > 0),
    status: () => ({ ...status }),
  };
}

module.exports = { createFaces, cleanName };
