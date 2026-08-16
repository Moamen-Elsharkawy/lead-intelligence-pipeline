# Technical Design

Lead Intelligence Pipeline. n8n + Odoo. Written for a reviewer who wants to know *why*, not *what* -
the *what* is in the workflow JSON and it is heavily commented.

| | |
|---|---|
| Stack | n8n 2.69.0 self-hosted, Odoo saas~19.3 (external API over JSON-RPC), OpenRouter |
| State | eight n8n Data Tables (`lp_*`) |
| Size | 11 workflows, 212 nodes, 194 unit assertions, 47 live tests (15 edge cases + 32 hardening) |
| Running cost | ~$0.07 per 1,000 classified leads (calculated, see §5). Everything else is free |

**Contents.** [1 Assumptions](#1-assumptions) · [2 Architecture](#2-architecture-overview) ·
[3 Workflows](#3-workflow-breakdown) · [4 Data schema](#4-data-schema) ·
[5 Integrations](#5-external-integrations--apis) · [6 Auth and secrets](#6-authentication-and-secrets-handling) ·
[7 Idempotency](#7-idempotency-strategy) · [8 Errors and retry](#8-error-handling-and-retry-strategy) ·
[9 Human approval](#9-human-approval--manual-review-logic) · [10 Observability](#10-logging-and-observability) ·
[11 Testing](#11-testing-approach) · [12 Limitations](#12-known-limitations-and-next-improvements)

Companion documents: [DATA-MODEL.md](DATA-MODEL.md) (every table and column),
[BUSINESS-RULES.md](BUSINESS-RULES.md) (scoring and routing, with worked examples),
[ERROR-STRATEGY.md](ERROR-STRATEGY.md) (retry, idempotency and reprocessing in operational detail).

---

## 1. Assumptions

Stated because each one changes the design, and a reviewer should be able to disagree with the
assumption rather than the code.

**About the business**

1. **B2B services, MENA-centred.** Core markets EG / AE / SA, adjacent Gulf, everything else scores
   lower. Phone normalisation defaults to Egypt (`+20`) when a number carries no country code. All
   of that is data in `_shared/constants.js`, not logic.
2. **A small sales team - single digits.** Four seeded. Assignment reads the whole roster into
   memory and sorts it, which is right for tens of people and wrong for thousands.
3. **Volume is hundreds a day, not hundreds of thousands.** This shapes the state store choice
   (§12) more than anything else in the document.
4. **A lead is a person, not a company.** Two people from the same company are two leads. Identity
   is phone first, then email.
5. **Missing data is not a rejection.** A lead with no company and no budget is a normal lead. Only
   *nothing to contact them by* is disqualifying.

**About the sources**

6. **The website form posts JSON** with a `submission_id`. If yours does not, the intake still
   works - the idempotency key falls back to a content hash (§7).
7. **WhatsApp is the real Meta Cloud API envelope.** The webhook parses
   `entry[].changes[].value.messages[]` and ignores `statuses[]` callbacks. Swapping the mock sender
   for Meta is a URL and a credential.
8. **A CSV import carries attested consent.** The importer states they have a lawful basis; it is
   recorded per lead as `consent_source: import_attested` rather than assumed.
9. **Sources are at-least-once.** Every one of them may deliver the same event twice. This is
   assumed, not hoped.

**About the environment**

10. **Odoo is the system of record for the funnel; n8n owns the pipeline's own memory.** Nothing
    about workflow state is stored in Odoo, and nothing about the sales funnel is authoritative
    outside it.
11. **`$env` is blocked on this instance** (`N8N_BLOCK_ENV_ACCESS_IN_NODE=true`) and `$vars` is
    licence-gated. Hence `lp_config` (§6).
12. **The n8n instance can be down for hours.** Follow-ups are queue rows with a `due_at`, not
    in-memory `Wait` nodes, so the queue drains late instead of being lost.
13. **Any credential can die silently.** Observed five times on this instance before this project:
    the workflow keeps reporting `active: true` and every run errors on its first node. `401` is
    therefore classified as *permanent, critical, alert immediately* - never retried.

---

## 2. Architecture overview

Diagram: [../04_Architecture/architecture.md](../04_Architecture/architecture.md).

```
website ─┐
whatsapp ─┼──► LP-01 Intake ──► LP-02 Qualify ──► LP-03 Route & Sync ──► Odoo
csv ─────┘      (gate)            (decide)            (act)              (system of record)
                    │                 │                   │
                    └─────────────────┴───────────────────┴──► lp_audit (why)
                                                          └──► lp_jobs  (when)
                                                                    │
                                          LP-04 Tick (every 5 min) ─┘──► LP-92 Send
                    LP-06 Events ──► cancel / stage / approve
                    LP-05 Errors ──► classify → dead-letter → replay
```

### The one idea

**Every side effect is claimed in a ledger before it happens.** Not checked afterwards - claimed
first. The question asked before acting is never "did this succeed?" but "has this already been
claimed?".

Three steps, no exceptions:

1. **Derive a deterministic key.** Intake: the provider id, or a content hash. Odoo write:
   `odoo_upsert:<lead_uid>`. Message: `message:<lead_uid>:<template>:<step>`. Booking:
   `booking:<booking_id>`.
2. **Claim it** - insert into `lp_idem` with `state=claimed`. If the row already exists, stop and
   write an audit row saying why.
3. **Act, then flip to `done`** with a `result_ref` (the Odoo id, the provider message id).

A crash between 2 and 3 leaves a `claimed` row, which is the *interesting* state: it means
"something may have happened out there". The replay path in LP-05 searches Odoo by external
reference before doing anything, finds the record that did get created, and repairs the ledger
instead of creating a second one. That is edge case 7, answered mechanically rather than
specially.

Eleven of the fourteen mandated edge cases are consequences of this one mechanism.

### Four structural decisions

**LP-02 decides, LP-03 acts.** Qualification produces a verdict object and touches nothing. Every
write, assignment, stage move, message and schedule is in LP-03. Two consequences: re-running
qualification is always safe, and there is exactly one writer per fact - so "what set this field"
has one answer.

**One gateway per external system.** All Odoo traffic goes through **LP-90**, all outbound
messaging through **LP-92**. Retry policy, error classification, auth and the stop-condition
recheck each exist once. Swapping mock WhatsApp for Meta touches one node.

**A due-queue, not `Wait` nodes.** Follow-ups are rows with a `due_at`, drained by a five-minute
tick. A held-open `Wait` cannot be cancelled cleanly, does not survive a restart, and holds an
execution slot for three days. The queue survives downtime, and cancellation is a status update -
which is what makes edge case 10 genuinely work rather than appear to. The tick **re-reads the stop
conditions immediately before sending**, so even a job already claimed for this tick will not go
out to someone who opted out four seconds ago.

**The AI contributes zero points.** Delete the whole AI layer and every lead still scores, routes,
assigns and syncs. The model is a separate qualitative axis over free text, and it is deliberately
**never shown the score** - otherwise "the AI disagrees with the rules" measures anchoring rather
than disagreement, and the conflict rule (§9) becomes theatre.

### Why n8n Data Tables for state

They are built in, free, transactional enough for this, and visible in the same UI as the
workflows - a reviewer can watch the ledger fill up while a lead flows through. The costs are real
and are listed in §12: no DELETE through the API, immutable schemas, a 250-row page ceiling, and no
unique constraint (§7 explains why the claim is still safe without one).

Google Sheets was the alternative. Same shape, worse latency, and a shared-quota failure mode.

---

## 3. Workflow breakdown

### LP-00 Setup and Seed — 26 nodes, manual + `POST /webhook/lp-setup`

Turns a bare instance into a working one. Provisions or verifies the Odoo connection, creates the
`x_lp_lead_id` custom field, creates the five funnel stages Odoo does not ship with, seeds the sales
roster, writes nine `lp_config` rows.

Three modes: `demo` (provision a throwaway database from Odoo's own public sandbox), `keep` (reuse
and re-verify - the mode that demonstrates setup is idempotent), `manual` (your own Odoo).

Its existence is the answer to "can I run this?". It also means the Odoo endpoint is *configuration*,
so a sandbox expiring is a re-run rather than an outage.

### LP-01 Intake — 17 nodes, three webhooks

Three fixed webhook paths, three normalisers that **only map field names**, and one shared
`finalizeLead` / `validateLead` pair in `_shared/intake.js` holding every actual rule. No per-source
logic exists downstream of node three.

Order matters in one place: **country is resolved before phone**, because a stated country picks the
dialling code for a local-format number.

Validation returns four states with four different consequences:

| State | Meaning | Consequence |
|---|---|---|
| `ok` | usable | continue |
| `incomplete` | missing a critical field but contactable | **Data Completion** path, still a real lead |
| `unusable` | no valid email and no valid phone | quarantined - nothing can be done with it |
| `parse_error` | the row is not a row | quarantined with its original text |

Then the duplicate-**delivery** gate: has this exact `idem_key` been seen? (Duplicate *people* are a
different question, answered in LP-03 - see §7.) The webhook responds **202 before the work**, then
three parallel branches write the audit row, claim the key and store the lead, and hand off to
LP-02.

CSV parsing is a real state machine - quoted cells, doubled quotes, embedded commas and newlines,
CRLF, BOM - and attaches errors **per row**, so one broken row is quarantined alone while the batch
proceeds. Batches are capped at 200 rows.

### LP-02 Qualify — 15 nodes, sub-workflow

Enrich → score → classify → detect conflict → band. No side effects.

Enrichment is one HTTP call with `retryOnFail`, an 8-second timeout and `onError: continueRegularOutput`,
so a dead enrichment provider costs precision, never a lead. A miss is a legitimate answer: most
WhatsApp leads have no domain to enrich.

Scoring is deterministic, capped at 100, and **every factor emits a breakdown line** - factor, value,
points, note - written to the audit row. A score you cannot explain line by line is a score you
cannot defend when a salesperson disputes it. Details and worked examples:
[BUSINESS-RULES.md](BUSINESS-RULES.md).

The AI call is **gated**: skipped entirely when there is no free text, which removes most of the
spend. Temperature 0, `response_format: json_object`, 300 max tokens, schema-validated on return.
Anything unusable becomes `ai_status: unavailable` and the lead completes on rules alone.

### LP-03 Route and Sync — 24 nodes, sub-workflow

The only workflow with side effects, in one sequence: resolve duplicates → read the stage map →
count workload → assign → claim → upsert into Odoo → fan out seven ways (store the lead, record the
claim, write the audit row, schedule follow-ups, arm the SLA timer, send the confirmation, alert the
manager).

**Duplicate resolution** searches Odoo with an OR domain over email, phone and `x_lp_lead_id`, with
`active_test: false` - without it a previously-lost lead is invisible and gets created again. Then:

| Confidence | Signal | Action |
|---|---|---|
| self | `x_lp_lead_id` = this lead | `update_self` - a previous run reached Odoo |
| ≥ 0.90 | phone key, or normalised email | `merge_into` - attach to the existing opportunity |
| ≥ 0.60 | same name + company, or name + domain | `create_flagged` - create it, but stage for a human |
| below | — | `create` |

A merge **fills blanks only**. It never touches the survivor's external key, stage, owner or
description. Getting this wrong destroys the original lead's idempotency anchor, so a later replay
creates exactly the duplicate the merge existed to prevent - which is what happened here before it
was fixed, and it was found by reading Odoo rather than by a green execution.

**Assignment** is three rungs, deterministic, tie-broken by `agent_id`: available and handles the
service category → available, any category → the fallback owner plus an alert. Workload is
**counted from the lead table**, not read off a stored counter, because a counter needs a decrement
on every path that ends an assignment and the first path anyone forgets leaves that salesperson
permanently "full". The fallback owner is excluded from rungs 1 and 2: they are usually the manager,
with high capacity and every service category, so leaving them in the rotation quietly makes the
manager the default owner of everything.

**Stage transitions** are a single lookup table, `C.STAGE_TRANSITIONS`. Nothing else in the system
moves a stage, so "when does a lead reach Qualified" has exactly one answer to read. `Lost` is not a
stage: in Odoo it is `active=false` + `probability=0` + a reason.

### LP-04 Tick — 24 nodes, every 5 minutes + `POST /webhook/lp-tick`

Four independent branches:

- **Due queue.** Claims up to 25 due jobs (`due_at <= now`, filter pushed into the store), re-reads
  the stop conditions, sends, schedules the next step. Follow-ups are business-hours gated.
- **Stuck jobs.** In-flight for over 15 minutes → requeue, three strikes → dead-letter.
- **Stale claims.** A `claimed` idempotency row older than 10 minutes means a crash between claim
  and act → dead-letter it for the reconciler.
- **Owner health.** A salesperson going unavailable errors nothing, which is exactly the problem.
  The scan finds their leads, reassigns across the team, and writes it to Odoo too.

### LP-05 Error Handler and DLQ — 23 nodes, error trigger + `POST /webhook/lp-replay`

Set as the error workflow on every other workflow. Classifies the failure (transient / credential /
permanent, with credential escalated to critical on sight), derives a stable `dlq_id` from
`workflow | node | digit-normalised message | lead` so the same recurring failure is one dead letter
with a rising attempt count rather than a thousand rows, writes the dead letter, and alerts only when
alerting is useful.

The replay half is the interesting half. `POST /webhook/lp-replay {dlq_id, override_json?}` **reads
the ledger first**, decides which steps already completed, and re-dispatches only what remains -
reporting exactly what it skipped. `override_json` is how a corrupted CSV row is fixed and replayed.

### LP-06 Events and Approvals — 23 nodes, two webhooks

`reply | opt_out | booking | close | sales_action`, plus the VIP approve/reject decision. One effect
table maps event → cancellations, stage move, Odoo write, notification. Booking is claimed by
`booking:<booking_id>`, so a webhook delivered twice books once and answers `duplicate: true`.

**This is the one endpoint whose response comes after a write rather than before it.** Intake
answers 202 up front on purpose, because a webhook that waits for the pipeline is a webhook that
times out. An opt-out is the opposite case: if the 200 only means *accepted*, then anything acting
on it immediately - a tick, a retry, an operator - can still observe consent as granted, and a
follow-up escapes. So `Apply To Lead` runs first and the response follows it. Only that one write is
in front; job cancellation and the Odoo update stay behind the response, because `consent = denied`
on the lead row is already the first stop condition LP-92 checks.

### LP-07 Ops Report — 13 nodes, daily 08:00 + `POST /webhook/lp-ops`

Processed, qualified, VIP, nurture, unqualified, duplicates, manual review, failed, SLA breached,
dead letters open and replayed. Emailed, and available as JSON with the internal fields stripped.

### LP-90 Odoo Gateway — 10 nodes, sub-workflow

Every Odoo call in the system. It exists because of two things the n8n Odoo node cannot do: send the
`X-Odoo-Database` header a multi-tenant host needs, and notice that **`/jsonrpc` answers HTTP 200 on
failure** - the error is in the body. The gateway parses the body, classifies, retries transient
failures with bounded backoff, and returns `{ok, result, error, error_class}`.

### LP-92 Send Message — 17 nodes, sub-workflow

The single outbound gate. Renders the template, then checks the stop conditions **in this order**:
consent → already sent → lead closed → job cancelled → job missing → approval rejected → awaiting
approval. Then claims, sends, records the provider reference.

Ordering is deliberate: consent is checked first because it is the one that must never be wrong.

The **mail redirect** lives here. With `demo_redirect_email` set, every lead-facing message goes to
the operator with the intended recipient preserved in the subject and in the audit row. The
edge-case suite refuses to start without it.

### LP-99 Mock Services — 20 nodes, three webhooks

Enrichment, WhatsApp send and booking stand-ins, each with deterministic failure injection driven by
the query string: `?fail=timeout|429|malformed|500|401&times=N&reset=1`. The counter lives in
`lp_idem` under `scope='mock'`, so the third call genuinely behaves differently from the first two -
which is what makes "times out twice, then succeeds" a test rather than a story.

---

## 4. Data schema

Full column-by-column detail: [DATA-MODEL.md](DATA-MODEL.md).

The canonical lead is defined once, in `_shared/constants.js`, and every source is normalised into
exactly this shape before anything else looks at it:

```
identity     lead_uid  source  source_ref  received_at
person       full_name  email_raw  email_norm  phone_raw  phone_e164  phone_key
             country  company  domain
intent       service_interest  free_text  urgency  budget_band
consent      consent (granted|denied|unknown)  consent_source
qualification score  score_breakdown_json  band
             ai_status  ai_intent  ai_urgency  ai_signals  ai_reason  ai_confidence
routing      owner_id  assign_rung  odoo_lead_id  odoo_stage
             approval_state  approval_by
lifecycle    status (active|merged|closed)  merged_into  raw_json  updated_at
```

`raw_json` keeps the original payload, so a replay can prove what actually arrived.

Eight tables: **`lp_lead`** (registry and current state), **`lp_idem`** (the claim ledger),
**`lp_person_index`** (person key → lead), **`lp_jobs`** (the due queue), **`lp_agents`** (roster),
**`lp_audit`** (append-only decision log), **`lp_dlq`** (dead letters), **`lp_config`** (runtime
configuration).

Timestamps are epoch **seconds** in numeric columns, because numeric comparison in the Data Table
filter operators is what the tick's `due_at <= now` claim depends on.

In Odoo, the pipeline writes `crm.lead` with one custom field, **`x_lp_lead_id`** - the external
reference that makes the CRM write idempotent. Every field the pipeline touches was verified against
`ir.model.fields` on the live database rather than assumed; `crm.lead.mobile` does not exist on
saas~19.3, which the duplicate search found out the hard way.

---

## 5. External integrations / APIs

| System | Transport | Auth | Failure posture |
|---|---|---|---|
| **Odoo** | JSON-RPC `POST /jsonrpc`, `execute_kw` | database + uid + password, resolved by `common.authenticate` | Everything through LP-90. **HTTP 200 on error**, so classification reads the body |
| **OpenRouter** | `POST /chat/completions` | n8n credential `OpenRouter account` | Optional. Unusable output → `ai_status: unavailable`, lead completes on rules |
| **Gmail** | n8n Gmail node | OAuth2, `Gmail account` | Send failure → error output → dead letter, never a silent drop |
| **Enrichment** | HTTP to LP-99 | `X-LP-Token` | 3 tries, 8s timeout, `continueRegularOutput`. A miss is a legitimate answer |
| **WhatsApp** | HTTP to LP-99, shaped like the Cloud API | `X-LP-Token` | Mock. Swapping in Meta is a URL and a credential |
| **Booking** | HTTP to LP-99 | `X-LP-Token` | Mock. Idempotent by `booking_id` |

**Why the Odoo node is not used.** It cannot send `X-Odoo-Database`, which a multi-tenant Odoo host
requires, and it does not know that `/jsonrpc` returns 200 with an error body. A raw HTTP call
through one gateway is both more honest and easier to reason about.

**What the mocks are, precisely.** LP-99 is a stand-in for three third-party services this project
has no account with. It is not a stand-in for Odoo, which is real, nor for Gmail, which is real. The
brief permits mocks where production access is unavailable; the boundary is drawn so that replacing
one is a configuration change:

```
enrich_url  → your provider          (lp_config)
whatsapp    → graph.facebook.com/... (one node in LP-92)
booking     → your scheduler's webhook
```

---

## 6. Authentication and secrets handling

**Nothing in this repository is a secret, and that is enforced rather than promised.**

| Secret | Where it lives | How the workflow reaches it |
|---|---|---|
| Webhook token | n8n credential `LP Webhook Token (X-LP-Token)` | HTTP Header Auth on every webhook node |
| Gmail OAuth | n8n credential `Gmail account` | referenced by name in the JSON |
| OpenRouter key | n8n credential `OpenRouter account` | `predefinedCredentialType` |
| Odoo url / db / user / password | `lp_config` data table, written by LP-00 | read by LP-90 per call |
| n8n API key | git-ignored `.env` at the repo root | scripts only, never a workflow |

**Inbound.** Every webhook requires `X-LP-Token`. Fixed paths, no path parameters (they do not
register on this build). The three mock endpoints are authenticated too - an open endpoint that
injects failures into a pipeline is not a small thing to leave lying around.

**Outbound.** Odoo credentials are read from `lp_config` at call time, so rotating them is a row
update with no redeploy. The password is never logged: the gateway logs the model, the method and
the error class, never the payload.

**Why `lp_config` instead of environment variables.** This instance runs with
`N8N_BLOCK_ENV_ACCESS_IN_NODE=true`, so `$env` throws inside a Code node, and `$vars` is
licence-gated. A config table was the remaining option, and it turned out better: values are visible
and editable in the same UI as the workflows, and LP-00 writes them, so provisioning is one action.

**What is in the exported JSON.** Credential **names** and no ids and no values. This matters twice:
it makes the repo safe to publish, and it makes the import portable, because ids are minted per
instance. `deploy.js` resolves names to ids at deploy time and **refuses to deploy an unknown
name** - n8n will otherwise silently bind a name-only reference to some other credential of the same
type, which is a very quiet way to send your leads through the wrong account.

**The demo Odoo password is the literal string `admin`** on a public throwaway sandbox that Odoo
hands to anyone who asks. It is not a secret and is not treated as one. Point the pipeline at a real
Odoo and the password lives in `lp_config` on your own instance.

---

## 7. Idempotency strategy

Operational detail: [ERROR-STRATEGY.md](ERROR-STRATEGY.md).

### Two keys, because they answer two different questions

```
idem_key    identifies an EVENT   "has this exact delivery been processed?"
person_key  identifies a HUMAN    "have we met this person before?"
```

Conflating them is the classic bug, and it fails in both directions. Deduplicate by event key and
the same person arriving on WhatsApp and the website is silently dropped - a real second enquiry,
lost. Deduplicate by person key and a retried webhook overwrites good data with a partial payload.

The pipeline uses both. Two deliveries from one person produce **two accepted events** and **one
opportunity**: the second is marked `merged` and attached to the first. That is edge case 1, and it
is the reason the design has two keys at all.

### Deriving the event key

A provider id is always preferred (`wamid`, `submission_id`, `batch:line`). Where there is none, the
key is a hash of the submission's own content - **not a time bucket**. Time bucketing was the first
design and it is fragile exactly where it matters: two clicks five seconds apart can straddle a
bucket edge and both be accepted, which is the duplicate the gate exists to stop. A content hash has
no boundary.

The accepted trade-off: someone who submits a byte-identical form twice a week apart is treated as
one event. That is the correct reading of an identical request, and the second delivery still writes
an `intake_duplicate_event` audit row, so it is visible rather than silent.

Hashing is FNV-1a 64-bit over canonical JSON with sorted keys, so key order cannot change the hash,
and the same function runs in a Code node and in the test runner.

### The claim, and its one honest weakness

Claiming is read-then-insert, not an atomic upsert, because n8n Data Tables have no unique
constraint. Two *simultaneous* claims of the same key could both succeed.

Why that is acceptable here, stated plainly rather than hidden: the window is milliseconds; the
sources that retry (webhooks) retry after seconds, not microseconds; and the expensive
irreversible action behind the claim - the Odoo write - is *additionally* protected by a
search-before-create on `x_lp_lead_id`, which is a real uniqueness check against the system of
record. So the ledger is the fast path and Odoo is the backstop.

If this needed to be airtight, the fix is a store with a unique index - Postgres or Redis `SETNX` -
and it is one node's worth of change inside LP-03. See §12.

### Where each key is used

| Scope | Key | Protects against |
|---|---|---|
| `intake` | provider id, or content hash | a webhook delivered twice (EC-1) |
| `odoo_upsert` | `odoo_upsert:<lead_uid>` | a duplicate CRM record (EC-7, EC-14) |
| `message` | `message:<lead_uid>:<template>:<step>` | the customer getting the same message twice (EC-8) |
| `booking` | `booking:<booking_id>` | a booking webhook delivered twice (EC-11) |
| `approval` | `approval:<lead_uid>` | a decision applied twice |
| `mock` | `mock:<service>:<plan>` | (the chaos counter, so failure injection is deterministic) |

---

## 8. Error handling and retry strategy

Operational detail: [ERROR-STRATEGY.md](ERROR-STRATEGY.md).

### Classification comes before retry

Retrying the wrong class of failure is worse than not retrying. A dead credential retried three
times is three times the log noise and zero times the fix.

| Class | Examples | Action |
|---|---|---|
| **transient** | timeout, 429, 500, 502, 503, 504, socket reset | retry, bounded backoff, then dead-letter |
| **credential** | 401, 403, `invalid_grant`, "session expired" | **never retried.** Dead letter at severity `critical`, alert now |
| **permanent** | 400, 404, 422, "Invalid field", schema violation | dead letter, no retry, no alert unless it repeats |

### Retry

Max 3 attempts, base 500ms, exponential with ±25% jitter, **capped at 8 seconds, clamped last**.

Clamping last is not a detail. The obvious ordering - cap, then jitter - returns up to 10s from an
"8s cap", so the cap is not a cap. A single sample passes; 2,000 samples do not, which is why the
unit test takes 2,000 samples.

The cap is 8 seconds rather than 60 because the gateway is called with `waitForSubWorkflow`, so a
long backoff holds the caller open and can blow a webhook response window. Every path is bounded by
attempts **and** by total elapsed time, so nothing can loop forever.

`Retry-After` is honoured when a 429 supplies it.

### Dead-letter and replay

Every failure becomes an `lp_dlq` row carrying the payload, the classification, the failing
workflow and node, and an attempt count. The `dlq_id` is stable across recurrences - derived from
`workflow | node | digit-normalised message | lead` - so a failure happening every five minutes is
one row with a rising count, not 288 rows a day.

Replay is safe **because it reads the ledger before acting**, not because the operator is careful:

```
POST /webhook/lp-replay {"dlq_id": "dlq-...", "override_json": {...}}
  → load the dead letter
  → read lp_idem for this lead
  → decide what already completed
  → re-dispatch only what remains, and report what was skipped
```

Edge case 14 is exactly this: the replay reports `odoo_already_created: true`, skips
`["odoo_upsert", "message"]`, and the opportunity count stays at 1.

### Two failure modes this instance taught us

**`active: true` is not evidence.** A workflow with a dead credential keeps reporting active and
keeps firing; every run errors on the first node. Verify at the destination.

**`status: success` is not evidence either.** A node carrying `onError: continueRegularOutput`
swallows a 401 exactly like an expected empty result, so the execution is logged successful and
nothing alerts. This is why the edge-case suite asserts against Odoo and the ledger, never against
"the workflow finished".

---

## 9. Human approval / manual review logic

Four ways a human enters the loop. Each is a *stage in Odoo*, so the queue is visible where the
sales team already works rather than in a tool only the automation knows about.

### VIP approval — score ≥ 90 or a strategic-account flag

Stage `Awaiting Approval`. **No outbound message is sent.** The manager is emailed with the score
breakdown, the AI's reading and a one-click approve / reject.

- **Approve** → the verdict is rebuilt and handed back to LP-03, which routes it as Qualified and
  sends the confirmation.
- **Reject** → status `closed`, every pending job cancelled, the opportunity marked lost with
  `Rejected by manager`. This is edge case 12, and "everything outbound stops" is enforced in LP-92:
  `awaiting_approval` and `approval_rejected` are two of its seven stop conditions, so even a job
  already claimed for this tick will not send.

### AI / rules conflict — the "materially" made numeric

A reviewer will ask what *materially* means, so it is one clause and two constants:

```js
materiallyConflicts = ai.status === 'ok'
  && ai.confidence >= 0.7
  && |bandOrdinal(aiImpliedBand) - bandOrdinal(ruleBand)| >= 2
```

Ordinals: `unqualified 0, nurture 1, qualified 2, vip 2`.

**Adjacent disagreement does not count.** Qualified versus Nurture is expected noise around a cut
point; if it triggered review, the manual queue would become the default path and the automation
would have achieved nothing. Only a two-step gap from a confident model - "high potential" against
rules that scored 38 - is a real disagreement, and neither side wins it: the lead goes to `Manual
Review` with both readings side by side.

### Ambiguous duplicate — confidence 0.60 to 0.89

Same name and company, different contact details. The lead **is created** - losing a real lead is
worse than a duplicate - but staged for a human with the candidate opportunity named, so the review
takes seconds. Never auto-merged, never auto-deleted.

### Data Completion — missing critical data

Not a failure and not a silent drop: a stage, with the lead intact and the specific missing field
named.

### Unassignable

Rung 3: nobody available or nobody with headroom. The lead goes to the fallback owner **and raises
an alert**, because an unassigned lead is a lead nobody is accountable for. The tick reassigns it
when capacity frees up.

---

## 10. Logging and observability

### `lp_audit` is the audit trail; n8n's execution log is not

The execution log is pruned (14 days by default), is not queryable by lead, and holds no business
meaning. `lp_audit` is append-only, one row per decision, and every row carries `lead_uid`,
timestamp, workflow, **execution id**, type, a one-line decision and a JSON detail blob.

22 event types: `intake_received`, `intake_duplicate_event`, `validation_failed`,
`duplicate_decision`, `enrichment`, `scored`, `ai_classified`, `ai_fallback`, `conflict_detected`,
`banded`, `assigned`, `odoo_upserted`, `stage_changed`, `message_sent`, `message_suppressed`,
`job_scheduled`, `job_cancelled`, `sla_breached`, `approval_requested`, `approval_decided`, `error`,
`replayed`.

### "Why did this lead get this result?"

Filter `lp_audit` by `lead_uid` and read top to bottom. A real trace:

```
intake_received    accepted            source website, ref sub_99700694_k2p1af
scored             qualified (auto)    87 · company_size 51-200 +16 · industry target +15
                                       · market core +10 · service high +25 · urgency immediate +10
                                       · completeness both +6 · source website +5 · budget unknown +0
ai_classified      high (0.82)         "400 shipments a day, re-typing into three systems"
odoo_upserted      create #52 -> Qualified   owner sales-01 rung 1, load 0/8,
                                       team sales-01:0/8 sales-02:1/8 sales-03:0/6
message_sent       sent: confirm_qualified   intended_to lead@..., actual_to operator@..., redirected
job_scheduled      followup step 1     due +3600s
job_scheduled      sla                 due +1800s
```

Every number in the score is there by name. Every routing decision carries the state of the whole
team at the moment it was made, so the decision can be understood later without re-running the
picker against a table that has since moved.

### The operational summary

Daily at 08:00 by email, and on demand as JSON at `POST /webhook/lp-ops`: processed, qualified, VIP,
nurture, unqualified, duplicates, manual review, failed, SLA breached, dead letters open and
replayed. Internal fields are stripped from the public JSON.

### Alerting

Alerts go out when a human can act: credential death (immediately, at critical), a lead nobody can
be assigned to, an SLA breach, and a dead letter that keeps recurring. Deliberately **not** alerted:
a single transient failure that the retry absorbed, and a permanent failure already parked in the
queue.

---

## 11. Testing approach

Three layers, and the top one is the only one that proves anything about the deployed system.

### Unit — 194 assertions, no network, ~1 second

`node scripts/test-scoring.js` (61), `node scripts/test-intake.js` (97) and
`node scripts/test-errors.js` (36) run the **same source** the Code nodes run: the shared runtime is
concatenated into each node at build time, so there is no hand-copied logic to drift away from its
tests.

That guarantee only covers code that actually lives in the shared runtime, which is why
`test-errors.js` exists. The error classifier was written inline in LP-05's Code node, outside the
prelude and therefore outside every test — and it shipped with a pattern that never matched n8n's own
`Task request timed out after 60 seconds`, so the most retryable failure the instance produces was
classified `permanent`. It misclassified two real failures before anyone noticed. The classifier now
sits in `_shared/constants.js` beside the scorer and the intake, for the same reason they are there.

They cover phone and email normalisation, three-valued consent, the four validation outcomes,
idempotency keys (delivery versus person), service and urgency and budget derivation, CSV parsing
including hostile input, scoring and banding, conflict detection, assignment rungs, and backoff.

Three real bugs these caught before deployment, listed because a test suite's value is what it
found, not how many assertions it has:

- **`/\bautomat\b/` matches nothing.** Every service and urgency pattern built on a word stem was
  dead, so every lead scored `service: unknown`. `"automation"` has no word boundary after
  `automat`.
- **A cross-module field-name mismatch.** The scorer read `stated_urgency`; intake produced
  `urgency`. A missing field is a legal "unknown", so real leads silently scored as though they had
  stated neither. Only a test running both modules together could see it.
- **The backoff cap that was not a cap** - jitter applied after clamping. One sample passed, 2,000
  did not.

### Integration — 15 cases against the live pipeline

`node 05_Test_Evidence/run-edge-cases.mjs` fires all fourteen mandated edge cases plus business
rule 7 at the real deployment and asserts on **observable outcomes**: a row in Odoo queried directly
over JSON-RPC, a state in the ledger, a cancelled job. Never on "the workflow finished without
erroring", which on this stack is not evidence of anything.

Latest run: **15 passed, 0 failed**, from a clean slate - tables recreated, a fresh Odoo sandbox
provisioned by LP-00 minutes earlier. Output in
[../05_Test_Evidence/last-run.json](../05_Test_Evidence/last-run.json), matrix in
[../05_Test_Evidence/EDGE-CASES.md](../05_Test_Evidence/EDGE-CASES.md).

Two properties worth naming:

**Failures are reproducible on demand**, through two narrow hooks: `enrich_chaos` (a config row
appended to the enrichment URL: `?fail=timeout&times=2`) and `POST /webhook/lp-tick` (runs the
scheduler now). A thirty-minute SLA is demonstrated in seconds. Neither hook exists on any path a
real lead takes.

**Identities are run-unique.** With fixed phone numbers, a lead from a previous run was still in
Odoo, the new lead merged into *it*, and the dedupe assertion passed without this run having created
anything. A test that passes for the wrong reason is worse than one that fails.

### Hardening — 32 checks against the live pipeline

`node 05_Test_Evidence/run-hardening.mjs`. The fourteen mandated cases all send a **well-formed,
authenticated request** and then check that the pipeline did the clever thing. None of them asks
what happens when the request itself is wrong, hostile or enormous, and in production that is most
of the traffic. So this suite attacks the contract instead of the logic: authentication on all
twelve endpoints, malformed and empty bodies, unknown event types, unknown leads, a second
contradictory approval, a WhatsApp status callback, excluded verticals, job-seeker text, disposable
inboxes, **Arabic input**, nurture and qualified cadences, a 50 KB message, injection strings, an
over-cap CSV, BOM and CRLF and quoted commas, four refusal paths on replay, the public metrics
payload, audit-trail completeness, and a sweep of every workflow's errored executions.

It found four defects, none of them reachable from the fourteen. Details:
[../05_Test_Evidence/HARDENING.md](../05_Test_Evidence/HARDENING.md).

### Manual — [../05_Test_Evidence/MANUAL-STEPS.md](../05_Test_Evidence/MANUAL-STEPS.md)

The handful of things a script should not assert: that the confirmation email actually arrives and
reads correctly, that the Odoo kanban shows the funnel moving, that the manager approval email is
usable on a phone.

### What the tests found that the workflows did not

Worth stating, because it is the argument for testing at this layer at all:

- **An opt-out was acknowledged before it was applied.** LP-06 answered `200` from a branch running
  parallel to its writes, so the response meant *accepted*, not *applied* - and a tick firing inside
  that few-hundred-millisecond gap read the lead as still consenting and sent the follow-up. In a
  system whose entire premise is that this cannot happen. It survived several green runs because the
  window only opens when the instance is under load. The lead write is now in front of the response.
- A **merge was overwriting the survivor's external key**, which would have made a later replay
  create the exact duplicate the merge existed to prevent. Found by reading Odoo, not by an
  execution status.
- **`crm.lead.mobile` does not exist** on this Odoo version. The duplicate search referenced it,
  Odoo answered "Invalid field", the gateway correctly classified it permanent, and LP-03 correctly
  refused to create a lead it could not de-duplicate. The system behaved perfectly and the feature
  was still broken.
- **A Data Table read runs once per input item**, so the owner-health branch ran four times over -
  four reassignments of the same lead, four Odoo writes, and every salesperson's workload counted
  at four times its real value, which pushed the team over capacity and dropped assignment to the
  fallback rung. Found by reading four identical audit rows.
- **The manager was the default owner of everything**, because the fallback owner sat in the normal
  rotation with capacity 50 and every service category. Found on the first clean-slate run, when an
  idle roster made the tie-break visible.
- **Arabic input scored 20 points low, silently.** `\b` is defined by `\w`, and in a non-unicode
  JavaScript regex an Arabic letter is not a word character - so `/\bأتمتة/` matches nothing, ever.
  The Arabic terms were inside the same `\b(...)` group as the English ones, so every Arabic
  enquiry got `service: unknown` and no urgency. For an Egypt-facing business that is most of the
  inbound, landing a band too low. Nothing but a test written in Arabic could have seen it.
- **The ops report timed out** once the tables had real data: five chained Data Table reads, each
  running once per input item, is a combinatorial explosion. It passed every earlier test because
  the tables were nearly empty - the shape of bug that takes a daily email down a month later and
  is noticed by nobody.
- **A second, contradictory approval overwrote the first**, because the claim that should have
  stopped it is written after the response and two clicks can both read "no claim yet". A manager's
  rejection could be undone by a stale link in the same email.
- **The database schema and the code had drifted apart, and had for the whole project.** The column
  list lived in `constants.js` *and* in `create-tables.js`, and the second copy still named
  `stated_urgency` and `stated_budget` - retired weeks earlier. The real table carried two dead
  columns and two missing ones. Nothing failed, because writing to a column that does not exist is
  only an error if something writes to it. The moment something did, **every lead failed to store**.
  Fixed at the root: one typed definition, `create-tables.js` derives from it, and a hardening check
  reads the live tables back and compares them column by column.

---

## 12. Known limitations and next improvements

Honest list. Roughly in the order they would break something.

### Limits of the state store

**No unique constraint, so the claim is read-then-insert.** Two *simultaneous* claims of one key
could both succeed (§7). Mitigated by search-before-create against Odoo, which is a real uniqueness
check. **Fix:** Postgres with a unique index on `(idem_key, scope)`, or Redis `SETNX`. One node's
change in LP-03.

**A 250-row page ceiling on reads.** Workload counting reads active leads on every routed lead, so
past ~250 concurrently active leads the count silently truncates and load-balancing degrades.
**Fix:** a `GROUP BY owner_id` query, which means a real database - or go back to a stored counter
*with* a decrement on every terminal path. Threshold is a few hundred active leads.

**Immutable schemas and no DELETE through the API.** Adding a column means recreating the table and
losing its rows; nothing can be deleted, only appended or replaced. Fine for an append-only audit
log, awkward for `lp_jobs`, which accumulates completed rows forever. **Fix:** a monthly archive
sub-workflow, or Postgres.

### Sub-second concurrent arrivals can create two opportunities

Duplicate detection is a search against Odoo, so there is nothing to match until the first lead has
actually been written there - a window of five to fifteen seconds while it enriches and calls the
model. Two submissions from the same person *inside that window* are both correctly judged new.

The mandated edge case is "within 2 minutes" and that works, tested. But it is a real gap and it is
not the one the test covers. **Fix:** claim `person:<person_key>` before the Odoo search; a lead
that loses the claim schedules a `recheck_duplicate` job for 60 seconds later and re-enters LP-03.
The tick already drains due jobs, so this is one new job type - roughly six nodes. Not done because
it adds a failure mode (a lost claim stalls a lead) that needs its own tests, and the two-day budget
was better spent proving the fourteen cases actually pass.

### The enrichment provider is a lookup table

A nine-domain directory in LP-99. The brief permits a lookup table, and the *interface* is a real
HTTP call with real timeouts and retries - so pointing `enrich_url` at Clearbit or Apollo is a
config change. But no real enrichment has been exercised, and a real provider will bring rate
limits, partial matches and fuzzy company names that this has never seen.

### The Odoo sandbox expires

`demo.odoo.com` databases live a few hours. Mitigated by design - the endpoint is configuration, and
re-running LP-00 takes seconds - but a reviewer coming back tomorrow must re-run setup. A permanent
Odoo needs a Custom plan, whose external API this build has never been tested against (only the
sandbox and the documented restrictions).

### Scoring weights are asserted, not learned

The eight factors and their points are a considered guess, tuned so that plausible leads land in
plausible bands. No outcome data exists to validate them. **Fix:** log score against actual
conversion for a quarter, then fit. The architecture supports this already - every contribution is
in `lp_audit` by name and by points, which is most of the work.

### The AI layer is one model, one prompt

No cross-checking, no second opinion, no drift detection. `ai_confidence` is the model's
self-report, which is not a calibrated probability, and the conflict threshold of 0.7 is set against
that uncalibrated number. It works because the model contributes zero points - a bad classification
costs a manual review, never a wrong route.

### Business-hours gating is one timezone

`Africa/Cairo`, hardcoded in the tick. A lead in Dubai gets a follow-up at 08:00 their time. **Fix:**
derive the window from the lead's country, which is already on the record. Small, not done.

### No inbound reply parsing

`POST /webhook/lp-event {"type":"reply"}` must be called by something. Wiring an IMAP watcher or the
Gmail push API into it is a half-day, and until then a customer replying by email does not
automatically stop their sequence - a human forwards it or calls the endpoint. This is the largest
functional gap in the follow-up engine and it is deliberate: reply detection done badly (matching on
subject lines, mis-attributing auto-responders) stops sequences for the wrong leads, which is worse
than not having it.

### Not built, and why

- **Facebook and Instagram Lead Ads.** The brief names five sources and requires three. The two not
  built are both "one more normaliser feeding the same intake" - roughly an hour each once the app
  review is done, and the app review is not a same-day thing.
- **A UI.** Approvals are an email link and a webhook; manual review is an Odoo stage. A real
  deployment would want a queue view. Odoo's own kanban is doing that job here.
- **Multi-currency.** Budget bands are USD. A lead stating EGP is read as USD and scores wrongly.

### If this were going to production on Monday

In order: (1) move `lp_idem` to Postgres for the unique constraint, (2) wire real reply detection,
(3) replace the enrichment mock with a real provider and handle its rate limits, (4) a synthetic
canary lead every hour that alerts if it does not reach Odoo within two minutes - because the one
failure mode this whole architecture cannot see is the pipeline being silently stopped, and
`active: true` will not tell you.
