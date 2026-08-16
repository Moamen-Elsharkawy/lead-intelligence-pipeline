# Setup

From a bare n8n instance to a working pipeline. Takes about ten minutes, most of which is
creating three credentials by hand in the n8n UI.

Tested on **n8n 2.69.0** self-hosted. Node 18+ for the scripts.

---

## 1. The three credentials

These are the only manual steps, and they are manual because credential values must never be in a
repo. Create them in **n8n → Credentials → New**, with **exactly these names** - the deploy script
resolves names to ids and refuses to deploy if a name is missing.

### `LP Webhook Token (X-LP-Token)` — type *HTTP Header Auth*

| Field | Value |
|---|---|
| Name | `X-LP-Token` |
| Value | a long random string you generate |

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Every inbound webhook in the system checks this header. Put the same value in `.env` as
`LP_WEBHOOK_TOKEN`.

### `Gmail account` — type *Gmail OAuth2*

Standard n8n Gmail OAuth. Used for confirmations, follow-ups, manager alerts and the daily report.

Swap it for SMTP if you prefer: the only nodes that touch it are `Send Email` in LP-92 and the
alert/report senders in LP-05 and LP-07.

### `OpenRouter account` — type *OpenRouter API*

An OpenRouter key. The default model is `google/gemini-2.5-flash-lite`, changeable in `lp_config`
without touching a workflow.

**The pipeline runs without this one.** If the credential is missing or the key is dead, LP-02
records `ai_status: unavailable` and the lead completes on rules alone - that is edge case 4, and
it is tested.

---

## 2. Configure and deploy

```bash
cp 01_README/.env.example .env
# fill in N8N_API_URL, N8N_API_KEY, LP_WEBHOOK_TOKEN

node scripts/create-tables.js     # the eight lp_* data tables
node scripts/deploy.js            # all 11 workflows, pushed and published
```

`create-tables.js` prints what it created and is safe to re-run - it skips tables that already
exist. Data Table schemas are **immutable** through the n8n API (you can rename a table but not add
a column), so `--recreate` is the only way to change one, and it destroys the rows.

`deploy.js` does three things the n8n UI import does not:

- **Resolves `@Name` sub-workflow references to real ids.** Workflow ids are minted per instance, so
  importing these files by hand leaves every `Execute Sub-workflow` node pointing at nothing. The
  specs write `@LP-90 Odoo Gateway`; the script resolves it in a second pass once every workflow
  exists.
- **Resolves credential names to ids, and refuses to deploy an unknown name.** n8n silently binds a
  name-only credential reference to *some other credential of the same type*, which is a very quiet
  way to send your leads through the wrong account.
- **Publishes callees before callers.** A workflow cannot be published while a sub-workflow it calls
  is still unpublished.

## 3. Provision Odoo

```bash
curl -X POST https://<your-n8n>/webhook/lp-setup \
     -H "X-LP-Token: $LP_WEBHOOK_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"mode":"demo","manager_email":"you@example.com"}'
```

**`manager_email` is required and has no default.** It receives VIP approval requests,
unassignable-lead alerts and SLA escalations, and setup refuses to run without a real address -
because this repository is public, and an address baked into the committed file means a stranger
running setup quietly starts mailing someone who never agreed to receive it. Pass it in the body as
above, or set it once in LP-00's `Config` node.

**`base_url` needs nothing when you call the webhook.** Setup reads it from the request - the host
that just called you is the host you are - and writes it to `lp_config`, where every other workflow
picks it up to reach the mock services. It is only worth filling in the Config node if you run setup
from the **manual trigger**, which has no request to read, and setup will stop and say so.

Three modes, set in LP-00's `Config` node or overridden in the request body:

| Mode | What it does |
|---|---|
| `demo` | Provisions a throwaway database from **Odoo's own public sandbox** (`demo.odoo.com/start`, an endpoint in Odoo's External API documentation). No account, no card, real Odoo. Sandboxes expire after a few hours - re-run for a fresh one |
| `keep` | Reuses whatever is already in `lp_config` and just re-verifies the field, the stages and the roster. Re-running setup is safe, and this is the mode that lets you watch it be safe: the summary says "already present" and "none needed" |
| `manual` | Your own Odoo. Fill `odoo_url`, `odoo_db`, `odoo_user`, `odoo_password` in the Config node |

It responds with a summary:

```
Odoo:            https://demo4.odoo.com
Database:        demo_saas-193_cc4617160b1d_1786399678
Source:          demo sandbox
External ref:    x_lp_lead_id created
Stages created:  Data Completion, Manual Review, Awaiting Approval, Nurture, Meeting Booked
Agents seeded:   4
Config rows:     9
```

### Why a sandbox rather than a normal Odoo account

Odoo Online's **free and Standard plans block the external API** - their documentation states
access is available on Custom plans only, and names One App Free and Standard as excluded. Reads
often work anyway; writes are refused, and this pipeline is almost entirely writes. Self-hosting
was out of scope for a two-day build.

`demo.odoo.com/start` is Odoo's own documented provisioning endpoint. It returns a real Odoo
database over a real external API - the same JSON-RPC calls, the same models, the same permission
model. The full probe, including what does and does not work, is in
[05_Test_Evidence/odoo-api-probe.md](../05_Test_Evidence/odoo-api-probe.md).

The design turns the expiry into a non-issue by treating the Odoo endpoint as **configuration**
rather than an assumption: it lives in `lp_config`, every call goes through LP-90, and re-running
LP-00 takes seconds.

## 4. Before you run the test suite: the mail redirect

The edge-case suite creates leads at real-looking domains, and the pipeline sends real email. Set
one config row and no test lead can ever be written to:

```bash
# lp_config: key=demo_redirect_email  value=<your address>
```

Every lead-facing message is then delivered to that address with the intended recipient preserved
in the subject line and in the audit row (`intended_to`, `actual_to`, `redirected: true`). Manager
alerts are never redirected - they are internal by definition.

**The suite refuses to start if this row is missing.** That is deliberate: a safety net you have to
remember to switch on is not a safety net.

## 5. Verify

```bash
node scripts/test-scoring.js                  # 58 tests, no network
node scripts/test-intake.js                   # 97 tests, no network
node scripts/test-errors.js                   # 36 tests, no network
node 05_Test_Evidence/run-edge-cases.mjs      # 15 cases against the live pipeline
```

---

## Instance-specific things that will bite you

Collected while building this. All of them cost real time.

| | |
|---|---|
| **`active: true` is not evidence** | A workflow with a dead credential stays `active` and keeps firing on schedule; every run just errors on its first node. Verify at the destination |
| **Editing an active workflow saves a draft** | The version answering the webhook stays the old one until you deactivate and reactivate. `GET /workflows/:id` shows the draft, so it looks like the change landed. `deploy.js` handles this |
| **`$env` is blocked** | This instance runs with `N8N_BLOCK_ENV_ACCESS_IN_NODE=true`, and `$vars` is licence-gated. Hence the `lp_config` table |
| **Webhook path parameters do not register** | `lp-mock/:service` answered 404 while the workflow reported active. Three fixed paths instead |
| **Data Table API surface** | `GET /rows?filter=`, `POST /rows`, `POST /rows/upsert`. No PATCH, no PUT, **no DELETE**. `limit` is capped at 250 and a larger value is a 400, not a clamp. A read returns three columns the table does not have (`id`, `createdAt`, `updatedAt`) and sending them back is `400 unknown column name 'id'` |
| **A Data Table read runs once per input item** | Feed it four items and the entire downstream branch happens four times. Use `executeOnce` |
