#!/usr/bin/env node
/**
 * Build the n8n workflow JSON from the specs in 02_Workflows/_src/.
 *
 * Why a builder instead of hand-written JSON:
 *
 *  1. The Code nodes run the SAME source that `node scripts/test-scoring.js`
 *     tests. The shared runtime is concatenated in at build time, so there is
 *     no hand-copied logic to drift out of sync with the tests.
 *  2. Node ids, canvas positions and the connection graph are generated, so
 *     they cannot be inconsistent with each other.
 *  3. Re-running the build is the diff. Reviewing a change means reading a
 *     20-line spec edit, not a 900-line JSON blob.
 *
 * Run: node scripts/build-workflows.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, '02_Workflows', '_src');
const SHARED = path.join(ROOT, '02_Workflows', '_shared');
const OUT = path.join(ROOT, '02_Workflows');

// --- the runtime preamble --------------------------------------------------
// constants.js defines `C`; the other modules re-require it, which is redundant
// once they all live in one scope, so that single line is stripped from each.
//
// Inside a Code node the three namespaces are `C` (constants), `S` (scoring)
// and `I` (intake), exactly as they are in the test runners - so a snippet
// pasted from a node into a test, or the reverse, behaves identically.
function buildPrelude() {
  const strip = (f) => fs
    .readFileSync(path.join(SHARED, f), 'utf8')
    .replace(/^const C = require\(['"]\.\/constants\.js['"]\);\s*$/m, '');
  return [
    '// ===== BEGIN shared runtime, generated from 02_Workflows/_shared/ =====',
    '// Do not edit here. Edit the source files and re-run scripts/build-workflows.js.',
    '// The same source is unit-tested by scripts/test-scoring.js and test-intake.js.',
    fs.readFileSync(path.join(SHARED, 'constants.js'), 'utf8'),
    strip('scorer.js'),
    strip('intake.js'),
    '// ===== END shared runtime =====',
    '',
  ].join('\n');
}

// --- node type shorthands --------------------------------------------------
// Versions are taken from workflows already deployed on this instance, not
// guessed. Guessed typeVersions have silently broken imports here before
// (switch was 3.4 not 3.3; chainLlm 1.9 not 1.7), so anything not confirmed
// by a live export is confirmed by validate_workflow before it ships.
const TYPES = {
  code: ['n8n-nodes-base.code', 2],
  set: ['n8n-nodes-base.set', 3.4],
  if: ['n8n-nodes-base.if', 2.2],
  switch: ['n8n-nodes-base.switch', 3.4],
  http: ['n8n-nodes-base.httpRequest', 4.4],
  webhook: ['n8n-nodes-base.webhook', 2.1],
  respond: ['n8n-nodes-base.respondToWebhook', 1.5],
  dataTable: ['n8n-nodes-base.dataTable', 1.1],
  executeWorkflow: ['n8n-nodes-base.executeWorkflow', 1.2],
  executeWorkflowTrigger: ['n8n-nodes-base.executeWorkflowTrigger', 1.1],
  schedule: ['n8n-nodes-base.scheduleTrigger', 1.2],
  manual: ['n8n-nodes-base.manualTrigger', 1],
  errorTrigger: ['n8n-nodes-base.errorTrigger', 1],
  form: ['n8n-nodes-base.form', 2.5],
  formTrigger: ['n8n-nodes-base.formTrigger', 2.2],
  gmail: ['n8n-nodes-base.gmail', 2.2],
  merge: ['n8n-nodes-base.merge', 3],
  splitOut: ['n8n-nodes-base.splitOut', 1],
  wait: ['n8n-nodes-base.wait', 1.1],
  noOp: ['n8n-nodes-base.noOp', 1],
  stopAndError: ['n8n-nodes-base.stopAndError', 1],
  sticky: ['n8n-nodes-base.stickyNote', 1],
  extractFromFile: ['n8n-nodes-base.extractFromFile', 1],
  filter: ['n8n-nodes-base.filter', 2.2],
  sort: ['n8n-nodes-base.sort', 1],
  limit: ['n8n-nodes-base.limit', 1],
  aggregate: ['n8n-nodes-base.aggregate', 1],
};

/** Deterministic uuid-shaped id, so rebuilding produces byte-identical JSON. */
function nodeId(workflowSlug, name) {
  let h = 0x811c9dc5;
  for (const ch of `${workflowSlug}:${name}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const hex = (n) => (h = Math.imul(h ^ (h >>> 15), 0x2545f491) >>> 0).toString(16).padStart(8, '0').slice(0, n);
  return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(8)}${hex(4)}`;
}

/**
 * Layout: depth from the trigger drives x, siblings at the same depth stack
 * on y. Good enough to read, and never overlapping.
 */
function layout(nodes, flow) {
  const depth = new Map();
  const children = new Map();
  const indeg = new Map();
  nodes.forEach((n) => {
    children.set(n.n, []);
    indeg.set(n.n, 0);
  });
  flow.forEach(([from, to]) => {
    if (!children.has(from) || !indeg.has(to)) throw new Error(`flow references unknown node: ${from} -> ${to}`);
    children.get(from).push(to);
    indeg.set(to, indeg.get(to) + 1);
  });
  const queue = nodes.filter((n) => indeg.get(n.n) === 0).map((n) => n.n);
  queue.forEach((n) => depth.set(n, 0));
  while (queue.length) {
    const cur = queue.shift();
    for (const kid of children.get(cur)) {
      const d = Math.max(depth.get(kid) ?? 0, depth.get(cur) + 1);
      depth.set(kid, d);
      indeg.set(kid, indeg.get(kid) - 1);
      if (indeg.get(kid) === 0) queue.push(kid);
    }
  }
  const perDepth = new Map();
  const pos = {};
  nodes.forEach((n) => {
    if (n.t === 'sticky') return;
    const d = depth.get(n.n) ?? 0;
    const row = perDepth.get(d) ?? 0;
    perDepth.set(d, row + 1);
    pos[n.n] = [-900 + d * 240, -200 + row * 190];
  });
  return pos;
}

function buildWorkflow(spec, prelude) {
  const slug = spec.file;
  const flow = spec.flow || [];
  const pos = layout(spec.nodes, flow);
  let stickyIdx = 0;

  const nodes = spec.nodes.map((n) => {
    const [type, defaultVersion] = TYPES[n.t] || [];
    if (!type) throw new Error(`${slug}: unknown node shorthand "${n.t}" on "${n.n}"`);

    const params = { ...(n.p || {}) };
    if (n.code !== undefined) {
      params.mode = n.mode || 'runOnceForAllItems';
      params.jsCode = (n.usesRuntime === false ? '' : prelude) + n.code.trim() + '\n';
    }
    if (n.t === 'sticky') {
      params.content = n.content;
      params.width = n.w || 460;
      params.height = n.h || 240;
    }

    const out = {
      id: nodeId(slug, n.n),
      name: n.n,
      type,
      typeVersion: n.v || defaultVersion,
      position: n.t === 'sticky' ? [n.at?.[0] ?? -900, n.at?.[1] ?? -560 - stickyIdx++ * 10] : pos[n.n],
      parameters: params,
    };
    if (n.creds) out.credentials = n.creds;
    if (n.retry) {
      out.retryOnFail = true;
      out.maxTries = n.retry.tries ?? 3;
      out.waitBetweenTries = n.retry.waitMs ?? 2000;
    }
    if (n.onError) out.onError = n.onError;
    if (n.alwaysOutputData) out.alwaysOutputData = true;
    if (n.executeOnce) out.executeOnce = true;
    if (n.notes) out.notes = n.notes;
    if (n.webhookId) out.webhookId = n.webhookId;
    return out;
  });

  const connections = {};
  for (const [from, to, outIdx = 0] of flow) {
    connections[from] = connections[from] || { main: [] };
    while (connections[from].main.length <= outIdx) connections[from].main.push([]);
    connections[from].main[outIdx].push({ node: to, type: 'main', index: 0 });
  }

  return {
    name: spec.name,
    nodes,
    connections,
    settings: {
      executionOrder: 'v1',
      timezone: 'Africa/Cairo',
      saveDataErrorExecution: 'all',
      saveDataSuccessExecution: 'all',
      saveManualExecutions: true,
      callerPolicy: 'workflowsFromSameOwner',
      ...(spec.settings || {}),
    },
  };
}

// --- main ------------------------------------------------------------------
const prelude = buildPrelude();
const specs = fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).sort();
if (!specs.length) {
  console.error('No specs found in 02_Workflows/_src/');
  process.exit(1);
}

