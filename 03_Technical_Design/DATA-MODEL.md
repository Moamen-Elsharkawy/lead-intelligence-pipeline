# Data Model

Deliverable 4. The canonical lead schema, the eight state tables, and what the pipeline writes into
Odoo.

Source of truth: [`02_Workflows/_shared/constants.js`](../02_Workflows/_shared/constants.js). It is
concatenated into every Code node at build time, so the schema below and the running code cannot
drift apart.

---

## 1. The canonical lead

Every source is normalised into exactly this shape before anything else looks at it. Three
normaliser nodes map field names; **no per-source logic exists downstream of them.**

### Identity

| Field | Type | Notes |
|---|---|---|
| `lead_uid` | string | `LP-<yyyymmdd>-<8 hex>`, derived from the idempotency key so a replay of the same event rebuilds the same id |
| `source` | string | `website` · `whatsapp` · `csv_import` |
| `source_ref` | string | The provider's own id when there is one: `wamid`, `submission_id`, `batch:line` |
| `received_at` | number | Epoch **seconds** |

### The person

| Field | Type | Notes |
|---|---|---|
| `full_name` | string | Control characters stripped, whitespace collapsed, capped |
| `email_raw` | string | Exactly as submitted, for display and for the reply-to |
| `email_norm` | string | Lowercased; Gmail dots and `+tags` folded, so `a.b+lead@gmail.com` and `ab@gmail.com` are one inbox |
| `phone_raw` | string | Exactly as submitted |
| `phone_e164` | string | `+<cc><national>` |
| `phone_key` | string | **Digits only, trailing 10.** The comparison key |
| `country` | string | ISO-2. Stated if given, otherwise derived from the E.164 prefix |
| `company` | string | |
| `domain` | string | From `email_norm`, **blank for free providers** - `gmail.com` is not a company |

**`phone_key` is the identity spine.** Ported from a parser that deduplicated 23,500 real contacts
down to 12,866. The trailing-10 rule is what makes `01012345678`, `+201012345678` and
`0020 101 234 5678` one person, and it survives the fact that people write their own number four
different ways.

**Country is resolved before phone**, because a stated country picks the dialling code for a
local-format number. Getting that order wrong sends every UAE lead to Egypt.

### Intent

| Field | Type | Notes |
|---|---|---|
| `service_interest` | string | `automation` · `ai_agent` · `rag` · `integration` · `custom_app` · `consulting` · `audit` · `training` · `unknown`. Matched from the stated field **and** the free text |
| `free_text` | string | The "what do you need" blob. The only thing the AI reads |
| `urgency` | string | `immediate` · `this_quarter` · `exploring` · `unknown`, matched from the text in English and Arabic |
| `budget_band` | string | `high` (≥ $5,000) · `mid` (≥ $1,000) · `unknown` |

The budget thresholds live in `C.BUDGET_USD`, **defined once**. They were briefly defined twice -
intake banding an amount against one pair of numbers and the scorer against another - so the same
lead could score differently depending on which path it arrived by. A threshold with two homes is a
threshold that will disagree with itself.

### Consent

| Field | Type | Notes |
|---|---|---|
| `consent` | string | `granted` · `denied` · `unknown` |
| `consent_source` | string | `form_checkbox` · `inbound_initiated` · `import_attested` |

**Three-valued on purpose.** A missing checkbox is not a refusal and it is not permission; it is
`unknown`, which routes to Data Completion. Collapsing it to a boolean means either mailing people
who never agreed or discarding leads who simply were not asked.

`inbound_initiated` is WhatsApp: someone who messages your business number has started a
conversation, which is a different legal basis from a ticked box, and worth recording as such.
`import_attested` is the importer stating they have a lawful basis - recorded per lead, because
"where did consent come from" is a question that gets asked after the fact.

### Qualification, routing, lifecycle

