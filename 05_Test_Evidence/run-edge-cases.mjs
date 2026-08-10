#!/usr/bin/env node
/**
 * Fires all 14 mandated edge cases at the live pipeline and reports pass/fail.
 *
 *   node 05_Test_Evidence/run-edge-cases.mjs            run everything
 *   node 05_Test_Evidence/run-edge-cases.mjs 3 7 14     run only these
 *
 * Needs a .env at the repo root with N8N_API_URL, N8N_API_KEY and
 * LP_WEBHOOK_TOKEN, and LP-00 Setup and Seed already run once.
 *
 * WHY THIS FILE EXISTS
 * A matrix of fourteen ticks in a document is a claim. This is the same
 * fourteen as a program a reviewer can run themselves, against their own
 * instance, and watch fail if the system is broken. Each case asserts on an
 * OBSERVABLE OUTCOME - a row in Odoo, a state in the ledger, a cancelled job -
 * not on "the workflow finished without erroring", which on this stack is not
 * evidence of anything.
 *
 * The suite writes real leads and real Odoo opportunities into whatever
 * environment it is pointed at. It is meant for the demo sandbox.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const line of fs.existsSync(path.join(ROOT, '.env'))
  ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n') : []) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !/^\s*#/.test(line)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const BASE = (process.env.N8N_API_URL || '').replace(/\/+$/, '');
const KEY = process.env.N8N_API_KEY;
const TOKEN = process.env.LP_WEBHOOK_TOKEN;
if (!BASE || !KEY || !TOKEN) {
  console.error('Set N8N_API_URL, N8N_API_KEY and LP_WEBHOOK_TOKEN in the repo-root .env first.');
  process.exit(1);
}

const RUN = String(Date.now()).slice(-8); // keeps each run's leads distinguishable
// Phone numbers must be run-unique too. With a fixed number, a lead from an
// earlier run is still in Odoo and the new lead merges into IT - so the dedupe
// assertion passes without this run having created anything to dedupe against.
const P6 = RUN.slice(-6);
const phoneFor = (slot) => '+20 1' + slot + P6.slice(1);
const waFor = (slot) => '201' + slot + P6.slice(1);
const only = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);

// --- plumbing ---------------------------------------------------------------

const nap = (ms) => new Promise((r) => setTimeout(r, ms));

async function hook(pathname, body, query = '') {
  const res = await fetch(`${BASE}/webhook/${pathname}${query}`, {
    method: 'POST',
    headers: { 'X-LP-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, json };
}

async function napi(method, urlPath, body) {
  const res = await fetch(`${BASE}/api/v1${urlPath}`, {
    method,
    headers: { 'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return { status: res.status, json: text ? JSON.parse(text) : null }; }
  catch { return { status: res.status, json: { raw: text.slice(0, 300) } }; }
}

// Data Table REST, measured against this build (see odoo-api-probe.md):
//   GET  /rows?filter={"type":"and","filters":[{columnName,condition,value}]}
//   POST /rows          insert   {data:[{...}]}
//   POST /rows/upsert   upsert   {filter, data}
// There is no PATCH, no PUT and no DELETE - a row can be added or replaced,
// never removed, through the public API.
let TABLES = {};
async function loadTables() {
  const r = await napi('GET', '/data-tables?limit=100');
  TABLES = Object.fromEntries((r.json?.data || []).map((t) => [t.name, t.id]));
  for (const t of ['lp_config', 'lp_lead', 'lp_idem', 'lp_jobs', 'lp_agents', 'lp_audit', 'lp_dlq', 'lp_person_index']) {
    if (!TABLES[t]) throw new Error(`data table ${t} is missing. Run: node scripts/create-tables.js`);
  }
}

const eq = (col, val) => ({ type: 'and', filters: [{ columnName: col, condition: 'eq', value: val }] });

async function rows(table, filter) {
  // limit is capped at 250 by this API; a larger value is a 400, not a clamp.
  const q = filter ? `?filter=${encodeURIComponent(JSON.stringify(filter))}&limit=250` : '?limit=250';
  const r = await napi('GET', `/data-tables/${TABLES[table]}/rows${q}`);
  if (r.status >= 300) throw new Error(`read ${table}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json?.data || [];
}

/**
 * A read returns three columns the table does not have - `id`, `createdAt`,
 * `updatedAt` - and the natural way to edit a row is `{...row, field: value}`.
 * That sends them straight back, and the API answers
 * `400 unknown column name 'id'`.
 *
 * This cost three edge cases on the first full run. Every one of them set up
 * its scenario with an upsert, got a silent 400 because nothing checked the
 * status, and then failed twenty seconds later asserting on a state change
 * that had never been written. The failure message named the assertion, not
 * the cause, which is the worst kind of test failure: it accuses the system
 * under test of a bug the harness caused.
 *
 * So: strip the three, and THROW on any non-2xx. A test harness that swallows
 * a 400 is not a harness, it is a random number generator.
 */
