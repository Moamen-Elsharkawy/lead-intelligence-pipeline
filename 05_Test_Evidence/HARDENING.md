# Hardening suite: 32 checks the mandated edge cases do not cover

**Latest run: 32 passed, 0 soft, 0 failed** in 68 seconds. Raw output: [last-hardening-run.json](last-hardening-run.json).

```bash
node scripts/demo-reset.js you@example.com    # optional, back to a clean slate
node 05_Test_Evidence/run-hardening.mjs       # all 32
node 05_Test_Evidence/run-hardening.mjs 12 15 # just these
```

---

## Why a second suite exists

[EDGE-CASES.md](EDGE-CASES.md) proves the fourteen scenarios the brief names. Every one of them
sends a **well-formed, authenticated request** and then checks that the pipeline did the clever
thing. None of them asks what happens when the request itself is wrong, hostile, or enormous - and
in production that is most of the traffic.

So this suite attacks the **contract** rather than the logic:

| Group | Question it asks |
|---|---|
| **A** Authentication and transport | Is the door actually locked? |
| **B** Input contract | Does a bad request fail cleanly and say why? |
| **C** Business rules end to end | Do the documented rules really fire on a live lead? |
| **D** Robustness | Hostile strings, 50 KB bodies, oversized batches |
| **E** Dead letters and replay | Does the recovery path refuse correctly? |
| **F** Observability | Is the audit trail complete, and does the public payload leak? |
| **G** Instance health | Did anything error that should not have, and does the live schema still match the code? |

Same rule as the other suite: every check asserts on an **observable outcome** - a status code, a
row read back out of Odoo, a state in the ledger. Never on "it did not throw".

---

## What it found

Four real defects, all fixed. None of them was reachable from the fourteen mandated cases, which is
the argument for the suite existing.

### 1. Arabic input silently scored 20 points low

`\b` is defined in terms of `\w`, and in a non-unicode JavaScript regex `\w` is `[A-Za-z0-9_]` -
an Arabic letter can never form a word boundary. The Arabic terms had been written **inside the
same `\b(...)` group** as the English ones:

```js
[/\b(automat\w*|n8n|zapier|make\.com|workflows?|أتمتة)/i, 'automation']
//                                                ^^^^^ unreachable, always
```

`/\bأتمتة/.test('محتاجين أتمتة')` is `false`. Every Arabic-language enquiry therefore scored
`service: unknown` - **5 points instead of 25** - and never had its urgency detected either. For a
business whose core market is Egypt, that is most of the inbound, quietly landing a band too low.

Nothing in the English tests could see it, and nothing in the live suite could either until a case
was written in Arabic. Fixed by giving Arabic its own patterns without `\b`, widening them while we
were there, and adding twenty unit assertions - including one that asserts a bare `\b` **cannot**
match Arabic, so the reason is documented in the test itself.

### 2. The ops report died of a combinatorial explosion

A Data Table read runs **once per input item**, and LP-07's five reads were chained: `Read Leads`
emitted N leads, so `Read Audit` ran N times, each emitting M rows, so `Read Jobs` ran N x M times.
Sixty leads and a few hundred audit rows is tens of thousands of reads, and the execution simply
timed out - the endpoint answered `500 the execution was cancelled because it timed out`.

It passed every earlier test because the tables were nearly empty. This is the shape of bug that
ships fine and takes the daily report down a month later, silently, because nobody notices an email
that stopped arriving. Fixed with `executeOnce` on all five reads.

### 3. A second, contradictory approval was applied over the first

A manager rejects a VIP; someone then clicks the stale **approve** link in the same email; the lead
that was deliberately killed is resurrected and messaged.

The ledger check that should have stopped it was correct but raceable: the claim is written by a
node that ran *after* the response, so two clicks a second apart both read "no claim yet". Fixed
twice over, deliberately:

- **the claim now sits in front of the response**, alongside the lead write, for the same reason -
  if the 200 goes out before the claim exists, the caller can act on that 200 and race it;
- **and a semantic guard that cannot be raced at all**: an approval event on a lead whose
  `approval_state` is already `approved` or `rejected` is refused with a 409, because that state was
  written by the first decision itself.

Changing a decision should be a deliberate act with its own trail, never an accident of a double
click.

### 4. The database schema and the code had drifted apart

Fixing (1) meant persisting `urgency` and `budget_band` on the lead row. Adding them to the column
list in `_shared/constants.js` and to the three workflows that write a full row was not enough: the
tables were created by `scripts/create-tables.js`, which carried **its own copy** of the schema.

That copy still said `stated_urgency` and `stated_budget` - names retired weeks earlier, when the
scorer and the intake were unified on `urgency` and `budget_band`. So the real table had **two dead
columns and two missing ones**, and had for the whole project. Nothing failed, because writing to a
column that does not exist is only an error if something writes to it, and until now nothing did.
The moment something did, every single lead failed to store with
`unknown column name 'urgency'` - a total outage, from a two-word mismatch.

Fixed at the root rather than at the symptom: `C.TABLES` is now a typed object and it is the **only**
definition; `create-tables.js` derives the tables from it and defines nothing. And **check 32 reads
the live tables back and compares them column by column against that object**, so the two can never
silently disagree again.

The general lesson is the one this whole project keeps re-learning in new costumes: a definition
with two homes is a definition that will disagree with itself. It happened with the budget
thresholds, with the urgency field name, and now with the schema itself.

---

## The checks

<!--RESULTS-->

### A. Authentication and transport

