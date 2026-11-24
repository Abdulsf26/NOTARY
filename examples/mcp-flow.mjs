// Example: Notary as an MCP gate (simulated upstream tools/list, no network needed).
import { TOOL_REGISTRY } from '../src/core/registry.js';
import { compileCatalog, authorize } from '../integrations/mcp-proxy.mjs';

const upstream = TOOL_REGISTRY.map(t => ({ name: t.id, description: t.desc, inputSchema: { type: 'object' } }));
const query = 'Post the Q3 update to #engineering and log it on the Acme deal';
const { tools, certificate, surface } = compileCatalog(upstream, query, { budget: 900, lambda: 0.5 });
console.log(`upstream tools : ${upstream.length}`);
console.log(`model sees     : ${tools.length}  → ${tools.map(t => t.name).join(', ')}`);
console.log(`certificate    : ${certificate.statement}`);
for (const id of ['slack.post_in_channel', 'stripe.create_refund']) {
  try { authorize(surface, id); console.log(`authorize      : ✓ ${id}`); }
  catch (e) { console.log(`authorize      : ✗ ${e.message.split('.')[0]}`); }
}
