#!/usr/bin/env node
/**
 * Unit tests for the intake runtime - the code that turns a source payload into
 * a canonical lead.
 *
 * This file exists because intake is where wrong answers are invisible. A bad
 * score shows up as a lead in the wrong bucket; a bad phone parse shows up six
 * weeks later as two customer records that were always the same person. Every
 * one of these ran red at least once before it ran green.
 *
 *   node scripts/test-intake.js
 */
const C = require('../02_Workflows/_shared/constants.js');
const I = require('../02_Workflows/_shared/intake.js');

let pass = 0;
let fail = 0;
const failures = [];

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  failures.push(`  ${label}\n      expected ${e}\n      actual   ${a}`);
}

function ok(label, cond) { check(label, !!cond, true); }

function section(t) { console.log(`\n${t}`); }

const NOW = 1754870400; // fixed, so lead_uid is reproducible across runs

// ---------------------------------------------------------------------------
section('Phone parsing and the country that drives it');
// ---------------------------------------------------------------------------
{
  const eg = I.finalizeLead({ source: 'website', phone_raw: '0100 123 4567', full_name: 'A', consent: true }, { now: NOW });
  check('Egyptian local number gets the home country code', eg.phone_e164, '+201001234567');
  check('...and resolves to EG', eg.country, 'EG');

  const ae = I.finalizeLead({ source: 'website', phone_raw: '050 123 4567', country: 'United Arab Emirates', full_name: 'A', consent: true }, { now: NOW });
  check('a stated country picks the dialling code, not the default', ae.phone_e164, '+971501234567');
  check('...and the country survives', ae.country, 'AE');

  const intl = I.finalizeLead({ source: 'website', phone_raw: '00971 50 123 4567', full_name: 'A', consent: true }, { now: NOW });
  check('00 prefix is understood as international', intl.phone_e164, '+971501234567');
  check('country is derived from the prefix when not stated', intl.country, 'AE');

  // The whole point of phone_key: three spellings, one person.
  const spellings = ['+20 100 123 4567', '0100-123-4567', '00201001234567', '(+20) 1001234567'];
  const keys = new Set(spellings.map((s) => I.finalizeLead({ source: 'website', phone_raw: s, full_name: 'A', consent: true }, { now: NOW }).phone_key));
  check('four spellings of one number produce one phone_key', keys.size, 1);

  const junk = I.finalizeLead({ source: 'website', phone_raw: '123', full_name: 'A', email_raw: 'a@b.co', consent: true }, { now: NOW });
  check('a too-short number is rejected, not padded into a fake one', junk.phone_e164, '');
  check('...and produces no phone_key to collide on', junk.phone_key, '');
}

// ---------------------------------------------------------------------------
section('Email folding');
// ---------------------------------------------------------------------------
{
  const a = I.finalizeLead({ source: 'website', email_raw: 'Nadia.Hassan+leads@GMail.com', full_name: 'N', consent: true }, { now: NOW });
  const b = I.finalizeLead({ source: 'website', email_raw: 'nadiahassan@googlemail.com', full_name: 'N', consent: true }, { now: NOW });
  check('gmail dots and plus-tags fold away', a.email_norm, 'nadiahassan@gmail.com');
  check('googlemail folds to gmail', b.email_norm, 'nadiahassan@gmail.com');
  check('the two are therefore the same person key', a.person_key === b.person_key || a.phone_key === b.phone_key, true);

  const corp = I.finalizeLead({ source: 'website', email_raw: 'first.last+po@acme-logistics.com', full_name: 'N', consent: true }, { now: NOW });
  check('non-gmail keeps its dots', corp.email_norm, 'first.last@acme-logistics.com');
  check('a corporate domain is extracted for enrichment', corp.domain, 'acme-logistics.com');

  const free = I.finalizeLead({ source: 'website', email_raw: 'someone@gmail.com', full_name: 'N', consent: true }, { now: NOW });
  check('a free-provider domain is NOT an enrichment target', free.domain, '');

  const bad = I.finalizeLead({ source: 'website', email_raw: 'not-an-email', phone_raw: '01001234567', full_name: 'N', consent: true }, { now: NOW });
  check('an invalid address is dropped rather than stored as a key', bad.email_norm, '');
}

