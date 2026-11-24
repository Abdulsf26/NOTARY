// Notary — the mock MCP world (in-memory backend the demo executes against).
// Deterministic. Supports a FAULT-INJECTION mode that simulates the documented
// "call returns 200, effect never happened" failure (the silent no-op).

export function createWorld() {
  return {
    slack: {
      channels: { engineering: { topic: 'build · ship · learn' } },
      messages: [],
    },
    notion: {
      pages: {
        'page-q3': {
          title: 'Q3 Engineering Update',
          blocks: [
            { id: 'blk-root-001', text: 'Q3 — Engineering Update (draft)', parent: null },
            { id: 'blk-100', text: 'Launched Notary private beta; 3 design partners onboarded.', parent: 'blk-root-001' },
            { id: 'blk-101', text: 'False-success rate caught by receipts: 100% of injected faults.', parent: 'blk-root-001' },
          ],
        },
      },
    },
    crm: { deals: { 'deal-4471': { name: 'Acme — Q3 platform rollout', stage: 'negotiation' } }, contacts: {}, activities: [] },
    gmail: { sent: [], drafts: [] },
    jira: { issues: {}, comments: [], next: 1042 },
    github: { issues: {}, prs: [], releases: [], next: 217 },
    drive: { files: { 'file-q3-report': { name: 'Q3_Engineering_Update.pdf', content: 'Q3 update: shipped beta, 3 design partners, FSR 0%.' } } },
    calendar: { events: [] },
    stripe: { invoices: {}, refunds: [] },
    linear: { issues: [] },
    postgres: { rows: [] },
    log: [],
  };
}

const uid = (p) => p + '-' + Math.random().toString(36).slice(2, 10);

/**
 * Fault injection state. When `silentNoOp` is on, the FIRST write tool call is
 * swallowed: it returns an HTTP-200-shaped success envelope and persists nothing —
 * the exact failure class Notary exists to catch. The fault fires once per run;
 * the retry then lands for real. Works for EVERY write tool, not just Notion.
 */
export function createFaults() {
  return { silentNoOp: false, swallowedWrites: 0, spent: false };
}

function ok(data) { return { status: 200, ok: true, data }; }
function fail(code, message) { return { status: code, ok: false, error: message }; }

export function callTool(tool, params, world, faults) {
  const [service, fn] = tool.id.split('.');
  const started = Date.now();
  let res;
  if (faults?.silentNoOp && tool.kind === 'write' && !faults.spent) {
    faults.spent = true;
    faults.swallowedWrites++;
    const swallowed = { status: 200, ok: true, data: { swallowed: true, note: '200 OK returned; effect not persisted (fault injection)' } };
    world.log.push({ id: uid('call'), tool: tool.id, params, ok: true, status: 200, latency: 1, at: Date.now(), swallowed: true });
    return { ...swallowed, latency: 1, tool: tool.id };
  }
  try {
    res = SERVICES[service]?.[fn]?.(params, world, faults) ?? fail(501, `${tool.id} is not wired in this demo backend`);
  } catch (e) {
    res = fail(500, String(e?.message || e));
  }
  const latency = Date.now() - started;
  world.log.push({ id: uid('call'), tool: tool.id, params, ok: res.ok, status: res.status, latency, at: Date.now() });
  return { ...res, latency, tool: tool.id };
}

