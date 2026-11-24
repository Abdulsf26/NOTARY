// Notary — Guided Run: the interactive walkthrough.
// Every step computes for real — nothing is a scripted screencast.
//   Task → Compile (sliders, pin/block tools) → Certificate (the arithmetic)
//   → Act (one Next-click per call, live world state) → Receipt (seal + verify)
import { useEffect, useMemo, useRef, useState } from 'react';
import { TOOL_REGISTRY, TOTAL_REGISTRY_TOKENS } from './core/registry.js';
import { compileSurface } from './core/selector.js';
import { relevance, redundancy, featureVector, poolThreshold, scorerName } from './core/similarity.js';
import { buildPlan } from './core/planner.js';
import { createWorld, createFaults } from './core/world.js';
import { createGuidedSession } from './core/guided-session.js';
import { verifyChain } from './core/receipts.js';
import { CERTIFICATE_CALIBRATION } from './core/cert-calibration.js';

const HERO = 'Find the Q3 update in Drive, post the summary to the engineering Slack channel, append it to the Q3 Notion page, and log it on the Acme deal';
const EXAMPLES = [['Hero', HERO], ['Refund', 'Refund charge ch_123 for the Acme invoice'], ['Weather', 'What is the weather in Chennai tomorrow?'], ['Junk', 'asdkfj qqq zzz']];
const fmt = n => Math.round(n).toLocaleString();
const STEPS = ['Task', 'Compile', 'Certificate', 'Act', 'Receipt'];

