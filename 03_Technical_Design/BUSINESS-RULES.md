# Business Rules and Scoring Logic

Deliverable 5. Every rule below is data in
[`02_Workflows/_shared/constants.js`](../02_Workflows/_shared/constants.js) or a pure function in
[`scorer.js`](../02_Workflows/_shared/scorer.js), unit-tested by `scripts/test-scoring.js` (61
assertions). Changing a weight is a constant edit, never a workflow edit.

---

## 1. The brief's seven rules, and where each one lives

| Rule | Condition | Action | Priority | Implemented in |
|---|---|---|---|---|
| Incomplete Lead | missing critical contact data | Data Completion / Manual Review | High | `validateLead` → stage `Data Completion` |
| Duplicate | high-confidence duplicate | merge or update the existing record | High | `dupConfidence` ≥ 0.90 → `merge_into` in LP-03 |
| Qualified | score ≥ 70 | assign to sales + immediate confirmation | High | `bandFor` → `pickOwner` → LP-92 |
| **VIP** | **score ≥ 90 OR strategic account flag** | **manager approval before any outbound** | **Critical** | stage `Awaiting Approval`; two of LP-92's seven stop conditions |
| Nurture | score 40-69 | nurture sequence | Medium | `C.CADENCE.nurture`, +2d / +7d / +21d |
| Unqualified | score < 40 | close, or low-frequency nurture | Low | `active=false` + lost reason |
| SLA Breach | qualified lead, no sales action in 30 min | escalate and optionally reassign | Critical | an `sla` job at `+C.SLA_SECONDS`, drained by LP-04 |

---

## 2. Scoring

Deterministic, eight factors, capped at 0-100. **The AI contributes zero points.** Delete the AI
layer and every lead still scores, routes, assigns and syncs.

Every factor emits a breakdown line - factor, value, points, note - written to `lp_audit`. A score
you cannot explain line by line is a score you cannot defend when a salesperson disputes it.

### The factors

| Factor | Values and points | Source |
|---|---|---|
| **Company size** | `201+` 20 · `51-200` 16 · `11-50` 12 · `1-10` 6 · **`unknown` 12** | enrichment |
| **Industry** | `target` 15 · `adjacent` 8 · **`unknown` 10** · `excluded` **disqualifies** | enrichment |
| **Market** | `core` (EG/AE/SA) 10 · `adjacent` (Gulf) 6 · **`unknown` 5** · `other` 2 | stated, else the E.164 prefix |
| **Service** | `high` 25 · `mid` 15 · `low` 5 · **`unknown` 5** | stated field + free text |
| **Urgency** | `immediate` 10 · `this_quarter` 6 · `exploring` 2 · **`unknown` 2** | free text, English and Arabic |
| **Completeness** | email **and** phone 6 · one of them 3 | the lead itself |
| **Source** | referral 5 · website 5 · whatsapp 4 · paid_social 2 · csv_import 1 | intake |
| **Budget** | `high` (≥ $5,000) 14 · `mid` (≥ $1,000) 7 · **`unknown` 0** | stated field + free text |

Penalties: competitor / job-seeker / solicitation language **−20**, disposable email domain **−10**.

Hard disqualifier: an **excluded industry** short-circuits to 0 before any points are awarded.
Excluded verticals are data (`C.EXCLUDED_INDUSTRIES`), not a hardcoded branch, so changing the list
is a config edit.

### The thing worth arguing about: `unknown` is worth real points

Every `unknown` band scores near the middle, not zero. This is deliberate and it is the single
correction that made the whole scorer work.

A WhatsApp lead has no email, therefore no domain, therefore **no enrichment** - so company size,
industry and often country are all unknown. With zero-valued unknowns, the arithmetic made it
*structurally impossible* for any WhatsApp lead to reach 70. For a brief whose central scenario is
WhatsApp, that is a scoring bug wearing a scoring policy's clothes.

