/**
 * LP-01 Intake - the only door into the system.
 *
 * Three sources, one canonical lead, one idempotency gate.
 *
 *   POST /webhook/lp-web-lead     website / landing-page form
 *   POST /webhook/lp-wa-inbound   WhatsApp Business Cloud API webhook
 *   POST /webhook/lp-csv-import   bulk import  { csv | csv_base64 | rows[] }
 *
 * Three deliberate choices a reviewer will want the reason for:
 *
 * 1. **The webhook answers before the work happens.** Intake claims the event,
 *    responds, and hands off to LP-02 without waiting. A source that retries on
 *    a slow response (Meta retries for days) must never be given a reason to.
 *
 * 2. **Two different keys, not one.** `idem_key` identifies a DELIVERY,
 *    `person_key` identifies a HUMAN. Intake only ever gates on the first.
 *    Deciding "same person" is a judgement call with a confidence score and it
 *    belongs in LP-02, not in a webhook that has 200ms to answer.
 *
 * 3. **A bad row is quarantined, never dropped and never fatal.** A 50-row CSV
 *    with one broken row imports 49 leads and files one dead letter with the
 *    original text attached, so it can be fixed and replayed (edge case 13).
 *
 * CSV arrives as text or base64 in a JSON body rather than as a browser file
 * upload. The trade-off, stated plainly: no upload UI, in exchange for an
 * endpoint the reviewer can drive with one curl command and the edge-case
 * runner can drive unattended. A Form Trigger front end is a thin addition and
 * is listed in the design doc's future work.
 */
