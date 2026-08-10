#!/usr/bin/env node
/**
 * Create the eight `lp_*` data tables this pipeline stores its state in.
 *
 * Data Table SCHEMAS ARE IMMUTABLE through the n8n public API - you can rename
 * a table but not add a column - so this script is the definition of record
 * and `--recreate` is the only way to change one.
 *
 *   node scripts/create-tables.js             create anything missing
 *   node scripts/create-tables.js --recreate  DROP and rebuild (destroys rows)
 *   node scripts/create-tables.js --list      show what exists
 */
const fs = require('fs');
const path = require('path');

(function loadDotenv() {
  const p = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (/^\s*(#|$)/.test(line)) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const BASE = (process.env.N8N_API_URL || '').replace(/\/+$/, '');
const KEY = process.env.N8N_API_KEY;
if (!KEY) { console.error('N8N_API_KEY is not set (put it in .env at the repo root).'); process.exit(1); }

const S = (name) => ({ name, type: 'string' });
const N = (name) => ({ name, type: 'number' });
const B = (name) => ({ name, type: 'boolean' });

// Timestamps are epoch SECONDS in number columns, never ISO strings. The tick
// claims work with `due_at <= now`, and numeric comparison is the one filter
// operator whose semantics are unambiguous here.
const TABLES = {
  lp_config: [S('key'), S('value'), S('note')],

  lp_lead: [
    S('lead_uid'), S('source'), S('source_ref'), N('received_at'),
    S('full_name'), S('email_raw'), S('email_norm'), S('phone_raw'), S('phone_e164'), S('phone_key'),
    S('country'), S('company'), S('domain'), S('service_interest'), S('free_text'),
    S('consent'), S('consent_source'), S('stated_urgency'), S('stated_budget'),
    N('score'), S('score_breakdown_json'), S('band'),
    S('ai_status'), S('ai_intent'), S('ai_urgency'), S('ai_signals'), S('ai_reason'), N('ai_confidence'),
    S('owner_id'), N('assign_rung'), N('odoo_lead_id'), S('odoo_stage'),
    S('approval_state'), S('approval_by'), S('status'), S('merged_into'),
    S('raw_json'), N('updated_at'),
  ],

  // The idempotency ledger. One row per claimed side effect, across every
  // scope: intake, odoo_upsert, message, booking, approval.
  lp_idem: [S('idem_key'), S('scope'), S('lead_uid'), S('state'), S('result_ref'),
    N('claimed_at'), N('completed_at'), N('attempts')],

  // Identity, which is a different question from idempotency: idem_key asks
  // "have we processed this event?", person_key asks "have we met this human?".
  lp_person_index: [S('person_key'), S('lead_uid'), S('email_norm'), S('phone_key'), N('created_at')],

  lp_jobs: [S('job_id'), S('lead_uid'), S('job_type'), N('step'), S('template'),
    N('due_at'), S('state'), N('attempts'), N('claimed_at'), S('result'), S('cancel_reason')],

  lp_agents: [S('agent_id'), S('name'), S('email'), S('services'),
    N('capacity'), N('open_leads'), B('available'), N('odoo_user_id')],

  // The audit trail. n8n's execution log is not one: it is pruned on a
  // schedule and cannot be queried by lead.
  lp_audit: [S('event_id'), S('lead_uid'), N('ts'), S('workflow'), S('execution_id'),
    S('type'), S('decision'), S('detail_json')],

  lp_dlq: [S('dlq_id'), S('lead_uid'), S('stage_failed'), S('error_class'), S('error'),
    S('payload_json'), N('attempts'), S('state'), N('first_seen'), N('last_seen')],
};

async function api(method, urlPath, body) {
  const res = await fetch(`${BASE}/api/v1${urlPath}`, {
    method,
    headers: { 'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 300) }; }
  if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status}: ${parsed?.message || parsed?.raw || ''}`);
  return parsed;
}

(async () => {
  const recreate = process.argv.includes('--recreate');
  const listOnly = process.argv.includes('--list');

  const existing = new Map();
  let cursor;
  do {
    const page = await api('GET', `/data-tables?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const t of page.data || []) existing.set(t.name, t.id);
    cursor = page.nextCursor;
  } while (cursor);

  if (listOnly) {
    for (const [name, id] of existing) console.log(`  ${name.padEnd(18)} ${id}`);
    console.log(`\n${existing.size} data tables on ${BASE}`);
    return;
  }

  for (const [name, columns] of Object.entries(TABLES)) {
    if (existing.has(name) && recreate) {
      await api('DELETE', `/data-tables/${existing.get(name)}`);
      console.log(`  dropped  ${name}`);
      existing.delete(name);
    }
    if (existing.has(name)) {
      console.log(`  exists   ${name}  (${columns.length} columns declared)`);
      continue;
    }
    const created = await api('POST', '/data-tables', { name, columns });
    console.log(`  created  ${name}  ${columns.length} columns  (${created.id})`);
  }

  console.log(`\n${Object.keys(TABLES).length} tables ready. Next: run "LP-00 Setup and Seed" in n8n.`);
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