| Field | Type | Notes |
|---|---|---|
| `score` | number | 0-100, deterministic |
| `score_breakdown_json` | string | Every factor, value, points and note. The reason a score is defensible |
| `band` | string | `vip` · `qualified` · `nurture` · `unqualified` · `data_completion` · `manual_review` |
| `ai_status` | string | `ok` · `unavailable` · `skipped` |
| `ai_intent` / `ai_urgency` / `ai_signals` / `ai_reason` / `ai_confidence` | | The model's separate reading. **Worth zero points** |
| `owner_id` | string | Into `lp_agents` |
| `assign_rung` | number | 1, 2 or 3. Which fallback rung made the call |
| `odoo_lead_id` | number | `crm.lead.id` |
| `odoo_stage` | string | Last stage written |
| `approval_state` | string | `not_required` · `pending` · `approved` · `rejected` |
| `approval_by` | string | |
| `status` | string | `active` · `merged` · `closed` |
| `merged_into` | string | The `lead_uid` of the survivor, when this one lost a de-duplication |
| `raw_json` | string | The original payload. A replay can prove what actually arrived |
| `updated_at` | number | Epoch seconds |

### Validation outcomes

Four states, four different consequences. Critical fields are `full_name`, `contactable`, `consent`;
`contactable` is satisfied by **either** a valid email **or** a valid phone.

| State | Condition | Consequence |
|---|---|---|
| `ok` | nothing missing | continue |
| `incomplete` | a critical field missing, but contactable | **Data Completion** stage - a real lead, not a failure |
| `unusable` | no valid email and no valid phone | quarantined - literally nothing can be done with it |
| `parse_error` | the row is not a row | quarantined with its original text, for edit-and-replay |

`service_interest` is deliberately **not** critical. It is recoverable from free text and from the
first conversation, and making it critical sent most WhatsApp leads to a human for no reason.

---

## 2. State: eight `lp_*` Data Tables

Columns are `string | number | boolean | date` only - no JSON column, so payloads are stored as JSON
strings. **Schemas are immutable** through the n8n API, so a missed column means dropping and
recreating the table, which is why they are declared in full in `C.TABLES` and created by
`scripts/create-tables.js`.

Timestamps are epoch **seconds in number columns**, because numeric comparison in the Data Table
filter operators is what the tick's `due_at <= now` claim depends on. A date string would sort
lexically and quietly break the queue.

### `lp_lead` — the registry

Every field above. One row per lead, updated in place.

`urgency` and `budget_band` were **missing from the table** while being present in the canonical
lead and used by the scorer - so this document described a row the database did not have. Caught by
a hardening check that asserted on them and read `undefined`. They are stored now. The lesson worth
keeping: a data-model document is only true if something executable checks it.

Partial upserts **merge** on this API rather than replacing, which is why nodes that touch one or
two fields (the tick's reassignment, an event's status change) do not need to restate the whole row.

### `lp_idem` — the claim ledger

The spine of the whole design.

| Column | Notes |
|---|---|
| `idem_key` | the deterministic key |
| `scope` | `intake` · `odoo_upsert` · `message` · `booking` · `approval` · `mock` |
| `lead_uid` | |
| `state` | `claimed` → `done` (or `failed`) |
| `result_ref` | the Odoo id, the provider message id - proof of what happened |
| `claimed_at` / `completed_at` / `attempts` | |

**A row stuck at `claimed` is the interesting state**: it means a side effect may have happened out
there and we never heard back. The tick dead-letters claims older than ten minutes, and the replay
path searches Odoo before acting. That is edge case 7.

`scope` is not decoration. Without it, a `continueRegularOutput` passthrough hands the *input* items
to a downstream filter, and an input item is a lead - which also carries an `idem_key`. Filtering on
`scope` as well as key is what keeps that from reading as a duplicate.

### `lp_person_index` — person key → lead

`person_key` (the phone key, else the normalised email), `lead_uid`, `email_norm`, `phone_key`,
`created_at`. Used for the name-and-company signals an Odoo search cannot express.

### `lp_jobs` — the due queue

`job_id`, `lead_uid`, `job_type` (`followup` · `sla`), `step`, `template`, `due_at`, `state`
(`pending` · `inflight` · `sent` · `cancelled` · `failed`), `attempts`, `claimed_at`, `result`,
`cancel_reason`.

Rows, not `Wait` nodes. A held-open `Wait` cannot be cancelled cleanly, does not survive a restart,
and holds an execution slot for three days.