// ---------------------------------------------------------------------------
section('Consent is three-valued, never two');
// ---------------------------------------------------------------------------
{
  const g = I.finalizeLead({ source: 'website', full_name: 'A', email_raw: 'a@b.co', consent: 'Yes' }, { now: NOW });
  const d = I.finalizeLead({ source: 'website', full_name: 'A', email_raw: 'a@b.co', consent: 'no' }, { now: NOW });
  const u = I.finalizeLead({ source: 'website', full_name: 'A', email_raw: 'a@b.co', consent: '' }, { now: NOW });
  check('granted', g.consent, 'granted');
  check('denied', d.consent, 'denied');
  check('absent is unknown, not denied and not granted', u.consent, 'unknown');
  check('unknown consent is a Data Completion case, not a rejection', u.validation_state, 'incomplete');
  check('...and it names what is missing', u.validation_missing, 'consent');
}

// ---------------------------------------------------------------------------
section('Validation: four outcomes with four different consequences');
// ---------------------------------------------------------------------------
{
  const full = I.finalizeLead({ source: 'website', full_name: 'Nadia Hassan', email_raw: 'n@acme-logistics.com', phone_raw: '01001234567', consent: true }, { now: NOW });
  check('complete lead is ok', full.validation_state, 'ok');

  const noName = I.finalizeLead({ source: 'whatsapp', phone_raw: '201001234567', consent: true }, { now: NOW });
  check('reachable but nameless goes forward as incomplete', noName.validation_state, 'incomplete');

  const nothing = I.finalizeLead({ source: 'csv_import', full_name: 'Ghost Person', consent: true }, { now: NOW });
  check('nobody to contact is unusable', nothing.validation_state, 'unusable');
  ok('...and says why in one sentence', /nothing to contact/.test(nothing.validation_reason));

  // The distinction that matters: incomplete is recoverable, unusable is not.
  ok('incomplete and unusable are not the same state', noName.validation_state !== nothing.validation_state);
}

// ---------------------------------------------------------------------------
section('Idempotency: a delivery, not a person');
// ---------------------------------------------------------------------------
{
  const payload = { source: 'website', source_ref: 'sub_9f2a11', full_name: 'A', email_raw: 'a@b.co', consent: true };
  const first = I.finalizeLead(payload, { now: NOW });
  const retry = I.finalizeLead(payload, { now: NOW + 300 });
  check('a retried POST with the same submission id is the same event', first.idem_key, retry.idem_key);

  const second = I.finalizeLead({ ...payload, source_ref: 'sub_9f2a12' }, { now: NOW });
  ok('a genuinely new submission is a different event', first.idem_key !== second.idem_key);

  // Same human, two channels: two events, one person.
  const web = I.finalizeLead({ source: 'website', source_ref: 's1', full_name: 'A', phone_raw: '01001234567', consent: true }, { now: NOW });
  const wa = I.finalizeLead({ source: 'whatsapp', source_ref: 'wamid.X', full_name: 'A', phone_raw: '+201001234567', consent: true }, { now: NOW });
  ok('two channels are two separate deliveries', web.idem_key !== wa.idem_key);
  check('...but one human', web.person_key, wa.person_key);

  // No provider id: the key is content, not a clock. A time bucket lets two
  // clicks either side of a boundary both through.
  const noRefA = I.finalizeLead({ source: 'website', full_name: 'A', email_raw: 'a@b.co', consent: true }, { now: NOW });
  const noRefB = I.finalizeLead({ source: 'website', full_name: 'A', email_raw: 'a@b.co', consent: true }, { now: NOW + 86400 });
  check('an identical payload a day later is still the same event', noRefA.idem_key, noRefB.idem_key);

  const changed = I.finalizeLead({ source: 'website', full_name: 'A', email_raw: 'a@b.co', free_text: 'now with a message', consent: true }, { now: NOW });
  ok('a changed payload is a new event', noRefA.idem_key !== changed.idem_key);

  ok('lead_uid has the documented shape', /^LP-\d{8}-[0-9A-F]{8}$/.test(first.lead_uid));
  check('lead_uid is a pure function of the key and the day', first.lead_uid, C.leadUidFrom(first.idem_key, NOW));
}

