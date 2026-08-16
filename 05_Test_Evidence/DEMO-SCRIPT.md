# Demo script

Deliverable 9. Written to be run **live** in about 12 minutes, or recorded from the same beats.
Every command is copy-pasteable and every one of them has been run.

---

## Before you start

Four windows, in this order left to right:

1. **Terminal**, in the repo root, `.env` filled in.
2. **Odoo**, at `Sales → Leads`, kanban view, grouped by stage.
3. **n8n**, on the `lp_lead` and `lp_audit` data tables.
4. **The inbox** at `lp_config.demo_redirect_email`.

Reset to a known state - this takes about 90 seconds and makes the whole demo reproducible:

```bash
node scripts/demo-reset.js you@example.com
```

That recreates the eight tables, provisions a **fresh Odoo sandbox**, seeds the roster, and points
every lead-facing message at your own inbox so nothing can reach a real person. Worth saying out
loud during the demo: whatever the reviewer is looking at was built from nothing, ninety seconds
ago.

Have `$N8N` and `$LP_WEBHOOK_TOKEN` exported already. Nobody wants to watch you find a token.

---

## 0. The claim, up front (30s)

> "One lead-processing pipeline. Three sources in, Odoo as the system of record. The thing I want
> you to judge it on is reliability: every side effect in this system is claimed in a ledger
> **before** it happens, so a duplicate webhook, a retried send, a lost acknowledgement and a manual
> re-run all land on the same outcome. Eleven of the fourteen edge cases fall out of that one idea
> rather than being special-cased."

Show `02_Workflows/` - eleven workflows - and say the second sentence that matters:

> "LP-02 decides and LP-03 acts. Qualification has no side effects, so it is always safe to re-run.
> Every write, message and schedule is in one workflow, so there is exactly one writer per fact."

## 1. A lead arrives (90s)

```bash
curl -X POST $N8N/webhook/lp-web-lead -H "X-LP-Token: $LP_WEBHOOK_TOKEN" \
     -H 'Content-Type: application/json' -d @06_Sample_Data/website-lead.json
```

Point at the response:

```json
{ "ok": true, "accepted": 1, "duplicates": 0, "quarantined": 0, "lead_uids": ["LP-..."] }
```

> "202, and it is sent **before** the work. The pipeline enriches, calls a model and writes to Odoo -
> a webhook that waits for that is a webhook that times out, and a source that times out retries,
> which is how you get duplicates."

Switch to Odoo. Within a few seconds a card appears in **Awaiting Approval**. Open it: score,
breakdown, owner, source, the reason for qualification, next action.

> "$15,000, urgent, strategic account. Scores 100, so it is VIP - and **no message has gone out**.
> That is the brief's critical rule, and it is enforced in the send gate, not by hoping nothing
> calls it."

## 2. Why did it get that result (90s)

Open `lp_audit` in n8n, filter by the `lead_uid`, read down the rows.

> "Every decision, one row. The score is not a number - it is eight factors with their points and a
> note each. The assignment records the **whole team's load at the moment it was made**, so I can
> explain the routing later without re-running the picker against a table that has since moved."

> "n8n's own execution log is not the audit trail. It is pruned after 14 days and it is not
> queryable by lead. This is."

## 3. The same person, from a second channel (2 min)

```bash
curl -X POST $N8N/webhook/lp-wa-inbound -H "X-LP-Token: $LP_WEBHOOK_TOKEN" \
     -H 'Content-Type: application/json' -d @06_Sample_Data/whatsapp-inbound.json
```

Then send it **again**, unchanged.

> "Three things just happened. The WhatsApp envelope is the real Meta Cloud API shape, so pointing
> Meta at this URL is a configuration change. The second identical delivery was rejected as a
> duplicate **event**. And if this person already existed from the website, the second one merges
> into their opportunity instead of creating a new one."

> "Those are two different questions and the system keeps two different keys for them. `idem_key`
> asks 'has this delivery been processed?'. `person_key` asks 'have we met this person?'. Conflate
> them and you fail in both directions: dedupe by event and a real second enquiry is silently
> dropped; dedupe by person and a retried webhook overwrites good data."

Show in Odoo: **one** opportunity. Show in `lp_lead`: the second lead marked `merged`.

## 4. Break something on purpose (2 min)

```bash
# make the enrichment API time out twice, then succeed
# lp_config: enrich_chaos = ?fail=timeout&times=2
curl -X POST $N8N/webhook/lp-web-lead -H "X-LP-Token: $LP_WEBHOOK_TOKEN" \
     -H 'Content-Type: application/json' -d @06_Sample_Data/website-lead.json
```

> "Two timeouts, bounded backoff, third call succeeds. The counter is real - it lives in the ledger -
> so this is reproducible, not a story."

Now kill the AI instead (`?fail=malformed`) and send another:

> "The model returned garbage. The lead scored **identically**, because the AI is worth zero points.
> It is a separate qualitative axis and it is deliberately never shown the score - otherwise 'the AI
> disagrees with the rules' measures anchoring, not disagreement. Delete the whole AI layer and this
> pipeline still runs."

Then the one that is not obvious:

```bash
# lp_config: enrich_chaos = ?fail=auth
```

> "401 is **never retried**. It is classified as a dead credential, dead-lettered at critical, and
> alerted immediately. Retrying a dead credential three times is three times the noise and zero
> times the fix. This instance has had five silent credential deaths, one of which went unnoticed
> for thirteen days."

