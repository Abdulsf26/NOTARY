// Notary — stepwise guided execution for the interactive demo.
// Unlike agent.js (batch runs, real-time sleeps), this executes ONE action per call,
// so the UI can expose every intermediate decision. No hidden state: session is a
// value you can serialize, and every event is returned, not pushed.
import { compileSurface } from './selector.js';
import { TOOL_REGISTRY } from './registry.js';
import { buildPlan, resolveDeferred, resolveForRetry } from './planner.js';
import { callTool } from './world.js';
import { verifyEffect } from './verifier.js';
import { createReceipt } from './receipts.js';
import { createFsrModel, recordOutcome, summarizeAll } from './fsr.js';
import { idempotencyKey, createIdempotencyStore, memoryBacking } from './idempotency.js';
import { createLogger } from './logger.js';

const log = createLogger({ service: 'notary-guided', mirror: false });

export function createGuidedSession({ query, budget = 900, lambda = 0.5, pin = null, block = null, world, faults, idempotency }) {
  const compile = compileSurface(query, TOOL_REGISTRY, { budget, lambda, pin, block });
  const plan = buildPlan(query, compile, world);
  const reads = plan.steps.filter(s => s.stage === 1);
  const writes = plan.steps.filter(s => s.stage === 2);
  const queue = [...reads, ...writes];
  const state = {
    query, compile, plan, queue, idx: 0, deferralDone: reads.length === 0 || writes.length === 0,
    results: {}, calls: [], fsr: createFsrModel(),
    idem: createIdempotencyStore(idempotency ?? memoryBacking()),
    retriesUsed: 0, done: queue.length === 0, sealed: null,
  };

  const toolOf = id => compile.selected.find(t => t.id === id);

  /** Execute one stage-1 or stage-2 step. Returns an events[] array for the UI. */
  async function execStep(step, { retrying = false } = {}) {
    const events = [];
    const tool = toolOf(step.tool);
    if (!tool) {
      const rec = { tool: step.tool, ok: false, verdict: 'BLOCKED', evidence: 'not in compiled surface — fails closed', params: step.params };
      state.calls.push(rec);
      events.push({ type: 'call-blocked', toolId: step.tool, reason: rec.evidence });
      return events;
    }
    const params = typeof step.params === 'function' ? step.params() : step.params;
    const key = await idempotencyKey({ task: query, tool: step.tool, params });
    const gate = state.idem.begin(key);
    if (gate.replay) {
      const rec = { tool: step.tool, ok: true, params, verdict: 'CONFIRMED', evidence: 'exactly-once replay — already confirmed; not re-executed', latencyMs: 0, replayed: true };
      state.calls.push(rec); state.results[step.tool] = { ok: true, status: 200, data: gate.record?.data };
      events.push({ type: 'call-replay', toolId: step.tool, evidence: rec.evidence });
      return events;
    }
    if (gate.inflight) {
      const rec = { tool: step.tool, ok: false, params, verdict: 'BLOCKED', evidence: 'in-flight duplicate dispatch refused', latencyMs: 0 };
      state.calls.push(rec);
      events.push({ type: 'call-blocked', toolId: step.tool, reason: rec.evidence });
      return events;
    }
    events.push({ type: 'call-start', toolId: step.tool, params, retrying });
    const res = callTool(tool, params, world, faults);
    events.push({ type: 'call-200', toolId: step.tool, params, status: res.status, latencyMs: 0, kind: tool.kind });
    const rec = { tool: step.tool, ok: res.ok, params, latencyMs: 0 };
    state.results[step.tool] = res;
    if (tool.kind === 'write') {
      const v = verifyEffect(tool, params, world);
      rec.verdict = v.verdict; rec.evidence = v.evidence;
      rec.fsr = recordOutcome(state.fsr, step.tool, v.verdict === 'CONTRADICTED');
      if (v.verdict === 'CONTRADICTED') state.idem.release(key); else state.idem.confirm(key, { verdict: v.verdict, evidence: v.evidence });
      events.push({ type: 'verdict', toolId: step.tool, verdict: v.verdict, evidence: v.evidence, readback: v.readback, fsr: rec.fsr });
      if (v.verdict === 'CONTRADICTED') state.retriesUsed += 1;
    } else {
      rec.verdict = 'CONFIRMED'; rec.evidence = 'read call — no postcondition required';
      events.push({ type: 'verdict', toolId: step.tool, verdict: 'CONFIRMED', evidence: rec.evidence, readback: '—' });
    }
    state.calls.push(rec);
    log.info('guided.call', { tool: step.tool, verdict: rec.verdict, retrying });
    return events;
  }

  /** One UI action. Returns { events, phase } where phase ∈ call|retry|deferral|done. */
  async function next() {
    if (state.done) return { events: [], phase: 'done' };
    // Deferral boundary: fires only when the NEXT pending step is a write
    // (i.e. every read already executed) — never before the reads feed it.
    const upcoming = state.queue[state.idx];
    if (!state.deferralDone && upcoming && upcoming.stage === 2) {
      state.deferralDone = true;
      resolveDeferred(state.queue, query, world, state.results);
      return { events: [{ type: 'deferral', note: 'Composed write parameters from read results (Drive/Notion/CRM context)' }], phase: 'deferral' };
    }
    // Retry path takes precedence over advancing
    const last = state.calls[state.calls.length - 1];
    if (last && last.verdict === 'CONTRADICTED' && state.retriesUsed <= 2) {
      const step = state.queue[state.idx - 1];
      const nextParams = resolveForRetry({ tool: step.tool, params: step.params }, world);
      step.params = nextParams;
      const events = await execStep({ ...step, params: nextParams }, { retrying: true });
      return { events: [{ type: 'retry', toolId: step.tool, reason: `Read-back CONTRADICTED — re-resolved target, retry ${state.retriesUsed}/2` }, ...events], phase: 'retry' };
    }
    if (state.idx >= state.queue.length) { state.done = true; return { events: [], phase: 'done' }; }
    const step = state.queue[state.idx];
    state.idx += 1;
    const events = await execStep(step, {});
    const tail = state.calls[state.calls.length - 1];
    const retryable = tail && tail.verdict === 'CONTRADICTED' && state.retriesUsed <= 2;
    if (state.idx >= state.queue.length && !retryable) state.done = true;
    return { events, phase: 'call' };
  }

  function summary() {
    const lastByTool = new Map();
    for (const c of state.calls) lastByTool.set(c.tool, c);
    const verdict = lastByTool.size === 0 ? 'NO_PLAN'
      : [...lastByTool.values()].every(c => c.verdict === 'CONFIRMED') ? 'CONFIRMED' : 'CONTRADICTED';
    return { verdict, calls: state.calls, fsr: summarizeAll(state.fsr) };
  }

  async function seal(prevHash = null) {
    const { verdict, calls, fsr } = summary();
    state.sealed = await createReceipt({ task: query, compile, calls, verdict, prevHash, fsr });
    return state.sealed;
  }

  return { next, summary, seal, state, compile, plan };
}
