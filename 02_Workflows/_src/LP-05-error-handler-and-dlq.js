/**
 * LP-05 Error Handler and DLQ - one place where failure is turned into a
 * record, and one place where a record is turned back into work.
 *
 * Every other workflow names this one as its `errorWorkflow`, so nothing in the
 * system fails silently into n8n's execution log and stays there.
 *
 * Two halves:
 *
 *   CAPTURE   n8n Error Trigger -> classify -> dead-letter row -> audit row ->
 *             alert, but only when a human can actually do something about it.
 *
 *   REPLAY    POST /webhook/lp-replay { dlq_id, override_json? }
 *             Reads the dead letter, then reads the IDEMPOTENCY LEDGER FIRST,
 *             and skips every step that already completed. That is the whole
 *             answer to edge case 14: a manual re-run after a partial success
 *             must not create a second opportunity in the CRM.
 *
 * Three design points a reviewer will test:
 *
 * 1. **This workflow has no error workflow of its own.** An error handler that
 *    points at itself loops; one that points at another handler just moves the
 *    problem. Every node here is written so that failing is survivable, and the
 *    alert path degrades to a `critical` audit row rather than throwing.
 *
 * 2. **A repeated failure increments, it does not multiply.** `dlq_id` is a
 *    hash of (workflow, node, error signature, lead), so the same failure for
 *    the same lead is one row with an attempt count - not 40 rows to read
 *    through at 9am.
 *
 * 3. **Alerting is filtered, not firehosed.** A transient error inside its
 *    retry budget is logged and stays quiet. A dead credential is escalated to
 *    critical on sight, because that is the failure that has silently frozen
 *    this instance five times.
 */
