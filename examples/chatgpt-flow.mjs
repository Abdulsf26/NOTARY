// Example: Notary × OpenAI Chat Completions — the real wiring, runnable shape.
// No API key is embedded; export OPENAI_API_KEY to execute, or read this as the template.
import { compileSurface } from '../src/core/selector.js';
import { TOOL_REGISTRY } from '../src/core/registry.js';
import { toOpenAITools, fromOpenAIToolName } from '../integrations/openai-tools.mjs';

const query = 'Find the Q3 update in Drive, post the summary to the engineering Slack channel, append it to the Q3 Notion page, and log it on the Acme deal';
const r = compileSurface(query, TOOL_REGISTRY, { budget: 900, lambda: 0.5 });

console.log('certificate:', r.certificate.statement);
console.log('surface    :', r.selected.map(t => t.id).join(', '));
const tools = toOpenAITools(r.selected);
console.log('openai tools payload entries:', tools.length, '| first:', tools[0].function.name);

// ── then, with OPENAI_API_KEY set:
//   const res = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST',
//     headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
//     body: JSON.stringify({ model: 'gpt-5.1', tools, messages: [{ role: 'user', content: query }] }) });
// When the model proposes a call, gate it: assert the name maps back into the compiled surface.
const proposed = tools[0]?.function?.name;
if (proposed) console.log('gate check : model may only call compiled tools — e.g.', proposed, '→', fromOpenAIToolName(proposed));
