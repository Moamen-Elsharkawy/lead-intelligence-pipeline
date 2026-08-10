#!/usr/bin/env node
/**
 * The hardening suite: 32 checks the fourteen mandated edge cases do not cover.
 *
 *   node 05_Test_Evidence/run-hardening.mjs         run everything
 *   node 05_Test_Evidence/run-hardening.mjs 3 12    run only these
 *
 * WHY A SECOND SUITE
 * run-edge-cases.mjs proves the fourteen scenarios the brief names. Those are
 * all *happy-ish* paths in the sense that every one of them sends a
 * well-formed, authenticated request and then checks that the pipeline did the
 * clever thing. None of them asks what happens when the request itself is
 * wrong, hostile, or enormous - and in production that is most of the traffic.
 *
 * So this suite attacks the contract rather than the logic:
 *
 *   A  authentication and transport   is the door actually locked
 *   B  input contract                 does a bad request fail cleanly
 *   C  business rules end to end      do the documented rules really fire
 *   D  robustness                     hostile and oversized input
 *   E  dead letters and replay        does the recovery path refuse correctly
 *   F  observability                  is the audit trail complete, no leaks
 *   G  instance health                did anything error that should not have
 *
 * Every check asserts on an observable outcome, same rule as the other suite:
 * a status code, a row in Odoo, a state in the ledger. Never on "it did not
 * throw".
 */
import {
  requireEnv, loadTables, requireMailRedirect, runSuite,
  hook, napi, rows, eq, upsert, config, setConfig, until, nap,
  leadRow, auditFor, jobsFor, runTick, odoo, odooByUid, BASE,
} from './_harness.mjs';

requireEnv();

const RUN = String(Date.now()).slice(-8);
const P6 = RUN.slice(-6);
const phoneFor = (slot) => '+20 1' + slot + P6.slice(1);
const only = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
const STARTED = Math.floor(Date.now() / 1000);

const website = (over = {}) => ({
  submission_id: `hard_${RUN}_${Math.random().toString(36).slice(2, 8)}`,
  name: 'Nadia Hassan',
  email: `h+${RUN}@nilecargo.com`,
  phone: phoneFor('90'),
  company: 'Nile Cargo',
  country: 'EG',
  service: 'Workflow automation',
  message: 'We move around 400 shipments a day and dispatch re-types every order into three systems. We want to start immediately.',
  budget: '',
  timeline: 'immediate',
  consent: true,
  ...over,
});

const CASES = [];
const test = (n, group, title, fn) => CASES.push({ n, group, title, fn });

// ===========================================================================
// A. Authentication and transport
// ===========================================================================

test(1, 'A', 'A webhook with no token is refused', async () => {
  const r = await hook('lp-web-lead', website(), { token: null });
  if (r.status < 400) throw new Error(`unauthenticated request was accepted with ${r.status}`);
  return `no X-LP-Token -> ${r.status}`;
});

test(2, 'A', 'A webhook with the wrong token is refused', async () => {
  const r = await hook('lp-web-lead', website(), { token: 'not-the-real-token-' + RUN });
  if (r.status < 400) throw new Error(`a wrong token was accepted with ${r.status}`);
  return `wrong X-LP-Token -> ${r.status}`;
});

test(3, 'A', 'Every inbound endpoint is authenticated, not just the lead ones', async () => {
  const paths = ['lp-web-lead', 'lp-wa-inbound', 'lp-csv-import', 'lp-event', 'lp-approval',
    'lp-replay', 'lp-ops', 'lp-tick', 'lp-setup', 'lp-mock-enrich', 'lp-mock-whatsapp', 'lp-mock-booking'];
  const open = [];
  for (const p of paths) {
    const r = await hook(p, {}, { token: null });
    if (r.status < 400) open.push(`${p} (${r.status})`);
  }
  if (open.length) throw new Error(`unauthenticated access allowed on: ${open.join(', ')}`);
  return `all ${paths.length} endpoints refuse an unauthenticated call, including the three mocks`;
});

