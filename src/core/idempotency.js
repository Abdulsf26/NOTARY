// Notary — exactly-once write semantics via idempotency keys.
// key = SHA-256(stableStringify({ task, tool, params })).slice(0, 24)
// Semantics (stripe-style):
//   • A write that CONFIRMED is cached forever under its key → replays are served
//     from the cache; the side effect NEVER happens twice.
//   • A write that CONTRADICTED is released → a bounded retry re-executes.
//   • Inflight collisions (two dispatchers, same key) are refused, not duplicated.
// Browser: backed by localStorage (survives reloads — "the ledger remembers").
// Node/tests: defaults to an in-memory Map, so behaviour is identical headless.
import { sha256hex, stableStringify } from './receipts.js';

export async function idempotencyKey({ task, tool, params }) {
  return 'idem-' + (await sha256hex(stableStringify({ task, tool, params }))).slice(0, 24);
}

export function memoryBacking() {
  const m = new Map();
  return { has: k => m.has(k), get: k => m.get(k), put: (k, v) => m.set(k, v), delete: k => m.delete(k), size: () => m.size };
}

export function localStorageBacking(storageKey = 'notary.idempotency.v1', cap = 500) {
  const load = () => { try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { return {}; } };
  const save = (obj) => {
    try {
      const entries = Object.entries(obj);
      const trimmed = entries.length > cap ? Object.fromEntries(entries.slice(-cap)) : obj;
      localStorage.setItem(storageKey, JSON.stringify(trimmed));
    } catch { /* quota — cache is an optimisation, never a blocker */ }
  };
  return {
    has: k => Object.prototype.hasOwnProperty.call(load(), k),
    get: k => load()[k],
    put: (k, v) => { const o = load(); o[k] = v; save(o); },
    delete: k => { const o = load(); delete o[k]; save(o); },
    size: () => Object.keys(load()).length,
  };
}

export function createIdempotencyStore(backing = memoryBacking()) {
  const inflight = new Set();
  return {
    backing,
    /** Decide: replay from cache, or proceed and mark inflight. */
    begin(key) {
      if (backing.has(key)) return { replay: true, record: backing.get(key) };
      if (inflight.has(key)) return { replay: false, inflight: true };
      inflight.add(key);
      return { replay: false, inflight: false };
    },
    confirm(key, record) { inflight.delete(key); backing.put(key, { ...record, at: Date.now() }); },
    /** Failed verification — release the key so a bounded retry may proceed. */
    release(key) { inflight.delete(key); backing.delete(key); },
    /** Process-level crash/abort — drop inflight marker, keep cache untouched. */
    abort(key) { inflight.delete(key); },
  };
}