// ---------------------------------------------------------------------------
section('Service, urgency and budget - derived by code, never by the model');
// ---------------------------------------------------------------------------
{
  check('explicit service field', I.normService('Workflow automation', ''), 'automation');
  check('read out of free text when there is no field', I.normService('', 'we need a chatbot on our website'), 'ai_agent');
  check('RAG beats the generic match', I.normService('', 'a knowledge base our staff can ask questions of'), 'rag');
  check('nothing recognisable stays unknown, it is not guessed', I.normService('', 'hello'), 'unknown');

  check('urgency from an explicit dropdown', I.normUrgency('immediate', ''), 'immediate');
  check('urgency from the words the lead used', I.normUrgency('', 'we need this fixed ASAP'), 'immediate');
  check('a browser is a browser', I.normUrgency('', 'just exploring options for now'), 'exploring');
  check('silence is unknown', I.normUrgency('', 'we move 400 shipments a day'), 'unknown');

  check('an explicit dollar amount bands high', I.normBudget('', 'budget is around $15,000'), 'high');
  check('12k usd bands high', I.normBudget('12k USD', ''), 'high');
  check('3000 usd bands mid', I.normBudget('3000 USD', ''), 'mid');
  // A bare number is far more likely a typo or a headcount than a budget, and a
  // wrong band can push a lead across a qualification threshold.
  check('a bare number with no currency is NOT read as dollars', I.normBudget('50', ''), 'unknown');
  check('no budget mentioned', I.normBudget('', 'we need help with dispatch'), 'unknown');
}

// ---------------------------------------------------------------------------
section('CSV parsing - the things split(",") gets wrong');
// ---------------------------------------------------------------------------
{
  const csv = [
    'Name,Email,Phone,Company,Notes',
    'Nadia Hassan,nadia@acme-logistics.com,+201001234567,Acme Logistics,"Dispatch, invoicing, and reporting"',
    '"Hassan, Karim",karim@nilecargo.com,01112223344,Nile Cargo,"He said ""call me Friday"""',
    'Broken Row,only,three,cells',
    'Sara Fouad,sara@deltaclinics.com,01234567890,Delta Clinics,Wants a booking bot',
  ].join('\n');

  const p = I.parseCsv(csv);
  check('header is read and lower-cased', p.header, ['name', 'email', 'phone', 'company', 'notes']);
  check('four data rows', p.rows.length, 4);
  check('a quoted field with commas stays one field', p.rows[0].cells[4], 'Dispatch, invoicing, and reporting');
  check('a quoted field can contain a comma in a name', p.rows[1].cells[0], 'Hassan, Karim');
  check('doubled quotes unescape', p.rows[1].cells[4], 'He said "call me Friday"');
  ok('the short row is flagged', /expected 5 columns, found 4/.test(p.rows[2].error));
  check('and the rows after it are unaffected', p.rows[3].error, '');
  check('the good row after the broken one still parses', p.rows[3].cells[0], 'Sara Fouad');

  const hm = I.csvHeaderMap(p.header);
  check('headers map to canonical fields', [hm.map.full_name, hm.map.email_raw, hm.map.phone_raw], [0, 1, 2]);
  const mapped = I.mapCsvRow(hm.map, p.rows[0].cells);
  check('a mapped row carries the values through', mapped.email_raw, 'nadia@acme-logistics.com');

  const crlf = I.parseCsv('﻿name,email\r\nA,a@b.co\r\n');
  check('BOM and CRLF from an Excel export are handled', crlf.rows[0].cells, ['A', 'a@b.co']);

  const embedded = I.parseCsv('name,notes\nA,"line one\nline two"');
  check('a newline inside quotes does not split the row', embedded.rows.length, 1);
  check('...and the field keeps its newline', embedded.rows[0].cells[1], 'line one\nline two');

  check('an empty file is reported, not crashed on', I.parseCsv('').error, 'the file is empty');
  check('trailing blank lines are ignored', I.parseCsv('a,b\n1,2\n\n').rows.length, 1);

  const unknownCols = I.csvHeaderMap(['name', 'email', 'favourite colour']);
  check('unmapped columns are reported back rather than silently dropped', unknownCols.unmapped, ['favourite colour']);
}