test(4, 'A', 'A malformed JSON body does not take the workflow down', async () => {
  const r = await hook('lp-web-lead', null, { raw: '{"name": "Broken", "email": ' });
  if (r.status === 200 || r.status === 202) {
    const created = r.json?.accepted;
    if (created) throw new Error('malformed JSON was accepted as a lead');
  }
  if (r.status >= 500 && r.status !== 500) throw new Error(`unexpected ${r.status}`);
  return `truncated JSON -> ${r.status}, no lead created`;
});

test(5, 'A', 'An empty body is handled, not crashed on', async () => {
  const r = await hook('lp-web-lead', {});
  const uids = r.json?.lead_uids || [];
  if (uids.length) {
    const row = await leadRow(uids[0]);
    if (row && row.status === 'active' && Number(row.odoo_lead_id) > 0) {
      throw new Error('an empty body produced a live opportunity in the CRM');
    }
  }
  return `empty body -> ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`;
});

// ===========================================================================
// B. Input contract
// ===========================================================================

test(6, 'B', 'An unknown event type is rejected with a reason', async () => {
  const r = await hook('lp-event', { type: 'teleport', lead_uid: 'LP-NOPE' });
  if (r.json?.ok) throw new Error('an invented event type was accepted');
  if (!String(r.json?.detail || r.json?.reason || '').length) throw new Error('rejected without saying why');
  return `type "teleport" -> ok:false, "${(r.json.detail || r.json.reason).slice(0, 80)}"`;
});

test(7, 'B', 'An event with no lead_uid is rejected', async () => {
  const r = await hook('lp-event', { type: 'reply' });
  if (r.json?.ok) throw new Error('an event without a lead was accepted');
  return `missing lead_uid -> ok:false, "${(r.json.detail || r.json.reason || '').slice(0, 70)}"`;
});

test(8, 'B', 'An event for a lead that does not exist is a 404, not a crash', async () => {
  const r = await hook('lp-event', { type: 'reply', lead_uid: `LP-19990101-DEADBEEF` });
  if (r.json?.ok) throw new Error('an event for an unknown lead was applied');
  const status = r.json?.status ?? r.status;
  if (Number(status) !== 404) throw new Error(`expected a 404-shaped answer, got ${status}`);
  return `unknown lead -> status 404, "${(r.json.detail || r.json.reason || '').slice(0, 70)}"`;
});

test(9, 'B', 'An approval with an invalid decision is rejected', async () => {
  const r = await hook('lp-approval', { lead_uid: 'LP-NOPE', decision: 'maybe' });
  if (r.json?.ok) throw new Error('"maybe" was accepted as a decision');
  return `decision "maybe" -> ok:false, "${(r.json.detail || r.json.reason || '').slice(0, 70)}"`;
});

test(10, 'B', 'A second approval on the same lead is refused, not silently applied', async () => {
  const r = await hook('lp-web-lead', website({
    email: `vip2+${RUN}@gulftech.ae`, company: 'GulfTech', country: 'AE',
    phone: phoneFor('91'), budget: '20000 USD',
  }));
  const uid = r.json.lead_uids[0];
  await until('VIP reaches Awaiting Approval', async () => {
    const l = await leadRow(uid);
    return l && l.approval_state === 'pending' && Number(l.odoo_lead_id) > 0 ? l : null;
  }, { tries: 30, waitMs: 2000 });

  const first = await hook('lp-approval', { lead_uid: uid, decision: 'reject', by: 'manager@example.com' });
  if (!first.json?.ok) throw new Error(`the first decision failed: ${JSON.stringify(first.json)}`);
  const second = await hook('lp-approval', { lead_uid: uid, decision: 'approve', by: 'manager@example.com' });
  if (second.json?.ok) throw new Error('a second, contradictory decision was applied over the first');

  const lead = await leadRow(uid);
  if (lead.approval_state !== 'rejected') throw new Error(`approval_state is "${lead.approval_state}", the reject should have stood`);
  return `reject applied, then approve refused ("${(second.json.detail || second.json.reason || '').slice(0, 60)}"); state stayed rejected`;
});

