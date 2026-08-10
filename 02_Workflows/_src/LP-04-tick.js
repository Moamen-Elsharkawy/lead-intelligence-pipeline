/**
 * LP-04 Tick - the clock. Runs every 5 minutes and does three jobs.
 *
 *   A. DRAIN THE DUE QUEUE. Follow-ups and SLA timers are rows with a `due_at`,
 *      not Wait nodes. That single choice is what makes cancellation work: a
 *      held-open Wait node cannot be cancelled cleanly and does not survive a
 *      restart, whereas a queue simply drains late after an outage. (EC-10)
 *
 *   B. SELF-HEAL. Jobs stuck `inflight` because a tick died mid-batch are
 *      requeued; CRM claims stuck `claimed` for more than ten minutes are
 *      dead-lettered so a human or the replay path can finish them. (EC-7)
 *
 *   C. WATCH THE OWNERS. A salesperson who becomes unavailable after leads were
 *      assigned to them leaves those leads orphaned and nobody notices, because
 *      nothing errors. The scan finds them and reassigns. (EC-9)
 *
 * Why 5 minutes and not 1: the smallest interval that matters here is the
 * 30-minute SLA, so a 5-minute tick detects a breach within 17% of the window
 * while doing a twelfth of the work. Ticking every minute would buy precision
 * nothing in this system can use.
 *
 * The batch is capped. A tick that tries to drain 10,000 due jobs in one
 * execution is a tick that times out and drains none of them; a capped tick
 * drains 25 and the next one drains 25 more.
 */
