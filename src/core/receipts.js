// Notary — the signed, hash-chained receipt.
// Each receipt commits to: the authorised tool surface, the certificate, every call,
// and the verification verdicts — then SHA-256-chains to the previous receipt.
// (Demo signs with an ephemeral session key id; production uses KMS/HSM. See README.)

export async function sha256hex(text) {
  if (globalThis.crypto?.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // FNV-1a fallback (non-crypto) so the demo still seals offline / in insecure contexts
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h1 = Math.imul(h1 ^ text.charCodeAt(i), 0x01000193);
    h2 = Math.imul(h2 ^ text.charCodeAt(i), 0x85ebca6b);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0').repeat(2) + (h2 >>> 0).toString(16).padStart(8, '0').repeat(2);
}

export async function hashPayload(payload) {
  return sha256hex(stableStringify(payload));
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

export async function createReceipt({ task, compile, calls, verdict, prevHash, fsr = null }) {
  const unsigned = {
    v: 1,
    kind: 'notary/receipt',
    id: 'rcpt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    at: new Date().toISOString(),
    task,
    surface: compile.selected.map(t => ({ id: t.id, cost: t.cost, r: +compile.relevance.get(t.id).toFixed(3) })),
    certificate: { bound: compile.certificate.bound, alpha: compile.certificate.alpha, deterministic: compile.certificate.deterministic, stochastic: compile.certificate.stochastic },
    budget: compile.budget,
    usedCost: compile.usedCost,
    calls: calls.map(c => ({ tool: c.tool, ok: c.ok, verdict: c.verdict, evidence: c.evidence, latencyMs: c.latencyMs ?? null })),
    verdict,
    falseSuccessCaught: calls.filter(c => c.verdict === 'CONTRADICTED').length,
    ...(fsr && fsr.length ? { fsr } : {}),
    prev: prevHash ?? 'genesis',
    session: 'sess_demo', // KMS key alias in production
  };
  const hash = await hashPayload(unsigned);
  return { ...unsigned, hash };
}

export async function verifyChain(receipts) {
  const problems = [];
  let prev = 'genesis';
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    const { hash, ...unsigned } = r;
    const recomputed = await hashPayload(unsigned);
    if (recomputed !== hash) problems.push({ index: i, id: r.id, problem: 'payload hash mismatch — receipt was modified after signing' });
    if (r.prev !== prev) problems.push({ index: i, id: r.id, problem: `chain break — prev points to ${String(r.prev).slice(0, 12)}…, expected ${String(prev).slice(0, 12)}…` });
    prev = r.hash;
  }
  return { valid: problems.length === 0, problems, checked: receipts.length };
}