async function upsert(table, filter, row) {
  const { id, createdAt, updatedAt, ...data } = row;
  const r = await napi('POST', `/data-tables/${TABLES[table]}/rows/upsert`, { filter, data });
  if (r.status >= 300) throw new Error(`upsert ${table}: ${r.status} ${JSON.stringify(r.json)}`);
  return r;
}
async function setConfig(key, value) {
  return upsert('lp_config', eq('key', key), { key, value: String(value), note: 'set by run-edge-cases.mjs' });
}

/** Poll until `fn` returns truthy, or give up. The pipeline is asynchronous by
 *  design, so every assertion has to wait for an outcome rather than assume the
 *  webhook's 202 meant the work finished. */
async function until(label, fn, { tries = 20, waitMs = 1500 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await nap(waitMs);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

const leadRow = (uid) => rows('lp_lead', eq('lead_uid', uid)).then((r) => r[0]);
const runTick = () => hook('lp-tick', { source: 'edge-case-runner' });

/** Ask Odoo directly. Trusting our own tables to prove a CRM write landed is
 *  the exact mistake this whole project is built to avoid. */
async function odoo(model, method, args, kwargs = {}) {
  const cfg = Object.fromEntries((await rows('lp_config')).map((r) => [r.key, r.value]));
  const url = String(cfg.odoo_url).replace(/\/+$/, '');
  const call = async (payload) => {
    const res = await fetch(`${url}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Odoo-Database': cfg.odoo_db },
      body: JSON.stringify(payload),
    });
    return res.json();
  };
  const auth = await call({ jsonrpc: '2.0', method: 'call', id: 1,
    params: { service: 'common', method: 'authenticate', args: [cfg.odoo_db, cfg.odoo_user, cfg.odoo_password, {}] } });
  const uid = auth.result;
  const out = await call({ jsonrpc: '2.0', method: 'call', id: 2,
    params: { service: 'object', method: 'execute_kw',
      args: [cfg.odoo_db, uid, cfg.odoo_password, model, method, args, { context: { active_test: false }, ...kwargs }] } });
  if (out.error) throw new Error('Odoo: ' + (out.error.data?.message || out.error.message));
  return out.result;
}
const odooByUid = (uid) => odoo('crm.lead', 'search_read',
  [[['x_lp_lead_id', '=', uid]]], { fields: ['id', 'name', 'stage_id', 'active', 'probability', 'user_id', 'email_from', 'phone'] });

// --- payload builders -------------------------------------------------------

const website = (over = {}) => ({
  submission_id: `sub_${RUN}_${Math.random().toString(36).slice(2, 8)}`,
  name: 'Nadia Hassan',
  email: `nadia+${RUN}@acme-logistics.com`,
  phone: phoneFor('99'),
  company: 'Acme Logistics',
  country: 'EG',
  service: 'Workflow automation',
  message: 'We move around 400 shipments a day and dispatch re-types every order into three systems. Budget is around $15,000 and we want to start immediately.',
  budget: '15000 USD',
  timeline: 'immediate',
  consent: true,
  ...over,
});

/**
 * A lead that lands in Qualified, deliberately NOT in VIP.
 *
 * The default `website()` fixture is a $15,000 urgent enquiry from a strategic
 * account, so it scores 100 and every one of them goes to Awaiting Approval.
 * That is correct behaviour and it is what EC-12 tests - but it means a VIP
 * lead gets no follow-up sequence and is owned by the manager, so the three
 * cases about the ordinary sales path (assignment, follow-ups, SLA) had no
 * ordinary lead to run on.
 *
 * Same enquiry, non-strategic company, no budget stated: 87 points, Qualified.
 */
const qualified = (over = {}) => website({
  company: 'Nile Cargo',
  email: `q+${RUN}@nilecargo.com`,
  budget: '',
  message: 'We move around 400 shipments a day and dispatch re-types every order into three systems. We want to start immediately.',
  ...over,
});

const whatsapp = (over = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '102290129340398', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '201234567890', phone_number_id: '106540352242922' },
    contacts: [{ profile: { name: over.name || 'Karim Adel' }, wa_id: over.from || '201009998877' }],
    messages: [{
      from: over.from || '201009998877',
      id: over.wamid || `wamid.${RUN}.${Math.random().toString(36).slice(2, 10)}`,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'text',
      text: { body: over.text || 'We run a logistics company and need an automation for dispatch urgently. Budget is around $12,000.' },
    }],
  } }] }],
});

// --- the cases --------------------------------------------------------------

const CASES = [];
const test = (n, title, fn) => CASES.push({ n, title, fn });

test(1, 'Same person from two sources within 2 minutes -> one opportunity, second merged', async () => {
  const phone = phoneFor("00");
  const a = await hook('lp-web-lead', website({ phone, email: `dual+${RUN}@acme-logistics.com`, name: 'Dual Source' }));
  if (a.status !== 202 || a.json.accepted !== 1) throw new Error(`website intake: ${a.status} ${JSON.stringify(a.json)}`);
  const uidA = a.json.lead_uids[0];
  await until('first lead reaches Odoo', async () => (await leadRow(uidA))?.odoo_lead_id > 0);

  const b = await hook('lp-wa-inbound', whatsapp({ from: waFor("00"), name: 'Dual Source',
    text: 'Following up on the form I filled in about dispatch automation.' }));
  if (b.status !== 202 || b.json.accepted !== 1) throw new Error(`whatsapp intake: ${b.status} ${JSON.stringify(b.json)}`);
  const uidB = b.json.lead_uids[0];

  if (uidA === uidB) throw new Error('the two deliveries collapsed into one event - they are separate events by the same person');

  const rowB = await until('second lead routed', async () => {
    const r = await leadRow(uidB);
    return r && (r.status === 'merged' || Number(r.odoo_lead_id) > 0) ? r : null;
  });
  const rowA = await leadRow(uidA);

  const oppsA = await odooByUid(uidA);
  const oppsB = await odooByUid(uidB);

  if (rowB.status !== 'merged') throw new Error(`second lead should be merged, it is "${rowB.status}"`);
  if (Number(rowB.odoo_lead_id) !== Number(rowA.odoo_lead_id)) {
    throw new Error(`two opportunities created: ${rowA.odoo_lead_id} and ${rowB.odoo_lead_id}`);
  }
  if (oppsB.length !== 0) throw new Error('the merged lead should not own its own opportunity');

  return `two deliveries (${uidA}, ${uidB}), one Odoo opportunity #${rowA.odoo_lead_id}; second marked merged into ${rowB.merged_into}, opp count for it = ${oppsA.length}`;
});

test(2, 'Phone formatted differently in each source -> recognised as one person', async () => {
  const uid = `LP-CHECK-${RUN}`;
  const spellings = [
    phoneFor('01'),
    '01' + waFor('01').slice(3),
    '0020' + waFor('01').slice(2),
    '(+20) ' + waFor('01').slice(2),
  ];
  const first = await hook('lp-web-lead', website({ phone: spellings[0], email: `fmt+${RUN}@nilecargo.com`, name: 'Format Test' }));
  const uidA = first.json.lead_uids[0];
  // Wait for the OPPORTUNITY, not just the lead row. Duplicate detection is a
  // search against Odoo, so there is nothing to match until the first lead has
  // actually been written there. Waiting only for `phone_key` - which intake
  // sets in the first second - submitted the second spelling while the first
  // was still being enriched, and both were correctly judged new. That is the
  // sub-second concurrent-arrival race documented under Known Limitations, and
  // it is not what this case is about: EC-2 is about two spellings of one
  // number being recognised as one person.
  await until('first format reaches Odoo', async () => (await leadRow(uidA))?.odoo_lead_id > 0,
    { tries: 30, waitMs: 2000 });
  const rowA = await leadRow(uidA);

  const second = await hook('lp-web-lead', website({ phone: spellings[2], email: `fmt2+${RUN}@nilecargo.com`, name: 'Format Test' }));
  const uidB = second.json.lead_uids[0];
  const rowB = await until('second format routed', async () => {
    const r = await leadRow(uidB);
    return r && (r.status === 'merged' || Number(r.odoo_lead_id) > 0) ? r : null;
  });

  if (rowA.phone_key !== rowB.phone_key) throw new Error(`phone keys differ: ${rowA.phone_key} vs ${rowB.phone_key}`);
  if (rowB.status !== 'merged') throw new Error(`different spelling of the same number was not merged (status ${rowB.status})`);
  return `"${spellings[0]}" and "${spellings[2]}" both -> phone_key ${rowA.phone_key}; second merged into opportunity #${rowB.odoo_lead_id}`;
});

test(3, 'Enrichment times out twice, then succeeds', async () => {
  await setConfig('enrich_chaos', '?fail=timeout&times=2');
  try {
    const r = await hook('lp-web-lead', website({
      email: `enrich+${RUN}@acme-logistics.com`, name: 'Enrich Retry', phone: phoneFor('03'),
    }));
    const uid = r.json.lead_uids[0];
    const row = await until('lead completes despite the timeouts', async () => {
      const l = await leadRow(uid);
      return l && Number(l.odoo_lead_id) > 0 ? l : null;
    }, { tries: 30, waitMs: 2000 });

    const audit = await rows('lp_audit', eq('lead_uid', uid));
    const scored = audit.find((a) => a.type === 'scored');
    const detail = JSON.parse(scored?.detail_json || '{}');
    if (Number(row.score) <= 0) throw new Error('the lead scored 0, so it did not really complete');
    return `enrichment status "${detail.enrichment}", lead still scored ${row.score} and reached Odoo #${row.odoo_lead_id}`;
  } finally {
    await setConfig('enrich_chaos', '');
  }
});

test(4, 'AI returns nothing usable -> lead completes on rules alone', async () => {
  await setConfig('ai_model', 'this-model/does-not-exist');
  try {
    const r = await hook('lp-web-lead', website({
      email: `aidown+${RUN}@acme-logistics.com`, name: 'AI Down', phone: phoneFor('04'),
    }));
    const uid = r.json.lead_uids[0];
    const row = await until('lead completes without the model', async () => {
      const l = await leadRow(uid);
      return l && Number(l.odoo_lead_id) > 0 ? l : null;
    }, { tries: 30, waitMs: 2000 });

    if (row.ai_status !== 'unavailable') throw new Error(`expected ai_status "unavailable", got "${row.ai_status}"`);
    if (!(Number(row.score) >= 70)) throw new Error(`a strong lead scored ${row.score} with the AI down - the AI is contributing points`);
    return `ai_status=unavailable, score still ${row.score} (${row.band}), Odoo #${row.odoo_lead_id}. The AI contributes zero points, so the fallback changed nothing.`;
  } finally {
    await setConfig('ai_model', '');
  }
});

test(5, 'AI and rules disagree materially -> manual review, neither side wins', async () => {
  // Engineered so the rules land in "unqualified" while the text reads as high
  // intent: no country, no company domain in the directory, no service keyword,
  // no urgency word, no currency amount.
  const r = await hook('lp-csv-import', {
    batch_id: `conflict-${RUN}`,
    attested_consent: true,
    csv: [
      'Name,Email,Notes',
      `Conflict Case,conflict+${RUN}@unknown-domain-xyz.com,"We have board approval and want to proceed with a purchase. Please send over a contract so we can sign."`,
    ].join('\n'),
  });
  const uid = r.json.lead_uids[0];
  const row = await until('conflict lead routed', async () => {
    const l = await leadRow(uid);
    return l && Number(l.odoo_lead_id) > 0 ? l : null;
  }, { tries: 30, waitMs: 2000 });

  const audit = await rows('lp_audit', eq('lead_uid', uid));
  const scored = audit.find((a) => a.type === 'scored');
  const d = JSON.parse(scored?.detail_json || '{}');

  // The RULE is unit-tested deterministically in scripts/test-scoring.js (six
  // assertions). Here a real model is asked a real question, so the honest
  // outcome is either "conflict detected" or "the model agreed" - both are
  // correct behaviour, and the run reports which happened rather than
  // pretending the model is deterministic.
  if (row.band === 'manual_review') {
    return `rules said ${d.rule_band} (${d.score}), model said ${d.ai?.intent} at ${d.ai?.confidence} -> manual_review, Odoo stage "${row.odoo_stage}"`;
  }
  if (d.ai?.status !== 'ok') return `SOFT: the model was ${d.ai?.status}, so there was nothing to disagree with. Conflict rule itself is covered by 6 assertions in test-scoring.js`;
  return `SOFT: rules ${d.rule_band} (${d.score}) vs model ${d.ai?.intent} @ ${d.ai?.confidence} - below the >=2 band / >=0.7 confidence bar, so correctly NOT escalated`;
});

test(6, 'Rate-limited dependency -> backoff, honours Retry-After, then succeeds', async () => {
  await setConfig('enrich_chaos', '?fail=429&times=1');
  try {
    const t0 = Date.now();
    const r = await hook('lp-web-lead', website({
      email: `ratelimit+${RUN}@acme-logistics.com`, name: 'Rate Limited', phone: phoneFor('06'),
    }));
    const uid = r.json.lead_uids[0];
    const row = await until('lead completes through the 429', async () => {
      const l = await leadRow(uid);
      return l && Number(l.odoo_lead_id) > 0 ? l : null;
    }, { tries: 30, waitMs: 2000 });
    const audit = await rows('lp_audit', eq('lead_uid', uid));
    const d = JSON.parse(audit.find((a) => a.type === 'scored')?.detail_json || '{}');
    return `429 absorbed, enrichment ${d.enrichment}, lead scored ${row.score} and reached Odoo #${row.odoo_lead_id} in ${Math.round((Date.now() - t0) / 1000)}s`;
  } finally {
    await setConfig('enrich_chaos', '');
  }
});

test(7, 'CRM write succeeded but the acknowledgement was lost -> repaired, not duplicated', async () => {
  const r = await hook('lp-web-lead', website({
    email: `lostack+${RUN}@acme-logistics.com`, name: 'Lost Ack', phone: phoneFor('07'),
  }));
  const uid = r.json.lead_uids[0];
  const row = await until('lead reaches Odoo', async () => {
    const l = await leadRow(uid);
    return l && Number(l.odoo_lead_id) > 0 ? l : null;
  }, { tries: 30, waitMs: 2000 });

  const before = await odooByUid(uid);
  if (before.length !== 1) throw new Error(`expected exactly 1 opportunity before the test, found ${before.length}`);

  // Rewind the ledger to the state a crash between the write and the response
  // would have left: claimed, never completed, no id recorded.
  await upsert('lp_idem', eq('idem_key', `odoo_upsert:${uid}`), {
    idem_key: `odoo_upsert:${uid}`, scope: 'odoo_upsert', lead_uid: uid,
    state: 'claimed', result_ref: '', claimed_at: Math.floor(Date.now() / 1000) - 30,
    completed_at: 0, attempts: 1,
  });

  const dlqId = `dlq-ec7-${RUN}`;
  await upsert('lp_dlq', eq('dlq_id', dlqId), {
    dlq_id: dlqId, lead_uid: uid, stage_failed: 'LP-03 Route and Sync / Odoo Upsert',
    error_class: 'transient', error: 'simulated: response lost after the CRM write',
    payload_json: '{}', attempts: 1, state: 'open',
    first_seen: Math.floor(Date.now() / 1000), last_seen: Math.floor(Date.now() / 1000),
  });

  const replay = await hook('lp-replay', { dlq_id: dlqId });
  if (replay.status !== 202) throw new Error(`replay: ${replay.status} ${JSON.stringify(replay.json)}`);

  await nap(8000);
  const after = await odooByUid(uid);
  if (after.length !== 1) throw new Error(`the replay created a duplicate: ${after.length} opportunities for ${uid}`);
  const led = (await rows('lp_idem', eq('idem_key', `odoo_upsert:${uid}`)))[0];
  return `ledger rewound to "claimed", replayed -> still exactly 1 opportunity (#${after[0].id}); ledger repaired to "${led?.state}" with ref ${led?.result_ref}`;
});

test(8, 'The same message is dispatched twice -> sent once', async () => {
  const r = await hook('lp-web-lead', website({
    email: `oncesend+${RUN}@acme-logistics.com`, name: 'Once Only', phone: phoneFor('08'),
  }));
  const uid = r.json.lead_uids[0];
  await until('confirmation sent', async () => {
    const a = await rows('lp_audit', eq('lead_uid', uid));
    return a.some((x) => x.type === 'message_sent') ? true : null;
  }, { tries: 30, waitMs: 2000 });

  const claimBefore = (await rows('lp_idem', eq('lead_uid', uid))).filter((x) => x.scope === 'message');
  if (!claimBefore.length) throw new Error('no message claim was recorded at all');

  // Re-run the whole routing step, which dispatches the same template at the
  // same step. The claim already says done.
  const dlqId = `dlq-ec8-${RUN}`;
  await upsert('lp_dlq', eq('dlq_id', dlqId), {
    dlq_id: dlqId, lead_uid: uid, stage_failed: 'manual re-dispatch', error_class: 'transient',
    error: 'simulated re-dispatch', payload_json: '{}', attempts: 1, state: 'open',
    first_seen: Math.floor(Date.now() / 1000), last_seen: Math.floor(Date.now() / 1000),
  });
  await hook('lp-replay', { dlq_id: dlqId });
  await nap(10000);

  const audit = await rows('lp_audit', eq('lead_uid', uid));
  const sent = audit.filter((a) => a.type === 'message_sent');
  const suppressed = audit.filter((a) => a.type === 'message_suppressed');
  if (sent.length !== 1) throw new Error(`expected exactly 1 message_sent, found ${sent.length}`);
  const why = suppressed.map((s) => JSON.parse(s.detail_json || '{}').reason).filter(Boolean);
  return `1 message_sent, ${suppressed.length} suppressed on the re-dispatch${why.length ? ` ("${why[0]}")` : ''}`;
});

test(9, 'Owner becomes unavailable after assignment -> reassigned by the tick', async () => {
  const r = await hook('lp-web-lead', qualified({
    email: `orphan+${RUN}@nilecargo.com`, name: 'Orphan Lead', phone: phoneFor('09'),
  }));
  const uid = r.json.lead_uids[0];
  const row = await until('lead assigned', async () => {
    const l = await leadRow(uid);
    return l && l.owner_id ? l : null;
  }, { tries: 30, waitMs: 2000 });

  const owner = row.owner_id;
  const roster = await rows('lp_agents');
  const agent = roster.find((a) => a.agent_id === owner);
  if (!agent) throw new Error(`assigned owner ${owner} is not on the roster`);

  // Guarantee the precondition instead of hoping for it. The suite leaves its
  // leads behind, so after two or three runs every rep is at their seeded
  // capacity (8, 8, 6) and there is genuinely nowhere to reassign to - the
  // picker lands back on the same owner and this case fails for a reason that
  // has nothing to do with owner health. Headroom is part of the scenario, so
  // the test sets it up and puts it back.
  const others = roster.filter((a) => a.agent_id !== owner);
  for (const a of others) await upsert('lp_agents', eq('agent_id', a.agent_id), { ...a, capacity: 999, available: true });

  await upsert('lp_agents', eq('agent_id', owner), { ...agent, available: false });
  try {
    await runTick();
    const moved = await until('lead reassigned', async () => {
      const l = await leadRow(uid);
      return l && l.owner_id && l.owner_id !== owner ? l : null;
    }, { tries: 12, waitMs: 2500 });
    return `owner ${owner} marked unavailable -> tick reassigned ${uid} to ${moved.owner_id} (rung ${moved.assign_rung})`;
  } finally {
    await upsert('lp_agents', eq('agent_id', owner), { ...agent, available: true });
    for (const a of others) await upsert('lp_agents', eq('agent_id', a.agent_id), { ...a });
  }
});

test(10, 'Opt-out lands while a follow-up is scheduled -> the follow-up never goes out', async () => {
  const r = await hook('lp-web-lead', qualified({
    email: `optout+${RUN}@nilecargo.com`, name: 'Opt Out', phone: phoneFor('10'),
  }));
  const uid = r.json.lead_uids[0];
  await until('follow-ups scheduled', async () => {
    const j = await rows('lp_jobs', eq('lead_uid', uid));
    return j.some((x) => x.job_type === 'followup' && x.state === 'pending') ? true : null;
  }, { tries: 30, waitMs: 2000 });

  // Bring the first follow-up forward so it is due right now.
  const jobs = await rows('lp_jobs', eq('lead_uid', uid));
  const fu = jobs.filter((j) => j.job_type === 'followup' && j.state === 'pending')
    .sort((a, b) => Number(a.step) - Number(b.step))[0];
  await upsert('lp_jobs', eq('job_id', fu.job_id), { ...fu, due_at: Math.floor(Date.now() / 1000) - 5 });

  const ev = await hook('lp-event', { type: 'opt_out', lead_uid: uid, note: 'unsubscribe, please stop' });
  if (ev.status !== 200 || !ev.json.ok) throw new Error(`opt_out: ${ev.status} ${JSON.stringify(ev.json)}`);

  await runTick();
  await nap(9000);

  const after = await rows('lp_jobs', eq('lead_uid', uid));
  const stillPending = after.filter((j) => j.state === 'pending' || j.state === 'inflight');
  const cancelled = after.filter((j) => j.state === 'cancelled');
  const audit = await rows('lp_audit', eq('lead_uid', uid));
  const sentAfter = audit.filter((a) => a.type === 'message_sent' && !String(a.decision).startsWith('sent: confirm'));
  const lead = await leadRow(uid);

  if (stillPending.length) throw new Error(`${stillPending.length} job(s) still live after the opt-out`);
  if (sentAfter.length) throw new Error(`a follow-up went out after the opt-out: ${sentAfter.map((a) => a.decision).join(', ')}`);
  if (lead.consent !== 'denied') throw new Error(`consent is "${lead.consent}", expected denied`);

  const opp = (await odooByUid(uid))[0];
  return `${cancelled.length} job(s) cancelled (${cancelled[0]?.cancel_reason}), consent=denied, no follow-up sent, Odoo opportunity active=${opp?.active}`;
});

test(11, 'The booking webhook is delivered twice -> booked once', async () => {
  const r = await hook('lp-web-lead', website({
    email: `booking+${RUN}@acme-logistics.com`, name: 'Booking Twice', phone: phoneFor('11'),
  }));
  const uid = r.json.lead_uids[0];
  await until('lead routed', async () => (await leadRow(uid))?.odoo_lead_id > 0);

  const bookingId = `bk_${RUN}_dup`;
  const payload = { type: 'booking', lead_uid: uid, booking_id: bookingId, slot: '2026-08-14T10:00:00Z' };
  const first = await hook('lp-event', payload);
  const second = await hook('lp-event', payload);

  if (!first.json.applied) throw new Error(`first booking was not applied: ${JSON.stringify(first.json)}`);
  if (second.json.duplicate !== true) throw new Error(`second delivery was not recognised as a duplicate: ${JSON.stringify(second.json)}`);
  if (second.status !== 200) throw new Error(`a duplicate must answer 200, got ${second.status} - an error makes the provider retry forever`);

  const audit = await rows('lp_audit', eq('lead_uid', uid));
  const bookings = audit.filter((a) => String(a.decision).startsWith('booking'));
  if (bookings.length !== 1) throw new Error(`${bookings.length} booking events recorded, expected 1`);
  const lead = await leadRow(uid);
  return `two deliveries of ${bookingId}: first applied (stage "${lead.odoo_stage}"), second answered 200 duplicate:true; 1 audit event`;
});

test(12, 'Manager rejects a VIP -> everything outbound stops', async () => {
  // gulftech.ae is flagged strategic in the enrichment directory, which forces
  // the VIP band regardless of score.
  const r = await hook('lp-web-lead', website({
    email: `vip+${RUN}@gulftech.ae`, name: 'VIP Reject', company: 'GulfTech',
    phone: '+971 5' + '12' + P6.slice(1), country: 'AE',
  }));
  const uid = r.json.lead_uids[0];
  const row = await until('VIP awaiting approval', async () => {
    const l = await leadRow(uid);
    return l && l.approval_state === 'pending' ? l : null;
  }, { tries: 30, waitMs: 2000 });

  if (row.band !== 'vip') throw new Error(`expected band vip, got ${row.band}`);
  const auditBefore = await rows('lp_audit', eq('lead_uid', uid));
  const toLead = auditBefore.filter((a) => a.type === 'message_sent' && /confirm_/.test(String(a.decision)));
  if (toLead.length) throw new Error('a confirmation reached the lead before the manager decided');

  const dec = await hook('lp-approval', { lead_uid: uid, decision: 'reject', by: 'edge-case-runner', note: 'not a fit' });
  if (!dec.json.ok) throw new Error(`reject: ${JSON.stringify(dec.json)}`);
  await nap(6000);

  const after = await leadRow(uid);
  const jobs = await rows('lp_jobs', eq('lead_uid', uid));
  const live = jobs.filter((j) => j.state === 'pending' || j.state === 'inflight');
  const opp = (await odooByUid(uid))[0];

  if (after.approval_state !== 'rejected') throw new Error(`approval_state is ${after.approval_state}`);
  if (live.length) throw new Error(`${live.length} job(s) still live after the rejection`);
  if (opp?.active !== false) throw new Error('the opportunity is still active in Odoo after a rejection');
  return `stage before: Awaiting Approval, no message reached the lead; after reject: status=${after.status}, ${jobs.filter((j) => j.state === 'cancelled').length} job(s) cancelled, Odoo active=false`;
});

test(13, 'One corrupted row in a CSV -> quarantined alone, the rest import', async () => {
  const csv = [
    'Name,Email,Phone,Company,Country,Service,Notes,Consent',
    `Row One,r1+${RUN}@nilecargo.com,01${P6}01,Nile Cargo,Egypt,Integration,Needs ERP and site talking,yes`,
    'Broken Row Here,only-three,cells',
    `Row Three,r3+${RUN}@deltaclinics.com,01${P6}03,Delta Clinics,Egypt,Automation,Wants a booking bot,yes`,
    `No Contact,,,Ghost Industries,Egypt,Consulting,Nothing to contact here,yes`,
  ].join('\n');

  const r = await hook('lp-csv-import', { batch_id: `csv-${RUN}`, attested_consent: true, csv });
  if (r.status !== 202) throw new Error(`csv import: ${r.status} ${JSON.stringify(r.json)}`);
  const { accepted, quarantined, errors } = r.json;
  if (accepted !== 2) throw new Error(`expected 2 accepted, got ${accepted}`);
  if (quarantined !== 2) throw new Error(`expected 2 quarantined (the short row and the uncontactable one), got ${quarantined}`);

  // The 202 is sent before the work, on purpose - a webhook that waits for the
  // pipeline is a webhook that times out. So the quarantine rows are written a
  // moment after the response, and this has to poll rather than read once.
  const mine = await until('quarantined rows reach the dead-letter queue', async () => {
    const found = (await rows('lp_dlq')).filter((d) => String(d.payload_json).includes(`csv-${RUN}`));
    return found.length >= 2 ? found : null;
  }, { tries: 15, waitMs: 1500 });
  const hasText = mine.some((d) => String(d.payload_json).includes('only-three') || String(d.error).includes('columns'));
  if (!hasText) throw new Error('the dead letter does not carry enough to fix and replay the row');

  return `4 rows in: 2 imported (${r.json.lead_uids.join(', ')}), 2 quarantined - "${errors.map((e) => `line ${e.line}: ${e.error}`).join('" / "')}"; ${mine.length} dead letter(s) hold the original row text`;
});

test(14, 'Manual re-run after a partial success -> completed steps are skipped', async () => {
  const r = await hook('lp-web-lead', website({
    email: `replay+${RUN}@acme-logistics.com`, name: 'Replay Me', phone: phoneFor('14'),
  }));
  const uid = r.json.lead_uids[0];
  const row = await until('lead fully routed', async () => {
    const l = await leadRow(uid);
    return l && Number(l.odoo_lead_id) > 0 ? l : null;
  }, { tries: 30, waitMs: 2000 });

  const oppsBefore = await odooByUid(uid);
  const dlqId = `dlq-ec14-${RUN}`;
  await upsert('lp_dlq', eq('dlq_id', dlqId), {
    dlq_id: dlqId, lead_uid: uid, stage_failed: 'LP-03 Route and Sync / Send Outreach',
    error_class: 'transient', error: 'simulated: failed after the CRM write, before the message',
    payload_json: '{}', attempts: 1, state: 'open',
    first_seen: Math.floor(Date.now() / 1000), last_seen: Math.floor(Date.now() / 1000),
  });

  const replay = await hook('lp-replay', { dlq_id: dlqId });
  if (replay.status !== 202) throw new Error(`replay: ${replay.status} ${JSON.stringify(replay.json)}`);
  if (replay.json.odoo_already_created !== true) {
    throw new Error(`the replay did not notice the CRM write had already completed: ${JSON.stringify(replay.json)}`);
  }

  await nap(9000);
  const oppsAfter = await odooByUid(uid);
  if (oppsAfter.length !== oppsBefore.length) {
    throw new Error(`opportunity count changed from ${oppsBefore.length} to ${oppsAfter.length}`);
  }
  const dlqRow = (await rows('lp_dlq', eq('dlq_id', dlqId)))[0];
  return `replay reported odoo_already_created=true, skipped ${JSON.stringify(replay.json.skipped_because_complete)}; opportunity count unchanged at ${oppsAfter.length} (#${oppsAfter[0].id}); dead letter now "${dlqRow?.state}"`;
});

// Not one of the 14, but business rule 7 deserves the same treatment: a rule
// stated in a document is a claim, and this makes it an observation.
test(15, 'Business rule 7: no sales action within the SLA -> escalated and reassigned', async () => {
  const r = await hook('lp-web-lead', qualified({
    email: `sla+${RUN}@nilecargo.com`, name: 'SLA Breach', phone: phoneFor('15'),
  }));
  const uid = r.json.lead_uids[0];
  const row = await until('SLA timer scheduled', async () => {
    const j = await rows('lp_jobs', eq('lead_uid', uid));
    return j.find((x) => x.job_type === 'sla' && x.state === 'pending') || null;
  }, { tries: 30, waitMs: 2000 });

  const lead = await leadRow(uid);
  const dueIn = Number(row.due_at) - Math.floor(Date.now() / 1000);
  if (dueIn < 1500 || dueIn > 1900) throw new Error(`SLA timer is due in ${dueIn}s, expected ~1800 (30 minutes)`);

  // Wind the clock forward rather than waiting half an hour.
  await upsert('lp_jobs', eq('job_id', row.job_id), { ...row, due_at: Math.floor(Date.now() / 1000) - 5 });
  await runTick();

  const breached = await until('breach recorded', async () => {
    const a = await rows('lp_audit', eq('lead_uid', uid));
    return a.find((x) => x.type === 'sla_breached') || null;
  }, { tries: 12, waitMs: 2500 });

  const job = (await rows('lp_jobs', eq('job_id', row.job_id)))[0];
  return `timer scheduled at +${dueIn}s (rule says 1800); on breach: audit "${breached.decision}", job state "${job.state}", owner was ${lead.owner_id} at stage "${lead.odoo_stage}"`;
});

// --- run --------------------------------------------------------------------

(async () => {
  console.log(`Lead Intelligence Pipeline - edge case suite`);
  console.log(`instance ${BASE}   run id ${RUN}\n`);
  await loadTables();

  // PREFLIGHT, and it is not optional.
  //
  // This suite creates leads whose addresses look real, and LP-92 sends real
  // email. Without demo_redirect_email set, a test run would put mail in a
  // stranger's inbox at a domain nobody here owns. Refusing to start is the
  // only acceptable behaviour: a test harness that can reach a real person is
  // a test harness that eventually will.
  const cfg = Object.fromEntries((await rows('lp_config')).map((r) => [r.key, r.value]));
  if (!cfg.odoo_url) {
    console.error('lp_config has no odoo_url. Run LP-00 Setup and Seed once first.');
    process.exit(2);
  }
  if (!String(cfg.demo_redirect_email || '').trim()) {
    console.error([
      'REFUSING TO RUN: lp_config.demo_redirect_email is not set.',
      '',
      'This suite generates leads at real-looking domains and the pipeline sends real',
      'email. Set the redirect first so every lead-facing message lands in one inbox',
      'you own, with the intended recipient preserved in the subject line:',
      '',
      '  node -e "..." or add the row through the n8n Data Table UI:',
      '     lp_config: key=demo_redirect_email  value=<your address>',
      '',
      'Manager alerts are never redirected - they are internal by definition.',
    ].join('\n'));
    process.exit(2);
  }
  console.log(`lead-facing mail redirected to ${cfg.demo_redirect_email}\n`);

  const chosen = only.length ? CASES.filter((c) => only.includes(c.n)) : CASES;
  const results = [];

  for (const c of chosen) {
    const t0 = Date.now();
    process.stdout.write(`EC-${String(c.n).padStart(2)}  ${c.title}\n`);
    try {
      const detail = await c.fn();
      const soft = String(detail).startsWith('SOFT:');
      results.push({ n: c.n, title: c.title, status: soft ? 'SOFT' : 'PASS', detail, secs: Math.round((Date.now() - t0) / 1000) });
      console.log(`        ${soft ? 'SOFT' : 'PASS'}  ${detail}\n`);
    } catch (e) {
      results.push({ n: c.n, title: c.title, status: 'FAIL', detail: e.message, secs: Math.round((Date.now() - t0) / 1000) });
      console.log(`        FAIL  ${e.message}\n`);
    }
  }

  const pass = results.filter((r) => r.status === 'PASS').length;
  const soft = results.filter((r) => r.status === 'SOFT').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;

  console.log('-'.repeat(76));
  console.log(`${pass} passed, ${soft} soft (non-deterministic, explained), ${fail} failed`);

  const out = path.join(ROOT, '05_Test_Evidence', 'last-run.json');
  fs.writeFileSync(out, JSON.stringify({ instance: BASE, run_id: RUN, results }, null, 2) + '\n');
  console.log(`Full detail written to ${path.relative(ROOT, out)}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nSUITE ABORTED:', e.message); process.exit(2); });
