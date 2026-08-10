#!/usr/bin/env node
/**
 * Deploy the built workflows to an n8n instance, and repair sub-workflow
 * references while doing it.
 *
 * THE PROBLEM THIS SOLVES
 * `Execute Sub-workflow` stores the callee's **workflow id**, and so does
 * `settings.errorWorkflow`. Ids are minted per instance, so importing a set of
 * JSON files through the n8n UI leaves every cross-workflow reference pointing
 * at nothing - the reviewer's first click is a red node. Specs therefore write
 * a placeholder `@LP-90 Odoo Gateway`, and this script resolves those to real
 * ids in a second pass, after every workflow exists.
 *
 *   node scripts/deploy.js              deploy everything
 *   node scripts/deploy.js LP-90        deploy only files matching LP-90
 *   node scripts/deploy.js --dry        show what would happen
 *
 * Requires N8N_API_URL and N8N_API_KEY in the repo-root .env.
 */
const fs = require('fs');
const path = require('path');

// A git-ignored .env at the repo root is honoured so the key never has to live
// in a shell history or a committed file. Real deployments inject the same two
// variables from their own secret store.
//
// The file OVERRIDES an ambient variable of the same name, which is the
// opposite of the usual precedence and is deliberate: an expired N8N_API_KEY
// left in the shell environment silently shadowed the working one here and
// produced a bare 401 that looked like a permissions problem on the instance.
// The most specific configuration present should win.
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
const OUT = path.join(__dirname, '..', '02_Workflows');
const IDS_FILE = path.join(__dirname, '..', '.n8n-ids.json');

if (!KEY) {
  console.error('N8N_API_KEY is not set. Export it, or run the MCP-backed path instead.');
  process.exit(1);
}

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const filter = args.find((a) => !a.startsWith('--'));