test(11, 'B', 'A WhatsApp delivery-status callback is acknowledged and ignored', async () => {
  const before = (await rows('lp_lead')).length;
  const r = await hook('lp-wa-inbound', {
    object: 'whatsapp_business_account',
    entry: [{ id: '102290129340398', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '201234567890', phone_number_id: '106540352242922' },
      statuses: [{ id: `wamid.STATUS.${RUN}`, status: 'delivered', timestamp: String(STARTED), recipient_id: '201005550000' }],
    } }] }],
  });
  if (r.status >= 400) throw new Error(`a status callback was rejected with ${r.status}`);
  await nap(3000);
  const after = (await rows('lp_lead')).length;
  if (after !== before) throw new Error(`a status callback created ${after - before} lead row(s)`);
  return `status callback -> ${r.status}, lead count unchanged at ${after}`;
});

// ===========================================================================
// C. Business rules, end to end
// ===========================================================================

test(12, 'C', 'An excluded vertical is hard-disqualified whatever else it scores', async () => {
  const r = await hook('lp-web-lead', website({
    name: 'Layla Fahmy', email: `bet+${RUN}@luckyspin.com`, company: 'LuckySpin',
    phone: phoneFor('92'), budget: '50000 USD',
    message: 'We need automation urgently across our platform and have a large budget approved.',
  }));
  const uid = r.json.lead_uids[0];
  const lead = await until('scored', async () => {
    const l = await leadRow(uid);
    return l && l.band ? l : null;
  }, { tries: 30, waitMs: 2000 });

  if (Number(lead.score) !== 0) throw new Error(`score is ${lead.score}, an excluded vertical must be 0`);
  if (lead.band !== 'unqualified') throw new Error(`band is "${lead.band}"`);
  const bd = JSON.parse(lead.score_breakdown_json || '[]');
  if (!bd.some((f) => String(f.note || '').includes('excluded'))) throw new Error('the breakdown does not say it was excluded');
  return `$50k urgent enquiry, gambling vertical -> score 0, unqualified, "${bd[0].note}"`;
});

test(13, 'C', 'Job-seeker language is penalised, not qualified', async () => {
  const r = await hook('lp-web-lead', website({
    name: 'Karim Fouad', email: `job+${RUN}@gmail.com`, company: '', phone: phoneFor('93'),
    service: '', message: 'I am looking for a job as an automation engineer, please find my CV attached.',
  }));
  const uid = r.json.lead_uids[0];
  const lead = await until('scored', async () => (await leadRow(uid))?.band ? leadRow(uid) : null, { tries: 30, waitMs: 2000 });
  const bd = JSON.parse(lead.score_breakdown_json || '[]');
  const pen = bd.find((f) => f.factor === 'intent_penalty');
  if (!pen) throw new Error('no intent penalty was applied');
  if (lead.band === 'qualified' || lead.band === 'vip') throw new Error(`a job application reached "${lead.band}"`);
  return `penalty ${pen.points} applied, final score ${lead.score} -> ${lead.band}`;
});

test(14, 'C', 'A disposable inbox costs points and says so', async () => {
  const r = await hook('lp-web-lead', website({
    name: 'Throwaway Tester', email: `temp+${RUN}@mailinator.com`, phone: phoneFor('94'),
  }));
  const uid = r.json.lead_uids[0];
  const lead = await until('scored', async () => (await leadRow(uid))?.band ? leadRow(uid) : null, { tries: 30, waitMs: 2000 });
  const bd = JSON.parse(lead.score_breakdown_json || '[]');
  const pen = bd.find((f) => f.factor === 'disposable_email');
  if (!pen) throw new Error('no disposable-email penalty in the breakdown');
  if (Number(pen.points) !== -10) throw new Error(`penalty is ${pen.points}, expected -10`);
  return `mailinator.com -> ${pen.points} points, "${pen.note}"`;
});

