# Lead Intelligence Pipeline

A multi-source lead-processing pipeline built in **n8n**, with **Odoo** as the central CRM and
system of record. Leads arrive from a website form, a WhatsApp webhook and CSV import; they are
normalised, validated, de-duplicated, enriched, scored by deterministic rules, classified
separately by an LLM, routed to a salesperson, written to Odoo, followed up on a schedule, and
audited end to end. Failures are classified, dead-lettered and replayable.

Built for the Automation Engineer technical assessment.

---

## The one-paragraph version

Every side effect in this system is **claimed in a ledger before it happens**. A duplicate webhook,
a retried send, a lost acknowledgement and a manual re-run all converge on the same outcome,
because the question asked before acting is never "did this succeed?" but "has this already been
claimed?". That single idea is what makes eleven of the fourteen mandated edge cases fall out of
the architecture rather than being special-cased. The rest of the design is deliberately boring.

---

## What is here

```
01_README/            this file, .env.example, SETUP.md, RUNNING.md
02_Workflows/         11 exported n8n workflows + the specs and shared runtime they are built from
03_Technical_Design/  the design document, data model, business rules, error strategy
04_Architecture/      Mermaid architecture diagram (renders on GitHub)
05_Test_Evidence/     the edge-case runner, its output, the matrix, and the Odoo API probe
06_Sample_Data/       website / WhatsApp / CSV payloads, including deliberately broken ones
scripts/              build, deploy, create tables, reset the demo, unit tests
```

## The eleven workflows

| Workflow | Nodes | What it is responsible for |
|---|---|---|
| **LP-00 Setup and Seed** | 26 | One-click provisioning: Odoo connection, the external-reference field, the five extra funnel stages, the sales roster, config |
| **LP-01 Intake** | 17 | Website / WhatsApp / CSV in, one canonical lead out. Gates duplicate *deliveries*, quarantines bad rows |
| **LP-02 Qualify** | 15 | Enrichment, deterministic score, independent AI classification, conflict detection, band. **No side effects** |
| **LP-03 Route and Sync** | 24 | Duplicate resolution, workload-aware assignment, idempotent Odoo upsert, stage transition, follow-up scheduling, outreach. **The only workflow that writes** |
| **LP-04 Tick** | 24 | Drains the follow-up and SLA queue, requeues stuck work, dead-letters stale claims, reassigns orphaned leads |
| **LP-05 Error Handler and DLQ** | 23 | Catches every failure, classifies it, dead-letters it, alerts, and replays it safely |
| **LP-06 Events and Approvals** | 23 | Reply, opt-out, booking, close, sales-action events, plus the VIP approve/reject decision |
| **LP-07 Ops Report** | 13 | Daily operational summary email and an on-demand JSON metrics endpoint |
| **LP-90 Odoo Gateway** | 10 | The single egress point for Odoo. Auth, bounded retry, and the 200-on-error trap |
| **LP-92 Send Message** | 17 | The single outbound gate: claim, last-moment stop-condition recheck, send, record |
| **LP-99 Mock Services** | 20 | Enrichment / WhatsApp / booking stand-ins with on-demand, deterministic failure injection |

212 nodes. `validate_workflow` returns **valid: true, 0 errors** on all eleven.

## Two decisions worth knowing before you read anything else

**LP-02 decides, LP-03 acts.** Qualification has no side effects, so it is safe to re-run at any
time; every write, assignment, message and schedule lives in one workflow. This is why a replay
cannot half-happen.

**The AI contributes zero points to the score.** Delete the whole AI layer and every lead still
scores, routes, assigns and syncs. The model is a *separate qualitative axis*, and it is
deliberately never shown the score - otherwise "AI disagrees with the rules" measures anchoring
rather than disagreement.

---

## Setup

Full detail in [SETUP.md](SETUP.md). The short version, from a bare n8n instance:

```bash
cp 01_README/.env.example .env      # fill in N8N_API_URL, N8N_API_KEY, LP_WEBHOOK_TOKEN
node scripts/create-tables.js       # creates the eight lp_* data tables
node scripts/deploy.js              # pushes and publishes all 11 workflows
curl -X POST https://<your-n8n>/webhook/lp-setup \
     -H "X-LP-Token: $LP_WEBHOOK_TOKEN" -H 'Content-Type: application/json' \
     -d '{"mode":"demo","manager_email":"you@example.com"}'   # Odoo, stages, field, roster
```

