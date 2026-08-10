/**
 * Shared plumbing for the two live test suites.
 *
 * Extracted from run-edge-cases.mjs when run-hardening.mjs needed the same
 * thing. Copying it would have been faster and would have started drifting the
 * moment one of them learned something the other did not - which is the exact
 * failure this project spends its whole architecture avoiding, so it would be a
 * poor place to make an exception.
 *
 * Nothing here knows anything about a test case. It knows how to reach the
 * instance, how to read and write the data tables, how to ask Odoo directly,
 * and how to wait for an asynchronous outcome.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const line of fs.existsSync(path.join(ROOT, '.env'))
  ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n') : []) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !/^\s*#/.test(line)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

export const BASE = (process.env.N8N_API_URL || '').replace(/\/+$/, '');
export const KEY = process.env.N8N_API_KEY;
export const TOKEN = process.env.LP_WEBHOOK_TOKEN;

export function requireEnv() {
  if (!BASE || !KEY || !TOKEN) {
    console.error('Set N8N_API_URL, N8N_API_KEY and LP_WEBHOOK_TOKEN in the repo-root .env first.');
    process.exit(1);
  }
}

export const nap = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Call a pipeline webhook. `token` is overridable so the auth cases can send a
 * wrong one or none at all; `raw` sends a body byte-for-byte, which is how a
 * malformed-JSON case is expressed.
 */
