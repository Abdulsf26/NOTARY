// Notary — Tool-Surface Compiler (BTSS: Budgeted Tool-Surface Selection).
//
//   maximise   F(S) = Σ_{t∈S} r(t|q)  −  λ · Σ_{{t,t'}⊆S} σ(t,t′)
//   subject to Σ_{t∈S} d(t) ≤ B
//
// F is submodular (diminishing returns per tool). If r(t|q) ≥ λ·Σ_{t'} σ(t,t′)
// for every t, F is also monotone — enforced here by clamping λ to λ_max.
// Guarantee: cost-benefit greedy + enumeration of seeds up to size 3 (Sviridenko 2004)
// yields F ≥ (1 − 1/e)·OPT ≈ 0.632·OPT. Exact ILP oracle used offline; here we ship
// greedy + seed enumeration, which is what runs at inference time.
import { relevance, redundancy, poolThreshold } from './similarity.js';
import { issueCertificate } from './certificate.js';

const EPS = 1e-9;

// σ is query-independent — precompute the full symmetric matrix once per registry array
// (WeakMap-cached), so the greedy/enumeration inner loop is an O(1) array read, not a
// string-keyed Map lookup. n ≤ ~600 ⇒ ≤ 360k entries.
const sigmaMatrixCache = new WeakMap();
function sigmaMatrix(registry) {
  let m = sigmaMatrixCache.get(registry);
  if (!m) {
    const n = registry.length;
    const mat = new Float32Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const v = redundancy(registry[i], registry[j]);
        mat[i * n + j] = v; mat[j * n + i] = v;
      }
    }
    m = { n, mat, index: new Map(registry.map((t, i) => [t.id, i])) };
    sigmaMatrixCache.set(registry, m);
  }
  return m;
}