### `lp_agents` — the roster

`agent_id`, `name`, `email`, `services` (comma-separated), `capacity`, `open_leads`, `available`,
`odoo_user_id`.

**`open_leads` is vestigial and is not read.** Workload is counted live from `lp_lead`, because a
stored counter needs a decrement on every path that ends an assignment - closed, merged, opted out,
reassigned, rejected - and the first path anyone forgets leaves that salesperson permanently
"full". The seeded counters were in fact all still `0` after a full edge-case run, so sorting by
them was sorting by a column that never moved. The column is kept so the table shape matches what an
operator expects to see.

### `lp_audit` — the decision log

`event_id`, `lead_uid`, `ts`, `workflow`, `execution_id`, `type`, `decision`, `detail_json`.
Append-only. 22 event types.

This is the audit trail. n8n's execution log is not: it is pruned after 14 days, it is not queryable
by lead, and it holds no business meaning.

### `lp_dlq` — dead letters

`dlq_id`, `lead_uid`, `stage_failed`, `error_class`, `error`, `payload_json`, `attempts`, `state`
(`open` · `quarantined` · `replayed` · `closed`), `first_seen`, `last_seen`.

`dlq_id` is **stable across recurrences** - derived from `workflow | node | digit-normalised message
| lead` - so a failure happening every five minutes is one row with a rising attempt count rather
than 288 rows a day.

### `lp_config` — runtime configuration

`key`, `value`, `note`. Nine rows: `odoo_url`, `odoo_db`, `odoo_user`, `odoo_password`, `base_url`,
`manager_email`, `fallback_owner_id`, `ai_model`, `sla_seconds`, plus the two demo hooks
`demo_redirect_email` and `enrich_chaos`.

Exists because this instance runs with `N8N_BLOCK_ENV_ACCESS_IN_NODE=true`, so `$env` throws inside
a Code node, and `$vars` is licence-gated. It turned out better than environment variables: values
are visible and editable in the same UI as the workflows, and LP-00 writes them, so provisioning is
one action.

---

## 3. What is written to Odoo

Model `crm.lead`, plus `crm.stage` for the funnel and `res.users` for ownership.

| Odoo field | Written from |
|---|---|
| `name` | `"<company or full_name> - <service_interest>"` |
| `contact_name` | `full_name` |
| `email_from` | `email_raw` |
| `phone` | `phone_e164` |
| `partner_name` | `company` |
| `description` | score, breakdown, band, AI reading, source, next action - the human-readable "why" |
| `stage_id` | from `C.STAGE_TRANSITIONS` |
| `user_id` | the assigned agent's `odoo_user_id` |
| `active` / `probability` | `false` / `0` on a close |
| **`x_lp_lead_id`** | **`lead_uid`. The external reference that makes the write idempotent** |

`x_lp_lead_id` is created by LP-00 as an `ir.model.fields` record. It is what "create/update the CRM
record without creating duplicates" actually rests on: the search-before-create runs against it, so
it is a real uniqueness check against the system of record rather than a promise the pipeline makes
to itself.

**Every field above was verified against `ir.model.fields` on the live database**, not assumed.
`crm.lead.mobile` does not exist on saas~19.3 - the duplicate search referenced it, Odoo answered
"Invalid field", and LP-03 correctly refused to create a lead it could not de-duplicate. The system
behaved perfectly and the feature was still broken, which is the argument for checking rather than
assuming.

### Stages

Odoo ships with New, Qualified, Proposition, Won. LP-00 creates the five it does not:

| Stage | Sequence | Reached when |
|---|---|---|
| Data Completion | 5 | a critical field is missing |
| Manual Review | 6 | ambiguous duplicate, or a material AI/rules conflict |
| Awaiting Approval | 7 | VIP, before any outbound |
| Nurture | 8 | score 40-69 |
| Meeting Booked | 30 | a booking event |

**Lost is not a stage.** In Odoo it is `active=false` + `probability=0` + a lost reason. Modelling
it as a stage gives you a pipeline column full of corpses - and it is why every duplicate search
passes `active_test: false`, because without it a previously-lost lead is invisible and gets created
again.
