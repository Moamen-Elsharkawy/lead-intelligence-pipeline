# Running the solution

Every endpoint below takes `X-LP-Token: $LP_WEBHOOK_TOKEN` and `Content-Type: application/json`.
Replace `$N8N` with your instance URL.

---

## Sending a lead

### Website form

```bash
curl -X POST $N8N/webhook/lp-web-lead -H "X-LP-Token: $LP_WEBHOOK_TOKEN" \
  -H 'Content-Type: application/json' -d @06_Sample_Data/website-lead.json
```

```json
{ "ok": true, "accepted": 1, "duplicates": 0, "quarantined": 0,
  "lead_uids": ["LP-20260811-4A9C21E0"] }
```

**202, not 200, and it is sent before the work.** The pipeline enriches, calls a model and writes
to Odoo; a webhook that waits for all of that is a webhook that times out, and a source that times
out retries, which is how you get duplicates. The 202 means *accepted and durably recorded*, and
everything after it is asynchronous. That is also why the test suite polls for outcomes instead of
reading the response body.

### WhatsApp

```bash
curl -X POST $N8N/webhook/lp-wa-inbound -H "X-LP-Token: $LP_WEBHOOK_TOKEN" \
  -H 'Content-Type: application/json' -d @06_Sample_Data/whatsapp-inbound.json
```

Takes a real **WhatsApp Business Cloud API** envelope (`entry[].changes[].value.messages[]`), so
pointing Meta at this URL is a configuration change rather than a code change. Delivery-status
callbacks - the `statuses[]` payload, which Meta sends far more often than messages - are
acknowledged and ignored; `06_Sample_Data/whatsapp-status-callback.json` is one, and treating it as
a lead is a mistake worth not making.

### CSV import

```bash
curl -X POST $N8N/webhook/lp-csv-import -H "X-LP-Token: $LP_WEBHOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"batch_id":"mar-tradeshow","attested_consent":true,"csv":"Name,Email,...\n..."}'
```

```json
{ "ok": true, "accepted": 2, "duplicates": 0, "quarantined": 2,
  "lead_uids": ["LP-...", "LP-..."],
  "errors": [ { "line": 3, "error": "expected 8 columns, found 3" },
              { "line": 5, "error": "no valid email and no valid phone - nothing to contact" } ] }
```

Bad rows are quarantined **individually**, with their original text, into the dead-letter queue -
fix the cell and replay. The rest of the batch imports. `attested_consent` is the importer stating
they have a lawful basis for these contacts; it is recorded on every lead as
`consent_source: import_attested`, because "where did consent come from" is a question that gets
asked after the fact.

## Operating it

| Endpoint | Body | What it does |
|---|---|---|
| `POST /webhook/lp-tick` | `{}` | Runs the tick immediately instead of waiting for the 5-minute schedule. The demo's clock |
| `POST /webhook/lp-event` | `{"type":"reply\|opt_out\|booking\|close\|sales_action","lead_uid":"LP-..."}` | Anything that happens to a lead after it is routed |
| `POST /webhook/lp-approval` | `{"lead_uid":"LP-...","decision":"approve\|reject","by":"manager@..."}` | The VIP gate |
| `POST /webhook/lp-replay` | `{"dlq_id":"dlq-...","override_json":{...}}` | Replay a dead letter, skipping whatever already completed |
| `POST /webhook/lp-ops` | `{}` | The operational summary as JSON |
| `POST /webhook/lp-setup` | `{"mode":"demo\|keep\|manual"}` | Re-provision or re-verify Odoo |

The operational summary, also emailed daily at 08:00:

```json
{ "window": "last 24h",
  "totals": { "processed": 41, "qualified": 12, "vip": 3, "nurture": 9,
              "unqualified": 7, "duplicates": 5, "manual_review": 2,
              "failed": 1, "sla_breached": 1 },
  "dead_letters": { "open": 1, "replayed": 3 } }
```

## Watching it work

Three windows, in the order a reviewer should open them:

1. **Odoo** - `Sales → Leads`, filtered to the pipeline's stages. This is the system of record. A
   green n8n execution is not evidence that anything landed here; that is the whole reason the test
   suite queries Odoo over JSON-RPC instead of trusting the workflow.
2. **The `lp_audit` data table** - one row per decision, filterable by `lead_uid`. "Why did this
   lead get this result" is answered by reading its rows top to bottom, and every scoring
   contribution is in there by name and by points.
3. **n8n executions** - for stack traces only. It is pruned, and it is not queryable by lead, so it
   is not the audit trail.

## Reproducing failures on demand

Two hooks make the failure edge cases repeatable in front of a reviewer instead of being a story.

**`enrich_chaos`** is a config row appended to the enrichment URL:

```
?fail=timeout&times=2     time out twice, then succeed        (EC-3)
?fail=429&times=1         rate-limit once, honour Retry-After (EC-6)
?fail=malformed           return something unparseable        (EC-4)
?fail=401                 credential death                    (I)
?reset=1                  clear the counter
```

The counter is real: it lives in `lp_idem` under `scope='mock'`, so the third call genuinely
behaves differently from the first two.

**`POST /webhook/lp-tick`** runs the scheduler now, so a 30-minute SLA or a three-day follow-up can
be demonstrated in seconds by winding a `due_at` back and ticking.

## The test suite

```bash
node scripts/test-scoring.js               # 61 assertions, no network
node scripts/test-intake.js                # 77 assertions, no network

node scripts/demo-reset.js you@example.com # OPTIONAL: back to a known-empty state
node 05_Test_Evidence/run-edge-cases.mjs   # 15 cases against the live pipeline
node 05_Test_Evidence/run-edge-cases.mjs 7 14
```

**Reset first if you are running the suite repeatedly.** The cases are designed to survive leftover
state - identities are run-unique - but they cannot survive a saturated roster: each run leaves
about fifteen active leads behind and the seeded capacities are 8, 8 and 6, so by the third
consecutive run every salesperson is full and the reassignment case has nowhere to reassign to.
`demo-reset.js` recreates the tables, provisions a fresh Odoo sandbox and re-arms the mail redirect,
in about ninety seconds. It is destructive by design.

The unit suites cover the pure logic - normalisation, scoring, banding, conflict detection,
idempotency keys, backoff, CSV parsing - and run in about a second with nothing attached.

The edge-case runner drives the real deployment and asserts on **observable outcomes**: a row in
Odoo, a state in the ledger, a cancelled job. Never on "the workflow finished without erroring",
which on this stack is not evidence of anything. It writes `05_Test_Evidence/last-run.json` and
exits non-zero on failure.

Every run uses run-unique identities derived from the clock. This is not tidiness: with fixed phone
numbers, a lead from a previous run was still in Odoo, the new lead merged into *it*, and the
dedupe assertion passed without this run having created anything to dedupe against. A test that
passes for the wrong reason is worse than one that fails.