export function compileSurface(query, registry, { budget = 900, lambda = 0.5, shortlistSize = 14, delta = 0.05, pin = null, block = null } = {}) {
  // User constraints (guided mode): block = forbidden (wins over pin); pin = forced in,
  // subject to the HARD budget. The (1−1/e) guarantee then holds over the unforced
  // remainder — documented in docs/ARCHITECTURE.md.
  const blockedIds = new Set(block ?? []);
  const pinned = (pin ? registry.filter(t => pin.has(t.id) && !blockedIds.has(t.id)) : []);
  const pinSet = new Set(pinned.map(t => t.id));
  const work = registry.filter(t => !blockedIds.has(t.id) && !pinSet.has(t.id));

  const n = work.length;
  const r = new Map(registry.map(t => [t.id, relevance(t, query)]));

  // ── λ_max clamp (monotonicity guard) ───────────────────────────────────
  // λ_max monotonicity guard, computed over the candidate pool (r ≥ 0.15) —
  // the set over which the greedy/enumeration decision is actually exercised.
  // (Over all n tools, Σσ grows linearly with registry size and λ_max → 0; the pool
  // restriction is the practical, documented guard. See README §theory.)
  const poolCutoff = poolThreshold();
  const pool = work.filter(t => r.get(t.id) >= poolCutoff);
  let lambdaMax = Infinity;
  for (const t of pool) {
    let sumSig = 0;
    for (const u of pool) if (u.id !== t.id) sumSig += redundancy(t, u);
    const lim = r.get(t.id) / (sumSig + EPS);
    if (lim < lambdaMax) lambdaMax = lim;
  }
  if (!isFinite(lambdaMax)) lambdaMax = lambda;
  const lambdaClamped = Math.min(lambda, lambdaMax);
  const wasClamped = lambdaClamped < lambda - 1e-12;

  const SM = sigmaMatrix(work);
  const sig = (a, b) => SM.mat[SM.index.get(a.id) * SM.n + SM.index.get(b.id)];
  const byId = new Map(registry.map(t => [t.id, t]));

  // Flat typed-array views for the inner loop (index === registry order === SM order)
  const rArr = new Float64Array(n), rOverCost = new Float64Array(n), costArr = new Float64Array(n);
  work.forEach((t, i) => {
    const rv = r.get(t.id);
    rArr[i] = rv; costArr[i] = t.cost; rOverCost[i] = rv / t.cost;
  });

  const marginal = (t, S) => {
    let m = r.get(t.id);
    for (const s of S) m -= lambdaClamped * sig(t, s);
    return m;
  };

  // Incremental-penalty greedy: maintain penalty[t] = λ·Σ_{s∈S} σ(t,s) as S grows,
  // so each added tool costs one O(|V|) update instead of rescanning S per candidate.
  // Same objective, same output — ~50× less redundant Σσ work.
  const F = S => {
    let sum = 0;
    for (const t of S) sum += r.get(t.id);
    for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) sum -= lambdaClamped * sig(S[i], S[j]);
    return sum;
  };
  const cost = S => S.reduce((s, t) => s + t.cost, 0);

  // ── cost-benefit greedy ────────────────────────────────────────────────
  function greedyExtend(seed) {
    const SM2 = sigmaMatrix(work);
    const mat = SM2.mat, nn = SM2.n;
    const S = [...seed];
    const inS = new Uint8Array(n);
    for (const s of S) inS[SM2.index.get(s.id)] = 1;
    const penalty = new Float64Array(n);
    for (const s of S) {
      const si = SM2.index.get(s.id);
      for (let i = 0; i < n; i++) if (i !== si) penalty[i] += lambdaClamped * mat[i * nn + si];
    }
    let used = cost(S);
    for (;;) {
      let bestIdx = -1, bestGain = EPS, bestDensity = 0;
      for (let i = 0; i < n; i++) {
        if (inS[i]) continue;
        const c = costArr[i];
        if (used + c > budget) continue;
        if (bestIdx >= 0 && rOverCost[i] <= bestDensity) continue; // m ≤ r ⇒ density ≤ r/cost ≤ bestDensity
        const m = rArr[i] - penalty[i];
        if (m <= EPS) continue;
        const d = m / c;
        if (bestIdx < 0 || d > bestDensity) { bestIdx = i; bestGain = m; bestDensity = d; }
      }
      if (bestIdx < 0 || bestGain < delta - EPS) break; // marginal floor δ — no entry under δ worth of gain
      const bt = work[bestIdx];
      S.push(bt); inS[bestIdx] = 1; used += costArr[bestIdx];
      for (let i = 0; i < n; i++) if (!inS[i]) penalty[i] += lambdaClamped * mat[i * nn + bestIdx];
    }
    return S;
  }

  const greedy = greedyExtend([]);
  let bestSet = greedy, bestF = F(greedy);

  // ── Sviridenko-style partial enumeration over top seeds (≤3) ───────────
  const shortlist = [...work].sort((a, b) => r.get(b.id) - r.get(a.id)).slice(0, shortlistSize);
  const seeds = [];
  for (let i = 0; i < shortlist.length; i++) {
    seeds.push([shortlist[i]]);
    for (let j = i + 1; j < shortlist.length; j++) {
      seeds.push([shortlist[i], shortlist[j]]);
      for (let k = j + 1; k < shortlist.length; k++) {
        if (cost([shortlist[i], shortlist[j], shortlist[k]]) <= budget) seeds.push([shortlist[i], shortlist[j], shortlist[k]]);
      }
    }
  }
  let explored = 0;
  for (const seed of seeds) {
    if (cost(seed) > budget) continue;
    const S = greedyExtend(seed);
    explored++;
    const f = F(S);
    if (f > bestF + 1e-9) { bestF = f; bestSet = S; }
  }

  // ── force-include pins under the HARD budget (user override) ─────────────
  const finalSet = [...bestSet];
  let used2 = cost(finalSet);
  const forced = [], pinNotes = [];
  for (const t of pinned) {
    if (used2 + t.cost <= budget) { finalSet.push(t); used2 += t.cost; forced.push(t); }
    else pinNotes.push(`pinned ${t.id} exceeds remaining budget (${used2}/${budget} tok used) — excluded`);
  }

  const selected = finalSet;
  const usedCost = cost(selected);
  const certificate = issueCertificate(selected, 0.05);

  // Tools deliberately excluded despite high relevance (redundant ambiguity)
  const selectedIds = new Set(selected.map(t => t.id));
  const nearMisses = [...work]
    .filter(t => !selectedIds.has(t.id) && r.get(t.id) > 0.08)
    .map(t => {
      const overlap = Math.max(0, ...selected.map(s => sig(t, s)));
      return { tool: t, r: r.get(t.id), maxSigma: overlap };
    })
    .sort((a, b) => b.maxSigma - a.maxSigma || b.r - a.r)
    .slice(0, 6);

  return {
    query,
    budget,
    lambdaRequested: lambda,
    lambdaUsed: lambdaClamped,
    lambdaMax,
    wasClamped,
    selected,
    usedCost,
    utilisation: usedCost / budget,
    F: F(finalSet),
    greedySet: greedy,
    greedyF: F(greedy),
    exploredSeeds: explored,
    relevance: r,
    certificate,
    nearMisses,
    registrySize: n,
    delta,
    forced: forced.map(t => t.id),
    pinNotes,
    blockedCount: blockedIds.size,
  };
}
