// Notary — tokenisation (shared), TF-IDF relevance, measured redundancy.
import { TOOL_REGISTRY, CALIBRATED_SIGMA } from './registry.js';
import { tokenize, rawTokens } from './text.js';
export { tokenize };

const docCache = new Map();
const docJoinedCache = new Map();
function doc(t) {
  if (!docCache.has(t.id)) {
    const toks = tokenize(`${t.service} ${t.name.replace(/_/g, ' ')} ${t.desc} ${Object.keys(t.params).join(' ')}`);
    docCache.set(t.id, toks);
    docJoinedCache.set(t.id, toks.join(' ') + ' ');
  }
  return docCache.get(t.id);
}

// IDF table over the registry
const N = TOOL_REGISTRY.length;
const df = new Map();
for (const t of TOOL_REGISTRY) {
  for (const tok of new Set(doc(t))) df.set(tok, (df.get(tok) || 0) + 1);
}
const idf = tok => Math.log((N + 1) / ((df.get(tok) || 0) + 1)) + 1;

function vec(tokens) {
  const v = new Map();
  const tf = new Map();
  for (const tok of tokens) tf.set(tok, (tf.get(tok) || 0) + 1);
  for (const [tok, f] of tf) v.set(tok, (1 + Math.log(f)) * idf(tok));
  return v;
}
const toolVecs = new Map(TOOL_REGISTRY.map(t => [t.id, vec(doc(t))]));

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [k, v] of a) { na += v * v; const bv = b.get(k); if (bv) dot += v * bv; }
  for (const v of b.values()) nb += v * v;
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Answerable = query tokens that exist somewhere in the registry (df ≥ 1).
 *  q3/acme/etc. appear nowhere, so they must not dilute every tool equally. */
let answerableCache = new Map();
function answerableSet(qTokens) {
  const key = qTokens.join(' ');
  if (!answerableCache.has(key)) answerableCache.set(key, new Set(qTokens.filter(t => (df.get(t) || 0) > 0)));
  return answerableCache.get(key);
}

// Per-query work (tokenize → tf-idf vec → answerable set → raw tokens) is query-dependent,
// not tool-dependent — memoise it once per process. This is what keeps compile < 50 ms.
const queryCache = new Map();
function queryParts(query) {
  const key = String(query);
  if (!queryCache.has(key)) {
    const qTokens = tokenize(key);
    queryCache.set(key, {
      qTokens,
      qv: vec(qTokens),
      answerable: answerableSet([...new Set(qTokens)]),
      raw: rawTokens(key),
      qSet: new Set(qTokens),
    });
  }
  return queryCache.get(key);
}

// char 3-gram TF vectors (cached per doc; per-query cached via queryParts)
function charVec(str) {
  const v = new Map();
  const clean = str.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const padded = ' ' + clean + ' ';
  for (let i = 0; i + 3 <= padded.length; i++) {
    const g = padded.slice(i, i + 3);
    if (g.trim()) v.set(g, (v.get(g) || 0) + 1);
  }
  return v;
}
const toolCharVecs = new Map(TOOL_REGISTRY.map(t => [t.id, charVec(`${t.service} ${t.name.replace(/_/g, ' ')} ${t.desc}`)]));
function charCosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [k, v] of a) { na += v * v; const bv = b.get(k); if (bv) dot += v * bv; }
  for (const v of b.values()) nb += v * v;
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Base features — cheap, shared by classic heuristic and the learned model.
function baseFeatures(tool, query) {
  const { qv, answerable, raw, qSet } = queryParts(query);
  const cos = cosine(qv, toolVecs.get(tool.id));
  const docTok = new Set(doc(tool));
  let matched = 0;
  for (const tok of answerable) if (docTok.has(tok)) matched++;
  const coverage = answerable.size ? matched / answerable.size : 0;
  // name hit: fraction of distinct raw query tokens present in the tool's name
  const nameTok = new Set(tokenize(tool.name.replace(/_/g, ' ')));
  let nameHit = 0;
  for (const t of raw) if (nameTok.has(t)) nameHit++;
  nameHit = raw.length ? nameHit / raw.length : 0;
  // service grounding: the query names the app (“post to Slack”, “… in Drive”) — the
  // strongest legitimate prior available before inference. Binary + interaction term.
  const serviceHit = tokenize(tool.service).some(t => qSet.has(t)) ? 1 : 0;
  return { cos, cos2: cos * cos, coverage, covCos: coverage * cos, prior: tool.prior, nameHit, serviceHit, serviceHitCos: serviceHit * cos, docTok, answerable };
}

