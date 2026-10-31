// ─── Yard speaker — waterproof Bluetooth speaker on its own dongle ────────────
//
// Owner, 2026-10-31 (rain-mode night): the graveyard ambient loops on it all
// night, and the 12-minute lightning plays a thunder clip on it in sync with
// the spotlight flash. It has its OWN Bluetooth adapter (Lily keeps the default
// one), chosen on the RAIN tab. Nothing here falls back to the Onkyo: if the
// speaker is gone, the ambient waits and a thunder clip is skipped.
//
// Settings per machine in yard-speaker.json (gitignored): { adapter, address,
// name, ambientVolume, thunderVolume, auto }. `auto` = it was connected when we
// last left it, so the server reconnects at boot and whenever it drops.

'use strict';

const fs = require('fs');

function createBtSpeaker({ file, log = console.log, onChange = () => {}, makeRouter, ambientFile }) {
  let cfg = { adapter: '', address: '', name: '', ambientVolume: 70, thunderVolume: 100, auto: false };
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (_) {}
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(cfg, null, 2)); } catch (e) { log(`speaker settings save failed: ${e.message}`); } };

  const router = makeRouter();
  const st = { connected: false, connecting: false, ambient: false, lastError: null };
  let ambientProc = null, ambientWanted = false;

  function startAmbientProc() {
    if (ambientProc || !st.connected) return;
    try {
      ambientProc = router.spawnOnSink(ambientFile(), { loop: true, volume: cfg.ambientVolume });
      st.ambient = true;
      ambientProc.on('exit', () => {
        ambientProc = null; st.ambient = false; onChange();
        // Restart if it died on its own (not stopped) and the speaker is still there.
        if (ambientWanted) setTimeout(() => { if (ambientWanted && st.connected) startAmbientProc(); }, 3000);
      });
      onChange();
    } catch (e) { st.lastError = e.message; }
  }
  function stopAmbientProc() {
    if (ambientProc) { try { ambientProc.kill(); } catch (_) {} ambientProc = null; }
    st.ambient = false;
  }

  let connecting = null;
  function connect() {
    if (connecting) return connecting;
    if (!cfg.address) return Promise.reject(new Error('Pick the speaker first (scan on its adapter)'));
    st.connecting = true; st.lastError = null; onChange();
    connecting = router.connectOn(cfg.adapter || null, cfg.address)
      .then(() => { st.connected = true; if (ambientWanted) startAmbientProc(); log(`yard speaker connected (${cfg.name || cfg.address})`); })
      .catch((e) => { st.connected = false; st.lastError = e.message; throw e; })
      .finally(() => { connecting = null; st.connecting = false; onChange(); });
    return connecting;
  }

  // Watchdog: while it should be connected, check every 15 s and reconnect.
  setInterval(async () => {
    if (!cfg.auto || connecting || process.platform !== 'linux') return;
    try {
      const present = st.connected && await router.sinkPresent();
      if (!present) {
        if (st.connected) log('yard speaker dropped — reconnecting');
        st.connected = false; stopAmbientProc(); onChange();
        await connect().catch(() => {});
      }
    } catch (_) {}
  }, 15000);
  if (cfg.auto && cfg.address) setTimeout(() => connect().catch(e => log(`yard speaker: ${e.message}`)), 8000);

  const api = {
    adapters: () => router.listAdapters(),
    scan: (adapter, seconds) => router.scanOn(adapter || null, seconds),

    async use({ adapter, address, name }) {
      if (adapter !== undefined) cfg.adapter = String(adapter || '');
      if (address !== undefined) cfg.address = String(address || '').toUpperCase();
      if (name !== undefined) cfg.name = String(name || '');
      cfg.auto = true; save();
      await connect();
      return api.status();
    },
    async disconnect() {
      cfg.auto = false; save();
      stopAmbientProc();
      if (cfg.address) await router.disconnectOn(cfg.adapter || null, cfg.address).catch(() => {});
      st.connected = false; onChange();
      return api.status();
    },

    setAmbient(on) {
      ambientWanted = !!on;
      if (ambientWanted) startAmbientProc(); else stopAmbientProc();
      onChange();
      return api.status();
    },
    setVolumes({ ambientVolume, thunderVolume }) {
      if (ambientVolume !== undefined) cfg.ambientVolume = Math.max(0, Math.min(100, Math.round(Number(ambientVolume) || 0)));
      if (thunderVolume !== undefined) cfg.thunderVolume = Math.max(0, Math.min(100, Math.round(Number(thunderVolume) || 0)));
      save();
      // ffplay can't change volume mid-play: restart the bed at the new level.
      if (ambientProc && ambientVolume !== undefined) { const keep = ambientWanted; ambientWanted = false; stopAmbientProc(); ambientWanted = keep; startAmbientProc(); }
      onChange();
      return api.status();
    },

    // One thunder clip (first 12 s, faded) -> the child process (the caller gates the mics on
    // it), or null when the speaker isn't there.
    thunder(clip) {
      if (!st.connected || !router.sinkName) return null;
      try { return router.spawnOnSink(clip, { volume: cfg.thunderVolume, maxSec: 12 }); }
      catch (e) { st.lastError = e.message; return null; }
    },

    get connected() { return st.connected; },
    status: () => ({ ...cfg, ...st, ambientWanted }),
  };
  return api;
}

module.exports = { createBtSpeaker };
