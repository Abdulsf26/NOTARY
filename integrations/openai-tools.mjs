// Notary → OpenAI Chat Completions `tools:` array.
// Registry param strings map 'name: type[?]' → JSON Schema. Tool ids (drive.search_files)
// become OpenAI-safe function names (drive_search_files) — collision-free here because no
// service name contains '_' and every function part matches [a-z0-9_]+.
// Usage:
//   const r = compileSurface(query, TOOL_REGISTRY, { budget: 900, lambda: 0.5 });
//   const tools = toOpenAITools(r.selected);
//   // → pass straight into chat.completions.create({ model, tools, messages })
import { compileSurface } from '../src/core/selector.js';
import { TOOL_REGISTRY } from '../src/core/registry.js';

const TYPE = { string: 'string', number: 'number', integer: 'integer', boolean: 'boolean', array: 'array', object: 'object' };

export function toOpenAIToolName(id) { return id.replace(/\./g, '_'); }
export function fromOpenAIToolName(name) { return name.replace('_', '.'); } // matches the one dot per id (service.fn)

function paramSchema(raw) {
  // "string?" → optional string · "array" → array of strings
  const optional = String(raw).endsWith('?');
  const base = optional ? String(raw).slice(0, -1) : String(raw);
  const schema = { type: TYPE[base] ?? 'string' };
  if (schema.type === 'array') schema.items = { type: 'string' };
  return { schema, optional };
}

export function toOpenAITools(selected) {
  return selected.map(t => {
    const properties = {}, required = [];
    for (const [key, raw] of Object.entries(t.params ?? {})) {
      const { schema, optional } = paramSchema(raw);
      properties[key] = schema;
      if (!optional) required.push(key);
    }
    return {
      type: 'function',
      function: {
        name: toOpenAIToolName(t.id),
        description: `${t.desc} [${t.service}; est. ${t.cost} tokens; ${t.kind}]`,
        parameters: { type: 'object', properties, required, additionalProperties: false },
      },
    };
  });
}

/** One call: query in → { tools, certificate } out. The full ChatGPT fast path. */
export function compileForOpenAI(query, { budget = 900, lambda = 0.5 } = {}) {
  const r = compileSurface(query, TOOL_REGISTRY, { budget, lambda });
  return { tools: toOpenAITools(r.selected), certificate: r.certificate, r };
}