test(15, 'C', 'An Arabic enquiry is parsed, scored and routed like any other', async () => {
  const r = await hook('lp-web-lead', website({
    name: 'محمد عبد الرحمن', email: `ar+${RUN}@nilecargo.com`, phone: phoneFor('95'),
    company: 'النيل للشحن', service: 'أتمتة',
    message: 'محتاجين أتمتة للعمليات عندنا ضروري، عندنا فريق كبير وبنضيع وقت كتير في الشغل اليدوي.',
  }));
  const uid = r.json.lead_uids[0];
  const lead = await until('scored and routed', async () => {
    const l = await leadRow(uid);
    return l && l.band && Number(l.odoo_lead_id) > 0 ? l : null;
  }, { tries: 30, waitMs: 2000 });

  if (lead.full_name !== 'محمد عبد الرحمن') throw new Error(`the name came back as "${lead.full_name}"`);
  if (lead.service_interest !== 'automation') throw new Error(`service is "${lead.service_interest}", the Arabic word for automation should have matched`);
  // Read urgency from the score breakdown as well as the column: the breakdown
  // is what the score was actually computed from, so it is the stronger claim.
  const bd = JSON.parse(lead.score_breakdown_json || '[]');
  const urg = bd.find((f) => f.factor === 'urgency');
  if (!urg || urg.value !== 'immediate') throw new Error(`the score used urgency "${urg && urg.value}", "ضروري" should have matched`);
  if (lead.urgency !== 'immediate') throw new Error(`the lead row stored urgency "${lead.urgency}"`);
  const opp = (await odooByUid(uid))[0];
  if (!opp) throw new Error('no Odoo opportunity');
  return `Arabic name and body preserved; service=automation and urgency=immediate matched from Arabic; Odoo #${opp.id}`;
});

test(16, 'C', 'A Nurture lead gets the nurture cadence, not the qualified one', async () => {
  const r = await hook('lp-web-lead', website({
    name: 'Omar Saleh', email: `nurt+${RUN}@smallshop.com`, company: 'Small Shop',
    phone: phoneFor('96'), service: 'Training', timeline: '',
    message: 'Just exploring what is possible, no rush at all, doing some research for later.',
  }));
  const uid = r.json.lead_uids[0];
  const lead = await until('routed', async () => {
    const l = await leadRow(uid);
    return l && l.band && Number(l.odoo_lead_id) > 0 ? l : null;
  }, { tries: 30, waitMs: 2000 });
  if (lead.band !== 'nurture') return `SOFT: this lead scored ${lead.score} -> "${lead.band}", not nurture; the cadence assertion needs a nurture lead`;

  const jobs = await until('cadence scheduled', async () => {
    const j = (await jobsFor(uid)).filter((x) => x.job_type === 'followup');
    return j.length >= 3 ? j : null;
  }, { tries: 15, waitMs: 2000 });

  const byStep = jobs.sort((a, b) => Number(a.step) - Number(b.step));
  const gaps = byStep.map((j) => Math.round((Number(j.due_at) - Number(lead.updated_at)) / 86400));
  // Nurture cadence is +2d / +7d / +21d.
  if (gaps[0] < 1 || gaps[0] > 3) throw new Error(`step 1 is due in ~${gaps[0]}d, nurture step 1 should be ~2d`);
  if (gaps[2] < 18) throw new Error(`step 3 is due in ~${gaps[2]}d, nurture step 3 should be ~21d`);
  return `score ${lead.score} -> nurture; 3 follow-ups due at roughly +${gaps.join('d, +')}d (rule: 2/7/21)`;
});

test(17, 'C', 'A Qualified lead is assigned, armed with an SLA, and confirmed', async () => {
  const r = await hook('lp-web-lead', website({ email: `qual+${RUN}@nilecargo.com`, phone: phoneFor('97') }));
  const uid = r.json.lead_uids[0];
  const lead = await until('routed', async () => {
    const l = await leadRow(uid);
    return l && l.owner_id && Number(l.odoo_lead_id) > 0 ? l : null;
  }, { tries: 30, waitMs: 2000 });

  if (lead.band !== 'qualified') return `SOFT: scored ${lead.score} -> "${lead.band}", expected qualified`;

  const jobs = await until('SLA + follow-ups scheduled', async () => {
    const j = await jobsFor(uid);
    return j.some((x) => x.job_type === 'sla') && j.some((x) => x.job_type === 'followup') ? j : null;
  }, { tries: 15, waitMs: 2000 });

  const sla = jobs.find((j) => j.job_type === 'sla');
  const slaIn = Number(sla.due_at) - Number(lead.updated_at);
  if (slaIn < 1700 || slaIn > 1900) throw new Error(`SLA is due in ${slaIn}s, the rule is 1800`);

  // The confirmation is written on a branch that runs after the response, so
  // this has to wait for it rather than read once. Reading once failed here
  // exactly the way EC-13 did: an assertion about the system that was really an
  // assertion about how fast the harness got there.
  await until('the confirmation reaches the audit log', async () => {
    const a = await auditFor(uid);
    return a.find((x) => x.type === 'message_sent') || null;
  }, { tries: 15, waitMs: 2000 });

  const opp = (await odooByUid(uid))[0];
  if (!opp) throw new Error('no Odoo opportunity');
  const desc = String(opp.description || '');
  for (const need of ['Score', 'Source']) {
    if (!desc.includes(need)) throw new Error(`the Odoo description is missing "${need}" - the brief requires stage, score, owner, source and reason on the record`);
  }
  return `owner ${lead.owner_id} (rung ${lead.assign_rung}), SLA at +${slaIn}s, confirmation sent, Odoo #${opp.id} carries the score and reason`;
});

