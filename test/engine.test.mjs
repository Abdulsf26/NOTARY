// Notary — engine test suite (node:test). Run: npm test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_REGISTRY, TOTAL_REGISTRY_TOKENS } from '../src/core/registry.js';
import { tokenize, featureVector, relevance, redundancy } from '../src/core/similarity.js';
import { compileSurface } from '../src/core/selector.js';
import { issueCertificate, toolQuantile } from '../src/core/certificate.js';
import { createReceipt, verifyChain, hashPayload, stableStringify } from '../src/core/receipts.js';
import { createWorld, createFaults, callTool } from '../src/core/world.js';
import { verifyEffect } from '../src/core/verifier.js';
import { runTask, HERO_TASK } from '../src/core/agent.js';

const HERO_IDS = ['drive.search_files', 'notion.read_page', 'notion.append_block', 'slack.post_in_channel', 'crm.log_activity'];

describe('tokenize', () => {
  test('empty and junk input yield no tokens', () => {
    assert.equal(tokenize('').length, 0);
    assert.equal(tokenize('   ').length, 0);
    assert.equal(tokenize('%%%&&&').length, 0);
  });
  test('unicode and mixed case are handled deterministically', () => {
    assert.deepEqual(tokenize('Slack ALERT 🚨'), tokenize('slack alert'));
  });
  test('synonym expansion: find → search', () => {
    assert.ok(tokenize('find files').includes('search'));
  });
  test('depluralisation: files → file', () => {
    assert.ok(tokenize('files').includes('file'));
  });
});

describe('relevance — fail-closed contract', () => {
  test('empty query is relevant to nothing', () => {
    for (const t of TOOL_REGISTRY) assert.equal(relevance(t, ''), 0);
  });
  test('out-of-registry query is relevant to nothing', () => {
    for (const t of TOOL_REGISTRY) assert.equal(relevance(t, 'asdfqwer zxcvb'), 0);
  });
  test('every relevance is in [0, 1] across a sweep of queries', () => {
    const qs = [HERO_TASK, 'refund charge ch_123', '  ', 'notion', 'delete everything', 'weather in Chennai'];
    for (const q of qs) for (const t of TOOL_REGISTRY) {
      const r = relevance(t, q);
      assert.ok(r >= 0 && r <= 1, `r out of range for ${t.id}: ${r}`);
    }
  });
});

describe('compiler (BTSS)', () => {
  const r = compileSurface(HERO_TASK, TOOL_REGISTRY, { budget: 900, lambda: 0.5 });
  test('hero surface contains the five gold tools', () => {
    const ids = new Set(r.selected.map(t => t.id));
    for (const id of HERO_IDS) assert.ok(ids.has(id), `missing ${id}`);
  });
  test('surface respects the budget', () => {
    assert.ok(r.usedCost <= 900);
  });
  test('enumeration never loses to greedy', () => {
    assert.ok(r.F + 1e-9 >= r.greedyF);
  });
  test('λ is clamped to the monotone regime', () => {
    assert.ok(r.lambdaUsed <= r.lambdaMax + 1e-9);
    assert.ok(r.wasClamped);
  });
  test('F accounts for redundancy (not just summed relevance)', () => {
    const raw = r.selected.reduce((s, t) => s + r.relevance.get(t.id), 0);
    assert.ok(r.F < raw + 1e-9); // redundancy penalties are subtracted
  });
  test('empty registry compiles to an empty surface', () => {
    const e = compileSurface(HERO_TASK, [], { budget: 900, lambda: 0.5 });
    assert.equal(e.selected.length, 0);
    assert.equal(e.certificate.n, 0);
  });
  test('budget 0 compiles nothing', () => {
    const e = compileSurface(HERO_TASK, TOOL_REGISTRY, { budget: 0, lambda: 0.5 });
    assert.equal(e.selected.length, 0);
    assert.equal(e.usedCost, 0);
  });
  test('lambda 0 selects the pure relevance set', () => {
    const e = compileSurface(HERO_TASK, TOOL_REGISTRY, { budget: 900, lambda: 0 });
    assert.ok(e.selected.length > 0);
  });
  test('out-of-registry query fails closed', () => {
    const e = compileSurface('asdfqwer zxcv', TOOL_REGISTRY, { budget: 900, lambda: 0.5 });
    assert.equal(e.selected.length, 0);
  });
  test('determinism: same query → same surface, twice', () => {
    const a = compileSurface(HERO_TASK, TOOL_REGISTRY, { budget: 900, lambda: 0.5 });
    const b = compileSurface(HERO_TASK, TOOL_REGISTRY, { budget: 900, lambda: 0.5 });
    assert.deepEqual(a.selected.map(t => t.id), b.selected.map(t => t.id));
    assert.equal(a.F, b.F);
  });
});

