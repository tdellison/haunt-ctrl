// ─── Llama engine — local Llama 3.1 8B through Ollama ─────────────────────────
//
// Measured on the OptiPlex (CPU only, 2026-09-30): ~18.7 s for the first line
// while the model loads, then 5-7 s per short line (~2 s reading the prompt,
// ~6 tokens/s writing). Everything here exists to hide that:
//   - the model is loaded at startup and never unloaded (keep_alive -1), so the
//     18 s cold start happens once per boot, not on show night;
//   - ONE request runs at a time (the CPU is shared anyway) through a priority
//     queue: live reactions jump ahead of background line-bank refills, and a
//     live request CANCELS a bank line already in progress (measured: waiting
//     behind one turned a 5 s reaction into 13-21 s);
//   - replies are capped short (num_predict) — Jasper/Edgar lines are one breath.
//
// If Ollama isn't running, it is started as this user (`ollama serve`) — the
// model lives in ~/.ollama, which the distro's ollama service would not see.

'use strict';

const { spawn } = require('child_process');

const HOST = process.env.OLLAMA_HOST_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.LLAMA_MODEL || 'llama3.1:8b';
const PRIORITY = { reaction: 0, live: 1, bank: 2 };

function createLlama({ log = console.log } = {}) {
  const queue = [];           // { priority, run, resolve, reject, enqueuedAt }
  let running = null;         // the job in flight

  let ready = false;
  let lastError = null;
  const stats = { calls: 0, totalMs: 0, lastMs: null };

  async function up() {
    try { const r = await fetch(`${HOST}/api/version`, { signal: AbortSignal.timeout(1500) }); return r.ok; }
    catch (_) { return false; }
  }

  async function ensureServer() {
    if (await up()) return true;
    log('Ollama not running - starting it');
    try {
      const p = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' });
      p.on('error', (e) => { lastError = `cannot start ollama: ${e.message}`; });
      p.unref();
    } catch (e) { lastError = e.message; return false; }
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (await up()) return true;
    }
    lastError = 'Ollama did not come up';
    return false;
  }

  function pump() {
    if (running || !queue.length) return;
    queue.sort((a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt);
    const job = queue.shift();
    job.abort = new AbortController();
    running = job;
    job.run(job.abort.signal).then(job.resolve, job.reject).finally(() => { running = null; pump(); });
  }

  function enqueue(priority, run) {
    return new Promise((resolve, reject) => {
      queue.push({ priority, run, resolve, reject, enqueuedAt: Date.now() });
      // A live request never waits for background work: cancel the bank line
      // in flight (Ollama stops generating when the request is dropped).
      if (running && running.priority === PRIORITY.bank && priority < PRIORITY.bank) running.abort.abort();
      pump();
    });
  }

  async function call(messages, { maxTokens = 48, temperature = 0.9, signal } = {}) {
    const t0 = Date.now();
    const r = await fetch(`${HOST}/api/chat`, {
      method: 'POST',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
      body: JSON.stringify({
        model: MODEL, stream: false, keep_alive: -1,
        options: { num_predict: maxTokens, temperature },
        messages,
      }),
    });
    const body = await r.json();
    if (!r.ok || body.error) throw new Error(body.error || `ollama ${r.status}`);
    const ms = Date.now() - t0;
    stats.calls++; stats.totalMs += ms; stats.lastMs = ms;
    return { text: String(body.message?.content || '').trim(), ms };
  }

  const api = {
    MODEL,
    PRIORITY,
    // Load the model now so the 18 s cold start never lands on a guest.
    async warm() {
      if (!(await ensureServer())) { log(`Llama unavailable: ${lastError}`); return false; }
      try {
        const { ms } = await enqueue(PRIORITY.live, (signal) => call([{ role: 'user', content: 'Say OK.' }], { maxTokens: 2, signal }));
        ready = true; lastError = null;
        log(`Llama ready (${MODEL}, loaded in ${(ms / 1000).toFixed(1)}s)`);
        return true;
      } catch (e) { lastError = e.message; log(`Llama warm-up failed: ${e.message}`); return false; }
    },
    // messages: [{role, content}], priority: PRIORITY.*
    chat(messages, { priority = PRIORITY.live, maxTokens, temperature } = {}) {
      return enqueue(priority, (signal) => call(messages, { maxTokens, temperature, signal })).catch((e) => {
        if (e.name !== 'AbortError') lastError = e.message;
        throw e;
      });
    },
    status() {
      return {
        model: MODEL, ready, lastError, queued: queue.length, busy: !!running,
        calls: stats.calls, avgMs: stats.calls ? Math.round(stats.totalMs / stats.calls) : null, lastMs: stats.lastMs,
      };
    },
  };
  return api;
}

module.exports = { createLlama };
