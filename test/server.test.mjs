import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = 8791;
let proc;
before(async () => {
  proc = spawn(process.execPath, ['server/notary-server.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/healthz`); if (r.ok) return; } catch {}
    await delay(100);
  }
  throw new Error('server did not start');
});
after(() => proc?.kill('SIGTERM'));

test('healthz reports registry', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.ok(j.tools > 50);
});
test('compile happy path returns surface + certificate', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/v1/compile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'Post the Q3 update to #engineering and log it on the Acme deal', budget: 900 }) });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.surface.length > 0);
  assert.ok(j.certificate.bound > 0);
  assert.ok(j.decision.usedCost <= 900);
});
test('compile fails closed on empty/invalid input', async () => {
  for (const body of [{}, { query: '' }, { query: '   ' }, { query: 'x'.repeat(5000) }, { query: 'ok', budget: -1 }, { query: 'ok', lambda: 999 }]) {
    const r = await fetch(`http://127.0.0.1:${PORT}/v1/compile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(r.status, 422, JSON.stringify(body).slice(0, 40));
  }
});
test('out-of-registry query returns empty surface (fail closed)', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/v1/compile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'asdfqwer zxcvb nm' }) });
  const j = await r.json();
  assert.equal(j.surface.length, 0);
  assert.equal(j.certificate.bound, 0);
});
test('openai-tools emits a valid chat-completions tools array', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/v1/openai-tools?q=${encodeURIComponent('refund charge ch_123 for acme')}`);
  const j = await r.json();
  assert.ok(Array.isArray(j.tools) && j.tools.length >= 1);
  for (const tool of j.tools) {
    assert.match(tool.function.name, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.equal(tool.type, 'function');
    assert.equal(tool.function.parameters.type, 'object');
  }
});
test('verify rejects a tampered chain', async () => {
  const bad = [{ v: 1, kind: 'notary/receipt', id: 'rcpt_x', at: new Date().toISOString(), task: 't', surface: [], certificate: {}, calls: [], verdict: 'CONFIRMED', falseSuccessCaught: 0, prev: 'genesis', session: 'sess_demo', hash: 'deadbeef'.repeat(8) }];
  const r = await fetch(`http://127.0.0.1:${PORT}/v1/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ receipts: bad }) });
  const j = await r.json();
  assert.equal(j.valid, false);
});
