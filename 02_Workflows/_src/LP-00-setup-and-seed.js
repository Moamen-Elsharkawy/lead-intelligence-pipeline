/**
 * LP-00 Setup and Seed - run this once, and the system is ready.
 *
 * Provisions an Odoo, records the connection, creates the CRM objects the
 * pipeline depends on (an external-reference field and five extra funnel
 * stages), and seeds the sales team. Re-running it is safe: every step checks
 * before it creates, and the two upserts key on a natural id.
 *
 * WHY IT EXISTS. The alternative is a README section saying "create eight data
 * tables with these exact columns, then five stages, then a custom field" -
 * thirty minutes of error-prone work on a reviewer's machine where the first
 * typo surfaces as a failure three workflows away.
 */
module.exports = {
  file: 'LP-00-setup-and-seed',
  name: 'LP-00 Setup and Seed',
  purpose: 'One-click provisioning: Odoo connection, external-ref field, funnel stages, seed agents.',

  nodes: [
    { n: 'Run Setup', t: 'manual' },

    {
      n: 'Setup Webhook',
      t: 'webhook',
      p: {
        httpMethod: 'POST',
        path: 'lp-setup',
        authentication: 'headerAuth',
        responseMode: 'lastNode',
        options: {},
      },
      creds: { httpHeaderAuth: { name: 'LP Webhook Token (X-LP-Token)' } },
      notes: 'A second way in, so the test harness can rebuild the environment from scratch\n'
        + 'before a run and the reviewer does not have to click anything. Header auth, not\n'
        + 'a query-string token: a token in a URL leaks into access logs, browser history\n'
        + 'and Referer headers. Same credential guards every webhook in the system.',
    },

    {
      n: 'Config',
      t: 'code',
      code: `
// ===== THE ONLY NODE AN OPERATOR EDITS =====
// A Code node and not $env, because this instance runs with
// N8N_BLOCK_ENV_ACCESS_IN_NODE=true and every $env read throws.
const CONFIG = {
  // 'demo'   provision a throwaway database from Odoo's own public sandbox.
  //          Zero setup, zero cost, real Odoo. Sandboxes expire after a few
  //          hours; re-run this workflow for a fresh one.
  // 'keep'   reuse whatever connection is already in lp_config, and just
  //          re-check the field, the stages and the roster. This is the mode
  //          that makes "re-running setup is safe" a thing you can watch:
  //          the summary should say "already present" and "none needed".
  // 'manual' point at your own Odoo. Fill the odoo_* fields below.
  mode: 'demo',

  odoo_url: '',
  odoo_db: '',
  odoo_user: '',
  odoo_password: '',

  // This instance's own public URL. Leave it empty when setup is run over the
  // webhook and it is taken from the request - the host that just called you is
  // the host you are. Fill it in only for the manual trigger, which has no
  // request to read. Empty by default because a real hostname committed to a
  // public repo is both a leak and a footgun: anyone cloning this and forgetting
  // to set it would be firing at someone else's n8n.
  base_url: '',

  // Where VIP approval requests, unassignable-lead alerts and SLA escalations
  // go. Deliberately a placeholder in the committed file: this repository is
  // public, and a real address baked in here means a stranger running setup
  // quietly starts mailing someone who never agreed to receive it. Set it
  // below, or pass it in the webhook body.
  manager_email: 'PUT_YOUR_MANAGER_EMAIL_HERE',

  fallback_owner_id: 'mgr-01',
};

// Seed sales team. Capacity and availability drive workload-aware assignment
// in LP-02; flipping \`available\` is how edge case 9 is demonstrated.
const AGENTS = [
  { agent_id: 'sales-01', name: 'Dina Hassan',   email: 'sales01@example.com', services: 'automation,ai_agent,rag',   capacity: 8,  open_leads: 0, available: true, odoo_user_id: 2 },
  { agent_id: 'sales-02', name: 'Youssef Amin',  email: 'sales02@example.com', services: 'integration,custom_app',    capacity: 8,  open_leads: 0, available: true, odoo_user_id: 2 },
  { agent_id: 'sales-03', name: 'Mariam Nabil',  email: 'sales03@example.com', services: 'consulting,audit,training', capacity: 6,  open_leads: 0, available: true, odoo_user_id: 2 },
  { agent_id: 'mgr-01',   name: 'Sales Manager', email: CONFIG.manager_email,
    services: 'automation,ai_agent,rag,integration,custom_app,consulting,audit,training',
    capacity: 50, open_leads: 0, available: true, odoo_user_id: 2 },
];

// The webhook body may override the mode, so the test harness can run
// {"mode":"keep"} to re-verify an existing environment without provisioning a
// new sandbox. The manual trigger emits {} and simply leaves CONFIG.mode alone.
// manager_email may be overridden the same way, which is how the committed
// file stays free of anyone's real address.
const inbound = $input.first()?.json || {};
const requested = String(inbound.body?.mode || '').trim();
const mode = requested || CONFIG.mode;

const managerEmail = String(inbound.body?.manager_email || CONFIG.manager_email || '').trim();
if (!/^[^\\s@]+@[^\\s@.]+\\.[^\\s@]{2,}$/.test(managerEmail) || /^PUT_/.test(managerEmail)) {
  throw new Error('Setup: manager_email is "' + managerEmail + '". ' +
    'Set it in the Config node, or POST {"manager_email":"you@example.com"} to /webhook/lp-setup. ' +
    'It receives VIP approvals, unassignable-lead alerts and SLA escalations, so setup will not ' +
    'run without a real address to send them to.');
}
CONFIG.manager_email = managerEmail;
AGENTS[AGENTS.length - 1].email = managerEmail;

// The instance's own URL, in order of preference: the request body, the Config
// node, then the request itself. Every workflow reads this from lp_config to
// reach the mock services, so it has to be right and it has to be absolute.
const hdr = inbound.headers || {};
const fromRequest = hdr.host
  ? (String(hdr['x-forwarded-proto'] || 'https').split(',')[0].trim() + '://' + String(hdr['x-forwarded-host'] || hdr.host).split(',')[0].trim())
  : '';
const baseUrl = String(inbound.body?.base_url || CONFIG.base_url || fromRequest || '').replace(/\\/+$/, '');
if (!/^https?:\\/\\//.test(baseUrl)) {
  throw new Error('Setup: base_url is "' + baseUrl + '". Running from the manual trigger there is no ' +
    'request to read it from, so set base_url in the Config node to this instance\\'s public URL ' +
    '(for example https://n8n.example.com), or run setup over POST /webhook/lp-setup instead, ' +
    'which reads it from the request.');
}
CONFIG.base_url = baseUrl;

if (mode === 'manual') {
  const missing = ['odoo_url', 'odoo_db', 'odoo_user', 'odoo_password'].filter(k => !CONFIG[k]);
  if (missing.length) {
    throw new Error('Setup: mode is "manual" but ' + missing.join(', ') +
      ' are empty. Fill them in the Config node, or switch mode back to "demo".');
  }
}

return [{ json: { ...CONFIG, mode, agents: AGENTS } }];
`,
      notes: 'The one node an operator edits. Defaults to Odoo\'s public sandbox so the whole\n'
        + 'submission runs with no account, no card and no infrastructure.',
    },

    {
      n: 'Which Mode?',
      t: 'switch',
      p: {
        rules: {
          values: ['demo', 'keep', 'manual'].map((m) => ({
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
              combinator: 'and',
              conditions: [{
                id: `mode-${m}`,
                leftValue: '={{ $json.mode }}',
                rightValue: m,
                operator: { type: 'string', operation: 'equals' },
              }],
            },
            renameOutput: true,
            outputKey: m,
          })),
        },
        options: { fallbackOutput: 'extra', renameFallbackOutput: 'unknown' },
      },
      notes: 'Three ways to obtain an Odoo connection, one shared tail. Exactly one branch\n'
        + 'ever carries items, which is why they converge on Config Rows with no Merge.',
    },

    {
      n: 'Reject Unknown Mode',
      t: 'stopAndError',
      p: {
        errorType: 'errorMessage',
        errorMessage: '={{ "Setup: mode \\"" + ($json.mode ?? "") + "\\" is not one of demo, keep, manual. Fix the Config node." }}',
      },
      notes: 'A typo in the mode string would otherwise fall through every branch and finish\n'
        + 'with a green tick having done nothing at all.\n\n'
        + 'Stop and Error rather than a Code node that only throws. Both fail the run, but a\n'
        + 'Code node whose body never returns anything is indistinguishable from one that\n'
        + 'forgot to - the validator flags it as "must return data", correctly, and a real\n'
        + 'missing return elsewhere would then be lost in the noise.',
    },

    {
      n: 'Read Existing Config',
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
      n: 'Use Existing Odoo',
      t: 'code',
      code: `
const rows = $input.all().map(i => i.json).filter(r => r && r.key);
const have = Object.fromEntries(rows.map(r => [r.key, r.value]));
const missing = ['odoo_url', 'odoo_db', 'odoo_user', 'odoo_password'].filter(k => !have[k]);
if (missing.length) {
  throw new Error('Setup: mode is "keep" but lp_config has no ' + missing.join(', ') +
    '. Run once in mode "demo" or "manual" first.');
}
const cfg = $('Config').first().json;
return [{ json: {
  ...cfg,
  odoo_url: have.odoo_url, odoo_db: have.odoo_db,
  odoo_user: have.odoo_user, odoo_password: have.odoo_password,
  provisioned: have.provisioned || 'reused from lp_config',
} }];
`,
    },

    {
      n: 'Provision Demo Odoo',
      t: 'http',
      p: {
        method: 'POST',
        url: 'https://demo.odoo.com/start',
        sendBody: true,
        contentType: 'raw',
        rawContentType: 'text/xml',
        body: '<?xml version="1.0"?><methodCall><methodName>start</methodName><params></params></methodCall>',
        // Autodetect, deliberately, with NO responseFormat override.
        //
        // Measured on this instance against this endpoint (probe workflow, four
        // variants, one run): responseFormat "text" returns a serialised Node
        // stream - the Code node receives '{"_writeState":...,"_readableState":
        // {"highWaterMark":65536...' as a string and every XML capture fails.
        // Adding outputPropertyName or fullResponse does not change it.
        // Autodetect returns the real "<?xml version='1.0'?><methodResponse>..."
        // body. So the working configuration is the one that specifies least.
        options: { timeout: 60000 },
      },
      retry: { tries: 2, waitMs: 3000 },
      notes: 'demo.odoo.com/start is Odoo\'s own documented sandbox provisioner. It speaks\n'
        + 'XML-RPC and answers with a four-member struct: host, database, user, password.\n'
        + 'Taken as raw text and parsed next door rather than through the XML node,\n'
        + 'because the shape is fixed and four captures read more clearly than a tree walk.',
    },

    {
      n: 'Parse Provisioned DB',
      t: 'code',
      code: `
const res = $input.first().json;

// Be explicit about the shape rather than trusting one key. n8n hands the body
// back under different names depending on responseFormat, and when the options
// disagree it hands back a serialised stream object that stringifies to
// '{"_readableState":...}' - which looks like a parse failure but is really a
// node-configuration failure. Say which one it is.
const candidate = res.data ?? res.body ?? res;
const xml = typeof candidate === 'string' ? candidate : '';
if (!xml) {
  throw new Error(
    'Setup: the sandbox response did not arrive as text. The HTTP node returned ' +
    (candidate && candidate._readableState ? 'an unconsumed stream' : typeof candidate) +
    ' with keys [' + Object.keys(candidate || {}).slice(0, 8).join(', ') + ']. ' +
    'Check the Provision Demo Odoo node: it needs responseFormat "text" and no fullResponse.'
  );
}
if (/<fault>/i.test(xml)) {
  throw new Error('Setup: the sandbox refused to provision a database. Retry in a minute, or switch the Config node to mode "manual".');
}

// <member><name>host</name><value><string>https://demo4.odoo.com</string></value></member>
const pick = (k) => {
  const m = xml.match(new RegExp('<name>' + k + '<\\\\/name>\\\\s*<value>\\\\s*(?:<string>)?([^<]*)', 'i'));
  return m ? m[1].trim() : '';
};
const out = {
  odoo_url: pick('host'), odoo_db: pick('database'),
  odoo_user: pick('user'), odoo_password: pick('password'),
};
const missing = Object.entries(out).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  throw new Error('Setup: could not read ' + missing.join(', ') +
    ' from the sandbox response. First 300 chars: ' + xml.slice(0, 300));
}
return [{ json: { ...$('Config').first().json, ...out, provisioned: 'demo sandbox' } }];
`,
    },

    {
      n: 'Use Manual Odoo',
      t: 'code',
      code: `
return [{ json: { ...$('Config').first().json, provisioned: 'operator supplied' } }];
`,
      notes: 'Both branches converge on Config Rows. Exactly one ever carries items, which\n'
        + 'is why no Merge node is needed.',
    },

    {
      n: 'Config Rows',
      t: 'code',
      code: `
const c = $input.first().json;
const rows = [
  ['odoo_url', c.odoo_url, 'Odoo base URL'],
  ['odoo_db', c.odoo_db, 'Database name, sent as the X-Odoo-Database header on every call'],
  ['odoo_user', c.odoo_user, 'Odoo login'],
  ['odoo_password', c.odoo_password, 'Password or API key. On the public sandbox this is literally "admin" and is not a secret.'],
  ['base_url', c.base_url, 'This n8n instance, for webhooks and the test harness'],
  ['manager_email', c.manager_email, 'VIP approvals and SLA escalations'],
  ['fallback_owner_id', c.fallback_owner_id, 'Assignment rung 3'],
  ['provisioned', c.provisioned, 'How the Odoo connection was obtained'],
  ['setup_at', String(Math.floor(Date.now() / 1000)), 'Epoch seconds of the last successful setup'],
];
return rows.map(([key, value, note]) => ({ json: { key, value: String(value ?? ''), note } }));
`,
    },

    {
      n: 'Save Config',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'upsert',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_config' },
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'key', condition: 'eq', keyValue: '={{ $json.key }}' }] },
        columns: {
          mappingMode: 'defineBelow',
          value: { key: '={{ $json.key }}', value: '={{ $json.value }}', note: '={{ $json.note }}' },
          matchingColumns: ['key'],
          schema: [],
        },
        options: {},
      },
      notes: 'Upsert, so re-running setup re-points the entire system at a new Odoo without\n'
        + 'duplicate rows and without a manual clear.',
    },

    {
      n: 'Agent Rows',
      t: 'code',
      code: `
return $('Config').first().json.agents.map(a => ({ json: a }));
`,
    },

    {
      n: 'Seed Agents',
      t: 'dataTable',
      p: {
        resource: 'row',
        operation: 'upsert',
        dataTableId: { __rl: true, mode: 'name', value: 'lp_agents' },
        matchType: 'allConditions',
        filters: { conditions: [{ keyName: 'agent_id', condition: 'eq', keyValue: '={{ $json.agent_id }}' }] },
        columns: {
          mappingMode: 'defineBelow',
          value: {
            agent_id: '={{ $json.agent_id }}', name: '={{ $json.name }}', email: '={{ $json.email }}',
            services: '={{ $json.services }}', capacity: '={{ $json.capacity }}',
            open_leads: '={{ $json.open_leads }}', available: '={{ $json.available }}',
            odoo_user_id: '={{ $json.odoo_user_id }}',
          },
          matchingColumns: ['agent_id'],
          schema: [],
        },
        options: {},
      },
      executeOnce: false,
      notes: 'Upsert on agent_id refreshes the roster without resetting a live open_leads\n'
        + 'count to zero mid-demo.',
    },

    {
      n: 'Find crm.lead Model',
      t: 'executeWorkflow',
      p: {
        workflowId: { __rl: true, mode: 'id', value: '@LP-90 Odoo Gateway' },
        workflowInputs: {
          mappingMode: 'defineBelow',
          value: {
            model: 'ir.model', method: 'search_read',
            args_json: '[[["model","=","crm.lead"]],["id","model"]]',
            kwargs_json: '{"limit":1}',
            purpose: 'setup:find-model', lead_uid: '',
          },
          matchingColumns: [], schema: [],
        },
        options: { waitForSubWorkflow: true },
      },
      executeOnce: true,
    },

    {
      n: 'Find External Ref Field',
      t: 'executeWorkflow',
      p: {
        workflowId: { __rl: true, mode: 'id', value: '@LP-90 Odoo Gateway' },
        workflowInputs: {
          mappingMode: 'defineBelow',
          value: {
            model: 'ir.model.fields', method: 'search_read',
            args_json: '[[["model","=","crm.lead"],["name","=","x_lp_lead_id"]],["id","name"]]',
            kwargs_json: '{"limit":1}',
            purpose: 'setup:find-field', lead_uid: '',
          },
          matchingColumns: [], schema: [],
        },
        options: { waitForSubWorkflow: true },
      },
      executeOnce: true,
    },

    {
      n: 'Field Needed?',
      t: 'code',
      code: `
const model = $('Find crm.lead Model').first().json;
const field = $('Find External Ref Field').first().json;
if (!model.ok) throw new Error('Setup: could not read ir.model from Odoo: ' + model.error);
if (!field.ok) throw new Error('Setup: could not read ir.model.fields from Odoo: ' + field.error);

const modelId = (model.result || [])[0]?.id;
if (!modelId) throw new Error('Setup: Odoo has no crm.lead model. Is the CRM app installed?');

const exists = (field.result || []).length > 0;
return [{ json: { model_id: modelId, field_exists: exists, needs_field: !exists } }];
`,
      notes: 'crm.lead has no `ref` field, which is the obvious place an external id would\n'
        + 'go. Verified against a live Odoo: writing `ref` returns "Invalid field \'ref\'\n'
        + 'in \'crm.lead\'". So the pipeline adds its own x_lp_lead_id, and every\n'
        + 'idempotent upsert searches on that.',
    },

    {
      n: 'Create Field?',
      t: 'if',
      p: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          combinator: 'and',
          conditions: [{
            id: 'needs-field',
            leftValue: '={{ $json.needs_field }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          }],
        },
        options: {},
      },
    },

    {
      n: 'Create External Ref Field',
      t: 'executeWorkflow',
      p: {
        workflowId: { __rl: true, mode: 'id', value: '@LP-90 Odoo Gateway' },
        workflowInputs: {
          mappingMode: 'defineBelow',
          value: {
            model: 'ir.model.fields', method: 'create',
            args_json: '={{ JSON.stringify([{ name: "x_lp_lead_id", field_description: "LP Lead ID", model_id: $json.model_id, ttype: "char", store: true, index: true }]) }}',
            kwargs_json: '{}',
            purpose: 'setup:create-field', lead_uid: '',
          },
          matchingColumns: [], schema: [],
        },
        options: { waitForSubWorkflow: true },
      },
    },

    { n: 'Field Ready', t: 'noOp' },

    {
      n: 'Read Stages',
      t: 'executeWorkflow',
      p: {
        workflowId: { __rl: true, mode: 'id', value: '@LP-90 Odoo Gateway' },
        workflowInputs: {
          mappingMode: 'defineBelow',
          value: {
            model: 'crm.stage', method: 'search_read',
            args_json: '[[],["id","name","sequence"]]',
            kwargs_json: '{"limit":100}',
            purpose: 'setup:read-stages', lead_uid: '',
          },
          matchingColumns: [], schema: [],
        },
        options: { waitForSubWorkflow: true },
      },
      executeOnce: true,
    },

    {
      n: 'Missing Stages?',
      t: 'code',
      code: `
const res = $input.first().json;
if (!res.ok) throw new Error('Setup: could not read crm.stage from Odoo: ' + res.error);

const have = new Set((res.result || []).map(s => String(s.name).trim().toLowerCase()));
// from _shared/constants.js
const missing = C.STAGES_TO_CREATE.filter(s => !have.has(s.name.toLowerCase()));

return [{ json: {
  needs_stages: missing.length > 0,
  missing_names: missing.map(s => s.name),
  existing: [...have],
  // Odoo's create accepts a LIST of dicts and makes them all in one call, so
  // five stages cost one round trip instead of five.
  payload: missing.map(s => ({ name: s.name, sequence: s.sequence })),
} }];
`,
    },

    {
      n: 'Create Stages?',
      t: 'if',
      p: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          combinator: 'and',
          conditions: [{
            id: 'needs-stages',
            leftValue: '={{ $json.needs_stages }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          }],
        },
        options: {},
      },
    },

    {
      n: 'Create Stages',
      t: 'executeWorkflow',
      p: {
        workflowId: { __rl: true, mode: 'id', value: '@LP-90 Odoo Gateway' },
        workflowInputs: {
          mappingMode: 'defineBelow',
          value: {
            model: 'crm.stage', method: 'create',
            args_json: '={{ JSON.stringify([$json.payload]) }}',
            kwargs_json: '{}',
            purpose: 'setup:create-stages', lead_uid: '',
          },
          matchingColumns: [], schema: [],
        },
        options: { waitForSubWorkflow: true },
      },
    },

    { n: 'Stages Ready', t: 'noOp' },

    {
      n: 'Setup Summary',
      t: 'code',
      code: `
const cfg = $('Config Rows').all().map(i => i.json);
const get = (k) => (cfg.find(r => r.key === k) || {}).value || '';
const stages = $('Missing Stages?').first().json;
const field = $('Field Needed?').first().json;

const lines = [
  'Odoo:            ' + get('odoo_url'),
  'Database:        ' + get('odoo_db'),
  'Source:          ' + get('provisioned'),
  'External ref:    ' + (field.field_exists ? 'x_lp_lead_id already present' : 'x_lp_lead_id created'),
  'Stages created:  ' + (stages.needs_stages ? stages.missing_names.join(', ') : 'none needed'),
  'Agents seeded:   ' + $('Agent Rows').all().length,
  'Config rows:     ' + cfg.length,
];
return [{ json: { ok: true, summary: lines.join('\\n'), odoo_url: get('odoo_url'), odoo_db: get('odoo_db') } }];
`,
      notes: 'Prints what actually happened rather than "done". On a re-run it should say\n'
        + '"already present" and "none needed", which is how you can tell the workflow is\n'
        + 'genuinely idempotent instead of quietly recreating things.',
    },

    {
      n: 'note',
      t: 'sticky',
      at: [-900, -560],
      w: 720,
      h: 300,
      content: '## LP-00 Setup and Seed\n\n'
        + 'Run this **once**, before anything else. It is safe to run again.\n\n'
        + '1. Provisions a real Odoo from **Odoo\'s own public sandbox** (`demo.odoo.com/start`) '
        + 'or uses your own, depending on `mode` in **Config**.\n'
        + '2. Writes the connection into the `lp_config` data table. Every other workflow reads it '
        + 'from there, so **no other node ever needs editing**.\n'
        + '3. Adds `x_lp_lead_id` to `crm.lead`. Odoo has no `ref` field on leads, and idempotent '
        + 'upsert needs a searchable external key.\n'
        + '4. Creates the five funnel stages Odoo does not ship with.\n'
        + '5. Seeds the sales team.\n\n'
        + '**The eight `lp_*` data tables must exist first.** Create them with '
        + '`node scripts/create-tables.js`, or by hand from `03_Technical_Design/data-model.md`.',
    },
  ],

  flow: [
    ['Run Setup', 'Config'],
    ['Setup Webhook', 'Config'],
    ['Config', 'Which Mode?'],
    ['Which Mode?', 'Provision Demo Odoo', 0],
    ['Which Mode?', 'Read Existing Config', 1],
    ['Which Mode?', 'Use Manual Odoo', 2],
    ['Which Mode?', 'Reject Unknown Mode', 3],
    ['Provision Demo Odoo', 'Parse Provisioned DB'],
    ['Read Existing Config', 'Use Existing Odoo'],
    ['Parse Provisioned DB', 'Config Rows'],
    ['Use Existing Odoo', 'Config Rows'],
    ['Use Manual Odoo', 'Config Rows'],
    ['Config Rows', 'Save Config'],
    ['Save Config', 'Agent Rows'],
    ['Agent Rows', 'Seed Agents'],
    ['Seed Agents', 'Find crm.lead Model'],
    ['Find crm.lead Model', 'Find External Ref Field'],
    ['Find External Ref Field', 'Field Needed?'],
    ['Field Needed?', 'Create Field?'],
    ['Create Field?', 'Create External Ref Field', 0],
    ['Create Field?', 'Field Ready', 1],
    ['Create External Ref Field', 'Field Ready'],
    ['Field Ready', 'Read Stages'],
    ['Read Stages', 'Missing Stages?'],
    ['Missing Stages?', 'Create Stages?'],
    ['Create Stages?', 'Create Stages', 0],
    ['Create Stages?', 'Stages Ready', 1],
    ['Create Stages', 'Stages Ready'],
    ['Stages Ready', 'Setup Summary'],
  ],
};
