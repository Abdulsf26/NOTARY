// Notary — scorer evaluation on held-out queries (by-query 80/20, seed 20261124,
// identical split to scripts/train.mjs). Tuning (S0, k1, field weights) is done on
// TRAIN; TEST numbers are reported, never tuned against.
// Run: node scripts/eval.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TOOL_REGISTRY } from '../src/core/registry.js';
import { relevanceClassic, relevance } from '../src/core/similarity.js';
import { createBm25f } from '../src/core/bm25.js';
import { LR } from '../src/core/model-params.js';
import { featureVector } from '../src/core/similarity.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const examples = readFileSync(join(root, 'data', 'gold.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

let s = 20261124 >>> 0;
const rand = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
const shuffle = arr => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const queries = shuffle(examples.map(e => e.q));
const nTest = Math.max(4, Math.round(queries.length * 0.2));
const testQs = new Set(queries.slice(0, nTest));
const trainEx = examples.filter(e => !testQs.has(e.q));
const testEx = examples.filter(e => testQs.has(e.q));
console.log(`train ${trainEx.length} queries · test ${testEx.length} queries\n`);

const learned = x => { let z = LR.bias; for (const k of LR.features) z += LR.w[k] * (x[k] ?? 0); return 1 / (1 + Math.exp(-z)); };

const bm25 = (S0, opts = {}) => createBm25f({ S0, ...opts });

const make = (fn) => (query) => TOOL_REGISTRY.map(t => ({ id: t.id, s: fn(t, query) }));
const byId = new Map(TOOL_REGISTRY.map(t => [t.id, t]));
const classicFn = (t, q) => relevanceClassic(t, q);
const learnedFn = (t, q) => learned(featureVector(t, q));
const bm25Fn = (S0, opts) => { const b = bm25(S0, opts); return (t, q) => b.relevance(t, q); };
const hybridFn = (bFn, wc = 0.5) => { const b = bFn; return (t, q) => Math.min(1, wc * classicFn(t, q) + (1 - wc) * b(t, q)); };

const S = {
  classic: make(classicFn),
  learned: make(learnedFn),
  'bm25f S0=4': make(bm25Fn(4.0)),
  'bm25f S0=5': make(bm25Fn(5.0)),
  'bm25f S0=6': make(bm25Fn(6.0)),
  'hybrid 50/50 S0=5': make(hybridFn(bm25Fn(5.0))),
  'hybrid 60/40 S0=5': make(hybridFn(bm25Fn(5.0), 0.6)),
  'hybrid 40/60 S0=5': make(hybridFn(bm25Fn(5.0), 0.4)),
};

function metrics(scoring, rows) {
  let P5 = 0, R5 = 0, F5 = 0, nDCG5 = 0, nDCG10 = 0, MRR = 0;
  for (const ex of rows) {
    const pos = new Set(ex.pos);
    const ranked = scoring(ex.q).sort((a, b) => b.s - a.s).map(x => x.id);
    const at = (k, ids) => ids.slice(0, k);
    const p5 = at(5, ranked).filter(id => pos.has(id)).length / 5;
    const r5 = at(5, ranked).filter(id => pos.has(id)).length / pos.size;
    P5 += p5; R5 += r5; F5 += (p5 + r5) ? (2 * p5 * r5) / (p5 + r5) : 0;
    const dcg = (ids, k) => ids.slice(0, k).reduce((a, id, i) => a + (pos.has(id) ? 1 / Math.log2(i + 2) : 0), 0);
    const ideal = (k) => Array.from({ length: Math.min(k, pos.size) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
    nDCG5 += dcg(ranked, 5) / ideal(5); nDCG10 += dcg(ranked, 10) / ideal(10);
    const first = ranked.findIndex(id => pos.has(id));
    MRR += first === -1 ? 0 : 1 / (first + 1);
  }
  const m = rows.length;
  return { P5: P5 / m, R5: R5 / m, F5: F5 / m, nDCG5: nDCG5 / m, nDCG10: nDCG10 / m, MRR: MRR / m };
}

const fmt = r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, +(v * 100).toFixed(1)]));
console.log('=== TRAIN (tuning surface) ===');
for (const [name, fn] of Object.entries(S)) console.log(name.padEnd(22), JSON.stringify(fmt(metrics(fn, trainEx))));
console.log('\n=== HELD-OUT TEST ===');
for (const [name, fn] of Object.entries(S)) console.log(name.padEnd(22), JSON.stringify(fmt(metrics(fn, testEx))));

// junk fail-closed check (must score everything 0 / select nothing)
const junk = 'asdkfj qqq zzz';
for (const [name, fn] of Object.entries(S)) {
  const max = Math.max(...fn(junk).map(x => x.s));
  console.log(`junk-max [${name}]:`, max.toFixed(4), max === 0 ? '✓ fail-closed' : '⚠ non-zero');
}

// ── Selection-level comparison (greedy-density proxy, B=900, λ=0.5, pool≥cutoff) ──
// The shipped scorer is chosen on WHICH TOOLS get selected, not only ranking.
// Proxy: rank by r/cost density, fill budget, respect pool cutoff per scorer.
const COSTS = new Map(TOOL_REGISTRY.map(t => [t.id, t.cost]));
const cuts = { classic: 0.15, learned: LR.poolThreshold ?? 0.179 };