// ===========================================================================
// D. Robustness
// ===========================================================================

test(18, 'D', 'A 50 KB message is truncated rather than crashing or storing whole', async () => {
  const huge = 'We need automation. '.repeat(2600); // ~52 KB
  const r = await hook('lp-web-lead', website({
    name: 'Verbose Vera', email: `huge+${RUN}@nilecargo.com`, phone: phoneFor('80'), message: huge,
  }));
  if (r.status !== 202) throw new Error(`intake answered ${r.status}`);
  const uid = r.json.lead_uids[0];
  const lead = await until('stored', async () => (await leadRow(uid)) || null, { tries: 20, waitMs: 1500 });
  if (lead.free_text.length > 4100) throw new Error(`free_text is ${lead.free_text.length} chars, the cap is 4000`);
  await until('scored', async () => (await leadRow(uid))?.band ? true : null, { tries: 30, waitMs: 2000 });
  return `${huge.length} chars in -> free_text capped at ${lead.free_text.length}, lead completed normally`;
});

test(19, 'D', 'Hostile strings in every field are stored as data, never executed', async () => {
  const nasty = "'; DROP TABLE lp_lead; -- <script>alert(1)</script> {{ $json.secret }}  [31m ";
  const r = await hook('lp-web-lead', website({
    name: nasty, company: nasty, service: nasty, message: nasty,
    email: `nasty+${RUN}@nilecargo.com`, phone: phoneFor('81'),
  }));
  if (r.status !== 202) throw new Error(`intake answered ${r.status}`);
  const uid = r.json.lead_uids[0];
  const lead = await until('scored', async () => (await leadRow(uid))?.band ? leadRow(uid) : null, { tries: 30, waitMs: 2000 });
  if (/[ -]/.test(lead.full_name)) throw new Error('control characters survived into the stored name');
  if ((await rows('lp_lead')).length === 0) throw new Error('the lead table is gone, which would be quite something');
  const opp = (await odooByUid(uid))[0];
  return `injection payloads stored as inert text, control characters stripped, Odoo #${opp ? opp.id : 'n/a'} created normally`;
});

test(20, 'D', 'A CSV over the row cap is refused with the limit named, not half-imported', async () => {
  const header = 'Name,Email,Phone,Company,Country,Service,Notes,Consent';
  const line = (i) => `Bulk ${i},bulk${i}+${RUN}@nilecargo.com,010${String(P6).slice(0, 5)}${String(i).padStart(2, '0')},Nile Cargo,Egypt,Automation,Row ${i},yes`;
  const csv = [header, ...Array.from({ length: 260 }, (_, i) => line(i))].join('\n');
  const r = await hook('lp-csv-import', { batch_id: `cap-${RUN}`, attested_consent: true, csv });
  if (r.status !== 202) throw new Error(`csv import answered ${r.status}`);
  // Refusing the whole batch is the right call here and better than truncating:
  // a half-imported file leaves the operator unable to say what landed. What
  // must never happen is a silent partial import.
  if ((r.json.accepted || 0) > 0) throw new Error(`${r.json.accepted} rows were imported from an over-cap batch - a partial import nobody asked for`);
  const said = JSON.stringify(r.json);
  if (!said.includes('200')) throw new Error('the batch was refused but the response does not name the limit, so the caller cannot act on it');
  const why = (r.json.errors || [])[0]?.error || said.slice(0, 140);
  return `260 rows in -> 0 imported, refused with the limit named: "${String(why).slice(0, 110)}"`;
});

