# Error Handling Strategy

Deliverable 6: retry, idempotency and manual reprocessing, in operational detail. The design
rationale is §7 and §8 of [DESIGN.md](DESIGN.md); this is the runbook.

---

## The premise

Two things this instance taught before the project started, both of which shape everything below:

**`active: true` is not evidence.** A workflow whose credential has died keeps reporting active and
keeps firing on schedule. Every run errors on its first node. This has happened five times here, and
one of them went unnoticed for thirteen days.

**`status: success` is not evidence either.** A node carrying `onError: continueRegularOutput`
swallows a 401 exactly like an expected empty result, so the execution is logged successful and
nothing alerts. One workflow failed every write for about twenty-five days that way; the only signal
that existed was at the destination.

So: **verify at the destination, classify before retrying, and make the failure state itself
queryable.**

---

## 1. Classification comes first

Retrying the wrong class of failure is worse than not retrying it - a dead credential retried three
times is three times the log noise and zero times the fix.

| Class | Recognised by | Retry? | Alert? |
|---|---|---|---|
| **transient** | timeout, socket reset, 408, 425, 429, 500, 502, 503, 504 | yes, bounded | only if it survives the retries |
| **credential** | 401, 403, `invalid_grant`, "session expired", "access denied" | **never** | **immediately, severity critical** |
| **permanent** | 400, 404, 422, "Invalid field", schema violation | no | only if it recurs |

Credential death is escalated on sight because it is the one failure that is total, silent and
un-self-healing. Everything the pipeline does through that credential is failing right now, and no
amount of retrying will change that.

`Retry-After` is honoured when a 429 supplies it.

### The Odoo-specific trap

`POST /jsonrpc` answers **HTTP 200 on failure** - the error is in the body:

```json
{ "jsonrpc": "2.0", "id": 1,
  "error": { "code": 200, "message": "Odoo Server Error",
             "data": { "name": "odoo.exceptions.ValidationError", "message": "Invalid field ..." } } }
```

An HTTP-status-based error check sees `200` and calls it a success. LP-90 parses the body, reads
`error.data.name` and `error.data.message`, classifies from those, and returns a uniform
`{ok, result, error, error_class}` to every caller. This is the main reason a gateway exists at all.

---

## 2. Retry

```
max attempts   3
base           500 ms
growth         exponential, x2
jitter         +/- 25%
cap            8000 ms, applied LAST
```

**Clamping last is not a detail.** The obvious ordering - cap, then jitter - returns up to 10s from
an "8s cap", so the cap is not a cap. One sample passes; the unit test takes 2,000 samples, and 2,000
did not.

The cap is 8 seconds rather than 60 because LP-90 is called with `waitForSubWorkflow`: a long
backoff holds the caller open and can blow a webhook response window. Every path is bounded by
attempt count **and** by total elapsed time, so no path can loop forever - which is the brief's
"sensible limits and backoff rather than infinite retry loops".

Enrichment is the one call that is allowed to fail quietly: `retryOnFail` 3 ×, 8-second timeout, and
`onError: continueRegularOutput`, so a dead enrichment provider costs precision and never a lead. A
miss is a legitimate answer - most WhatsApp leads have no domain to enrich - and the scorer prices
`unknown` accordingly.

---

## 3. Idempotency

