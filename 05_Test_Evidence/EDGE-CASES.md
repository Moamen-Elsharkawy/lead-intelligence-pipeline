# Test Evidence: the fourteen mandated edge cases

**Latest run: 15 passed, 0 failed.** Run id `99964129`, instance `moamen.dsoqi.online`, 149 seconds.
Raw output: [last-run.json](last-run.json).

That run was from a **clean slate**: the eight data tables recreated, and a fresh Odoo sandbox
provisioned by LP-00 minutes earlier. Nothing was left over from a previous run to lean on.

Run it yourself:

```bash
node 05_Test_Evidence/run-edge-cases.mjs          # all 15
node 05_Test_Evidence/run-edge-cases.mjs 7 14     # just these
```

---

## What "PASS" means here

Every case asserts on an **observable outcome**: an opportunity read back out of Odoo over JSON-RPC,
a state in the idempotency ledger, a cancelled job row. Never on *the workflow finished without
erroring*, which on this stack is not evidence of anything - a node carrying
`onError: continueRegularOutput` swallows a dead-credential 401 exactly like an expected empty
result and the execution is logged successful.

Two design choices make the fourteen reproducible rather than anecdotal:

- **`enrich_chaos`** - a config row appended to the enrichment URL (`?fail=timeout&times=2`,
  `?fail=429`, `?fail=malformed`, `?fail=401`, `?reset=1`). The counter is real, stored in `lp_idem`
  under `scope='mock'`, so the third call genuinely behaves differently from the first two.
- **`POST /webhook/lp-tick`** - runs the five-minute scheduler now, so a 30-minute SLA or a
  three-day follow-up is demonstrated in seconds by winding a `due_at` back and ticking.

Neither hook exists on any path a real lead takes.

**Identities are run-unique**, derived from the clock. This is not tidiness. With fixed phone
numbers, a lead from a previous run was still in Odoo, this run's lead merged into *it*, and the
dedupe assertion passed without this run having created anything to dedupe against. That is a test
passing for the wrong reason, which is worse than a test failing.

**No test lead can be emailed.** The suite refuses to start unless `lp_config.demo_redirect_email`
is set; every lead-facing message then goes to the operator with the intended recipient preserved in
the subject line and in the audit row (`intended_to`, `actual_to`, `redirected: true`).

---

## The matrix

