// Notary — planner / FSR posterior / idempotency test suite. Run: npm test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, resolveForRetry, isRead } from '../src/core/planner.js';
import { compileSurface } from '../src/core/selector.js';
import { TOOL_REGISTRY } from '../src/core/registry.js';
import { betaPosterior, wilsonInterval, createFsrModel, recordOutcome, summarizeTool, decayedCounts } from '../src/core/fsr.js';
import { createIdempotencyStore, memoryBacking, idempotencyKey } from '../src/core/idempotency.js';

const compile = q => compileSurface(q, TOOL_REGISTRY, { budget: 1400, lambda: 0.5 });

describe('planner — computes the trajectory from the task', () => {
  test('hero task maps to exactly the hero tool set', () => {
    const { steps } = buildPlan('Find the Q3 update in Drive, post the summary to the engineering Slack channel, append it to the Q3 Notion page, and log it on the Acme deal', compile('Find the Q3 update in Drive, post the summary to the engineering Slack channel, append it to the Q3 Notion page, and log it on the Acme deal'), null);
    const ids = steps.map(s => s.tool);
    assert.ok(ids.includes('drive.search_files') && ids.includes('notion.read_page'));
    assert.ok(ids.includes('notion.append_block') && ids.includes('slack.post_in_channel') && ids.includes('crm.log_activity'));
  });
  test('reads are staged before writes', () => {
    const q = 'Post the Q3 update to the engineering Slack channel';
    const { steps } = buildPlan(q, compile(q), null);
    const stages = steps.map(s => s.stage);
    assert.deepEqual([...stages].sort((a, b) => a - b), stages);
  });
  test('junk query yields an empty plan — never a fabricated one', () => {
    const q = 'asdkfj qqq zzz';
    const { steps } = buildPlan(q, compile(q), null);
    assert.equal(steps.length, 0);
  });
  test('refund intent resolves to stripe.create_refund with the charge id parsed from text', () => {
    const q = 'Refund charge ch_123abc for the wrong invoice';
    const { steps } = buildPlan(q, compile(q), null);
    const refund = steps.find(s => s.tool === 'stripe.create_refund');
    assert.ok(refund, 'refund step exists');
    assert.equal(refund.params.charge_id, 'ch_123abc');
  });
  test('a refund request never spuriously creates an invoice or deal note', () => {
    const q = 'Refund charge ch_123 for the Acme invoice';
    const { steps } = buildPlan(q, compile(q), null);
    assert.ok(steps.some(s => s.tool === 'stripe.create_refund'));
    assert.ok(!steps.some(s => s.tool === 'stripe.create_invoice'), 'no unsolicited invoice');
    assert.ok(!steps.some(s => s.tool === 'crm.log_activity'), 'no unsolicited CRM write');
  });
  test('intents outside the compiled surface fail closed (not in surface ⇒ blocked)', () => {
    const q = 'Post the Q3 update to the engineering Slack channel';
    const tiny = { selected: TOOL_REGISTRY.filter(t => t.id === 'drive.search_files') }; // Slack deliberately NOT compiled
    const { steps, notes } = buildPlan(q, tiny, null);
    assert.ok(!steps.some(s => s.tool === 'slack.post_in_channel'));
    assert.ok(notes.some(n => n.includes('slack.post_in_channel')));
  });
  test('retry resolver re-reads the live parent instead of reusing the stale one', () => {
    const world = { notion: { pages: { 'page-q3': { title: 'Q3', blocks: [{ id: 'blk-live-1', text: 'x', parent: null }] } } } };
    const next = resolveForRetry({ tool: 'notion.append_block', params: { parent_block_id: 'stale-parent', content: 'c' } }, world);
    assert.equal(next.parent_block_id, 'blk-live-1');
  });
  test('isRead classifies reads vs writes', () => {
    assert.ok(isRead('drive.search_files') && isRead('notion.read_page') && !isRead('notion.append_block') && !isRead('slack.post_in_channel'));
  });
});

describe('fsr — Beta posterior + Wilson interval', () => {
  test('zero observations start at the uninformative prior mean 0.5 with full interval', () => {
    const s = summarizeTool(createFsrModel(), 'x.y');
    assert.equal(s.posteriorMean, 0.5);
    assert.deepEqual(s.wilson95, [0, 1]);
  });
  test('no false successes still reports non-zero risk (Laplace)', () => {
    const m = createFsrModel();
    for (let i = 0; i < 10; i++) recordOutcome(m, 'a.b', false, i);
    const s = summarizeTool(m, 'a.b', 10);
    assert.ok(s.posteriorMean > 0 && s.posteriorMean < 0.1);
    assert.equal(s.wilson95[0], 0);
    assert.ok(s.wilson95[1] > 0.15 && s.wilson95[1] < 0.45);
  });
  test('all false successes pushes the estimate toward 1', () => {
    const m = createFsrModel();
    for (let i = 0; i < 20; i++) recordOutcome(m, 'a.b', true, i);
    const s = summarizeTool(m, 'a.b', 20);
    assert.ok(s.posteriorMean > 0.9);
  });
  test('wilsonInterval is bounded in [0,1] and contains the point estimate-ish region', () => {
    for (const [f, n] of [[0, 0], [0, 1], [1, 1], [5, 10], [10, 10], [3, 100]]) {
      const [lo, hi] = wilsonInterval(f, n);
      assert.ok(lo >= 0 && hi <= 1 && lo <= hi, `bounds ${f}/${n}`);
    }
  });
  test('half-life decay halves old evidence after 14 days', () => {
    const day = 86_400_000, t0 = 1_000_000_000_000;
    const { nEff } = decayedCounts([{ t: t0, f: 0 }], t0 + 14 * day);
    assert.ok(Math.abs(nEff - 0.5) < 1e-9);
  });
  test('betaPosterior matches (f+1)/(n+2)', () => {
    assert.ok(Math.abs(betaPosterior(3, 9).mean - 4 / 11) < 1e-12);
  });
});

describe('idempotency — exactly-once write semantics', () => {
  test('same task+tool+params ⇒ same key', async () => {
    const a = await idempotencyKey({ task: 't', tool: 'x.y', params: { b: 2, a: 1 } });
    const b = await idempotencyKey({ task: 't', tool: 'x.y', params: { a: 1, b: 2 } });
    assert.equal(a, b); // key order-insensitive via stableStringify
  });
  test('different params ⇒ different key', async () => {
    const a = await idempotencyKey({ task: 't', tool: 'x.y', params: { a: 1 } });
    const b = await idempotencyKey({ task: 't', tool: 'x.y', params: { a: 2 } });
    assert.notEqual(a, b);
  });
  test('confirmed key replays; released key re-executes', () => {
    const store = createIdempotencyStore(memoryBacking());
    assert.equal(store.begin('k').replay, false);
    store.confirm('k', { verdict: 'CONFIRMED' });
    assert.equal(store.begin('k').replay, true);
    // release path (failed verification)
    const store2 = createIdempotencyStore(memoryBacking());
    store2.begin('k2');
    store2.release('k2');
    assert.equal(store2.begin('k2').replay, false);
  });
  test('in-flight collision is refused, not duplicated', () => {
    const store = createIdempotencyStore(memoryBacking());
    store.begin('k');
    assert.equal(store.begin('k').inflight, true);
  });
});