describe('certificate', () => {
  test('bound ≥ deterministic cost, always', () => {
    const r = compileSurface(HERO_TASK, TOOL_REGISTRY, { budget: 900, lambda: 0.5 });
    assert.ok(r.certificate.bound >= r.certificate.deterministic);
    assert.ok(r.certificate.estimateMedian >= r.certificate.deterministic);
    assert.ok(r.certificate.calibratedBound >= r.certificate.deterministic);
  });
  test('guarantee number is the Bonferroni bound (not the calibrated estimate)', () => {
    const r = compileSurface(HERO_TASK, TOOL_REGISTRY, { budget: 900, lambda: 0.5 });
    assert.ok(r.certificate.statement.includes(r.certificate.bound.toLocaleString()));
  });
  test('empty surface → fails closed statement, zero bound', () => {
    const c = issueCertificate([], 0.05);
    assert.equal(c.bound, 0);
    assert.match(c.statement, /fails closed/i);
  });
  test('quantiles are monotone in confidence', () => {
    const p95 = 1000;
    assert.ok(toolQuantile(p95, 0.5) < toolQuantile(p95, 0.9));
    assert.ok(toolQuantile(p95, 0.9) < toolQuantile(p95, 0.99));
  });
  test('Bonferroni: per-tool confidence rises with surface size', () => {
    const tools = TOOL_REGISTRY.slice(0, 8);
    const c1 = issueCertificate(tools.slice(0, 1), 0.05);
    const c5 = issueCertificate(tools.slice(0, 5), 0.05);
    assert.ok(c5.perToolConfidence > c1.perToolConfidence);
  });
});

describe('receipts — hash chain', () => {
  test('stableStringify is key-order invariant', () => {
    assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  });
  test('chain verifies and tampering is detected', async () => {
    const r1 = compileSurface(HERO_TASK, TOOL_REGISTRY, { budget: 900, lambda: 0.5 });
    const mk = async calls => createReceipt({ task: 't', compile: r1, calls, verdict: 'CONFIRMED', prevHash: null });
    const a = await mk([{ tool: 'x', verdict: 'CONFIRMED' }]);
    const b = await createReceipt({ task: 't', compile: r1, calls: [{ tool: 'y', verdict: 'CONFIRMED' }], verdict: 'CONFIRMED', prevHash: a.hash });
    assert.ok((await verifyChain([a, b])).valid);
    const forged = { ...b, calls: [{ tool: 'y', verdict: 'CONFIRMED', evidence: 'attacker-controlled' }] };
    const check = await verifyChain([a, forged]);
    assert.equal(check.valid, false);
    assert.ok(check.problems.length >= 1);
  });
});

describe('verifier — read-back never trusts 200', () => {
  test('silent no-op write is CONTRADICTED', () => {
    const world = createWorld();
    const faults = createFaults();
    faults.silentNoOp = true;
    const tool = TOOL_REGISTRY.find(t => t.id === 'notion.append_block');
    const res = callTool(tool, { parent_block_id: 'stale-parent', content: 'test' }, world, faults);
    assert.equal(res.status, 200); // the lie
    const v = verifyEffect(tool, { parent_block_id: 'stale-parent', content: 'test' }, world);
    assert.equal(v.verdict, 'CONTRADICTED'); // the evidence
  });
  test('normal write is CONFIRMED', () => {
    const world = createWorld();
    const faults = createFaults();
    const tool = TOOL_REGISTRY.find(t => t.id === 'slack.post_in_channel');
    callTool(tool, { channel: 'engineering', text: 'hello receipt' }, world, faults);
    const v = verifyEffect(tool, { channel: 'engineering', text: 'hello receipt' }, world);
    assert.equal(v.verdict, 'CONFIRMED');
  });
});

describe('end-to-end — protected run', () => {
  test('catches the silent no-op and lands CONFIRMED via bounded retry', async () => {
    const world = createWorld();
    const faults = createFaults();
    faults.silentNoOp = true;
    const out = await runTask({ query: HERO_TASK, budget: 900, lambda: 0.5, emit: () => {}, world, faults, prevHash: null });
    assert.equal(out.verdict, 'CONFIRMED');
    assert.ok(out.receipt.falseSuccessCaught >= 1);
    assert.equal((await verifyChain([out.receipt])).valid, true);
  });
});

describe('registry integrity', () => {
  test('every write tool has a postcondition contract', () => {
    const writes = TOOL_REGISTRY.filter(t => t.kind === 'write');
    assert.ok(writes.length > 0);
    for (const w of writes) {
      assert.ok(w.contract, `${w.id} write tool missing contract`);
      assert.ok(w.contract.post, `${w.id} missing postcondition`);
      assert.ok(w.contract.readback, `${w.id} missing readback`);
    }
  });
  test('TOTAL_REGISTRY_TOKENS matches the sum of tool costs', () => {
    const sum = TOOL_REGISTRY.reduce((s, t) => s + t.cost, 0);
    assert.equal(sum, TOTAL_REGISTRY_TOKENS);
  });
});
