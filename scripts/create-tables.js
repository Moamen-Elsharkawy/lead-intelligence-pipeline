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

// THE SCHEMA IS NOT DEFINED HERE. It is read from _shared/constants.js, which
// is also what the workflows are built from - so a column can never exist in
// one place and not the other.
//
// It used to be defined twice, and the two drifted: this file created
// `stated_urgency` and `stated_budget` long after the code had been unified on
// `urgency` and `budget_band`. Two dead columns, two missing ones, and nothing
// failed - because writing to a column that does not exist is only an error if
// something writes to it, and nothing did until a test asked.
const C = require('../02_Workflows/_shared/constants.js');

const TABLES = Object.fromEntries(
  Object.entries(C.TABLES).map(([table, cols]) => [
    table,
    Object.entries(cols).map(([name, type]) => ({ name, type })),
  ]),
);

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