export async function hook(pathname, body, { query = '', token = TOKEN, raw = null, method = 'POST' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== null) headers['X-LP-Token'] = token;
  const res = await fetch(`${BASE}/webhook/${pathname}${query}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : (raw !== null ? raw : JSON.stringify(body ?? {})),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 400) }; }
  return { status: res.status, json, text };
}

export async function napi(method, urlPath, body) {
  const res = await fetch(`${BASE}/api/v1${urlPath}`, {
    method,
    headers: { 'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return { status: res.status, json: text ? JSON.parse(text) : null }; }
  catch { return { status: res.status, json: { raw: text.slice(0, 400) } }; }
}

// Data Table REST, measured against this build (see odoo-api-probe.md):
//   GET  /rows?filter=   POST /rows (insert)   POST /rows/upsert
// No PATCH, no PUT, no DELETE. `limit` is capped at 250 and a larger value is
// a 400, not a clamp.
export const TABLES = {};
export const REQUIRED_TABLES = ['lp_config', 'lp_lead', 'lp_idem', 'lp_jobs', 'lp_agents', 'lp_audit', 'lp_dlq', 'lp_person_index'];

export async function loadTables() {
  const r = await napi('GET', '/data-tables?limit=100');
  for (const t of r.json?.data || []) TABLES[t.name] = t.id;
  for (const t of REQUIRED_TABLES) {
    if (!TABLES[t]) throw new Error(`data table ${t} is missing. Run: node scripts/create-tables.js`);
  }
}

export const eq = (col, val) => ({ type: 'and', filters: [{ columnName: col, condition: 'eq', value: val }] });

export async function rows(table, filter) {
  const q = filter ? `?filter=${encodeURIComponent(JSON.stringify(filter))}&limit=250` : '?limit=250';
  const r = await napi('GET', `/data-tables/${TABLES[table]}/rows${q}`);
  if (r.status >= 300) throw new Error(`read ${table}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json?.data || [];
}

/**
 * A read returns three columns the table does not have - `id`, `createdAt`,
 * `updatedAt` - and the natural way to edit a row is `{...row, field: value}`.
 * That sends them straight back and the API answers
 * `400 unknown column name 'id'`.
 *
 * This cost three edge cases on the first full run: each set up its scenario
 * with an upsert, got a silent 400 because nothing checked the status, then
 * failed twenty seconds later asserting on a state change that had never been
 * written. So: strip the three, and THROW on any non-2xx. A harness that
 * swallows a 400 is not a harness, it is a random number generator.
 */
export async function upsert(table, filter, row) {
  const { id, createdAt, updatedAt, ...data } = row;
  const r = await napi('POST', `/data-tables/${TABLES[table]}/rows/upsert`, { filter, data });
  if (r.status >= 300) throw new Error(`upsert ${table}: ${r.status} ${JSON.stringify(r.json)}`);
  return r;
}

export async function config() {
  return Object.fromEntries((await rows('lp_config')).map((r) => [r.key, r.value]));
}

export async function setConfig(key, value, note = 'set by the test harness') {
  return upsert('lp_config', eq('key', key), { key, value: String(value), note });
}

/** Poll until `fn` returns truthy, or give up. The pipeline is asynchronous by
 *  design, so every assertion has to wait for an outcome rather than assume the
 *  webhook's 202 meant the work finished. */
export async function until(label, fn, { tries = 20, waitMs = 1500 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await nap(waitMs);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

export const leadRow = (uid) => rows('lp_lead', eq('lead_uid', uid)).then((r) => r[0]);
export const auditFor = (uid) => rows('lp_audit', eq('lead_uid', uid));
export const jobsFor = (uid) => rows('lp_jobs', eq('lead_uid', uid));
export const runTick = () => hook('lp-tick', { source: 'test-harness' });

/** Ask Odoo directly. Trusting our own tables to prove a CRM write landed is
 *  the exact mistake this whole project is built to avoid. */
export async function odoo(model, method, args, kwargs = {}) {
  const cfg = await config();
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

export const odooByUid = (uid) => odoo('crm.lead', 'search_read',
  [[['x_lp_lead_id', '=', uid]]],
  { fields: ['id', 'name', 'stage_id', 'active', 'probability', 'user_id', 'email_from', 'phone', 'description'] });

/**
 * The mail-redirect preflight. Both suites create leads at real-looking
 * domains and the pipeline sends real email, so neither may start without it.
 * A safety net you have to remember to switch on is not a safety net.
 */
export async function requireMailRedirect() {
  const cfg = await config();
  if (!cfg.demo_redirect_email) {
    console.error([
      '',
      'REFUSING TO RUN: lp_config.demo_redirect_email is not set.',
      '',
      'This suite creates leads at real-looking addresses and the pipeline sends',
      'real email. With the redirect set, every lead-facing message goes to an',
      'inbox you own, with the intended recipient preserved in the subject line.',
      '',
      '  node scripts/demo-reset.js you@example.com',
      '',
      'Manager alerts are never redirected - they are internal by definition.',
    ].join('\n'));
    process.exit(2);
  }
  return cfg.demo_redirect_email;
}

/** Standard suite runner: prints as it goes, writes a JSON artefact, exits non-zero on failure. */
export async function runSuite({ title, cases, only, outFile }) {
  const chosen = only && only.length ? cases.filter((c) => only.includes(c.n)) : cases;
  const results = [];

  for (const c of chosen) {
    const t0 = Date.now();
    process.stdout.write(`${String(c.n).padStart(3)}  ${c.title}\n`);
    try {
      const detail = await c.fn();
      const soft = String(detail).startsWith('SOFT:');
      results.push({ n: c.n, group: c.group, title: c.title, status: soft ? 'SOFT' : 'PASS', detail, secs: Math.round((Date.now() - t0) / 1000) });
      console.log(`     ${soft ? 'SOFT' : 'PASS'}  ${detail}\n`);
    } catch (e) {
      results.push({ n: c.n, group: c.group, title: c.title, status: 'FAIL', detail: e.message, secs: Math.round((Date.now() - t0) / 1000) });
      console.log(`     FAIL  ${e.message}\n`);
    }
  }

  const pass = results.filter((r) => r.status === 'PASS').length;
  const soft = results.filter((r) => r.status === 'SOFT').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;

  console.log('-'.repeat(76));
  console.log(`${title}: ${pass} passed, ${soft} soft, ${fail} failed`);
  if (fail) {
    console.log('\nFailures:');
    for (const r of results.filter((x) => x.status === 'FAIL')) console.log(`  ${r.n}  ${r.title}\n      ${r.detail}`);
  }

  if (outFile) {
    fs.writeFileSync(path.join(ROOT, outFile),
      JSON.stringify({ instance: BASE, suite: title, results }, null, 2) + '\n');
    console.log(`Full detail written to ${outFile}`);
  }
  return fail;
}