// Node-code bodies are written as template literals in the specs, so a stray
// backtick inside one - almost always in a comment quoting `a field name` -
// closes the literal early and the whole spec fails to parse. Node reports it
// as "Unexpected identifier" pointing at a comment, which reads like nonsense.
// This turns three minutes of confusion into one line naming the file and the
// text. It cost that three minutes twice before it was worth writing.
for (const file of specs) {
  const raw = fs.readFileSync(path.join(SRC, file), 'utf8');
  for (const [i, line] of raw.split('\n').entries()) {
    // An escaped backtick is fine; only a bare one closes the literal.
    if (/^\s*\/\//.test(line) && /`/.test(line.replace(/\\`/g, ''))) {
      console.error(
        `${file}:${i + 1} has a backtick inside a comment:\n    ${line.trim()}\n` +
        `  Node code lives in a template literal, so this closes it early. ` +
        `Rephrase without the backtick, or escape it.`,
      );
      process.exit(1);
    }
  }
}

let nodeTotal = 0;
const manifest = [];
for (const file of specs) {
  const spec = require(path.join(SRC, file));
  spec.file = spec.file || file.replace(/\.js$/, '');
  const wf = buildWorkflow(spec, prelude);
  const outPath = path.join(OUT, `${spec.file}.json`);
  fs.writeFileSync(outPath, JSON.stringify(wf, null, 2) + '\n');
  const real = wf.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote').length;
  nodeTotal += real;
  manifest.push({ file: `${spec.file}.json`, name: wf.name, nodes: real, purpose: spec.purpose || '' });
  console.log(`  ${spec.file}.json  ${String(real).padStart(3)} nodes  ${wf.name}`);
}

fs.writeFileSync(
  path.join(OUT, 'manifest.json'),
  JSON.stringify({ generated_by: 'scripts/build-workflows.js', workflows: manifest, total_nodes: nodeTotal }, null, 2) + '\n',
);
console.log(`\n${specs.length} workflows, ${nodeTotal} nodes. manifest.json written.`);
