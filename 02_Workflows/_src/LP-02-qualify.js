/**
 * LP-02 Qualify - enrich, score, classify, and decide a band.
 *
 * This workflow DECIDES. It never writes to Odoo, never sends a message and
 * never assigns an owner; LP-03 does all of that. The split is deliberate:
 * qualification is pure reasoning over data and is therefore the part that can
 * be re-run at will, while LP-03 owns every side effect and every claim. If
 * this workflow is run twice nothing in the outside world changes.
 *
 * The two axes, kept genuinely independent (requirement D):
 *
 *   RULES   A deterministic 0-100 score from structured fields. Reproducible,
 *           explainable line by line, and unchanged by anything the AI says.
 *
 *   AI      A qualitative read of the free text: intent, urgency, buying
 *           signals, objections. It contributes ZERO POINTS. Delete this half
 *           of the workflow and every lead still scores, bands and routes.
 *
 * They are compared, not blended. A material disagreement (band distance >= 2
 * at confidence >= 0.7) sends the lead to a human instead of quietly picking a
 * winner. Adjacent disagreement is expected noise around a cut point and is
 * logged and ignored - a review queue that fills up is a review queue nobody
 * works.
 *
 * The AI is deliberately NOT shown the deterministic score. If it were, the
 * conflict check would be measuring how well the model anchors to a number it
 * was handed, not whether it actually disagrees.
 */