export default function GuidedRun({ receipts, setReceipts }) {
  const [step, setStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);
  const [query, setQuery] = useState(HERO);
  const [budget, setBudget] = useState(900);
  const [lambda, setLambda] = useState(0.5);
  const [pin, setPin] = useState(() => new Set());
  const [block, setBlock] = useState(() => new Set());
  const [faultsOn, setFaultsOn] = useState(true);
  const [guided, setGuided] = useState(null);        // { session, world, faults } — created on entering Act
  const [events, setEvents] = useState([]);
  const [worldTick, setWorldTick] = useState(0);
  const [acting, setActing] = useState(false);
  const [sealed, setSealed] = useState(null);
  const [chain, setChain] = useState(null);
  const guidedRef = useRef(null);
  const timelineRef = useRef(null);
  useEffect(() => { if (timelineRef.current) timelineRef.current.scrollTop = timelineRef.current.scrollHeight; }, [events]);

  const go = (n) => { setStep(n); setMaxStep(m => Math.max(m, n)); if (typeof window !== 'undefined') window.scrollTo(0, 0); };

  // live compile — recomputes on every slider/checkbox change (6 ms)
  const compile = useMemo(
    () => compileSurface(query || ' ', TOOL_REGISTRY, { budget, lambda, pin, block }),
    [query, budget, lambda, pin, block]
  );
  const poolRows = useMemo(() => {
    const sel = new Set(compile.selected.map(t => t.id));
    return TOOL_REGISTRY
      .map(t => ({ t, r: relevance(t, query || ' '), sig: sel.size ? Math.max(0, ...compile.selected.map(s => redundancy(t, s))) : 0 }))
      .filter(x => x.r >= 0.05 || sel.has(x.t.id))
      .sort((a, b) => b.r - a.r)
      .slice(0, 14);
  }, [query, compile]);

  const toggleConstraint = (id, kind, current, other, setCurrent, setOther) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    setCurrent(next);
    if (next.has(id) && other.has(id)) { const o = new Set(other); o.delete(id); setOther(o); }
  };

  const beginExecution = () => {
    const world = createWorld();
    const faults = createFaults(); faults.silentNoOp = faultsOn;
    const session = createGuidedSession({ query, budget, lambda, pin, block, world, faults });
    guidedRef.current = { session, world, faults };
    setGuided({ world, faults });
    setEvents([]); setWorldTick(0); setChain(null); setSealed(null);
    go(3);
  };

  const nextAction = async () => {
    if (!guidedRef.current || acting) return;
    setActing(true);
    try {
      const { session } = guidedRef.current;
      const { events: evs, phase } = await session.next();
      setEvents(prev => [...prev, ...evs.map(e => ({ ...e, id: Math.random().toString(36).slice(2) }))]);
      setWorldTick(t => t + 1);
      if (phase === 'done') setEvents(prev => [...prev, { type: 'done-hint', id: Math.random().toString(36).slice(2), note: 'Plan complete — seal the receipt (or inspect the world first).' }]);
    } finally { setActing(false); }
  };

  const sess = guidedRef.current?.session ?? null;
  const summary = sess?.summary() ?? { verdict: '—', calls: [], fsr: [] };
  const sessionDone = sess ? sess.state.done : false;
  const lastCall = summary.calls.length ? summary.calls[summary.calls.length - 1] : null;
  const retryable = !!(lastCall && lastCall.verdict === 'CONTRADICTED' && sess && sess.state.retriesUsed <= 2);
  const runComplete = sessionDone;                 // plan exhausted, nothing retryable
  const allConfirmed = runComplete && summary.verdict === 'CONFIRMED';
  const allContradicted = runComplete && summary.verdict === 'CONTRADICTED';
  const plan = sess?.plan ?? null;

  const sealReceipt = async () => {
    const prevHash = receipts.length ? receipts[receipts.length - 1].hash : null;
    const receipt = await guidedRef.current.session.seal(prevHash);
    setSealed(receipt);
    setReceipts(rs => [...rs, receipt]);
    go(4);
  };

  const downloadReceipt = () => {
    if (!sealed) return;
    const blob = new Blob([JSON.stringify(sealed, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${sealed.id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const world = guidedRef.current?.world ?? null;
  // read world state at render time (worldTick drives re-render)
  void worldTick;
  const worldStats = world ? [
    ['slack', world.slack.messages.length, 'slack messages'],
    ['notion blocks', world.notion.pages['page-q3']?.blocks?.length ?? 0, 'notion blocks'],
    ['crm activities', world.crm.activities.length, 'crm activities'],
    ['sent mail', world.gmail.sent.length, 'sent mail'],
    ['jira issues', Object.keys(world.jira.issues).length, 'jira issues'],
    ['github issues', Object.keys(world.github.issues).length, 'github issues'],
    ['stripe invoices', Object.keys(world.stripe.invoices).length, 'invoices'],
    ['rows', world.postgres.rows.length, 'postgres rows'],
  ] : [];

  return (
    <div>
      <h2 style={{ margin: '2px 0 2px' }}>Guided Run — every step computed live</h2>
      <div className="sub" style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-2)', fontSize: 12.5, marginBottom: 12 }}>
        Type a task, then drive it from quote to receipt. Sliders recompile instantly; every tool call is one deliberate click. Nothing is pre-baked.
      </div>

      {/* ── stepper ── */}
      <div className="gr-stepper" role="tablist" aria-label="Guided steps">
        {STEPS.map((label, i) => {
          const reachable = i <= maxStep;
          const state = i === step ? 'active' : i < step ? 'done' : '';
          return <button key={label} className={'gr-step ' + state} disabled={!reachable} onClick={() => reachable && go(i)}>{i + 1} · {label}</button>;
        })}
      </div>

      {/* ══════════ STEP 1 · TASK ══════════ */}
      {step === 0 && (
        <section className="panel">
          <h2>1 · The task</h2>
          <div className="sub">Free text. The compiler and planner do the rest — this is the only thing you type.</div>
          <textarea rows={3} value={query} onChange={e => setQuery(e.target.value)} aria-label="Task" spellCheck={false} />
          <div className="chips" style={{ marginTop: 8 }}>
            {EXAMPLES.map(([label, q]) => <button key={label} className="chip" type="button" onClick={() => setQuery(q)}>{label}</button>)}
          </div>
          <div className="step-cta">
            <span className="mono muted" style={{ fontSize: 10, alignSelf: 'center' }}>{(query.trim().length ? query.trim().split(/\s+/).length : 0)} words · {TOOL_REGISTRY.length} tools in registry · {fmt(TOTAL_REGISTRY_TOKENS)} registry tokens</span>
            <button className="btn primary" onClick={() => go(1)} disabled={!query.trim()}>Compile it →</button>
          </div>
        </section>
      )}

      {/* ══════════ STEP 2 · COMPILE ══════════ */}
      {step === 1 && (
        <div className="grid g-2">
          <section className="panel">
            <h2>2 · Compile the surface</h2>
            <div className="sub">Budget and redundancy sliders recompile live. Pin a tool to force it in (hard budget still applies), block one to forbid it.</div>
            <div className="ctl-row"><label>Token budget B</label><input type="range" min={200} max={2400} step={20} value={budget} onChange={e => setBudget(+e.target.value)} /><b style={{ color: 'var(--ledger)' }}>{budget}</b></div>
            <div className="ctl-row"><label>λ redundancy</label><input type="range" min={0} max={1.5} step={0.05} value={lambda} onChange={e => setLambda(+e.target.value)} /><b style={{ color: 'var(--ledger)' }}>{lambda.toFixed(2)}</b></div>

            <div className="meter-lbl" style={{ marginTop: 14 }}><span>candidate pool (r ≥ {poolThreshold().toFixed(2)})</span><span>{poolRows.length} shown</span></div>
            {poolRows.map(({ t, r, sig }) => {
              const state = pin.has(t.id) ? 'pin' : block.has(t.id) ? 'block' : 'auto';
              const inSurface = compile.selected.some(x => x.id === t.id);
              return (
                <div key={t.id} className={'pool-row' + (inSurface ? ' sel' : '')}>
                  <span className="mono" style={{ fontSize: 10, color: inSurface ? 'var(--ledger)' : 'var(--ink-2)' }}>{inSurface ? '●' : '○'}</span>
                  <span title={t.desc}><b style={{ fontFamily: 'var(--mono)', fontSize: 10.5 }}>{t.id}</b>
                    <small style={{ display: 'block', color: 'var(--ink-2)', fontSize: 9 }}>{fmt(t.cost)} tok · σ→sel {sig.toFixed(2)}{compile.forced?.includes(t.id) ? ' · forced' : ''}</small>
                    <span className="r-bar" style={{ marginTop: 2 }}><span style={{ display: 'block', width: `${Math.min(100, r * 100)}%`, height: '100%', background: 'var(--ledger)' }} /></span>
                  </span>
                  <span className="mono" style={{ fontSize: 10, textAlign: 'right' }}>{r.toFixed(3)}</span>
                  <span className="mono muted" style={{ fontSize: 8, textAlign: 'right', textTransform: 'uppercase' }}>{t.kind}</span>
                  <span className="seg3" role="group" aria-label={`constraint for ${t.id}`}>
                    {['auto', 'pin', 'block'].map(mode => (
                      <button key={mode} className={state === mode ? (mode === 'pin' ? 'on-pin' : mode === 'block' ? 'on-block' : 'on') : ''} onClick={() => {
                        if (state === mode) return;
                        if (mode === 'auto') { const p = new Set(pin); p.delete(t.id); setPin(p); const b = new Set(block); b.delete(t.id); setBlock(b); }
                        else if (mode === 'pin') toggleConstraint(t.id, 'pin', pin, block, setPin, setBlock);
                        else toggleConstraint(t.id, 'block', block, pin, setBlock, setPin);
                      }}>{mode}</button>
                    ))}
                  </span>
                </div>
              );
            })}
            <p className="mono muted" style={{ fontSize: 9, marginTop: 8 }}>Pins are forced subject to the hard budget; blocks never run. The (1−1/e) guarantee applies to the unforced remainder — see docs/ARCHITECTURE.md.</p>
          </section>

          <section className="panel">
            <h2>What was chosen &amp; why</h2>
            <div className="sub">F(S) = Σ r(t|q) − λ·Σ σ(ti,tj) s.t. Σ d(t) ≤ B · scorer: {scorerName}</div>
            <div className="meter-lbl"><span>compiled surface</span><span>{compile.selected.length} tools · {fmt(compile.usedCost)} / {budget} tok</span></div>
            <div className="meter good" style={{ marginBottom: 10 }}><div style={{ width: `${Math.min(100, (compile.usedCost / TOTAL_REGISTRY_TOKENS) * 100)}%` }} /><span className="meter-tag">{compile.selected.length ? 'CARRIED ON THE WIRE' : 'EMPTY — FAIL CLOSED'}</span></div>
            {compile.selected.map(t => {
              const f = featureVector(t, query || ' ');
              const why = [f.serviceHit ? 'service named' : null, f.nameHit > 0 ? `name ${(f.nameHit * 100) | 0}%` : null, `covers ${(f.coverage * 100) | 0}%`].filter(Boolean).join(' · ');
              return (
                <div key={t.id} className="kv" style={{ alignItems: 'baseline' }}>
                  <span><b style={{ fontFamily: 'var(--mono)' }}>{t.id}</b><small style={{ display: 'block', textTransform: 'none', letterSpacing: 0, color: 'var(--ink-2)', fontSize: 9, marginTop: 1 }}>{why}</small></span>
                  <span className="mono">r {compile.relevance.get(t.id).toFixed(2)} · {fmt(t.cost)} tok</span>
                </div>
              );
            })}
            {(compile.forced ?? []).map(id => <p key={id} className="mono" style={{ fontSize: 9, color: 'var(--ledger)', margin: '4px 2px' }}>forced in by you: {id}</p>)}
            {(compile.pinNotes ?? []).map((n, i) => <p key={i} className="mono" style={{ fontSize: 9, color: 'var(--oxide)', margin: '4px 2px' }}>{n}</p>)}
            <div className="kv" style={{ marginTop: 10 }}><span>objective F</span><span>{compile.F.toFixed(3)} (greedy {compile.greedyF.toFixed(3)} · seeds {compile.exploredSeeds})</span></div>
            <div className="kv"><span>λ requested → used</span><span>{compile.lambdaRequested.toFixed(2)} → {compile.lambdaUsed.toFixed(3)}{compile.wasClamped ? ` (clamped; λ_max = ${compile.lambdaMax.toFixed(4)})` : ''}</span></div>
            <div className="kv"><span>registry</span><span>{TOOL_REGISTRY.length} tools · working set {compile.registrySize} (pins/blocks removed)</span></div>
            {compile.nearMisses?.length > 0 && (
              <div className="arch-note" style={{ marginTop: 10 }}>
                <b>excluded for redundancy:</b><br />
                {compile.nearMisses.map(m => <span key={m.tool.id} style={{ display: 'block' }}>{m.tool.id} — max σ {m.maxSigma.toFixed(2)} · r {m.r.toFixed(2)}</span>)}
              </div>
            )}
            <div className="step-cta">
              <button className="btn" onClick={() => go(0)}>← Task</button>
              <button className="btn primary" onClick={() => go(2)}>Issue certificate →</button>
            </div>
          </section>
        </div>
      )}

      {/* ══════════ STEP 3 · CERTIFICATE ══════════ */}
      {step === 2 && <CertStep compile={compile} onBack={() => go(1)} onNext={beginExecution} />}

      {/* ══════════ STEP 4 · ACT ══════════ */}
      {step === 3 && guided && (
        <div className="grid g-2">
          <section className="panel">
            <h2>4 · Act — one call per click</h2>
            <div className="sub">Every write is re-read back. The fault injector swallows the first write — watch the lie detector fire.</div>
            <label className="ctl-row toggle" title="First write tool call returns 200 OK and persists nothing">
              <input type="checkbox" checked={faultsOn} disabled={events.length > 0} onChange={e => setFaultsOn(e.target.checked)} />
              <span>SILENT NO-OP INJECTION {faultsOn ? '— ARMED' : '— OFF'}</span>
            </label>
            <div className="arch-note" style={{ marginBottom: 10 }}>
              plan: {plan ? (plan.steps.length ? plan.steps.map(s => `${s.stage === 1 ? 'READ' : 'WRITE'} ${s.tool}`).join(' → ') : 'NO PLAN — fail-closed: zero calls will be made, no receipt can exist') : '…'}
              {(plan?.notes ?? []).map((n, i) => <span key={i} style={{ display: 'block', color: 'var(--oxide)' }}>{n}</span>)}
            </div>
            <div className="timeline" style={{ maxHeight: 320 }} ref={timelineRef}>
              {events.length === 0 && <div className="mono muted" style={{ padding: 14, textAlign: 'center', border: '1px dashed var(--line)', borderRadius: 2 }}>No calls yet — press Next call.</div>}
              {events.map(ev => <GuidedEvent key={ev.id} ev={ev} />)}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="btn primary" onClick={nextAction} disabled={acting || runComplete}>
                {acting ? 'Running…' : retryable ? '↻ Retry (bounded)' : runComplete ? 'Done' : 'Next call →'}
              </button>
              <button className="btn" onClick={() => { setGuided(null); guidedRef.current = null; setEvents([]); go(1); }}>Reset</button>
              <button className="btn" style={{ marginLeft: 'auto' }} disabled={!runComplete || summary.calls.length === 0} onClick={sealReceipt}>Seal receipt →</button>
            </div>
            {allContradicted && <div className="flash CONTRADICTED" style={{ marginTop: 10 }}>UNRESOLVED — HUMAN ESCALATION<small>the bounded retry budget (2) was exhausted; the receipt records every CONTRADICTED call</small></div>}
            {allConfirmed && <div className="flash CONFIRMED" style={{ marginTop: 10 }}>CONFIRMED<small>every write verified against real state</small></div>}
          </section>

          <section className="panel">
            <h2>The world, live</h2>
            <div className="sub">Real state of the mock MCP backend — what the read-backs verify against.</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {worldStats.map(([k, n]) => (
                <div key={k} className="world-cell"><div className="n">{n}</div><div className="d">{k}</div></div>
              ))}
            </div>
            <div className="kv" style={{ marginTop: 12 }}><span>calls made</span><span>{summary.calls.length}</span></div>
            <div className="kv"><span>verdict</span><span style={{ color: allConfirmed ? 'var(--ledger)' : allContradicted ? 'var(--oxide)' : 'var(--ink-2)' }}>{summary.verdict}</span></div>
            <div className="kv"><span>false successes caught</span><span>{summary.calls.filter(c => c.verdict === 'CONTRADICTED').length}</span></div>
            {/* worldTick keeps the counts fresh after each click */}
          </section>
        </div>
      )}

      {/* ══════════ STEP 5 · RECEIPT ══════════ */}
      {step === 4 && sealed && (
        <section className="panel">
          <h2>5 · The receipt</h2>
          <div className="sub">SHA-256 hash-chained to the previous receipt on the ledger. Tamper with any byte and the chain breaks.</div>
          <div className="receipt" style={{ maxWidth: 560 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <b style={{ color: 'var(--ink)' }}>{sealed.id}</b>
              <span className={'stamp ' + (sealed.verdict === 'CONFIRMED' ? 'ok' : 'contra')}>{sealed.verdict}</span>
            </div>
            <div className="kv" style={{ marginTop: 8 }}><span>surface</span><span style={{ textAlign: 'right' }}>{sealed.surface.map(x => x.id).join(', ')}</span></div>
            <div className="kv"><span>certificate</span><span>≤ {fmt(sealed.certificate.bound)} tok · α ≤ {sealed.certificate.alpha}</span></div>
            <div className="kv"><span>false successes caught</span><span>{sealed.falseSuccessCaught}</span></div>
            {sealed.fsr?.map(f => <div className="kv" key={f.tool}><span>FSR p̂({f.tool})</span><span>{f.posteriorMean.toFixed(3)} [{f.wilson95[0].toFixed(2)}–{f.wilson95[1].toFixed(2)}] · n={f.n}</span></div>)}
            <div className="kv"><span>prev</span><span className="hash">{String(sealed.prev).slice(0, 26)}…</span></div>
            <div className="kv"><span>hash</span><span className="hash">{sealed.hash.slice(0, 46)}…</span></div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button className="btn" onClick={downloadReceipt}>Download receipt JSON</button>
            <button className="btn" onClick={async () => setChain(await verifyChain(receipts))}>Verify chain ({receipts.length} on ledger)</button>
            <button className="btn primary" onClick={() => { setQuery(HERO); setPin(new Set()); setBlock(new Set()); setGuided(null); guidedRef.current = null; setEvents([]); setSealed(null); go(0); setMaxStep(0); }}>Run another task →</button>
          </div>
          {chain && <div className={'flash ' + (chain.valid ? 'CONFIRMED' : 'CONTRADICTED')} style={{ marginTop: 10 }}>{chain.valid ? 'CHAIN VALID' : 'CHAIN BROKEN'}<small>{chain.checked} receipts checked · {chain.problems.length} problem(s)</small></div>}
        </section>
      )}
    </div>
  );
}

/* ───────── Certificate step (live arithmetic) ───────── */
function CertStep({ compile, onBack, onNext }) {
  const cert = compile.certificate;
  const sz = compile.selected.length;
  // calibration grid is n=1..8; larger surfaces reuse the n=8 factor (most conservative tightening)
  const factor = CERTIFICATE_CALIBRATION.inflations[String(Math.min(8, Math.max(1, sz)))] ?? 1;
  const tightened = Math.round(cert.stochastic * factor) + cert.deterministic;
  return (
    <section className="panel">
      <h2>3 · The certificate — the arithmetic, shown</h2>
      <div className="sub">P(actual spend &gt; bound) ≤ 0.05, from a union bound alone — no independence assumption, no data. Conformal tightening shown alongside.</div>
      <div className="cert" style={{ maxWidth: 460 }}>
        <div className="mono" style={{ fontSize: 9, letterSpacing: '.2em', color: 'var(--ink-2)' }}>PRE-FLIGHT COST CERTIFICATE</div>
        <div className="bound">≤ {fmt(cert.bound)} <small>tokens</small></div>
        <div className="row"><span>deterministic Σ d(t) (known)</span><span>{fmt(cert.deterministic)}</span></div>
        <div className="row"><span>stochastic Σ Q̂(1 − α/{compile.selected.length}) per tool</span><span>{fmt(cert.stochastic)}</span></div>
        <div className="row"><span>conformal-tightened estimate (|S|={compile.selected.length}, ×{factor.toFixed(3)})</span><span>≈ {fmt(tightened)} (est., not the guarantee)</span></div>
        <div className="row"><span>failure probability</span><span>P ≤ 0.05 · union bound</span></div>
        <div className="row"><span>per-tool confidence</span><span>≥ {(cert.perToolConfidence * 100).toFixed(1)}%</span></div>
      </div>
      <div className="arch-note" style={{ marginTop: 10 }}>
        Bonferroni splits α across {compile.selected.length} tool{compile.selected.length === 1 ? '' : 's'} (α/|S| each), so the guarantee needs nothing but the quantile estimate per tool.
        The guarantee attaches to the <b>bound</b>, never to the tightened estimate. Calibration (npm run calibrate): held-out breach 4.22–5.82% at α = 0.05 after conformal tightening.
      </div>
      <div className="step-cta">
        <button className="btn" onClick={onBack}>← Recompile</button>
        <button className="btn primary" onClick={onNext}>Begin execution →</button>
      </div>
    </section>
  );
}

/* ───────── event row renderer ───────── */
function GuidedEvent({ ev }) {
  switch (ev.type) {
    case 'call-start': return <div className="ev verify"><span className="tag">CALL →</span><span>{ev.toolId}{ev.retrying ? '  (RETRY)' : ''}<small>{JSON.stringify(ev.params).slice(0, 120)}</small></span></div>;
    case 'call-200': return <div className="ev write"><span className="tag">{ev.kind === 'write' ? 'WRITE 200' : 'READ 200'}</span><span>{ev.toolId}<small>returned 200 OK — proving nothing yet</small></span></div>;
    case 'call-replay': return <div className="ev good"><span className="tag">REPLAY ✓</span><span>{ev.toolId}<small>{ev.evidence}</small></span></div>;
    case 'call-blocked': return <div className="ev bad"><span className="tag">BLOCKED</span><span>{ev.toolId}<small>{ev.reason}</small></span></div>;
    case 'verdict': return <div className={'ev ' + (ev.verdict === 'CONFIRMED' ? 'good' : 'bad')}><span className="tag">{ev.verdict}</span><span>{ev.evidence}<small>read-back via {ev.readback}</small></span></div>;
    case 'retry': return <div className="ev bad"><span className="tag">RETRY</span><span>{ev.reason}</span></div>;
    case 'deferral': return <div className="ev info"><span className="tag">COMPOSED</span><span>{ev.note}</span></div>;
    case 'done-hint': return <div className="ev info"><span className="tag">PLAN DONE</span><span>{ev.note}</span></div>;
    default: return null;
  }
}