// Learned-only query context, computed lazily so the classic path never pays for it
const queryCharCache = new Map();
const queryBigramCache = new Map();
function queryCharVec(query) {
  const key = String(query);
  if (!queryCharCache.has(key)) queryCharCache.set(key, charVec(key));
  return queryCharCache.get(key);
}
function queryBigrams(query) {
  const key = String(query);
  if (!queryBigramCache.has(key)) {
    const t = tokenize(key);
    queryBigramCache.set(key, t.length > 1 ? Array.from({ length: t.length - 1 }, (_, i) => t[i] + ' ' + t[i + 1]) : []);
  }
  return queryBigramCache.get(key);
}

/** Full feature vector for a (tool, query) pair — used by the learned model
 *  (offline training and VITE_NOTARY_SCORER=learned inference). The shipped
 *  classic scorer only needs baseFeatures, so production stays fast. */
export function featureVector(tool, query) {
  const base = baseFeatures(tool, query);
  const { docTok, answerable } = base;
  const qChar = queryCharVec(query), qBigrams = queryBigrams(query);
  const idfCovNum = [...answerable].reduce((acc, t) => acc + (docTok.has(t) ? idf(t) : 0), 0);
  const idfCovDen = [...answerable].reduce((acc, t) => acc + idf(t), 0);
  const idfCoverage = idfCovDen ? idfCovNum / idfCovDen : 0;
  // char 3-gram similarity — morphological robustness ("refund" ↔ "refunded")
  const charCos = charCosine(qChar, toolCharVecs.get(tool.id));
  // query bigram coverage — phrase-level matching
  const docJoined = docJoinedCache.get(tool.id) ?? (doc(tool), docJoinedCache.get(tool.id));
  let bgMatched = 0;
  for (const bg of qBigrams) if (docJoined.includes(bg)) bgMatched++;
  const bigramCoverage = qBigrams.length ? bgMatched / qBigrams.length : 0;
  const { docTok: _d, answerable: _a, ...rest } = base;
  return { ...rest, idfCoverage, charCos, bigramCoverage };
}

/** Classic (hand-tuned) relevance — the auditable production scorer, validated end-to-end. */
export function relevanceClassic(tool, query) {
  const { cos, coverage, prior, serviceHit } = baseFeatures(tool, query);
  const base = Math.min(1, Math.pow(cos * 2.6, 1.15));
  // service grounding (“post to Slack” ⇒ slack.*): bounded, documented boost; cos and
  // coverage still gate. Tips near-threshold decisions toward the app the query names.
  return Math.min(1, base * (0.62 + 0.85 * coverage) * prior * (1 + 0.35 * serviceHit));
}

// Learned relevance: logistic regression trained offline (scripts/train.mjs) on the
// authored supervision set (data/gold.jsonl), calibrated on a held-out split.
// Deterministic at runtime — a handful of float multiplies.
// SHIPS AS CHALLENGER: holdout parity with classic + a non-sparse operating point means
// the production scorer stays classic; build with VITE_NOTARY_SCORER=learned to enable.
import { LR } from './model-params.js';
const learned = LR && LR.version > 0 ? LR : null;
const SCORER = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_NOTARY_SCORER) || 'classic';
export const scorerName = SCORER;

/** Relevance r(t|q) ∈ [0,1] — trained model when present, classic heuristic otherwise.
 *  Fail-closed contract: a query that shares NO token with the registry (answerable set
 *  is empty) is relevant to nothing — 0 by construction, regardless of priors. */
export function relevance(tool, query) {
  const { qSet, answerable } = queryParts(query);
  if (qSet.size === 0 || answerable.size === 0) return 0;
  if (SCORER !== 'learned' || !learned) return relevanceClassic(tool, query);
  const f = featureVector(tool, query);
  let z = learned.bias;
  for (const k of learned.features) z += learned.w[k] * (f[k] ?? 0);
  return 1 / (1 + Math.exp(-z));
}

/** Candidate-pool cutoff for the compiler: smallest score t such that, on TRAIN negatives,
 *  at most `fpr` fraction score above it. Calibrated offline (scripts/train.mjs). */
export function poolThreshold() {
  // cutoff is calibrated per scorer: learned uses the train-negatives FPR calibration;
  // classic uses the documented hand-set 0.15 the demo was validated at.
  if (SCORER !== 'learned') return 0.15;
  return learned?.poolThreshold ?? 0.15;
}

const jaccardCache = new Map();
function jaccard(a, b) {
  const key = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
  if (jaccardCache.has(key)) return jaccardCache.get(key);
  const A = new Set(doc(a)), B = new Set(doc(b));
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  const j = union === 0 ? 0 : inter / union;
  jaccardCache.set(key, j);
  return j;
}

/** Redundancy σ(ti,tj) ∈ [0,1]: normalised Jaccard over name+description+params, calibrated for known near-duplicates. */
export function redundancy(ti, tj) {
  const key = [ti.id, tj.id].sort().join('|');
  if (CALIBRATED_SIGMA[key] !== undefined) return CALIBRATED_SIGMA[key];
  return Math.min(1, jaccard(ti, tj) * 1.6);
}