module.exports = {
  file: 'LP-04-tick',
  name: 'LP-04 Tick',
  purpose: 'Drains the follow-up and SLA queue, requeues stuck work, dead-letters stale CRM claims, reassigns orphaned leads.',
  settings: { errorWorkflow: '@LP-05 Error Handler and DLQ', executionTimeout: 280 },

  nodes: [
    {
      n: 'Every 5 Minutes',
      t: 'schedule',
      p: { rule: { interval: [{ field: 'minutes', minutesInterval: 5 }] } },
    },

    {
      n: 'Run Tick Now',
      t: 'webhook',
      p: {
        httpMethod: 'POST',
        path: 'lp-tick',
        authentication: 'headerAuth',
        responseMode: 'onReceived',
        options: {},
      },
      creds: { httpHeaderAuth: { name: 'LP Webhook Token (X-LP-Token)' } },
      notes: 'The same three jobs, on demand. Two reasons it exists beyond convenience:\n\n'
        + '1. It makes the queue behaviour DEMONSTRABLE. Edge cases 9 and 10 are about what\n'
        + '   happens on the next tick, and a reviewer should not have to wait five minutes\n'
        + '   per assertion to watch them.\n'
        + '2. It is what an operator wants at 4pm on a Friday after fixing a credential -\n'
        + '   "drain the backlog now" rather than "wait and hope".\n\n'
        + 'responseMode onReceived: it answers 200 immediately and keeps working, because\n'
        + 'the caller wants an acknowledgement, not a report. The report is LP-07.',
    },

    // =======================================================================
    // A. Drain the due queue
    // =======================================================================
    {
      n: 'Read Due Jobs',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'get',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_jobs' },
        matchType: 'allConditions',
        filters: {
          conditions: [
            { keyName: 'state', condition: 'eq', keyValue: 'pending' },
            { keyName: 'due_at', condition: 'lte', keyValue: '={{ Math.floor(Date.now()/1000) }}' },
          ],
        },
        returnAll: true,
      },
      alwaysOutputData: true,
      notes: 'The due comparison is pushed into the store rather than done in code, so a\n'
        + 'growing queue does not mean a growing read. The `lte` operator was verified\n'
        + 'against this instance\'s Data Table API before it was relied on (it validates\n'
        + 'server-side and rejects a type mismatch) - see 05_Test_Evidence.',
    },

    {
      n: 'Claim Batch',
      t: 'code',
      code: `
const now = Math.floor(Date.now() / 1000);
const MAX_PER_TICK = 25;

const due = $input.all().map(i => i.json)
  .filter(r => r && r.job_id && r.state === 'pending' && Number(r.due_at) <= now)
  .sort((a, b) => Number(a.due_at) - Number(b.due_at));

// Oldest first, then stop. Whatever is left is still due on the next tick, and
// draining a bounded batch every 5 minutes beats timing out trying to drain all
// of it once.
const batch = due.slice(0, MAX_PER_TICK);

if (!batch.length) return [];

return batch.map(j => ({ json: {
  ...j,
  attempts: Number(j.attempts || 0) + 1,
  claimed_at: now,
  overdue_by: now - Number(j.due_at),
  deferred: due.length - batch.length,
} }));
`,
      notes: 'Returning [] on an empty queue ends the branch silently. A scheduled workflow that\n'
        + 'logs "nothing to do" every 5 minutes buries the runs that did something.',
    },

    {
      n: 'Mark In Flight',
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
            state: 'inflight',
            attempts: '={{ $json.attempts }}',
            claimed_at: '={{ $json.claimed_at }}',
            result: '',
            cancel_reason: '',
          },
          matchingColumns: ['job_id'],
          schema: [],
        },
        options: {},
      },
      notes: 'Claim before work, the same rule as everywhere else. Two ticks overlapping - which\n'
        + 'happens the moment one run takes longer than the interval - would otherwise both\n'
        + 'read the same pending rows and send every follow-up twice.',
    },

    {
      n: 'Read Job Leads',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'get',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_lead' },
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'lead_uid', condition: 'eq', keyValue: '={{ $json.lead_uid }}' }] },
        returnAll: true,
      },
      alwaysOutputData: true,
      onError: 'continueRegularOutput',
    },

    {
      n: 'Plan Job Actions',
      t: 'code',
      code: `
// Joined by VALUE, never by position. The Data Table read emits one row per
// match and nothing for a miss, so item 3 of the output is not item 3 of the
// input - a positional join here would silently send lead A's follow-up to
// lead B.
const leads = new Map();
for (const i of $input.all()) {
  const r = i.json;
  if (r && r.lead_uid && r.source !== undefined) leads.set(String(r.lead_uid), r);
}

const jobs = $('Claim Batch').all().map(i => i.json);
const now = Math.floor(Date.now() / 1000);
const out = [];

for (const j of jobs) {
  const lead = leads.get(String(j.lead_uid));

  if (!lead) {
    out.push({ json: { ...j, action: 'drop', new_state: 'failed',
      result: 'no lead record - the job outlived its lead' } });
    continue;
  }

  // Cheap local stop conditions. LP-92 re-checks all of them anyway, at the
  // last possible moment; catching them here just avoids a pointless call.
  if (lead.consent === 'denied' || lead.status === 'closed' || lead.status === 'merged') {
    out.push({ json: { ...j, action: 'drop', new_state: 'cancelled',
      result: 'lead is ' + (lead.consent === 'denied' ? 'opted out' : lead.status) } });
    continue;
  }

  if (j.job_type === 'sla') {
    // "Has anyone acted?" is answered from the lead's own state rather than by
    // trawling the audit log: a reply, a booking or a close all move the stage
    // or the status, and LP-06 is what moves them.
    const untouched = lead.status === 'active'
      && String(lead.odoo_stage || '') === C.STAGES.QUALIFIED
      && String(lead.approval_state || 'not_required') !== 'pending';

    out.push({ json: { ...j, lead, action: untouched ? 'escalate' : 'drop',
      new_state: untouched ? 'sent' : 'cancelled',
      result: untouched
        ? 'SLA breached: still at ' + lead.odoo_stage + ' with no recorded action'
        : 'no breach: the lead moved to ' + lead.odoo_stage + ' / ' + lead.status } });
    continue;
  }

  out.push({ json: { ...j, lead, action: 'send', new_state: 'sent',
    result: '', now } });
}

return out;
`,
    },

    {
      n: 'Route Job',
      t: 'switch',
      p: {
        rules: {
          values: ['send', 'escalate', 'drop'].map((a) => ({
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
              combinator: 'and',
              conditions: [{
                id: 'act-' + a,
                leftValue: '={{ $json.action }}',
                rightValue: a,
                operator: { type: 'string', operation: 'equals' },
              }],
            },
            renameOutput: true,
            outputKey: a,
          })),
        },
        options: {},
      },
    },

    {
      n: 'Send Follow-up',
      t: 'executeWorkflow',
      p: {
        workflowId: '@LP-92 Send Message',
        mode: 'each',
        workflowInputs: {
          mappingMode: 'defineBelow',
          value: {
            lead_uid: '={{ $json.lead_uid }}',
            channel: '={{ $json.lead.email_norm ? "email" : "whatsapp" }}',
            to: '={{ $json.lead.email_norm || $json.lead.phone_e164 }}',
            template: '={{ $json.template }}',
            step: '={{ String($json.step) }}',
            job_id: '={{ $json.job_id }}',
            context_json: '={{ JSON.stringify({ lead: $json.lead, score: $json.lead.score, band: $json.lead.band, odoo_lead_id: $json.lead.odoo_lead_id, missing: "" }) }}',
          },
          matchingColumns: [],
          schema: [],
        },
        options: { waitForSubWorkflow: true },
      },
      notes: 'Waited on, unlike most sub-workflow calls here, because the job row has to record\n'
        + 'what actually happened. `job_id` is passed so LP-92 can re-read the queue row and\n'
        + 'refuse to send a job that was cancelled between this claim and the send.',
    },

    {
      n: 'Escalate SLA',
      t: 'executeWorkflow',
      p: {
        workflowId: '@LP-92 Send Message',
        mode: 'each',
        workflowInputs: {
          mappingMode: 'defineBelow',
          value: {
            lead_uid: '={{ $json.lead_uid }}',
            channel: 'email',
            to: '={{ $json.lead.owner_id }}',
            template: 'sla_breach',
            step: '0',
            job_id: '={{ $json.job_id }}',
            context_json: '={{ JSON.stringify({ lead: $json.lead, score: $json.lead.score, owner_name: $json.lead.owner_id, odoo_lead_id: $json.lead.odoo_lead_id }) }}',
          },
          matchingColumns: [],
          schema: [],
        },
        options: { waitForSubWorkflow: true },
      },
      notes: '`to` is intentionally not a real address here: sla_breach is a manager-audience\n'
        + 'template, and LP-92 addresses manager mail from lp_config rather than from the\n'
        + 'caller. Routing an escalation through the same send gate keeps it inside the same\n'
        + 'idempotency and audit story as everything else - one breach, one alert, however\n'
        + 'many ticks observe it.',
    },

    {
      n: 'Record Job Outcome',
      t: 'code',
      code: `
// Three branches feed this node - send, escalate and drop - and n8n runs it
// once per branch that carried data. So it must emit ONLY what its own input
// covers. Iterating the full plan each time instead would re-emit the dropped
// jobs on every pass and insert a duplicate audit row for each of them.
//
// job_id is the join key, echoed back by LP-92 for exactly this purpose.
const planned = new Map($('Plan Job Actions').all().map(i => [String(i.json.job_id), i.json]));
const now = Math.floor(Date.now() / 1000);
const out = [];

for (const item of $input.all()) {
  const r = item.json || {};
  const j = planned.get(String(r.job_id || ''));
  if (!j) continue;

  if (j.action === 'drop') { out.push({ json: { ...j, done_at: now } }); continue; }

  // A failed send goes back to pending so the next tick retries it - up to
  // three attempts, after which it is a dead job rather than an infinite one.
  const failed = r.ok === false;
  const exhausted = failed && Number(j.attempts) >= 3;

  out.push({ json: {
    ...j,
    new_state: failed ? (exhausted ? 'failed' : 'pending') : (j.new_state || 'sent'),
    result: failed
      ? ('attempt ' + j.attempts + ' failed: ' + (r.error || 'unknown'))
      : (r.outcome + (r.provider_ref ? ' (' + r.provider_ref + ')' : '') + (r.reason ? ' - ' + r.reason : '')),
    done_at: now,
    escalated: j.action === 'escalate' && r.ok !== false,
  } });
}

return out;
`,
    },

    {
      n: 'Update Job Row',
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
            // A retry is pushed out by two minutes rather than retried inside the
            // same tick, so a provider having a bad thirty seconds is not hit
            // three times in three seconds.
            due_at: '={{ $json.new_state === "pending" ? ($json.done_at + 120) : $json.due_at }}',
            state: '={{ $json.new_state }}',
            attempts: '={{ $json.attempts }}',
            claimed_at: '={{ $json.claimed_at }}',
            result: '={{ $json.result }}',
            cancel_reason: '={{ $json.new_state === "cancelled" ? $json.result : "" }}',
          },
          matchingColumns: ['job_id'],
          schema: [],
        },
        options: {},
      },
    },

    {
      n: 'Write Job Audit',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'insert',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_audit' },
        columns: {
          mappingMode: 'defineBelow',
          value: {
            event_id: '={{ $json.job_id + ":" + $json.done_at }}',
            lead_uid: '={{ $json.lead_uid }}',
            ts: '={{ $json.done_at }}',
            workflow: 'LP-04 Tick',
            execution_id: '={{ $execution.id }}',
            type: '={{ $json.escalated ? "sla_breached" : ($json.new_state === "cancelled" ? "job_cancelled" : "message_sent") }}',
            decision: '={{ $json.job_type + " step " + $json.step + " -> " + $json.new_state }}',
            detail_json: '={{ JSON.stringify({ template: $json.template, result: $json.result, attempts: $json.attempts, overdue_by_seconds: $json.overdue_by, deferred_to_next_tick: $json.deferred }) }}',
          },
          matchingColumns: [],
          schema: [],
        },
        options: {},
      },
      onError: 'continueRegularOutput',
    },

    // =======================================================================
    // B. Self-heal
    // =======================================================================
    {
      n: 'Read Stuck Jobs',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'get',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_jobs' },
        matchType: 'allConditions',
        filters: {
          conditions: [
            { keyName: 'state', condition: 'eq', keyValue: 'inflight' },
            { keyName: 'claimed_at', condition: 'lte', keyValue: '={{ Math.floor(Date.now()/1000) - 900 }}' },
          ],
        },
        returnAll: true,
      },
      alwaysOutputData: true,
      notes: 'A job claimed more than 15 minutes ago and never completed means the tick that\n'
        + 'claimed it died. Without this scan those rows sit in `inflight` forever and the\n'
        + 'follow-up is simply never sent - the quietest possible failure, and the reason\n'
        + 'claim-based queues need a reaper.',
    },

    {
      n: 'Requeue Stuck',
      t: 'code',
      code: `
const now = Math.floor(Date.now() / 1000);
const stuck = $input.all().map(i => i.json)
  .filter(r => r && r.job_id && r.state === 'inflight' && Number(r.claimed_at) <= now - 900);

if (!stuck.length) return [];

return stuck.map(j => ({ json: {
  ...j,
  // Three strikes. A job that has been claimed and abandoned three times is not
  // going to succeed on the fourth, and leaving it in the queue hides real work.
  new_state: Number(j.attempts || 0) >= 3 ? 'failed' : 'pending',
  result: 'requeued after a tick abandoned it mid-flight (attempt ' + (j.attempts || 0) + ')',
  done_at: now,
  overdue_by: 0,
  deferred: 0,
  escalated: false,
} }));
`,
    },

    {
      n: 'Read Stale Claims',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'get',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_idem' },
        matchType: 'allConditions',
        filters: {
          conditions: [
            { keyName: 'scope', condition: 'eq', keyValue: 'odoo_upsert' },
            { keyName: 'state', condition: 'eq', keyValue: 'claimed' },
            { keyName: 'claimed_at', condition: 'lte', keyValue: '={{ Math.floor(Date.now()/1000) - 600 }}' },
          ],
        },
        returnAll: true,
      },
      alwaysOutputData: true,
      notes: 'EDGE CASE 7, the safety net behind the safety net. LP-03 already searches Odoo by\n'
        + 'external key before every create, so a lost acknowledgement is normally repaired\n'
        + 'on the next attempt. This catches the case where there IS no next attempt because\n'
        + 'the execution died and nothing retried it.',
    },

    {
      n: 'Dead-letter Stale Claims',
      t: 'code',
      code: `
const now = Math.floor(Date.now() / 1000);
const stale = $input.all().map(i => i.json)
  .filter(r => r && r.idem_key && r.scope === 'odoo_upsert' && r.state === 'claimed' && Number(r.claimed_at) <= now - 600);

if (!stale.length) return [];

// Written as dead letters rather than retried here on purpose. Replay already
// exists, it already reads the ledger, and it already knows how to skip what
// completed - reimplementing a second, subtly different recovery path inside
// the tick is how two recovery mechanisms end up disagreeing about the truth.
return stale.map(r => ({ json: {
  dlq_id: 'dlq-stale-' + C.stableHash(r.idem_key).slice(0, 12),
  lead_uid: r.lead_uid || '',
  stage_failed: 'LP-03 Route and Sync / Odoo Upsert',
  error_class: 'transient',
  error: 'the CRM write was claimed at ' + new Date(Number(r.claimed_at) * 1000).toISOString() +
    ' and never completed. The execution probably died between the claim and the response.',
  payload_json: JSON.stringify({ idem_key: r.idem_key, claimed_at: r.claimed_at, detected_by: 'LP-04 Tick', replay: { workflow: 'LP-02 Qualify' } }),
  attempts: Number(r.attempts || 1),
  state: 'open',
  first_seen: Number(r.claimed_at),
  last_seen: now,
} }));
`,
    },

    {
      n: 'Write Stale Dead Letter',
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
            state: '={{ $json.state }}',
            first_seen: '={{ $json.first_seen }}',
            last_seen: '={{ $json.last_seen }}',
          },
          matchingColumns: ['dlq_id'],
          schema: [],
        },
        options: {},
      },
    },

    // =======================================================================
    // C. Owner health
    // =======================================================================
    {
      n: 'Read All Agents',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'get',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_agents' },
        returnAll: true,
        filters: { conditions: [] },
      },
      alwaysOutputData: true,
    },

    {
      n: 'Read Active Leads',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'get',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_lead' },
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'status', condition: 'eq', keyValue: 'active' }] },
        returnAll: true,
      },
      alwaysOutputData: true,
    },

    {
      n: 'Find Orphaned Leads',
      t: 'code',
      code: `
// EDGE CASE 9. Nothing errors when a salesperson goes on leave, which is
// exactly the problem: their leads keep sitting there, the SLA quietly passes,
// and the first sign of trouble is a customer who never heard back.
const agents = $('Read All Agents').all().map(i => i.json)
  .filter(a => a && a.agent_id)
  .map(a => ({
    ...a,
    available: a.available === true || String(a.available) === 'true',
    capacity: Number(a.capacity || 0),
    open_leads: Number(a.open_leads || 0),
  }));

const byId = new Map(agents.map(a => [String(a.agent_id), a]));
const now = Math.floor(Date.now() / 1000);

const leads = $input.all().map(i => i.json)
  .filter(r => r && r.lead_uid && r.status === 'active' && r.owner_id);

const orphans = leads.filter(l => {
  const a = byId.get(String(l.owner_id));
  return !a || !a.available;
});

if (!orphans.length) return [];

// Reassign in-process, so several orphans in one sweep spread across the team
// instead of every one of them landing on whoever happens to be least loaded
// at the moment the scan starts.
const working = agents.map(a => ({ ...a }));
const out = [];

for (const lead of orphans) {
  const pick = C.pickOwner(working, lead.service_interest, 'mgr-01');
  const target = working.find(a => a.agent_id === pick.agent_id);
  if (target) target.open_leads += 1;

  const previous = byId.get(String(lead.owner_id));
  out.push({ json: {
    ...lead,
    previous_owner: lead.owner_id,
    previous_owner_state: previous ? 'unavailable' : 'no longer on the roster',
    owner_id: pick.agent_id,
    assign_rung: pick.rung,
    odoo_user_id: Number(target?.odoo_user_id || 0),
    reassigned_at: now,
    reason: 'owner ' + lead.owner_id + ' is ' + (previous ? 'unavailable' : 'not on the roster') +
      ', reassigned to ' + pick.agent_id + ' (rung ' + pick.rung + ')',
  } });
}

return out;
`,
    },

    {
      n: 'Reassign Lead',
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
            score: '={{ $json.score }}',
            score_breakdown_json: '={{ $json.score_breakdown_json }}',
            band: '={{ $json.band }}',
            ai_status: '={{ $json.ai_status }}',
            ai_intent: '={{ $json.ai_intent }}',
            ai_urgency: '={{ $json.ai_urgency }}',
            ai_signals: '={{ $json.ai_signals }}',
            ai_reason: '={{ $json.ai_reason }}',
            ai_confidence: '={{ $json.ai_confidence }}',
            owner_id: '={{ $json.owner_id }}',
            assign_rung: '={{ $json.assign_rung }}',
            odoo_lead_id: '={{ $json.odoo_lead_id }}',
            odoo_stage: '={{ $json.odoo_stage }}',
            approval_state: '={{ $json.approval_state }}',
            approval_by: '={{ $json.approval_by }}',
            status: 'active',
            merged_into: '={{ $json.merged_into }}',
            raw_json: '={{ $json.raw_json }}',
            updated_at: '={{ $json.reassigned_at }}',
          },
          matchingColumns: ['lead_uid'],
          schema: [],
        },
        options: {},
      },
      notes: 'Every column is remapped from the row that was just read, because the Data Table\n'
        + 'node upserts whole rows and has no partial update. Reading the full row first is\n'
        + 'what makes that safe - the two other fields are the only ones that change.',
    },

    {
      n: 'Reassign in Odoo',
      t: 'executeWorkflow',
      p: {
        workflowId: '@LP-90 Odoo Gateway',
        mode: 'each',
        workflowInputs: {
          mappingMode: 'defineBelow',
          value: {
            model: 'crm.lead',
            method: 'write',
            args_json: '={{ JSON.stringify([[Number($json.odoo_lead_id)], { user_id: Number($json.odoo_user_id) }]) }}',
            kwargs_json: '{}',
            purpose: 'reassign after owner became unavailable',
            lead_uid: '={{ $json.lead_uid }}',
          },
          matchingColumns: [],
          schema: [],
        },
        options: { waitForSubWorkflow: false },
      },
      notes: 'The CRM has to agree, or the salesperson opening Odoo still sees the old owner and\n'
        + 'the reassignment exists only in our own table. Not waited on: a failed CRM write\n'
        + 'here raises its own dead letter and the local record is already correct.',
    },

    {
      n: 'Write Reassign Audit',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'insert',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_audit' },
        columns: {
          mappingMode: 'defineBelow',
          value: {
            event_id: '={{ $json.lead_uid + ":reassigned:" + $json.reassigned_at }}',
            lead_uid: '={{ $json.lead_uid }}',
            ts: '={{ $json.reassigned_at }}',
            workflow: 'LP-04 Tick',
            execution_id: '={{ $execution.id }}',
            type: 'assigned',
            decision: '={{ $json.previous_owner + " -> " + $json.owner_id }}',
            detail_json: '={{ JSON.stringify({ reason: $json.reason, previous_owner_state: $json.previous_owner_state, rung: $json.assign_rung, trigger: "owner health scan" }) }}',
          },
          matchingColumns: [],
          schema: [],
        },
        options: {},
      },
      onError: 'continueRegularOutput',
    },

    {
      n: 'note',
      t: 'sticky',
      at: [-1020, -640],
      w: 820,
      h: 340,
      content: '## LP-04 Tick - every 5 minutes, three jobs\n\n'
        + '**A. Drain the due queue.** Follow-ups and SLA timers are rows with a `due_at`, not Wait '
        + 'nodes - which is the only reason cancellation works: a held-open Wait cannot be cancelled '
        + 'cleanly and does not survive a restart. Batch capped at 25; the rest wait for the next tick. '
        + '**(EC-10)**\n\n'
        + '**B. Self-heal.** Jobs stuck `inflight` for 15 min (a tick died mid-batch) are requeued, 3 '
        + 'strikes then failed. CRM claims stuck `claimed` for 10 min are dead-lettered for the replay '
        + 'path rather than retried here - two recovery mechanisms would eventually disagree. **(EC-7)**\n\n'
        + '**C. Owner health.** A salesperson going unavailable errors nothing, so nothing notices. The '
        + 'scan finds their leads, reassigns them across the team, and writes it to Odoo too. **(EC-9)**\n\n'
        + '5 minutes, not 1: the smallest window that matters is the 30-minute SLA.',
    },
  ],

  flow: [
    ['Every 5 Minutes', 'Read Due Jobs'],
    ['Every 5 Minutes', 'Read Stuck Jobs'],
    ['Every 5 Minutes', 'Read Stale Claims'],
    ['Every 5 Minutes', 'Read All Agents'],

    ['Run Tick Now', 'Read Due Jobs'],
    ['Run Tick Now', 'Read Stuck Jobs'],
    ['Run Tick Now', 'Read Stale Claims'],
    ['Run Tick Now', 'Read All Agents'],

    ['Read Due Jobs', 'Claim Batch'],
    ['Claim Batch', 'Mark In Flight'],
    ['Mark In Flight', 'Read Job Leads'],
    ['Read Job Leads', 'Plan Job Actions'],
    ['Plan Job Actions', 'Route Job'],
    ['Route Job', 'Send Follow-up', 0],
    ['Route Job', 'Escalate SLA', 1],
    ['Route Job', 'Record Job Outcome', 2],
    ['Send Follow-up', 'Record Job Outcome'],
    ['Escalate SLA', 'Record Job Outcome'],
    ['Record Job Outcome', 'Update Job Row'],
    ['Record Job Outcome', 'Write Job Audit'],

    ['Read Stuck Jobs', 'Requeue Stuck'],
    ['Requeue Stuck', 'Update Job Row'],

    ['Read Stale Claims', 'Dead-letter Stale Claims'],
    ['Dead-letter Stale Claims', 'Write Stale Dead Letter'],

    ['Read All Agents', 'Read Active Leads'],
    ['Read Active Leads', 'Find Orphaned Leads'],
    ['Find Orphaned Leads', 'Reassign Lead'],
    ['Find Orphaned Leads', 'Reassign in Odoo'],
    ['Find Orphaned Leads', 'Write Reassign Audit'],
  ],
};
