/**
 * LP-90 Odoo Gateway - every Odoo call in the system goes through here.
 *
 * Why a gateway instead of Odoo nodes scattered across the pipeline:
 *
 *   1. The n8n Odoo node speaks XML-RPC with no way to add a request header.
 *      This deployment's Odoo is multi-tenant, so it needs `X-Odoo-Database`
 *      to pick a database at all - without it every endpoint answers 404. That
 *      was measured, not assumed: see 05_Test_Evidence/odoo-api-probe.md.
 *   2. The node also cannot express an OR domain, call `message_post`, or call
 *      `read_group`. Duplicate detection needs the first, the CRM-side audit
 *      trail needs the second, and live workload needs the third.
 *   3. `/jsonrpc` answers HTTP 200 when the call FAILED and puts the failure in
 *      the body. n8n's retry logic never sees it. Exactly one node in this
 *      system knows that, and it is `Inspect Response` below.
 *
 * Contract in:  { model, method, args_json, kwargs_json, purpose, lead_uid }
 * Contract out: { ok, result, error, error_class, attempts, purpose, lead_uid }
 *
 * The gateway NEVER throws for a business-level failure. It returns ok:false
 * with a classification, so the caller decides between dead-lettering and
 * carrying on. It throws only when it is genuinely misconfigured.
 */
