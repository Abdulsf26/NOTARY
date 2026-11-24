// Notary — the demo agent. The trajectory is COMPUTED from the typed query on every
// run (deterministic planner, src/core/planner.js) — nothing about the path is
// pre-baked. Runs against the mock world with fault injection; narrates every step
// so the UI can render the three beats live: BOMB → LIE DETECTOR → VOICE.
// BASELINE mode (no Notary): same planner, same world, same faults — the agent
// declares "Done!" on 200 OK with zero verification. Used for the A/B demo.
import { compileSurface } from './selector.js';
import { TOOL_REGISTRY } from './registry.js';
import { callTool } from './world.js';
import { verifyEffect } from './verifier.js';
import { createReceipt } from './receipts.js';
import { buildPlan, resolveDeferred, resolveForRetry } from './planner.js';
import { createFsrModel, recordOutcome, summarizeAll } from './fsr.js';
import { idempotencyKey, createIdempotencyStore, memoryBacking } from './idempotency.js';
import { createLogger, attachRingToGlobal } from './logger.js';

export const HERO_TASK = 'Find the Q3 update in Drive, post the summary to the engineering Slack channel, append it to the Q3 Notion page, and log it on the Acme deal';

const log = createLogger({ service: 'notary-agent', mirror: typeof window !== 'undefined' });
attachRingToGlobal(log);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * @param {object} opts
 * @param {string} opts.query
 * @param {number} opts.budget
 * @param {number} opts.lambda
 * @param {boolean} opts.baseline
 * @param {(e:object)=>void} opts.emit
 * @param {object} opts.world
 * @param {object} opts.faults
 * @param {string|null} opts.prevHash
 * @param {object} [opts.idempotency] — backing store ({has,get,put,delete,size}) for exactly-once
 */
export async function runTask({ query, budget = 900, lambda = 0.5, baseline = false, emit, world, faults, prevHash = null, idempotency }) {
  if (baseline) return runBaseline({ query, emit, world, faults, idempotency });

  emit({ type: 'phase', phase: 'COMPILE', label: 'Compiling tool surface under budget' });
  await sleep(300);

  const t0 = Date.now();
  const compile = compileSurface(query, TOOL_REGISTRY, { budget, lambda });
  const compileMs = Date.now() - t0;
  log.info('surface.compiled', { ms: compileMs, tools: compile.selected.length, usedCost: compile.usedCost, budget, lambdaUsed: compile.lambdaUsed, seeds: compile.exploredSeeds, F: +compile.F.toFixed(3) });
  emit({ type: 'surface', compile });
  await sleep(420);

  emit({ type: 'phase', phase: 'CERTIFICATE', label: 'Issuing pre-flight cost certificate' });
  await sleep(400);
  emit({ type: 'certificate', certificate: compile.certificate });
  await sleep(350);

  emit({ type: 'phase', phase: 'ACT', label: 'Agent acting inside the certified surface' });

  const toolOf = id => compile.selected.find(t => t.id === id);
  const plan = buildPlan(query, compile, world);
  for (const note of plan.notes) emit({ type: 'plan-note', note });

  if (plan.steps.length === 0) {
    log.warn('plan.empty', { query: String(query).slice(0, 200) });
    emit({ type: 'plan-empty', reason: 'No recognised intent in the query — refusing to improvise tool calls. (An LLM planner wires in here; see docs/INTEGRATION.md)' });
    return { verdict: 'NO_PLAN', calls: [], compile };
  }

  const idem = createIdempotencyStore(idempotency ?? memoryBacking());
  const fsr = createFsrModel();
  const calls = [];
  const results = {};

  async function exec(toolId, params, { retrying = false } = {}) {
    const tool = toolOf(toolId);
    if (!tool) {
      emit({ type: 'call-blocked', toolId, reason: 'Not in compiled surface — request fails closed' });
      log.warn('call.blocked', { tool: toolId });
      return { tool: toolId, ok: false, verdict: 'BLOCKED', evidence: 'tool excluded by compiler', params };
    }
    const key = await idempotencyKey({ task: query, tool: toolId, params });
    const gate = idem.begin(key);
    if (gate.replay) {
      const record = { tool: toolId, ok: true, params, verdict: 'CONFIRMED', evidence: 'exactly-once replay — this write already confirmed; NOT re-executed', latencyMs: 0, replayed: true };
      calls.push(record); results[toolId] = { ok: true, status: 200, data: gate.record?.data };
      emit({ type: 'call-replay', toolId, evidence: record.evidence });
      log.info('call.replayed', { tool: toolId, key });
      return record;
    }
    if (gate.inflight) {
      const record = { tool: toolId, ok: false, params, verdict: 'BLOCKED', evidence: 'in-flight write with identical idempotency key — duplicate dispatch refused', latencyMs: 0 };
      calls.push(record);
      emit({ type: 'call-blocked', toolId, reason: record.evidence });
      return record;
    }
    emit({ type: 'call-start', toolId, params, retrying });
    await sleep(300);
    const started = Date.now();
    const res = callTool(tool, params, world, faults);
    const latencyMs = Date.now() - started + res.latency;
    emit({ type: 'call-200', toolId, params, status: res.status, latencyMs, kind: tool.kind });
    await sleep(260);

    let verdict = 'CONFIRMED', evidence = 'read call — no postcondition required';
    if (tool.kind === 'write') {
      emit({ type: 'verify-start', toolId });
      await sleep(320);
      const v = verifyEffect(tool, params, world);
      verdict = v.verdict; evidence = v.evidence;
      emit({ type: 'verdict', toolId, verdict, evidence, readback: v.readback });
      await sleep(240);
    }
    const record = { tool: toolId, ok: res.ok, params, verdict, evidence, latencyMs };
    calls.push(record);
    results[toolId] = res;
    if (tool.kind === 'write') {
      record.fsr = recordOutcome(fsr, toolId, verdict === 'CONTRADICTED');
      if (verdict === 'CONTRADICTED') idem.release(key); else idem.confirm(key, { verdict, evidence });
    }
    log.info('call.done', { tool: toolId, kind: tool.kind, verdict, ms: latencyMs, retrying, ...(record.fsr ? { fsrMean: record.fsr.posteriorMean } : {}) });
    return record;
  }

  // Stage 1 — reads. Stage 2 — writes (composed from read results, then executed).
  for (const step of plan.steps.filter(s => s.stage === 1)) await exec(step.tool, step.params);
  resolveDeferred(plan.steps, query, world, results);

  for (const step of plan.steps.filter(s => s.stage === 2)) {
    let record = await exec(step.tool, step.params);
    let k = 1;
    while (record.verdict === 'CONTRADICTED' && k <= 2) {
      const next = resolveForRetry({ tool: step.tool, params: step.params }, world);
      emit({ type: 'retry', toolId: step.tool, reason: `Read-back CONTRADICTED — re-resolving target before retry (${k}/2)` });
      log.warn('call.retry', { tool: step.tool, attempt: k, evidence: record.evidence });
      await sleep(420);
      record = await exec(step.tool, next, { retrying: true });
      record = { ...record, note: `retry ${k}/2 after CONTRADICTED` };
      calls[calls.length - 1] = record;
      k++;
    }
    step.params = record.params; // keep step in sync for receipt clarity
  }

  emit({ type: 'phase', phase: 'RECEIPT', label: 'Hash-chaining and sealing the receipt' });
  await sleep(350);
  const lastByTool = new Map();
  for (const c of calls) lastByTool.set(c.tool, c);
  const verdict = [...lastByTool.values()].every(c => c.verdict === 'CONFIRMED') ? 'CONFIRMED' : 'CONTRADICTED';
  const fsrTable = summarizeAll(fsr);
  const receipt = await createReceipt({ task: query, compile, calls, verdict, prevHash, fsr: fsrTable });
  log.info('receipt.sealed', { id: receipt.id, verdict, calls: calls.length, falseSuccessCaught: receipt.falseSuccessCaught });
  emit({ type: 'receipt', receipt, calls, compile, verdict, fsr: fsrTable });

  return { receipt, calls, compile, verdict, fsr: fsrTable };
}

