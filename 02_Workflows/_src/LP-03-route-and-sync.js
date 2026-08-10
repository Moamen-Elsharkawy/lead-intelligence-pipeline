/**
 * LP-03 Route and Sync - the only workflow in the system with side effects.
 *
 * LP-02 decided; this one acts. Everything that changes the outside world
 * happens here and nowhere else: the CRM write, the owner assignment, the
 * scheduled follow-ups, the outbound message. One writer per fact.
 *
 * Order is the design:
 *
 *   1. SEARCH BEFORE CREATE, always, against Odoo itself and not just our own
 *      index. Our index can be behind; Odoo is the system of record. The search
 *      runs with active_test:false, so a previously LOST opportunity is visible
 *      - without that, a lead the team already rejected is created again as if
 *      it were new. (EC-1, EC-2)
 *   2. CLAIM, then write. The ledger row goes in before the Odoo call, so a
 *      crash between the two is detectable rather than invisible. (EC-7)
 *   3. Write, then complete the claim with the Odoo id as the receipt.
 *   4. Only then: persist, schedule, and message.
 *
 * A failed CRM write throws on purpose. It is a real failure, it deserves a
 * dead letter, and the replay in LP-05 re-runs it safely because step 1 will
 * find whatever step 3 managed to create.
 */
module.exports = {
  file: 'LP-03-route-and-sync',
  name: 'LP-03 Route and Sync',
  purpose: 'Duplicate resolution, workload-aware assignment, idempotent Odoo upsert, stage transition, follow-up scheduling, outreach.',
  settings: { errorWorkflow: '@LP-05 Error Handler and DLQ', executionTimeout: 240 },

  nodes: [
    {
      n: 'Route Call',
      t: 'executeWorkflowTrigger',
      p: {
        inputSource: 'workflowInputs',
        workflowInputs: { values: [{ name: 'verdict_json', type: 'string' }] },
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
      n: 'Parse Verdict',
      t: 'code',
      code: `
const cfg = Object.fromEntries(
  $input.all().map(i => i.json).filter(r => r && r.key).map(r => [r.key, r.value]),
);

let v;
try { v = JSON.parse($('Route Call').first().json.verdict_json || '{}'); }
catch (e) { throw new Error('LP-03: verdict_json was not valid JSON. ' + e.message); }

const lead = v.lead || {};
if (!lead.lead_uid) throw new Error('LP-03: the verdict carries no lead_uid.');

// --- the duplicate query -------------------------------------------------
// Built here rather than in an expression, because an Odoo domain is a nested
// array with prefix-notation operators: N clauses need N-1 leading '|'. Getting
// that count wrong does not error, it silently ANDs - and an AND of email and
// phone finds almost nothing, so the dedupe would appear to work and never fire.
const clauses = [];
clauses.push(['x_lp_lead_id', '=', lead.lead_uid]);
if (lead.email_norm) clauses.push(['email_from', '=ilike', lead.email_norm]);
if (lead.phone_key) {
  clauses.push(['phone', 'like', lead.phone_key]);
  clauses.push(['mobile', 'like', lead.phone_key]);
}
const domain = [...Array(clauses.length - 1).fill('|'), ...clauses];

return [{ json: {
  v,
  lead,
  lead_uid: lead.lead_uid,
  cfg: {
    base_url: String(cfg.base_url || '').replace(/\\/+$/, ''),
    manager_email: cfg.manager_email || '',
    fallback_owner_id: cfg.fallback_owner_id || 'mgr-01',
    sla_seconds: cfg.sla_seconds || '',
  },
  dup_args_json: JSON.stringify([domain]),
  dup_kwargs_json: JSON.stringify({
    fields: ['id', 'name', 'email_from', 'phone', 'mobile', 'partner_name', 'contact_name',
      'stage_id', 'x_lp_lead_id', 'active', 'user_id', 'create_date'],
    limit: 20,
    // active_test:false is injected by LP-90 for every search, so a lost
    // opportunity is still found. Named here so the reason is not invisible.
    order: 'create_date asc',
  }),
} }];
`,
    },

    {
      n: 'Find in Odoo',
      t: 'executeWorkflow',
      p: {
        workflowId: '@LP-90 Odoo Gateway',
        mode: 'once',
        workflowInputs: {
          mappingMode: 'defineBelow',
          value: {
            model: 'crm.lead',
            method: 'search_read',
            args_json: '={{ $json.dup_args_json }}',
            kwargs_json: '={{ $json.dup_kwargs_json }}',
            purpose: 'duplicate check before create',
            lead_uid: '={{ $json.lead_uid }}',
          },
          matchingColumns: [],
          schema: [],
        },
        options: { waitForSubWorkflow: true },
      },
      notes: 'Waited on, unlike every other sub-workflow call in this system - the answer is\n'
        + 'needed before the next decision can be made. Bounded by LP-90\'s own retry budget\n'
        + '(3 tries, 8s cap), so it cannot hang this execution indefinitely.',
    },

    {
      n: 'Read Person Index',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'get',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_person_index' },
        matchType: 'anyCondition',
        filters: {
          conditions: [
            { keyName: 'email_norm', condition: 'eq', keyValue: "={{ $('Parse Verdict').first().json.lead.email_norm || '__no_email__' }}" },
            { keyName: 'phone_key', condition: 'eq', keyValue: "={{ $('Parse Verdict').first().json.lead.phone_key || '__no_phone__' }}" },
          ],
        },
        returnAll: true,
      },
      alwaysOutputData: true,
      onError: 'continueRegularOutput',
      notes: 'anyCondition, so either identifier finds the person - the same human reaching us\n'
        + 'by email one week and WhatsApp the next has only one of the two in common.\n\n'
        + 'The __no_email__ / __no_phone__ sentinels are load-bearing. An empty string would\n'
        + 'become `email_norm = ""`, which MATCHES EVERY WhatsApp-sourced row (they all have\n'
        + 'no email) and would merge unrelated people into one another. A sentinel that\n'
        + 'cannot occur in real data matches nothing, which is the intended meaning of\n'
        + '"I have no email to search on".',
    },

    {
      n: 'Decide Duplicate',
      t: 'code',
      code: `
const ctx = $('Parse Verdict').first().json;
const lead = ctx.lead;
const gw = $('Find in Odoo').first().json;

if (!gw.ok) {
  // Cannot see the CRM, so cannot know whether this person is already in it.
  // Creating anyway is how duplicates are born. Fail, dead-letter, replay.
  throw new Error('LP-03: the duplicate check against Odoo failed (' + gw.error_class + ': ' + gw.error + '). Refusing to create a lead blind.');
}

const found = Array.isArray(gw.result) ? gw.result : [];

// Our own index, for the name/company signals Odoo's search cannot express.
const indexRows = $input.all().map(i => i.json)
  .filter(r => r && r.person_key && r.lead_uid && r.lead_uid !== lead.lead_uid);

// --- was THIS lead already written? --------------------------------------
// The external key is ours, so a hit here is not a duplicate person - it is
// proof that a previous run of this exact lead reached Odoo. EC-7.
const self = found.find(r => String(r.x_lp_lead_id || '') === lead.lead_uid);

// --- is this a duplicate PERSON? -----------------------------------------
const others = found.filter(r => String(r.x_lp_lead_id || '') !== lead.lead_uid);
let best = null;
for (const r of others) {
  const cand = {
    phone_key: C.phoneKey(r.phone || r.mobile || ''),
    email_norm: C.normEmail(r.email_from || ''),
    full_name: r.contact_name || r.name || '',
    company: r.partner_name || '',
    domain: C.domainOf(C.normEmail(r.email_from || '')),
  };
  const conf = C.dupConfidence(lead, cand);
  if (!best || conf.score > best.conf.score) best = { row: r, conf };
}

let dup_action = 'create';
let dup_reason = 'no existing opportunity matched';
let target_id = 0;

if (self) {
  dup_action = 'update_self';
  target_id = Number(self.id);
  dup_reason = 'this lead_uid already exists in Odoo as opportunity ' + self.id +
    ', so a previous run got as far as the CRM write. Updating it instead of creating a second one.';
} else if (best && best.conf.score >= C.DUP.HIGH) {
  // High confidence: the same person. Never create, never delete - attach to
  // the opportunity that already exists and record the merge. (EC-1)
  dup_action = 'merge_into';
  target_id = Number(best.row.id);
  dup_reason = 'matched opportunity ' + best.row.id + ' on ' + best.conf.on +
    ' at confidence ' + best.conf.score + (best.row.active === false ? ' (previously lost, found because active_test is off)' : '');
} else if (best && best.conf.score >= C.DUP.MEDIUM) {
  // Ambiguous. Create it - losing a real lead is worse - but stage it for a
  // human, with the candidate named so the review takes seconds.
  dup_action = 'create_flagged';
  target_id = Number(best.row.id);
  dup_reason = 'possible duplicate of opportunity ' + best.row.id + ' on ' + best.conf.on +
    ' at confidence ' + best.conf.score + ', below the auto-merge floor of ' + C.DUP.HIGH;
}

const indexHit = indexRows[0];
if (dup_action === 'create' && indexHit) {
  dup_reason = 'our person index has seen ' + indexHit.person_key + ' before (lead ' + indexHit.lead_uid +
    ') but Odoo has no matching opportunity, so this is treated as new';
}

// A flagged duplicate overrides the band: a human decides before any outbound.
const band = dup_action === 'create_flagged' ? 'manual_review' : ctx.v.band;

return [{ json: {
  ...ctx,
  band,
  band_overridden: band !== ctx.v.band,
  dup_action,
  dup_reason,
  dup_target_id: target_id,
  dup_candidates: found.length,
  merged_into: dup_action === 'merge_into' ? String(best.row.x_lp_lead_id || ('odoo:' + best.row.id)) : '',
  upsert_key: 'odoo_upsert:' + lead.lead_uid,
} }];
`,
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
            kwargs_json: '={{ JSON.stringify({ fields: ["id","name","sequence","is_won"], limit: 100 }) }}',
            purpose: 'stage name to id map',
            lead_uid: '={{ $json.lead_uid }}',
          },
          matchingColumns: [],
          schema: [],
        },
        options: { waitForSubWorkflow: true },
      },
      notes: 'Fetched every run rather than cached. One extra round trip per lead buys the\n'
        + 'guarantee that a stage added or renamed in Odoo this morning is honoured this\n'
        + 'afternoon - no cache to invalidate and no "why did it go to the wrong column"\n'
        + 'to debug. Caching it in lp_config with a TTL is the named optimisation if lead\n'
        + 'volume ever makes the call worth removing.',
    },

    {
      n: 'Read Agents',
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
      n: 'Assign Owner',
      t: 'code',
      code: `
const ctx = $('Decide Duplicate').first().json;
const lead = ctx.lead;
const stageGw = $('Read Stage Map').first().json;

if (!stageGw.ok) throw new Error('LP-03: could not read the Odoo stage list (' + stageGw.error + ').');

const stages = {};
for (const s of stageGw.result || []) stages[String(s.name).trim().toLowerCase()] = Number(s.id);

// --- which stage does this outcome map to? -------------------------------
// One lookup table decides the whole funnel. Nothing else in the system moves a
// stage, so "when does a lead reach Qualified" has exactly one answer to read.
const EVENT_BY_BAND = {
  vip: 'vip_pending_approval',
  qualified: 'qualified_assigned',
  nurture: 'nurture_assigned',
  data_completion: 'missing_critical_data',
  manual_review: ctx.dup_action === 'create_flagged' ? 'duplicate_ambiguous' : 'ai_rule_conflict',
  unqualified: 'lead_created',
};
const event = EVENT_BY_BAND[ctx.band] || 'lead_created';
const stageName = C.STAGE_TRANSITIONS[event] || C.STAGES.NEW;
const stage_id = stages[stageName.toLowerCase()] || stages['new'] || 0;

if (!stage_id) {
  throw new Error('LP-03: Odoo has no stage named "' + stageName + '" and no "New" to fall back to. Run LP-00 Setup and Seed, which creates the five extra stages.');
}

// --- close, or route? ----------------------------------------------------
// Lost is not a stage in Odoo: it is active=false plus probability 0 plus a
// reason. Trying to model it as a stage produces a pipeline column full of
// corpses.
const close = ctx.band === 'unqualified' || ctx.v.outcome === 'suppressed';
const lost_reason = ctx.v.outcome === 'suppressed'
  ? C.LOST_REASONS.opted_out
  : (ctx.dup_action === 'merge_into' ? C.LOST_REASONS.duplicate_merged : C.LOST_REASONS.unqualified_closed);

// --- assignment ----------------------------------------------------------
// Three rungs, deterministic, tie-broken by agent_id so the same inputs always
// produce the same owner and the routing is testable rather than "whoever the
// table happened to return first".
const agents = $input.all().map(i => i.json).filter(a => a && a.agent_id).map(a => ({
  ...a,
  available: a.available === true || String(a.available) === 'true',
  capacity: Number(a.capacity || 0),
  open_leads: Number(a.open_leads || 0),
}));

let owner = { agent_id: '', rung: 0, alert: false };
// Nobody owns a closed lead or a lead waiting on a human decision - assigning
// one only inflates a salesperson's open count with work they cannot do.
const assignable = !close && ctx.band !== 'manual_review';
if (assignable) {
  owner = C.pickOwner(agents, lead.service_interest, ctx.cfg.fallback_owner_id);
}

const ownerRow = agents.find(a => a.agent_id === owner.agent_id);
const odoo_user_id = Number(ownerRow?.odoo_user_id || 0);

return [{ json: {
  ...ctx,
  stage_id,
  stage_name: stageName,
  stage_event: event,
  close,
  lost_reason,
  owner_id: owner.agent_id,
  owner_email: ownerRow?.email || '',
  owner_name: ownerRow?.name || '',
  odoo_user_id,
  assign_rung: owner.rung,
  assign_alert: !!owner.alert,
  assign_reason: !assignable
    ? (close ? 'closed leads are not assigned' : 'held for human review before assignment')
    : C.ASSIGN_RUNGS[owner.rung - 1] || 'unassigned',
  no_capacity: assignable && owner.rung === 3,
}}];
`,
      notes: 'Rung 3 (nobody available or nobody with headroom) does NOT drop the lead. It goes\n'
        + 'to the configured fallback owner and raises an alert, because an unassigned lead\n'
        + 'is a lead nobody is accountable for - the failure mode this rung exists to\n'
        + 'prevent. The tick in LP-04 reassigns it when capacity frees up. (EC-9)',
    },

    {
      n: 'Read Upsert Claim',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'get',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_idem' },
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'idem_key', condition: 'eq', keyValue: '={{ $json.upsert_key }}' }] },
        returnAll: true,
      },
      alwaysOutputData: true,
      onError: 'continueRegularOutput',
    },

    {
      n: 'Build Odoo Write',
      t: 'code',
      code: `
const ctx = $('Assign Owner').first().json;
const lead = ctx.lead;
const v = ctx.v;

const claim = $input.all().map(i => i.json)
  .find(r => r && r.idem_key === ctx.upsert_key && r.scope !== undefined);

// --- the receipt check ---------------------------------------------------
// A ledger row in state 'done' carries the Odoo id it produced. Combined with
// the search above, this is the full answer to "did the last run get through?"
//   done            -> we have the id, update it
//   claimed, found  -> the write landed and the acknowledgement did not (EC-7)
//   claimed, absent -> the write never landed, create
const claimedBefore = !!claim && claim.state === 'claimed';
const alreadyDone = !!claim && claim.state === 'done' && Number(claim.result_ref) > 0;

let target_id = 0;
let method = 'create';
let recovery = '';

if (alreadyDone) {
  target_id = Number(claim.result_ref);
  method = 'write';
  recovery = 'the ledger already holds Odoo id ' + target_id + ' for this lead';
} else if (ctx.dup_action === 'update_self' || ctx.dup_action === 'merge_into') {
  target_id = ctx.dup_target_id;
  method = 'write';
  if (claimedBefore && ctx.dup_action === 'update_self') {
    recovery = 'PARTIAL SUCCESS RECOVERED: the ledger says claimed but never completed, and Odoo already holds opportunity ' +
      target_id + ' under this external key. The previous run created it and lost the response.';
  }
} else if (claimedBefore) {
  recovery = 'a previous attempt claimed this key but Odoo has no matching record, so the write genuinely never landed. Creating.';
}

// --- the payload ---------------------------------------------------------
const title = [lead.company || lead.full_name || 'Inbound lead',
  lead.service_interest && lead.service_interest !== 'unknown' ? lead.service_interest.replace(/_/g, ' ') : '']
  .filter(Boolean).join(' - ');

const PRIORITY = { vip: '3', qualified: '2', nurture: '1' };

const values = {
  name: title.slice(0, 120),
  type: 'opportunity',
  contact_name: lead.full_name || '',
  email_from: lead.email_raw || lead.email_norm || '',
  phone: lead.phone_e164 || lead.phone_raw || '',
  partner_name: lead.company || '',
  description: [
    'Source: ' + lead.source + (lead.sub_source ? ' / ' + lead.sub_source : ''),
    'Lead id: ' + lead.lead_uid,
    'Score: ' + v.score + '  Band: ' + ctx.band + (ctx.band_overridden ? ' (overridden: ' + ctx.dup_reason + ')' : ''),
    'Consent: ' + lead.consent + ' (' + lead.consent_source + ')',
    v.ai_status === 'ok'
      ? 'AI read: ' + v.ai_intent + ' intent, confidence ' + v.ai_confidence + '. ' + v.ai_reason
      : 'AI read: ' + v.ai_status + (v.ai_note ? ' (' + v.ai_note + ')' : ''),
    '',
    'What they wrote:',
    lead.free_text || '(nothing)',
  ].join('\\n').slice(0, 4000),
  x_lp_lead_id: lead.lead_uid,
  stage_id: ctx.stage_id,
  priority: PRIORITY[ctx.band] || '0',
};

if (ctx.odoo_user_id > 0) values.user_id = ctx.odoo_user_id;

// Closing is a field change, not a stage change.
if (ctx.close) {
  values.active = false;
  values.probability = 0;
}

const args = method === 'create' ? [[values]] : [[target_id], values];

return [{ json: {
  ...ctx,
  odoo_method: method,
  odoo_target_id: target_id,
  odoo_args_json: JSON.stringify(args),
  recovery,
  claim_state_before: claim?.state || 'none',
  claimed_at: Math.floor(Date.now() / 1000),
} }];
`,
    },

    {
      n: 'Claim Odoo Upsert',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'upsert',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_idem' },
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'idem_key', condition: 'eq', keyValue: '={{ $json.upsert_key }}' }] },
        columns: {
          mappingMode: 'defineBelow',
          value: {
            idem_key: '={{ $json.upsert_key }}',
            scope: 'odoo_upsert',
            lead_uid: '={{ $json.lead_uid }}',
            state: 'claimed',
            result_ref: '={{ String($json.odoo_target_id || "") }}',
            claimed_at: '={{ $json.claimed_at }}',
            completed_at: 0,
            attempts: 1,
          },
          matchingColumns: ['idem_key'],
          schema: [],
        },
        options: {},
      },
      notes: 'Written BEFORE the CRM call, deliberately. A crash between this node and the next\n'
        + 'leaves a row saying "someone started writing this lead to Odoo and never said it\n'
        + 'finished" - which is a fact the reconciler can act on. Claiming afterwards would\n'
        + 'leave no trace at all, and the lead would look untouched while an opportunity sat\n'
        + 'in the CRM.',
    },

    {
      n: 'Odoo Upsert',
      t: 'executeWorkflow',
      p: {
        workflowId: '@LP-90 Odoo Gateway',
        mode: 'once',
        workflowInputs: {
          mappingMode: 'defineBelow',
          value: {
            model: 'crm.lead',
            method: "={{ $('Build Odoo Write').first().json.odoo_method }}",
            args_json: "={{ $('Build Odoo Write').first().json.odoo_args_json }}",
            kwargs_json: '{}',
            purpose: "={{ 'crm upsert (' + $('Build Odoo Write').first().json.odoo_method + ')' }}",
            lead_uid: "={{ $('Build Odoo Write').first().json.lead_uid }}",
          },
          matchingColumns: [],
          schema: [],
        },
        options: { waitForSubWorkflow: true },
      },
      notes: 'Every input reads from Build Odoo Write by name rather than from $json, because\n'
        + '$json here is the row the claim node returned. Referencing the source node makes\n'
        + 'the chain order explicit and removes any dependence on what a Data Table write\n'
        + 'happens to emit.',
    },

    {
      n: 'Record Upsert',
      t: 'code',
      code: `
const ctx = $('Build Odoo Write').first().json;
const gw = $input.first().json;

if (!gw.ok) {
  // A failed CRM write is a real failure. Throwing sends it to LP-05, which
  // dead-letters it with the lead attached; the replay re-runs LP-02 -> LP-03
  // and the search-before-create at the top finds anything this attempt did
  // manage to write. Swallowing it would leave a scored lead that exists
  // nowhere a salesperson can see.
  throw new Error('LP-03: Odoo ' + ctx.odoo_method + ' failed (' + gw.error_class + '): ' + gw.error);
}

// create returns an id; write returns true. Both have to end up as an id.
const odoo_lead_id = ctx.odoo_method === 'create'
  ? Number(Array.isArray(gw.result) ? gw.result[0] : gw.result)
  : Number(ctx.odoo_target_id);

if (!Number.isFinite(odoo_lead_id) || odoo_lead_id <= 0) {
  throw new Error('LP-03: Odoo ' + ctx.odoo_method + ' reported success but returned no usable id: ' + JSON.stringify(gw.result).slice(0, 200));
}

const now = Math.floor(Date.now() / 1000);
const lead = ctx.lead;
const v = ctx.v;

// --- what happens next, decided once -------------------------------------
// A single table instead of the same band conditional repeated in four places.
const PLAN = {
  qualified:       { cadence: 'qualified', sla: true,  template: 'confirm_qualified', to: 'lead' },
  vip:             { cadence: null,        sla: true,  template: 'vip_approval',      to: 'manager' },
  nurture:         { cadence: 'nurture',   sla: false, template: 'confirm_nurture',   to: 'lead' },
  data_completion: { cadence: 'data',      sla: false, template: 'ask_missing',       to: 'lead' },
  manual_review:   { cadence: null,        sla: true,  template: 'review_notice',     to: 'manager' },
  unqualified:     { cadence: null,        sla: false, template: '',                  to: '' },
};
const plan = PLAN[ctx.band] || PLAN.unqualified;

// VIP sends nothing to the lead until a manager approves (EC-12), and a
// suppressed person is never messaged at all.
const suppressed = v.outcome === 'suppressed';
const channel = lead.email_norm ? 'email' : (lead.phone_e164 ? 'whatsapp' : '');
const recipient = plan.to === 'manager' ? ctx.cfg.manager_email
  : plan.to === 'lead' ? (lead.email_norm || lead.phone_e164) : '';

const should_send = !suppressed && !!plan.template && !!recipient
  && (plan.to === 'manager' || !!channel);

return [{ json: {
  ...ctx,
  odoo_lead_id,
  odoo_created: ctx.odoo_method === 'create',
  completed_at: now,
  plan_cadence: plan.cadence || '',
  plan_sla: plan.sla,
  approval_state: ctx.band === 'vip' ? 'pending' : 'not_required',
  outreach: {
    should_send,
    template: plan.template,
    // A manager notice always goes by email; only lead-facing messages follow
    // the channel the lead actually reached us on.
    channel: plan.to === 'manager' ? 'email' : channel,
    to: recipient,
    audience: plan.to,
    skip_reason: should_send ? ''
      : suppressed ? 'consent denied'
      : !plan.template ? 'nothing to say to an unqualified lead'
      : 'no usable ' + (plan.to === 'manager' ? 'manager email in lp_config' : 'contact channel'),
  },
  note_body: [
    'Processed by the lead pipeline.',
    'Score ' + v.score + ' -> ' + ctx.band + '. ' + (v.band_reason || ''),
    'Owner: ' + (ctx.owner_name || 'unassigned') + ' (rung ' + ctx.assign_rung + ': ' + ctx.assign_reason + ')',
    'Duplicate check: ' + ctx.dup_reason,
    ctx.recovery ? 'Recovery: ' + ctx.recovery : '',
    'Enrichment: ' + v.enrich_status + '. AI: ' + v.ai_status + (v.ai_status === 'ok' ? ' (' + v.ai_intent + ', ' + v.ai_confidence + ')' : ''),
  ].filter(Boolean).join('<br/>'),
} }];
`,
    },

    // --- everything below fans out from a successful CRM write -------------
    {
      n: 'Complete Claim',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'upsert',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_idem' },
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'idem_key', condition: 'eq', keyValue: '={{ $json.upsert_key }}' }] },
        columns: {
          mappingMode: 'defineBelow',
          value: {
            idem_key: '={{ $json.upsert_key }}',
            scope: 'odoo_upsert',
            lead_uid: '={{ $json.lead_uid }}',
            state: 'done',
            result_ref: '={{ String($json.odoo_lead_id) }}',
            claimed_at: '={{ $json.claimed_at }}',
            completed_at: '={{ $json.completed_at }}',
            attempts: 1,
          },
          matchingColumns: ['idem_key'],
          schema: [],
        },
        options: {},
      },
      notes: 'result_ref is the Odoo id. That single field is what makes a later replay able to\n'
        + 'say "already done, here is the record" instead of writing a second opportunity.',
    },

    {
      n: 'Update Lead Record',
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
            source: '={{ $json.lead.source }}',
            source_ref: '={{ $json.lead.source_ref }}',
            received_at: '={{ $json.lead.received_at }}',
            full_name: '={{ $json.lead.full_name }}',
            email_raw: '={{ $json.lead.email_raw }}',
            email_norm: '={{ $json.lead.email_norm }}',
            phone_raw: '={{ $json.lead.phone_raw }}',
            phone_e164: '={{ $json.lead.phone_e164 }}',
            phone_key: '={{ $json.lead.phone_key }}',
            country: '={{ $json.lead.country }}',
            company: '={{ $json.lead.company }}',
            domain: '={{ $json.lead.domain }}',
            service_interest: '={{ $json.lead.service_interest }}',
            free_text: '={{ $json.lead.free_text }}',
            consent: '={{ $json.lead.consent }}',
            consent_source: '={{ $json.lead.consent_source }}',
            score: '={{ $json.v.score }}',
            score_breakdown_json: '={{ $json.v.score_breakdown_json }}',
            band: '={{ $json.band }}',
            ai_status: '={{ $json.v.ai_status }}',
            ai_intent: '={{ $json.v.ai_intent }}',
            ai_urgency: '={{ $json.v.ai_urgency }}',
            ai_signals: '={{ $json.v.ai_signals }}',
            ai_reason: '={{ $json.v.ai_reason }}',
            ai_confidence: '={{ $json.v.ai_confidence }}',
            owner_id: '={{ $json.owner_id }}',
            assign_rung: '={{ $json.assign_rung }}',
            odoo_lead_id: '={{ $json.odoo_lead_id }}',
            odoo_stage: '={{ $json.close ? "Lost" : $json.stage_name }}',
            approval_state: '={{ $json.approval_state }}',
            approval_by: '',
            status: '={{ $json.dup_action === "merge_into" ? "merged" : ($json.close ? "closed" : "active") }}',
            merged_into: '={{ $json.merged_into }}',
            raw_json: '={{ $json.lead.raw_json || "" }}',
            updated_at: '={{ $json.completed_at }}',
          },
          matchingColumns: ['lead_uid'],
          schema: [],
        },
        options: {},
      },
      notes: 'Every column is mapped, not just the changed ones. The Data Table node has no\n'
        + 'partial update - an upsert rewrites the whole row - so omitting a field blanks it.\n'
        + 'That is a real limitation of the free built-in store and it is listed as such in\n'
        + 'the design doc; on Postgres this would be an UPDATE ... SET of four columns.',
    },

    {
      n: 'Register Person',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'upsert',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_person_index' },
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'person_key', condition: 'eq', keyValue: '={{ $json.lead.person_key }}' }] },
        columns: {
          mappingMode: 'defineBelow',
          value: {
            person_key: '={{ $json.lead.person_key }}',
            lead_uid: '={{ $json.merged_into || $json.lead_uid }}',
            email_norm: '={{ $json.lead.email_norm }}',
            phone_key: '={{ $json.lead.phone_key }}',
            created_at: '={{ $json.completed_at }}',
          },
          matchingColumns: ['person_key'],
          schema: [],
        },
        options: {},
      },
      notes: 'The index points at the SURVIVING lead, so the next enquiry from this person\n'
        + 'resolves straight to the record that is actually being worked rather than to a\n'
        + 'merged-away one.',
    },

    {
      n: 'Post Odoo Note',
      t: 'executeWorkflow',
      p: {
        workflowId: '@LP-90 Odoo Gateway',
        mode: 'once',
        workflowInputs: {
          mappingMode: 'defineBelow',
          value: {
            model: 'crm.lead',
            method: 'message_post',
            args_json: '={{ JSON.stringify([[$json.odoo_lead_id]]) }}',
            kwargs_json: '={{ JSON.stringify({ body: $json.note_body, message_type: "comment" }) }}',
            purpose: 'crm-side audit note',
            lead_uid: '={{ $json.lead_uid }}',
          },
          matchingColumns: [],
          schema: [],
        },
        options: { waitForSubWorkflow: false },
      },
      notes: 'The audit trail a salesperson will actually read. Our lp_audit table is for\n'
        + 'operators; this puts the score, the reason, the owner and the duplicate decision\n'
        + 'in the chatter of the record itself, where the person working the deal is already\n'
        + 'looking. Not waited on - a missing note must never fail a lead.',
    },

    {
      n: 'Write Route Audit',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'insert',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_audit' },
        columns: {
          mappingMode: 'defineBelow',
          value: {
            event_id: '={{ $json.lead_uid + ":routed:" + $json.completed_at }}',
            lead_uid: '={{ $json.lead_uid }}',
            ts: '={{ $json.completed_at }}',
            workflow: 'LP-03 Route and Sync',
            execution_id: '={{ $execution.id }}',
            type: 'odoo_upserted',
            decision: '={{ $json.odoo_method + " #" + $json.odoo_lead_id + " -> " + $json.stage_name }}',
            detail_json: '={{ JSON.stringify({ band: $json.band, stage: $json.stage_name, stage_event: $json.stage_event, closed: $json.close, duplicate: { action: $json.dup_action, reason: $json.dup_reason, candidates: $json.dup_candidates }, owner: { id: $json.owner_id, rung: $json.assign_rung, why: $json.assign_reason, alert: $json.assign_alert }, recovery: $json.recovery, outreach: $json.outreach }) }}',
          },
          matchingColumns: [],
          schema: [],
        },
        options: {},
      },
      onError: 'continueRegularOutput',
    },

    {
      n: 'Plan Jobs',
      t: 'code',
      code: `
const d = $input.first().json;
const now = d.completed_at;
const jobs = [];

// --- the SLA clock -------------------------------------------------------
// Started at assignment, not at intake, because the 30 minutes is the sales
// team's response window and the clock should not already be running when the
// lead lands on their desk.
if (d.plan_sla) {
  // 30 minutes per the brief, overridable from lp_config so a demo can watch a
  // breach happen in 60 seconds instead of waiting half an hour. The default is
  // the real rule; the override exists so the rule can be SHOWN working.
  const slaSeconds = Number(d.cfg.sla_seconds) > 0 ? Number(d.cfg.sla_seconds) : C.SLA_SECONDS;
  jobs.push({
    job_id: d.lead_uid + ':sla',
    job_type: 'sla',
    step: 0,
    template: 'sla_breach',
    due_at: now + slaSeconds,
  });
}

// --- the follow-up sequence ----------------------------------------------
// Rows with a due_at, drained by the tick in LP-04 - not Wait nodes. A Wait
// node cannot be cancelled cleanly when the lead replies or opts out, and it
// does not survive a restart. A queue drains late after an outage; a held-open
// Wait is simply gone. (EC-10)
const DATA_COMPLETION = [
  { step: 1, delay_s: 3600, template: 'dc_fu1', condition: 'always' },
  { step: 2, delay_s: 86400, template: 'dc_fu2', condition: 'always' },
];
const cadence = d.plan_cadence === 'data' ? DATA_COMPLETION : (C.CADENCE[d.plan_cadence] || []);

for (const step of cadence) {
  // Step 3 of the qualified sequence is conditional on the score. Evaluated
  // here rather than stored as a string for the tick to interpret: the score
  // cannot change between now and then, so a rule engine at send time would be
  // machinery with nothing to decide.
  if (step.condition === 'score>=85' && Number(d.v.score) < 85) continue;
  jobs.push({
    job_id: d.lead_uid + ':' + d.plan_cadence + ':' + step.step,
    job_type: 'followup',
    step: step.step,
    template: step.template,
    due_at: now + step.delay_s,
  });
}

if (!jobs.length) return [];

return jobs.map(j => ({ json: {
  ...j,
  lead_uid: d.lead_uid,
  state: 'pending',
  attempts: 0,
  claimed_at: 0,
  result: '',
  cancel_reason: '',
} }));
`,
    },

    {
      n: 'Write Jobs',
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
            state: '={{ $json.state }}',
            attempts: 0,
            claimed_at: 0,
            result: '',
            cancel_reason: '',
          },
          matchingColumns: ['job_id'],
          schema: [],
        },
        options: {},
      },
      notes: 'Upsert on a deterministic job_id (lead + cadence + step), so re-running this\n'
        + 'workflow reschedules the same three jobs instead of queueing three more. Without\n'
        + 'that, one replay would double every follow-up the lead receives.',
    },

    {
      n: 'Outreach?',
      t: 'if',
      p: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          combinator: 'and',
          conditions: [{
            id: 'should-send',
            leftValue: '={{ $json.outreach.should_send }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          }],
        },
        options: {},
      },
    },

    {
      n: 'Send Outreach',
      t: 'executeWorkflow',
      p: {
        workflowId: '@LP-92 Send Message',
        mode: 'once',
        workflowInputs: {
          mappingMode: 'defineBelow',
          value: {
            lead_uid: '={{ $json.lead_uid }}',
            channel: '={{ $json.outreach.channel }}',
            to: '={{ $json.outreach.to }}',
            template: '={{ $json.outreach.template }}',
            step: '0',
            context_json: '={{ JSON.stringify({ lead: $json.lead, score: $json.v.score, band: $json.band, owner_name: $json.owner_name, owner_email: $json.owner_email, odoo_lead_id: $json.odoo_lead_id, missing: $json.lead.validation_missing, dup_reason: $json.dup_reason, base_url: $json.cfg.base_url }) }}',
          },
          matchingColumns: [],
          schema: [],
        },
        options: { waitForSubWorkflow: false },
      },
    },

    {
      n: 'note',
      t: 'sticky',
      at: [-1000, -600],
      w: 800,
      h: 340,
      content: '## LP-03 Route and Sync\n\n'
        + '**The only workflow with side effects.** LP-02 decided; this one writes to Odoo, assigns '
        + 'an owner, schedules follow-ups and sends the message. One writer per fact.\n\n'
        + '**Search before create, every time** - against Odoo, not just our index, and with '
        + '`active_test:false` so a previously *lost* opportunity is visible. Without it, a lead the '
        + 'team already rejected gets recreated as new. **(EC-1, EC-2)**\n\n'
        + '**Claim -> write -> complete.** The ledger row goes in *before* the Odoo call, so a crash '
        + 'between them leaves evidence. `claimed` + a record found by external key = the write landed '
        + 'and the acknowledgement did not, and it is repaired instead of duplicated. **(EC-7)**\n\n'
        + '**Lost is not a stage** in Odoo - it is `active=false` + `probability=0` + a reason.\n\n'
        + '**Follow-ups are queue rows, not Wait nodes**, so an opt-out can cancel one. **(EC-10)**',
    },
  ],

  flow: [
    ['Route Call', 'Read Config'],
    ['Read Config', 'Parse Verdict'],
    ['Parse Verdict', 'Find in Odoo'],
    ['Find in Odoo', 'Read Person Index'],
    ['Read Person Index', 'Decide Duplicate'],
    ['Decide Duplicate', 'Read Stage Map'],
    ['Read Stage Map', 'Read Agents'],
    ['Read Agents', 'Assign Owner'],
    ['Assign Owner', 'Read Upsert Claim'],
    ['Read Upsert Claim', 'Build Odoo Write'],
    ['Build Odoo Write', 'Claim Odoo Upsert'],
    ['Claim Odoo Upsert', 'Odoo Upsert'],
    ['Odoo Upsert', 'Record Upsert'],

    // Fan-out after a confirmed CRM write. Each is keyed and idempotent, so no
    // ordering between them is load-bearing.
    ['Record Upsert', 'Complete Claim'],
    ['Record Upsert', 'Update Lead Record'],
    ['Record Upsert', 'Register Person'],
    ['Record Upsert', 'Write Route Audit'],
    ['Record Upsert', 'Post Odoo Note'],
    ['Record Upsert', 'Plan Jobs'],
    ['Record Upsert', 'Outreach?'],
    ['Plan Jobs', 'Write Jobs'],
    ['Outreach?', 'Send Outreach', 0],
  ],
};
