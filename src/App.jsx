// Notary — the transaction layer for AI actions.
// Registry → Tool-Surface Compiler → Cost Certificate → Verified execution → Signed receipt.
import { useCallback, useEffect, useMemo, useRef, useState, useDeferredValue } from 'react';
import { TOOL_REGISTRY, TOTAL_REGISTRY_TOKENS } from './core/registry.js';
import { compileSurface } from './core/selector.js';
import { runTask, HERO_TASK } from './core/agent.js';
import { createWorld, createFaults } from './core/world.js';
import { verifyChain } from './core/receipts.js';
import { localStorageBacking } from './core/idempotency.js';
import GuidedRun from './GuidedRun.jsx';
import './index.css';

const CONTEXT_WINDOW = 200_000;
const speak = (text) => { try { const u = new SpeechSynthesisUtterance(text); u.lang = 'en-IN'; u.rate = 1.02; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch { /* voice optional */ } };
const loadLedger = () => { try { return JSON.parse(localStorage.getItem('notary.receipts.v1') || '[]'); } catch { return []; } };
const saveLedger = (rs) => { try { localStorage.setItem('notary.receipts.v1', JSON.stringify(rs)); } catch {} };
const fmt = n => Math.round(n).toLocaleString('en-IN');

function Seal({ size = 44 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-label="Notary seal">
      <circle cx="24" cy="24" r="22" stroke="#17493a" strokeWidth="2.4" />
      <circle cx="24" cy="24" r="16.5" stroke="#17493a" strokeWidth="1.1" strokeDasharray="3 3" />
      <path d="M15.5 24.5l6.2 6.2L33.5 18" stroke="#17493a" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

export default function App() {
  const [tab, setTab] = useState('demo');
  const [receipts, setReceipts] = useState(loadLedger);
  useEffect(() => saveLedger(receipts), [receipts]);

  const stats = useMemo(() => {
    const writes = receipts.reduce((s, r) => s + r.calls.filter(c => c.verdict === 'CONFIRMED' || c.verdict === 'CONTRADICTED').length, 0);
    const caught = receipts.reduce((s, r) => s + (r.falseSuccessCaught || 0), 0);
    return { actions: receipts.length, writes, caught, fsr: writes ? ((caught / writes) * 100).toFixed(0) : '0' };
  }, [receipts]);

  return (
    <div>
      <header className="hdr">
        <div className="brand">
          <Seal size={46} />
          <div>
            <h1>NOTARY</h1>
            <small>QUOTE BEFORE · RECEIPT AFTER · THE TRANSACTION LAYER FOR AI ACTIONS</small>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span className="mono muted" style={{ fontSize: 10 }}>HACKATHON2WIN · Shiv Nadar University Chennai</span>
          <span className="track-badge">TRACK 1 — MAKE MCP MATTER</span>
        </div>
      </header>

      <nav className="tabs">
        {[['demo', 'Demo Console'], ['guided', 'Guided Run'], ['playground', 'Compiler Playground'], ['ledger', `Receipts Ledger (${receipts.length})`], ['approach', 'How It Works']].map(([id, label]) => (
          <button key={id} className={'tab' + (tab === id ? ' active' : '')} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>

      <main className="wrap">
        <div className="stat-strip">
          <div className="stat"><div className="n">40–72%</div><div className="d">Context tax measured on real MCP stacks (143k/200k tokens)</div></div>
          <div className="stat"><div className="n">43→14%</div><div className="d">Tool-selection accuracy collapse past ~50 tools</div></div>
          <div className="stat"><div className="n">0</div><div className="d">Writes any vendor can prove landed (until Notary)</div></div>
          <div className="stat"><div className="n">{(stats.caught)}</div><div className="d">False successes caught this session (FSR → 0)</div></div>
          <div className="stat"><div className="n">1−1/e</div><div className="d">Provable fraction of optimal surface selection (Sviridenko)</div></div>
        </div>

        {tab === 'demo' && <DemoConsole receipts={receipts} setReceipts={setReceipts} />}
        {tab === 'guided' && <GuidedRun receipts={receipts} setReceipts={setReceipts} />}
        {tab === 'playground' && <Playground />}
        {tab === 'ledger' && <Ledger receipts={receipts} setReceipts={setReceipts} />}
        {tab === 'approach' && <Approach />}
      </main>

      <footer className="foot">
        <span>NOTARY · formerly RECEIPT · wHACKiest 2026 · Track: Make MCP Matter — Less Magic, More Utility</span>
        <span>Quote before. Receipt after. Nothing moves without both.</span>
      </footer>
    </div>
  );
}

/* ─────────────── DEMO CONSOLE ─────────────── */
function DemoConsole({ receipts, setReceipts }) {
  const [query, setQuery] = useState(HERO_TASK);
  const [budget, setBudget] = useState(900);
  const [lambda, setLambda] = useState(0.5);
  const [faultsOn, setFaultsOn] = useState(true);
  const [running, setRunning] = useState(false);
  const [timeline, setTimeline] = useState([]);
  const [compile, setCompile] = useState(null);
  const [cert, setCert] = useState(null);
  const [flash, setFlash] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [meterPct, setMeterPct] = useState(100);
  const [compileMs, setCompileMs] = useState(null);
  const [mode, setMode] = useState('notary');   // 'notary' | 'baseline'
  const [audit, setAudit] = useState(null);
  const timelineRef = useRef(null);

  useEffect(() => { if (timelineRef.current) timelineRef.current.scrollTop = timelineRef.current.scrollHeight; }, [timeline]);

  const push = useCallback((ev) => setTimeline(t => [...t, { id: Math.random().toString(36).slice(2), ...ev }]), []);

  function switchMode(next) {
    setMode(next);
    setTimeline([]); setCompile(null); setCert(null); setFlash(null); setReceipt(null); setAudit(null); setMeterPct(100); setCompileMs(null);
  }

  async function run() {
    setRunning(true); setTimeline([]); setCompile(null); setCert(null); setFlash(null); setReceipt(null); setAudit(null); setMeterPct(100); setCompileMs(null);
    const world = createWorld();
    const faults = createFaults(); faults.silentNoOp = faultsOn;
    const prevHash = receipts.length ? receipts[receipts.length - 1].hash : null;
    const t0 = performance.now();
    try {
      await runTask({
        query, budget, lambda, world, faults, prevHash, baseline: mode === 'baseline', idempotency: localStorageBacking(),
        emit: (e) => {
          switch (e.type) {
            case 'phase': push({ cls: 'phase', tag: 'PHASE', text: e.label }); break;
            case 'surface': {
              setCompile(e.compile);
              setCompileMs(Math.round(performance.now() - t0));
              setMeterPct(e.compile.usedCost > 0 ? Math.max(2, (e.compile.usedCost / TOTAL_REGISTRY_TOKENS) * 100) : 0);
              push({ cls: 'info', tag: 'SURFACE', text: `Compiled ${e.compile.selected.length} tools · ${fmt(e.compile.usedCost)} / ${budget} tokens · F = ${e.compile.F.toFixed(3)}`, sub: e.compile.selected.map(t => t.id).join('  ·  ') });
              break;
            }
            case 'certificate': setCert(e.certificate); push({ cls: 'phase', tag: 'CERTIFIED', text: e.certificate.statement, sub: e.certificate.guarantee }); break;
            case 'plan-note': push({ cls: 'info', tag: 'PLANNER', text: e.note }); break;
            case 'plan-empty': push({ cls: 'bad', tag: 'NO PLAN', text: e.reason }); break;
            case 'call-replay': push({ cls: 'good', tag: 'REPLAY ✓', text: e.evidence }); break;
            case 'call-start': push({ cls: 'verify', tag: 'CALL →', text: `${e.toolId}${e.retrying ? '  (RETRY)' : ''}`, sub: JSON.stringify(e.params).slice(0, 140) }); break;
            case 'call-200': push(e.kind === 'write'
              ? { cls: 'write', tag: `WRITE 200`, text: `${e.toolId} returned OK in ${e.latencyMs} ms — but is that true?` }
              : { cls: 'read', tag: `READ ${e.status}`, text: `${e.toolId} · ${e.latencyMs} ms` }); break;
            case 'verify-start': push({ cls: 'verify', tag: 'VERIFY', text: `Reading back real state for ${e.toolId}…` }); break;
            case 'verdict':
              push({ cls: e.verdict === 'CONFIRMED' ? 'good' : 'bad', tag: e.verdict, text: e.evidence, sub: `read-back via ${e.readback}` });
              if (e.verdict === 'CONTRADICTED') setFlash('CONTRADICTED');
              break;
            case 'retry': push({ cls: 'bad', tag: 'RETRY', text: e.reason }); setFlash(null); break;
            case 'call-blocked': push({ cls: 'bad', tag: 'BLOCKED', text: `${e.toolId} — ${e.reason}` }); break;
            case 'meter-baseline': push({ cls: 'bad', tag: 'CONTEXT', text: `All 86 tools on the wire (~${fmt(TOTAL_REGISTRY_TOKENS)} tokens simulated; 143k+ on real stacks) — uncompressed, uncertified` }); break;
            case 'claim': push({ cls: 'write', tag: 'CLAIM ✓', text: `${e.toolId} → “Done!” (believed on 200 OK — never verified)` }); break;
            case 'audit-item': push({ cls: e.verdict === 'CONFIRMED' ? 'good' : 'bad', tag: 'AUDIT·' + e.verdict, text: e.evidence }); break;
            case 'audit':
              setAudit(e);
              push({ cls: e.fooled ? 'bad' : 'good', tag: 'VERDICT', text: e.fooled ? `Baseline was fooled — ${e.fooled}/${e.writes} writes claimed success that never happened` : 'Baseline got lucky this time — but nothing proves it' });
              break;
            case 'receipt': {
              setReceipt(e.receipt);
              setReceipts(rs => [...rs, e.receipt]);
              setFlash(e.verdict);
              const caught = e.receipt.falseSuccessCaught;
              speak(caught > 0
                ? `Action verified. ${caught} false success caught and corrected. Receipt signed.`
                : 'Action verified. Receipt signed.');
              push({ cls: 'good', tag: 'RECEIPT', text: `Sealed ${e.receipt.id} · hash ${e.receipt.hash.slice(0, 18)}…` });
              break;
            }
            default: break;
          }
        },
      });
    } catch (err) {
      push({ cls: 'bad', tag: 'ERROR', text: String(err?.message || err) });
    } finally {
      setRunning(false);
    }
  }

  const registryPct = 100;
  const compiledTokens = compile?.usedCost ?? TOTAL_REGISTRY_TOKENS;

  return (
    <div className="grid g-2">
      <section className="panel">
        <h2>Live Run — The Three Beats</h2>
        <div className="sub">{mode === 'notary' ? 'Beat 1 the bomb · Beat 2 the lie detector · Beat 3 the voice' : 'Same agent, same faults — zero protection. Watch it get fooled, then audit it.'}</div>

        <textarea rows={2} value={query} onChange={e => setQuery(e.target.value)} aria-label="Task" spellCheck={false} />
        <div className="chips" aria-label="Examples">
          {[['Hero', HERO_TASK], ['Refund a charge', 'Refund charge ch_123 for the Acme invoice'], ['Weather', 'What is the weather in Chennai tomorrow?'], ['Out of scope', 'asdkfj qqq zzz']].map(([label, q]) => (
            <button key={label} className="chip" onClick={() => setQuery(q)} type="button">{label}</button>
          ))}
        </div>
        <div className="ctl-row"><label>Token budget B</label><input type="range" min={200} max={2400} step={20} value={budget} onChange={e => setBudget(+e.target.value)} /><b style={{ color: 'var(--gold)' }}>{budget}</b></div>
        <div className="ctl-row"><label>λ redundancy</label><input type="range" min={0} max={1.5} step={0.05} value={lambda} onChange={e => setLambda(+e.target.value)} /><b style={{ color: 'var(--gold)' }}>{lambda.toFixed(2)}</b></div>
        <label className="ctl-row toggle" title="Simulate a write tool that returns 200 OK but never persists — the exact silent no-op class Notary catches">
          <input type="checkbox" checked={faultsOn} onChange={e => setFaultsOn(e.target.checked)} />
          <span>SILENT NO-OP INJECTION</span>
          {faultsOn && <span className="armed">● ARMED — the agent will falsely claim success</span>}
        </label>

        <div className="seg" role="tablist" aria-label="Scenario">
          <button className={mode === 'notary' ? 'on' : ''} onClick={() => switchMode('notary')} disabled={running}>Protected by Notary</button>
          <button className={mode === 'baseline' ? 'on danger' : ''} onClick={() => switchMode('baseline')} disabled={running}>Baseline · No Notary</button>
        </div>
        <button className="run" disabled={running} onClick={run}>{running ? 'Working…' : mode === 'baseline' ? 'Run — Unprotected' : 'Run — Protected by Notary'}</button>

        <div style={{ marginTop: 16 }}>
          <div className="meter-lbl"><span>BEAT 1 — context on the wire, before the user speaks</span><span>{fmt(TOTAL_REGISTRY_TOKENS)} tokens (registry)</span></div>
          <div className="meter" style={{ marginBottom: 8 }}><div style={{ width: registryPct + '%' }} /><span className="meter-tag">FULL REGISTRY · 100%</span></div>
          <div className="meter good"><div style={{ width: meterPct + '%' }} /><span className="meter-tag">COMPILED · {meterPct.toFixed(0)}%</span></div>
          <div className="meter-lbl"><span>Notary compiles the decision away pre-inference — the model barely has to choose</span><span>{compile ? fmt(compiledTokens) + ' tokens' : ''}</span></div>
        </div>

        {mode === 'baseline' && !cert && (
          <div className="arch-note" style={{ marginTop: 12, borderColor: 'var(--red)', color: 'var(--oxide)' }}>NO CERTIFICATE — the entire registry was handed to the model. Cost: unknowable. Outcome: unverifiable.</div>
        )}
        {cert && (
          <div className="cert" style={{ marginTop: 12 }}>
            <div className="mono" style={{ fontSize: 10, letterSpacing: '.2em', color: 'var(--gold)' }}>PRE-FLIGHT COST CERTIFICATE</div>
            <div className="bound">≤ {fmt(cert.bound)} <small>TOKENS</small></div>
            <div className="row"><span>deterministic (surface d(S))</span><span>{fmt(cert.deterministic)}</span></div>
            <div className="row"><span>stochastic (Bonferroni quantiles)</span><span>{fmt(cert.stochastic)}</span></div>
            <div className="row"><span>failure probability</span><span>P ≤ {cert.alpha} (union bound)</span></div>
            <div className="row"><span>per-tool confidence</span><span>≥ {(cert.perToolConfidence * 100).toFixed(1)}%</span></div>
          </div>
        )}

        {compile && <p className="mono muted" style={{ fontSize: 10, marginTop: 8 }}>Selector runtime: {compileMs ?? '—'} ms · seeds explored: {compile.exploredSeeds} · λ used {compile.lambdaUsed.toFixed(3)}{compile.wasClamped ? ` (clamped from ${compile.lambdaRequested}; λ_max = ${compile.lambdaMax.toFixed(4)} — monotonicity guard)` : ''}</p>}

        {flash && <div className={'flash ' + flash}>{flash}<small>{flash === 'CONTRADICTED' ? 'the tool said 200 OK · the read-back says otherwise' : 'read-back verified against real state'}</small></div>}
      </section>

      <section className="panel">
        <h2>Execution Timeline</h2>
        <div className="sub">Every call in, every read-back out — nothing is trusted because a tool returned 200</div>
        <div className="timeline" ref={timelineRef}>
          {timeline.length === 0 && <div className="mono muted" style={{ padding: 18, textAlign: 'center', border: '1px dashed var(--line)', borderRadius: 10 }}>No calls yet. Any task you type is compiled, certified, executed and read-back live — pick an example or write your own.</div>}
          {timeline.map(ev => (
            <div key={ev.id} className={'ev ' + ev.cls}><span className="tag">{ev.tag}</span><span>{ev.text}{ev.sub && <small>{ev.sub}</small>}</span></div>
          ))}
        </div>

        {audit && (
          <div style={{ marginTop: 12 }}>
            <div className={'flash ' + (audit.fooled ? 'CONTRADICTED' : 'CONFIRMED')}>{audit.fooled ? 'BASELINE WAS FOOLED' : 'LUCKY MISS'}<small>{audit.fooled ? `${audit.fooled} of ${audit.writes} writes did nothing — and the agent reported success for all of them` : 'no faults landed this run — but there is still no proof of it'}</small></div>
            <div className="receipt" style={{ marginTop: 12 }}>
              <b style={{ color: 'var(--gold)' }}>AUDIT REVEAL — AFTER THE FACT</b>
              {audit.reveals.map(r => (
                <div key={r.tool} className="kv" style={{ marginTop: 6 }}><span>{r.tool}</span><span style={{ color: r.verdict === 'CONFIRMED' ? 'var(--green)' : 'var(--red)' }}>{r.verdict}</span></div>
              ))}
              <div className="kv" style={{ marginTop: 8, borderTop: '1px solid var(--line)', paddingTop: 8 }}><span>receipt</span><span style={{ color: 'var(--red)' }}>none exists — nothing to audit, no hash to trust</span></div>
            </div>
            <button className="run" style={{ marginTop: 12 }} onClick={() => switchMode('notary')}>Run it protected →</button>
          </div>
        )}

        {receipt && (
          <div className="receipt" style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <b style={{ color: 'var(--gold)', letterSpacing: '.15em' }}>SIGNED RECEIPT</b>
              <button className="btn small" onClick={() => speak(`Receipt ${receipt.id}. Verdict ${receipt.verdict}. ${receipt.calls.length} calls, ${receipt.falseSuccessCaught} false success caught.`)}>Speak receipt</button>
            </div>
            <div className="kv"><span>id</span><span>{receipt.id}</span></div>
            <div className="kv"><span>verdict</span><span style={{ color: receipt.verdict === 'CONFIRMED' ? 'var(--green)' : 'var(--red)' }}>{receipt.verdict}</span></div>
            <div className="kv"><span>surface</span><span>{receipt.surface.map(s => s.id).join(', ')}</span></div>
            <div className="kv"><span>certificate</span><span>≤ {fmt(receipt.certificate.bound)} tok @ α≤{receipt.certificate.alpha}</span></div>
            <div className="kv"><span>false successes caught</span><span>{receipt.falseSuccessCaught}</span></div>
            {receipt.fsr?.map(f => (
              <div className="kv" key={f.tool}><span>FSR p̂({f.tool})</span><span title="Beta(1,1) posterior · Wilson 95%">{f.posteriorMean.toFixed(3)} [{f.wilson95[0].toFixed(2)}–{f.wilson95[1].toFixed(2)}] · n={f.n}</span></div>
            ))}
            <div className="kv"><span>prev</span><span className="hash">{String(receipt.prev).slice(0, 32)}…</span></div>
            <div className="kv"><span>hash (SHA-256)</span><span className="hash">{receipt.hash}</span></div>
          </div>
        )}
      </section>
    </div>
  );
}

/* ─────────────── PLAYGROUND ─────────────── */
function Playground() {
  const [query, setQuery] = useState('Post the Q3 update to the engineering channel');
  const [budget, setBudget] = useState(900);
  const [lambda, setLambda] = useState(0.5);
  const deferredQuery = useDeferredValue(query);
  const result = useMemo(() => compileSurface(deferredQuery, TOOL_REGISTRY, { budget, lambda }), [deferredQuery, budget, lambda]);
  const enumGain = result.F - result.greedyF;
  const r = result.relevance;
  const sorted = [...TOOL_REGISTRY].map(t => ({ t, score: r.get(t.id) })).sort((a, b) => b.score - a.score);

  return (
    <div className="grid g-2">
      <section className="panel">
        <h2>Tool-Surface Compiler</h2>
        <div className="sub">F(S) = Σ r(t|q) − λ·Σ σ(ti,tj) s.t. Σ d(t) ≤ B — submodular knapsack, (1−1/e) guarantee</div>
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="Ask for anything…" />
        <div className="ctl-row"><label>Budget B</label><input type="range" min={200} max={4000} step={20} value={budget} onChange={e => setBudget(+e.target.value)} /><b style={{ color: 'var(--gold)' }}>{budget}</b></div>
        <div className="ctl-row"><label>λ</label><input type="range" min={0} max={1.5} step={0.05} value={lambda} onChange={e => setLambda(+e.target.value)} /><b style={{ color: 'var(--gold)' }}>{lambda.toFixed(2)}</b></div>
        {result.wasClamped && <div className="arch-note" style={{ borderColor: 'var(--gold-dim)', color: 'var(--gold)' }}>λ clamped {result.lambdaRequested} → {result.lambdaUsed.toFixed(4)} (λ_max — monotonicity guard, §5.3)</div>}
        {result.selected.length === 0 && <div className="arch-note" style={{ borderColor: 'var(--red)', color: 'var(--oxide)', marginTop: 8 }}>Empty surface — fails closed. No tool clears the relevance bar, so the agent gets nothing and must ask for tools. That is the desired failure mode: auditable beats hallucinated.</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <span className="chip">greedy F {result.greedyF.toFixed(3)} → enumeration F {result.F.toFixed(3)} <b>(+{enumGain.toFixed(3)})</b></span>
          <span className="chip">{result.exploredSeeds} seed combinations explored</span>
          <span className="chip">λ {result.lambdaUsed.toFixed(3)}{result.wasClamped ? ' (clamped)' : ''}</span>
        </div>

        <h3 className="sec">Compiled surface — {result.selected.length}/{result.registrySize} tools · {fmt(result.usedCost)} tokens · F = {result.F.toFixed(3)}</h3>
        <div className="bar" style={{ marginBottom: 10 }}><div style={{ width: Math.min(100, result.usedCost / result.budget * 100) + '%' }} /></div>
        <table>
          <thead><tr><th>Tool</th><th>r(t|q)</th><th>d(t)</th><th>Kind</th></tr></thead>
          <tbody>
            {result.selected.map(t => (
              <tr key={t.id} className="sel"><td>{t.id}</td><td>{r.get(t.id).toFixed(3)}</td><td>{t.cost}</td><td><span className={'pill ' + t.kind}>{t.kind}</span></td></tr>
            ))}
          </tbody>
        </table>

        <h3 className="sec">Deliberately excluded — the second-best tool, discarded on purpose</h3>
        <table>
          <thead><tr><th>Tool</th><th>r</th><th>max σ</th><th>Why excluded</th></tr></thead>
          <tbody>
            {result.nearMisses.map(({ tool, r: rr, maxSigma }) => (
              <tr key={tool.id}><td>{tool.id}</td><td>{rr.toFixed(3)}</td><td>{maxSigma.toFixed(2)}<div className="bar" style={{ width: 80, display: 'inline-block', verticalAlign: 'middle', marginLeft: 6 }}><div style={{ width: (maxSigma * 100).toFixed(0) + '%', background: 'var(--oxide)' }} /></div></td><td className="muted">redundant with selected surface</td></tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>Certificate &amp; Proof</h2>
        <div className="sub">What the CFO and the auditor ask before any agent touches production</div>
        <div className="cert">
          <div className="mono" style={{ fontSize: 10, letterSpacing: '.2em', color: 'var(--gold)' }}>PRE-FLIGHT COST CERTIFICATE</div>
          <div className="bound">≤ {fmt(result.certificate.bound)} <small>TOKENS</small></div>
          <div className="row"><span>deterministic d(S)</span><span>{fmt(result.certificate.deterministic)}</span></div>
          <div className="row"><span>stochastic Σ F̂⁻¹(1−α/|S|)</span><span>{fmt(result.certificate.stochastic)}</span></div>
          <div className="row"><span>statement</span><span>{result.certificate.statement}</span></div>
          <div className="row"><span>method</span><span>Bonferroni union bound · lognormal returns</span></div>
        </div>

        <h3 className="sec">All 60+ tools, ranked by relevance</h3>
        <div style={{ maxHeight: 380, overflowY: 'auto' }}>
          <table>
            <thead><tr><th>#</th><th>Tool</th><th>r</th><th>d</th><th>in S*</th></tr></thead>
            <tbody>
              {sorted.map(({ t, score }, i) => (
                <tr key={t.id} className={result.selected.includes(t) ? 'sel' : ''}>
                  <td className="muted">{i + 1}</td><td>{t.id}</td><td>{score.toFixed(3)}</td><td>{t.cost}</td>
                  <td>{result.selected.includes(t) ? '✓' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/* ─────────────── LEDGER ─────────────── */
function Ledger({ receipts, setReceipts }) {
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState(false);
  const aggregate = useMemo(() => {
    const caught = receipts.reduce((s, r) => s + (r.falseSuccessCaught || 0), 0);
    const tokensSaved = receipts.reduce((s, r) => s + Math.max(0, TOTAL_REGISTRY_TOKENS - (r.usedCost || TOTAL_REGISTRY_TOKENS)), 0);
    const writes = receipts.reduce((s, r) => s + r.calls.filter(c => c.verdict === 'CONFIRMED' || c.verdict === 'CONTRADICTED').length, 0);
    return { caught, tokensSaved, writes };
  }, [receipts]);
  async function verify() { setBusy(true); setCheck(await verifyChain(receipts)); setBusy(false); }
  function download(r) {
    const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = r.id + '.json'; a.click(); URL.revokeObjectURL(a.href);
  }
  return (
    <section className="panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2>Receipts Ledger</h2>
          <div className="sub">Hash-chained, replayable audit artifacts — trust the hash, not us</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" disabled={busy || receipts.length === 0} onClick={verify}>{busy ? 'VERIFYING…' : 'Verify chain'}</button>
          <button className="btn" onClick={() => { setReceipts([]); setCheck(null); }}>Clear ledger</button>
        </div>
      </div>
      {check && (
        <div className="arch-note" style={{ marginTop: 10, borderColor: check.valid ? 'var(--green)' : 'var(--red)', color: check.valid ? 'var(--green)' : 'var(--red)' }}>
          {check.valid ? `✓ CHAIN VALID — ${check.checked} receipt(s) hash-linked from genesis. Tamper with any byte and this fails.` : `✗ CHAIN BROKEN (${check.problems.length}): ${check.problems.map(p => `#${p.index} ${p.problem}`).join(' · ')}`}
        </div>
      )}
      {receipts.length > 0 && (
        <div className="stat-strip" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: 12, marginBottom: 0 }}>
          <div className="stat"><div className="n">{receipts.length}</div><div className="d">Actions receipted &amp; hash-chained</div></div>
          <div className="stat"><div className="n">{aggregate.caught}</div><div className="d">False successes caught (FSR → 0)</div></div>
          <div className="stat"><div className="n">{fmt(aggregate.tokensSaved)}</div><div className="d">Catalog tokens NOT burned vs full-registry baseline</div></div>
        </div>
      )}
      {receipts.length === 0 && <p className="muted mono" style={{ textAlign: 'center', padding: 30 }}>No receipts yet — run the task in the Demo Console.</p>}
      {[...receipts].reverse().map(r => (
        <div key={r.hash} className="receipt" style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <b style={{ color: 'var(--ink)' }}>{r.id}</b>
            <span className={'stamp ' + (r.verdict === 'CONFIRMED' ? 'ok' : 'contra')}>{r.verdict}</span>
            <span className="muted">{new Date(r.at).toLocaleString()}</span>
            <button className="btn small" onClick={() => download(r)}>↓ JSON</button>
          </div>
          <div className="kv"><span>task</span><span style={{ maxWidth: 520, textAlign: 'right' }}>{r.task}</span></div>
          <div className="kv"><span>surface</span><span>{r.surface.map(s => s.id).join(', ')}</span></div>
          <div className="kv"><span>certificate</span><span>≤ {fmt(r.certificate.bound)} tokens @ α≤{r.certificate.alpha}</span></div>
          <div className="kv"><span>false successes caught</span><span>{r.falseSuccessCaught}</span></div>
          <div className="kv"><span>prev</span><span className="hash">{String(r.prev).slice(0, 40)}…</span></div>
          <div className="kv"><span>hash</span><span className="hash">{r.hash.slice(0, 40)}…</span></div>
        </div>
      ))}
    </section>
  );
}

/* ─────────────── APPROACH ─────────────── */
function Approach() {
  return (
    <div className="panel" style={{ maxWidth: 1080 }}>
      <h2>How Notary Works</h2>
      <div className="sub">The transaction layer for AI actions — quote before, receipt after</div>

      <h3 className="sec">The problem in three numbers</h3>
      <p>Three common MCP servers consume <b>143,000 of 200,000 tokens (72%)</b> before the user types anything. Tool-selection accuracy falls from <b>43% to under 14%</b> as catalogs grow past ~50 tools. Agents report <b>“Done!”</b> on a 200 OK — even when nothing happened (a documented silent no-op; injection success measured at 23.6%). Enterprises can answer neither “what will this cost?” nor “did it happen?” — so they don’t deploy writes.</p>

      <h3 className="sec">The one-line thesis</h3>
      <div className="arch-note">Replace inference-time tool selection with compile-time surface compilation under a budgeted submodular objective, plus post-execution effect verification — converting probabilistic best-effort into an enforceable, auditable contract.</div>

      <h3 className="sec">Architecture — the three components</h3>
      <svg viewBox="0 0 1000 210" width="100%" role="img" aria-label="Notary architecture">
        {[['① QUOTE', 'Tool-Surface Compiler', 'submodular knapsack + λ_max clamp', '≥ (1−1/e)·OPT'], ['② CERTIFICATE', 'Cost commitment', 'Bonferroni quantiles, union bound', 'P(actual > C) ≤ α'], ['③ RECEIPT', 'Effect contract + read-back', 'φ_pre · call · φ_post · hash chain', 'CONFIRMED / CONTRADICTED']].map(([a, b, c, d], i) => (
          <g key={i} transform={`translate(${20 + i * 335},30)`}>
            <rect width="300" height="150" rx="14" fill="#f1efe7" stroke="#201f1b" strokeOpacity="0.55" strokeWidth="1.6" />
            <text x="150" y="38" textAnchor="middle" fill="#201f1b" fontFamily="ui-monospace" fontSize="15" letterSpacing="3">{a}</text>
            <text x="150" y="70" textAnchor="middle" fill="#201f1b" fontSize="15">{b}</text>
            <text x="150" y="97" textAnchor="middle" fill="#5d5a50" fontSize="11.5">{c}</text>
            <text x="150" y="122" textAnchor="middle" fill="#39536b" fontFamily="ui-monospace" fontSize="11">{d}</text>
            {i < 2 && <path d="M300 75 h34 m-8 -7 l10 7 -10 7" stroke="#17493a" strokeWidth="2.2" fill="none" />}
          </g>
        ))}
      </svg>

      <h3 className="sec">The theory (why this is not an AI wrapper)</h3>
      <p className="mono" style={{ fontSize: 12, lineHeight: 1.9, color: 'var(--ink-2)' }}>
        BTSS — maximise <code className="inline">F(S) = Σ r(t|q) − λ·Σ σ(tᵢ,tⱼ)</code> s.t. <code className="inline">Σ d(t) ≤ B</code>.<br />
        <b>Theorem 1.</b> F is submodular (diminishing returns: Δ<sub>S</sub>(t) = r(t|q) − λ·Σ<sub>t′∈S</sub> σ(t,t′) can only shrink as S grows). If r(t|q) ≥ λ·Σσ(t,t′) ∀t then F is monotone — enforced by the λ_max clamp.<br />
        <b>Theorem 2.</b> BTSS is NP-hard (contains budgeted max coverage). Cost-benefit greedy + 3-element seed enumeration ⇒ F ≥ (1−1/e)·OPT ≈ 0.632·OPT (Sviridenko 2004). Runtime &lt; 10 ms at n ≤ 600.<br />
        <b>Certificate.</b> C(S) = Σ d(t) + Σ F̂⁻¹<sub>t</sub>(1 − α/|S|). Union bound ⇒ P(actual &gt; C(S)) ≤ α. Reported at α = 0.05, breaches logged.<br />
        <b>Verification.</b> False-Success Rate = P(2xx ∧ ¬φ_post(state)). We drive it to 0 by construction: every write is read back; CONTRADICTED triggers bounded retry ≤ 2, then human escalation.
      </p>

      <h3 className="sec">What we deliberately do NOT claim</h3>
      <ul>
        <li>No universal correctness verifier — per-tool postconditions on the ~30 write tools that can cost money, not on all 600.</li>
        <li>No optimal selection — a provable (1−1/e) fraction of optimal.</li>
        <li>No hard token ceiling — a quantile with a published α-breach rate.</li>
        <li>Not a replacement for Anthropic Tool Search / Cloudflare Code Mode — an independent commitment + proof layer alongside them (an auditor won’t accept a receipt from the party being audited).</li>
      </ul>

      <h3 className="sec">Sponsor tech, load-bearing</h3>
      <div className="arch-note">
        <b>AWS:</b> Bedrock (reasoning + Guardrails for injection defence) · OpenSearch Serverless (vector index of 600 descriptors) · DynamoDB (registry, calibration table, hash-chained receipt log) · Lambda/Fargate (compiler+verifier) · Step Functions (deterministic replay of verified plans) · EventBridge (scheduled verified digests) · CloudWatch (α-breach + FSR alarms) · Cognito (per-org scoping).<br /><br />
        <b>ElevenLabs:</b> the accountability channel — spoken read-back consent before irreversible writes (“You are about to email 47 customers totalling ₹12.4L. Say confirm.”) and spoken verified receipts in Tamil/Hindi/English. Voice-first and low-vision users get the same guarantee as a dashboard — voice as distribution, not decoration. (In this build, browser speech synthesis stands in; ElevenLabs Flash slot is wired behind <code className="inline">speak()</code>.)
      </div>

      <h3 className="sec">Demo script — 90 seconds</h3>
      <p className="mono" style={{ fontSize: 11.5, lineHeight: 1.9, color: 'var(--ink-2)' }}>
        0:00 Beat 1 — “Three MCP servers eat 72% of your context before you speak. Notary compiles it to a certified surface.” Meter collapses. Certificate: <b>≤ 1,550 tokens @ 95% confidence</b>.<br />
        0:25 Beat 2 — The agent calls notion.append_block → <b>200 OK</b>. Baseline says “Done!” Notary reads the page back → <b>block missing → CONTRADICTED</b> → resolves real parent → retry → <b>CONFIRMED</b>, block visible on screen.<br />
        0:55 Beat 3 — Spoken consent: “You are about to post to #engineering. Say confirm.” → action → spoken receipt: “Posted. Verified. 1,412 tokens, within quote.”<br />
        Close — “Quote before. Receipt after. Less magic, more utility.”
      </p>

      <h3 className="sec">Metrics we report (not adjectives)</h3>
      <table>
        <thead><tr><th>Metric</th><th>Baseline</th><th>Target</th><th>How measured</th></tr></thead>
        <tbody>
          <tr><td>Context tax (catalog on wire)</td><td>40–72%</td><td>≤ 8%</td><td>surface tokens ÷ window</td></tr>
          <tr><td>Task success (30-task set)</td><td>measure</td><td>≥ baseline</td><td>automated pass/fail</td></tr>
          <tr><td>False-Success Rate</td><td>invisible today</td><td>→ 0</td><td>injected silent no-ops detected</td></tr>
          <tr><td>Certificate breaches</td><td>—</td><td>≤ 5% @ α=0.05</td><td>predicted vs actual</td></tr>
          <tr><td>Overhead</td><td>—</td><td>&lt; 500 ms p95</td><td>timestamps around control plane</td></tr>
        </tbody>
      </table>
    </div>
  );
}
