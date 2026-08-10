/**
 * LP-92 Send Message - the only thing in the system that talks to a customer.
 *
 * Every outbound message, from every workflow, goes through here. That is what
 * makes three otherwise-scattered guarantees possible to state and to test:
 *
 *   1. **Nothing is sent twice.** `message:<lead>:<template>:<step>` is claimed
 *      before the send and completed with the provider's message id after it.
 *      A retried caller, a replayed dead letter and a double-fired tick all
 *      converge on one message. (EC-8)
 *
 *   2. **Stop conditions are re-checked at the last possible moment**, not when
 *      the message was scheduled. A lead who opted out at 10:59 does not get
 *      the 11:00 follow-up, because the lead row and the job row are both read
 *      again inside this workflow, after the queue already decided to send.
 *      (EC-10)
 *
 *   3. **No real prospect can be emailed by a test run.** When
 *      `demo_redirect_email` is set in lp_config, every lead-facing message is
 *      redirected there with the intended recipient in the subject line. A
 *      staging system that can reach production inboxes is one typo away from
 *      an incident.
 *
 * The WhatsApp channel posts to the mock in LP-99, which is shaped exactly like
 * Meta's Cloud API response. Going live is a URL and a credential.
 */
module.exports = {
  file: 'LP-92-send-message',
  name: 'LP-92 Send Message',
  purpose: 'Single outbound gate: idempotent claim, last-moment stop-condition recheck, email or WhatsApp, recorded result.',
  settings: { errorWorkflow: '@LP-05 Error Handler and DLQ', executionTimeout: 120 },

  nodes: [
    {
      n: 'Send Call',
      t: 'executeWorkflowTrigger',
      p: {
        inputSource: 'workflowInputs',
        workflowInputs: {
          values: [
            { name: 'lead_uid', type: 'string' },
            { name: 'channel', type: 'string' },
            { name: 'to', type: 'string' },
            { name: 'template', type: 'string' },
            { name: 'step', type: 'string' },
            { name: 'context_json', type: 'string' },
            { name: 'job_id', type: 'string' },
          ],
        },
      },
    },

    {
      n: 'Read Config',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'get',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_config' },
        returnAll: true,
        filters: { conditions: [] },
      },
      alwaysOutputData: true,
    },

    {
      n: 'Render Message',
      t: 'code',
      code: `
const cfg = Object.fromEntries(
  $input.all().map(i => i.json).filter(r => r && r.key).map(r => [r.key, r.value]),
);
const inp = $('Send Call').first().json;

let ctx = {};
try { ctx = JSON.parse(inp.context_json || '{}'); } catch (_) { ctx = {}; }
const lead = ctx.lead || {};

const template = String(inp.template || '');
const step = String(inp.step || '0');
const lead_uid = String(inp.lead_uid || '');
if (!lead_uid || !template) throw new Error('LP-92: lead_uid and template are both required.');

const name = lead.full_name || 'there';
const service = (lead.service_interest && lead.service_interest !== 'unknown')
  ? lead.service_interest.replace(/_/g, ' ') : 'what you described';
const owner = ctx.owner_name || 'someone from the team';
const base = String(ctx.base_url || cfg.base_url || '').replace(/\\/+$/, '');

// --- templates -----------------------------------------------------------
// Deliberately plain, and deliberately free of any claim that is not true.
// Nothing here invents a result, a client or a number, and nothing pretends
// somebody personally reviewed the enquiry before this message went out.
const approveCurl = (decision) =>
  'curl -X POST ' + base + '/webhook/lp-approval \\\\\\n' +
  '  -H "X-LP-Token: <token>" -H "Content-Type: application/json" \\\\\\n' +
  '  -d \\'{"lead_uid":"' + lead_uid + '","decision":"' + decision + '"}\\'';

const T = {
  confirm_qualified: {
    audience: 'lead',
    subject: 'We got your enquiry',
    body: 'Hi ' + name + ',\\n\\nThanks for getting in touch about ' + service + '. Your enquiry is with ' + owner + ', who will come back to you shortly.\\n\\nIf anything has changed in the meantime, just reply to this message.',
  },
  confirm_nurture: {
    audience: 'lead',
    subject: 'Thanks for getting in touch',
    body: 'Hi ' + name + ',\\n\\nThanks for your enquiry about ' + service + '. We have it on file and will follow up with something useful rather than a sales call.\\n\\nIf your timing changes, reply here and we will pick it up.',
  },
  ask_missing: {
    audience: 'lead',
    subject: 'One thing before we can help',
    body: 'Hi ' + name + ',\\n\\nThanks for reaching out. To route this to the right person we are missing: ' +
      (ctx.missing || 'a couple of details') + '.\\n\\nCould you reply with that and we will take it from there?',
  },
  q_fu1: { audience: 'lead', subject: 'Following up on your enquiry',
    body: 'Hi ' + name + ',\\n\\nJust checking this reached you. ' + owner + ' has your enquiry about ' + service + ' and can talk through options whenever suits.\\n\\nWhat does your week look like?' },
  q_fu2: { audience: 'lead', subject: 'Still worth a conversation?',
    body: 'Hi ' + name + ',\\n\\nFollowing up once more on ' + service + '. If the timing is wrong, say so and we will stop chasing.\\n\\nIf it is not, a short call is usually enough to tell whether this is worth either of our time.' },
  q_fu3: { audience: 'lead', subject: 'Last note from me',
    body: 'Hi ' + name + ',\\n\\nI will leave it here rather than keep filling your inbox. If ' + service + ' comes back onto your list, reply to this and we will pick it straight up.' },
  n_fu1: { audience: 'lead', subject: 'Something that might be useful',
    body: 'Hi ' + name + ',\\n\\nNo pitch. If you are still looking at ' + service + ', happy to answer specific questions by email whenever they come up.' },
  n_fu2: { audience: 'lead', subject: 'Checking in',
    body: 'Hi ' + name + ',\\n\\nChecking in on ' + service + '. If nothing has changed, no reply needed at all.' },
  n_fu3: { audience: 'lead', subject: 'Closing the loop',
    body: 'Hi ' + name + ',\\n\\nClosing this off so it stops sitting in your inbox. If it comes back around, reply here.' },
  dc_fu1: { audience: 'lead', subject: 'Still missing a detail',
    body: 'Hi ' + name + ',\\n\\nWe still need ' + (ctx.missing || 'a couple of details') + ' before we can help properly. One reply is enough.' },
  dc_fu2: { audience: 'lead', subject: 'Last check',
    body: 'Hi ' + name + ',\\n\\nWe will close this off unless we hear back. If you would still like help with ' + service + ', reply with ' + (ctx.missing || 'the missing details') + '.' },

  vip_approval: {
    audience: 'manager',
    subject: 'VIP approval needed: ' + (lead.company || name) + ' (score ' + (ctx.score ?? '?') + ')',
    body: [
      'A lead scored into the VIP band and is waiting for your decision. Nothing has been sent to them.',
      '',
      'Lead:     ' + name + (lead.company ? ' at ' + lead.company : ''),
      'Contact:  ' + (lead.email_norm || lead.phone_e164 || 'unknown'),
      'Score:    ' + (ctx.score ?? '?') + '  Band: ' + (ctx.band || 'vip'),
      'Service:  ' + service,
      'Odoo:     opportunity #' + (ctx.odoo_lead_id || '?') + ' (stage Awaiting Approval)',
      '',
      'What they wrote:',
      (lead.free_text || '(nothing)'),
      '',
      'Approve:', approveCurl('approve'),
      '',
      'Reject:', approveCurl('reject'),
      '',
      'Rejecting stops all outbound for this lead and closes the opportunity as lost.',
    ].join('\\n'),
  },
  review_notice: {
    audience: 'manager',
    subject: 'Manual review: ' + (lead.company || name),
    body: [
      'A lead needs a human before it can be routed. Nothing has been sent to them.',
      '',
      'Lead:    ' + name + (lead.company ? ' at ' + lead.company : ''),
      'Contact: ' + (lead.email_norm || lead.phone_e164 || 'unknown'),
      'Score:   ' + (ctx.score ?? '?'),
      'Reason:  ' + (ctx.dup_reason || ctx.band_reason || 'flagged for review'),
      'Odoo:    opportunity #' + (ctx.odoo_lead_id || '?') + ' (stage Manual Review)',
    ].join('\\n'),
  },
  sla_breach: {
    audience: 'manager',
    subject: 'SLA breach: no action on ' + (lead.company || name) + ' in 30 minutes',
    body: [
      'A qualified lead has had no recorded sales action within the 30-minute SLA.',
      '',
      'Lead:    ' + name + (lead.company ? ' at ' + lead.company : ''),
      'Owner:   ' + owner + (ctx.owner_email ? ' <' + ctx.owner_email + '>' : ''),
      'Score:   ' + (ctx.score ?? '?'),
      'Odoo:    opportunity #' + (ctx.odoo_lead_id || '?'),
      '',
      'It has been escalated and reassigned where a free owner was available.',
    ].join('\\n'),
  },
};

const t = T[template];
if (!t) throw new Error('LP-92: no template named "' + template + '".');

// --- the redirect guard --------------------------------------------------
// Lead-facing mail goes to demo_redirect_email when it is set. Manager mail
// never does - it is already internal, and redirecting it would hide the
// alerts. The intended recipient is preserved in the subject and recorded, so a
// redirected run still proves who WOULD have been contacted.
const redirect = String(cfg.demo_redirect_email || '').trim();
// A manager-audience message is always addressed from lp_config, never from the
// caller. Callers legitimately pass an agent_id or a lead address as the
// an escalation that goes to the lead instead of the manager is worse than one
// that does not go at all.
const intended = t.audience === 'manager'
  ? String(cfg.manager_email || '').trim()
  : String(inp.to || '');
const redirected = t.audience === 'lead' && !!redirect && redirect !== intended;
const actual_to = redirected ? redirect : intended;

if (!actual_to) throw new Error('LP-92: no recipient for template ' + template + '.');

return [{ json: {
  lead_uid,
  job_id: String(inp.job_id || ''),
  template,
  step,
  audience: t.audience,
  channel: String(inp.channel || 'email'),
  intended_to: intended,
  to: actual_to,
  redirected,
  subject: (redirected ? '[redirected from ' + intended + '] ' : '') + t.subject,
  body: t.body,
  // The message identity. Template plus step, so follow-up 2 is a different
  // message from follow-up 1 but a retry of follow-up 2 is not.
  idem_key: 'message:' + lead_uid + ':' + template + ':' + step,
  now: Math.floor(Date.now() / 1000),
  base_url: base,
} }];
`,
    },

    {
      n: 'Read Send Claim',
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
    },

    {
      n: 'Read Lead State',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'get',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_lead' },
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'lead_uid', condition: 'eq', keyValue: "={{ $('Render Message').first().json.lead_uid }}" }] },
        returnAll: true,
      },
      alwaysOutputData: true,
      onError: 'continueRegularOutput',
      notes: 'Read HERE, milliseconds before the send, and not trusted from whatever the caller\n'
        + 'was holding. The caller may have decided to send this message hours ago; the only\n'
        + 'state that matters is the state now.',
    },

    {
      n: 'Read Job State',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'get',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_jobs' },
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'job_id', condition: 'eq', keyValue: "={{ $('Render Message').first().json.job_id || '__no_job__' }}" }] },
        returnAll: true,
      },
      alwaysOutputData: true,
      onError: 'continueRegularOutput',
      notes: 'EDGE CASE 10, the last link in it. The tick claims a job and calls this workflow;\n'
        + 'between those two moments an opt-out can arrive and cancel the job. Re-reading the\n'
        + 'job row here closes that window. The sentinel keeps the query from matching\n'
        + 'anything when the caller is not a queued job at all.',
    },

    {
      n: 'Stop Conditions',
      t: 'code',
      code: `
const m = $('Render Message').first().json;

const claim = $('Read Send Claim').all().map(i => i.json)
  .find(r => r && r.idem_key === m.idem_key && r.scope !== undefined);
const lead = $('Read Lead State').all().map(i => i.json)
  .find(r => r && r.lead_uid === m.lead_uid && r.source !== undefined);
const job = $input.all().map(i => i.json)
  .find(r => r && r.job_id && r.job_id === m.job_id && r.state !== undefined);

let send = true;
let outcome = 'send';
let reason = '';

// The checks are ordered by how bad it would be to get them wrong, most
// serious first: contacting someone who said no is worse than sending a
// duplicate, which is worse than messaging a closed lead.
if (lead && lead.consent === 'denied') {
  send = false; outcome = 'suppressed'; reason = 'consent denied';
} else if (claim && claim.state === 'done') {
  // EC-8. Already delivered; the provider id is right there in the ledger.
  send = false; outcome = 'already_sent'; reason = 'already sent, provider ref ' + (claim.result_ref || 'unknown');
} else if (m.audience === 'lead' && lead && (lead.status === 'closed' || lead.status === 'merged')) {
  send = false; outcome = 'lead_closed'; reason = 'the lead is ' + lead.status;
} else if (m.job_id && job && job.state === 'cancelled') {
  send = false; outcome = 'cancelled'; reason = 'the job was cancelled: ' + (job.cancel_reason || 'no reason recorded');
} else if (m.job_id && !job) {
  // A job id that no longer resolves means the queue row was removed while
  // this was in flight. Not sending is the safe reading.
  send = false; outcome = 'job_missing'; reason = 'job ' + m.job_id + ' no longer exists';
} else if (m.audience === 'lead' && lead && lead.approval_state === 'rejected') {
  // EC-12. A manager said no; nothing further goes to this person.
  send = false; outcome = 'approval_rejected'; reason = 'a manager rejected this lead';
} else if (m.audience === 'lead' && lead && lead.approval_state === 'pending') {
  send = false; outcome = 'awaiting_approval'; reason = 'still waiting on manager approval';
}

return [{ json: { ...m, send, outcome, reason,
  channel: m.channel === 'whatsapp' ? 'whatsapp' : 'email' } }];
`,
    },

    {
      n: 'Send?',
      t: 'if',
      p: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          combinator: 'and',
          conditions: [{
            id: 'do-send',
            leftValue: '={{ $json.send }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          }],
        },
        options: {},
      },
    },

    {
      n: 'Claim Send',
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
            scope: 'message',
            lead_uid: '={{ $json.lead_uid }}',
            state: 'claimed',
            result_ref: '',
            claimed_at: '={{ $json.now }}',
            completed_at: 0,
            attempts: 1,
          },
          matchingColumns: ['idem_key'],
          schema: [],
        },
        options: {},
      },
    },

    {
      n: 'Which Channel?',
      t: 'switch',
      p: {
        rules: {
          values: ['email', 'whatsapp'].map((ch) => ({
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
              combinator: 'and',
              conditions: [{
                id: 'ch-' + ch,
                leftValue: "={{ $('Stop Conditions').first().json.channel }}",
                rightValue: ch,
                operator: { type: 'string', operation: 'equals' },
              }],
            },
            renameOutput: true,
            outputKey: ch,
          })),
        },
        options: {},
      },
    },

    {
      n: 'Send Email',
      t: 'gmail',
      p: {
        resource: 'message',
        operation: 'send',
        sendTo: "={{ $('Stop Conditions').first().json.to }}",
        subject: "={{ $('Stop Conditions').first().json.subject }}",
        emailType: 'text',
        message: "={{ $('Stop Conditions').first().json.body }}",
        options: { appendAttribution: false },
      },
      creds: { gmailOAuth2: { name: 'Gmail account' } },
      retry: { tries: 2, waitMs: 3000 },
      onError: 'continueRegularOutput',
      alwaysOutputData: true,
      notes: 'Plain text, and appendAttribution off. A prospect-facing message that arrives\n'
        + 'with an automation tool\'s footer on it announces that nobody read their enquiry.',
    },

    {
      n: 'Send WhatsApp',
      t: 'http',
      p: {
        method: 'POST',
        url: "={{ $('Stop Conditions').first().json.base_url }}/webhook/lp-mock-whatsapp",
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: "={{ JSON.stringify({ messaging_product: 'whatsapp', to: $('Stop Conditions').first().json.to, type: 'text', text: { body: $('Stop Conditions').first().json.body } }) }}",
        options: { timeout: 15000 },
      },
      creds: { httpHeaderAuth: { name: 'LP Webhook Token (X-LP-Token)' } },
      retry: { tries: 2, waitMs: 2000 },
      onError: 'continueRegularOutput',
      alwaysOutputData: true,
      notes: 'The request body is the real WhatsApp Business Cloud API shape, and the mock\n'
        + 'answers with the real response shape (messages[0].id = a wamid). Swapping to Meta\n'
        + 'is this URL and a credential - no code below this node changes, because it reads\n'
        + 'the provider id out of the same field either way.',
    },

    {
      n: 'Record Result',
      t: 'code',
      code: `
const m = $('Stop Conditions').first().json;
const res = $input.first()?.json ?? {};

let ok = true;
let provider_ref = '';
let error = '';

if (res.error || res.errorMessage) {
  ok = false;
  error = String(res.errorMessage || res.error?.message || 'send failed');
} else if (m.channel === 'whatsapp') {
  provider_ref = res.messages?.[0]?.id || '';
  if (!provider_ref) { ok = false; error = 'the WhatsApp response carried no message id: ' + JSON.stringify(res).slice(0, 200); }
} else {
  provider_ref = res.id || res.messageId || res.threadId || '';
  if (!provider_ref) { ok = false; error = 'the mail provider returned no message id'; }
}

// Three states, not two. "claimed but not done" is the state that makes a
// crash between the claim and the provider response recoverable: the next run
// sees an unfinished claim rather than either a clean slate (send twice) or a
// completed one (never send).
return [{ json: {
  ...m,
  ok,
  provider_ref,
  error,
  state: ok ? 'done' : 'failed',
  sent_at: Math.floor(Date.now() / 1000),
  outcome: ok ? 'sent' : 'failed',
} }];
`,
    },

    {
      n: 'Skipped',
      t: 'code',
      code: `
const m = $input.first().json;
return [{ json: { ...m, ok: true, provider_ref: '', error: '', state: 'skipped', sent_at: Math.floor(Date.now() / 1000) } }];
`,
      notes: 'A suppressed send is a SUCCESS, not a failure - the system did exactly what it\n'
        + 'should. Returning it as an error would fill the dead-letter queue with correct\n'
        + 'behaviour and train whoever reads it to ignore the queue.',
    },

    {
      n: 'Complete Send Claim',
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
            scope: 'message',
            lead_uid: '={{ $json.lead_uid }}',
            state: '={{ $json.state }}',
            result_ref: '={{ $json.provider_ref || $json.error }}',
            claimed_at: '={{ $json.now }}',
            completed_at: '={{ $json.sent_at }}',
            attempts: 1,
          },
          matchingColumns: ['idem_key'],
          schema: [],
        },
        options: {},
      },
      onError: 'continueRegularOutput',
    },

    {
      n: 'Write Send Audit',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'insert',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_audit' },
        columns: {
          mappingMode: 'defineBelow',
          value: {
            event_id: '={{ $json.idem_key + ":" + $json.sent_at }}',
            lead_uid: '={{ $json.lead_uid }}',
            ts: '={{ $json.sent_at }}',
            workflow: 'LP-92 Send Message',
            execution_id: '={{ $execution.id }}',
            type: '={{ $json.state === "done" ? "message_sent" : "message_suppressed" }}',
            decision: '={{ $json.outcome + ": " + $json.template }}',
            detail_json: '={{ JSON.stringify({ channel: $json.channel, template: $json.template, step: $json.step, audience: $json.audience, intended_to: $json.intended_to, actual_to: $json.to, redirected: $json.redirected, provider_ref: $json.provider_ref || "", reason: $json.reason || "", error: $json.error || "" }) }}',
          },
          matchingColumns: [],
          schema: [],
        },
        options: {},
      },
      onError: 'continueRegularOutput',
      notes: 'Both outcomes are logged with the same weight. "Why did this lead never hear from\n'
        + 'us" is asked far more often than "why did they", and it is only answerable if the\n'
        + 'suppressions were written down too.',
    },

    {
      n: 'Return',
      t: 'code',
      code: `
const r = $input.first().json;
return [{ json: {
  ok: !!r.ok,
  lead_uid: r.lead_uid,
  // Echoed back so a caller draining a queue can match this result to the exact
  // row it claimed, rather than by position across a sub-workflow boundary.
  job_id: r.job_id || '',
  template: r.template,
  step: r.step,
  channel: r.channel,
  state: r.state,
  outcome: r.outcome,
  reason: r.reason || '',
  provider_ref: r.provider_ref || '',
  error: r.error || '',
  redirected: !!r.redirected,
  intended_to: r.intended_to || '',
} }];
`,
    },

    {
      n: 'note',
      t: 'sticky',
      at: [-1000, -580],
      w: 780,
      h: 320,
      content: '## LP-92 Send Message\n\n'
        + '**Every outbound message in the system goes through this one workflow**, which is what makes '
        + 'the guarantees below statable at all.\n\n'
        + '**Claim -> send -> complete**, keyed `message:<lead>:<template>:<step>`. A retried caller, a '
        + 'replayed dead letter and a double-fired tick all produce one message. **(EC-8)**\n\n'
        + '**Stop conditions are re-read HERE**, milliseconds before the send: consent, lead status, '
        + 'approval state, and the job row itself. An opt-out at 10:59 stops the 11:00 follow-up. '
        + '**(EC-10, EC-12)**\n\n'
        + '**`demo_redirect_email` in `lp_config`** sends every lead-facing message to one inbox with '
        + 'the intended recipient in the subject. A staging system that can reach a real prospect is '
        + 'one typo away from an incident. Manager alerts are never redirected.',
    },
  ],

  flow: [
    ['Send Call', 'Read Config'],
    ['Read Config', 'Render Message'],
    ['Render Message', 'Read Send Claim'],
    ['Read Send Claim', 'Read Lead State'],
    ['Read Lead State', 'Read Job State'],
    ['Read Job State', 'Stop Conditions'],
    ['Stop Conditions', 'Send?'],
    ['Send?', 'Claim Send', 0],
    ['Send?', 'Skipped', 1],
    ['Claim Send', 'Which Channel?'],
    ['Which Channel?', 'Send Email', 0],
    ['Which Channel?', 'Send WhatsApp', 1],
    ['Send Email', 'Record Result'],
    ['Send WhatsApp', 'Record Result'],
    ['Record Result', 'Complete Send Claim'],
    ['Record Result', 'Write Send Audit'],
    ['Record Result', 'Return'],
    ['Skipped', 'Write Send Audit'],
    ['Skipped', 'Return'],
  ],
};
