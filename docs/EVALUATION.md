# Notary — Evaluation Report

_Reproduce everything: `npm run train && npm run calibrate && npm test && npm run smoke && node scripts/eval.mjs`_
_All numbers below are from the committed, seeded pipeline (seed 20261124). Nothing is hand-tuned after the fact._

## 1 · Learned relevance model (candidate challenger)

**Supervision.** `data/gold.jsonl` — 65 natural-language task queries authored for the registry
(86 tools, closed set). Positives = tools the task requires; everything else = negatives
(5,518 negatives vs 72 positives — distant supervision over a closed registry).

**Model.** Logistic regression on TF-IDF cosine × coverage × prior × service-grounding features
(cos, cos², cross-coverage, prior, nameHit, serviceHit, serviceHit×cos), full-batch gradient
descent, L2 = 3e-3, positive-class weight 4.0, 4,000 epochs. Held-out split **by query** (80/20,
seeded; 13 test queries never seen in training).

**Held-out results (test queries).**

| Metric   | Learned | Classic (shipped) |
|----------|---------|-------------------|
| P@5      | 20.0%   | 20.0%             |
| Recall@5 | 92.3%   | 92.3%             |
| F1@5     | 32.6%   | 32.6%             |
| nDCG@5   | 89.5%   | 87.9%             |
| MRR      | 88.6%   | 86.6%             |

**11 features, honestly measured.** The learned model uses [cos, cos², coverage, covCos, prior,
nameHit, serviceHit, serviceHitCos, idfCoverage, charCos, bigramCoverage]. On the single seeded
80/20 split the three new features move nDCG@5 89.5 → 92.3 and MRR 88.6 → 92.4. A 5-fold
cross-validation (`node scripts/cv-features.mjs`) shows the gain is modest — **orig8: 88.6 ± 5.2
nDCG@5, 88.2 ± 5.7 MRR · full11: 89.4 ± 5.3 nDCG@5, 89.0 ± 5.4 MRR** — i.e. the held-out win is
partly split-luck. New features are kept because they never hurt; no unmeasured claims attached.

**Why classic ships.** The learned model wins ranking metrics modestly, but at the compiler's
hard operating point it admits irrelevant tools with mid-range sigmoid scores — measured, not
asserted: on the hero task it proposes ~11 tools vs classic ~11 at F 4.15 after
service grounding was added to classic (re-verified 2026-11-24 on the retrained challenger), and it fills every budget completely. Holdout cannot
distinguish the two at n = 13 queries. Decision: **classic ships; learned stays as a benchmarked
challenger** — enable with `VITE_NOTARY_SCORER=learned npm run build`. Both share the
fail-closed answerable guard (queries sharing no token with the registry score 0).

## 2 · Certificate calibration (split-conformal, Monte-Carlo)

`npm run calibrate` simulates 40,000 synthetic episodes per surface size n ∈ [1, 8], half used
to fit per-size conformal inflation factors on the stochastic tail, half held out to verify.
Actuals drawn lognormal under the fitted dispersion (σ = 0.85, p95-calibrated medians).

| n | Bonferroni breach | Conformal (×factor) |
|---|-------------------|---------------------|
| 1 | 5.44%             | 5.21% (×1.02)       |
| 2 | 1.53%             | 4.64% (×0.68)       |
| 3 | 0.49%             | 5.82% (×0.51)       |
| 4 | 0.20%             | 5.06% (×0.44)       |
| 5 | 0.08%             | 4.22% (×0.40)       |
| 6 | 0.08%             | 4.70% (×0.36)       |
| 7 | 0.04%             | 5.07% (×0.33)       |
| 8 | 0.00%             | 5.09% (×0.31)       |

**Shipped semantics.** `certificate.bound` = Bonferroni union bound — **the guarantee attaches
to this number only**. `certificate.calibratedBound` = conformal-tightened estimate (model-fitted,
α-level coverage) and `certificate.estimateMedian` = p50 quote — both labelled, both excluded from
the guarantee claim. Bonferroni measures conservative at n ≥ 2, near-exact at n = 1 (5.44%, within
≈ 1.3 Monte-Carlo σ of 5%).

**Honest scope.** Calibration under the fitted model, not production telemetry. Swapping in
real token logs replaces the Monte-Carlo the same day; the harness and the certificate schema
already consume it (`npm run calibrate`).

## 3 · Compiler

- **Greedy ≥ (1−1/√e)·OPT**, **greedy + 3-element seed enumeration ≥ (1−1/e)·OPT** (Sviridenko 2004);
  exact ILP oracle unnecessary at n ≤ 600.
- **Marginal floor δ = 0.05**: greedy stops when nothing left is worth ≥ δ to F at insertion
  time (submodular maximisation with threshold δ — preserves the approximation structure,
  only shrinks S). Every selected tool has r(t|q) ≥ δ by construction.
