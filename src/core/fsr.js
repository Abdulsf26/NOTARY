// Notary — per-tool False-Success-Rate posterior.
// A silent no-op is a Bernoulli event: the tool returned success but nothing landed.
// Conjugate Beta prior (Laplace, Beta(1,1)) → posterior mean p̂ = (f+1)/(n+2).
// Uncertainty: Wilson 95% score interval (preferred over ±1.96·√(p̂q̂/n) — bounded,
// never exceeds [0,1], behaves at f=0 and p̂→0/1). Old observations decay with a
// half-life so the estimate tracks CURRENT behaviour, not lifetime history.
// Reference: Wilson 1927; Brown–Cai–DasGupta 2001; Agresti–Coull 1998.

export const Z95 = 1.959964;
export const HALF_LIFE_DAYS = 14;
const DAY_MS = 86_400_000;
export const EVENT_CAP = 200; // keep memory bounded; older events merge into priors implicitly via decay

export function betaPosterior(f, n) {
  return { alpha: f + 1, beta: n - f + 1, mean: (f + 1) / (n + 2) };
}

export function wilsonInterval(f, n, z = Z95) {
  if (n <= 0) return [0, 1];
  const p = f / n, z2 = z * z, denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [Math.max(0, (centre - half) / denom), Math.min(1, (centre + half) / denom)];
}

/** Exponentially decayed effective counts as of `now`. */
export function decayedCounts(events, now = Date.now(), halfLifeDays = HALF_LIFE_DAYS) {
  const hl = halfLifeDays * DAY_MS;
  let nEff = 0, fEff = 0;
  for (const ev of events) {
    const w = Math.pow(0.5, (now - ev.t) / hl);
    nEff += w;
    if (ev.f) fEff += w;
  }
  return { nEff, fEff };
}

export function createFsrModel() {
  return { tools: new Map() };
}

export function recordOutcome(model, tool, falseSuccess, at = Date.now()) {
  const e = model.tools.get(tool) ?? { events: [] };
  e.events.push({ t: at, f: falseSuccess ? 1 : 0 });
  if (e.events.length > EVENT_CAP) e.events.splice(0, e.events.length - EVENT_CAP);
  model.tools.set(tool, e);
  return summarizeTool(model, tool, at);
}

export function summarizeTool(model, tool, now = Date.now(), halfLifeDays = HALF_LIFE_DAYS) {
  const e = model.tools.get(tool);
  if (!e || e.events.length === 0) return { tool, n: 0, falseSuccess: 0, posteriorMean: 0.5, wilson95: [0, 1] };
  const rawF = e.events.reduce((a, ev) => a + ev.f, 0);
  const { nEff, fEff } = decayedCounts(e.events, now, halfLifeDays);
  const post = betaPosterior(fEff, nEff);
  const [lo, hi] = wilsonInterval(fEff, Math.max(nEff, 1e-9));
  return {
    tool,
    n: e.events.length,
    falseSuccess: rawF,
    nEffective: +nEff.toFixed(3),
    posteriorMean: +post.mean.toFixed(4),
    wilson95: [+lo.toFixed(4), +hi.toFixed(4)],
  };
}

export function summarizeAll(model, now = Date.now()) {
  return [...model.tools.keys()].map(t => summarizeTool(model, t, now));
}
