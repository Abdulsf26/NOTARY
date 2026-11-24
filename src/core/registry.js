// Notary — the MCP tool registry (illustrative LiveMCPBench-scale slice).
// Each entry models a real MCP server tool descriptor.
//   cost  — tokens of the full descriptor (name + description + param schema), computed at load
//   p95   — calibrated p95 of tokens RETURNED by a call (used by the cost certificate)
//   prior — learned quality prior for relevance scoring
//   kind  — 'read' | 'write'  (only writes carry effect contracts + read-back verification)
//   contract — for writes: { pre, post, readback } postcondition ids (see verifier.js)

const T = (service, name, desc, params, p95, prior, kind = 'read', contract = null) =>
  ({ service, name, desc, params, p95, prior, kind, contract, id: `${service}.${name}` });

const registry = [
  // ── Slack ─────────────────────────────────────────────────────────────
  T('slack', 'post_in_channel', 'Post a message to a named Slack channel. Use for announcements, updates and broadcasts to a whole channel.', { channel: 'string', text: 'string', attachments: 'array?' }, 180, 1.10, 'write', { pre: 'channel_exists', post: 'message_in_channel', readback: 'read_channel_history' }),
  T('slack', 'post_in_thread', 'Post a reply inside an existing Slack thread. Use only when replying to a specific thread, not for broadcasts.', { channel: 'string', thread_ts: 'string', text: 'string' }, 160, 0.95, 'write', { pre: 'thread_exists', post: 'message_in_thread', readback: 'read_channel_history' }),
  T('slack', 'read_channel_history', 'Read recent messages from a Slack channel.', { channel: 'string', limit: 'number?' }, 900, 1.0),
  T('slack', 'list_channels', 'List all Slack channels the workspace can see.', {}, 400, 0.9),
  T('slack', 'search_messages', 'Search Slack messages by query string.', { query: 'string', limit: 'number?' }, 700, 0.95),
  T('slack', 'upload_file', 'Upload a file to a Slack channel.', { channel: 'string', file_path: 'string', title: 'string?' }, 220, 0.85, 'write', { pre: 'channel_exists', post: 'file_in_channel', readback: 'read_channel_history' }),
  T('slack', 'add_reaction', 'Add an emoji reaction to a message.', { channel: 'string', ts: 'string', emoji: 'string' }, 60, 0.7, 'write', { pre: 'message_exists', post: 'reaction_present', readback: 'read_channel_history' }),
  T('slack', 'set_topic', 'Set the topic of a Slack channel.', { channel: 'string', topic: 'string' }, 80, 0.7, 'write', { pre: 'channel_exists', post: 'topic_set', readback: 'list_channels' }),

  // ── Notion ────────────────────────────────────────────────────────────
  T('notion', 'append_block', 'Append a content block to a Notion page or block. Use to add notes, updates and entries to an existing page.', { parent_block_id: 'string', content: 'string', type: 'string?' }, 120, 1.05, 'write', { pre: 'block_exists', post: 'block_appended', readback: 'read_page' }),
  T('notion', 'create_page', 'Create a new Notion page under a parent.', { parent_id: 'string', title: 'string', content: 'string?' }, 140, 0.95, 'write', { pre: 'parent_exists', post: 'page_created', readback: 'read_page' }),
  T('notion', 'read_page', 'Read the blocks of a Notion page.', { page_id: 'string' }, 1200, 1.0),
  T('notion', 'search_pages', 'Search Notion pages by title and content.', { query: 'string' }, 650, 1.0),
  T('notion', 'update_page', 'Update properties of a Notion page.', { page_id: 'string', properties: 'object' }, 150, 0.9, 'write', { pre: 'page_exists', post: 'page_updated', readback: 'read_page' }),
  T('notion', 'query_database', 'Query a Notion database with filters and sorts.', { database_id: 'string', filter: 'object?', sorts: 'array?' }, 1100, 0.95),
  T('notion', 'create_database', 'Create a new Notion database.', { parent_id: 'string', title: 'string', schema: 'object' }, 200, 0.6, 'write', { pre: 'parent_exists', post: 'database_created', readback: 'search_pages' }),
  T('notion', 'append_scheduled_block', 'Append a block scheduled for future publication (experiments only).', { parent_block_id: 'string', content: 'string', publish_at: 'string' }, 130, 0.5, 'write', { pre: 'block_exists', post: 'block_appended', readback: 'read_page' }),

  // ── Jira ──────────────────────────────────────────────────────────────
  T('jira', 'create_issue', 'Create a Jira issue in a project. Use to file bugs, tasks and stories with type, summary and description.', { project: 'string', type: 'string', summary: 'string', description: 'string?', priority: 'string?' }, 160, 1.0, 'write', { pre: 'project_exists', post: 'issue_created', readback: 'get_issue' }),
  T('jira', 'get_issue', 'Fetch a Jira issue by key.', { issue_key: 'string' }, 350, 1.0),
  T('jira', 'search_issues', 'Search Jira issues with a JQL query.', { jql: 'string', max_results: 'number?' }, 800, 0.95),
  T('jira', 'update_issue', 'Update fields of a Jira issue.', { issue_key: 'string', fields: 'object' }, 140, 0.85, 'write', { pre: 'issue_exists', post: 'issue_updated', readback: 'get_issue' }),
  T('jira', 'transition_issue', 'Move a Jira issue through a workflow transition (e.g. To Do → Done).', { issue_key: 'string', transition: 'string' }, 120, 0.9, 'write', { pre: 'issue_exists', post: 'issue_transitioned', readback: 'get_issue' }),
  T('jira', 'add_comment', 'Comment on a Jira issue.', { issue_key: 'string', body: 'string' }, 110, 0.85, 'write', { pre: 'issue_exists', post: 'comment_added', readback: 'get_issue' }),
  T('jira', 'list_projects', 'List Jira projects visible to the integration.', {}, 250, 0.7),

  // ── GitHub ────────────────────────────────────────────────────────────
  T('github', 'create_issue', 'Create a GitHub issue in a repository with title, body and labels.', { repo: 'string', title: 'string', body: 'string?', labels: 'array?' }, 150, 0.95, 'write', { pre: 'repo_exists', post: 'gh_issue_created', readback: 'get_issue' }),
  T('github', 'get_issue', 'Fetch a GitHub issue by number.', { repo: 'string', number: 'number' }, 300, 0.9),
  T('github', 'list_commits', 'List recent commits on a branch.', { repo: 'string', branch: 'string?', limit: 'number?' }, 600, 0.8),
  T('github', 'create_pull_request', 'Open a pull request from a head branch into base.', { repo: 'string', title: 'string', head: 'string', base: 'string', body: 'string?' }, 170, 0.9, 'write', { pre: 'branches_exist', post: 'pr_created', readback: 'get_pr' }),
  T('github', 'get_pr', 'Fetch a pull request by number.', { repo: 'string', number: 'number' }, 320, 0.85),
  T('github', 'search_code', 'Search code across repositories.', { query: 'string', limit: 'number?' }, 750, 0.8),
  T('github', 'create_release', 'Create a GitHub release for a tag.', { repo: 'string', tag: 'string', name: 'string', notes: 'string?' }, 160, 0.6, 'write', { pre: 'repo_exists', post: 'release_created', readback: 'get_issue' }),

  // ── Google Drive ──────────────────────────────────────────────────────
  T('drive', 'search_files', 'Search Google Drive files by name, content or type.', { query: 'string', page_size: 'number?' }, 500, 1.0),
  T('drive', 'read_file', 'Read the text content of a Drive file.', { file_id: 'string' }, 1500, 0.95),
  T('drive', 'create_file', 'Create a file in Drive with content.', { name: 'string', content: 'string', folder_id: 'string?' }, 120, 0.85, 'write', { pre: 'folder_exists', post: 'file_created', readback: 'search_files' }),
  T('drive', 'update_file', 'Overwrite the content of a Drive file.', { file_id: 'string', content: 'string' }, 100, 0.8, 'write', { pre: 'file_exists', post: 'file_updated', readback: 'read_file' }),
  T('drive', 'list_folder', 'List files inside a Drive folder.', { folder_id: 'string' }, 450, 0.85),
  T('drive', 'share_file', 'Grant a user or link access to a Drive file.', { file_id: 'string', role: 'string', target: 'string' }, 110, 0.75, 'write', { pre: 'file_exists', post: 'permission_added', readback: 'get_permissions' }),
  T('drive', 'get_permissions', 'List permissions on a Drive file.', { file_id: 'string' }, 200, 0.7),

  // ── Google Calendar ───────────────────────────────────────────────────
  T('calendar', 'create_event', 'Create a calendar event with attendees, time and description.', { summary: 'string', start: 'string', end: 'string', attendees: 'array?', description: 'string?' }, 150, 0.95, 'write', { pre: 'attendees_valid', post: 'event_created', readback: 'list_events' }),
  T('calendar', 'list_events', 'List upcoming events on a calendar.', { calendar_id: 'string?', max_results: 'number?' }, 600, 0.9),
  T('calendar', 'find_free_slot', 'Find mutually free time for attendees in a window.', { attendees: 'array', window_start: 'string', window_end: 'string', duration_minutes: 'number' }, 400, 0.9),
  T('calendar', 'update_event', 'Update an existing calendar event.', { event_id: 'string', patch: 'object' }, 120, 0.8, 'write', { pre: 'event_exists', post: 'event_updated', readback: 'list_events' }),
  T('calendar', 'delete_event', 'Cancel a calendar event and notify attendees.', { event_id: 'string' }, 90, 0.7, 'write', { pre: 'event_exists', post: 'event_deleted', readback: 'list_events' }),

  // ── Gmail ─────────────────────────────────────────────────────────────
  T('gmail', 'send_email', 'Send an email to one or more recipients with subject and body.', { to: 'array', subject: 'string', body: 'string', cc: 'array?' }, 130, 1.05, 'write', { pre: 'recipients_valid', post: 'email_sent', readback: 'list_sent' }),
  T('gmail', 'list_sent', 'List recently sent emails.', { max_results: 'number?' }, 500, 0.9),
  T('gmail', 'search_inbox', 'Search inbox messages with a query.', { query: 'string', max_results: 'number?' }, 650, 0.9),
  T('gmail', 'draft_reply', 'Draft a reply to an email without sending.', { message_id: 'string', body: 'string' }, 120, 0.75, 'write', { pre: 'message_exists', post: 'draft_created', readback: 'search_inbox' }),
  T('gmail', 'send_bulk_email', 'Send a personalised email to a list of recipients from a template.', { recipients: 'array', template: 'string', subject: 'string' }, 140, 0.9, 'write', { pre: 'recipients_valid', post: 'bulk_sent', readback: 'list_sent' }),

  // ── CRM (HubSpot-style) ───────────────────────────────────────────────
  T('crm', 'log_activity', 'Log an activity (call, email, meeting, note) against a CRM contact or deal.', { object_type: 'string', object_id: 'string', activity_type: 'string', body: 'string' }, 120, 1.0, 'write', { pre: 'object_exists', post: 'activity_logged', readback: 'list_activities' }),
  T('crm', 'list_activities', 'List activities logged against a CRM object.', { object_type: 'string', object_id: 'string' }, 400, 0.85),
  T('crm', 'search_contacts', 'Search CRM contacts by name, email or company.', { query: 'string' }, 500, 0.9),
  T('crm', 'update_deal_stage', 'Move a CRM deal to a new stage.', { deal_id: 'string', stage: 'string' }, 110, 0.85, 'write', { pre: 'deal_exists', post: 'deal_stage_set', readback: 'search_contacts' }),
  T('crm', 'create_contact', 'Create a CRM contact.', { email: 'string', first_name: 'string?', last_name: 'string?', company: 'string?' }, 120, 0.8, 'write', { pre: 'email_not_taken', post: 'contact_created', readback: 'search_contacts' }),

  // ── Stripe ────────────────────────────────────────────────────────────
  T('stripe', 'create_invoice', 'Create and finalise an invoice for a customer.', { customer_id: 'string', line_items: 'array', due_date: 'string?' }, 200, 0.85, 'write', { pre: 'customer_exists', post: 'invoice_created', readback: 'get_invoice' }),
  T('stripe', 'get_invoice', 'Fetch an invoice by id.', { invoice_id: 'string' }, 300, 0.8),
  T('stripe', 'list_charges', 'List recent charges.', { customer_id: 'string?', limit: 'number?' }, 550, 0.75),
  T('stripe', 'create_refund', 'Refund a charge fully or partially.', { charge_id: 'string', amount: 'number?' }, 130, 0.7, 'write', { pre: 'charge_refundable', post: 'refund_created', readback: 'list_charges' }),
  T('stripe', 'send_invoice_reminder', 'Send a payment reminder for an open invoice.', { invoice_id: 'string' }, 90, 0.6, 'write', { pre: 'invoice_open', post: 'reminder_sent', readback: 'get_invoice' }),

  // ── Postgres ──────────────────────────────────────────────────────────
  T('postgres', 'run_select', 'Run a read-only SELECT query against the analytics database.', { sql: 'string' }, 400, 0.85),
  T('postgres', 'run_insert', 'Run an INSERT into an allowlisted table.', { table: 'string', row: 'object' }, 150, 0.7, 'write', { pre: 'table_allowlisted', post: 'row_inserted', readback: 'run_select' }),
  T('postgres', 'list_tables', 'List tables in the connected database.', {}, 150, 0.6),
  T('postgres', 'describe_table', 'Describe columns and types of a table.', { table: 'string' }, 200, 0.6),

  // ── Linear ────────────────────────────────────────────────────────────
  T('linear', 'create_issue', 'Create a Linear issue in a team.', { team_id: 'string', title: 'string', description: 'string?', priority: 'number?' }, 140, 0.75, 'write', { pre: 'team_exists', post: 'linear_issue_created', readback: 'get_issue' }),
  T('linear', 'get_issue', 'Fetch a Linear issue by id.', { issue_id: 'string' }, 280, 0.7),
  T('linear', 'search_issues', 'Search Linear issues.', { query: 'string' }, 450, 0.6),

  // ── Miscellaneous / long-tail tools to bloat the registry realistically ──
  T('weather', 'get_forecast', 'Get a weather forecast for a city.', { city: 'string', days: 'number?' }, 250, 0.3),
  T('stocks', 'get_quote', 'Get the latest quote for a ticker symbol.', { symbol: 'string' }, 150, 0.3),
  T('maps', 'geocode', 'Geocode an address to coordinates.', { address: 'string' }, 120, 0.35),
  T('maps', 'directions', 'Get driving directions between two points.', { origin: 'string', destination: 'string' }, 350, 0.35),
  T('translate', 'translate_text', 'Translate text between languages.', { text: 'string', target: 'string', source: 'string?' }, 200, 0.35),
  T('image', 'generate_image', 'Generate an image from a text prompt.', { prompt: 'string', size: 'string?' }, 100, 0.3),
  T('sms', 'send_sms', 'Send an SMS to a phone number.', { to: 'string', body: 'string' }, 80, 0.4, 'write', { pre: 'phone_valid', post: 'sms_sent', readback: 'list_sms' }),
  T('sms', 'list_sms', 'List recently sent SMS messages.', { limit: 'number?' }, 250, 0.3),
  T('zoom', 'create_meeting', 'Create a Zoom meeting.', { topic: 'string', start: 'string', duration: 'number' }, 120, 0.5, 'write', { pre: 'start_valid', post: 'meeting_created', readback: 'list_meetings' }),
  T('zoom', 'list_meetings', 'List scheduled Zoom meetings.', {}, 300, 0.4),
  T('asana', 'create_task', 'Create an Asana task in a project.', { project_id: 'string', name: 'string', notes: 'string?', due_on: 'string?' }, 130, 0.6, 'write', { pre: 'project_exists', post: 'asana_task_created', readback: 'list_tasks' }),
  T('asana', 'list_tasks', 'List tasks in an Asana project.', { project_id: 'string' }, 400, 0.5),
  T('snowflake', 'run_query', 'Run a read-only SQL query on the warehouse.', { sql: 'string' }, 450, 0.5),
  T('pagerduty', 'create_incident', 'Create a PagerDuty incident.', { service_id: 'string', title: 'string', urgency: 'string' }, 120, 0.5, 'write', { pre: 'service_exists', post: 'incident_created', readback: 'list_incidents' }),
  T('pagerduty', 'list_incidents', 'List active PagerDuty incidents.', {}, 350, 0.4),
  T('salesforce', 'create_lead', 'Create a Salesforce lead.', { first_name: 'string', last_name: 'string', company: 'string', email: 'string' }, 130, 0.45, 'write', { pre: 'email_valid', post: 'lead_created', readback: 'search_leads' }),
  T('salesforce', 'search_leads', 'Search Salesforce leads.', { query: 'string' }, 450, 0.4),
  T('docusign', 'send_envelope', 'Send a document for e-signature.', { file_id: 'string', signers: 'array', subject: 'string' }, 150, 0.5, 'write', { pre: 'file_exists', post: 'envelope_sent', readback: 'get_envelope' }),
  T('docusign', 'get_envelope', 'Get the status of a DocuSign envelope.', { envelope_id: 'string' }, 200, 0.45),
  T('dropbox', 'upload_file', 'Upload a file to Dropbox.', { path: 'string', content_base64: 'string' }, 120, 0.4, 'write', { pre: 'path_valid', post: 'dropbox_file_created', readback: 'list_folder' }),
  T('confluence', 'create_page', 'Create a Confluence page in a space.', { space_key: 'string', title: 'string', body: 'string' }, 140, 0.6, 'write', { pre: 'space_exists', post: 'confluence_page_created', readback: 'get_page' }),
  T('confluence', 'get_page', 'Fetch a Confluence page by id.', { page_id: 'string' }, 800, 0.55),
];