Three n8n credentials are referenced **by name**, never by id, and none of their values are in this
repo:

| Credential name | Type | Used for |
|---|---|---|
| `LP Webhook Token (X-LP-Token)` | HTTP Header Auth | every inbound webhook |
| `Gmail account` | Gmail OAuth2 | confirmations, follow-ups, alerts, the daily report |
| `OpenRouter account` | OpenRouter API | the qualitative classification in LP-02 |

## Running it

Full detail in [RUNNING.md](RUNNING.md).

```bash
node scripts/test-scoring.js                 #  61 unit assertions, no network
node scripts/test-intake.js                  #  97 unit assertions, no network

node scripts/demo-reset.js you@example.com   # back to a known-empty state
node 05_Test_Evidence/run-edge-cases.mjs     #  15 mandated edge cases, live
node 05_Test_Evidence/run-hardening.mjs      #  32 hardening checks, live
node 05_Test_Evidence/run-edge-cases.mjs 7   # just one
```

Send a lead by hand:

```bash
curl -X POST https://<your-n8n>/webhook/lp-web-lead \
     -H "X-LP-Token: $LP_WEBHOOK_TOKEN" -H 'Content-Type: application/json' \
     -d @06_Sample_Data/website-lead.json
```

## Pointing it at your own Odoo

Three lines. Open **LP-00 Setup and Seed**, set the `Config` node to:

```js
mode: 'manual',
odoo_url: 'https://yourcompany.odoo.com',
odoo_db:  'yourcompany',
odoo_user: 'you@yourcompany.com',
odoo_password: '<an Odoo API key>',
```

Run it once. It creates the `x_lp_lead_id` field, the five missing stages and the roster, writes
the connection into `lp_config`, and every other workflow picks it up on its next execution.
Nothing else changes: all Odoo traffic already goes through LP-90.

## Why the workflows are generated

`02_Workflows/*.json` is **built**, not hand-edited: `02_Workflows/_src/<name>.js` is a compact spec
and `scripts/build-workflows.js` renders it. Three reasons, all of them things that went wrong
before the builder existed:

1. The Code nodes run the **same source** the unit tests run. `_shared/constants.js`, `scorer.js`
   and `intake.js` are concatenated into each node at build time, so there is no hand-copied logic
   to drift away from its tests.
2. Node ids, canvas positions and the connection graph are generated, so they cannot contradict
   each other.
3. Re-running the build **is** the diff. Reviewing a change means reading a twenty-line spec edit,
   not a nine-hundred-line JSON blob.

The JSON is committed and importable on its own - you never need to run the builder to review or
run this. Edit the spec and rebuild if you want to change behaviour.

**The cost, stated plainly: the JSON files are large** (300-500 KB each). n8n Code nodes cannot
`require` anything, so the shared runtime is inlined into every node that uses it - the same 900
lines, twenty times over. That is the price of the tests and the nodes running identical source
rather than two copies that agree today. **Read the specs in `_src/`, not the JSON**; the JSON is
build output, and it is committed only so the submission is importable without a build step.

## Where to look first

- **Is it real?** [05_Test_Evidence/EDGE-CASES.md](../05_Test_Evidence/EDGE-CASES.md) - fifteen
  cases, each asserting on an observable outcome in Odoo or the ledger, and a runner you can
  execute yourself.
- **Why is it built this way?** [03_Technical_Design/DESIGN.md](../03_Technical_Design/DESIGN.md).
- **What does it look like?** [04_Architecture/architecture.md](../04_Architecture/architecture.md).
- **What is not finished?** The last section of the design document, and it is not short.

## Cost

The AI layer costs about **$0.07 per 1,000 classified leads**. That is arithmetic, not a meter
reading: `google/gemini-2.5-flash-lite` at its list price of $0.10/M input and $0.40/M output, and
this prompt at ~285 input and ~95 output tokens per lead. It is also an upper bound, because leads
with no free text are not classified at all. Everything else - n8n, Data Tables, the Odoo sandbox -
is free.
