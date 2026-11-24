# Notary — Integration Guide

_How Notary wires into a real agent flow. Everything here runs on the committed code —
no mock endpoints, no "coming soon."_

## Two integration shapes

| | **A · ChatGPT (OpenAI API)** | **B · MCP hosts (Claude Desktop, IDE agents)** |
|---|---|---|
| Mechanism | Custom GPT Action / chat-completions `tools:` | MCP `tools/list` gate in front of upstream servers |
| Entry point | `GET /v1/openai-tools?q=…` or `compileForOpenAI()` | `integrations/mcp-proxy.mjs` → `compileCatalog()` |
| Enforcement | Model only sees compiled tools; uncompiled calls impossible by absence | `authorize()` rejects any call outside the surface — fail closed, before upstream |
| Guarantee artefact | `certificate` (Bonferroni bound @ α=0.05) | same certificate |
| Audit | receipt per run (hash-chained) | same receipt |

## A · ChatGPT

**Option A1 — programmatic (fastest).**
```js
import { compileForOpenAI } from './integrations/openai-tools.mjs';
const { tools, certificate } = compileForOpenAI(userTask, { budget: 900, lambda: 0.5 });
// tools[] → chat.completions.create({ model, tools, messages })
```
Tool ids map to OpenAI-safe names (`drive.search_files` → `drive_search_files`, reversible via `fromOpenAIToolName`). Write-tools carry `[service; est. N tokens; write]` in their descriptions so the model can budget consciously.

**Option A2 — Custom GPT (Actions).** `integrations/openapi.yaml` documents `/v1/compile`, `/v1/openai-tools`, `/v1/verify`. Run `npm run serve` behind a public URL (fly.io/ngrok/your proxy — the facade binds 127.0.0.1 by default; set `HOST=0.0.0.0 PORT=…` to expose deliberately), paste the OpenAPI into the GPT’s Actions, and the GPT can ask Notary to compile before every plan. Validation failures surface as 422 with a reason.

**Execution.** The facade deliberately does NOT execute your tools — execution stays in your stack / the MCP upstream. Notary’s contract: *authorise + certify + (after you call) verify*. For the verify leg: run the task, collect `calls[]`, `POST /v1/verify` nothing — receipts are produced by `runTask` in `src/core/agent.js`; a standalone `/v1/execute` is intentionally out of scope (it would need your credentials and world-state — that’s the boundary).

## B · MCP gate (the reference pattern)

```js
import { compileCatalog, authorize } from './integrations/mcp-proxy.mjs';
const { tools, certificate } = compileCatalog(upstreamToolsList, query, { budget: 900 });
// send `tools` to the model …
authorize(surfaceFromCompile, 'notion.append_block'); // throws NOTARY-DENY otherwise
```
See `examples/mcp-flow.mjs` (`npm run example:mcp`) — upstream 86 tools in, compiled surface
out, out-of-surface call denied with the exact reason. Extend it to a JSON-RPC middleware
by wrapping your MCP client’s `tools/list` and `tools/call` handlers: filter on list,
authorize on call, append receipt to the hash chain.

## C · HTTP facade (language-agnostic)

`npm run serve` → `127.0.0.1:8787` (env `PORT`, `HOST`):

- `GET /healthz` — service + registry info
- `POST /v1/compile` — `{ query, budget?, lambda? }` → `{ surface, certificate, decision }` (422 on bad input; fail-closed empty surface for out-of-registry queries)
- `GET /v1/openai-tools?q=…&budget=…&lambda=…` — ready `tools:` array
- `POST /v1/verify` — `{ receipts }` → `{ valid, problems, checked }`

Body cap 1 MB; JSON only; CORS `*`. It is a localhost sidecar, not a public API — put it behind your own auth if you expose it.

## D · Receipts in CI

```bash
curl -s -X POST localhost:8787/v1/verify -d '{"receipts": [...]}' | jq .valid
```
Gate deploys on `valid === true`. A tampered receipt fails payload hash; a re-ordered chain fails the prev link.

## Threat model, briefly

- **Model hallucinates a tool id** → not in the compiled surface → `authorize` throws (B) or the call can’t exist (A — tool absent from `tools:`).
- **Tool returns 200 but lies** → verifier reads back real state; CONTRADICTED → bounded retry (≤2) → human escalation. FSR → 0 is the design property, enforced per write-tool postcondition.
- **Certificate abused as “ceiling”** → it isn’t: `calibratedBound` is a model estimate; the **guarantee attaches to `bound` (union bound, α = 0.05)** and nothing tighter.
- **Prompt injection telling the agent to “delete everything”** → compiler returns the smallest set for that intent (or an empty surface); write-tools still need preconditions; nothing bypasses verification.

## Known integration gaps (honest)

- No hosted public instance — self-host the facade (stateless, ~30 MB RAM).
- Receipts are produced by the in-repo agent; wiring `runTask` into your production agent loop is `agent.js`’s documented contract (`emit`, `world`, `faults` are injectable).
- MCP upstream authentication is your responsibility; the proxy never sees credentials.
