/**
 * LP-07 Ops Report - what the pipeline did, and what it is currently getting
 * wrong.
 *
 *   Daily at 08:00 Africa/Cairo -> email
 *   GET/POST /webhook/lp-ops                -> the same figures as JSON
 *
 * The JSON endpoint is not a nicety. It is what the edge-case runner asserts
 * against and what a monitoring system would poll; the email is the same data
 * shaped for a person. One computation, two renderings, so the number in the
 * inbox and the number on the dashboard cannot disagree.
 *
 * The report leads with problems, not volume. A daily digest that opens with
 * "47 leads processed" gets skimmed; one that opens with "3 dead letters open,
 * 2 SLA breaches, 1 lead unassigned" gets read.
 */
module.exports = {
  file: 'LP-07-ops-report',
  name: 'LP-07 Ops Report',
  purpose: 'Daily operational summary and an on-demand JSON metrics endpoint over the audit, lead, job and dead-letter tables.',
  settings: { errorWorkflow: '@LP-05 Error Handler and DLQ', executionTimeout: 120 },

  nodes: [
    {
      n: 'Daily at 08:00',
      t: 'schedule',
      p: { rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * *' }] } },
    },
    {
      n: 'Ops Endpoint',
      t: 'webhook',
      p: {
        httpMethod: 'POST',
        path: 'lp-ops',
        authentication: 'headerAuth',
        responseMode: 'responseNode',
        options: {},
      },
      creds: { httpHeaderAuth: { name: 'LP Webhook Token (X-LP-Token)' } },
      notes: 'POST { "window_hours": 24 } - the window is a parameter so the edge-case runner\n'
        + 'can ask about the last few minutes rather than the last day.',
    },

    {
      n: 'Window',
      t: 'code',
      code: `
const inbound = $input.first()?.json || {};
const hours = Number(inbound.body?.window_hours) > 0 ? Number(inbound.body.window_hours) : 24;
const now = Math.floor(Date.now() / 1000);
return [{ json: {
  now,
  since: now - hours * 3600,
  hours,
  // A schedule trigger emits no body; a webhook does. That is the only
  // difference between the two entry points from here on.
  mode: inbound.body ? 'api' : 'scheduled',
} }];
`,
    },

    {
      n: 'Read Leads',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'get',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_lead' },
        returnAll: true,
        filters: { conditions: [] },
      },
      alwaysOutputData: true,
    },
    {
      n: 'Read Audit',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'get',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_audit' },
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'ts', condition: 'gte', keyValue: "={{ $('Window').first().json.since }}" }] },
        returnAll: true,
      },
      alwaysOutputData: true,
      notes: 'Only the window is read, not the whole log. The audit table is the fastest-growing\n'
        + 'thing in the system - several rows per lead - so a report that reads all of it gets\n'
        + 'slower every day it runs.',
    },
    {
      n: 'Read Jobs',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'get',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_jobs' },
        returnAll: true,
        filters: { conditions: [] },
      },
      alwaysOutputData: true,
    },
    {
      n: 'Read Dead Letters',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'get',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_dlq' },
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'state', condition: 'eq', keyValue: 'open' }] },
        returnAll: true,
      },
      alwaysOutputData: true,
    },
    {
      n: 'Read Ops Config',
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
      n: 'Compute Metrics',
      t: 'code',
      code: `
const w = $('Window').first().json;
const cfg = Object.fromEntries($input.all().map(i => i.json).filter(r => r && r.key).map(r => [r.key, r.value]));

const leads = $('Read Leads').all().map(i => i.json).filter(r => r && r.lead_uid);
const audit = $('Read Audit').all().map(i => i.json).filter(r => r && r.event_id && Number(r.ts) >= w.since);
const jobs = $('Read Jobs').all().map(i => i.json).filter(r => r && r.job_id);
const dlq = $('Read Dead Letters').all().map(i => i.json).filter(r => r && r.dlq_id && r.state === 'open');

const inWindow = leads.filter(l => Number(l.received_at) >= w.since);
const count = (arr, fn) => arr.filter(fn).length;
const tally = (arr, key) => arr.reduce((m, r) => { const k = String(r[key] || 'none'); m[k] = (m[k] || 0) + 1; return m; }, {});

// --- volume --------------------------------------------------------------
const bySource = tally(inWindow, 'source');
const byBand = tally(inWindow, 'band');

// --- the things that need a human ----------------------------------------
const unassigned = leads.filter(l => l.status === 'active' && !l.owner_id && l.band !== 'unqualified');
const awaitingApproval = leads.filter(l => l.approval_state === 'pending');
const inReview = leads.filter(l => l.status === 'active' && l.band === 'manual_review');
const incomplete = leads.filter(l => l.status === 'active' && l.band === 'data_completion');
const slaBreaches = audit.filter(a => a.type === 'sla_breached');
const quarantined = dlq.filter(d => String(d.error_class) === 'parse_error' || String(d.error_class) === 'unusable');
const credentialDeaths = dlq.filter(d => d.error_class === 'credential');

// --- pipeline health -----------------------------------------------------
const stuckJobs = jobs.filter(j => j.state === 'inflight' && Number(j.claimed_at) < w.now - 900);
const overdue = jobs.filter(j => j.state === 'pending' && Number(j.due_at) < w.now - 600);
const failedJobs = jobs.filter(j => j.state === 'failed');

// --- effectiveness -------------------------------------------------------
const sent = count(audit, a => a.type === 'message_sent');
const suppressed = count(audit, a => a.type === 'message_suppressed');
const duplicates = count(audit, a => a.type === 'intake_duplicate_event');
const dupMerges = audit.filter(a => a.type === 'odoo_upserted' && String(a.decision).startsWith('write')).length;
const aiFallbacks = audit.filter(a => a.type === 'scored' && /"status":"unavailable"/.test(String(a.detail_json || ''))).length;
const conflicts = count(audit, a => a.type === 'scored' && String(a.decision).includes('ai_rule_conflict'));

const scored = inWindow.filter(l => Number(l.score) > 0);
const avgScore = scored.length ? Math.round(scored.reduce((s, l) => s + Number(l.score), 0) / scored.length) : 0;

// Everything in this list is a thing a person has to do today. Most urgent
// first, and it is what the email leads with.
const attention = [];
if (credentialDeaths.length) attention.push(credentialDeaths.length + ' credential failure(s) - the pipeline is probably frozen');
if (dlq.length) attention.push(dlq.length + ' open dead letter(s)');
if (slaBreaches.length) attention.push(slaBreaches.length + ' SLA breach(es) in the window');
if (awaitingApproval.length) attention.push(awaitingApproval.length + ' VIP lead(s) waiting on your approval');
if (inReview.length) attention.push(inReview.length + ' lead(s) in manual review');
if (unassigned.length) attention.push(unassigned.length + ' active lead(s) with no owner');
if (stuckJobs.length) attention.push(stuckJobs.length + ' job(s) stuck in flight');
if (overdue.length) attention.push(overdue.length + ' job(s) more than 10 minutes overdue - is LP-04 Tick still active?');
if (quarantined.length) attention.push(quarantined.length + ' quarantined row(s) needing a data fix');

return [{ json: {
  generated_at: w.now,
  window_hours: w.hours,
  mode: w.mode,
  manager_email: cfg.manager_email || '',
  attention,
  volume: {
    received: inWindow.length,
    by_source: bySource,
    by_band: byBand,
    average_score: avgScore,
    total_leads_all_time: leads.length,
  },
  outcomes: {
    qualified: byBand.qualified || 0,
    vip: byBand.vip || 0,
    nurture: byBand.nurture || 0,
    unqualified: byBand.unqualified || 0,
    data_completion: byBand.data_completion || 0,
    manual_review: byBand.manual_review || 0,
  },
  messaging: { sent, suppressed, duplicate_events_blocked: duplicates },
  quality: {
    duplicate_merges: dupMerges,
    ai_fallbacks: aiFallbacks,
    ai_rule_conflicts: conflicts,
  },
  health: {
    open_dead_letters: dlq.length,
    credential_failures: credentialDeaths.length,
    sla_breaches: slaBreaches.length,
    jobs_pending: count(jobs, j => j.state === 'pending'),
    jobs_overdue: overdue.length,
    jobs_stuck_inflight: stuckJobs.length,
    jobs_failed: failedJobs.length,
    unassigned_active_leads: unassigned.length,
    awaiting_approval: awaitingApproval.length,
  },
  // Named, not just counted. "3 dead letters" is a number; three ids are work.
  dead_letters: dlq.slice(0, 10).map(d => ({ dlq_id: d.dlq_id, lead_uid: d.lead_uid, where: d.stage_failed, class: d.error_class, attempts: d.attempts, error: String(d.error).slice(0, 160) })),
  needs_approval: awaitingApproval.slice(0, 10).map(l => ({ lead_uid: l.lead_uid, name: l.full_name, company: l.company, score: l.score })),
  needs_review: inReview.slice(0, 10).map(l => ({ lead_uid: l.lead_uid, name: l.full_name, score: l.score })),
} }];
`,
    },

    {
      n: 'Public Metrics',
      t: 'code',
      usesRuntime: false,
      code: `
// The API answer is not simply the internal object. manager_email is an
// operator's address and has no business leaving the system through a metrics
// endpoint just because it happened to be in scope.
const { manager_email, ...body } = $input.first().json;
return [{ json: body }];
`,
      notes: 'Also keeps the Respond node off the fan-out. n8n\'s validator infers roles from node\n'
        + 'TYPE as well as name, and reads a respondToWebhook sitting directly among sibling\n'
        + 'branches as an error handler wired to the wrong output - so the two nodes that\n'
        + 'genuinely belong on separate branches are the email renderer and this one.',
    },

    {
      n: 'Respond Metrics',
      t: 'respond',
      p: {
        respondWith: 'json',
        responseBody: '={{ JSON.stringify($json) }}',
        options: { responseCode: 200 },
      },
      notes: 'Reached only on the webhook path. A Respond node in an execution that started from\n'
        + 'a schedule trigger has nothing to answer and is simply skipped, which is why both\n'
        + 'entry points can share one computation.',
    },

    {
      n: 'Render Email',
      t: 'code',
      code: `
const m = $input.first().json;
const line = (k, v) => '  ' + String(k).padEnd(26) + v;

// Plain text with aligned columns, never a markdown table: mail clients render
// pipe tables as raw pipes, and this has to be readable on a phone at 8am.
const body = [
  m.attention.length ? 'NEEDS ATTENTION' : 'Nothing needs attention.',
  ...m.attention.map(a => '  - ' + a),
  '',
  'Last ' + m.window_hours + ' hours',
  line('received', m.volume.received),
  line('average score', m.volume.average_score),
  '',
  'By band',
  ...Object.entries(m.outcomes).filter(([, v]) => v > 0).map(([k, v]) => line(k, v)),
  '',
  'By source',
  ...Object.entries(m.volume.by_source).map(([k, v]) => line(k, v)),
  '',
  'Messaging',
  line('sent', m.messaging.sent),
  line('suppressed', m.messaging.suppressed),
  line('duplicate events blocked', m.messaging.duplicate_events_blocked),
  '',
  'Quality',
  line('duplicate merges', m.quality.duplicate_merges),
  line('AI fallbacks', m.quality.ai_fallbacks),
  line('AI vs rules conflicts', m.quality.ai_rule_conflicts),
  '',
  'Health',
  line('open dead letters', m.health.open_dead_letters),
  line('SLA breaches', m.health.sla_breaches),
  line('jobs pending', m.health.jobs_pending),
  line('jobs overdue', m.health.jobs_overdue),
  line('jobs stuck in flight', m.health.jobs_stuck_inflight),
  line('unassigned active leads', m.health.unassigned_active_leads),
];

if (m.dead_letters.length) {
  body.push('', 'Open dead letters');
  m.dead_letters.forEach(d => body.push('  ' + d.dlq_id + '  ' + d.where + '  (' + d.class + ', x' + d.attempts + ')', '      ' + d.error));
}
if (m.needs_approval.length) {
  body.push('', 'Waiting on your approval');
  m.needs_approval.forEach(l => body.push('  ' + l.lead_uid + '  ' + (l.name || '') + (l.company ? ' at ' + l.company : '') + '  score ' + l.score));
}

return [{ json: {
  ...m,
  subject: m.attention.length
    ? 'Lead pipeline: ' + m.attention.length + ' thing(s) need attention'
    : 'Lead pipeline: ' + m.volume.received + ' leads, all clear',
  body: body.join('\\n'),
} }];
`,
    },

    {
      n: 'Send Report',
      t: 'gmail',
      p: {
        resource: 'message',
        operation: 'send',
        sendTo: '={{ $json.manager_email }}',
        subject: '={{ $json.subject }}',
        emailType: 'text',
        message: '={{ $json.body }}',
        options: { appendAttribution: false },
      },
      creds: { gmailOAuth2: { name: 'Gmail account' } },
      retry: { tries: 2, waitMs: 3000 },
      onError: 'continueRegularOutput',
      notes: 'Sent every day, including quiet ones. This is the exception to the "stay silent\n'
        + 'when there is nothing to say" rule that the rest of the system follows, and the\n'
        + 'reason is that this mail doubles as the heartbeat: its ABSENCE is the signal that\n'
        + 'the instance is down. A digest that only arrives when something is wrong cannot\n'
        + 'tell you it stopped arriving.',
    },

    {
      n: 'note',
      t: 'sticky',
      at: [-980, -540],
      w: 760,
      h: 280,
      content: '## LP-07 Ops Report\n\n'
        + 'Daily 08:00 email **and** `POST /webhook/lp-ops {"window_hours":1}` returning the same '
        + 'figures as JSON. One computation, two renderings - the number in the inbox and the number '
        + 'on a dashboard cannot disagree.\n\n'
        + '**Leads with problems, not volume.** "47 leads processed" gets skimmed; "3 dead letters, 2 '
        + 'SLA breaches, 1 lead with no owner" gets read. Dead letters are listed **by id**, because a '
        + 'count is a number and an id is work you can do.\n\n'
        + '**Sent even on quiet days**, deliberately - unlike every other notification here. It is the '
        + 'heartbeat: a digest that only arrives when something is wrong can never tell you it stopped '
        + 'arriving.',
    },
  ],

  flow: [
    ['Daily at 08:00', 'Window'],
    ['Ops Endpoint', 'Window'],
    ['Window', 'Read Leads'],
    ['Read Leads', 'Read Audit'],
    ['Read Audit', 'Read Jobs'],
    ['Read Jobs', 'Read Dead Letters'],
    ['Read Dead Letters', 'Read Ops Config'],
    ['Read Ops Config', 'Compute Metrics'],
    ['Compute Metrics', 'Public Metrics'],
    ['Public Metrics', 'Respond Metrics'],
    ['Compute Metrics', 'Render Email'],
    ['Render Email', 'Send Report'],
  ],
};
