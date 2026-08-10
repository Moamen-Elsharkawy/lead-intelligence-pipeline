/**
 * LP-06 Events and Approvals - everything that happens to a lead AFTER it was
 * routed, and the one human decision the pipeline waits on.
 *
 *   POST /webhook/lp-event     { type, lead_uid, ... }
 *        reply | opt_out | booking | close | sales_action
 *
 *   POST /webhook/lp-approval  { lead_uid, decision: approve|reject, by?, note? }
 *
 * One endpoint for events rather than five, because the shape of the work is
 * identical every time: resolve the lead, decide what changes, cancel what is
 * now pointless, write it to both stores, log it. Five webhooks would be the
 * same five nodes copied five times.
 *
 * Two things worth reading the code for:
 *
 * - **A booking is claimed by its provider id** (`booking:<booking_id>`), so a
 *   webhook delivered twice books once. (EC-11)
 *
 * - **Approval does not reimplement routing.** Approving a VIP flips the state
 *   and hands the lead back to LP-03, which is already idempotent - it finds
 *   the existing opportunity, moves it, assigns it, schedules the cadence and
 *   sends the confirmation. Rewriting that here would be a second copy of the
 *   routing rules that drifts from the first. (EC-12)
 */
module.exports = {
  file: 'LP-06-events-and-approvals',
  name: 'LP-06 Events and Approvals',
  purpose: 'Reply, opt-out, booking, close and sales-action events, plus the VIP approve/reject decision.',
  settings: { errorWorkflow: '@LP-05 Error Handler and DLQ', executionTimeout: 120 },

  nodes: [
    {
      n: 'Event Webhook',
      t: 'webhook',
      p: {
        httpMethod: 'POST',
        path: 'lp-event',
        authentication: 'headerAuth',
        responseMode: 'responseNode',
        options: {},
      },
      creds: { httpHeaderAuth: { name: 'LP Webhook Token (X-LP-Token)' } },
    },
    {
      n: 'Approval Webhook',
      t: 'webhook',
      p: {
        httpMethod: 'POST',
        path: 'lp-approval',
        authentication: 'headerAuth',
        responseMode: 'responseNode',
        options: {},
      },
      creds: { httpHeaderAuth: { name: 'LP Webhook Token (X-LP-Token)' } },
      notes: 'Header auth, the same token as every other endpoint, so the manager approves with\n'
        + 'the curl command included in the alert email.\n\n'
        + 'The honest trade-off: this is not a link you can click from a phone. The two\n'
        + 'production answers are a Slack interactive button or a signed magic link with a\n'
        + 'secret in lp_config, and neither is here because both add a credential or a\n'
        + 'secret that a reviewer cloning this repo would have to create before anything\n'
        + 'works. Named in the design doc under production hardening.',
    },

    {
      n: 'Normalize Event',
      t: 'code',
      code: `
const b = $input.first().json.body || {};
const type = String(b.type || b.event || '').trim().toLowerCase();

const ALLOWED = ['reply', 'opt_out', 'booking', 'close', 'sales_action'];
if (!ALLOWED.includes(type)) {
  return [{ json: { kind: 'event', bad_request: 'type must be one of ' + ALLOWED.join(', '), lead_uid: '' } }];
}
if (!b.lead_uid) {
  return [{ json: { kind: 'event', bad_request: 'lead_uid is required', lead_uid: '' } }];
}

const lead_uid = String(b.lead_uid);
const booking_id = String(b.booking_id || '');

// A booking carries a provider id, so it is claimed by that id and a duplicate
// delivery is recognised however many times it arrives. (EC-11)
// Other events have no provider id, so the key is the content: the same reply
// delivered twice is one event, a second genuine reply is not.
const idem_key = type === 'booking' && booking_id
  ? 'booking:' + booking_id
  : 'event:' + lead_uid + ':' + type + ':' + C.stableHash(C.canonicalJson(b)).slice(0, 12);

return [{ json: {
  kind: 'event',
  type,
  lead_uid,
  idem_key,
  booking_id,
  slot: String(b.slot || b.start || ''),
  outcome: String(b.outcome || '').toLowerCase(),
  note: String(b.note || b.text || '').slice(0, 500),
  actor: String(b.by || b.actor || 'system'),
  raw: b,
} }];
`,
    },

    {
      n: 'Normalize Approval',
      t: 'code',
      code: `
const b = $input.first().json.body || {};
const decision = String(b.decision || '').trim().toLowerCase();

if (!['approve', 'reject'].includes(decision)) {
  return [{ json: { kind: 'approval', bad_request: 'decision must be approve or reject', lead_uid: '' } }];
}
if (!b.lead_uid) {
  return [{ json: { kind: 'approval', bad_request: 'lead_uid is required', lead_uid: '' } }];
}

const lead_uid = String(b.lead_uid);
return [{ json: {
  kind: 'approval',
  type: 'approval_' + decision,
  decision,
  lead_uid,
  // One decision per lead. A second call is answered "already decided" rather
  // than silently overwriting the first - if a manager needs to change their
  // mind, that is a deliberate act with its own audit trail, not an accident
  // caused by a double-clicked link.
  idem_key: 'approval:' + lead_uid,
  note: String(b.note || '').slice(0, 500),
  actor: String(b.by || b.actor || 'manager'),
  raw: b,
} }];
`,
    },

    {
      n: 'Prepare',
      t: 'code',
      code: `
// Both webhooks converge here, so everything below is written once. Only one
// trigger fires per execution, so exactly one normaliser produced this item.
return [{ json: { ...$input.first().json, now: Math.floor(Date.now() / 1000) } }];
`,
    },

    {
      n: 'Read Lead',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'get',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_lead' },
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'lead_uid', condition: 'eq', keyValue: "={{ $json.lead_uid || '__none__' }}" }] },
        returnAll: true,
      },
      alwaysOutputData: true,
      onError: 'continueRegularOutput',
    },

    {
      n: 'Read Event Claim',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'get',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_idem' },
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'idem_key', condition: 'eq', keyValue: "={{ $('Prepare').first().json.idem_key || '__none__' }}" }] },
        returnAll: true,
      },
      alwaysOutputData: true,
      onError: 'continueRegularOutput',
    },

    {
      n: 'Read Stage Map',
      t: 'executeWorkflow',
      p: {
        workflowId: '@LP-90 Odoo Gateway',
        mode: 'once',
        workflowInputs: {
          mappingMode: 'defineBelow',
          value: {
            model: 'crm.stage',
            method: 'search_read',
            args_json: '[[]]',
            kwargs_json: '={{ JSON.stringify({ fields: ["id","name","is_won"], limit: 100 }) }}',
            purpose: 'stage map for an event',
            lead_uid: "={{ $('Prepare').first().json.lead_uid }}",
          },
          matchingColumns: [],
          schema: [],
        },
        options: { waitForSubWorkflow: true },
      },
    },

    {
      n: 'Decide Effect',
      t: 'code',
      code: `
const e = $('Prepare').first().json;
const now = e.now;

const bad = (status, reason) => [{ json: {
  ...e, ok: false, status, reason, apply: false, cancel_jobs: false,
  odoo_change: false, requalify: false,
} }];

if (e.bad_request) return bad(400, e.bad_request);

const lead = $('Read Lead').all().map(i => i.json)
  .find(r => r && r.lead_uid === e.lead_uid && r.source !== undefined);
if (!lead) return bad(404, 'no lead with id ' + e.lead_uid);

const claim = $('Read Event Claim').all().map(i => i.json)
  .find(r => r && r.idem_key === e.idem_key && r.scope !== undefined);
if (claim && claim.state === 'done') {
  // EC-11 for bookings, and the same protection for every other event type.
  return [{ json: { ...e, ok: true, status: 200, reason: 'already processed at ' +
    new Date(Number(claim.completed_at || 0) * 1000).toISOString(),
    duplicate: true, apply: false, cancel_jobs: false, odoo_change: false, requalify: false } }];
}

const gw = $input.first().json;
const stages = {};
for (const s of (gw.ok ? gw.result || [] : [])) stages[String(s.name).trim().toLowerCase()] = Number(s.id);
const wonStage = (gw.ok ? (gw.result || []) : []).find(s => s.is_won);

// --- the effect table ----------------------------------------------------
// Every event's consequences in one readable place, rather than a branch per
// event scattered across the canvas.
const changes = { updated_at: now };
let stage_name = '';
let close = false;
let lost_reason = '';
let cancel_jobs = false;
let cancel_reason = '';
let requalify = false;
let note = '';

switch (e.type) {
  case 'reply':
    // A reply is the goal of the whole follow-up sequence, so the sequence
    // stops the moment it arrives. Continuing to chase someone who answered is
    // the single most common way an automated sequence damages a relationship.
    cancel_jobs = true; cancel_reason = 'replied';
    stage_name = C.STAGES.CONTACTED;
    changes.status = 'active';
    note = 'Lead replied. Follow-up sequence stopped.' + (e.note ? '<br/>' + e.note : '');
    break;

  case 'opt_out':
    cancel_jobs = true; cancel_reason = 'opted_out';
    close = true; lost_reason = C.LOST_REASONS.opted_out;
    changes.consent = 'denied';
    changes.consent_source = 'opt_out_request';
    changes.status = 'closed';
    note = 'Opted out. Consent set to denied and every pending message cancelled.';
    break;

  case 'booking':
    cancel_jobs = true; cancel_reason = 'booked';
    stage_name = C.STAGES.BOOKED;
    changes.status = 'active';
    note = 'Meeting booked' + (e.slot ? ' for ' + e.slot : '') + '. Booking id ' + (e.booking_id || 'not supplied') + '.';
    break;

  case 'close':
    cancel_jobs = true; cancel_reason = 'closed';
    changes.status = 'closed';
    if (e.outcome === 'won') {
      stage_name = C.STAGES.WON;
      note = 'Closed won.' + (e.note ? ' ' + e.note : '');
    } else {
      close = true;
      lost_reason = e.note || C.LOST_REASONS.unqualified_closed;
      note = 'Closed lost.' + (e.note ? ' ' + e.note : '');
    }
    break;

  case 'sales_action':
    // Not a stage change - just proof a human touched it, which is what stops
    // the SLA timer from escalating.
    cancel_reason = 'sales_action';
    note = 'Sales action recorded by ' + e.actor + '.' + (e.note ? ' ' + e.note : '');
    break;

  case 'approval_approve':
    if (lead.approval_state === 'rejected') return bad(409, 'this lead was already rejected');
    changes.approval_state = 'approved';
    changes.approval_by = e.actor;
    changes.band = 'qualified';
    // Handed back to LP-03 rather than re-implemented here.
    requalify = true;
    note = 'VIP approved by ' + e.actor + '.' + (e.note ? ' ' + e.note : '');
    break;

  case 'approval_reject':
    if (lead.approval_state === 'approved') return bad(409, 'this lead was already approved');
    changes.approval_state = 'rejected';
    changes.approval_by = e.actor;
    changes.status = 'closed';
    cancel_jobs = true; cancel_reason = 'approval_rejected';
    close = true; lost_reason = C.LOST_REASONS.vip_rejected;
    note = 'VIP rejected by ' + e.actor + '. All outbound stopped.' + (e.note ? ' ' + e.note : '');
    break;
}

// --- the Odoo write ------------------------------------------------------
const values = {};
if (close) { values.active = false; values.probability = 0; }
if (stage_name) {
  const id = stage_name === C.STAGES.WON && wonStage ? Number(wonStage.id) : stages[stage_name.toLowerCase()];
  if (id) { values.stage_id = id; if (stage_name === C.STAGES.WON) values.probability = 100; }
}
const odoo_id = Number(lead.odoo_lead_id || 0);
const odoo_change = odoo_id > 0 && Object.keys(values).length > 0;

if (stage_name) changes.odoo_stage = close ? 'Lost' : stage_name;
if (close) changes.odoo_stage = 'Lost';

return [{ json: {
  ...e,
  ok: true,
  status: 200,
  duplicate: false,
  reason: note,
  apply: true,
  lead_row: { ...lead, ...changes },
  cancel_jobs,
  // A sales action stops only the SLA clock. A reply stops everything.
  cancel_scope: e.type === 'sales_action' ? 'sla' : 'all',
  cancel_reason,
  odoo_change,
  odoo_id,
  odoo_args_json: JSON.stringify([[odoo_id], values]),
  odoo_note: note,
  requalify,
  stage_name,
  closed: close,
  lost_reason,
} }];
`,
    },

    // --- answer first ------------------------------------------------------
    {
      n: 'Build Event Response',
      t: 'code',
      code: `
// Read the decision by name, not from $input: this node now sits AFTER the
// lead write, so its input is a Data Table result, not the decision.
const d = $('Decide Effect').first().json;
return [{ json: {
  ok: !!d.ok,
  status: d.status || 200,
  lead_uid: d.lead_uid || '',
  event: d.type || '',
  duplicate: !!d.duplicate,
  applied: !!d.apply,
  detail: d.reason || '',
  cancelled_followups: !!d.cancel_jobs,
  odoo_updated: !!d.odoo_change,
  requalified: !!d.requalify,
  execution_id: String($execution.id || ''),
} }];
`,
    },
    {
      n: 'Respond Event',
      t: 'respond',
      p: {
        respondWith: 'json',
        responseBody: '={{ JSON.stringify($json) }}',
        options: { responseCode: '={{ $json.status }}' },
      },
      notes: 'A duplicate booking answers 200 with duplicate:true, not an error. A provider that\n'
        + 'gets an error back re-delivers, and re-delivering something already handled\n'
        + 'correctly is how a retry storm starts.',
    },

    {
      n: 'Applies?',
      t: 'if',
      p: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          combinator: 'and',
          conditions: [{
            id: 'applies',
            leftValue: '={{ $json.apply }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          }],
        },
        options: {},
      },
      notes: 'One gate in front of every side effect, so a 404, a 400 or a duplicate answers the\n'
        + 'caller and then stops. Without it each of the six writes below would have to carry\n'
        + 'its own guard, and the first one someone forgot would try to upsert an undefined\n'
        + 'lead row.',
    },

    // --- cancel what is now pointless --------------------------------------
    {
      n: 'Read Lead Jobs',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'get',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_jobs' },
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'lead_uid', condition: 'eq', keyValue: '={{ $json.lead_uid }}' }] },
        returnAll: true,
      },
      alwaysOutputData: true,
      onError: 'continueRegularOutput',
    },

    {
      n: 'Cancel Jobs',
      t: 'code',
      code: `
const d = $('Decide Effect').first().json;
if (!d.apply || !d.cancel_jobs) return [];

const now = d.now;
const jobs = $input.all().map(i => i.json)
  .filter(r => r && r.job_id && (r.state === 'pending' || r.state === 'inflight'));

// A sales action only stops the SLA clock; the nurture sequence carries on.
const targets = d.cancel_scope === 'sla' ? jobs.filter(j => j.job_type === 'sla') : jobs;
if (!targets.length) return [];

// EDGE CASE 10 has two halves and this is the first: cancel the queue rows.
// The second half is in LP-92, which re-reads the row immediately before
// sending - because a job already claimed by a tick is past this point.
return targets.map(j => ({ json: {
  ...j,
  state: 'cancelled',
  cancel_reason: d.cancel_reason,
  result: 'cancelled by ' + d.type + ' at ' + new Date(now * 1000).toISOString(),
} }));
`,
    },

    {
      n: 'Write Cancelled Jobs',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'upsert',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_jobs' },
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'job_id', condition: 'eq', keyValue: '={{ $json.job_id }}' }] },
        columns: {
          mappingMode: 'defineBelow',
          value: {
            job_id: '={{ $json.job_id }}',
            lead_uid: '={{ $json.lead_uid }}',
            job_type: '={{ $json.job_type }}',
            step: '={{ $json.step }}',
            template: '={{ $json.template }}',
            due_at: '={{ $json.due_at }}',
            state: 'cancelled',
            attempts: '={{ $json.attempts }}',
            claimed_at: '={{ $json.claimed_at }}',
            result: '={{ $json.result }}',
            cancel_reason: '={{ $json.cancel_reason }}',
          },
          matchingColumns: ['job_id'],
          schema: [],
        },
        options: {},
      },
    },

    // --- persist -----------------------------------------------------------
    {
      n: 'Apply To Lead',
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
            lead_uid: '={{ $json.lead_row.lead_uid }}',
            source: '={{ $json.lead_row.source }}',
            source_ref: '={{ $json.lead_row.source_ref }}',
            received_at: '={{ $json.lead_row.received_at }}',
            full_name: '={{ $json.lead_row.full_name }}',
            email_raw: '={{ $json.lead_row.email_raw }}',
            email_norm: '={{ $json.lead_row.email_norm }}',
            phone_raw: '={{ $json.lead_row.phone_raw }}',
            phone_e164: '={{ $json.lead_row.phone_e164 }}',
            phone_key: '={{ $json.lead_row.phone_key }}',
            country: '={{ $json.lead_row.country }}',
            company: '={{ $json.lead_row.company }}',
            domain: '={{ $json.lead_row.domain }}',
            service_interest: '={{ $json.lead_row.service_interest }}',
            free_text: '={{ $json.lead_row.free_text }}',
            consent: '={{ $json.lead_row.consent }}',
            consent_source: '={{ $json.lead_row.consent_source }}',
            score: '={{ $json.lead_row.score }}',
            score_breakdown_json: '={{ $json.lead_row.score_breakdown_json }}',
            band: '={{ $json.lead_row.band }}',
            ai_status: '={{ $json.lead_row.ai_status }}',
            ai_intent: '={{ $json.lead_row.ai_intent }}',
            ai_urgency: '={{ $json.lead_row.ai_urgency }}',
            ai_signals: '={{ $json.lead_row.ai_signals }}',
            ai_reason: '={{ $json.lead_row.ai_reason }}',
            ai_confidence: '={{ $json.lead_row.ai_confidence }}',
            owner_id: '={{ $json.lead_row.owner_id }}',
            assign_rung: '={{ $json.lead_row.assign_rung }}',
            odoo_lead_id: '={{ $json.lead_row.odoo_lead_id }}',
            odoo_stage: '={{ $json.lead_row.odoo_stage }}',
            approval_state: '={{ $json.lead_row.approval_state }}',
            approval_by: '={{ $json.lead_row.approval_by }}',
            status: '={{ $json.lead_row.status }}',
            merged_into: '={{ $json.lead_row.merged_into }}',
            raw_json: '={{ $json.lead_row.raw_json }}',
            updated_at: '={{ $json.lead_row.updated_at }}',
          },
          matchingColumns: ['lead_uid'],
          schema: [],
        },
        options: {},
      },
    },

    {
      n: 'Claim Event',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'upsert',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_idem' },
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'idem_key', condition: 'eq', keyValue: '={{ $json.idem_key }}' }] },
        columns: {
          mappingMode: 'defineBelow',
          value: {
            idem_key: '={{ $json.idem_key }}',
            scope: '={{ $json.kind === "approval" ? "approval" : ($json.type === "booking" ? "booking" : "event") }}',
            lead_uid: '={{ $json.lead_uid }}',
            state: 'done',
            result_ref: '={{ $json.type }}',
            claimed_at: '={{ $json.now }}',
            completed_at: '={{ $json.now }}',
            attempts: 1,
          },
          matchingColumns: ['idem_key'],
          schema: [],
        },
        options: {},
      },
      notes: 'Written as `done` in one step rather than claimed-then-completed. An event is a\n'
        + 'fact that already happened somewhere else - there is no half-applied state to\n'
        + 'recover, unlike a CRM write which can succeed on their side and fail on ours.',
    },

    {
      n: 'Write Event Audit',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'insert',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_audit' },
        columns: {
          mappingMode: 'defineBelow',
          value: {
            event_id: '={{ $json.idem_key + ":" + $json.now }}',
            lead_uid: '={{ $json.lead_uid }}',
            ts: '={{ $json.now }}',
            workflow: 'LP-06 Events and Approvals',
            execution_id: '={{ $execution.id }}',
            type: '={{ $json.kind === "approval" ? "approval_decided" : ($json.cancel_jobs ? "job_cancelled" : "stage_changed") }}',
            decision: '={{ $json.type + (($json.stage_name) ? " -> " + $json.stage_name : "") + ($json.closed ? " (closed: " + $json.lost_reason + ")" : "") }}',
            detail_json: '={{ JSON.stringify({ actor: $json.actor, note: $json.note || "", detail: $json.reason, cancelled: $json.cancel_jobs ? $json.cancel_scope : "none", odoo_updated: $json.odoo_change, requalified: $json.requalify, booking_id: $json.booking_id || "" }) }}',
          },
          matchingColumns: [],
          schema: [],
        },
        options: {},
      },
      onError: 'continueRegularOutput',
    },

    // --- push it to Odoo ---------------------------------------------------
    {
      n: 'Odoo Change?',
      t: 'if',
      p: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          combinator: 'and',
          conditions: [{
            id: 'odoo-change',
            leftValue: '={{ $json.odoo_change }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          }],
        },
        options: {},
      },
    },

    {
      n: 'Apply Odoo Change',
      t: 'executeWorkflow',
      p: {
        workflowId: '@LP-90 Odoo Gateway',
        mode: 'once',
        workflowInputs: {
          mappingMode: 'defineBelow',
          value: {
            model: 'crm.lead',
            method: 'write',
            args_json: '={{ $json.odoo_args_json }}',
            kwargs_json: '{}',
            purpose: "={{ 'event: ' + $json.type }}",
            lead_uid: '={{ $json.lead_uid }}',
          },
          matchingColumns: [],
          schema: [],
        },
        options: { waitForSubWorkflow: true },
      },
    },

    {
      n: 'Note On Odoo',
      t: 'executeWorkflow',
      p: {
        workflowId: '@LP-90 Odoo Gateway',
        mode: 'once',
        workflowInputs: {
          mappingMode: 'defineBelow',
          value: {
            model: 'crm.lead',
            method: 'message_post',
            args_json: "={{ JSON.stringify([[ $('Decide Effect').first().json.odoo_id ]]) }}",
            kwargs_json: "={{ JSON.stringify({ body: $('Decide Effect').first().json.odoo_note, message_type: 'comment' }) }}",
            purpose: 'event note',
            lead_uid: "={{ $('Decide Effect').first().json.lead_uid }}",
          },
          matchingColumns: [],
          schema: [],
        },
        options: { waitForSubWorkflow: false },
      },
      notes: 'Posted after the field write, so a salesperson opening the record sees the change\n'
        + 'and the reason for it side by side. Not waited on - a missing note must never fail\n'
        + 'an event that already happened.',
    },

    // --- an approved VIP goes back through routing --------------------------
    {
      n: 'Requalify?',
      t: 'if',
      p: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          combinator: 'and',
          conditions: [{
            id: 'requalify',
            leftValue: '={{ $json.requalify }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          }],
        },
        options: {},
      },
    },

    {
      n: 'Re-enter Routing',
      t: 'executeWorkflow',
      p: {
        workflowId: '@LP-03 Route and Sync',
        mode: 'once',
        workflowInputs: {
          mappingMode: 'defineBelow',
          value: {
            verdict_json: `={{ JSON.stringify({
  lead: {
    ...$json.lead_row,
    person_key: $json.lead_row.phone_key || $json.lead_row.email_norm || ('uid:' + $json.lead_row.lead_uid),
    validation_state: 'ok',
    validation_missing: '',
    urgency: $json.lead_row.ai_urgency || 'unknown',
    budget_band: 'unknown',
    sub_source: ''
  },
  lead_uid: $json.lead_uid,
  score: Number($json.lead_row.score || 0),
  rule_band: 'qualified',
  band: 'qualified',
  outcome: 'vip_approved',
  band_reason: 'approved by ' + $json.actor,
  strategic: true,
  needs_approval: false,
  score_breakdown_json: $json.lead_row.score_breakdown_json || '[]',
  enrich: { found: false, source: 'not re-run on approval' },
  enrich_status: 'skipped',
  ai_status: $json.lead_row.ai_status || 'skipped',
  ai_intent: $json.lead_row.ai_intent || '',
  ai_urgency: $json.lead_row.ai_urgency || '',
  ai_signals: $json.lead_row.ai_signals || '',
  ai_objections: '',
  ai_reason: $json.lead_row.ai_reason || '',
  ai_confidence: Number($json.lead_row.ai_confidence || 0),
  ai_note: '',
  qualified_at: $json.now
}) }}`,
          },
          matchingColumns: [],
          schema: [],
        },
        options: { waitForSubWorkflow: false },
      },
      notes: 'EDGE CASE 12, the approve half. The verdict is rebuilt from the stored lead and\n'
        + 'sent back through the SAME routing workflow, which is already idempotent: it finds\n'
        + 'the existing opportunity by external key, moves it from Awaiting Approval to\n'
        + 'Qualified, assigns an owner, schedules the cadence and sends the confirmation that\n'
        + 'was withheld while the decision was pending.\n\n'
        + 'Enrichment and the AI are deliberately not re-run. Nothing about the lead changed;\n'
        + 'only the permission to act on it did, and paying a vendor and a model again to\n'
        + 'learn the same thing is waste.',
    },

    {
      n: 'note',
      t: 'sticky',
      at: [-1020, -620],
      w: 800,
      h: 330,
      content: '## LP-06 Events and Approvals\n\n'
        + '`POST /webhook/lp-event` - `reply | opt_out | booking | close | sales_action`\n'
        + '`POST /webhook/lp-approval` - `{"lead_uid":"...","decision":"approve|reject"}`\n\n'
        + '**One effect table**, not a branch per event. Each event says what stage it moves to, what '
        + 'it cancels, and whether it closes the opportunity - in one readable object.\n\n'
        + '**A booking is claimed by its provider id**, so a webhook delivered twice books once, and '
        + 'the second delivery gets a 200 with `duplicate:true` rather than an error that would make '
        + 'the provider retry. **(EC-11)**\n\n'
        + '**Approve does not reimplement routing** - it flips the state and hands the lead back to '
        + 'LP-03, which is idempotent and already knows how to move, assign, schedule and confirm. '
        + '**Reject stops all outbound and closes the opportunity as lost. (EC-12)**\n\n'
        + '**A sales action cancels only the SLA clock**; a reply cancels everything. **(EC-10)**',
    },
  ],

  flow: [
    ['Event Webhook', 'Normalize Event'],
    ['Approval Webhook', 'Normalize Approval'],
    ['Normalize Event', 'Prepare'],
    ['Normalize Approval', 'Prepare'],
    ['Prepare', 'Read Lead'],
    ['Read Lead', 'Read Event Claim'],
    ['Read Event Claim', 'Read Stage Map'],
    ['Read Stage Map', 'Decide Effect'],

    ['Decide Effect', 'Applies?'],

    // The response comes AFTER the lead write, and that ordering is the whole
    // point of this arrangement.
    //
    // It used to be a sibling branch: answer the caller on one side, do the
    // work on the other. That makes the 200 mean "accepted", not "applied" -
    // and an opt-out that is merely accepted is not an opt-out. A tick firing
    // in the gap between the response and the write read the lead as still
    // consenting and sent the follow-up. EC-10 caught it doing exactly that.
    //
    // Only the lead write is in front of the response, not the whole fan-out:
    // consent=denied on the lead row is the first stop condition LP-92
    // checks, so once that row is written no message can escape. Job
    // cancellation and the Odoo write are belt-and-braces and stay behind the
    // response, which keeps it fast.
    ['Applies?', 'Apply To Lead', 0],
    ['Apply To Lead', 'Build Event Response'],
    ['Applies?', 'Build Event Response', 1], // nothing to apply: answer and stop
    ['Build Event Response', 'Respond Event'],

    ['Applies?', 'Read Lead Jobs', 0],
    ['Read Lead Jobs', 'Cancel Jobs'],
    ['Cancel Jobs', 'Write Cancelled Jobs'],

    ['Applies?', 'Claim Event', 0],
    ['Applies?', 'Write Event Audit', 0],
    ['Applies?', 'Odoo Change?', 0],
    ['Odoo Change?', 'Apply Odoo Change', 0],
    ['Apply Odoo Change', 'Note On Odoo'],
    ['Applies?', 'Requalify?', 0],
    ['Requalify?', 'Re-enter Routing', 0],
  ],
};