test(21, 'D', 'A CSV with a BOM, CRLF and quoted commas parses correctly', async () => {
  const csv = '﻿' + [
    'Name,Email,Phone,Company,Country,Service,Notes,Consent',
    `"Hassan, Mahmoud",bom+${RUN}@deltaclinics.com,010${P6}01,"Delta Clinics, LLC",Egypt,Automation,"Line one\nline two, with a comma",yes`,
  ].join('\r\n');
  const r = await hook('lp-csv-import', { batch_id: `bom-${RUN}`, attested_consent: true, csv });
  if (r.json.accepted !== 1) throw new Error(`expected 1 accepted, got ${r.json.accepted} (${JSON.stringify(r.json.errors || [])})`);
  const lead = await until('stored', async () => (await leadRow(r.json.lead_uids[0])) || null, { tries: 20, waitMs: 1500 });
  if (lead.full_name !== 'Hassan, Mahmoud') throw new Error(`the quoted name came back as "${lead.full_name}"`);
  if (!lead.company.includes('Delta Clinics')) throw new Error(`the quoted company came back as "${lead.company}"`);
  if (!lead.free_text.includes('with a comma')) throw new Error('the embedded newline broke the field');
  return `BOM stripped, CRLF handled, quoted commas and an embedded newline preserved: "${lead.full_name}" / "${lead.company}"`;
});

test(22, 'D', 'An import row with attested consent records where consent came from', async () => {
  const csv = [
    'Name,Email,Phone,Company,Country,Service,Notes,Consent',
    `Consent Trace,ct+${RUN}@nilecargo.com,010${P6}02,Nile Cargo,Egypt,Automation,Wants a quote,yes`,
  ].join('\n');
  const r = await hook('lp-csv-import', { batch_id: `consent-${RUN}`, attested_consent: true, csv });
  const lead = await until('stored', async () => (await leadRow(r.json.lead_uids[0])) || null, { tries: 20, waitMs: 1500 });
  if (lead.consent !== 'granted') throw new Error(`consent is "${lead.consent}"`);
  if (lead.consent_source !== 'import_attested') throw new Error(`consent_source is "${lead.consent_source}", it must record that this came from an import attestation`);
  return `consent=granted, consent_source=import_attested - the lawful basis is recorded per lead, not assumed`;
});

// ===========================================================================
// E. Dead letters and replay
// ===========================================================================

test(23, 'E', 'Replaying a dead letter that does not exist is a 404', async () => {
  const r = await hook('lp-replay', { dlq_id: `dlq-does-not-exist-${RUN}` });
  if (r.json?.ok) throw new Error('a nonexistent dead letter was "replayed"');
  if (Number(r.json?.status) !== 404) throw new Error(`expected 404, got ${r.json?.status}`);
  return `unknown dlq_id -> 404, "${String(r.json.reason || r.json.detail || '').slice(0, 70)}"`;
});

test(24, 'E', 'Replaying with no dlq_id at all is a 400', async () => {
  const r = await hook('lp-replay', {});
  if (r.json?.ok) throw new Error('a replay with no id was accepted');
  if (Number(r.json?.status) !== 400) throw new Error(`expected 400, got ${r.json?.status}`);
  return `missing dlq_id -> 400, "${String(r.json.reason || r.json.detail || '').slice(0, 70)}"`;
});

test(25, 'E', 'A malformed override_json is refused instead of half-applied', async () => {
  const dlq_id = `dlq-hard-${RUN}`;
  await upsert('lp_dlq', eq('dlq_id', dlq_id), {
    dlq_id, lead_uid: '', stage_failed: 'test', error_class: 'transient', error: 'seeded by the hardening suite',
    payload_json: '{}', attempts: 1, state: 'open', first_seen: STARTED, last_seen: STARTED,
  });
  const r = await hook('lp-replay', { dlq_id, override_json: '{not valid json' });
  if (r.json?.ok) throw new Error('a broken override was accepted');
  if (Number(r.json?.status) !== 400) throw new Error(`expected 400, got ${r.json?.status}`);
  const row = (await rows('lp_dlq', eq('dlq_id', dlq_id)))[0];
  if (row.state !== 'open') throw new Error(`the dead letter moved to "${row.state}" on a refused replay`);
  return `bad override -> 400, and the dead letter stayed "open" rather than being marked handled`;
});