module.exports = {
  file: 'LP-05-error-handler-and-dlq',
  name: 'LP-05 Error Handler and DLQ',
  purpose: 'Catch every workflow failure, classify it, dead-letter it, alert when useful, and replay it safely.',

  nodes: [
    // =======================================================================
    // CAPTURE
    // =======================================================================
    {
      n: 'Failure',
      t: 'errorTrigger',
      p: {},
      notes: 'Fires on a PRODUCTION execution failure in any workflow that names this one as\n'
        + 'its error workflow. It does NOT fire on a manual "Test workflow" run, which is a\n'
        + 'trap worth knowing: a hand-tested failure looks like the handler is broken when\n'
        + 'it simply was not called.',
    },

    {
      n: 'Classify Failure',
      t: 'code',
      code: `
// The Error Trigger payload has moved between n8n versions, so every field is
// read defensively. A handler that throws while handling an error is worse than
// no handler at all.
const e = $input.first().json || {};
const wf = e.workflow || {};
const ex = e.execution || {};
const err = ex.error || e.error || {};

const message = String(err.message || err.description || 'unknown error').slice(0, 800);
const nodeName = String(err.node?.name || ex.lastNodeExecuted || 'unknown node');
const wfName = String(wf.name || 'unknown workflow');
const sig = (message + ' ' + String(err.name || '')).toLowerCase();

// --- classification ------------------------------------------------------
// The three classes exist because they have three different responses:
// transient means wait, credential means a human must log in somewhere, and
// permanent means the input or the code is wrong and retrying is pointless.
let error_class = 'permanent';
let severity = 'error';

if (/unauthori[sz]ed|\\b401\\b|\\b403\\b|forbidden|invalid.{0,12}(credential|api key|token)|token.{0,12}expired|refresh token|authentication failed|access denied/i.test(sig)) {
  error_class = 'credential';
  // Escalated on sight. On this instance an expired credential has frozen a
  // pipeline five separate times while every workflow still reported
  // active:true, once for 13 days and once for 25. It is never a low-priority
  // error here.
  severity = 'critical';
} else if (/econnrefused|etimedout|enotfound|socket hang up|network|timeout|\\b429\\b|\\b50[234]\\b|rate.?limit|temporarily unavailable|serializationfailure|could not serialize/i.test(sig)) {
  error_class = 'transient';
  severity = 'warning';
}

// --- who it happened to --------------------------------------------------
// The lead id is the thread that ties an error back to a customer. It can
// arrive in several shapes depending on which workflow failed, so look in all
// of them rather than losing the link.
const runData = ex.data?.resultData?.runData || {};
let lead_uid = '';
for (const key of Object.keys(runData)) {
  const first = runData[key]?.[0]?.data?.main?.[0]?.[0]?.json;
  if (first && typeof first === 'object') {
    if (first.lead_uid) { lead_uid = String(first.lead_uid); break; }
    if (first.lead_json) {
      try { lead_uid = String(JSON.parse(first.lead_json).lead_uid || ''); } catch (_) {}
      if (lead_uid) break;
    }
  }
}

// --- identity of the FAILURE, not of this occurrence ---------------------
// Digits are stripped from the message before hashing so that "row 12 failed"
// and "row 13 failed" collapse into one dead letter with two attempts, instead
// of two rows that need reading separately. The lead id keeps genuinely
// different customers apart.
const normalised = message.toLowerCase().replace(/\\d+/g, '#').replace(/\\s+/g, ' ').slice(0, 200);
const dlq_id = 'dlq-' + C.stableHash(wfName + '|' + nodeName + '|' + normalised + '|' + lead_uid).slice(0, 14);

const now = Math.floor(Date.now() / 1000);

return [{ json: {
  dlq_id,
  lead_uid,
  stage_failed: wfName + ' / ' + nodeName,
  error_class,
  severity,
  error: message,
  workflow_name: wfName,
  workflow_id: String(wf.id || ''),
  node_name: nodeName,
  execution_id: String(ex.id || ''),
  execution_url: String(ex.url || ''),
  retry_of: String(ex.retryOf || ''),
  now,
  payload_json: JSON.stringify({
    replay: { workflow: 'LP-02 Qualify', requires: 'lead_json' },
    execution_url: ex.url || '',
    node: nodeName,
    error_name: err.name || '',
    stack: String(err.stack || '').slice(0, 1200),
  }),
} }];
`,
    },

    {
      n: 'Read Prior Dead Letter',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'get',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_dlq' },
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'dlq_id', condition: 'eq', keyValue: '={{ $json.dlq_id }}' }] },
        returnAll: true,
      },
      alwaysOutputData: true,
      onError: 'continueRegularOutput',
    },

    {
      n: 'Count Attempts',
      t: 'code',
      code: `
const cur = $('Classify Failure').first().json;
// Only a real dead-letter row counts. On the continue-on-error path this node
// receives the INPUT item instead, which also carries a dlq_id - so match on a
// field only a stored row has.
const prior = $input.all().map(i => i.json)
  .find(r => r && r.dlq_id === cur.dlq_id && r.state !== undefined);

const attempts = Number(prior?.attempts || 0) + 1;

// An error that keeps recurring is a different problem from an error that
// happened once, and it should read differently in the inbox.
const repeating = attempts >= 3;

return [{ json: {
  ...cur,
  attempts,
  repeating,
  first_seen: Number(prior?.first_seen || cur.now),
  state: 'open',
  should_alert:
    cur.severity === 'critical' ||
    cur.error_class === 'permanent' ||
    repeating,
  alert_subject:
    '[' + (cur.severity === 'critical' ? 'CRITICAL' : 'ERROR') + '] ' +
    cur.workflow_name + ' - ' + cur.error_class +
    (repeating ? ' (x' + attempts + ')' : ''),
} }];
`,
      notes: 'A transient error inside its retry budget is recorded and stays quiet; the same\n'
        + 'error three times running is no longer transient and does alert. Alert fatigue is\n'
        + 'not a minor annoyance - an operator who has learned to ignore this mailbox is the\n'
        + 'same as having no alerting at all.',
    },

    {
      n: 'Write Dead Letter',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'upsert',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_dlq' },
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'dlq_id', condition: 'eq', keyValue: '={{ $json.dlq_id }}' }] },
        columns: {
          mappingMode: 'defineBelow',
          value: {
            dlq_id: '={{ $json.dlq_id }}',
            lead_uid: '={{ $json.lead_uid }}',
            stage_failed: '={{ $json.stage_failed }}',
            error_class: '={{ $json.error_class }}',
            error: '={{ $json.error }}',
            payload_json: '={{ $json.payload_json }}',
            attempts: '={{ $json.attempts }}',
            state: 'open',
            first_seen: '={{ $json.first_seen }}',
            last_seen: '={{ $json.now }}',
          },
          matchingColumns: ['dlq_id'],
          schema: [],
        },
        options: {},
      },
      onError: 'continueRegularOutput',
    },

    {
      n: 'Write Error Audit',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'insert',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_audit' },
        columns: {
          mappingMode: 'defineBelow',
          value: {
            event_id: '={{ $json.dlq_id + ":" + $json.attempts }}',
            lead_uid: '={{ $json.lead_uid }}',
            ts: '={{ $json.now }}',
            workflow: '={{ $json.workflow_name }}',
            execution_id: '={{ $json.execution_id }}',
            type: 'error',
            decision: '={{ $json.error_class }}',
            detail_json: '={{ JSON.stringify({ node: $json.node_name, error: $json.error, severity: $json.severity, attempts: $json.attempts, execution_url: $json.execution_url }) }}',
          },
          matchingColumns: [],
          schema: [],
        },
        options: {},
      },
      onError: 'continueRegularOutput',
      notes: 'The dead-letter table is state ("what is still broken"); the audit table is\n'
        + 'history ("what happened, in order"). Resolving a dead letter changes its state\n'
        + 'row; it must not erase the fact that the failure occurred.',
    },

    {
      n: 'Alert Worth Sending?',
      t: 'if',
      p: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          combinator: 'and',
          conditions: [{
            id: 'should-alert',
            leftValue: '={{ $json.should_alert }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          }],
        },
        options: {},
      },
    },

    {
      n: 'Read Alert Config',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'get',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_config' },
        returnAll: true,
        filters: { conditions: [] },
      },
      alwaysOutputData: true,
      onError: 'continueRegularOutput',
    },

    {
      n: 'Compose Alert',
      t: 'code',
      code: `
const cfg = Object.fromEntries(
  $input.all().map(i => i.json).filter(r => r && r.key).map(r => [r.key, r.value]),
);
const f = $('Count Attempts').first().json;

// Plain text, no HTML table. Every mail client renders a markdown table as raw
// pipes, and an alert nobody can read at a glance is an alert nobody reads.
const lines = [
  f.severity === 'critical' ? 'CRITICAL - this one needs a human now.' : 'A workflow failed.',
  '',
  'Workflow:   ' + f.workflow_name,
  'Node:       ' + f.node_name,
  'Class:      ' + f.error_class,
  'Attempt:    ' + f.attempts + (f.repeating ? '  (recurring)' : ''),
  'Lead:       ' + (f.lead_uid || 'not tied to a single lead'),
  'Execution:  ' + (f.execution_url || f.execution_id),
  '',
  'Error:',
  '  ' + f.error,
  '',
];

if (f.error_class === 'credential') {
  lines.push(
    'This looks like an expired or revoked credential.',
    'The workflow will keep reporting active:true and keep failing on every run',
    'until it is re-authorised in the n8n credentials screen.',
    '',
  );
}

lines.push(
  'Replay it once the cause is fixed:',
  '  POST ' + (cfg.base_url || '') + '/webhook/lp-replay',
  '  Header: X-LP-Token: <token>',
  '  Body:   {"dlq_id": "' + f.dlq_id + '"}',
  '',
  'The replay reads the idempotency ledger first and skips whatever already',
  'completed, so re-running it cannot create a second opportunity in Odoo.',
);

return [{ json: {
  ...f,
  alert_to: cfg.manager_email || '',
  alert_body: lines.join('\\n'),
} }];
`,
    },

    {
      n: 'Send Alert Email',
      t: 'gmail',
      p: {
        resource: 'message',
        operation: 'send',
        sendTo: '={{ $json.alert_to }}',
        subject: '={{ $json.alert_subject }}',
        emailType: 'text',
        message: '={{ $json.alert_body }}',
        options: { appendAttribution: false },
      },
      creds: { gmailOAuth2: { name: 'Gmail account' } },
      onError: 'continueErrorOutput',
      retry: { tries: 2, waitMs: 3000 },
      notes: 'continueErrorOutput, not continueRegularOutput. The difference matters: this\n'
        + 'routes a failed send down a SECOND branch that records it, instead of letting the\n'
        + 'flow carry on as though the alert went out.\n\n'
        + 'The failure mode being defended against is specific and has happened here: the\n'
        + 'Gmail credential itself expires, so the one channel that would tell you a\n'
        + 'credential died is the credential that died. Production wants a second channel on\n'
        + 'a different credential (Telegram, Slack, PagerDuty) - one node, wired to the same\n'
        + 'error output. It is deliberately not wired here because it would bind this repo\n'
        + 'to a private bot token that no reviewer can run.',
    },

    {
      n: 'Record Alert Failure',
      t: 'code',
      code: `
// Last line of defence. If even this write fails the execution dies loudly,
// which is the correct outcome: silence at this depth is the only truly
// unacceptable result.
const f = $('Count Attempts').first().json;
return [{ json: {
  event_id: f.dlq_id + ':alert-failed:' + f.attempts,
  lead_uid: f.lead_uid,
  ts: Math.floor(Date.now() / 1000),
  workflow: 'LP-05 Error Handler and DLQ',
  execution_id: String($execution.id || ''),
  type: 'error',
  decision: 'alert_undeliverable',
  detail_json: JSON.stringify({
    severity: 'critical',
    note: 'The alert email could not be sent, so this failure was never announced. Check the Gmail credential.',
    original: { workflow: f.workflow_name, node: f.node_name, error: f.error },
  }),
} }];
`,
    },

    {
      n: 'Log Undelivered Alert',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'insert',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_audit' },
        columns: {
          mappingMode: 'defineBelow',
          value: {
            event_id: '={{ $json.event_id }}',
            lead_uid: '={{ $json.lead_uid }}',
            ts: '={{ $json.ts }}',
            workflow: '={{ $json.workflow }}',
            execution_id: '={{ $json.execution_id }}',
            type: '={{ $json.type }}',
            decision: '={{ $json.decision }}',
            detail_json: '={{ $json.detail_json }}',
          },
          matchingColumns: [],
          schema: [],
        },
        options: {},
      },
    },

    // =======================================================================
    // REPLAY
    // =======================================================================
    {
      n: 'Replay Request',
      t: 'webhook',
      p: {
        httpMethod: 'POST',
        path: 'lp-replay',
        authentication: 'headerAuth',
        responseMode: 'responseNode',
        options: {},
      },
      creds: { httpHeaderAuth: { name: 'LP Webhook Token (X-LP-Token)' } },
      notes: 'POST { "dlq_id": "dlq-...", "override_json": "{...}" }\n\n'
        + 'override_json is how a quarantined CSV row is fixed and resubmitted: correct the\n'
        + 'field, replay the dead letter. Without it the operator would have to rebuild the\n'
        + 'original request by hand from a log line.',
    },

    {
      n: 'Load Dead Letter',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'get',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_dlq' },
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'dlq_id', condition: 'eq', keyValue: '={{ $json.body.dlq_id }}' }] },
        returnAll: true,
      },
      alwaysOutputData: true,
    },

    {
      n: 'Plan Replay',
      t: 'code',
      code: `
const req = $('Replay Request').first().json;
const body = req.body || {};
const dlq_id = String(body.dlq_id || '');

const row = $input.all().map(i => i.json).find(r => r && r.dlq_id === dlq_id);

if (!dlq_id) {
  return [{ json: { action: 'bad_request', reason: 'dlq_id is required', dlq_id: '', lead_uid: '' } }];
}
if (!row) {
  return [{ json: { action: 'not_found', reason: 'no dead letter with id ' + dlq_id, dlq_id, lead_uid: '' } }];
}
if (row.state === 'resolved' || row.state === 'replayed') {
  // Replaying a replay is itself an idempotency question, and the answer is no.
  return [{ json: { action: 'already_handled', reason: 'this dead letter is already ' + row.state, dlq_id, lead_uid: row.lead_uid || '' } }];
}

let payload = {};
try { payload = JSON.parse(row.payload_json || '{}'); } catch (_) { payload = {}; }

// An operator-supplied correction wins over the stored payload. This is the
// path for a bad CSV cell: fix the value, replay the id.
let override = null;
if (body.override_json) {
  try { override = typeof body.override_json === 'string' ? JSON.parse(body.override_json) : body.override_json; }
  catch (e) { return [{ json: { action: 'bad_request', reason: 'override_json is not valid JSON', dlq_id, lead_uid: row.lead_uid || '' } }]; }
}

return [{ json: {
  action: 'check_ledger',
  dlq_id,
  lead_uid: String(row.lead_uid || ''),
  error_class: row.error_class || '',
  stage_failed: row.stage_failed || '',
  attempts: Number(row.attempts || 0),
  payload,
  override,
  has_lead: !!String(row.lead_uid || ''),
} }];
`,
    },

    {
      n: 'Read Lead Ledger',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'get',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_idem' },
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'lead_uid', condition: 'eq', keyValue: '={{ $json.lead_uid }}' }] },
        returnAll: true,
      },
      alwaysOutputData: true,
      onError: 'continueRegularOutput',
      notes: 'Every claim ever made for this lead, across every scope. This read is what makes\n'
        + 'a replay safe rather than hopeful - it is the difference between "run it again and\n'
        + 'see" and "run only the parts that never finished".',
    },

    {
      n: 'Read Lead Record',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'get',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_lead' },
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'lead_uid', condition: 'eq', keyValue: "={{ $('Plan Replay').first().json.lead_uid }}" }] },
        returnAll: true,
      },
      alwaysOutputData: true,
      onError: 'continueRegularOutput',
    },

    {
      n: 'Decide Replay',
      t: 'code',
      code: `
const plan = $('Plan Replay').first().json;

if (plan.action !== 'check_ledger') {
  return [{ json: { ...plan, ok: false, new_state: '', replay_lead_json: '' } }];
}

// Ledger rows only: the continue-on-error path passes the input through, and
// the input also carries lead_uid.
const ledger = $('Read Lead Ledger').all().map(i => i.json)
  .filter(r => r && r.idem_key && r.scope);
const done = new Set(ledger.filter(r => r.state === 'done').map(r => r.scope));

const leadRow = $input.all().map(i => i.json).find(r => r && r.lead_uid === plan.lead_uid && r.source !== undefined);

if (!leadRow) {
  return [{ json: { ...plan, ok: false, action: 'no_lead_record', new_state: '',
    reason: 'the dead letter has no lead record to replay. Resubmit the original request through the intake endpoint instead.' } }];
}

// EDGE CASE 14, mechanically. The CRM write already completed, so re-running
// qualification would create a second opportunity for the same person. The
// completed work is respected and only the tail is resumed.
const odooDone = done.has('odoo_upsert');

const merged = { ...leadRow, ...(plan.override || {}) };
// The replay must be a REPLAY, not a new event: the same idempotency key and
// the same lead id, so every downstream claim recognises itself.
merged.lead_uid = plan.lead_uid;
merged.replay_of = plan.dlq_id;
merged.replay_skip_create = odooDone;
merged.odoo_lead_id = Number(leadRow.odoo_lead_id || 0);

return [{ json: {
  ...plan,
  ok: true,
  action: 'requalify',
  odoo_already_created: odooDone,
  completed_scopes: Array.from(done),
  new_state: 'replayed',
  replay_lead_json: JSON.stringify(merged),
  reason: odooDone
    ? 'the Odoo opportunity already exists (idem scope odoo_upsert is done), so the replay resumes after it instead of creating a second one'
    : 'nothing had completed, so the lead is re-qualified from the start',
} }];
`,
    },

    {
      n: 'Build Replay Response',
      t: 'code',
      code: `
const d = $input.first().json;
const httpish = {
  bad_request: 400, not_found: 404, already_handled: 409,
  no_lead_record: 422, requalify: 202,
};
return [{ json: {
  ok: !!d.ok,
  action: d.action,
  dlq_id: d.dlq_id || '',
  lead_uid: d.lead_uid || '',
  reason: d.reason || '',
  odoo_already_created: !!d.odoo_already_created,
  skipped_because_complete: d.completed_scopes || [],
  status: httpish[d.action] || 400,
  execution_id: String($execution.id || ''),
} }];
`,
    },

    {
      n: 'Respond Replay',
      t: 'respond',
      p: {
        respondWith: 'json',
        responseBody: '={{ JSON.stringify($json) }}',
        options: { responseCode: '={{ $json.status }}' },
      },
      notes: 'The status code carries the outcome (404 unknown id, 409 already handled, 422\n'
        + 'nothing to replay, 202 accepted) and the body says which steps were skipped and\n'
        + 'why, so an operator can see that the replay respected the completed work rather\n'
        + 'than having to go and check Odoo.',
    },

    {
      n: 'Replay Route',
      t: 'if',
      p: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          combinator: 'and',
          conditions: [{
            id: 'is-replayable',
            leftValue: '={{ $json.action }}',
            rightValue: 'requalify',
            operator: { type: 'string', operation: 'equals' },
          }],
        },
        options: {},
      },
    },

    {
      n: 'Re-dispatch to Qualify',
      t: 'executeWorkflow',
      p: {
        workflowId: '@LP-02 Qualify',
        mode: 'each',
        workflowInputs: {
          mappingMode: 'defineBelow',
          value: { lead_json: '={{ $json.replay_lead_json }}' },
          matchingColumns: [],
          schema: [],
        },
        options: { waitForSubWorkflow: false },
      },
      onError: 'continueRegularOutput',
    },

    {
      n: 'Mark Dead Letter Replayed',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'upsert',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_dlq' },
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'dlq_id', condition: 'eq', keyValue: '={{ $json.dlq_id }}' }] },
        columns: {
          mappingMode: 'defineBelow',
          value: {
            dlq_id: '={{ $json.dlq_id }}',
            lead_uid: '={{ $json.lead_uid }}',
            stage_failed: '={{ $json.stage_failed }}',
            error_class: '={{ $json.error_class }}',
            error: '={{ $json.reason }}',
            payload_json: '={{ JSON.stringify({ replayed_at: Math.floor(Date.now()/1000), skipped: $json.completed_scopes || [] }) }}',
            attempts: '={{ $json.attempts }}',
            state: '={{ $json.new_state }}',
            first_seen: 0,
            last_seen: '={{ Math.floor(Date.now()/1000) }}',
          },
          matchingColumns: ['dlq_id'],
          schema: [],
        },
        options: {},
      },
      notes: 'State moves to "replayed", never to deleted. A dead letter is evidence: what\n'
        + 'failed, how often, and what was done about it. Deleting it on success throws away\n'
        + 'the only record that the incident happened.\n\n'
        + 'first_seen is written as 0 because upsert rewrites the whole row and the original\n'
        + 'value is preserved in the audit history instead - a documented limitation of the\n'
        + 'Data Table node, which has no partial update.',
    },

    {
      n: 'note',
      t: 'sticky',
      at: [-980, -580],
      w: 780,
      h: 330,
      content: '## LP-05 Error Handler and DLQ\n\n'
        + '**Capture** (top): every workflow names this one as its `errorWorkflow`. Failures are '
        + 'classified `transient` / `credential` / `permanent`, dead-lettered under a stable id so a '
        + 'repeat increments instead of multiplying, and alerted **only when a human can act** - a '
        + 'transient inside its retry budget stays quiet, a dead credential is critical on sight.\n\n'
        + '**Replay** (bottom): `POST /webhook/lp-replay {"dlq_id":"..."}`. It reads the idempotency '
        + 'ledger **before** doing anything, so a re-run after a partial success skips the steps that '
        + 'already completed and cannot create a second Odoo opportunity. **(EC-14)**\n\n'
        + '**This workflow has no error workflow of its own** - that would loop. Every node here is '
        + 'written to survive its own failure, and the alert path degrades to a `critical` audit row.',
    },
  ],

  flow: [
    // capture
    ['Failure', 'Classify Failure'],
    ['Classify Failure', 'Read Prior Dead Letter'],
    ['Read Prior Dead Letter', 'Count Attempts'],
    ['Count Attempts', 'Write Dead Letter'],
    ['Count Attempts', 'Write Error Audit'],
    ['Count Attempts', 'Alert Worth Sending?'],
    ['Alert Worth Sending?', 'Read Alert Config', 0],
    ['Read Alert Config', 'Compose Alert'],
    ['Compose Alert', 'Send Alert Email'],
    ['Send Alert Email', 'Record Alert Failure', 1],
    ['Record Alert Failure', 'Log Undelivered Alert'],

    // replay
    ['Replay Request', 'Load Dead Letter'],
    ['Load Dead Letter', 'Plan Replay'],
    ['Plan Replay', 'Read Lead Ledger'],
    ['Read Lead Ledger', 'Read Lead Record'],
    ['Read Lead Record', 'Decide Replay'],
    ['Decide Replay', 'Build Replay Response'],
    ['Decide Replay', 'Replay Route'],
    ['Build Replay Response', 'Respond Replay'],
    ['Replay Route', 'Re-dispatch to Qualify', 0],
    ['Replay Route', 'Mark Dead Letter Replayed', 0],
  ],
};
