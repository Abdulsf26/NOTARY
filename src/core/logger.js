// Notary — structured logger. One event shape everywhere:
//   { ts, level, service, msg, ...fields }  (JSONL on Node; ring buffer + console in the browser)
// Browser cannot write files (and shouldn't); Node writes logs/<service>.jsonl with 1 MB rotation.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const RING_CAP = 250;
const ring = [];

const browserSink = (entry, mirror) => {
  ring.push(entry);
  if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
  if (mirror) {
    const fn = entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warn' : 'log';
    // eslint-disable-next-line no-console
    console[fn](`[${entry.service}] ${entry.msg}`, entry);
  }
};

export function createLogger({ service = 'notary', level = 'info', sink = browserSink, mirror = true } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl, msg, fields) => {
    if ((LEVELS[lvl] ?? 20) < threshold) return;
    const entry = { ts: new Date().toISOString(), level: lvl, service, msg, ...(fields ?? {}) };
    try { sink(entry, mirror); } catch { /* logging must never take the app down */ }
  };
  return {
    debug: (msg, f) => emit('debug', msg, f),
    info: (msg, f) => emit('info', msg, f),
    warn: (msg, f) => emit('warn', msg, f),
    error: (msg, f) => emit('error', msg, f),
    ring: () => [...ring],
  };
}

/** Browser/devtools inspection: window.__notary_log */
export function attachRingToGlobal(log) {
  if (typeof globalThis !== 'undefined') globalThis.__notary_log = { entries: () => log.ring() };
}