| # | Mandated edge case | Mechanism that handles it | Evidence from the run | s |
|---|---|---|---|---|
| **1** | Same lead from WhatsApp and the website within 2 minutes | Two keys: `idem_key` per delivery, `person_key` per human. Both deliveries accepted; the second resolves to a high-confidence duplicate and merges | Two deliveries (`LP-...164B5C1A`, `LP-...352D887B`), **one** Odoo opportunity **#61**; the second marked `merged`, and it owns **0** opportunities of its own | 13 |
| **2** | A valid phone in two different formats | `phoneKey()` - digits only, trailing 10 - applied before any comparison. Ported from a parser that deduped 23.5k real contacts | `"+20 10164129"` and `"002010164129"` both → `phone_key 2010164129`; the second merged into **#62** | 10 |
| **3** | Enrichment times out twice, then succeeds | `retryOnFail` 3 × bounded backoff, 8s timeout, `continueRegularOutput` so a dead provider costs precision not a lead | Chaos plan `?fail=timeout&times=2`; enrichment came back `ok`, lead scored **100**, reached Odoo **#63** | 5 |
| **4** | The AI returns an empty or malformed response | Schema validation on return, then a deterministic fallback. **The AI contributes zero points** | `ai_status=unavailable`, score still **100** (vip), Odoo **#64**. The fallback changed nothing, which is the point | 7 |
| **5** | AI says "high potential", the rules say low value | `materiallyConflicts`: confidence ≥ 0.7 **and** band distance ≥ 2. Adjacent disagreement is expected noise and is ignored | Rules **38** (unqualified), model **high @ 0.95** → `manual_review`, Odoo stage **"Manual Review"**. Neither side wins | 5 |
| **6** | The CRM API returns 429 Rate Limit | Classified transient, honours `Retry-After`, exponential backoff with jitter capped at 8s, max 3 tries | 429 absorbed, enrichment `ok`, lead scored 100 and reached Odoo **#66** in 5s | 5 |
| **7** | CRM create succeeded, the workflow timed out before the acknowledgement | The claim is written *before* the call, so a `claimed` row means "something may have happened". Replay searches Odoo by `x_lp_lead_id` before acting | Ledger rewound to `claimed` to simulate the lost ack; replay found the existing record → still exactly **1** opportunity (**#67**), ledger repaired to `done` with `result_ref 67` | 16 |
| **8** | A WhatsApp send is retried after a transient error | The send is claimed under `message:<lead_uid>:<template>:<step>` before dispatch. LP-92 is the only outbound path | 1 `message_sent`, 1 `message_suppressed` on the re-dispatch, reason `already sent, provider ref 19fedbd477525ce1` | 18 |
| **9** | A salesperson becomes unavailable after assignment | Nothing errors when someone goes on leave, which is the problem. The tick's owner-health scan finds their leads and reassigns | `sales-03` marked unavailable → tick reassigned `LP-...DD870AAF` to `mgr-01` (rung 3, the reps being at capacity), and wrote it to Odoo too | 8 |
| **10** | A lead opts out while a follow-up is already scheduled | Follow-ups are queue rows, not `Wait` nodes, so cancellation is a status update. The tick re-reads the stop conditions **immediately before sending** | Follow-up wound forward to due-now, opt-out fired, tick run: **4 jobs cancelled** (`opted_out`), `consent=denied`, **no follow-up sent**, Odoo `active=false` | 16 |
| **11** | A booking webhook is delivered twice | Claimed under `booking:<booking_id>` | Two deliveries of `bk_99964129_dup`: the first applied (stage **"Meeting Booked"**), the second answered `200 {duplicate: true}`; **1** audit event | 6 |
| **12** | A manager rejects a VIP after qualification | The VIP gate is a stage with no outbound. `awaiting_approval` and `approval_rejected` are two of LP-92's seven stop conditions | Before: stage **"Awaiting Approval"**, **no message reached the lead**. After reject: `status=closed`, 1 job cancelled, Odoo `active=false` | 13 |
| **13** | A corrupted CSV row inside an otherwise valid batch | A real state-machine CSV reader attaching errors **per row**; bad rows quarantined individually with their original text | 4 rows in → **2 imported**, **2 quarantined**: *"line 3: expected 8 columns, found 3"* and *"line 5: no valid email and no valid phone"*. Both dead letters carry the original row text, so the fix is edit-and-replay | 2 |
| **14** | A workflow is manually re-run after partial success | Replay reads the ledger first and re-dispatches only what is missing | Replay reported `odoo_already_created: true`, skipped `["odoo_upsert","message"]`, opportunity count **unchanged at 1** (**#75**); dead letter now `replayed` | 16 |
| **15** | *(business rule 7)* No sales action within the 30-minute SLA | An `sla` job armed at +1800s on every qualified assignment | Timer scheduled at **+1799s**; on breach: audit `sla_breached`, job `sent`, escalation raised for owner `sales-03` at stage "Qualified" | 9 |

---

## What the suite found

A test suite's value is what it catches, not how many assertions it has. Four real defects, all
found by these fifteen cases and all fixed:

**A merge was overwriting the survivor.** Writing the new enquiry's payload onto the existing
opportunity blanked its email (WhatsApp leads have none) and replaced its `x_lp_lead_id` with the
second lead's - destroying the original's idempotency anchor, so a later replay would have created
exactly the duplicate the merge existed to prevent. Found by reading opportunity 45 in Odoo, not by
an execution status. A merge now fills blanks only and never touches the external key, stage, owner
or description.

**`crm.lead.mobile` does not exist** on Odoo saas~19.3. The duplicate search referenced it, Odoo
answered "Invalid field", the gateway classified it permanent, and LP-03 correctly refused to create
a lead it could not de-duplicate. The system behaved perfectly and the feature was still broken.
Every `crm.lead` field the pipeline touches was then checked against `ir.model.fields` on the live
database; `mobile` was the only one missing.

**The owner-health branch ran four times over.** A Data Table read runs once per input item, and the
node upstream emitted one item per agent. Four reassignments of the same lead, four identical audit
rows, four Odoo writes, and every salesperson's workload counted at 4× its real value - which pushed
the whole team over capacity and silently dropped assignment to the fallback rung. Found by reading
four identical `mgr-01 -> mgr-01` audit rows.

**The manager was the default owner of everything.** The fallback owner sat in the normal rotation
with capacity 50 and every service category, so on an idle roster their load ratio was 0 and
`"mgr-01"` beat `"sales-01"` on the alphabetical tie-break. Only visible on the first clean-slate
run. The fallback is now excluded from rungs 1 and 2 - rung 3 is where they belong, and rung 3
raises an alert.

It also found three defects in **itself**, which is worth saying out loud:

- `upsert` was sending `id`/`createdAt`/`updatedAt` back to an API that does not have those columns.
  Every setup step returned `400` and nothing checked the status, so three cases failed twenty
  seconds later asserting on a state change that had never been written. The harness now strips
  those three columns and **throws on any non-2xx**.
- Three cases used the default lead fixture, which is a $15,000 urgent enquiry from a strategic
  account - it scores 100 and goes to Awaiting Approval, so there was no ordinary Qualified lead to
  test assignment, follow-ups or the SLA against.
- EC-13 read the dead-letter queue immediately after a 202 that is deliberately sent *before* the
  work, and found nothing because nothing had been written yet.

---

## Not covered by the runner

Four things a script should not be trusted to assert. They are in
[MANUAL-STEPS.md](MANUAL-STEPS.md) with what to look for: that the confirmation email actually
arrives and reads correctly, that the Odoo kanban visibly moves, that the manager approval email is
usable on a phone, and that a re-run of LP-00 is genuinely idempotent.