module.exports = {
  file: 'LP-90-odoo-gateway',
  name: 'LP-90 Odoo Gateway',
  purpose: 'Single egress point for Odoo. Auth, retry with bounded backoff, and the 200-on-error trap.',
  settings: { executionTimeout: 120 },

  nodes: [
    {
      n: 'Gateway Call',
      t: 'executeWorkflowTrigger',
      p: {
        inputSource: 'workflowInputs',
        workflowInputs: {
          values: [
            { name: 'model', type: 'string' },
            { name: 'method', type: 'string' },
            { name: 'args_json', type: 'string' },
            { name: 'kwargs_json', type: 'string' },
            { name: 'purpose', type: 'string' },
            { name: 'lead_uid', type: 'string' },
          ],
        },
      },
      notes: 'args_json and kwargs_json are STRINGS, not objects. n8n sub-workflow inputs\n'
        + 'flatten nested objects unpredictably, and an Odoo domain is a nested array\n'
        + '(e.g. [["|",["email_norm","=",..],["phone","=",..]]]). Passing it as text and\n'
        + 'parsing it here is the only shape that survives the boundary intact.',
    },

    {
      n: 'Read Odoo Config',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'get',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_config' },
        returnAll: true,
        filters: { conditions: [] },
      },
      alwaysOutputData: true,
      notes: 'Tables are addressed BY NAME, never by id. Ids are minted per instance, so a\n'
        + 'name reference is the difference between this importing cleanly on a\n'
        + 'reviewer\'s n8n and importing as a red node.',
    },

    {
      n: 'Build RPC Call',
      t: 'code',
      code: `
// from _shared/constants.js (inlined above by scripts/build-workflows.js)
const cfgRows = $input.all().map(i => i.json).filter(r => r && r.key);
const cfg = Object.fromEntries(cfgRows.map(r => [r.key, r.value]));

const missing = ['odoo_url', 'odoo_db', 'odoo_user', 'odoo_password']
  .filter(k => !cfg[k]);
if (missing.length) {
  // Misconfiguration, not a business failure: throw loudly so it surfaces at
  // install time with a sentence naming the fix, rather than as a confusing
  // 404 from Odoo three nodes later.
  throw new Error(
    'LP-90: Odoo is not configured (' + missing.join(', ') + ' missing from the ' +
    'lp_config data table). Run "LP-00 Setup and Seed" once, then retry.'
  );
}

const inp = $('Gateway Call').first().json;
const parse = (raw, fallback) => {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); }
  catch (e) { throw new Error('LP-90: could not parse ' + JSON.stringify(raw).slice(0, 120) + ' as JSON'); }
};

const model = String(inp.model || '').trim();
const method = String(inp.method || '').trim();
if (!model || !method) throw new Error('LP-90: model and method are required');

// Odoo hides soft-deleted (lost) records from every search unless you ask for
// them. Lost is active=false, so a duplicate check that omits this silently
// re-creates a lead the team already rejected.
const kwargs = parse(inp.kwargs_json, {});
if (method === 'search_read' || method === 'search' || method === 'search_count') {
  if (kwargs.context === undefined) kwargs.context = {};
  if (kwargs.context.active_test === undefined) kwargs.context.active_test = false;
}

return [{
  json: {
    odoo_url: String(cfg.odoo_url).replace(/\\/+$/, ''),
    odoo_db: cfg.odoo_db,
    odoo_user: cfg.odoo_user,
    odoo_password: cfg.odoo_password,
    model,
    method,
    args: parse(inp.args_json, []),
    kwargs,
    purpose: inp.purpose || '',
    lead_uid: inp.lead_uid || '',
    attempt: 1,
    max_tries: C.RETRY.MAX_TRIES,
  },
}];
`,
    },

    {
      n: 'Authenticate',
      t: 'http',
      p: {
        method: 'POST',
        url: '={{ $json.odoo_url }}/jsonrpc',
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'X-Odoo-Database', value: '={{ $json.odoo_db }}' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service: "common", method: "authenticate", args: [$json.odoo_db, $json.odoo_user, $json.odoo_password, {}] }, id: 1 }) }}',
        options: { timeout: 20000, response: { response: { neverError: true, fullResponse: true } } },
      },
      retry: { tries: 2, waitMs: 1500 },
      notes: 'neverError + fullResponse, deliberately. This endpoint returns HTTP 200 for a\n'
        + 'failed login, so the status code carries no information and the body has to\n'
        + 'be read either way. Letting n8n decide success from the status would mark a\n'
        + 'rejected login as a good response.\n\n'
        + 'The gateway authenticates on every invocation. That is one extra round trip,\n'
        + 'and it buys statelessness: there is no cached uid to go stale, and no\n'
        + 'session-expiry branch to write, test and explain.',
    },

    {
      n: 'Check Auth',
      t: 'code',
      code: `
const res = $input.first().json;
const body = res.body ?? res;
const cfg = $('Build RPC Call').first().json;

if (body && body.error) {
  const msg = body.error.data?.message || body.error.message || 'unknown Odoo auth error';
  throw new Error('LP-90: Odoo authentication failed: ' + msg);
}
const uid = body?.result;
// Odoo answers \`false\` for bad credentials, and \`false\` is a 200. A truthiness
// check that accepted 0 or false here would send every later call as uid=false
// and produce "access denied" errors that look like a permissions problem.
if (typeof uid !== 'number' || uid <= 0) {
  throw new Error('LP-90: Odoo rejected the credentials (uid=' + JSON.stringify(uid) + '). Check lp_config.');
}
return [{ json: { ...cfg, uid } }];
`,
    },

    {
      n: 'Odoo Call',
      t: 'http',
      p: {
        method: 'POST',
        url: '={{ $json.odoo_url }}/jsonrpc',
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'X-Odoo-Database', value: '={{ $json.odoo_db }}' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service: "object", method: "execute_kw", args: [$json.odoo_db, $json.uid, $json.odoo_password, $json.model, $json.method, $json.args, $json.kwargs] }, id: 2 }) }}',
        options: { timeout: 25000, response: { response: { neverError: true, fullResponse: true } } },
      },
      notes: 'No retryOnFail here on purpose. n8n\'s built-in retry has a fixed delay, no\n'
        + 'jitter, and no way to distinguish 429 from 400 - and it cannot see a failure\n'
        + 'that arrived as HTTP 200 anyway. Retry is done explicitly by the loop below,\n'
        + 'which classifies first and backs off with jitter.',
    },

    {
      n: 'Inspect Response',
      t: 'code',
      code: `
// The single most important node in the integration.
//
// /jsonrpc answers HTTP 200 for a failed call and puts the failure in the body.
// Proven on this exact deployment: writing an unknown field returned
// 200 {"error":{"data":{"message":"Invalid field 'ref' in 'crm.lead'"}}}.
// Treating HTTP 200 as success would have recorded that write as done.
const res = $input.first().json;
const ctx = $('Check Auth').first().json;
const status = Number(res.statusCode ?? 200);
const body = res.body ?? res;

function classify(httpStatus, odooErr) {
  if (C.RETRY.RETRYABLE_STATUS.includes(httpStatus)) return 'transient';
  if (httpStatus >= 400) return 'permanent';
  if (!odooErr) return 'ok';
  const name = String(odooErr.data?.name || '');
  const msg = String(odooErr.data?.message || odooErr.message || '');
  // A serialisation failure is Odoo telling us two transactions collided. It
  // is the one Odoo-level error that is worth retrying verbatim.
  if (/SerializationFailure|concurrent update|could not serialize/i.test(name + msg)) return 'transient';
  if (/AccessDenied|AccessError|session expired/i.test(name + msg)) return 'auth';
  return 'permanent';
}

const odooErr = body && body.error ? body.error : null;
const klass = classify(status, odooErr);

if (klass === 'ok') {
  return [{ json: {
    ok: true, result: body.result, error: '', error_class: '',
    attempts: ctx.attempt, purpose: ctx.purpose, lead_uid: ctx.lead_uid, done: true,
  } }];
}

const message = odooErr
  ? (odooErr.data?.message || odooErr.message || 'Odoo error')
  : ('HTTP ' + status + ' ' + JSON.stringify(body).slice(0, 300));

const canRetry = klass === 'transient' && ctx.attempt < ctx.max_tries;

// Honour Retry-After when the server sends one; seconds form only, because the
// HTTP-date form is not used by anything in this stack and parsing it would be
// untested code.
const retryAfter = Number(res.headers?.['retry-after'] ?? 0);
const waitMs = retryAfter > 0
  ? Math.min(C.RETRY.CAP_MS, retryAfter * 1000)
  : C.backoffMs(ctx.attempt);

return [{ json: {
  ...ctx,
  ok: false,
  result: null,
  error: message,
  error_class: klass,
  http_status: status,
  attempts: ctx.attempt,
  attempt: ctx.attempt + 1,
  wait_ms: waitMs,
  done: !canRetry,
} }];
`,
    },

    {
      n: 'Retry?',
      t: 'if',
      p: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          combinator: 'and',
          conditions: [
            {
              id: 'retry-check',
              leftValue: '={{ $json.done }}',
              rightValue: false,
              operator: { type: 'boolean', operation: 'false', singleValue: true },
            },
          ],
        },
        options: {},
      },
      notes: 'True branch = another attempt is allowed. The loop is bounded twice over: by\n'
        + 'C.RETRY.MAX_TRIES in Inspect Response, and by this node only ever seeing an\n'
        + 'incremented attempt counter. There is no path that loops forever.',
    },

    {
      n: 'Backoff',
      t: 'wait',
      p: { resume: 'timeInterval', amount: '={{ $json.wait_ms / 1000 }}', unit: 'seconds' },
      notes: 'Capped at 8 seconds, not 60. The gateway runs as a sub-workflow the caller\n'
        + 'waits on, so a long sleep here holds the parent open and can blow a webhook\n'
        + 'response window. Three tries at 0.5s, 1s, 2s costs under 4 seconds total.',
    },

    {
      n: 'Return',
      t: 'code',
      code: `
const r = $input.first().json;
return [{ json: {
  ok: !!r.ok,
  result: r.ok ? r.result : null,
  error: r.error || '',
  error_class: r.error_class || '',
  http_status: r.http_status ?? 200,
  attempts: r.attempts ?? 1,
  model: r.model || '',
  method: r.method || '',
  purpose: r.purpose || '',
  lead_uid: r.lead_uid || '',
} }];
`,
      notes: 'Returns ok:false rather than throwing. A gateway that throws forces every one\n'
        + 'of its eleven callers to wrap it in error handling; a gateway that returns a\n'
        + 'verdict lets each caller decide whether this particular failure is fatal.',
    },

    {
      n: 'note',
      t: 'sticky',
      at: [-900, -520],
      w: 700,
      h: 280,
      content: '## LP-90 Odoo Gateway\n\n'
        + 'Every Odoo read and write in the system passes through this workflow.\n\n'
        + '**The trap it exists for:** `/jsonrpc` returns **HTTP 200 when the call failed** and puts '
        + 'the error in the body. `Inspect Response` is the only node that knows this. Without it, a '
        + 'rejected write is recorded as a successful one.\n\n'
        + '**Config** lives in the `lp_config` data table, written by `LP-00 Setup and Seed`. '
        + 'Re-running setup re-points the whole system at a new Odoo with no node edits.\n\n'
        + '**Retry** is explicit, not `retryOnFail`: classify first (429/5xx transient, 4xx permanent), '
        + 'then back off with jitter, capped at 8s, max 3 tries.',
    },
  ],

  flow: [
    ['Gateway Call', 'Read Odoo Config'],
    ['Read Odoo Config', 'Build RPC Call'],
    ['Build RPC Call', 'Authenticate'],
    ['Authenticate', 'Check Auth'],
    ['Check Auth', 'Odoo Call'],
    ['Odoo Call', 'Inspect Response'],
    ['Inspect Response', 'Retry?'],
    ['Retry?', 'Backoff', 0],
    ['Retry?', 'Return', 1],
    ['Backoff', 'Odoo Call'],
  ],
};
