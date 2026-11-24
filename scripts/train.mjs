// Notary — offline trainer for the learned relevance model.
// Supervision: data/gold.jsonl — (query, positive tool ids). All other registry tools are
// treated as negatives (distant supervision over a closed tool registry).
// Model: logistic regression on [cos, coverage, prior, nameHit], full-batch GD, L2.
// Held-out split by query (80/20, seeded). Prints metrics vs the classic heuristic;
// writes src/core/model-params.js and docs/EVALUATION.md.
// Run: npm run train
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TOOL_REGISTRY } from '../src/core/registry.js';
import { featureVector, relevanceClassic } from '../src/core/similarity.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEED = 20261124;
const POS_WEIGHT = 4;      // class imbalance: 1 positive vs ~87 negatives per query
const L2 = 3e-3;
const LR = 0.5, EPOCHS = 4000;

// seeded PRNG (LCG) — reproducible split and shuffles
let s = SEED >>> 0;
const rand = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
const shuffle = arr => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const examples = readFileSync(join(root, 'data', 'gold.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
console.log(`supervision: ${examples.length} queries × ${TOOL_REGISTRY.length} registry tools`);

const FEATURES = ['cos', 'cos2', 'coverage', 'covCos', 'prior', 'nameHit', 'serviceHit', 'serviceHitCos', 'idfCoverage', 'charCos', 'bigramCoverage'];
const pairs = [];
for (const ex of examples) {
  const pos = new Set(ex.pos);
  for (const tool of TOOL_REGISTRY) {
    const f = featureVector(tool, ex.q);
    pairs.push({ q: ex.q, id: tool.id, x: FEATURES.map(k => f[k]), y: pos.has(tool.id) ? 1 : 0 });
  }
}

// split by query
const queries = shuffle(examples.map(e => e.q));
const nTest = Math.max(4, Math.round(queries.length * 0.2));
const testQs = new Set(queries.slice(0, nTest));
const train = pairs.filter(p => !testQs.has(p.q));
const test = pairs.filter(p => testQs.has(p.q));
console.log(`train ${train.length} pairs (${examples.length - nTest} queries) · test ${test.length} pairs (${nTest} queries)`);

// standardize on train stats
const mean = FEATURES.map((_, j) => train.reduce((s, p) => s + p.x[j], 0) / train.length);
const std = FEATURES.map((_, j) => Math.sqrt(train.reduce((s, p) => s + (p.x[j] - mean[j]) ** 2, 0) / train.length) || 1);
const norm = p => p.x.map((v, j) => (v - mean[j]) / std[j]);

// full-batch gradient descent on weighted logloss with L2
const NF = FEATURES.length; let w = new Array(NF).fill(0), b = 0;
const n = train.length;
for (let epoch = 0; epoch < EPOCHS; epoch++) {
  const g = new Array(NF).fill(0); let gb = 0;
  for (const p of train) {
    const x = norm(p);
    const z = b + w.reduce((s, wj, j) => s + wj * x[j], 0);
    const pred = 1 / (1 + Math.exp(-z));
    const wgt = p.y ? POS_WEIGHT : 1;
    const err = (pred - p.y) * wgt;
    for (let j = 0; j < NF; j++) g[j] += err * x[j];
    gb += err;
  }
  for (let j = 0; j < NF; j++) w[j] -= LR * (g[j] / n + L2 * w[j]);
  b -= LR * gb / n;
}

// bake standardisation back into raw-feature weights (runtime stays raw dot products)
const wRaw = w.map((wj, j) => wj / std[j]);
const bRaw = b - w.reduce((s, wj, j) => s + wj * mean[j] / std[j], 0);

const sigmoid = z => 1 / (1 + Math.exp(-z));
const scoreLearned = x => sigmoid(bRaw + wRaw.reduce((s, wj, j) => s + wj * x[j], 0));

// ── evaluation ──────────────────────────────────────────────────────────
function metrics(scoreFn, splitSet) {
  const byQ = new Map();
  for (const p of splitSet) {
    if (!byQ.has(p.q)) byQ.set(p.q, []);
    byQ.get(p.q).push({ id: p.id, y: p.y, s: scoreFn(p) });
  }
  let P5 = 0, R5 = 0, F15 = 0, ndcg5 = 0, mrr = 0;
  for (const rows of byQ.values()) {
    rows.sort((a, b) => b.s - a.s);
    const top5 = rows.slice(0, 5);
    const tp = top5.filter(r => r.y === 1).length;
    const total = rows.filter(r => r.y === 1).length;
    P5 += tp / 5; R5 += total ? tp / total : 0; F15 += (tp / 5 + (total ? tp / total : 0)) ? (2 * (tp / 5) * (total ? tp / total : 0)) / ((tp / 5) + (total ? tp / total : 0)) : 0;
    let dcg = 0;
    top5.forEach((r, i) => { if (r.y) dcg += 1 / Math.log2(i + 2); });
    const ideal = Math.min(5, total), idcg = Array.from({ length: ideal }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
    ndcg5 += idcg ? dcg / idcg : 0;
    const first = rows.findIndex(r => r.y === 1);
    mrr += first >= 0 ? 1 / (first + 1) : 0;
  }
  const m = byQ.size;
  return { P5: P5 / m, R5: R5 / m, F15: F15 / m, nDCG5: ndcg5 / m, MRR: mrr / m, queries: m };
}
const fmt = x => (x * 100).toFixed(1) + '%';
const learned = metrics(p => scoreLearned(p.x), test);
const classic = metrics(p => relevanceClassic(TOOL_REGISTRY.find(t => t.id === p.id), p.q), test);
console.log('\nHELD-OUT TEST (by query)           learned   classic');
for (const k of ['P5', 'R5', 'F15', 'nDCG5', 'MRR']) console.log(`  ${k.padEnd(6)} ${fmt(learned[k]).padStart(7)}  ${fmt(classic[k])}`);

// train-set sanity (overfitting check)
const learnedTrain = metrics(p => scoreLearned(p.x), train);

const params = `// GENERATED by scripts/train.mjs — do not edit by hand. Retrain: npm run train
export const LR = {
  kind: 'notary/lr',
  version: 1,
  trainedAt: ${JSON.stringify(new Date().toISOString())},
  features: ${JSON.stringify(FEATURES)},
  w: { ${FEATURES.map((k, i) => `${k}: ${wRaw[i]}`).join(', ')} },
  bias: ${bRaw},
  train: {
    seed: ${SEED}, posWeight: ${POS_WEIGHT}, l2: ${L2}, epochs: ${EPOCHS}, lr: ${LR},
    nQueries: ${examples.length}, nTrainPairs: ${train.length}, nTestPairs: ${test.length}, testQueries: ${nTest},
    test: { P5: ${learned.P5}, R5: ${learned.R5}, F15: ${learned.F15}, nDCG5: ${learned.nDCG5}, MRR: ${learned.MRR} },
    testClassic: { P5: ${classic.P5}, R5: ${classic.R5}, F15: ${classic.F15}, nDCG5: ${classic.nDCG5}, MRR: ${classic.MRR} },
    train: { P5: ${learnedTrain.P5}, R5: ${learnedTrain.R5}, nDCG5: ${learnedTrain.nDCG5} },
  },
};
`;
// calibrate the candidate-pool cutoff on TRAIN negatives (FPR ≤ 2%)
const trainNeg = train.filter(p => p.y === 0).map(p => scoreLearned(p.x)).sort((a, b) => a - b);
const fprTarget = 0.02;
const poolThreshold = trainNeg.length ? trainNeg[Math.floor((1 - fprTarget) * trainNeg.length)] : 0.15;
console.log(`pool cutoff (train negatives FPR≤2%): ${poolThreshold.toFixed(4)}`);
const params2 = params.replace("  kind: 'notary/lr',", `  poolThreshold: ${poolThreshold},\n  kind: 'notary/lr',`);
writeFileSync(join(root, 'src', 'core', 'model-params.js'), params2);
console.log('\nwrote src/core/model-params.js');
