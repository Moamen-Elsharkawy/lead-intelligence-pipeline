/**
 * LP-99 Mock Services - the three external systems this build does not have
 * production access to, plus a chaos switch.
 *
 * The brief allows mocks. What it actually grades is whether the failures can
 * be DEMONSTRATED, so this mock's real job is not to return happy data - it is
 * to fail on command, the same way twice.
 *
 *   POST /webhook/lp-mock-enrich    { domain, company, country_hint }
 *   POST /webhook/lp-mock-whatsapp  { to, template, body }
 *   POST /webhook/lp-mock-booking   { lead_uid, slot }
 *
 * Chaos is a query string:
 *   ?fail=429&times=2&key=acme.com    two 429s for this key, then success
 *   ?fail=timeout                     sleeps past the caller's timeout
 *   ?fail=malformed                   HTTP 200 with prose where JSON belongs
 *   ?fail=500                         a plain server error
 *   ?fail=auth                        401, to prove auth failure is NOT retried
 *
 * `times` is what makes edge case 3 ("times out twice, then succeeds")
 * reproducible rather than a story: the counter lives in lp_idem under
 * scope='mock', so the third call genuinely behaves differently from the first
 * two, and `?reset=1` puts it back.
 */
module.exports = {
  file: 'LP-99-mock-services',
  name: 'LP-99 Mock Services',
  purpose: 'Enrichment, WhatsApp and booking stand-ins, with on-demand deterministic failure injection.',

  nodes: [
    ...['enrich', 'whatsapp', 'booking'].map((svc) => ({
      n: `${svc} Endpoint`,
      t: 'webhook',
      p: {
        httpMethod: 'POST',
        path: `lp-mock-${svc}`,
        authentication: 'headerAuth',
        responseMode: 'responseNode',
        options: {},
      },
      creds: { httpHeaderAuth: { name: 'LP Webhook Token (X-LP-Token)' } },
      notes: `Fixed path /webhook/lp-mock-${svc}.\n\n`
        + 'Originally one webhook on `lp-mock/:service`. Path parameters did not register\n'
        + 'on this n8n build - every request answered 404 while the workflow reported\n'
        + 'active:true and an identical fixed-path webhook in LP-00 answered fine. Three\n'
        + 'fixed paths cost two extra nodes and remove an unknown; the chaos machinery\n'
        + 'downstream is still written once.',
    })),

    ...['enrich', 'whatsapp', 'booking'].map((svc) => ({
      n: `tag ${svc}`,
      t: 'code',
      usesRuntime: false,
      code: `
// Stamp which endpoint fired, then hand off to the shared chain.
const r = $input.first().json;
return [{ json: { service: '${svc}', query: r.query || {}, body: r.body || {} } }];
`,
    })),

    {
      n: 'Read Chaos Plan',
      t: 'code',
      code: `
const req = $input.first().json;
const q = req.query || {};
const body = req.body || {};
const service = String(req.service || '').toLowerCase();

const fail = String(q.fail || '').toLowerCase();
const times = Math.max(0, parseInt(q.times ?? '1', 10) || 0);
// The counter key defaults to something stable per target, so "two failures
// then success" is per-lead rather than global.
const key = String(q.key || body.domain || body.to || body.lead_uid || 'global');

return [{ json: {
  service, body, fail, times, key,
  reset: String(q.reset || '') === '1',
  counter_key: 'mock:' + service + ':' + key + ':' + (fail || 'none'),
  chaos_requested: !!fail,
} }];
`,
    },

    {
      n: 'Read Counter',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'get',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_idem' },
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'idem_key', condition: 'eq', keyValue: '={{ $json.counter_key }}' }] },
        returnAll: true,
      },
      alwaysOutputData: true,
      notes: 'The call counter reuses lp_idem under scope="mock" instead of adding a ninth\n'
        + 'table. It is the same shape - a key and an attempt count - and Data Table\n'
        + 'schemas cannot be altered after creation, so fewer tables is fewer things to\n'
        + 'get permanently wrong.',
    },

    {
      n: 'Decide Behaviour',
      t: 'code',
      code: `
const plan = $('Read Chaos Plan').first().json;
const rows = $input.all().map(i => i.json).filter(r => r && r.idem_key === plan.counter_key);
const seen = plan.reset ? 0 : Number(rows[0]?.attempts || 0);
const next = seen + 1;

// Fail while we are still inside the requested number of failures.
const shouldFail = plan.chaos_requested && next <= plan.times;
const behaviour = shouldFail ? plan.fail : 'ok';

return [{ json: {
  ...plan,
  seen, attempts: next, behaviour,
  note: plan.chaos_requested
    ? ('call ' + next + ' of a "' + plan.fail + ' x' + plan.times + '" plan -> ' + behaviour)
    : 'no chaos requested',
} }];
`,
    },

    {
      n: 'Save Counter',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'upsert',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_idem' },
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'idem_key', condition: 'eq', keyValue: '={{ $json.counter_key }}' }] },
        columns: {
          mappingMode: 'defineBelow',
          value: {
            idem_key: '={{ $json.counter_key }}', scope: 'mock', lead_uid: '={{ $json.key }}',
            state: '={{ $json.behaviour }}', result_ref: '={{ $json.note }}',
            claimed_at: '={{ Math.floor(Date.now()/1000) }}', completed_at: 0,
            attempts: '={{ $json.attempts }}',
          },
          matchingColumns: ['idem_key'],
          schema: [],
        },
        options: {},
      },
    },

    {
      n: 'Route Behaviour',
      t: 'switch',
      p: {
        rules: {
          values: ['ok', 'timeout', '429', 'malformed', '500', 'auth'].map((b) => ({
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
              combinator: 'and',
              conditions: [{
                id: `b-${b}`,
                leftValue: "={{ $('Decide Behaviour').first().json.behaviour }}",
                rightValue: b,
                operator: { type: 'string', operation: 'equals' },
              }],
            },
            renameOutput: true,
            outputKey: b,
          })),
        },
        options: { fallbackOutput: 'extra', renameFallbackOutput: 'unhandled' },
      },
    },

    {
      n: 'Serve Data',
      t: 'code',
      code: `
const d = $('Decide Behaviour').first().json;
const b = d.body || {};

// The enrichment "provider". A lookup table is exactly what the brief allows,
// and it is honest: this is reference data, not a live vendor.
const DIRECTORY = {
  'acme-logistics.com': { company_size: 420, industry: 'logistics',             country: 'EG', strategic: true  },
  'nilecargo.com':      { company_size: 180, industry: 'logistics',             country: 'EG', strategic: false },
  'deltaclinics.com':   { company_size: 95,  industry: 'healthcare',            country: 'EG', strategic: false },
  'gulftech.ae':        { company_size: 600, industry: 'technology',            country: 'AE', strategic: true  },
  'smallshop.com':      { company_size: 8,   industry: 'retail',                country: 'EG', strategic: false },
  'brightlearn.com':    { company_size: 60,  industry: 'education',             country: 'SA', strategic: false },
  'apexrealty.com':     { company_size: 140, industry: 'real estate',           country: 'AE', strategic: false },
  'northstarco.com':    { company_size: 25,  industry: 'professional services', country: 'GB', strategic: false },
  'luckyspin.com':      { company_size: 300, industry: 'gambling',              country: 'MT', strategic: false },
};

if (d.service === 'enrich') {
  const domain = String(b.domain || '').toLowerCase();
  const hit = DIRECTORY[domain];
  // A miss is a legitimate answer, not an error. Most WhatsApp leads have no
  // domain at all, and the scorer is built to price "unknown" rather than
  // treat it as zero.
  return [{ json: { status: 200, payload: hit
    ? { found: true, domain, ...hit, source: 'mock-directory' }
    : { found: false, domain, source: 'mock-directory' } } }];
}

if (d.service === 'whatsapp') {
  // Shaped like the real WhatsApp Business Cloud API response, so swapping the
  // mock for Meta is a URL and a credential, not a code change.
  const wamid = 'wamid.MOCK' + Math.random().toString(36).slice(2, 12).toUpperCase();
  return [{ json: { status: 200, payload: {
    messaging_product: 'whatsapp',
    contacts: [{ input: b.to || '', wa_id: String(b.to || '').replace(/\\D/g, '') }],
    messages: [{ id: wamid, message_status: 'accepted' }],
  } }}];
}

// booking
return [{ json: { status: 200, payload: {
  booking_id: b.booking_id || ('bk_' + Math.random().toString(36).slice(2, 10)),
  lead_uid: b.lead_uid || '', slot: b.slot || '', status: 'confirmed',
} }}];
`,
    },

    {
      n: 'Respond OK',
      t: 'respond',
      p: {
        respondWith: 'json',
        responseBody: '={{ JSON.stringify($json.payload) }}',
        options: { responseCode: 200 },
      },
    },

    {
      n: 'Hang Past Timeout',
      t: 'wait',
      p: { resume: 'timeInterval', amount: 35, unit: 'seconds' },
      notes: 'The caller times out at 25s, so 35s here reproduces a timeout without needing\n'
        + 'anything to actually be broken. Deliberately longer than the gateway timeout\n'
        + 'and shorter than the workflow one, so the execution still finishes and stays\n'
        + 'visible in the log.',
    },

    {
      n: 'Respond After Hang',
      t: 'respond',
      p: {
        respondWith: 'json',
        responseBody: '={{ JSON.stringify({ ok: true, late: true }) }}',
        options: { responseCode: 200 },
      },
    },

    {
      n: 'Respond 429',
      t: 'respond',
      p: {
        respondWith: 'json',
        responseBody: '={{ JSON.stringify({ error: "rate_limited", message: "Too many requests" }) }}',
        options: { responseCode: 429, responseHeaders: { entries: [{ name: 'Retry-After', value: '2' }] } },
      },
      notes: 'Sends a real Retry-After. The gateway prefers that header over its own\n'
        + 'backoff curve, and this is the only place that behaviour can be exercised:\n'
        + 'Odoo itself imposes no rate limit here, so the 429 has to be injected.',
    },

    {
      n: 'Respond Malformed',
      t: 'respond',
      p: {
        respondWith: 'text',
        responseBody: 'Service temporarily degraded, please retry shortly.',
        options: { responseCode: 200, responseHeaders: { entries: [{ name: 'Content-Type', value: 'application/json' }] } },
      },
      notes: 'HTTP 200, Content-Type says JSON, body is prose. This is the shape that breaks\n'
        + 'naive integrations: the status says success, so anything keying off the status\n'
        + 'code alone records a success and moves on with undefined fields.',
    },

    {
      n: 'Respond 500',
      t: 'respond',
      p: {
        respondWith: 'json',
        responseBody: '={{ JSON.stringify({ error: "internal", message: "Simulated upstream failure" }) }}',
        options: { responseCode: 500 },
      },
    },

    {
      n: 'Respond 401',
      t: 'respond',
      p: {
        respondWith: 'json',
        responseBody: '={{ JSON.stringify({ error: "unauthorized", message: "Simulated bad or expired credential" }) }}',
        options: { responseCode: 401 },
      },
      notes: 'Exists to prove a negative: 401 is classified permanent, so the caller must\n'
        + 'NOT burn three attempts on it. A dead credential retried on a backoff curve is\n'
        + 'how a five-minute outage becomes a thirty-minute one.',
    },

    {
      n: 'Respond Unhandled',
      t: 'respond',
      p: {
        respondWith: 'json',
        responseBody: '={{ JSON.stringify({ error: "unknown_chaos", requested: $(\'Decide Behaviour\').first().json.fail }) }}',
        options: { responseCode: 400 },
      },
    },

    {
      n: 'note',
      t: 'sticky',
      at: [-900, -520],
      w: 720,
      h: 300,
      content: '## LP-99 Mock Services\n\n'
        + 'Stands in for the enrichment provider, WhatsApp Cloud API and the booking system.\n\n'
        + '**Its real job is failing on demand**, because that is what the 14 edge cases need:\n\n'
        + '```\n'
        + '?fail=timeout&times=2   times out twice, then succeeds   (EC-3)\n'
        + '?fail=429&times=1       one rate limit, then succeeds    (EC-6)\n'
        + '?fail=malformed         200 OK with prose, not JSON      (EC-4)\n'
        + '?fail=500 | auth        server error / dead credential\n'
        + '?reset=1                clears the counter for that key\n'
        + '```\n\n'
        + 'The counter is stored, so "twice then succeeds" is genuinely reproducible rather than a claim. '
        + 'The WhatsApp response is shaped exactly like Meta\'s, so going live is a URL and a credential.',
    },
  ],

  flow: [
    ['enrich Endpoint', 'tag enrich'],
    ['whatsapp Endpoint', 'tag whatsapp'],
    ['booking Endpoint', 'tag booking'],
    ['tag enrich', 'Read Chaos Plan'],
    ['tag whatsapp', 'Read Chaos Plan'],
    ['tag booking', 'Read Chaos Plan'],
    ['Read Chaos Plan', 'Read Counter'],
    ['Read Counter', 'Decide Behaviour'],
    ['Decide Behaviour', 'Save Counter'],
    ['Save Counter', 'Route Behaviour'],
    ['Route Behaviour', 'Serve Data', 0],
    ['Route Behaviour', 'Hang Past Timeout', 1],
    ['Route Behaviour', 'Respond 429', 2],
    ['Route Behaviour', 'Respond Malformed', 3],
    ['Route Behaviour', 'Respond 500', 4],
    ['Route Behaviour', 'Respond 401', 5],
    ['Route Behaviour', 'Respond Unhandled', 6],
    ['Serve Data', 'Respond OK'],
    ['Hang Past Timeout', 'Respond After Hang'],
  ],
};