// Real MCP descriptors carry a full JSON Schema: types, required[], enums, per-param
// descriptions and an envelope (~85 tokens). Model that, not just the prose.
function descriptorTokens(t) {
  const name = `${t.service}.${t.name}`;
  const params = JSON.stringify(t.params);
  const schemaOverhead = Object.keys(t.params).length * 34; // per-param schema boilerplate
  const chars = name.length + t.desc.length + params.length + schemaOverhead + 85;
  return Math.max(60, Math.ceil(chars / 3.6));
}

function attachCosts(list) {
  return list.map(t => ({ ...t, cost: descriptorTokens(t) }));
}

export const TOOL_REGISTRY = attachCosts(registry);
export const TOTAL_REGISTRY_TOKENS = TOOL_REGISTRY.reduce((s, t) => s + t.cost, 0);

// Well-known near-duplicate pairs whose σ is calibrated from usage logs (Jaccard under-scores these).
export const CALIBRATED_SIGMA = {
  'slack.post_in_channel|slack.post_in_thread': 0.85,
  'notion.append_block|notion.append_scheduled_block': 0.88,
  'jira.create_issue|github.create_issue': 0.55,
  'jira.create_issue|linear.create_issue': 0.55,
  'jira.create_issue|asana.create_task': 0.5,
  'github.create_issue|linear.create_issue': 0.65,
  'github.create_issue|asana.create_task': 0.35,
  'notion.create_page|confluence.create_page': 0.7,
  'crm.create_contact|salesforce.create_lead': 0.6,
  'gmail.send_email|gmail.send_bulk_email': 0.7,
  'drive.create_file|dropbox.upload_file': 0.55,
  'jira.create_issue|github.create_pull_request': 0.2,
};
