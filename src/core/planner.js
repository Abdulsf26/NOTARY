// Notary — deterministic plan builder. NO LLM in the loop.
// Maps the free-text task onto intents, resolves each to a concrete tool + params
// FROM THE COMPILED SURFACE (the compiler gates what may run — that is the point),
// orders reads before writes, and composes cross-step content.
// Honest by construction: a query with no recognised intent yields an EMPTY plan,
// and the agent refuses to fake execution (see docs/INTEGRATION.md for the LLM seam).
const strip = s => String(s ?? '').trim();
const words = s => strip(s).replace(/\s+/g, ' ');
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

/** Extract a #channel token if present (e.g. "#engineering" → "engineering"). */
const hashChannel = q => (q.match(/#([a-z0-9][a-z0-9-_]*)/i)?.[1] ?? '').toLowerCase();
/** Extract charge id (ch_...) if present. */
const chargeId = q => q.match(/ch_[A-Za-z0-9_]+/)?.[0] ?? null;
/** Extract issue key (ENG-123) if present. */
const issueKey = q => q.match(/\b[A-Z]{2,10}-\d+\b/)?.[0] ?? null;
/** Extract a 2-5 letter ticker in caps, e.g. NVDA. */
const ticker = q => (q.match(/\b[A-Z]{2,5}\b/g) ?? []).find(t => !['I', 'A', 'AN', 'THE', 'URL', 'API', 'JSON', 'HTTP'].includes(t)) ?? 'NVDA';

/** Compose the body shared by Slack/Notion/CRM writes: what actually happened. */
function summaryFrom(query, planState) {
  const drive = planState.results?.['drive.search_files']?.data?.files?.[0];
  const notionRead = planState.results?.['notion.read_page']?.data;
  const bits = [];
  if (drive) bits.push(`Drive: ${drive.name}`);
  if (notionRead?.title) bits.push(`page: ${notionRead.title}`);
  const core = bits.length ? bits.join(' · ') : `Task: ${words(query).slice(0, 120)}`;
  return `Q3 update — ${core} · logged by Notary (verified, receipted).`;
}

/**
 * Build an executable plan.
 * @returns {{ steps: Array<{tool, params, stage}>, notes: string[] }}
 */
export function buildPlan(query, compile, world) {
  const q = String(query ?? '');
  const lq = q.toLowerCase();
  const raw = words(q);
  const notes = [];
  const rules = [];

  const want = (re, toolId, build) => { if (re.test(lq) || re.test(q)) rules.push({ toolId, build }); };

  // ── reads (stage 1) ──────────────────────────────────────────────
  want(/drive|doc|file|pdf|report/i, 'drive.search_files', () => ({ query: raw.slice(0, 80), page_size: 5 }));
  want(/notion/i, 'notion.read_page', () => ({ page_id: 'page-q3' }));
  want(/slack.*(history|search|read)|search.*slack/i, 'slack.read_channel_history', () => ({ channel: hashChannel(q) || 'engineering', limit: 10 }));
  want(/jira.*(search|find|open)|bug/i, 'jira.search_issues', () => ({ jql: words(q).slice(0, 80), max_results: 10 }));
  want(/github.*(search|find)/i, 'github.search_code', () => ({ query: raw.slice(0, 80) }));
  // ── writes (stage 2) ─────────────────────────────────────────────
  want(/notion/i, 'notion.append_block', () => null); // params composed in second pass (needs drive result)
  want(/slack|#/i, 'slack.post_in_channel', () => ({ channel: hashChannel(q) || 'engineering', text: null }));
  want(/\bcrm\b|\bdeal\b|log (it|this|the update)|acme (deal|account|rollout)/i, 'crm.log_activity', () => ({ object_type: 'deal', object_id: q.match(/deal-\d+/)?.[0] ?? 'deal-4471', activity_type: 'note', body: null }));
  want(/zoom/i, 'zoom.create_meeting', () => ({ topic: raw.slice(0, 80), start: '2026-11-25T10:30:00+05:30', duration: 30 }));
  want(/calendar|meeting|event|free slot|schedule|slot/i, 'calendar.create_event', () => ({ summary: raw.slice(0, 80), start: '2026-11-25T10:30:00+05:30', end: '2026-11-25T11:00:00+05:30', attendees: ['team@acme.example'] }));
  want(/email|gmail|mail.*(list|team|partners)/i, 'gmail.send_email', () => ({ to: ['team@acme.example'], subject: cap(raw.slice(0, 60)) || 'Update', body: null }));
  want(/refund/i, 'stripe.create_refund', () => ({ charge_id: chargeId(q) ?? 'ch_123', amount: 'full' }));
  want(/(create|make|issue|send|generate)\s+(an?\s+)?invoice/i, 'stripe.create_invoice', () => ({ customer_id: 'cus_acme', line_items: [{ description: raw.slice(0, 80), amount: 155000 }] }));
  want(/jira|bug|ticket/i, 'jira.create_issue', () => ({ project: 'ENG', type: /bug/i.test(q) ? 'Bug' : 'Task', summary: raw.slice(0, 100) }));
  want(/github (issue|bug)|file an issue/i, 'github.create_issue', () => ({ repo: 'hackathon2win/notary', title: raw.slice(0, 90), body: `Filed by Notary from: ${raw.slice(0, 200)}` }));
  want(/weather/i, 'weather.get_forecast', () => ({ city: (q.match(/in\s+([A-Za-z ]{3,30})/i)?.[1] ?? 'Chennai').trim() }));
  want(/stock|quote|price of|trading at/i, 'stocks.get_quote', () => ({ symbol: ticker(q) }));
  want(/select|sql|database|table/i, 'postgres.run_select', () => ({ sql: 'SELECT * FROM metrics_q3 LIMIT 5' }));

  // ── resolve against THE COMPILED SURFACE ────────────────────────────
  const inSurface = new Set((compile?.selected ?? []).map(t => t.id));
  const steps = [];
  for (const rule of rules) {
    if (!inSurface.has(rule.toolId)) { notes.push(`${rule.toolId}: recognised intent but NOT in compiled surface — blocked (fails closed)`); continue; }
    steps.push({ tool: rule.toolId, params: rule.build(), stage: isRead(rule.toolId) ? 1 : 2 });
  }
  steps.sort((a, b) => a.stage - b.stage);

  // tag blocks that need second-pass params
  for (const s of steps) {
    if (s.tool === 'notion.append_block') s.params = () => null; // resolved post-read by resolveDeferred
    if (s.tool === 'slack.post_in_channel' && !s.params.text) s.params.text = () => null;
    if (s.tool === 'crm.log_activity' && !s.params.body) s.params.body = () => null;
    if (s.tool === 'gmail.send_email' && !s.params.body) s.params.body = () => null;
  }
  return { steps, notes };
}

export const isRead = id => /search|read|list|get|describe|history|geocode|directions|forecast|quote|select/.test(id);

/**
 * Second-pass param resolution for cross-step composition (drive result → summary).
 * Called by the agent after the reads have executed.
 */
export function resolveDeferred(steps, query, world, results) {
  const planState = { results };
  const summary = summaryFrom(query, planState);
  for (const s of steps) {
    if (typeof s.params === 'function') s.params = s.params();
    if (s.tool === 'notion.append_block' && !s.params) {
      const page = world.notion.pages['page-q3'];
      const parent = page.blocks.length ? page.blocks[page.blocks.length - 1].id : 'blk-root-001';
      s.params = { parent_block_id: parent, content: summary };
    } else if (s.tool === 'notion.append_block' && s.params && typeof s.params.parent_block_id === 'undefined') {
      const page = world.notion.pages['page-q3'];
      s.params = { parent_block_id: page.blocks.at(-1)?.id ?? 'blk-root-001', content: summary };
    }
    if (s.tool === 'slack.post_in_channel' && !s.params.text) s.params.text = summary;
    if (s.tool === 'crm.log_activity' && !s.params.body) s.params.body = `${summary} Full task: ${String(query).slice(0, 140)}`;
    if (s.tool === 'gmail.send_email' && !s.params.body) s.params.body = summary;
  }
  return steps;
}

/** Retry target re-resolution: never blindly retry against the same stale target. */
export function resolveForRetry(step, world) {
  if (step.tool === 'notion.append_block') {
    const page = world.notion.pages['page-q3'];
    return { ...step.params, parent_block_id: page.blocks.at(-1)?.id ?? 'blk-root-001' };
  }
  return { ...step.params };
}
