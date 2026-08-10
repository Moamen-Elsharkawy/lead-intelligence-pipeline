# Manual verification steps

Four things the automated suite deliberately does not assert, because a script asserting them would
be asserting its own opinion. Each takes a minute and needs a human looking at a screen.

Everything else is in [EDGE-CASES.md](EDGE-CASES.md) and runs unattended.

---

## 1. The confirmation email actually arrives, and reads like a person wrote it

The runner asserts that a `message_sent` audit row exists with a provider reference. It does not
open the inbox, and it cannot judge whether the copy is any good.

```bash
curl -X POST $N8N/webhook/lp-web-lead -H "X-LP-Token: $LP_WEBHOOK_TOKEN" \
     -H 'Content-Type: application/json' -d @06_Sample_Data/website-lead.json
```

Open the inbox at `lp_config.demo_redirect_email` within a minute or two and check:

- The subject line carries the intended recipient, since the redirect is on:
  `[demo -> nadia@acme-logistics.com] ...`
- The body has the lead's **name**, their **service interest** and the **owner's name** filled in -
  no `{{ }}`, no empty gaps where a merge field should be.
- Nothing in it claims something the business has not done. The templates state what happens next
  and who will call; they do not invent case studies or numbers.

Then check `lp_audit` for that lead: the `message_sent` row should show
`intended_to`, `actual_to` and `redirected: true`.

**Why not automated:** an assertion that an email "reads correctly" is an assertion about taste.
Checking that the send *happened* is automated; checking that it is fit to send to a customer is a
human's job, every time.

## 2. The Odoo funnel visibly moves

Open Odoo → **Sales → Leads**, switch to kanban, and group by stage.

Send four leads and watch them land in four different columns:

| Send | Expect |
|---|---|
| `06_Sample_Data/website-lead.json` | **Awaiting Approval** - $15k, strategic account, scores 100 |
| the same with `"budget": ""` and a non-strategic domain | **Qualified**, owner set |
| `06_Sample_Data/whatsapp-inbound.json` | **Qualified** or **Nurture**, depending on the message |
| a lead with `"message": "I am looking for a job"` | closed, `active=false`, lost reason set |

Then, on the Qualified one, fire a booking and watch the card move to **Meeting Booked** in real
time:

```bash
curl -X POST $N8N/webhook/lp-event -H "X-LP-Token: $LP_WEBHOOK_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"type":"booking","lead_uid":"LP-...","booking_id":"bk_demo_1","slot":"2026-08-14T11:00:00Z"}'
```

Open the opportunity itself and check the fields the brief asks to be written: **stage**, **score**
(in the description block), **owner**, **source**, the **reason for qualification** and the **next
action**.

**Why not automated:** the runner already queries Odoo over JSON-RPC and asserts on stage and
`active`. What it cannot check is whether the result is *legible to a salesperson* - the right
columns, in the right order, with a description you can act on rather than a JSON dump.

## 3. The manager approval email is usable

Send the default website lead (it scores 100 → VIP) and open the manager email at
`lp_config.manager_email`. It is **not** redirected - internal mail never is.

Check that it is decidable without opening anything else:

- the score **and its breakdown**, factor by factor
- the AI's reading and its confidence
- the lead's own words
- two links, approve and reject

Then open it on a phone. A manager approving a deal from a car is the realistic case, and a
two-column HTML table is not usable there.

Click reject, and confirm in Odoo that the opportunity is `active=false` with lost reason
**"Rejected by manager"**, and that no message ever reached the lead.

**Why not automated:** EC-12 asserts every one of those state changes. What it cannot assert is
whether a human can make the decision from what they were sent.

## 4. Re-running setup is genuinely safe

```bash
curl -X POST $N8N/webhook/lp-setup -H "X-LP-Token: $LP_WEBHOOK_TOKEN" \
     -H 'Content-Type: application/json' -d '{"mode":"keep"}'
```

The summary should report the field **already present**, **no stages created**, and the roster
unchanged - and Odoo should have no new duplicate stages afterwards.

This matters because setup is the one thing a reviewer runs twice by accident.

**Why not automated:** it is one call and one glance, and automating a check that "nothing changed"
against a system whose whole job is to change things costs more than it saves.

---

## Recording the evidence

For the submission, one screenshot each is enough:

1. The inbox showing the confirmation, subject line visible.
2. The Odoo kanban with cards in four different stages.
3. The manager approval email.
4. The terminal showing `15 passed, 0 soft, 0 failed`.
