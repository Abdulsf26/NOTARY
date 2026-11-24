// Notary — BM25F (field-weighted BM25) scorer.
// Sources: Robertson BM25 (1994/2009); BM25F (Robertson–Zaragoza–Taylor 2004;
// Elasticsearch/Bleve field-boost in practice); lore: k1=1.2, b=0.75; short
// structured docs → b≈0.4; tool NAMES carry more signal than descriptions.
// Per-field saturated tf is weight-summed (practical field-boost formulation),
// Robertson smoothed IDF: log(1 + (N − df + 0.5)/(df + 0.5)).
// Same shaping contract as relevanceClassic: (0.62 + 0.85·coverage) · prior ·
// (1 + 0.35·serviceHit) — only the base scorer differs. Answerable guard:
// zero token overlap with the registry ⇒ 0, by construction.
import { TOOL_REGISTRY } from './registry.js';
import { tokenize } from './text.js';

const N = TOOL_REGISTRY.length;

export function createBm25f({ k1 = 1.2, wName = 3.0, wParams = 1.5, wDesc = 1.0, bName = 0.4, bParams = 0.75, bDesc = 0.75, S0 = 5.0 } = {}) {
  const docs = TOOL_REGISTRY.map(t => {
    const rawFields = {
      name: tokenize(`${t.service ?? ''} ${t.name.replace(/_/g, ' ')}`),
      params: tokenize(Object.keys(t.params).join(' ')),
      desc: tokenize(t.desc ?? ''),
    };
    const counts = {}, lens = {}, unionDf = new Set();
    const all = new Set();
    for (const k of Object.keys(rawFields)) {
      const m = new Map();
      for (const tok of rawFields[k]) { m.set(tok, (m.get(tok) || 0) + 1); all.add(tok); }
      counts[k] = m; lens[k] = rawFields[k].length;
    }
    return { id: t.id, tool: t, counts, lens, dfKeys: all };
  });
  const avg = { name: 0, params: 0, desc: 0 };
  for (const d of docs) for (const k of Object.keys(avg)) avg[k] += d.lens[k] / N;
  const dfs = { name: new Map(), params: new Map(), desc: new Map() };
  const dfAll = new Map();
  for (const d of docs) {
    for (const tok of d.dfKeys) dfAll.set(tok, (dfAll.get(tok) || 0) + 1);
    for (const k of Object.keys(dfs)) for (const tok of d.counts[k].keys()) dfs[k].set(tok, (dfs[k].get(tok) || 0) + 1);
  }
  const idf = (field, tok) => { const df = dfs[field].get(tok) || 0; return Math.log(1 + (N - df + 0.5) / (df + 0.5)); };
  const W = { name: wName, params: wParams, desc: wDesc };
  const B = { name: bName, params: bParams, desc: bDesc };
  const byId = new Map(docs.map(d => [d.id, d]));

  /** Raw BM25F score (≥ 0, unbounded). */
  function raw(tool, query) {
    const d = byId.get(tool.id);
    if (!d) return 0;
    let s = 0;
    for (const tok of new Set(tokenize(query))) {
      for (const k of ['name', 'params', 'desc']) {
        const f = d.counts[k].get(tok) || 0;
        if (!f) continue;
        const dl = d.lens[k] || 1, ad = avg[k] || 1;
        s += W[k] * idf(k, tok) * (f * (k1 + 1)) / (f + k1 * (1 - B[k] + B[k] * dl / ad));
      }
    }
    return s;
  }

  /** r(t|q) ∈ [0,1): saturating map 1−e^{−s/S0} under the classic shaping contract. */
  function relevance(tool, query) {
    const qTok = tokenize(query);
    const answerable = [...new Set(qTok)].filter(t => (dfAll.get(t) || 0) > 0);
    if (!answerable.length) return 0;
    const d = byId.get(tool.id);
    let matched = 0;
    for (const t of answerable) if (d.dfKeys.has(t)) matched++;
    const coverage = matched / answerable.length;
    const qSet = new Set(qTok);
    const serviceHit = tokenize(tool.service).some(t => qSet.has(t)) ? 1 : 0;
    const s = raw(tool, query);
    const sat = 1 - Math.exp(-s / S0);
    return Math.min(1, sat * (0.62 + 0.85 * coverage) * tool.prior * (1 + 0.35 * serviceHit));
  }

  return { raw, relevance, _internals: { avg, W, B, k1, S0 } };
}