Zero means "we know this is bad". Unknown means "we have not been told". Pricing them the same
punishes leads for the channel they arrived on.

Budget is the one exception at 0: an unstated budget genuinely is a weaker signal than a stated one,
and unlike enrichment it is something the lead chose not to say.

### Worked examples

**A WhatsApp enquiry: no email, no company, urgent.**

```
company_size  unknown      +12   not enriched - scored at the unknown band, not zero
industry      unknown      +10   same
market        core (EG)    +10   derived from the E.164 prefix
service       high         +25   "automation" matched in the message
urgency       immediate    +10   "urgently"
completeness  one          +3    phone only
source        whatsapp     +4
budget        high         +14   "$12,000" in the message
                          ────
                            88   → Qualified
```

That lead is real, it is reachable, and it says what it wants. It should be qualified, and under the
old zero-valued unknowns it scored 56 and went to nurture.

**A website form from an enriched logistics company, no budget stated.**

```
company_size  51-200       +16
industry      target       +15   logistics
market        core (EG)    +10
service       high         +25   "Workflow automation"
urgency       immediate    +10
completeness  both         +6
source        website      +5
budget        unknown      +0
                          ────
                            87   → Qualified
```

**A job application through the contact form.**

```
intent_penalty  job language  −20
... every other factor ...     +58
                              ────
                                38   → Unqualified, closed with a lost reason
```

### Bands

```
strategic flag OR score ≥ 90  →  vip          manager approval, no outbound
              score ≥ 70      →  qualified    assign + immediate confirmation
              score 40-69     →  nurture      low-frequency sequence
              score < 40      →  unqualified  close with a reason
```

The strategic-account flag comes from enrichment and **forces VIP regardless of score** - that is
the brief's "score ≥ 90 OR strategic account flag", and it is why a strategic account with a modest
enquiry still gets a human's eyes.

---

## 3. The AI's separate axis

The model reads the free text only and returns strict JSON:

```json
{ "intent_level": "high|medium|low", "urgency": "immediate|this_quarter|exploring|unknown",
  "buying_signals": ["at most 3"], "reason": "≤200 chars, quoting the lead",
  "confidence": 0.0 }
```

`google/gemini-2.5-flash-lite`, temperature 0, `response_format: json_object`, 300 max tokens.
**Skipped entirely when there is no free text**, which removes most of the spend. Cost is about
**$0.07 per 1,000 classified leads** - list price ($0.10/M in, $0.40/M out) against this prompt's
~285 input and ~95 output tokens, so a calculated upper bound rather than a measurement.

**The model is never shown the score.** If it were, "the AI disagrees with the rules" would measure
anchoring rather than disagreement, and the conflict rule below would be theatre.

### Conflict, made numeric

A reviewer will ask what *materially conflicts* means, so it is one clause and two constants:

```js
materiallyConflicts = ai.status === 'ok'
  && ai.confidence >= 0.7
  && |bandOrdinal(AI_IMPLIED_BAND[ai.intent]) - bandOrdinal(ruleBand)| >= 2
```

with `AI_IMPLIED_BAND = {high: qualified, medium: nurture, low: unqualified}` and ordinals
`unqualified 0, nurture 1, qualified 2, vip 2`.

**Adjacent disagreement does not count.** Qualified versus Nurture is expected noise around a cut
point. If it triggered review, the manual queue would become the default path and the automation
would have achieved nothing. Only a two-step gap from a confident model - "high potential" against
rules that scored 38 - is a real disagreement.

When it fires, **neither side wins**: the lead goes to `Manual Review` with both readings recorded
side by side. The rules do not overrule the model and the model does not overrule the rules; a human
looks.

If the model returns nothing usable, `ai_status: unavailable` and the lead completes on rules alone.
Because the AI is worth zero points, the fallback changes the outcome by exactly nothing - which is
edge case 4, and the test asserts the score is identical.

---

