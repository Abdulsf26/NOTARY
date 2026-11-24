// Notary — zero-dependency HTTP facade for the compiler + verifier.
// This is the "ready to integrate" surface: ChatGPT GPT Actions (via integrations/openapi.yaml),
// your own backend, CI pipelines, or a local sidecar — anything that speaks JSON over HTTP.
// Run: npm run serve            (defaults 127.0.0.1:8787)
// Env: PORT=8787 HOST=0.0.0.0   (expose deliberately, e.g. behind your proxy)
import http from 'node:http';
import { compileSurface } from '../src/core/selector.js';
import { TOOL_REGISTRY, TOTAL_REGISTRY_TOKENS } from '../src/core/registry.js';
import { verifyChain } from '../src/core/receipts.js';
import { toOpenAITools } from '../integrations/openai-tools.mjs';
import { createFileLogger } from './logger.mjs';

const log = createFileLogger('notary-facade');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 1024 * 1024; // 1 MB

const json = (res, code, obj) => {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  res.end(body);
};
const fail = (res, code, error) => json(res, code, { error });

const readBody = req => new Promise((resolve, reject) => {
  let size = 0, chunks = [];
  req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('invalid JSON')); } });
  req.on('error', reject);
});

const validQuery = q => typeof q === 'string' && q.trim().length >= 1 && q.length <= 2000;
const validBudget = b => b === undefined || (Number.isFinite(b) && b >= 0 && b <= 100000);
const validLambda = l => l === undefined || (Number.isFinite(l) && l >= 0 && l <= 100);

function checkInputs(body) {
  const { query, budget, lambda } = body ?? {};
  if (!validQuery(query)) return 'query: non-empty string, ≤ 2000 chars, required';
  if (!validBudget(budget)) return 'budget: finite number in [0, 100000]';
  if (!validLambda(lambda)) return 'lambda: finite number in [0, 100]';
  return null;
}

function compileResponse(body) {
  const budget = body.budget ?? 900, lambda = body.lambda ?? 0.5;
  const r = compileSurface(body.query.trim(), TOOL_REGISTRY, { budget, lambda });
  return {
    surface: r.selected.map(t => ({ id: t.id, service: t.service, kind: t.kind, cost: t.cost, relevance: +r.relevance.get(t.id).toFixed(4) })),
    certificate: r.certificate,
    decision: {
      lambdaRequested: r.lambdaRequested, lambdaUsed: +r.lambdaUsed.toFixed(4), lambdaMax: +r.lambdaMax.toFixed(4), wasClamped: r.wasClamped,
      F: +r.F.toFixed(4), greedyF: +r.greedyF.toFixed(4), enumerationGainPct: r.greedyF > 0 ? +(((r.F - r.greedyF) / r.greedyF) * 100).toFixed(2) : 0,
      exploredSeeds: r.exploredSeeds, registrySize: r.registrySize, usedCost: r.usedCost, budget: r.budget,
      registryTokens: TOTAL_REGISTRY_TOKENS,
    },
  };
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  // structured access log — method/path/status/latency only, never bodies
  const done = (code) => { if (path !== '/healthz') log.info('http.request', { method: req.method, path, status: code, ms: Date.now() - started }); };
  const jsonLogged = (res, code, obj) => { done(code); return json(res, code, obj); };
  const failLogged = (res, code, error) => { done(code); return fail(res, code, error); };
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' }); return res.end(); }
  try {
    if (req.method === 'GET' && path === '/healthz') return jsonLogged(res, 200, { ok: true, service: 'notary', tools: TOOL_REGISTRY.length, registryTokens: TOTAL_REGISTRY_TOKENS });
    if (req.method === 'POST' && path === '/v1/compile') {
      const body = await readBody(req);
      const err = checkInputs(body);
      if (err) return failLogged(res, 422, err);
      return jsonLogged(res, 200, compileResponse(body));
    }
    if (req.method === 'GET' && path === '/v1/openai-tools') {
      const q = url.searchParams.get('q');
      const budget = Number(url.searchParams.get('budget') ?? 900), lambda = Number(url.searchParams.get('lambda') ?? 0.5);
      if (!validQuery(q)) return failLogged(res, 422, 'q: query param, non-empty string ≤ 2000 chars');
      if (!validBudget(budget) || !validLambda(lambda)) return failLogged(res, 422, 'budget/lambda out of range');
      const r = compileSurface(q.trim(), TOOL_REGISTRY, { budget, lambda });
      return jsonLogged(res, 200, { tools: toOpenAITools(r.selected), certificate: r.certificate, surface: r.selected.map(t => t.id) });
    }
    if (req.method === 'POST' && path === '/v1/verify') {
      const body = await readBody(req);
      if (!Array.isArray(body?.receipts) || body.receipts.length > 100) return failLogged(res, 422, 'receipts: array, ≤ 100 entries');
      const check = await verifyChain(body.receipts);
      return jsonLogged(res, 200, check);
    }
    if (req.method === 'GET' && path === '/') return jsonLogged(res, 200, { service: 'notary', docs: '/v1/compile · /v1/openai-tools · /v1/verify · /healthz' });
    return failLogged(res, 404, 'not found');
  } catch (e) {
    log.error('http.error', { method: req.method, path, error: String(e?.message || e) });
    return failLogged(res, e.message === 'body too large' ? 413 : 400, e.message);
  }
});

server.listen(PORT, HOST, () => {
  const line = { ts: new Date().toISOString(), level: 'info', service: 'notary-facade', msg: 'http.listen', host: HOST, port: PORT };
  console.log(JSON.stringify(line));
  log.info('http.listen', { host: HOST, port: PORT });
});
