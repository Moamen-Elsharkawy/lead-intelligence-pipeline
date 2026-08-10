#!/usr/bin/env node
/**
 * Rewrite the results tables in the evidence documents from the JSON the test
 * runners actually produced.
 *
 *   node scripts/refresh-evidence.js
 *
 * WHY THIS EXISTS
 * A results table typed by hand is a claim about a test run. A results table
 * generated from `last-run.json` is the test run. The difference matters most
 * at exactly the moment it is easiest to get wrong: you fix something, re-run,
 * and forget to update the row that says what happened - so the document keeps
 * quoting a result from two hours and three bugs ago.
 *
 * EDGE-CASES.md keeps its hand-written "mechanism" column, because that is
 * explanation and it does not change per run. Only the evidence and the timing
 * come from the artefact. HARDENING.md is generated whole, between its markers.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

// Git normalises these files to CRLF on this machine, so every `\n` anchor
// below would miss. Normalise on the way in, write LF on the way out, and let
// git do whatever it likes with the checkout.
const readDoc = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const writeDoc = (p, s) => fs.writeFileSync(path.join(ROOT, p), s);
const esc = (s) => String(s).replace(/\|/g, '\\|');

// --- EDGE-CASES.md: refresh the evidence and seconds columns in place -------
function refreshEdgeCases() {
  const artefact = '05_Test_Evidence/last-run.json';
  if (!fs.existsSync(path.join(ROOT, artefact))) return 'skipped (no last-run.json)';
  const run = read(artefact);
  const byN = new Map(run.results.map((r) => [r.n, r]));

  const docPath = path.join(ROOT, '05_Test_Evidence/EDGE-CASES.md');
  let doc = fs.readFileSync(docPath, 'utf8');

  const pass = run.results.filter((r) => r.status === 'PASS').length;
  const soft = run.results.filter((r) => r.status === 'SOFT').length;
  const fail = run.results.filter((r) => r.status === 'FAIL').length;
  const secs = run.results.reduce((s, r) => s + r.secs, 0);

  doc = doc.replace(/^\*\*Latest run: .*$/m,
    `**Latest run: ${pass} passed, ${soft} soft, ${fail} failed.** Run id \`${run.run_id}\`, ${secs} seconds of wall clock.`);

  doc = doc.split('\n').map((line) => {
    const m = line.match(/^\| \*\*(\d+)\*\* \| (.*?) \| (.*?) \| (.*?) \| (\d+) \|$/);
    if (!m) return line;
    const r = byN.get(Number(m[1]));
    if (!r) return line;
    const mark = r.status === 'PASS' ? '' : `**${r.status}** - `;
    return `| **${m[1]}** | ${m[2]} | ${m[3]} | ${mark}${esc(r.detail)} | ${r.secs} |`;
  }).join('\n');

  fs.writeFileSync(docPath, doc);
  return `${pass}/${run.results.length} passed, ${secs}s`;
}

// --- HARDENING.md: generate the whole table between the markers ------------
const GROUPS = {
  A: 'Authentication and transport',
  B: 'Input contract',
  C: 'Business rules, end to end',
  D: 'Robustness',
  E: 'Dead letters and replay',
  F: 'Observability',
  G: 'Instance health',
};

function refreshHardening() {
  const artefact = '05_Test_Evidence/last-hardening-run.json';
  if (!fs.existsSync(path.join(ROOT, artefact))) return 'skipped (no last-hardening-run.json)';
  const run = read(artefact);

  const pass = run.results.filter((r) => r.status === 'PASS').length;
  const soft = run.results.filter((r) => r.status === 'SOFT').length;
  const fail = run.results.filter((r) => r.status === 'FAIL').length;
  const secs = run.results.reduce((s, r) => s + r.secs, 0);

  const out = [];
  let current = null;
  for (const r of run.results) {
    if (r.group !== current) {
      current = r.group;
      out.push('', `### ${current}. ${GROUPS[current] || current}`, '',
        '| # | Check | Result | s |', '|---|---|---|---|');
    }
    const mark = r.status === 'PASS' ? '' : `**${r.status}** - `;
    out.push(`| ${r.n} | ${esc(r.title)} | ${mark}${esc(r.detail)} | ${r.secs} |`);
  }

  let doc = readDoc('05_Test_Evidence/HARDENING.md');
  doc = doc.replace(/^\*\*Latest run:.*$/m, () =>
    `**Latest run: ${pass} passed, ${soft} soft, ${fail} failed** in ${secs} seconds. Raw output: [last-hardening-run.json](last-hardening-run.json).`);

  // A function replacement, not a string: the results contain `$` characters
  // (a "$50k enquiry", for one) and `$&` and friends are special on the
  // right-hand side of String.replace.
  const marker = /<!--RESULTS-->[\s\S]*?(?=\n---\n)/;
  if (!marker.test(doc)) throw new Error('the <!--RESULTS--> marker is missing from HARDENING.md');
  const body = `<!--RESULTS-->\n${out.join('\n')}\n`;
  doc = doc.replace(marker, () => body);

  writeDoc('05_Test_Evidence/HARDENING.md', doc);
  return `${pass}/${run.results.length} passed, ${secs}s`;
}

console.log('EDGE-CASES.md  ', refreshEdgeCases());
console.log('HARDENING.md   ', refreshHardening());
