// 5-fold CV comparison of LR feature sets on the 65 gold queries — does the new-feature
// gain generalise, or is it a lucky 80/20 split? Report mean ± sd.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_REGISTRY } from '../src/core/registry.js';
import { featureVector, relevanceClassic } from '../src/core/similarity.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const examples = readFileSync(join(root, 'data', 'gold.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

const ORIG = ['cos', 'cos2', 'coverage', 'covCos', 'prior', 'nameHit', 'serviceHit', 'serviceHitCos'];
const FULL = [...ORIG, 'idfCoverage', 'charCos', 'bigramCoverage'];

// seeded shuffle (independent of train.mjs's single split)
const SEED = 20261124;
let s = SEED >>> 0;
const rand = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
const shuffled = (() => { const a = [...examples]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; })();
const folds = [[], [], [], [], []];
shuffled.forEach((ex, i) => folds[i % 5].push(ex));

const precompute = (queries) => {
  const map = new Map();
  for (const ex of queries) {
    const pos = new Set(ex.pos);
    map.set(ex.q, TOOL_REGISTRY.map(t => ({ id: t.id, y: pos.has(t.id) ? 1 : 0, f: featureVector(t, ex.q) })));
  }
  return map;
};
const all = precompute(examples);

function trainFold(trainEx, FEATURES) {
  const pairs = [];
  for (const ex of trainEx) for (const row of all.get(ex.q)) pairs.push({ x: FEATURES.map(k => row.f[k]), y: row.y });
  const mean = FEATURES.map((_, j) => pairs.reduce((a, p) => a + p.x[j], 0) / pairs.length);
  const std = FEATURES.map((_, j) => Math.sqrt(pairs.reduce((a, p) => a + (p.x[j] - mean[j]) ** 2, 0) / pairs.length) || 1);
  const norm = x => x.map((v, j) => (v - mean[j]) / std[j]);
  const NF = FEATURES.length; let w = new Array(NF).fill(0), b = 0;
  const n = pairs.length, POS_WEIGHT = 4, L2 = 3e-3, LR2 = 0.5, EPOCHS = 4000;
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    const g = new Array(NF).fill(0); let gb = 0;
    for (const p of pairs) {
      const x = norm(p.x);
      const z = b + w.reduce((a, wj, j) => a + wj * x[j], 0);
      const pred = 1 / (1 + Math.exp(-z));
      const err = (pred - p.y) * (p.y ? POS_WEIGHT : 1);
      for (let j = 0; j < NF; j++) g[j] += err * x[j];
      gb += err;
    }
    for (let j = 0; j < NF; j++) w[j] -= LR2 * (g[j] / n + L2 * w[j]);
    b -= LR2 * gb / n;
  }
  const wRaw = w.map((wj, j) => wj / std[j]);
  const bRaw = b - w.reduce((a, wj, j) => a + wj * mean[j] / std[j], 0);
  return (f) => { const z = bRaw + FEATURES.reduce((a, k, j) => a + wRaw[j] * f[k], 0); return 1 / (1 + Math.exp(-z)); };
}

function metrics(scoreFn, testEx) {
  let ndcg5 = 0, mrr = 0;
  for (const ex of testEx) {
    const rows = all.get(ex.q).map(r => ({ y: r.y, s: scoreFn(r.f) })).sort((a, b) => b.s - a.s);
    let dcg = 0;
    for (let i = 0; i < 5; i++) if (rows[i].y) dcg += 1 / Math.log2(i + 2);
    const total = rows.filter(r => r.y === 1).length;
    const ideal = Math.min(5, total);
    const idcg = Array.from({ length: ideal }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
    ndcg5 += idcg ? dcg / idcg : 0;
    const first = rows.findIndex(r => r.y === 1);
    mrr += first >= 0 ? 1 / (first + 1) : 0;
  }
  return { nDCG5: ndcg5 / testEx.length, MRR: mrr / testEx.length };
}

for (const [name, FEATURES] of [['orig8', ORIG], ['full11', FULL]]) {
  const r = [];
  for (let k = 0; k < 5; k++) {
    const testEx = folds[k];
    const trainEx = folds.filter((_, i) => i !== k).flat();
    const score = trainFold(trainEx, FEATURES);
    r.push(metrics(score, testEx));
  }
  const mean = f => r.reduce((a, x) => a + x[f], 0) / r.length;
  const sd = f => Math.sqrt(r.reduce((a, x) => a + (x[f] - mean(f)) ** 2, 0) / r.length);
  console.log(`${name.padEnd(7)} nDCG5 ${(mean('nDCG5') * 100).toFixed(1)} ± ${(sd('nDCG5') * 100).toFixed(1)}  MRR ${(mean('MRR') * 100).toFixed(1)} ± ${(sd('MRR') * 100).toFixed(1)}`);
}