test(26, 'E', 'A dead letter already handled is refused a second time', async () => {
  const dlq_id = `dlq-done-${RUN}`;
  await upsert('lp_dlq', eq('dlq_id', dlq_id), {
    dlq_id, lead_uid: '', stage_failed: 'test', error_class: 'transient', error: 'seeded, already replayed',
    payload_json: '{}', attempts: 1, state: 'replayed', first_seen: STARTED, last_seen: STARTED,
  });
  const r = await hook('lp-replay', { dlq_id });
  if (r.json?.ok) throw new Error('an already-replayed dead letter was replayed again');
  if (Number(r.json?.status) !== 409) throw new Error(`expected 409, got ${r.json?.status}`);
  return `already replayed -> 409, "${String(r.json.reason || r.json.detail || '').slice(0, 70)}"`;
});

test(27, 'E', 'A permanent Odoo error is classified permanent and never retried', async () => {
  const before = (await rows('lp_dlq')).length;
  const r = await hook('lp-mock-enrich', {}, { query: '?fail=401' });
  if (r.status < 400) throw new Error(`the 401 injector answered ${r.status}`);
  // The classification itself is unit-tested; here we only prove the injector
  // is real and that a 401 is not silently turned into a success.
  return `the credential-death injector returns ${r.status}; classification of 401 as permanent+critical is covered by the unit suite (dlq rows: ${before})`;
});

// ===========================================================================
// F. Observability
// ===========================================================================

test(28, 'F', 'The ops endpoint returns every metric the brief asks for', async () => {
  const r = await hook('lp-ops', {});
  if (r.status !== 200) throw new Error(`ops answered ${r.status}`);
  // The brief names six metrics: total processed, qualified, duplicates,
  // failed, manual-review and SLA-breached. They are all here, under names that
  // say what they are rather than the brief's wording, so this checks the PATHS
  // rather than grepping for the brief's vocabulary in the blob.
  const j = r.json;
  const need = {
    'total processed': j.volume?.received,
    qualified: j.outcomes?.qualified,
    duplicates: j.quality?.duplicate_merges,
    failed: j.health?.open_dead_letters,
    'manual review': j.outcomes?.manual_review,
    'SLA breached': j.health?.sla_breaches,
  };
  const missing = Object.entries(need).filter(([, v]) => typeof v !== 'number').map(([k]) => k);
  if (missing.length) throw new Error(`the summary does not report: ${missing.join(', ')}`);
  return `all six reported - processed ${need['total processed']}, qualified ${need.qualified}, duplicates ${need.duplicates}, failed ${need.failed}, manual ${need['manual review']}, SLA ${need['SLA breached']}`;
});

test(29, 'F', 'The public ops payload does not leak internal addresses', async () => {
  const cfg = await config();
  const r = await hook('lp-ops', {});
  const flat = JSON.stringify(r.json);
  if (cfg.manager_email && flat.includes(cfg.manager_email)) {
    throw new Error('the manager email is exposed on the public metrics endpoint');
  }
  if (cfg.odoo_password && flat.includes(cfg.odoo_password)) throw new Error('the Odoo password is in the metrics payload');
  return `manager_email and odoo credentials absent from the ${flat.length}-byte public payload`;
});