async function api(method, urlPath, body) {
  const res = await fetch(`${BASE}/api/v1${urlPath}`, {
    method,
    headers: { 'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 500) }; }
  if (!res.ok) {
    const detail = parsed?.message || parsed?.raw || text.slice(0, 400);
    throw new Error(`${method} ${urlPath} -> ${res.status}: ${detail}`);
  }
  return parsed;
}

/** n8n rejects a create/update that carries read-only fields, so send only these. */
function payloadOf(wf) {
  return { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings };
}

async function listRemote() {
  const byName = new Map();
  let cursor;
  do {
    const q = `/workflows?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page = await api('GET', q);
    for (const w of page.data || []) byName.set(w.name, w.id);
    cursor = page.nextCursor;
  } while (cursor);
  return byName;
}

(async () => {
  const files = fs
    .readdirSync(OUT)
    .filter((f) => f.endsWith('.json') && f !== 'manifest.json')
    .filter((f) => !filter || f.includes(filter))
    .sort();

  if (!files.length) {
    console.error('Nothing to deploy. Run: node scripts/build-workflows.js');
    process.exit(1);
  }

  const remote = await listRemote();
  const ids = fs.existsSync(IDS_FILE) ? JSON.parse(fs.readFileSync(IDS_FILE, 'utf8')) : {};

  // ---- credential name -> id -------------------------------------------
  // Workflow JSON in the repo references credentials BY NAME ONLY, so no
  // secret and no instance-specific id is ever committed. n8n, however, binds
  // on id: given a name it does not recognise it silently attaches the first
  // credential of the same TYPE. That is not a hypothetical - the first deploy
  // of this project asked for "LP Webhook Token (X-LP-Token)" and n8n quietly
  // bound an unrelated "Header Auth account", and the webhook answered 403
  // with no indication why. Resolve explicitly, and fail loudly when a name is
  // missing.
  const credByName = new Map();
  {
    const res = await api('GET', '/credentials?limit=250');
    for (const c of res.data || []) credByName.set(c.name, { id: c.id, name: c.name });
  }

  function bindCredentials(wf) {
    for (const node of wf.nodes) {
      if (!node.credentials) continue;
      for (const [type, ref] of Object.entries(node.credentials)) {
        if (ref && ref.id) continue;
        const found = credByName.get(ref?.name);
        if (!found) {
          throw new Error(
            `${wf.name}: node "${node.name}" needs the ${type} credential "${ref?.name}", ` +
            `which does not exist on ${BASE}. Create it in n8n with exactly that name, then redeploy. ` +
            `(Deploying anyway would bind an unrelated credential of the same type and fail at runtime.)`,
          );
        }
        node.credentials[type] = found;
      }
    }
  }

  // ---- pass 0: make sure every workflow has an id BEFORE any content ----
  // References have to be resolved before the first real PUT, not after. n8n
  // validates an update against the published version, so pushing content that
  // still contains an unresolved "@LP-90 Odoo Gateway" to an already-published
  // workflow is rejected outright:
  //   "Cannot publish workflow: Node X references workflow @LP-90 ... which is
  //    not published"
  // A brand-new workflow therefore gets an empty shell first, purely to mint
  // its id, and every reference is resolved before anything meaningful ships.
  const loaded = files.map((f) => ({ f, wf: JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')) }));
  loaded.forEach(({ wf }) => bindCredentials(wf));

  for (const { wf } of loaded) {
    const existing = remote.get(wf.name) || ids[wf.name];
    if (existing) { ids[wf.name] = existing; continue; }
    if (dry) { console.log(`  [dry] create  ${wf.name}`); continue; }
    const shell = await api('POST', '/workflows', {
      name: wf.name, nodes: [], connections: {}, settings: { executionOrder: 'v1' },
    });
    ids[wf.name] = shell.id;
    console.log(`  reserved ${wf.name}  (${shell.id})`);
  }

  // ---- pass 1: resolve @Name references --------------------------------
  let patched = 0;
  for (const { wf } of loaded) {
    let changed = false;
    for (const node of wf.nodes) {
      if (node.type !== 'n8n-nodes-base.executeWorkflow') continue;
      const rl = node.parameters?.workflowId;
      const raw = typeof rl === 'object' ? rl?.value : rl;
      if (typeof raw !== 'string' || !raw.startsWith('@')) continue;
      const targetName = raw.slice(1);
      const targetId = ids[targetName];
      if (!targetId) throw new Error(`${wf.name}: "${node.name}" points at unknown workflow "${targetName}"`);
      node.parameters.workflowId = { __rl: true, mode: 'id', value: targetId, cachedResultName: targetName };
      changed = true;
    }
    const ew = wf.settings?.errorWorkflow;
    if (typeof ew === 'string' && ew.startsWith('@')) {
      const targetId = ids[ew.slice(1)];
      if (!targetId) throw new Error(`${wf.name}: error workflow "${ew.slice(1)}" is not in this deployment`);
      wf.settings.errorWorkflow = targetId;
      changed = true;
    }
    if (changed) patched++;
  }
  if (dry) {
    loaded.forEach(({ wf }) => console.log(`  [dry] push    ${wf.name}  (${wf.nodes.length} nodes)`));
    return;
  }

  // ---- pass 2: push the real content -----------------------------------
  for (const { wf } of loaded) {
    await api('PUT', `/workflows/${ids[wf.name]}`, payloadOf(wf));
    console.log(`  pushed   ${wf.name}  (${ids[wf.name]})`);
  }

  // ---- pass 3: publish, callees before callers --------------------------
  // This n8n refuses to publish a workflow whose Execute Sub-workflow target
  // is still unpublished:
  //   "Cannot publish workflow: Node X references workflow Y which is not published"
  // So activation order is a real dependency order, not a nicety.
  const deps = new Map();
  for (const { wf } of loaded) {
    deps.set(
      wf.name,
      wf.nodes
        .filter((n) => n.type === 'n8n-nodes-base.executeWorkflow')
        .map((n) => n.parameters?.workflowId?.cachedResultName)
        .filter((x) => x && x !== wf.name),
    );
  }

  const activated = new Set();
  const skipped = [];
  for (let round = 0; round < loaded.length + 1 && activated.size < loaded.length; round++) {
    for (const { wf } of loaded) {
      if (activated.has(wf.name)) continue;
      if ((deps.get(wf.name) || []).some((d) => deps.has(d) && !activated.has(d))) continue;
      const res = await fetch(`${BASE}/api/v1/workflows/${ids[wf.name]}/activate`, {
        method: 'POST',
        headers: { 'X-N8N-API-KEY': KEY },
      });
      if (res.ok) {
        activated.add(wf.name);
        console.log(`  published ${wf.name}`);
      } else {
        const why = (await res.text()).slice(0, 160);
        // A workflow with no activatable trigger (manual only) is not a failure.
        if (/no trigger|cannot be activated/i.test(why)) {
          activated.add(wf.name);
          console.log(`  (no trigger to publish) ${wf.name}`);
        } else {
          skipped.push(`${wf.name}: ${why}`);
          activated.add(wf.name);
        }
      }
    }
  }
  if (skipped.length) {
    console.log('\nNot published:');
    skipped.forEach((s) => console.log('  ! ' + s));
  }

  fs.writeFileSync(IDS_FILE, JSON.stringify(ids, null, 2) + '\n');
  console.log(`\n${loaded.length} deployed, ${patched} had references resolved.`);
  console.log(`Ids written to .n8n-ids.json (git-ignored - they are instance-specific).`);
})().catch((e) => {
  console.error('\nDEPLOY FAILED:', e.message);
  process.exit(1);
});