Full rationale in [DESIGN.md §7](DESIGN.md#7-idempotency-strategy). The operational shape:

```
1  derive a deterministic key
2  claim it in lp_idem  (state = claimed)      ← BEFORE the side effect
3  do the side effect
4  flip to done, with a result_ref             ← the Odoo id, the message id
```

A crash between 2 and 3 leaves a `claimed` row. **That is the informative state**: it means
something may have happened out there and we never heard back. Two mechanisms act on it - the tick
dead-letters claims older than ten minutes, and the replay path searches Odoo by `x_lp_lead_id`
before doing anything, finds whatever did get created, and repairs the ledger rather than creating a
second record.

| Scope | Key | Protects against |
|---|---|---|
| `intake` | provider id, else a content hash | a webhook delivered twice |
| `odoo_upsert` | `odoo_upsert:<lead_uid>` | a duplicate CRM record |
| `message` | `message:<lead_uid>:<template>:<step>` | the customer getting the same message twice |
| `booking` | `booking:<booking_id>` | a booking webhook delivered twice |
| `approval` | `approval:<lead_uid>` | a decision applied twice |

### The honest weakness

Claiming is read-then-insert, not an atomic upsert, because n8n Data Tables have no unique
constraint. Two *simultaneous* claims of one key could both succeed.

Why that is acceptable here, stated rather than hidden: the window is milliseconds; webhook sources
retry after seconds, not microseconds; and the expensive irreversible action behind the claim - the
Odoo write - is **additionally** protected by a search-before-create on `x_lp_lead_id`, which is a
real uniqueness check against the system of record. The ledger is the fast path; Odoo is the
backstop.

The fix, if this needed to be airtight: a store with a unique index. Postgres with
`UNIQUE (idem_key, scope)`, or Redis `SETNX`. One node's change inside LP-03.

---

## 4. The dead-letter queue

Every failure - from any workflow, via the error trigger - becomes an `lp_dlq` row:

```
dlq_id  lead_uid  stage_failed  error_class  error
payload_json  attempts  state  first_seen  last_seen
```

`dlq_id` is **stable across recurrences**, derived from `workflow | node | digit-normalised message |
lead`. Normalising digits out of the message is what collapses `timeout after 8017ms` and `timeout
after 8123ms` into one dead letter. A failure happening every five minutes is therefore one row with
a rising attempt count, not 288 rows a day - which is the difference between a queue an operator
reads and a queue an operator mutes.

`payload_json` carries enough to replay: the lead, the original input, and for a quarantined CSV row
its **original text**, so the fix is edit-and-replay rather than "1 row failed, good luck".

States: `open` → `replayed` | `closed`, plus `quarantined` for validation failures that were never
really errors.

### Alerting

Alerts fire when a human can act:

- credential death - immediately, at critical
- a lead nobody can be assigned to
- an SLA breach
- a dead letter that keeps recurring

Deliberately **not** alerted: a single transient failure the retry absorbed, and a permanent failure
already parked in the queue. An alert stream that includes things nobody acts on stops being read,
and then the credential-death alert is lost in it too.

The alert send itself carries `onError: continueErrorOutput` into a `Log Undelivered Alert` node, so
a failure to alert is recorded rather than swallowed. An alerting path that can fail silently is not
an alerting path.

---

## 5. Manual reprocessing

```bash
curl -X POST $N8N/webhook/lp-replay -H "X-LP-Token: $LP_WEBHOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"dlq_id":"dlq-ac72409375a1c9"}'
```

With a correction - this is how a corrupted CSV row is fixed:

```bash
  -d '{"dlq_id":"qe-9bfe7a2af0ab",
       "override_json":{"email":"real@company.com","phone":"+201012345678"}}'
```

What happens, in order:

1. Load the dead letter.
2. **Read `lp_idem` for this lead** - what has already completed?
3. Read the lead record; set `odoo_already_created` from the ledger, not from a guess.
4. Re-dispatch **only the missing steps**, and report which ones were skipped.
5. Mark the dead letter `replayed`.

The response is explicit about what it did not do:

```json
{ "ok": true, "dlq_id": "dlq-ec14-99964129",
  "odoo_already_created": true,
  "skipped": ["odoo_upsert", "message"],
  "replaying": ["followup_schedule"] }
```

**Safety comes from the ledger, not from the operator being careful.** Replaying the same dead
letter ten times produces the same outcome as replaying it once. That is edge case 14, and the test
asserts the Odoo opportunity count is unchanged at 1.

---

## 6. Self-healing, without a human

LP-04's tick repairs three failure modes on a five-minute cycle:

| Condition | Detected by | Action |
|---|---|---|
| A job stuck in-flight | `state=inflight` for > 15 min | requeue; three strikes and it is dead-lettered |
| A crash between claim and act | `lp_idem` row `claimed` for > 10 min | dead-letter it for the reconciler |
| A salesperson gone unavailable | owner-health scan | reassign their active leads, write it to Odoo too |

The third is the one nothing else would catch. A salesperson going on leave **errors nothing** -
there is no failed execution, no red node, no alert. Their leads simply sit there while the SLA
quietly passes, and the first sign of trouble is a customer who never heard back.

---

## 7. The six scenarios the brief names

| Scenario | Handling | Tested by |
|---|---|---|
| **API timeout** | 8s timeout, 3 tries, bounded backoff, then dead-letter | EC-3 |
| **Rate limit** | classified transient, honours `Retry-After`, capped backoff | EC-6 |
| **Invalid response** | schema-validated; unusable → deterministic fallback, `ai_status: unavailable` | EC-4 |
| **Unavailable service** | `continueRegularOutput` on enrichment - precision degrades, the lead does not | EC-3 |
| **Malformed payload** | per-row validation and quarantine, with the original text kept | EC-13 |
| **Missing credentials** | 401 → permanent + critical, **never retried**, alert immediately | `?fail=401` on any mock |

---

## 8. What is still weak

Named because a strategy document that only lists strengths is a brochure.

- **No unique constraint on the claim** (above). Mitigated by search-before-create.
- **No circuit breaker.** If Odoo is down for an hour, every lead spends its full retry budget
  before dead-lettering. A breaker that trips after N consecutive failures and parks work directly
  in the queue would be kinder to both systems.
- **No poison-message cap.** A dead letter can be replayed indefinitely. `attempts` is recorded but
  nothing refuses at, say, ten.
- **The pipeline cannot see itself stop.** Every mechanism here catches a failure that *happens*.
  None of them catch the pipeline being silently disabled - and `active: true` will not tell you.
  The fix is a synthetic canary lead every hour that alerts if it does not reach Odoo within two
  minutes, and it is the first thing this design would gain before running in production.
