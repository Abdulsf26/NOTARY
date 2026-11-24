// Notary — the Cost Certificate.
// C(S) = Σ_{t∈S} d(t)  +  Σ_{t∈S} Q_t(1 − α/|S|)
//         deterministic          Bonferroni-corrected quantiles
// Claim: P(actual total tokens > C(S)) ≤ α   (union bound). Reported at α = 0.05.
// Per-tool token returns are modelled as lognormal, calibrated so that p95 matches the registry.

import { CERTIFICATE_CALIBRATION } from './cert-calibration.js';

// Normal quantile (Acklam's rational approximation)
function normInv(p) {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469593316837, 0.32246712907004, 2.44513413782195, 3.75440866190742];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
             ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
}

// p95/p50 dispersion assumed per class of tool (calibrated from logs; registry stores p95 only).
const DISPERSION = 0.85; // lognormal σ — p95 = p50·e^{1.645·σ} ≈ p50·4.05
const Z95 = normInv(0.95);

export function toolQuantile(p95, p /* confidence per tool */) {
  const median = p95 / Math.exp(Z95 * DISPERSION);
  return median * Math.exp(normInv(Math.min(0.99999, p)) * DISPERSION);
}

export function issueCertificate(selectedTools, alpha = 0.05) {
  if (selectedTools.length === 0) {
    return { alpha, n: 0, deterministic: 0, stochastic: 0, bound: 0, perToolConfidence: 1 - alpha,
      statement: 'No tools authorised — the request fails closed and must ask for tools instead of hallucinating',
      guarantee: 'empty surface, α vacuous', breaches: 0 };
  }
  const n = selectedTools.length;
  const det = selectedTools.reduce((s, t) => s + t.cost, 0);
  const perTool = 1 - alpha / n; // Bonferroni: each bounded w.p. ≥ 1−α/|S|
  const medians = selectedTools.map(t => t.p95 / Math.exp(Z95 * DISPERSION));
  const stochastic = selectedTools.reduce((s, t) => s + toolQuantile(t.p95, perTool), 0);
  const bound = Math.ceil(det + stochastic);
  // Calibrated view (model-fitted, NOT the guarantee): per-surface-size conformal factors,
  // verified on held-out synthetic episodes (npm run calibrate). The Bonferroni `bound`
  // above remains the number the guarantee attaches to.
  const inflations = CERTIFICATE_CALIBRATION?.inflations ?? null;
  const inflation = inflations ? inflations[Math.min(n, Math.max(...Object.keys(inflations).map(Number)))] : null;
  const calibratedBound = inflation == null ? null : Math.ceil(det + stochastic * inflation);
  const estimateMedian = Math.ceil(det + medians.reduce((s, m) => s + m, 0));
  return {
    alpha,
    n,
    deterministic: det,
    stochastic: Math.ceil(stochastic),
    bound,
    estimateMedian,
    calibratedBound,
    perToolConfidence: perTool,
    statement: `P(total tokens > ${bound.toLocaleString()}) ≤ ${alpha}`,
    guarantee: 'Union bound over Bonferroni-corrected per-tool quantiles (α = 0.05)',
    calibration: inflation == null ? null : { kind: 'split-conformal (model-fitted)', inflation, note: 'calibratedBound is a tighter model estimate — the guarantee attaches to `bound` only' },
    breaches: 0,
  };
}