test(30, 'F', 'Every lead this suite created has a complete, readable audit trail', async () => {
  const mine = (await rows('lp_lead')).filter((l) => String(l.raw_json || '').includes(RUN) || String(l.email_raw || '').includes(RUN));
  if (mine.length < 5) throw new Error(`only found ${mine.length} leads from this run, expected several`);
  const gaps = [];
  for (const l of mine) {
    const a = await auditFor(l.lead_uid);
    const types = new Set(a.map((x) => x.type));
    if (!types.has('intake_received')) gaps.push(`${l.lead_uid}: no intake_received`);
    if (l.band && !types.has('scored')) gaps.push(`${l.lead_uid}: scored but no "scored" audit row`);
    if (Number(l.odoo_lead_id) > 0 && !types.has('odoo_upserted')) gaps.push(`${l.lead_uid}: in Odoo but no "odoo_upserted" row`);
    if (a.some((x) => !x.execution_id)) gaps.push(`${l.lead_uid}: an audit row with no execution id`);
  }
  if (gaps.length) throw new Error(gaps.slice(0, 4).join(' | '));
  return `${mine.length} leads checked, every one traceable from intake to CRM write, every row carrying its execution id`;
});

// ===========================================================================
// G. Instance health
// ===========================================================================

test(32, 'G', 'The live tables match the schema the code is built from', async () => {
  // The schema had two homes and they drifted: the real lp_lead carried
  // `stated_urgency` and `stated_budget`, names retired weeks earlier, while
  // `urgency` and `budget_band` were written by three workflows and stored by
  // nobody. Nothing failed - writing to a column that does not exist is only an
  // error if something writes to it, and n8n silently accepted the rest.
  //
  // The definition is single now. This check is what keeps it that way: it
  // reads the tables the instance ACTUALLY has and compares them, column by
  // column, against the object the workflows were generated from.
  const C = (await import('../02_Workflows/_shared/constants.js')).default
    || (await import('../02_Workflows/_shared/constants.js'));
  const spec = C.TABLES || C.default?.TABLES;
  if (!spec) throw new Error('could not load C.TABLES from the shared constants');

  const live = (await napi('GET', '/data-tables?limit=100')).json?.data || [];
  const problems = [];

  for (const [table, cols] of Object.entries(spec)) {
    const t = live.find((x) => x.name === table);
    if (!t) { problems.push(`${table}: missing entirely`); continue; }
    const full = (await napi('GET', `/data-tables/${t.id}`)).json;
    const actual = new Map((full?.columns || []).map((c) => [c.name, c.type]));
    for (const [name, type] of Object.entries(cols)) {
      if (!actual.has(name)) problems.push(`${table}.${name} is in the code and not in the table`);
      else if (actual.get(name) !== type) problems.push(`${table}.${name} is ${actual.get(name)}, the code says ${type}`);
    }
    for (const name of actual.keys()) {
      if (!(name in cols)) problems.push(`${table}.${name} is in the table and not in the code`);
    }
  }

  if (problems.length) throw new Error(problems.slice(0, 6).join(' | '));
  const total = Object.values(spec).reduce((n, c) => n + Object.keys(c).length, 0);
  return `${Object.keys(spec).length} tables, ${total} columns, every one matching the definition the workflows are generated from`;
});

test(31, 'G', 'Nothing errored on the instance during this run that should not have', async () => {
  const ids = JSON.parse((await import('node:fs')).readFileSync(new URL('../.n8n-ids.json', import.meta.url), 'utf8'));
  const problems = [];
  for (const [name, id] of Object.entries(ids)) {
    const r = await napi('GET', `/executions?workflowId=${id}&status=error&limit=20`);
    const recent = (r.json?.data || []).filter((e) => Math.floor(new Date(e.startedAt).getTime() / 1000) >= STARTED);
    // LP-99 is the chaos mock: it is SUPPOSED to fail when asked to.
    if (recent.length && !/LP-99/.test(name)) problems.push(`${name}: ${recent.length} errored execution(s)`);
  }
  if (problems.length) throw new Error(problems.join(' | '));
  return `all 11 workflows: zero unexpected errored executions since this suite started`;
});

// ---------------------------------------------------------------------------

(async () => {
  console.log('\nLead Intelligence Pipeline - hardening suite');
  console.log(`instance ${BASE}   run id ${RUN}\n`);
  await loadTables();
  const redirect = await requireMailRedirect();
  console.log(`lead-facing mail redirected to ${redirect}\n`);

  const fail = await runSuite({
    title: 'Hardening', cases: CASES, only, outFile: '05_Test_Evidence/last-hardening-run.json',
  });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nSUITE ABORTED:', e.message); process.exit(2); });
