#!/usr/bin/env node
/**
 * Put the whole system back to a known-empty state, in one command.
 *
 *   node scripts/demo-reset.js you@example.com
 *
 * Three steps, about 90 seconds:
 *   1. drop and recreate the eight lp_* data tables
 *   2. run LP-00 Setup and Seed in mode "demo" - provisions a fresh Odoo
 *      sandbox, creates the external-reference field, the five extra funnel
 *      stages and the sales roster
 *   3. set demo_redirect_email, so no test lead can be mailed
 *
 * WHY THIS EXISTS
 * The edge-case suite is designed to survive leftover state - identities are
 * run-unique - but it cannot survive a saturated roster. Each run leaves ~15
 * active leads behind and the seeded capacities are 8, 8 and 6, so by the third
 * consecutive run every salesperson is full, every lead falls to the fallback
 * owner, and the reassignment case has nowhere to reassign to. Resetting is
 * cheaper than making every case defend itself against that.
 *
 * It is also the honest way to demo: a reviewer watching this run knows the
 * results in front of them were produced from nothing, a minute ago.
 *
 * DESTRUCTIVE. It deletes every row in every lp_* table.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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
const TOKEN = process.env.LP_WEBHOOK_TOKEN;
const MANAGER = process.argv[2];

if (!BASE || !KEY || !TOKEN) {
  console.error('Set N8N_API_URL, N8N_API_KEY and LP_WEBHOOK_TOKEN in .env at the repo root.');
  process.exit(1);
}
if (!MANAGER || !/^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(MANAGER)) {
  console.error('Usage: node scripts/demo-reset.js <your-email@example.com>\n\n' +
    'The address receives VIP approvals and alerts, and every lead-facing message is\n' +
    'redirected to it so a test run can never reach a real person.');
  process.exit(1);
}

const napi = async (method, urlPath, body) => {
  const res = await fetch(`${BASE}/api/v1${urlPath}`, {
    method,
    headers: { 'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 300) }; }
  if (res.status >= 300) throw new Error(`${method} ${urlPath} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
};

(async () => {
  console.log('1. recreating the eight lp_* tables');
  const out = execFileSync(process.execPath, [path.join(__dirname, 'create-tables.js'), '--recreate'], { encoding: 'utf8' });
  console.log('  ', out.trim().split('\n').pop());

  console.log('2. LP-00 Setup and Seed (mode demo - provisions a fresh Odoo sandbox)');
  const res = await fetch(`${BASE}/webhook/lp-setup`, {
    method: 'POST',
    headers: { 'X-LP-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'demo', manager_email: MANAGER }),
  });
  const setup = await res.json().catch(() => ({}));
  if (!setup.ok) throw new Error(`setup failed: ${res.status} ${JSON.stringify(setup)}`);
  console.log(setup.summary.split('\n').map((l) => '   ' + l).join('\n'));

  console.log('3. redirecting every lead-facing message to ' + MANAGER);
  const tables = Object.fromEntries((await napi('GET', '/data-tables?limit=100')).data.map((t) => [t.name, t.id]));
  await napi('POST', `/data-tables/${tables.lp_config}/rows/upsert`, {
    filter: { type: 'and', filters: [{ columnName: 'key', condition: 'eq', value: 'demo_redirect_email' }] },
    data: { key: 'demo_redirect_email', value: MANAGER, note: 'demo safety net - no test lead can be emailed' },
  });

  console.log('\nReady. Next: node 05_Test_Evidence/run-edge-cases.mjs');
})().catch((e) => { console.error('\nRESET FAILED:', e.message); process.exit(1); });