module.exports = {
  file: 'LP-02-qualify',
  name: 'LP-02 Qualify',
  purpose: 'Enrichment, deterministic scoring, independent AI classification, conflict detection, band decision.',
  settings: { errorWorkflow: '@LP-05 Error Handler and DLQ', executionTimeout: 180 },

  nodes: [
    {
      n: 'Qualify Call',
      t: 'executeWorkflowTrigger',
      p: {
        inputSource: 'workflowInputs',
        workflowInputs: { values: [{ name: 'lead_json', type: 'string' }] },
      },
      notes: 'One string input, not a mapped object. Sub-workflow inputs flatten nested data\n'
        + 'unpredictably and a lead carries its original payload, so the whole record crosses\n'
        + 'the boundary as JSON text and is parsed once on this side.',
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
      n: 'Parse Lead',
      t: 'code',
      code: `
const cfg = Object.fromEntries(
  $input.all().map(i => i.json).filter(r => r && r.key).map(r => [r.key, r.value]),
);

let lead;
try {
  lead = JSON.parse($('Qualify Call').first().json.lead_json || '{}');
} catch (e) {
  throw new Error('LP-02: lead_json was not valid JSON. ' + e.message);
}
if (!lead.lead_uid) throw new Error('LP-02: lead_json has no lead_uid, so nothing downstream can be keyed or replayed.');

// Consent denied means this person told us not to contact them. They are still
// recorded - a suppression list only works if it has the names on it - but they
// are not enriched, not sent to a paid model, and not messaged. Suppression is
// decided here and executed by LP-03.
const suppressed = lead.consent === 'denied';

const base_url = String(cfg.base_url || '').replace(/\\/+$/, '');
if (!base_url) throw new Error('LP-02: lp_config has no base_url. Run LP-00 Setup and Seed once.');

return [{ json: {
  lead,
  cfg: {
    base_url,
    // Cheapest capable model on the account, and a config value rather than a
    // hardcoded string so it can be changed without editing a node. Measured
    // list price at build time: $0.10 / 1M input, $0.40 / 1M output.
    ai_model: cfg.ai_model || 'google/gemini-2.5-flash-lite',
    manager_email: cfg.manager_email || '',
    fallback_owner_id: cfg.fallback_owner_id || 'mgr-01',
  },
  suppressed,
  // Enrichment needs a company domain. A free-provider address gives none, and
  // a WhatsApp lead has no email at all - both are normal, and the scorer
  // prices "unknown" rather than treating it as zero.
  should_enrich: !suppressed && !!lead.domain,
} }];
`,
    },

    {
      n: 'Enrich?',
      t: 'if',
      p: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          combinator: 'and',
          conditions: [{
            id: 'should-enrich',
            leftValue: '={{ $json.should_enrich }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          }],
        },
        options: {},
      },
    },

    {
      n: 'Enrich Company',
      t: 'http',
      p: {
        method: 'POST',
        url: '={{ $json.cfg.base_url }}/webhook/lp-mock-enrich',
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ domain: $json.lead.domain, company: $json.lead.company, country_hint: $json.lead.country }) }}',
        options: { timeout: 8000 },
      },
      creds: { httpHeaderAuth: { name: 'LP Webhook Token (X-LP-Token)' } },
      retry: { tries: 3, waitMs: 2000 },
      onError: 'continueRegularOutput',
      alwaysOutputData: true,
      notes: 'EDGE CASE 3, and the one place in this build where n8n\'s built-in retry is the\n'
        + 'right tool. The enrichment provider reports failure honestly through its status\n'
        + 'code (429, 500, timeout), so retryOnFail can see it. Odoo does not - it answers\n'
        + 'HTTP 200 on failure - which is why LP-90 hand-rolls its retry loop and this node\n'
        + 'does not need to.\n\n'
        + 'Timeout 8s against a 3-try budget: a hung provider costs at most ~30s, well inside\n'
        + 'the workflow timeout, and this path is asynchronous anyway - nobody is waiting.\n\n'
        + 'continueRegularOutput because enrichment is an ENHANCEMENT. A lead that cannot be\n'
        + 'enriched must still be scored and routed; failing the lead because a third party\n'
        + 'was down would be the pipeline punishing the customer for the vendor.\n\n'
        + 'Reproduce the failure: append ?fail=timeout&times=2 to the URL, and the third\n'
        + 'attempt succeeds.',
    },

    {
      n: 'Parse Enrichment',
      t: 'code',
      code: `
const ctx = $('Parse Lead').first().json;
const res = $input.first()?.json ?? {};

// Three ways this arrives wrong, and all three have been seen from real
// providers: an error object from the failed node, a JSON string instead of an
// object, and HTTP 200 with prose in the body (the "malformed" chaos mode).
// None of them may reach the scorer as if they were data.
function coerce(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return null; } }
  return null;
}

let payload = coerce(res.body !== undefined ? res.body : res);
let status = 'ok';
let note = '';

if (res.error || res.errorMessage) {
  status = 'unavailable';
  note = String(res.errorMessage || res.error?.message || 'enrichment call failed');
  payload = null;
} else if (!payload || typeof payload.found !== 'boolean') {
  // The status code said 200 and the body is not the contract. Treating this as
  // success is how "undefined" ends up in a score.
  status = 'unavailable';
  note = 'response did not match the enrichment contract (no boolean "found")';
  payload = null;
}

const enrich = (status === 'ok' && payload.found)
  ? {
      found: true,
      company_size: payload.company_size,
      industry: payload.industry,
      country: payload.country,
      strategic: payload.strategic === true || String(payload.strategic) === 'true',
      source: payload.source || 'provider',
    }
  : { found: false, source: status === 'ok' ? 'provider-miss' : 'unavailable' };

return [{ json: { ...ctx, enrich, enrich_status: status, enrich_note: note } }];
`,
    },

    {
      n: 'No Enrichment',
      t: 'code',
      code: `
const ctx = $input.first().json;
return [{ json: {
  ...ctx,
  enrich: { found: false, source: 'skipped' },
  enrich_status: 'skipped',
  enrich_note: ctx.suppressed
    ? 'consent denied, so no third party was called about this person'
    : 'no company domain to look up',
} }];
`,
      notes: 'A skipped enrichment is not a failed one, and the difference is recorded. Sending\n'
        + 'a person who asked not to be contacted to a data vendor would be a privacy\n'
        + 'incident, not an optimisation.',
    },

    {
      n: 'Score Lead',
      t: 'code',
      code: `
const ctx = $input.first().json;
const lead = ctx.lead;

// S.scoreLead is the exact function unit-tested by scripts/test-scoring.js -
// same file, inlined above by the build step. There is no second copy to drift.
const scored = scoreLead(lead, ctx.enrich || {});

// The AI is called only when there is something for it to read. A one-word
// WhatsApp message has no qualitative content, and paying a model to classify
// "hi" is the kind of cost that looks small per lead and is not per 100,000.
const text = String(lead.free_text || '').trim();
const needs_ai = !ctx.suppressed && !scored.disqualified && text.length >= 20;

return [{ json: {
  ...ctx,
  score: scored.score,
  rule_band: scored.band,
  strategic: scored.strategic,
  disqualified: scored.disqualified,
  disqualify_reason: scored.disqualify_reason || '',
  breakdown: scored.breakdown,
  score_breakdown_json: JSON.stringify(scored.breakdown),
  needs_ai,
  ai_skip_reason: needs_ai ? ''
    : (ctx.suppressed ? 'consent denied'
      : scored.disqualified ? 'hard-disqualified before any AI spend'
      : 'free text too short to classify (' + text.length + ' chars)'),
} }];
`,
    },

    {
      n: 'Need AI?',
      t: 'if',
      p: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          combinator: 'and',
          conditions: [{
            id: 'needs-ai',
            leftValue: '={{ $json.needs_ai }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          }],
        },
        options: {},
      },
    },

    {
      n: 'AI Classify',
      t: 'http',
      p: {
        method: 'POST',
        url: 'https://openrouter.ai/api/v1/chat/completions',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'openRouterApi',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: `={{ JSON.stringify({
  model: $json.cfg.ai_model,
  temperature: 0,
  max_tokens: 300,
  response_format: { type: "json_object" },
  messages: [
    { role: "system", content: "You classify inbound B2B sales enquiries for an automation consultancy. Return ONE JSON object and nothing else.\\n\\nSchema:\\n{\\"intent_level\\":\\"high|medium|low\\",\\"urgency\\":\\"immediate|this_quarter|exploring|unknown\\",\\"buying_signals\\":[\\"short phrase\\"],\\"objections\\":[\\"short phrase\\"],\\"reason\\":\\"under 200 characters\\",\\"confidence\\":0.0}\\n\\nRules:\\n- Judge only what is written. Never infer a company, a budget, a timeline or a job title that is not in the text.\\n- buying_signals and objections must be phrases the writer actually used. At most 3 and 2. Empty arrays are correct when there are none.\\n- reason must quote the words that decided it.\\n- If the text is too short or too vague to judge, use intent_level \\"low\\" and confidence 0.3 or less.\\n- confidence is your certainty in this classification, not how interested the lead is." },
    { role: "user", content: "Source: " + $json.lead.source + "\\nService asked for: " + ($json.lead.service_interest || "not stated") + "\\nCompany: " + ($json.lead.company || "not stated") + "\\n\\nWhat they wrote:\\n" + $json.lead.free_text }
  ]
}) }}`,
        options: { timeout: 20000 },
      },
      creds: { openRouterApi: { name: 'OpenRouter account' } },
      retry: { tries: 2, waitMs: 2000 },
      onError: 'continueRegularOutput',
      alwaysOutputData: true,
      notes: 'The prompt withholds the deterministic score ON PURPOSE. Show a model the number\n'
        + 'it is being checked against and it will agree with it, and the conflict detector\n'
        + 'then measures anchoring rather than disagreement.\n\n'
        + 'temperature 0 and response_format json_object: this is a classifier, not a writer.\n'
        + 'max_tokens 300 caps both the spend and the blast radius of a rambling answer.\n\n'
        + 'Cost at the model\'s list price ($0.10/1M in, $0.40/1M out) and this prompt size:\n'
        + 'roughly $0.09 per 1,000 classified leads, and only leads with real free text are\n'
        + 'classified at all.\n\n'
        + 'continueRegularOutput: edge case 4. An unavailable model must degrade the lead to\n'
        + 'rules-only, never block it.',
    },

    {
      n: 'Parse AI',
      t: 'code',
      code: `
const ctx = $('Score Lead').first().json;
const res = $input.first()?.json ?? {};

const fallback = (why) => [{ json: {
  ...ctx,
  ai_status: 'unavailable', ai_intent: '', ai_urgency: '', ai_signals: '',
  ai_objections: '', ai_reason: '', ai_confidence: 0, ai_note: why,
} }];

if (res.error || res.errorMessage) return fallback(String(res.errorMessage || res.error?.message || 'model call failed'));

let content = res.choices?.[0]?.message?.content;
if (typeof content !== 'string' || !content.trim()) return fallback('model returned no content');

// Models wrap JSON in fences even when told not to, and the fix is one line
// here rather than a retry that costs another call.
content = content.trim().replace(/^\\\`\\\`\\\`(?:json)?/i, '').replace(/\\\`\\\`\\\`$/, '').trim();

let parsed;
try { parsed = JSON.parse(content); }
catch (e) { return fallback('model output was not JSON: ' + content.slice(0, 120)); }

// Validate against the contract rather than trusting it. An out-of-vocabulary
// intent_level would silently break the conflict comparison, because an unknown
// band maps to undefined and every comparison against it is false - the lead
// would look like it agreed with the rules when nothing was actually checked.
const intent = String(parsed.intent_level || '').toLowerCase();
if (!['high', 'medium', 'low'].includes(intent)) return fallback('intent_level "' + intent + '" is not in the schema');

let conf = Number(parsed.confidence);
if (!Number.isFinite(conf)) conf = 0;
conf = Math.max(0, Math.min(1, conf));

const arr = (v, n) => (Array.isArray(v) ? v : []).slice(0, n).map(x => String(x).slice(0, 80));
const urgency = String(parsed.urgency || 'unknown').toLowerCase();

return [{ json: {
  ...ctx,
  ai_status: 'ok',
  ai_intent: intent,
  ai_urgency: ['immediate', 'this_quarter', 'exploring', 'unknown'].includes(urgency) ? urgency : 'unknown',
  ai_signals: arr(parsed.buying_signals, 3).join(' | '),
  ai_objections: arr(parsed.objections, 2).join(' | '),
  ai_reason: String(parsed.reason || '').slice(0, 200),
  ai_confidence: conf,
  ai_note: '',
  ai_tokens: Number(res.usage?.total_tokens || 0),
} }];
`,
      notes: 'EDGE CASE 4 in full: an empty response, prose instead of JSON, a fenced block, an\n'
        + 'out-of-vocabulary value and a non-numeric confidence all resolve to the same safe\n'
        + 'fallback with ai_status="unavailable" - and the reason is recorded, so "the AI is\n'
        + 'not working" is a diagnosable statement rather than a feeling.\n\n'
        + 'The AI NEVER contributes points, so the fallback changes the score by exactly\n'
        + 'zero. That is the payoff for keeping the two axes independent.',
    },

    {
      n: 'No AI',
      t: 'code',
      code: `
const ctx = $input.first().json;
return [{ json: {
  ...ctx,
  ai_status: 'skipped', ai_intent: '', ai_urgency: '', ai_signals: '',
  ai_objections: '', ai_reason: '', ai_confidence: 0,
  ai_note: ctx.ai_skip_reason,
} }];
`,
    },

    {
      n: 'Final Verdict',
      t: 'code',
      code: `
const d = $input.first().json;
const lead = d.lead;

let band = d.rule_band;
let outcome = 'auto';
let reason = '';

// Order matters. Each of these overrides the ones below it, and writing them as
// a single ordered ladder is what stops two rules quietly firing at once.

if (d.suppressed) {
  band = 'unqualified';
  outcome = 'suppressed';
  reason = 'consent denied, do not contact';
} else if (d.disqualified) {
  band = 'unqualified';
  outcome = 'disqualified';
  reason = d.disqualify_reason;
} else if (lead.validation_state === 'incomplete') {
  // Reachable, but missing something critical. Not scored into a band it cannot
  // support - it goes to the Data Completion stage and gets asked.
  band = 'data_completion';
  outcome = 'data_completion';
  reason = 'missing ' + (lead.validation_missing || 'a critical field');
} else if (C.materiallyConflicts(d.rule_band, { ai_status: d.ai_status, ai_intent: d.ai_intent, ai_confidence: d.ai_confidence })) {
  // EDGE CASE 5. The rules and the model disagree by two full bands and the
  // model is confident about it. Neither side wins automatically; a human looks.
  band = 'manual_review';
  outcome = 'ai_rule_conflict';
  reason = 'rules say ' + d.rule_band + ' (score ' + d.score + '), the model says ' +
    d.ai_intent + ' intent at confidence ' + d.ai_confidence + '. Band distance >= ' +
    C.CONFLICT.MIN_BAND_DISTANCE + ' at confidence >= ' + C.CONFLICT.MIN_CONFIDENCE + ' is reviewed, not resolved.';
}

// VIP needs a manager's yes before anything goes out. That is a routing state,
// not a score, so it is recorded next to the band rather than replacing it.
const needs_approval = band === 'vip';

return [{ json: {
  lead_uid: lead.lead_uid,
  lead,
  cfg: d.cfg,
  score: d.score,
  rule_band: d.rule_band,
  band,
  outcome,
  band_reason: reason,
  strategic: d.strategic,
  needs_approval,
  score_breakdown_json: d.score_breakdown_json,
  enrich: d.enrich,
  enrich_status: d.enrich_status,
  ai_status: d.ai_status,
  ai_intent: d.ai_intent,
  ai_urgency: d.ai_urgency,
  ai_signals: d.ai_signals,
  ai_objections: d.ai_objections,
  ai_reason: d.ai_reason,
  ai_confidence: d.ai_confidence,
  ai_note: d.ai_note || '',
  qualified_at: Math.floor(Date.now() / 1000),
} }];
`,
    },

    {
      n: 'Write Qualification Audit',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'insert',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_audit' },
        columns: {
          mappingMode: 'defineBelow',
          value: {
            event_id: '={{ $json.lead_uid + ":scored" }}',
            lead_uid: '={{ $json.lead_uid }}',
            ts: '={{ $json.qualified_at }}',
            workflow: 'LP-02 Qualify',
            execution_id: '={{ $execution.id }}',
            type: 'scored',
            decision: '={{ $json.band + " (" + $json.outcome + ")" }}',
            detail_json: '={{ JSON.stringify({ score: $json.score, rule_band: $json.rule_band, reason: $json.band_reason, breakdown: JSON.parse($json.score_breakdown_json), enrichment: $json.enrich_status, ai: { status: $json.ai_status, intent: $json.ai_intent, confidence: $json.ai_confidence, reason: $json.ai_reason, note: $json.ai_note } }) }}',
          },
          matchingColumns: [],
          schema: [],
        },
        options: {},
      },
      onError: 'continueRegularOutput',
      notes: 'The whole breakdown is written, not just the total. "Why did this lead get 62?"\n'
        + 'is answered by reading one row, which is the difference between a score a\n'
        + 'salesperson trusts and a score they route around.',
    },

    {
      n: 'Handoff to Route',
      t: 'executeWorkflow',
      p: {
        workflowId: '@LP-03 Route and Sync',
        mode: 'each',
        workflowInputs: {
          mappingMode: 'defineBelow',
          value: { verdict_json: '={{ JSON.stringify($json) }}' },
          matchingColumns: [],
          schema: [],
        },
        options: { waitForSubWorkflow: false },
      },
      notes: 'Not waited on. If LP-03 fails, exactly one dead letter is raised - by LP-03,\n'
        + 'naming LP-03. Waiting would propagate the failure back up and produce a second\n'
        + 'dead letter for the same incident, which is how an error inbox becomes noise.',
    },

    {
      n: 'note',
      t: 'sticky',
      at: [-980, -560],
      w: 780,
      h: 320,
      content: '## LP-02 Qualify\n\n'
        + '**Decides. Never acts.** No Odoo write, no message, no assignment - LP-03 owns every '
        + 'side effect. So this workflow is safe to re-run as many times as you like.\n\n'
        + '**Two independent axes.** The 0-100 score comes from structured fields only; the model '
        + 'reads the free text and contributes **zero points**. Delete the AI half and every lead '
        + 'still scores, bands and routes.\n\n'
        + '**The model is not shown the score** - otherwise "conflict detection" would just be '
        + 'measuring how well it anchors to a number it was handed.\n\n'
        + '**Conflict = band distance >= 2 AND confidence >= 0.7** -> a human looks (EC-5). Adjacent '
        + 'disagreement is logged and ignored, or the review queue becomes the default path.\n\n'
        + 'Enrichment down (EC-3) or model down (EC-4): the lead still completes, rules-only, with '
        + 'the reason recorded.',
    },
  ],

  flow: [
    ['Qualify Call', 'Read Config'],
    ['Read Config', 'Parse Lead'],
    ['Parse Lead', 'Enrich?'],
    ['Enrich?', 'Enrich Company', 0],
    ['Enrich?', 'No Enrichment', 1],
    ['Enrich Company', 'Parse Enrichment'],
    ['Parse Enrichment', 'Score Lead'],
    ['No Enrichment', 'Score Lead'],
    ['Score Lead', 'Need AI?'],
    ['Need AI?', 'AI Classify', 0],
    ['Need AI?', 'No AI', 1],
    ['AI Classify', 'Parse AI'],
    ['Parse AI', 'Final Verdict'],
    ['No AI', 'Final Verdict'],
    ['Final Verdict', 'Write Qualification Audit'],
    ['Final Verdict', 'Handoff to Route'],
  ],
};