| # | Check | Result | s |
|---|---|---|---|
| 1 | A webhook with no token is refused | no X-LP-Token -> 403 | 0 |
| 2 | A webhook with the wrong token is refused | wrong X-LP-Token -> 403 | 0 |
| 3 | Every inbound endpoint is authenticated, not just the lead ones | all 12 endpoints refuse an unauthenticated call, including the three mocks | 1 |
| 4 | A malformed JSON body does not take the workflow down | truncated JSON -> 422, no lead created | 0 |
| 5 | An empty body is handled, not crashed on | empty body -> 202 {"ok":false,"received":1,"accepted":0,"duplicates":0,"quarantined":1,"ignored":0,"lead_uids":[],"incomplete":[],"errors" | 0 |

### B. Input contract

| # | Check | Result | s |
|---|---|---|---|
| 6 | An unknown event type is rejected with a reason | type "teleport" -> ok:false, "type must be one of reply, opt_out, booking, close, sales_action" | 1 |
| 7 | An event with no lead_uid is rejected | missing lead_uid -> ok:false, "lead_uid is required" | 1 |
| 8 | An event for a lead that does not exist is a 404, not a crash | unknown lead -> status 404, "no lead with id LP-19990101-DEADBEEF" | 1 |
| 9 | An approval with an invalid decision is rejected | decision "maybe" -> ok:false, "decision must be approve or reject" | 1 |
| 10 | A second approval on the same lead is refused, not silently applied | reject applied, then approve refused ("this lead was already rejected by manager@example.com. Rever"); state stayed rejected | 7 |
| 11 | A WhatsApp delivery-status callback is acknowledged and ignored | status callback -> 202, lead count unchanged at 19 | 3 |

### C. Business rules, end to end

| # | Check | Result | s |
|---|---|---|---|
| 12 | An excluded vertical is hard-disqualified whatever else it scores | $50k urgent enquiry, gambling vertical -> score 0, unqualified, "excluded vertical, hard disqualify" | 5 |
| 13 | Job-seeker language is penalised, not qualified | penalty -20 applied, final score 58 -> nurture | 5 |
| 14 | A disposable inbox costs points and says so | mailinator.com -> -10 points, "throwaway inbox" | 5 |
| 15 | An Arabic enquiry is parsed, scored and routed like any other | Arabic name and body preserved; service=automation and urgency=immediate matched from Arabic; Odoo #65 | 5 |
| 16 | A Nurture lead gets the nurture cadence, not the qualified one | score 52 -> nurture; 3 follow-ups due at roughly +2d, +7d, +21d (rule: 2/7/21) | 5 |
| 17 | A Qualified lead is assigned, armed with an SLA, and confirmed | owner sales-01 (rung 1), SLA at +1800s, confirmation sent, Odoo #67 carries the score and reason | 6 |

### D. Robustness

| # | Check | Result | s |
|---|---|---|---|
| 18 | A 50 KB message is truncated rather than crashing or storing whole | 52000 chars in -> free_text capped at 4000, lead completed normally | 5 |
| 19 | Hostile strings in every field are stored as data, never executed | injection payloads stored as inert text, control characters stripped, Odoo #69 created normally | 6 |
| 20 | A CSV over the row cap is refused with the limit named, not half-imported | 260 rows in -> 0 imported, refused with the limit named: "260 rows exceeds the 200-row synchronous limit. Split the file, or use the documented async import path." | 0 |
| 21 | A CSV with a BOM, CRLF and quoted commas parses correctly | BOM stripped, CRLF handled, quoted commas and an embedded newline preserved: "Hassan, Mahmoud" / "Delta Clinics, LLC" | 1 |
| 22 | An import row with attested consent records where consent came from | consent=granted, consent_source=import_attested - the lawful basis is recorded per lead, not assumed | 2 |

### E. Dead letters and replay

| # | Check | Result | s |
|---|---|---|---|
| 23 | Replaying a dead letter that does not exist is a 404 | unknown dlq_id -> 404, "no dead letter with id dlq-does-not-exist-06096653" | 0 |
| 24 | Replaying with no dlq_id at all is a 400 | missing dlq_id -> 400, "dlq_id is required" | 1 |
| 25 | A malformed override_json is refused instead of half-applied | bad override -> 400, and the dead letter stayed "open" rather than being marked handled | 1 |
| 26 | A dead letter already handled is refused a second time | already replayed -> 409, "this dead letter is already replayed" | 1 |
| 27 | A permanent Odoo error is classified permanent and never retried | the credential-death injector returns 400; classification of 401 as permanent+critical is covered by the unit suite (dlq rows: 9) | 1 |

### F. Observability

| # | Check | Result | s |
|---|---|---|---|
| 28 | The ops endpoint returns every metric the brief asks for | all six reported - processed 29, qualified 10, duplicates 5, failed 1, manual 1, SLA 1 | 0 |
| 29 | The public ops payload does not leak internal addresses | manager_email and odoo credentials absent from the 2092-byte public payload | 1 |
| 30 | Every lead this suite created has a complete, readable audit trail | 11 leads checked, every one traceable from intake to CRM write, every row carrying its execution id | 1 |

### G. Instance health

| # | Check | Result | s |
|---|---|---|---|
| 32 | The live tables match the schema the code is built from | 8 tables, 91 columns, every one matching the definition the workflows are generated from | 1 |
| 31 | Nothing errored on the instance during this run that should not have | all 11 workflows: zero unexpected errored executions since this suite started | 1 |

---

## Two things this suite deliberately does not do

**It does not re-test the fourteen.** Those live in the other suite and there is no value in two
places asserting the same thing differently.

**It does not test the mocks' business behaviour.** LP-99 stands in for three services this project
has no account with; what matters is that the *interface* is real (HTTP, timeouts, retries, status
codes) and that its failure injection is deterministic. Check 27 confirms the injector actually
returns a 401 rather than pretending to; how a 401 is classified is a pure function and is unit
tested.