## 4. Duplicate confidence

Never delete. Merge, flag, or treat as new.

| Confidence | Signal | Action |
|---|---|---|
| 1.00 | `phone_key` match | `merge_into` |
| 0.95 | `email_norm` match | `merge_into` |
| 0.75 | same normalised name **and** company | `create_flagged` → Manual Review |
| 0.70 | same name **and** email domain | `create_flagged` → Manual Review |
| 0.40 | name only | treated as new |

Thresholds: **≥ 0.90 auto-merge**, **0.60-0.89 create-and-flag**, below that new.

Creating a flagged possible-duplicate rather than blocking it is deliberate: **losing a real lead is
worse than carrying a duplicate for an hour.** The candidate opportunity is named in the flag, so
the human review takes seconds.

A merge **fills blanks only**. It never touches the survivor's external key, stage, owner or
description. Overwriting the survivor's `x_lp_lead_id` destroys the original's idempotency anchor,
so a later replay creates exactly the duplicate the merge existed to prevent - which happened here
once, and was found by reading Odoo rather than by a green execution.

Every decision writes a `duplicate_decision` audit row with the confidence, the signal it matched
on, and the candidate id. That is the brief's "maintain a record of duplicate decisions".

---

## 5. Routing

### Three rungs, deterministic

```
rung 1   available AND handles the service category
rung 2   available, any category
rung 3   the fallback owner, and raise an alert
```

Within a rung: **least loaded first** by `open_leads / capacity`, ties broken by `agent_id`, so the
same inputs always produce the same owner and the routing is testable rather than "whoever the table
happened to return first".

**Workload is counted from the lead table**, not read from a stored counter. A counter needs a
decrement on every path that ends an assignment - closed, merged, opted out, reassigned by the tick,
rejected by a manager - and the first path anyone forgets leaves that salesperson permanently full.

**The fallback owner is excluded from rungs 1 and 2.** They are usually the sales manager: high
capacity and every service category, which on an idle roster means the lowest load ratio and a
winning tie-break, so leaving them in the rotation quietly makes the manager the default owner of
everything. Rung 3 is where they belong, and rung 3 raises an alert.

Rung 3 does **not** drop the lead. An unassigned lead is a lead nobody is accountable for, which is
the failure mode the rung exists to prevent. The tick reassigns when capacity frees up.

Nobody owns a **closed** lead or one **waiting on a human decision** - assigning one only inflates a
salesperson's queue with work they cannot do.

### Geography and urgency

Both are scoring inputs rather than separate routing branches, which is a design choice worth
stating: a single score that already weighs market and urgency produces one ordering, where parallel
routing rules produce conflicts that need a tiebreaker nobody can explain. Geography also picks the
message language, and urgency sets the first follow-up delay.

---

## 6. The follow-up cadence

Three steps with genuinely different timing conditions, per the brief.

| | Qualified | Nurture |
|---|---|---|
| step 1 | +1 hour | +2 days |
| step 2 | +1 day | +7 days |
| step 3 | +3 days, **only if score ≥ 85** | +21 days |

Step 3 for qualified leads is **score-conditional**, not just a longer delay - the third chase is
worth it for an 88-point lead and is noise for a 71-point one.

All sends are business-hours gated (09:00-18:00 Africa/Cairo) and event-conditional.

### Stop conditions

`replied` · `booked` · `opted_out` · `closed` · `merged`. Any one of them cancels **every** pending
job for that lead immediately.

The tick **re-reads the stop conditions immediately before sending**, not only when the job is
claimed. That is what makes edge case 10 genuinely work rather than appear to: a lead who opts out
four seconds after a job is claimed for this tick still does not receive it.

### SLA

An `sla` job is armed at **+1800 seconds** on every qualified assignment. Any `sales_action` event
cancels it. If it fires: audit `sla_breached`, escalate to the manager, and reassign if the owner
has gone unavailable.