/* ───────────────────────── BASELINE (no Notary) ───────────────────────── */
async function runBaseline({ query, emit, world, faults, idempotency }) {
  emit({ type: 'phase', phase: 'BASELINE', label: 'Baseline agent — full registry, no certificate, no verifier' });
  await sleep(350);
  emit({ type: 'meter-baseline' });
  const registryMap = new Map(TOOL_REGISTRY.map(t => [t.id, t]));
  const fullCatalog = { selected: TOOL_REGISTRY }; // the unfiltered 86-tool surface
  const plan = buildPlan(query, fullCatalog, world);
  for (const note of plan.notes) emit({ type: 'plan-note', note });
  if (plan.steps.length === 0) {
    emit({ type: 'plan-empty', reason: 'No recognised intent in the query.' });
    return { baseline: true, calls: [], reveals: [], fooled: 0, verdict: 'NO_PLAN' };
  }
  const calls = [];
  const results = {};

  async function execBlind(toolId, params) {
    const tool = registryMap.get(toolId);
    emit({ type: 'call-start', toolId, params });
    await sleep(320);
    const started = Date.now();
    const res = callTool(tool, params, world, faults);
    const latencyMs = Date.now() - started + res.latency;
    emit({ type: 'call-200', toolId, status: res.status, latencyMs, kind: tool.kind });
    await sleep(220);
    if (tool.kind === 'write') emit({ type: 'claim', toolId });
    const record = { tool: toolId, ok: res.ok, params, verdict: 'CLAIMED', latencyMs };
    calls.push(record);
    results[toolId] = res;
    return record;
  }

  for (const step of plan.steps.filter(s => s.stage === 1)) await execBlind(step.tool, step.params);
  resolveDeferred(plan.steps, query, world, results);
  for (const step of plan.steps.filter(s => s.stage === 2)) await execBlind(step.tool, step.params);

  // ── Audit reveal: hand the world to Notary AFTER the fact ──
  emit({ type: 'phase', phase: 'AUDIT', label: 'Notary audits the baseline — reading real state back' });
  await sleep(450);
  const reveals = [];
  for (const c of calls) {
    const tool = registryMap.get(c.tool);
    if (tool.kind !== 'write') continue;
    const v = verifyEffect(tool, c.params, world);
    reveals.push({ tool: c.tool, verdict: v.verdict, evidence: v.evidence });
    emit({ type: 'audit-item', toolId: c.tool, verdict: v.verdict, evidence: v.evidence });
    await sleep(300);
  }
  const fooled = reveals.filter(r => r.verdict === 'CONTRADICTED').length;
  log.info('baseline.audited', { writes: reveals.length, fooled });
  emit({ type: 'audit', reveals, fooled, writes: reveals.length });
  return { baseline: true, calls, reveals, fooled, verdict: fooled > 0 ? 'FOOLED' : 'LUCKY' };
}
