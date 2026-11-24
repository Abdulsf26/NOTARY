// Notary as an MCP gate — the pattern, reference implementation included.
// An MCP host (Claude Desktop, IDE agent, your orchestrator) receives tools/list from
// upstream MCP servers. Instead of forwarding all of them, compile this request first:
// the model only ever sees the certified surface, and any call outside it is rejected
// before it reaches the upstream server (fail closed), with the receipt as evidence.
//
//   const { tools, certificate } = compileCatalog(upstreamTools, query);
//   // → send `tools` to the model; on proposed call "notion.append_block":
//   authorize(certificate, "notion.append_block") // throws unless in the compiled surface
//
// Zero dependencies. Deterministic. ~7 ms per compile on an 86-tool catalog.
import { compileSurface } from '../src/core/selector.js';
import { TOOL_REGISTRY } from '../src/core/registry.js';

// catalog: MCP tools/list array [{ name, description, inputSchema }] — mapped onto the
// registry by id "<service>.<fn>". Unknown entries are DROPPED (never just passed through).
export function compileCatalog(catalog, query, { budget = 900, lambda = 0.5 } = {}) {
  const byId = new Map(TOOL_REGISTRY.map(t => [t.id, t]));
  const ids = new Set();
  for (const item of catalog ?? []) ids.add(String(item?.name ?? ''));
  const r = compileSurface(query, TOOL_REGISTRY, { budget, lambda });
  const allowed = new Set(r.selected.map(t => t.id));
  return {
    tools: (catalog ?? []).filter(item => allowed.has(String(item?.name ?? ''))),
    catalogDropped: [...ids].filter(id => !byId.has(id)),
    certificate: r.certificate,
    surface: r.selected.map(t => t.id),
  };
}

/** Authorize a proposed call against the compiled surface. Throws on violation — fail closed. */
export function authorize(certificateOrSurface, toolId) {
  const surface = Array.isArray(certificateOrSurface) ? certificateOrSurface : certificateOrSurface?.surface ? certificateOrSurface.surface : null;
  const allowed = surface ? new Set(surface.map(s => (typeof s === 'string' ? s : s.id))) : new Set();
  if (!allowed.has(String(toolId))) {
    const e = new Error(`NOTARY-DENY: ${toolId} was not in the compiled surface for this request (fail closed). It was never sent to the model.`);
    e.code = 'NOTARY_DENY';
    throw e;
  }
  return true;
}