- **Measured**: enumerating 469 seeds on the hero task yields F = greedyF = 4.147 at the λ-clamped
  operating point (λ_max = 0.0724 — the monotonicity guard binds hard because one weak pool tool
  pairs heavily with the rest). Enumeration never loses (F ≥ greedyF asserted in tests), but the
  marginal gain of enumeration at this operating point is 0.00% — the clamp keeps redundancy almost
  free, so greedy is already near-optimal. Lower-λ_max regimes (service-grounding off, or the
  learned scorer) show the classical enumeration gain (was +9.8% pre-clamp). Winsorised λ_max bounds
  are future work — the hard min-clamp is kept because it is the sufficient condition for monotonicity,
  and we do not ship unproven loosenings of a guarantee-bearing bound;
  exploration explores seeds only while cost ≤ B.
- **Latency**: 596 ms → **~9 ms warm** (300-run mean, 86-tool registry, re-measured 2026-11-24;
  memoisation, a WeakMap-cached σ matrix, incremental-penalty greedy and r/cost density pruning.
  Cold start ≈ 50 ms (one-time σ matrix). Deterministic.

## 4 · End-to-end (fault injection)

| Scenario                                | Result                                             |
|-----------------------------------------|-----------------------------------------------------|
| Silent no-op armed, protected run       | CONTRADICTED → bounded retry → CONFIRMED; falseSuccessCaught = 1 |
| Same fault, unprotected baseline        | “Done!” on 200 OK; 1 of 3 writes never happened    |
| Receipt chain after run                 | verifyChain ✓ (genesis → … sealed)                 |
| Empty query / out-of-registry query     | Empty surface — fails closed, zero spend           |

## 4b · Exact-oracle optimality gap (compiler quality, measured)

Greedy + enumeration is the inference-time path; the (1−1/e) theorem is only a lower bound on
optimality. `node scripts/eval.mjs` now also computes the **exact optimum** F* over each gold
query via branch-and-bound over all tools with r > 0 (valid upper bound: membership-penalised
marginals, δ among remaining candidates dropped) and compares against `compileSurface`:

**mean F / F* = 99.86% over the 65 gold queries · every query ≥ 98.3% of optimum**

— i.e. on this registry, at this operating point (B = 900, λ = 0.5, λ_max clamp binding), the
shipped compiler is effectively optimal, far above the (1−1/e) floor. One query (pool = 47) hit
the 5M-node tractability ceiling; for it F\* reported by the search is a lower bound and the true
gap is smaller. This is compiler accuracy evidence the theorem cannot give by itself.

## 5 · Challenger scorers that were measured and rejected

`node scripts/eval.mjs` — same seeded 80/20 query split as `train.mjs`. Ranking metrics on held-out
test queries, plus a selection-level proxy (pool ≥ poolCutoff, classic cut 0.15, learned cut
LR poolThreshold ≈ 0.179) measuring whether the greedy compiler would surface a relevant tool
within budget at all.

| Scorer                                 | nDCG@5 | nDCG@10 | MRR   | Selection recall (train / test) |
|----------------------------------------|--------|---------|-------|----------------------------------|
| Classic (shipped)                      | 87.9%  | 87.9%   | 86.6% | 100.0% / 100.0% (≈ 5.7 / 6.4 tools compiled) |
| Learned LR (challenger, 11 features)   | 92.3%  | 92.3%   | 92.4% | 96.6% / 100.0% (≈ 2.7 / 2.5 tools) |
| BM25F fielded, S0 ∈ {4, 5, 6}          | 72.2%  | 72.2%   | 67.0% | — not evaluated (ranking failed)  |
| Hybrid 50/50 · 60/40 · 40/60 (classic:BM25F) | 87.9% | 87.9% | 86.6% | 98.3% / 100.0% (≈ hybrid collapses onto classic ranking) |

**BM25F was evaluated and rejected.** The Stacklok / WANDS literature (field-weighted BM25 with
name ≈ 3× description weight; +7.4 nDCG on WANDS when fused with embeddings) did not transfer to
this registry: gold queries are short keyword-dense strings over 86 short tool documents, name/desc
field length normalisation saturates (S0 ∈ {4,5,6} all identical), and held-out nDCG@5 drops ~16
points vs classic. Fusing with classic changes nothing — the RRF/rank fusion was not needed because
the hybrid inherits classic's cutoffs verbatim. Hybrids stay in the tree as an experiment, **never
wired to the compiler**. Selection recall is the metric that closes the case: classic surfaces a
relevant tool for **100%** of held-out queries at ~6 compiled tools; no challenger beat it.

Fail-closed behaviour (junk / answerable guard): classic / BM25F / hybrid score **0.0000** on
answerable-set violations; learned LR scores ≤ 0.006 (below its pool cutoff 0.179 — still fails
closed at the compiler but not exactly zero, recorded honestly).

## 6 · Known limits

- Holdout n = 13 queries; metrics are ranking metrics, not downstream task success.
- σ for near-duplicates is partially hand-calibrated (`CALIBRATED_SIGMA`).
- DISPERSION is global per registry (per-class calibration is roadmap).
- Certificate's guarantee reduces to the token model; telemetry swap pending design partners.
