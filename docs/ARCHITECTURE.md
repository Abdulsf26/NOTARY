# Notary — Architecture

_Diagram: `docs/architecture.drawio` — full system view (opens in [draw.io](https://app.diagrams.net) / diagrams.net). Rendered in every commit-audience; mirrors this document._

## 0. What this is
Notary is a protocol-level control plane around MCP tool use. It does three things, in order, for every request: **compile** the tool surface under a hard token budget, **commit** to a pre-flight cost with a stated confidence, and **prove** what actually happened with a read-back verifier and a hash-chained receipt.

```
compile(S*)  →  certificate C(S)  →  act  →  verify(φ_post)  →  receipt (hash-chained, signed)
```

## 1. Formal problem — Budgeted Tool-Surface Selection (BTSS)

Given query `q`, registry `T = {t₁..tₙ}` (n ≈ 527 at LiveMCPBench scale):
- `d(t)` — tokens of t's full descriptor (name + prose + JSON Schema, modelled at ~3.6 chars/token + per-param schema overhead)
- `r(t|q) ∈ [0,1]` — relevance. Here: TF-IDF (over registry corpus) cosine × query-coverage factor × learned prior, deterministic, no LLM call. Production: embedding similarity ⊙ prior.
- `σ(tᵢ,tⱼ) ∈ [0,1]` — redundancy. Normalised Jaccard over name+description+parameter tokens, with a calibrated pair table (e.g. `post_in_channel|post_in_thread = 0.85`) for near-duplicate surfaces the metric under-scores.
- `B` — token budget = context window − reserve(system, history, output)

```
maximise   F(S) = Σ_{t∈S} r(t|q)  −  λ · Σ_{{t,t'}⊆S} σ(t,t′)
subject to Σ_{t∈S} d(t) ≤ B
```

**Why the σ term exists.** The documented dominant failure is not "can't find the tool" but "two tools are both sort of right" (`create_post` vs `create_scheduled_post`). Attention-segment analysis (arXiv 2606.16364) shows input-side repairs recover ≤ 23% of selection failures. Penalising redundant surfaces **by construction** does at compile time what cannot be fixed at readout time.

**Why not top-k by similarity.** Top-k ignores cost and ambiguity. The relevance-ranked top-5 of the dossier's worked example costs 1,160 > B = 900 — *infeasible*. Retrieval-first systems in that class ship infeasible or mis-picked surfaces.

## 2. Theorem 1 — F is submodular; condition for monotonicity

Marginal of adding t to S:
```
Δ_S(t) = r(t|q) − λ · Σ_{t′∈S} σ(t,t′)
```
Every t′ already in S can only reduce Δ_S(t) (σ ≥ 0) — diminishing returns ⇒ **F is submodular**.

F is monotone non-decreasing iff `r(t|q) ≥ λ · Σ_{t′} σ(t,t′)`. In the worst case (λ too large) F goes non-monotone and classic guarantees evaporate. We therefore clamp:

```
λ_max = min over candidate pool (r ≥ 0.15)  r(t|q) / ( Σ_{pool} σ(t,t′) + ε )
λ ← min(λ, λ_max)
```
(The pool restriction is the practical guard: over all n tools Σσ grows linearly with registry size and λ_max → 0, which would delete the redundancy penalty entirely. Documented in `src/core/selector.js`. The clamp engages visibly in the UI — judges can watch it fire.)

## 3. Theorem 2 — (1 − 1/e) via seed enumeration
BTSS is NP-hard (at λ = 0 it contains budgeted maximum coverage, which contains knapsack). We ship:
1. **Cost-benefit greedy** — repeatedly add argmax Δ_S(t)/d(t) while the gain is positive and the budget holds. Alone: ≥ (1 − 1/√e) ≈ 0.393·OPT.
2. **Enumeration of all seeds up to size 3** over the shortlist of top-14 by r, then greedy extend; keep the best-F result. Sviridenko (2004): **F ≥ (1 − 1/e)·OPT ≈ 0.632·OPT**.

Complexity: O(shortlist³ · n·k) with heavy pruning; < 10 ms typical at n ≤ 600 (n = 86 in this demo, ≈ 9 ms measured). An exact branch-and-bound oracle runs offline in `scripts/eval.mjs` over the r > 0 pool — measured mean F / F* = 99.86% over the 65 gold queries (min 98.3%).

## 4. Cost certificate (union bound)
`X_t` = tokens returned by tool t, modelled lognormal, calibrated so p95 matches the registry table. For α = 0.05 and surface size |S|:
```
C(S) = Σ_{t∈S} d(t)  +  Σ_{t∈S} F̂⁻¹_t(1 − α/|S|)          (Bonferroni per-tool confidence 1 − α/|S|)
```
**Claim.** P(actual total > C(S)) ≤ α. Proof: each term exceeds its (1 − α/|S|)-quantile with probability ≤ α/|S|; union bound over |S| terms gives ≤ α. Independence not required.

We report breaches publicly; α widens adaptively until the breach rate ≤ α. *A guarantee you audit in public is a business; one you hide is a lawsuit.*

## 5. Effect contracts & the read-back verifier
For every WRITE tool:
```
contract(t) = ( pre: φ_pre, post: φ_post, readback: read_t, idempotency: key )
```
Protocol:
```
1. assert φ_pre(state)                      → abort if false (fail closed)
2. r ← call(t, params, idempotency_key)     → HTTP 200 is NOT success
3. s ← call(read_t, locator from r)         → read the real post-write state
4. emit CONFIRMED if φ_post(s) else CONTRADICTED
5. on CONTRADICTED → bounded retry (≤ 2) with corrected reference → else human escalation
```
The demo ships a **silent no-op fault injector**: with fault injection armed, the FIRST write tool call of a run returns HTTP-200 and persists nothing (any write tool — Notion, Slack, Stripe, …). The trajectory itself is computed live from the typed query by a deterministic planner (src/core/planner.js); reads are staged before writes; cross-step content is composed from read results; intents whose tools aren't in the compiled surface fail closed. The verifier catches the swallowed write 100% of the time and a bounded retry (≤ 2, target re-resolved — never a blind retry) lands the effect for real. Writes carry idempotency keys (SHA-256 of task+tool+params): confirmed writes replay exactly-once from localStorage instead of double-executing. Per-tool False-Success-Rate is tracked as a Beta(1,1) posterior with a Wilson 95% interval and a 14-day half-life decay (src/core/fsr.js).

**FSR** = P(2xx ∧ ¬φ_post). Baseline agents have an invisible, large FSR. Notary measures it and drives it to zero by construction. Receipts record `falseSuccessCaught`.

## 6. Receipts — hash-chained audit artifacts
```
receipt = { v, kind, id, at, task, surface[], certificate{bound,α,det,stoch},
            budget, usedCost, calls[], verdict, falseSuccessCaught, prev, session }
hash    = SHA-256( stableStringify(receipt) )        prev = hash of previous receipt ('genesis' for #1)
```
`verifyChain()` re-hashes every receipt and checks every link. Trust the hash, not us. Production: signs with a KMS/HSM alias; receipts are content-addressed for replay by Step Functions (re-run of a *verified* plan at ~0 marginal cost).

## 7. Fail modes & answers (engineering, not marketing)
| Failure | Answer |
|---|---|
| λ too high → non-monotone F | λ_max clamp (§2) |
| Certificate breach | Log every breach, publish rate, widen α adaptively (§4) |
| Verifier wrong (false CONFIRMED) | Double read-back on high-stakes writes; verifier output itself receipted |
| Model wants an excluded tool | Fail closed + one-click "add tool / raise budget" upsell |
| Registry poisoning | Signed registries, provenance metadata, per-org allowlists |
| Cold-start calibration | Bootstrap p95 from schema size; α = 0.20 week 1 → tighten |
| Notary down | Fail open for reads (SLO), fail closed for writes |

## 8. Production mapping (AWS + ElevenLabs)
Bedrock Converse (reasoning) + Guardrails (input-side injection defence, complementing our output-side verification) · OpenSearch Serverless vector (descriptors, ≤ 9 ms ANN) · DynamoDB (registry, calibration, **hash-chain log**) · Fargate (stateless compiler/verifier) · Step Functions (deterministic replay of verified plans) · EventBridge (scheduled verified digests — recurring value) · CloudWatch (α-breach, FSR p95 alarms) · Cognito (tenant scoping) · ElevenLabs Flash (spoken consent + spoken receipts, Tamil/Hindi/English — voice as the accountability channel and as distribution).

## 9. Sources
AgentPMT *The MCP Bloat Tax* (Feb 2026) · Quandri Engineering (2026) · Cloudflare Code Mode (Sep 2025/2026) · Speakeasy/Albato/Lunar.dev benchmarks (2026) · arXiv 2606.16364 *Looking Is Not Picking* · arXiv 2505.03275 *RAG-MCP* · arXiv 2606.20047 *PACMS* · arXiv 2610.23707 *Tool Recommendation* · arXiv 2508.01780 *LiveMCPBench* · Sviridenko, *A note on maximizing a submodular set function subject to a knapsack constraint* (2004) · arXiv 2510.03285 *WAREX* · Anthropic *Claude for Chrome* · WAREX/WebArena.

---

## Addendum — operating point (2026-11-24)

Three refinements to the compile path, all measured (docs/EVALUATION.md):

**Marginal floor δ = 0.05.** BTSS is run as *budgeted submodular maximisation with threshold*:
greedy (and every seed extension) stops when no remaining tool can contribute ≥ δ to F. This
prunes “budget padding” — tools whose marginal is positive but commercially meaningless — at the
cost of a provable constant factor in the approximation bound. Every selected tool now satisfies
r(t|q) ≥ δ by construction. δ is exposed as `compileSurface(…, { delta })`.

**Certificate, calibrated view.** The reported `bound` remains the Bonferroni union bound — the
guarantee attaches to it and nothing else. `calibratedBound` (per-surface-size split-conformal
factors, fitted on 40k seeded synthetic episodes, verified on a held-out half) and `estimateMedian`
(p50 quote) are shipped alongside as clearly-labelled *model estimates*, never as the guarantee.
Calibration under the fitted lognormal model is the current state; swapping in production token
telemetry makes the conformal layer empirical — same code path (`npm run calibrate`).

**Service grounding.** `serviceHit(t,q) ∈ {0,1}` — whether the query names the tool’s service
(Slack, Drive, Notion, CRM, …) — is a first-class feature of both scorers (bounded ×1.35 in the
production heuristic; learned weight in the challenger). App-named prompts are the dominant real
shape of MCP requests; the feature is discriminative without replacing lexical evidence.

## Addendum — pins & blocks (2026-11-24)

`compileSurface(query, registry, { ..., pin, block })` lets an operator force tools in or out.

- **block** removes tools from the greedy candidate pool entirely (a blocked tool cannot be selected,
  enumerated or pinned). Block beats pin: an id present in both is blocked.
- **pin** forces named tools onto the compiled surface *after* greedy completes, subject to a
  **hard token budget**: a pinned tool that does not fit the remaining budget is excluded and the
  exclusion is reported in `pinNotes` (never silently dropped).
- **(1 − 1/e) · OPT applies over the unforced remainder only.** The guarantee is inherited from the
  seed-enumerated greedy run over `P \ (block ∪ pin)`; pins are added post-hoc under a hard-budget
  rule, so the bound covers the remainder, not the pinned additions. Any other reading would be a
  false claim and is refused.
- Returned surface object gains `forced[]` (ids pinned in), `pinNotes[]` (budget exclusions) and
  `blockedCount`.