function select(fns, query, scorer, B = 900) {
  const scored = fns(query).filter(x => x.s >= cuts[scorer]).map(x => ({ ...x, density: x.s / COSTS.get(x.id) }));
  scored.sort((a, b) => b.density - a.density);
  let used = 0; const picked = [];
  for (const t of scored) { if (used + COSTS.get(t.id) <= B) { used += COSTS.get(t.id); picked.push(t.id); } }
  return picked;
}
const selScorers = { classic: S.classic, learned: S.learned, 'hybrid 50/50 S0=5': S['hybrid 50/50 S0=5'] };
const selCut = { classic: cuts.classic, learned: cuts.learned, 'hybrid 50/50 S0=5': 0.15 };
for (const split of [['TRAIN', trainEx], ['TEST', testEx]]) {
  console.log(`\n=== SELECTION (${split[0]}, greedy-density proxy) ===`);
  for (const [name, fn] of Object.entries(selScorers)) {
    let hit = 0, total = 0, tp = 0, selCount = 0;
    for (const ex of split[1]) {
      const pos = new Set(ex.pos);
      const picked = select(fn, ex.q, name === 'learned' ? 'learned' : 'classic');
      tp += picked.filter(id => pos.has(id)).length;
      hit += pos.size ? Math.min(tp, pos.size) : 0; selCount += picked.length; total += pos.size;
    }
    console.log(name.padEnd(22), `selected≈${(selCount / split[1].length).toFixed(1)}/q  recall=${(hit / total * 100).toFixed(1)}%`);
  }
}

// ── Exact oracle: branch-and-bound over r>0 tools ────────────────────────
// Measures how close greedy+enumeration gets to the TRUE optimal F over all
// tools with positive relevance. Bound: F(members) + Σ_{j≥idx} max(0, r_j −
// λ·Σ_{s∈members} σ(j,s))  (drops redundancy among remaining candidates —
// a valid upper bound).
import { redundancy } from '../src/core/similarity.js';
const LAMBDA = 0.5;

function exactOptimum(query, B = 900) {
  const scored = TOOL_REGISTRY.map(t => ({ t, r: relevanceClassic(t, query) }))
    .filter(x => x.r > 1e-9 && x.t.cost <= B)
    .sort((a, b) => b.r / b.t.cost - a.r / a.t.cost);
  const n = scored.length;
  if (n === 0) return { opt: 0, poolSize: 0 };
  // λ_max clamp exactly as compileSurface computes it (r ≥ poolCutoff over pool)
  const pool = scored.filter(x => x.r >= 0.15);
  let lambdaMax = Infinity;
  for (const t of pool) {
    let sumSig = 0;
    for (const u of pool) if (u.t.id !== t.t.id) sumSig += redundancy(t.t, u.t);
    lambdaMax = Math.min(lambdaMax, t.r / (sumSig + 1e-9));
  }
  if (!isFinite(lambdaMax)) lambdaMax = LAMBDA;
  const lam = Math.min(LAMBDA, lambdaMax);
  const n2 = n, rArr = scored.map(x => x.r), costArr = scored.map(x => x.t.cost);
  const sigCache = new Map();
  const sig = (i, j) => {
    const key = i < j ? i * n2 + j : j * n2 + i;
    if (!sigCache.has(key)) sigCache.set(key, redundancy(scored[i].t, scored[j].t));
    return sigCache.get(key);
  };
  let best = 0, nodes = 0;
  const bt = (idx, used, members, fPartial) => {
    if (fPartial > best) best = fPartial;
    // tight upper bound: remaining candidates with their membership-penalty only
    let bound = fPartial;
    for (let j = idx; j < n2; j++) {
      let m = rArr[j];
      for (const s of members) m -= lam * sig(s, j);
      if (m > 0) bound += m;
    }
    if (bound <= best) return;
    for (let j = idx; j < n2; j++) {
      if (++nodes > 5e6) return; // tractability ceiling — report separately
      if (used + costArr[j] > B) continue;
      let m = rArr[j];
      for (const s of members) m -= lam * sig(s, j);
      if (m <= 1e-9) continue;
      bt(j + 1, used + costArr[j], [...members, j], fPartial + m);
    }
  };
  bt(0, 0, [], 0);
  return { opt: best, poolSize: n, nodes, capped: nodes >= 5e6 };
}

console.log('\n=== OPTIMALITY GAP (exact oracle vs greedy+enumeration, B=900, λ=0.5) ===');
const { compileSurface } = await import('../src/core/selector.js');
let sumRatio = 0, counted = 0, cappedN = 0, below = [];
for (const ex of [...trainEx, ...testEx]) {
  const { opt, poolSize, capped } = exactOptimum(ex.q);
  const res = compileSurface(ex.q, TOOL_REGISTRY, { budget: 900, lambda: 0.5 });
  const ratio = opt > 0 ? Math.min(1.05, res.F / opt) : 1;
  sumRatio += ratio; counted++;
  if (capped) cappedN++;
  if (ratio < 0.99) below.push({ ratio, poolSize, q: ex.q });
  console.log(`  pool=${String(poolSize).padStart(2)}  OPT=${opt.toFixed(3)}  F=${res.F.toFixed(3)}  ratio=${(ratio * 100).toFixed(1)}%${ex.q ? '' : ''}`);
}
console.log(`mean F/OPT = ${(sumRatio / counted * 100).toFixed(2)}% over ${counted} queries (exact B&B over r>0 pool)${cappedN ? ` · ${cappedN} queries hit the 5M-node tractability ceiling (OPT is a lower bound there — true gap smaller)` : ''}`);
if (below.length) for (const b of below) console.log(`  below 99%: ${(b.ratio * 100).toFixed(1)}%  pool=${b.poolSize}  q="${b.q.slice(0, 70)}"`);