const SERVICES = {
  slack: {
    post_in_channel({ channel, text }, w) {
      if (!w.slack.channels[channel]) return fail(404, `channel ${channel} not found`);
      const ts = Date.now() / 1000;
      w.slack.messages.push({ channel, text, ts });
      return ok({ ts, channel });
    },
    post_in_thread({ channel, thread_ts, text }, w) {
      if (!w.slack.channels[channel]) return fail(404, `channel ${channel} not found`);
      w.slack.messages.push({ channel, text, thread_ts, ts: Date.now() / 1000 });
      return ok({ ts: Date.now() / 1000, channel, thread_ts });
    },
    read_channel_history({ channel, limit = 10 }, w) {
      const msgs = w.slack.messages.filter(m => m.channel === channel).slice(-limit);
      return ok({ channel, messages: msgs });
    },
    list_channels(_p, w) { return ok({ channels: Object.keys(w.slack.channels) }); },
    search_messages({ query, limit = 10 }, w) {
      const q = String(query).toLowerCase();
      return ok({ messages: w.slack.messages.filter(m => m.text.toLowerCase().includes(q)).slice(-limit) });
    },
    upload_file({ channel, file_path }, w, f) {
      if (!w.slack.channels[channel]) return fail(404, `channel ${channel} not found`);
      w.slack.messages.push({ channel, text: `[file] ${file_path}`, ts: Date.now() / 1000, file: file_path });
      return ok({ file: file_path });
    },
    add_reaction({ channel, ts, emoji }, w) { return ok({ channel, ts, emoji }); },
    set_topic({ channel, topic }, w) { if (!w.slack.channels[channel]) return fail(404, 'channel not found'); w.slack.channels[channel].topic = topic; return ok({ channel, topic }); },
  },

  notion: {
    append_block({ parent_block_id, content }, w) {
      const page = w.notion.pages['page-q3'];
      const block = { id: uid('blk'), text: content, parent: parent_block_id };
      page.blocks.push(block);
      return ok({ block_id: block.id, parent: parent_block_id });
    },
    create_page({ parent_id, title }, w) { const id = uid('page'); w.notion.pages[id] = { title, blocks: [] }; return ok({ page_id: id }); },
    read_page({ page_id }, w) {
      const page = w.notion.pages[page_id] ?? w.notion.pages['page-q3'];
      return ok({ page_id, title: page.title, blocks: page.blocks });
    },
    search_pages({ query }, w) {
      const q = String(query).toLowerCase();
      const hits = Object.entries(w.notion.pages).filter(([, p]) => p.title.toLowerCase().includes(q) || p.blocks.some(b => b.text.toLowerCase().includes(q))).map(([id, p]) => ({ id, title: p.title }));
      return ok({ results: hits });
    },
    update_page({ page_id, properties }, w) { const p = w.notion.pages[page_id]; if (!p) return fail(404, 'page not found'); Object.assign(p, properties); return ok({ page_id }); },
    query_database({ database_id }, w) { return ok({ results: [] }); },
    create_database({ parent_id, title }, w) { const id = uid('db'); (w.notion.databases = w.notion.databases || []).push({ id, title }); return ok({ database_id: id, title }); },
    append_scheduled_block({ parent_block_id, content, publish_at }, w) { return ok({ block_id: uid('blk'), publish_at }); },
  },

  crm: {
    log_activity({ object_type, object_id, activity_type, body }, w) {
      const a = { id: uid('act'), object_type, object_id, activity_type, body, at: Date.now() };
      w.crm.activities.push(a);
      return ok({ activity_id: a.id });
    },
    list_activities({ object_id }, w) { return ok({ activities: w.crm.activities.filter(a => !object_id || a.object_id === object_id) }); },
    search_contacts({ query }, w) { return ok({ contacts: [], deals: Object.entries(w.crm.deals).map(([id, d]) => ({ id, ...d })) }); },
    update_deal_stage({ deal_id, stage }, w) { const d = w.crm.deals[deal_id]; if (!d) return fail(404, 'deal not found'); d.stage = stage; return ok({ deal_id, stage }); },
    create_contact({ email }, w) { const id = uid('ct'); w.crm.contacts[id] = { email }; return ok({ contact_id: id }); },
  },

  gmail: {
    send_email({ to, subject, body }, w) { const id = uid('msg'); w.gmail.sent.push({ id, to, subject, body, at: Date.now() }); return ok({ message_id: id, to, subject }); },
    list_sent({ max_results = 10 }, w) { return ok({ sent: w.gmail.sent.slice(-max_results) }); },
    search_inbox({ query, max_results = 10 }, w) { return ok({ messages: [] }); },
    draft_reply({ message_id, body }, w) { const id = uid('draft'); w.gmail.drafts.push({ id, message_id, body }); return ok({ draft_id: id }); },
    send_bulk_email({ recipients, template, subject }, w) { const id = uid('bulk'); w.gmail.sent.push({ id, to: recipients, subject, body: template, at: Date.now(), bulk: true }); return ok({ broadcast_id: id, count: recipients.length }); },
  },

  jira: {
    create_issue({ project, type, summary }, w) { const key = `${project}-${w.jira.next++}`; w.jira.issues[key] = { key, type, summary, status: 'To Do' }; return ok({ issue_key: key }); },
    get_issue({ issue_key }, w) { const i = w.jira.issues[issue_key]; return i ? ok(i) : fail(404, 'issue not found'); },
    search_issues({ jql, max_results = 20 }, w) { return ok({ issues: Object.values(w.jira.issues) }); },
    update_issue({ issue_key, fields }, w) { const i = w.jira.issues[issue_key]; if (!i) return fail(404, 'issue not found'); Object.assign(i, fields); return ok(i); },
    transition_issue({ issue_key, transition }, w) { const i = w.jira.issues[issue_key]; if (!i) return fail(404, 'issue not found'); i.status = transition; return ok(i); },
    add_comment({ issue_key, body }, w) { const i = w.jira.issues[issue_key]; if (!i) return fail(404, 'issue not found'); const id = uid('cmt'); w.jira.comments.push({ id, issue_key, body }); return ok({ issue_key, comment_id: id }); },
    list_projects(_p, _w) { return ok({ projects: ['ENG', 'OPS'] }); },
  },

  github: {
    create_issue({ repo, title }, w) { const number = w.github.next++; w.github.issues[number] = { number, repo, title, state: 'open' }; return ok({ number, repo }); },
    get_issue({ repo, number }, w) { const i = w.github.issues[number]; return i ? ok(i) : fail(404, 'issue not found'); },
    list_commits({ repo, limit = 10 }, _w) { return ok({ commits: [{ sha: 'a1b2c3d', message: 'feat(core): tool-surface compiler + certificate' }, { sha: 'e4f5a6b', message: 'feat(verify): effect contracts + read-back' }] }); },
    create_pull_request({ repo, title, head, base }, w) { const number = w.github.next++; w.github.prs.push({ number, repo, title, head, base }); return ok({ number, repo, title, head, base }); },
    get_pr({ repo, number }, _w) { return ok({ number, repo, state: 'open' }); },
    search_code({ query }, _w) { return ok({ items: [] }); },
    create_release({ repo, tag, name }, w) { w.github.releases.push({ repo, tag, name }); return ok({ repo, tag, name }); },
  },

  drive: {
    search_files({ query, page_size = 10 }, w) {
      const q = String(query).toLowerCase();
      const hits = Object.entries(w.drive.files).filter(([, f]) => f.name.toLowerCase().includes(q) || f.content.toLowerCase().includes(q)).map(([id, f]) => ({ id, name: f.name }));
      return ok({ files: hits });
    },
    read_file({ file_id }, w) { const f = w.drive.files[file_id]; return f ? ok({ file_id, content: f.content }) : fail(404, 'file not found'); },
    create_file({ name, content, folder_id }, w) { const id = uid('file'); w.drive.files[id] = { name, content }; return ok({ file_id: id }); },
    update_file({ file_id, content }, w) { const f = w.drive.files[file_id]; if (!f) return fail(404, 'file not found'); f.content = content; return ok({ file_id }); },
    list_folder(_p, w) { return ok({ files: Object.entries(w.drive.files).map(([id, f]) => ({ id, name: f.name })) }); },
    share_file({ file_id, role, target }, w) { const f = w.drive.files[file_id]; if (!f) return fail(404, 'file not found'); return ok({ file_id, role, target }); },
    get_permissions({ file_id }, w) { return ok({ permissions: [{ role: 'owner', target: 'me' }] }); },
  },

  calendar: {
    create_event({ summary, start, end, attendees }, w) { const id = uid('evt'); w.calendar.events.push({ id, summary, start, end, attendees }); return ok({ event_id: id }); },
    list_events(_p, w) { return ok({ events: w.calendar.events }); },
    find_free_slot(_p, _w) { return ok({ slot: '2026-11-25T10:30:00+05:30' }); },
    update_event({ event_id, patch }, w) { return ok({ event_id, ...patch }); },
    delete_event({ event_id }, w) { w.calendar.events = w.calendar.events.filter(e => e.id !== event_id); return ok({ deleted: event_id }); },
  },

  stripe: {
    create_invoice({ customer_id, line_items }, w) { const id = uid('in'); w.stripe.invoices[id] = { id, customer_id, line_items, status: 'open' }; return ok({ invoice_id: id }); },
    get_invoice({ invoice_id }, w) { const i = w.stripe.invoices[invoice_id]; return i ? ok(i) : fail(404, 'invoice not found'); },
    list_charges(_p, _w) { return ok({ charges: [] }); },
    create_refund({ charge_id, amount }, w) { const id = uid('re'); w.stripe.refunds.push({ refund_id: id, charge_id, amount, at: Date.now() }); return ok({ refund_id: id, charge_id, amount }); },
    send_invoice_reminder({ invoice_id }, _w) { return ok({ invoice_id, reminder: 'sent' }); },
  },

  postgres: {
    run_select({ sql }, w) { if (!/^\s*select/i.test(sql)) return fail(403, 'read-only: SELECT only'); return ok({ rows: [{ q3_shipped: 'beta', design_partners: 3, fsr: '0%' }] }); },
    run_insert({ table, row }, w) { w.postgres.rows.push({ table, row }); return ok({ inserted: 1 }); },
    list_tables(_p, _w) { return ok({ tables: ['metrics_q3', 'accounts'] }); },
    describe_table({ table }, _w) { return ok({ table, columns: ['id', 'name', 'value'] }); },
  },

  linear: {
    create_issue({ team_id, title }, w) { const id = uid('lin'); w.linear.issues.push({ id, team_id, title }); return ok({ issue_id: id, team_id, title }); },
    get_issue({ issue_id }, _w) { return ok({ issue_id, title: 'Notary', state: 'In Progress' }); },
    search_issues({ query }, _w) { return ok({ issues: [] }); },
  },
};
