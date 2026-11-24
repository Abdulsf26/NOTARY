// Node-only JSONL file logger for the facade — same entry shape as src/core/logger.js.
// Appends one JSON object per line to logs/facade.jsonl; rotates at 1 MB (facade.1.jsonl).
// Never logs request/response bodies (customer data) — sizes and ids only.
import { appendFileSync, mkdirSync, statSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs');
const LOG_FILE = join(LOG_DIR, 'facade.jsonl');
const ROTATED = join(LOG_DIR, 'facade.1.jsonl');
const MAX_BYTES = 1_000_000;

export function fileSink(entry) {
  mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  try {
    if (statSync(LOG_FILE).size > MAX_BYTES) renameSync(LOG_FILE, ROTATED);
  } catch { /* rotation is best-effort */ }
}

export function createFileLogger(service = 'notary-facade') {
  const emit = (level, msg, fields) => {
    const entry = { ts: new Date().toISOString(), level, service, msg, ...(fields ?? {}) };
    try { fileSink(entry); } catch (e) { process.stderr.write(`log write failed: ${e.message}\n`); }
    process.stdout.write(JSON.stringify(entry) + '\n');
  };
  return {
    info: (msg, f) => emit('info', msg, f),
    warn: (msg, f) => emit('warn', msg, f),
    error: (msg, f) => emit('error', msg, f),
  };
}