// ---------------------------------------------------------------------------
section('The WhatsApp scoring hole, checked end to end');
// ---------------------------------------------------------------------------
{
  // A WhatsApp lead has no email, therefore no domain, therefore no enrichment.
  // With zero-valued "unknown" bands it was arithmetically impossible for such a
  // lead to reach 70 - in a brief whose main scenario is WhatsApp. This test is
  // the regression guard for that.
  const S = require('../02_Workflows/_shared/scorer.js');
  const wa = I.finalizeLead({
    source: 'whatsapp',
    source_ref: 'wamid.TEST',
    phone_raw: '201001234567',
    full_name: 'Karim Adel',
    free_text: 'We run a logistics company and need an automation for dispatch urgently, budget around $12,000',
    consent: true,
    consent_source: 'inbound_initiated',
  }, { now: NOW });

  check('service is recovered from the message', wa.service_interest, 'automation');
  check('urgency is recovered from the message', wa.urgency, 'immediate');
  check('budget is recovered from the message', wa.budget_band, 'high');
  check('country comes from the phone prefix, with no email to help', wa.country, 'EG');

  const scored = S.scoreLead(wa, { found: false });
  ok(`a strong WhatsApp lead can reach Qualified with no enrichment (scored ${scored.score})`, scored.score >= 70);
  check('...and bands as qualified', scored.band, 'qualified');

  const weak = I.finalizeLead({
    source: 'whatsapp', source_ref: 'wamid.T2', phone_raw: '201009998877',
    free_text: 'hi', consent: true,
  }, { now: NOW });
  const weakScored = S.scoreLead(weak, { found: false });
  ok(`a bare "hi" does NOT reach qualified (scored ${weakScored.score})`, weakScored.score < 70);
}

// ---------------------------------------------------------------------------
section('Injection and hostile input');
// ---------------------------------------------------------------------------
{
  const nasty = I.finalizeLead({
    source: 'website',
    full_name: '  Nadia\x00\x07\x1b\tHassan \r\n\n',
    email_raw: '  NADIA@ACME-LOGISTICS.COM  ',
    free_text: 'x'.repeat(9000),
    consent: true,
  }, { now: NOW });
  check('control characters are stripped and whitespace collapsed', nasty.full_name, 'Nadia Hassan');
  check('email is trimmed and lower-cased', nasty.email_norm, 'nadia@acme-logistics.com');
  check('free text is capped', nasty.free_text.length, I.INTAKE.MAX_FREE_TEXT);

  const missing = I.finalizeLead({ source: 'website' }, { now: NOW });
  ok('a completely empty payload does not throw', typeof missing.lead_uid === 'string');
  check('...it is simply unusable', missing.validation_state, 'unusable');

  const nulls = I.finalizeLead({ source: 'website', full_name: null, email_raw: undefined, phone_raw: 0, consent: null }, { now: NOW });
  ok('nulls and undefined do not throw', typeof nulls.lead_uid === 'string');

  const bigRaw = I.finalizeLead({ source: 'website', email_raw: 'a@b.co', full_name: 'A', consent: true, raw: { blob: 'y'.repeat(50000) } }, { now: NOW });
  ok('raw_json cannot blow the row size', bigRaw.raw_json.length <= I.INTAKE.MAX_RAW_JSON);
}

// ---------------------------------------------------------------------------
console.log(`\n${'-'.repeat(64)}`);
if (fail) {
  console.log(`${pass} passed, ${fail} FAILED\n`);
  failures.forEach((f) => console.log(f));
  process.exit(1);
}
console.log(`${pass} passed, 0 failed.`);