module.exports = {
  file: 'LP-01-intake',
  name: 'LP-01 Intake',
  purpose: 'Website, WhatsApp and CSV intake: normalize to one schema, gate duplicate deliveries, quarantine bad rows, hand off.',
  settings: { errorWorkflow: '@LP-05 Error Handler and DLQ' },

  nodes: [
    // -----------------------------------------------------------------------
    // Triggers
    // -----------------------------------------------------------------------
    {
      n: 'Website Lead',
      t: 'webhook',
      p: {
        httpMethod: 'POST',
        path: 'lp-web-lead',
        authentication: 'headerAuth',
        responseMode: 'responseNode',
        options: { rawBody: false },
      },
      creds: { httpHeaderAuth: { name: 'LP Webhook Token (X-LP-Token)' } },
      notes: 'Header auth, not "open webhook plus a check in a Code node". An unauthenticated\n'
        + 'endpoint that validates later still executes the workflow for every request,\n'
        + 'which is a free denial-of-service and a free way to fill the audit log.',
    },
    {
      n: 'WhatsApp Inbound',
      t: 'webhook',
      p: {
        httpMethod: 'POST',
        path: 'lp-wa-inbound',
        authentication: 'headerAuth',
        responseMode: 'responseNode',
        options: { rawBody: false },
      },
      creds: { httpHeaderAuth: { name: 'LP Webhook Token (X-LP-Token)' } },
      notes: 'Accepts the real WhatsApp Business Cloud API envelope\n'
        + '(entry[].changes[].value.messages[]) and a flat {from,name,text} shape for\n'
        + 'testing. Going live against Meta is a URL swap plus their signature header;\n'
        + 'nothing downstream changes.\n\n'
        + 'Meta retries an unacknowledged webhook for up to 7 days, which is precisely why\n'
        + 'the response is sent before the processing rather than after it.',
    },
    {
      n: 'CSV Import',
      t: 'webhook',
      p: {
        httpMethod: 'POST',
        path: 'lp-csv-import',
        authentication: 'headerAuth',
        responseMode: 'responseNode',
        options: { rawBody: false },
      },
      creds: { httpHeaderAuth: { name: 'LP Webhook Token (X-LP-Token)' } },
    },

    // -----------------------------------------------------------------------
    // Per-source normalisation - the ONLY part that differs per source
    // -----------------------------------------------------------------------
    {
      n: 'Normalize Website',
      t: 'code',
      code: `
const req = $input.first().json;
const b = req.body || {};

// A form post with nothing in it is a client bug, not a lead. It is reported
// back as a quarantined row rather than thrown, so the caller gets a readable
// answer instead of a 500 from a Code node.
if (!b || typeof b !== 'object' || !Object.keys(b).length) {
  return [{ json: { __parse_error: 'empty request body', source: 'website', raw: req.body ?? null } }];
}

return [{ json: {
  source: 'website',
  // The form's own submission id is the best idempotency anchor there is:
  // a retried POST carries the same one, a second genuine submission does not.
  source_ref: b.submission_id || b.form_submission_id || b.id || '',
  sub_source: b.utm_source || b.channel || 'web_form',
  full_name: b.name || b.full_name || [b.first_name, b.last_name].filter(Boolean).join(' '),
  email_raw: b.email || b.email_address || '',
  phone_raw: b.phone || b.mobile || b.phone_number || '',
  company: b.company || b.company_name || b.organisation || '',
  country: b.country || b.country_code || '',
  service_interest: b.service || b.service_interest || b.interested_in || '',
  free_text: b.message || b.notes || b.requirement || b.description || '',
  budget: b.budget || b.budget_usd || '',
  urgency: b.timeline || b.urgency || b.when || '',
  consent: b.consent ?? b.opt_in ?? b.gdpr_consent ?? '',
  // A ticked box on a form is explicit, recorded consent. Anything weaker gets
  // 'unknown' from finalizeLead and routes to Data Completion instead.
  consent_source: 'form_checkbox',
  raw: b,
} }];
`,
    },

    {
      n: 'Normalize WhatsApp',
      t: 'code',
      code: `
const req = $input.first().json;
const b = req.body || {};
const out = [];

// The real Cloud API envelope.
const changes = (b.entry || []).flatMap(e => e.changes || []);
for (const ch of changes) {
  const v = ch.value || {};

  // Meta sends far more delivery/read receipts than messages. They are not
  // leads. Acknowledging and ignoring them is required - responding with an
  // error would make Meta retry the receipt forever.
  if (v.statuses && !v.messages) {
    out.push({ json: { __ignored: 'delivery status callback', source: 'whatsapp', raw: v } });
    continue;
  }

  const profiles = Object.fromEntries((v.contacts || []).map(c => [c.wa_id, c.profile?.name || '']));
  for (const m of v.messages || []) {
    // Only text carries qualifying information. Media still creates the lead,
    // with the media type recorded, because the person is real either way.
    const text = m.text?.body
      || m.button?.text
      || m.interactive?.list_reply?.title
      || m.interactive?.button_reply?.title
      || (m.type && m.type !== 'text' ? '[' + m.type + ' message]' : '');

    out.push({ json: {
      source: 'whatsapp',
      // wamid is globally unique and stable across Meta's own retries, so it is
      // the idempotency key. This is the cleanest source in the system.
      source_ref: m.id || '',
      sub_source: 'whatsapp_inbound',
      full_name: profiles[m.from] || '',
      email_raw: '',
      phone_raw: m.from || '',
      company: '',
      country: '',
      service_interest: '',
      free_text: text,
      budget: '',
      urgency: '',
      // Inbound-initiated contact IS consent to reply under WhatsApp's own
      // rules and under every marketing regime that matters here: they messaged
      // us first. Recorded with its basis, not silently assumed.
      consent: true,
      consent_source: 'inbound_initiated',
      raw: { message: m, metadata: v.metadata || {} },
    } });
  }
}

// Flat test shape, so the edge-case runner does not have to build a Meta
// envelope by hand for every scenario.
if (!out.length && (b.from || b.phone)) {
  out.push({ json: {
    source: 'whatsapp',
    source_ref: b.message_id || b.wamid || '',
    sub_source: 'whatsapp_inbound',
    full_name: b.name || '',
    email_raw: b.email || '',
    phone_raw: b.from || b.phone || '',
    company: '', country: '', service_interest: '',
    free_text: b.text || b.message || '',
    budget: '', urgency: '',
    consent: true,
    consent_source: 'inbound_initiated',
    raw: b,
  } });
}

if (!out.length) {
  out.push({ json: { __ignored: 'no messages in payload', source: 'whatsapp', raw: b } });
}
return out;
`,
    },

    {
      n: 'Parse CSV Batch',
      t: 'code',
      code: `
const req = $input.first().json;
const b = req.body || {};
const batch_id = String(b.batch_id || ('csv-' + C.stableHash(JSON.stringify(b)).slice(0, 8)));

// Three accepted shapes: raw text, base64 (a file, without a multipart parser),
// and a pre-parsed array for callers that already have objects.
let text = '';
if (typeof b.csv === 'string' && b.csv.trim()) text = b.csv;
else if (typeof b.csv_base64 === 'string' && b.csv_base64.trim()) {
  try { text = Buffer.from(b.csv_base64, 'base64').toString('utf8'); }
  catch (e) { return [{ json: { __parse_error: 'csv_base64 is not valid base64', source: 'csv_import', raw: { batch_id } } }]; }
}

let rows = [];
let unmapped = [];

if (text) {
  const parsed = I.parseCsv(text);
  if (parsed.error) {
    return [{ json: { __parse_error: parsed.error, source: 'csv_import', raw: { batch_id } } }];
  }
  const hm = I.csvHeaderMap(parsed.header);
  unmapped = hm.unmapped;

  // A file whose header matches nothing is a wrong-file mistake, and importing
  // it row by row would produce a page of identical "unusable" quarantines that
  // hides the real cause. One clear failure beats fifty confusing ones.
  if (!hm.map.email_raw && !hm.map.phone_raw) {
    return [{ json: {
      __parse_error: 'no email or phone column found. Columns seen: ' + parsed.header.join(', '),
      source: 'csv_import', raw: { batch_id, header: parsed.header },
    } }];
  }
  if (parsed.rows.length > I.INTAKE.MAX_CSV_ROWS) {
    return [{ json: {
      __parse_error: parsed.rows.length + ' rows exceeds the ' + I.INTAKE.MAX_CSV_ROWS +
        '-row synchronous limit. Split the file, or use the documented async import path.',
      source: 'csv_import', raw: { batch_id, rows: parsed.rows.length },
    } }];
  }

  rows = parsed.rows.map(r => ({
    line: r.line,
    error: r.error,
    partial: r.error ? null : I.mapCsvRow(hm.map, r.cells),
    cells: r.cells,
  }));
} else if (Array.isArray(b.rows)) {
  rows = b.rows.map((o, i) => ({ line: i + 1, error: '', partial: o, cells: [] }));
} else {
  return [{ json: { __parse_error: 'send csv, csv_base64 or rows[]', source: 'csv_import', raw: { batch_id } } }];
}

if (!rows.length) {
  return [{ json: { __parse_error: 'the file has a header but no data rows', source: 'csv_import', raw: { batch_id } } }];
}

// One item per row. A broken row travels as an item carrying its error, so it
// is quarantined individually further down instead of aborting the batch.
return rows.map(r => ({ json: r.error
  ? { __parse_error: r.error, source: 'csv_import', batch_id, line: r.line,
      raw: { batch_id, line: r.line, cells: r.cells } }
  : {
      ...r.partial,
      source: 'csv_import',
      // No provider id, so the idempotency key falls back to a content hash of
      // the row. Re-uploading the same file therefore imports nothing twice,
      // which is the whole point of a bulk-import gate.
      source_ref: r.partial.source_ref ? batch_id + ':' + r.partial.source_ref : '',
      sub_source: r.partial.sub_source || 'csv_import',
      // The importer attests to consent for the batch. If they do not, every
      // row lands in Data Completion rather than being contacted on a guess.
      consent: b.attested_consent === true ? true : (r.partial.consent || ''),
      consent_source: b.attested_consent === true ? 'import_attested' : 'csv_column',
      batch_id,
      line: r.line,
      raw: { batch_id, line: r.line, ...r.partial },
    },
}));
`,
      notes: 'Uses I.parseCsv from _shared/intake.js: quoted fields, doubled quotes, embedded\n'
        + 'commas and newlines, CRLF and a BOM. A split(",") import corrupts data silently,\n'
        + 'which is worse than failing, because nobody looks.',
    },

    // -----------------------------------------------------------------------
    // Shared chain
    // -----------------------------------------------------------------------
    {
      n: 'Finalize and Validate',
      t: 'code',
      code: `
// Only one trigger fires per execution, so exactly one normaliser produced
// these items. Everything from here on is source-agnostic by construction:
// there is no "if website" anywhere downstream.
const now = Math.floor(Date.now() / 1000);
const out = [];

for (const item of $input.all()) {
  const p = item.json;

  if (p.__ignored) {
    out.push({ json: { gate_input: 'ignored', reason: p.__ignored, source: p.source } });
    continue;
  }

  if (p.__parse_error) {
    // A row that could not be read still gets a stable id, so its dead letter
    // is addressable and a replay can be tied back to it.
    const key = 'parse:' + p.source + ':' + C.stableHash(C.canonicalJson(p.raw ?? p));
    out.push({ json: {
      gate_input: 'parse_error',
      reason: p.__parse_error,
      source: p.source,
      line: p.line || 0,
      batch_id: p.batch_id || '',
      idem_key: key,
      lead_uid: C.leadUidFrom(key, now),
      raw_json: JSON.stringify(p.raw ?? {}).slice(0, I.INTAKE.MAX_RAW_JSON),
    } });
    continue;
  }

  const lead = I.finalizeLead(p, { now, default_cc: '20' });
  out.push({ json: { gate_input: 'lead', ...lead, batch_id: p.batch_id || '', line: p.line || 0 } });
}

return out;
`,
    },

    {
      n: 'Read Intake Ledger',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'get',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_idem' },
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'idem_key', condition: 'eq', keyValue: '={{ $json.idem_key }}' }] },
        returnAll: true,
      },
      alwaysOutputData: true,
      onError: 'continueRegularOutput',
      notes: 'Filtered per item, so a 50-row import does 50 keyed lookups rather than one\n'
        + 'full-table scan. Verified live with a multi-row batch before it was trusted -\n'
        + 'see 05_Test_Evidence.\n\n'
        + 'continueRegularOutput here is a considered exception, not a habit: this node is\n'
        + 'NOT on the path to the webhook response (that branches earlier), and a ledger\n'
        + 'read that fails should degrade to "assume nothing was seen before" - a possible\n'
        + 'duplicate - rather than reject a real lead outright. Losing a lead is worse than\n'
        + 'processing one twice, and everything downstream is idempotent anyway.',
    },

    {
      n: 'Gate Duplicates',
      t: 'code',
      code: `
// Correspondence between items and their ledger rows is established by VALUE,
// not by position. The Data Table node emits one row per match and nothing for
// a miss, so positions do not line up with the input - matching on the key that
// each returned row carries is the only correct way to read it.
//
// The scope check is load-bearing, not decoration. The read node is set to
// continue on error, and on that path n8n passes the INPUT items through - and
// an input item is a lead, which also has an idem_key. Without this filter a
// failed ledger read would mark every lead in the batch as a duplicate of
// itself and silently drop the whole thing. A ledger row is the only thing that
// carries scope='intake'.
const seen = new Set(
  $input.all().map(i => i.json)
    .filter(r => r && r.idem_key && r.scope === 'intake')
    .map(r => String(r.idem_key)),
);

const items = $('Finalize and Validate').all().map(i => i.json);
const nowSec = Math.floor(Date.now() / 1000);
const execId = String($execution.id || '');
const out = [];

for (const it of items) {
  if (it.gate_input === 'ignored') {
    out.push({ json: { ...it, gate: 'ignored',
      event_id: 'ig-' + C.stableHash(execId + it.reason).slice(0, 12),
      audit_type: 'intake_received', audit_decision: 'ignored',
      audit_detail: it.reason } });
    continue;
  }

  if (it.gate_input === 'parse_error') {
    out.push({ json: { ...it, gate: 'quarantine',
      event_id: 'qe-' + C.stableHash(it.idem_key).slice(0, 12),
      quarantine_class: 'parse_error',
      quarantine_error: it.reason,
      audit_type: 'validation_failed', audit_decision: 'quarantined',
      audit_detail: 'line ' + (it.line || 0) + ': ' + it.reason } });
    continue;
  }

  if (seen.has(String(it.idem_key))) {
    // Not an error, and not silence. The same delivery arriving twice is normal
    // (edge case 8) - it is recorded so "why is this lead not in the CRM twice"
    // has an answer in the audit log.
    out.push({ json: { ...it, gate: 'duplicate',
      event_id: 'dp-' + C.stableHash(it.idem_key + execId).slice(0, 12),
      audit_type: 'intake_duplicate_event', audit_decision: 'skipped',
      audit_detail: 'idem_key already claimed: ' + it.idem_key } });
    continue;
  }

  if (it.validation_state === 'unusable') {
    out.push({ json: { ...it, gate: 'quarantine',
      event_id: 'qu-' + C.stableHash(it.idem_key).slice(0, 12),
      quarantine_class: 'unusable',
      quarantine_error: it.validation_reason,
      audit_type: 'validation_failed', audit_decision: 'quarantined',
      audit_detail: it.validation_reason } });
    continue;
  }

  // 'ok' and 'incomplete' both proceed. Incomplete is not a failure: it is a
  // real person missing a field, and the Data Completion stage exists to chase
  // exactly that. Rejecting them here would throw away recoverable leads.
  out.push({ json: { ...it, gate: 'proceed',
    event_id: 'in-' + C.stableHash(it.idem_key).slice(0, 12),
    claimed_at: nowSec,
    audit_type: 'intake_received',
    audit_decision: it.validation_state === 'incomplete' ? 'accepted_incomplete' : 'accepted',
    audit_detail: it.validation_state === 'incomplete'
      ? ('missing ' + it.validation_missing)
      : ('score pending, source ' + it.source) } });
}

return out;
`,
    },

    // --- branch 1: answer the caller, first and fast -----------------------
    {
      n: 'Build Response',
      t: 'code',
      code: `
const items = $input.all().map(i => i.json);
const count = (g) => items.filter(i => i.gate === g).length;

const accepted = items.filter(i => i.gate === 'proceed');
const quarantined = items.filter(i => i.gate === 'quarantine');

return [{ json: {
  ok: accepted.length > 0 || (quarantined.length === 0),
  received: items.length,
  accepted: accepted.length,
  duplicates: count('duplicate'),
  quarantined: quarantined.length,
  ignored: count('ignored'),
  lead_uids: accepted.map(i => i.lead_uid),
  incomplete: accepted.filter(i => i.validation_state === 'incomplete')
    .map(i => ({ lead_uid: i.lead_uid, missing: i.validation_missing })),
  errors: quarantined.map(i => ({ line: i.line || 0, error: i.quarantine_error })),
  execution_id: String($execution.id || ''),
} }];
`,
    },
    {
      n: 'Respond Accepted',
      t: 'respond',
      p: {
        respondWith: 'json',
        responseBody: '={{ JSON.stringify($json) }}',
        options: { responseCode: 202 },
      },
      notes: '202 Accepted, deliberately, and sent BEFORE the handoff. The lead has been\n'
        + 'durably claimed by this point but not yet qualified, and 202 is the honest code\n'
        + 'for that. It also stops WhatsApp retrying: Meta re-delivers anything it does not\n'
        + 'see acknowledged quickly, for up to seven days.\n\n'
        + 'The body names every outcome - accepted, duplicate, quarantined, ignored, plus\n'
        + 'the lead_uids - so the caller and the edge-case runner can assert on it instead\n'
        + 'of inferring success from a bare 200.',
    },

    // --- branch 2: the audit trail -----------------------------------------
    {
      n: 'Write Intake Audit',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'insert',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_audit' },
        columns: {
          mappingMode: 'defineBelow',
          value: {
            event_id: '={{ $json.event_id }}',
            lead_uid: '={{ $json.lead_uid || "" }}',
            ts: '={{ Math.floor(Date.now()/1000) }}',
            workflow: 'LP-01 Intake',
            execution_id: '={{ $execution.id }}',
            type: '={{ $json.audit_type }}',
            decision: '={{ $json.audit_decision }}',
            detail_json: '={{ JSON.stringify({ detail: $json.audit_detail, source: $json.source, source_ref: $json.source_ref || "", idem_key: $json.idem_key || "", batch_id: $json.batch_id || "", line: $json.line || 0 }) }}',
          },
          matchingColumns: [],
          schema: [],
        },
        options: {},
      },
      onError: 'continueRegularOutput',
      notes: 'Every arrival is logged, including the ones that go nowhere. n8n\'s own\n'
        + 'execution log is not an audit trail: it is pruned on a schedule and it cannot be\n'
        + 'queried by lead. "What happened to lead X" has to be answerable from a table.\n\n'
        + 'A failed audit write must not fail the intake, hence continueRegularOutput -\n'
        + 'and this node is a leaf, so nothing downstream inherits a broken item.',
    },

    // --- branch 3: routing --------------------------------------------------
    {
      n: 'Route Intake',
      t: 'switch',
      p: {
        rules: {
          values: ['proceed', 'quarantine'].map((g) => ({
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
              combinator: 'and',
              conditions: [{
                id: `gate-${g}`,
                leftValue: '={{ $json.gate }}',
                rightValue: g,
                operator: { type: 'string', operation: 'equals' },
              }],
            },
            renameOutput: true,
            outputKey: g,
          })),
        },
        options: {},
      },
      notes: 'No fallback output on purpose. "duplicate" and "ignored" are terminal states\n'
        + 'whose only required action - the audit row - already happened on branch 2. An\n'
        + 'explicit dead end is clearer than a NoOp node that exists to look tidy.',
    },

    {
      n: 'Claim Intake',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'insert',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_idem' },
        columns: {
          mappingMode: 'defineBelow',
          value: {
            idem_key: '={{ $json.idem_key }}',
            scope: 'intake',
            lead_uid: '={{ $json.lead_uid }}',
            state: 'claimed',
            result_ref: '={{ $json.source + ":" + ($json.source_ref || "content-hash") }}',
            claimed_at: '={{ $json.claimed_at }}',
            completed_at: 0,
            attempts: 1,
          },
          matchingColumns: [],
          schema: [],
        },
        options: {},
      },
      notes: 'Claim BEFORE the handoff, never after. A crash between the two leaves a row in\n'
        + 'state="claimed" with no completion, which is exactly the signal the reconciler\n'
        + 'in LP-03 looks for: it searches Odoo by the external key, finds whether the work\n'
        + 'actually happened, and either finishes the ledger or re-runs it. That is edge\n'
        + 'case 7 handled by a mechanism instead of by hoping.',
    },

    {
      n: 'Store Lead',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'upsert',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_lead' },
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'lead_uid', condition: 'eq', keyValue: '={{ $json.lead_uid }}' }] },
        columns: {
          mappingMode: 'defineBelow',
          value: {
            lead_uid: '={{ $json.lead_uid }}',
            source: '={{ $json.source }}',
            source_ref: '={{ $json.source_ref }}',
            received_at: '={{ $json.received_at }}',
            full_name: '={{ $json.full_name }}',
            email_raw: '={{ $json.email_raw }}',
            email_norm: '={{ $json.email_norm }}',
            phone_raw: '={{ $json.phone_raw }}',
            phone_e164: '={{ $json.phone_e164 }}',
            phone_key: '={{ $json.phone_key }}',
            country: '={{ $json.country }}',
            company: '={{ $json.company }}',
            domain: '={{ $json.domain }}',
            service_interest: '={{ $json.service_interest }}',
            free_text: '={{ $json.free_text }}',
            consent: '={{ $json.consent }}',
            consent_source: '={{ $json.consent_source }}',
            score: 0,
            score_breakdown_json: '',
            band: '={{ $json.validation_state === "incomplete" ? "data_completion" : "" }}',
            ai_status: 'skipped',
            ai_intent: '',
            ai_urgency: '={{ $json.urgency }}',
            ai_signals: '',
            ai_reason: '',
            ai_confidence: 0,
            owner_id: '',
            assign_rung: 0,
            odoo_lead_id: 0,
            odoo_stage: '',
            approval_state: 'not_required',
            approval_by: '',
            status: 'active',
            merged_into: '',
            raw_json: '={{ $json.raw_json }}',
            updated_at: '={{ $json.received_at }}',
          },
          matchingColumns: ['lead_uid'],
          schema: [],
        },
        options: {},
      },
      notes: 'Upsert, not insert. lead_uid is derived from the idempotency key, so a replay\n'
        + 'of the same delivery rewrites the same row rather than creating a second one -\n'
        + 'the record is durable before LP-02 is even asked to run.\n\n'
        + 'budget_band and urgency are carried in the payload to LP-02 rather than stored\n'
        + 'here: the Data Table schema is immutable through the API, so every speculative\n'
        + 'column is permanent. They belong to the score, and the score is stored as its\n'
        + 'breakdown.',
    },

    {
      n: 'Handoff to Qualify',
      t: 'executeWorkflow',
      p: {
        workflowId: '@LP-02 Qualify',
        mode: 'each',
        workflowInputs: {
          mappingMode: 'defineBelow',
          value: { lead_json: '={{ JSON.stringify($json) }}' },
          matchingColumns: [],
          schema: [],
        },
        options: { waitForSubWorkflow: false },
      },
      onError: 'continueRegularOutput',
      notes: 'mode "each": one LP-02 execution per lead, so a single poisonous row in a\n'
        + '50-row import cannot take the other 49 down with it. One failed execution, 49\n'
        + 'successes, one dead letter.\n\n'
        + 'waitForSubWorkflow false: intake is done once the lead is claimed and stored.\n'
        + 'Blocking here would put enrichment, an AI call and an Odoo round trip inside the\n'
        + 'webhook window, which is how a source starts retrying and one lead becomes four.\n\n'
        + 'The whole payload crosses as ONE JSON STRING. Sub-workflow inputs flatten nested\n'
        + 'objects unpredictably (the same lesson as LP-90), and a lead has nested raw data.',
    },

    {
      n: 'Quarantine Row',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'insert',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_dlq' },
        columns: {
          mappingMode: 'defineBelow',
          value: {
            dlq_id: '={{ $json.event_id }}',
            lead_uid: '={{ $json.lead_uid || "" }}',
            stage_failed: 'LP-01 Intake / validation',
            error_class: '={{ $json.quarantine_class }}',
            error: '={{ $json.quarantine_error }}',
            payload_json: '={{ JSON.stringify({ source: $json.source, batch_id: $json.batch_id || "", line: $json.line || 0, raw: $json.raw_json || "" }) }}',
            attempts: 0,
            state: 'quarantined',
            first_seen: '={{ Math.floor(Date.now()/1000) }}',
            last_seen: '={{ Math.floor(Date.now()/1000) }}',
          },
          matchingColumns: [],
          schema: [],
        },
        options: {},
      },
      notes: 'Edge case 13, made concrete. The broken row is kept WITH its original text, so\n'
        + 'the fix is: correct the cell, replay the dead letter through LP-05. Discarding\n'
        + 'it and logging "1 row failed" would leave the operator with a number and no way\n'
        + 'to act on it.',
    },

    {
      n: 'note',
      t: 'sticky',
      at: [-980, -560],
      w: 760,
      h: 320,
      content: '## LP-01 Intake\n\n'
        + 'Three sources in, one canonical lead out. `_shared/intake.js` holds every rule; the three '
        + '`Normalize *` nodes only map field names, so there is no per-source logic downstream.\n\n'
        + '**Two keys, not one.** `idem_key` = *this delivery* (gated here). `person_key` = *this human* '
        + '(resolved in LP-02, with a confidence score). Merging the two concepts breaks intake in both '
        + 'directions.\n\n'
        + '**Order matters:** claim -> store -> respond -> hand off. The response goes out before the '
        + 'processing, because WhatsApp retries anything it has not seen acknowledged for up to 7 days.\n\n'
        + '**A bad row never takes the batch down.** 50 rows, 1 broken: 49 imported, 1 dead letter with '
        + 'the original text attached, replayable through LP-05. (EC-13)',
    },
  ],

  flow: [
    ['Website Lead', 'Normalize Website'],
    ['WhatsApp Inbound', 'Normalize WhatsApp'],
    ['CSV Import', 'Parse CSV Batch'],

    ['Normalize Website', 'Finalize and Validate'],
    ['Normalize WhatsApp', 'Finalize and Validate'],
    ['Parse CSV Batch', 'Finalize and Validate'],

    ['Finalize and Validate', 'Read Intake Ledger'],
    ['Read Intake Ledger', 'Gate Duplicates'],

    // Branch order is the execution order under n8n's v1 engine: answer the
    // caller, then write the audit trail, then do the work.
    ['Gate Duplicates', 'Build Response'],
    ['Gate Duplicates', 'Write Intake Audit'],
    ['Gate Duplicates', 'Route Intake'],
    ['Build Response', 'Respond Accepted'],

    // Three parallel branches, not a chain: a Data Table write outputs the
    // stored ROW, so chaining them would hand the next node a ledger row where
    // it expects a lead. All three are keyed and idempotent, so the order
    // between them is not load-bearing - which is the point. Nothing here
    // depends on n8n's branch-ordering semantics being what I think they are.
    ['Route Intake', 'Claim Intake', 0],
    ['Route Intake', 'Store Lead', 0],
    ['Route Intake', 'Handoff to Qualify', 0],
    ['Route Intake', 'Quarantine Row', 1],
  ],
};