## 5. The lost acknowledgement (2 min)

The best 90 seconds in the demo.

> "The CRM create succeeded and the workflow died before hearing back. The lead is written in Odoo
> and our ledger says 'claimed'. Naively, a retry creates a second opportunity."

Rewind the ledger row to `claimed`, then replay:

```bash
curl -X POST $N8N/webhook/lp-replay -H "X-LP-Token: $LP_WEBHOOK_TOKEN" \
     -H 'Content-Type: application/json' -d '{"dlq_id":"dlq-..."}'
```

```json
{ "ok": true, "odoo_already_created": true, "skipped": ["odoo_upsert","message"] }
```

Show Odoo: still **one** opportunity.

> "It read the ledger before acting, searched Odoo by our external reference, found the record that
> did get created, and repaired the ledger instead of duplicating it. That is edge case 7 and edge
> case 14 answered by the same mechanism - and the safety comes from the ledger, not from the
> operator being careful."

## 6. Opting out mid-sequence (90s)

Send a Qualified lead, show the follow-up jobs appear with their `due_at`. Wind the first one
forward so it is due now. Then:

```bash
curl -X POST $N8N/webhook/lp-event -H "X-LP-Token: $LP_WEBHOOK_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"type":"opt_out","lead_uid":"LP-...","note":"unsubscribe"}'

curl -X POST $N8N/webhook/lp-tick -H "X-LP-Token: $LP_WEBHOOK_TOKEN" -d '{}'
```

Every job `cancelled`. Nothing sent.

> "Follow-ups are queue rows with a `due_at`, drained by a five-minute tick - not `Wait` nodes. A
> held-open Wait cannot be cancelled cleanly, does not survive a restart, and holds an execution
> slot for three days."

> "And the tick re-reads the stop conditions **immediately before sending**, not just when it claims
> the job. That is the difference between this working and appearing to work: someone who opts out
> four seconds after the job is claimed still does not get the message."

## 7. The manager says no (90s)

Go back to the VIP from step 1.

```bash
curl -X POST $N8N/webhook/lp-approval -H "X-LP-Token: $LP_WEBHOOK_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"lead_uid":"LP-...","decision":"reject","by":"manager@example.com"}'
```

Odoo: `active=false`, lost reason **"Rejected by manager"**. Jobs cancelled. **No message ever
reached the lead.**

> "Seven stop conditions in the send gate, checked in order, consent first. `awaiting_approval` and
> `approval_rejected` are two of them - so even a job already claimed for this tick will not go
> out."

## 8. The whole suite (90s)

```bash
node 05_Test_Evidence/run-edge-cases.mjs
```

Let it run while you talk.

> "Fifteen cases: the fourteen mandated plus business rule 7. Every one asserts on an **observable
> outcome** - a row read back out of Odoo over JSON-RPC, a state in the ledger, a cancelled job.
> Never on 'the workflow finished without erroring', which on this stack is not evidence of
> anything: a node with continue-on-error swallows a 401 exactly like an empty result and the
> execution is logged successful."

```
15 passed, 0 soft, 0 failed
```

> "That is from a clean slate - tables recreated, a fresh Odoo provisioned by the setup workflow
> minutes earlier. And it found four real bugs, which is the part I would rather talk about."

## 9. What it got wrong (90s) — do not skip this

> "A merge was overwriting the survivor's external key, which would have made a later replay create
> exactly the duplicate the merge existed to prevent. I found it by reading Odoo, not by looking at
> an execution status."

> "`crm.lead.mobile` does not exist on this Odoo version. The duplicate search used it, Odoo said
> 'Invalid field', the gateway classified it permanent, and the router correctly refused to create a
> lead it could not de-duplicate. The system behaved perfectly and the feature was still broken."

> "A Data Table read runs once per input item, so the owner-health scan ran four times over - and
> counted every salesperson's workload at four times its real value, which pushed the team over
> capacity. Four identical audit rows is what gave it away."

> "And the fallback owner was sitting in the normal rotation, so the sales manager had quietly
> become the default owner of everything."

Then the limitations, unprompted:

> "Two submissions from the same person inside the same five-second window can still create two
> opportunities - duplicate detection is a search against Odoo, and there is nothing to match until
> the first one is written there. The mandated case is 'within two minutes' and that works, but this
> is a real gap. The fix is a person-level claim with a re-check job, about six nodes, and I did not
> do it because it adds a failure mode that needs its own tests."

> "The enrichment provider is a lookup table. The claim ledger has no unique constraint, so it is
> read-then-insert - mitigated by search-before-create against Odoo, which is a real uniqueness
> check. And there is no inbound reply parsing yet; something has to call the reply endpoint."

## 10. Close (30s)

> "Eleven workflows, 212 nodes, 194 unit tests, fifteen live edge-case tests, and the whole thing
> runs at about seven cents per thousand classified leads. If you want it against your own Odoo, it
> is three lines in the setup workflow's config node and one run - every Odoo call already goes
> through a single gateway."

---

## If you have five minutes instead of twelve

Sections 0, 3, 5, 8, 9. That is: the claim, two channels one person, the lost acknowledgement, the
suite going green, and what it got wrong.

## If a recording is wanted

Record sections 1 through 8 in one take, no cuts - the point is that these are live systems
responding, not screenshots. Keep the terminal at 16pt or larger. Total runtime lands around 11
minutes.
