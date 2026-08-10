# Architecture

Mermaid, so it is version-controlled and renders natively on GitHub. Three views: the whole system,
the path one lead takes, and the human checkpoints.

---

## 1. The system

```mermaid
flowchart TB
  subgraph SRC["Sources (at-least-once)"]
    W["Website form"]
    A["WhatsApp<br/>Cloud API envelope"]
    C["CSV / manual import"]
  end

  subgraph N8N["n8n"]
    direction TB
    L1["<b>LP-01 Intake</b><br/>normalise · validate<br/>gate duplicate deliveries<br/>quarantine bad rows"]
    L2["<b>LP-02 Qualify</b><br/>enrich · score · classify<br/>conflict · band<br/><i>no side effects</i>"]
    L3["<b>LP-03 Route and Sync</b><br/>dedupe · assign · upsert<br/>stage · schedule · send<br/><i>the only writer</i>"]
    L4["<b>LP-04 Tick</b><br/>every 5 min<br/>due queue · self-heal<br/>owner health"]
    L6["<b>LP-06 Events</b><br/>reply · opt-out · booking<br/>close · approval"]
    L5["<b>LP-05 Errors and DLQ</b><br/>classify · dead-letter<br/>alert · replay"]
    L7["<b>LP-07 Ops Report</b><br/>daily + on demand"]
    L90(["<b>LP-90 Odoo Gateway</b><br/>single egress"])
    L92(["<b>LP-92 Send Message</b><br/>single outbound gate"])
    L99["<b>LP-99 Mocks</b><br/>enrichment · WhatsApp · booking<br/>+ deterministic chaos"]
  end

  subgraph STATE["State — n8n Data Tables"]
    direction LR
    TIDEM[("lp_idem<br/><i>the claim ledger</i>")]
    TJOBS[("lp_jobs<br/><i>due queue</i>")]
    TLEAD[("lp_lead")]
    TAUD[("lp_audit<br/><i>append-only</i>")]
    TDLQ[("lp_dlq")]
    TAG[("lp_agents")]
    TCFG[("lp_config")]
  end

  ODOO[["<b>Odoo</b><br/>crm.lead · crm.stage<br/><i>system of record</i>"]]
  MAIL["Email / WhatsApp<br/>to the lead"]
  HUMAN{{"Manager<br/>approve · reject"}}
  OPS["Operator<br/>alerts · daily summary"]

  W & A & C -->|"POST + X-LP-Token<br/>202 before the work"| L1
  L1 --> L2 --> L3
  L3 --> L90 --> ODOO
  L3 --> L92 --> MAIL
  L3 -.->|"schedules"| TJOBS
  L4 -->|"claims due jobs"| L92
  L4 --> L90
  L6 -->|"cancels"| TJOBS
  L6 --> L90
  L6 --> L3
  L3 -.-> HUMAN
  HUMAN -->|"decision"| L6
  L2 -->|"enrich"| L99
  L92 -->|"whatsapp"| L99
  L5 --> OPS
  L7 --> OPS
  L1 & L2 & L3 & L4 & L6 -.->|"on error"| L5
  L5 -->|"replay, skipping<br/>what already completed"| L3

  L1 & L3 & L92 & L6 <--> TIDEM
  L1 & L3 & L4 <--> TLEAD
  L3 & L4 <--> TAG
  L1 & L2 & L3 & L4 & L6 --> TAUD
  L1 & L5 & L4 --> TDLQ
  L90 & L2 & L92 --> TCFG
  L7 --> TAUD

  classDef gate fill:#fff3cd,stroke:#997404,stroke-width:2px
  classDef writer fill:#f8d7da,stroke:#842029,stroke-width:2px
  classDef store fill:#e7f1ff,stroke:#0a58ca
  classDef human fill:#e8f5e9,stroke:#1b5e20,stroke-width:2px
  class L90,L92 gate
  class L3 writer
  class TIDEM,TJOBS,TLEAD,TAUD,TDLQ,TAG,TCFG store
  class HUMAN,OPS human
```

Three things the colours are saying:

- **Red is the only workflow that writes.** Every Odoo record, every message, every schedule
  originates in LP-03. Nothing else has side effects.
- **Yellow are the two gateways.** All Odoo traffic and all outbound messaging funnel through one
  node each, so retry policy, auth and the stop-condition recheck exist once.
- **`lp_idem` is touched by four workflows** because it is the claim ledger, and every side effect
  is claimed before it happens.

---

## 2. One lead's path

```mermaid
flowchart TD
  IN["Lead arrives"] --> NORM["Normalise to the canonical schema<br/><i>country before phone</i>"]
  NORM --> KEYS["Derive two keys<br/><b>idem_key</b> = this delivery<br/><b>person_key</b> = this human"]
  KEYS --> SEEN{"idem_key<br/>already claimed?"}
  SEEN -->|yes| DUPEV["Audit: intake_duplicate_event<br/><b>stop</b>"]
  SEEN -->|no| VAL{"Validate"}

  VAL -->|"unusable / parse_error"| QUAR["Quarantine to lp_dlq<br/>with the original text"]
  VAL -->|incomplete| DC["Stage: Data Completion<br/><i>still a real lead</i>"]
  VAL -->|ok| ENR["Enrich<br/>3 tries · 8s · miss is fine"]

  ENR --> SCORE["Deterministic score<br/>8 factors · every one logged"]
  SCORE --> AI{"free text?"}
  AI -->|no| BAND
  AI -->|yes| LLM["Classify<br/><b>zero points</b> · never shown the score"]
  LLM --> CONF{"conf ≥ 0.7<br/>and band gap ≥ 2?"}
  CONF -->|yes| MR["Stage: Manual Review<br/><i>neither side wins</i>"]
  CONF -->|no| BAND{"Band"}

  BAND -->|"≥ 90 or strategic"| VIP["Stage: Awaiting Approval<br/><b>no outbound</b>"]
  BAND -->|"≥ 70"| QUAL["Qualified"]
  BAND -->|"40-69"| NUR["Nurture"]
  BAND -->|"< 40"| UNQ["Closed, lost reason set"]

  QUAL --> DUP{"Duplicate person?<br/>search Odoo, active_test off"}
  NUR --> DUP
  DUP -->|"≥ 0.90"| MERGE["Merge into the existing opportunity<br/><i>fill blanks only</i>"]
  DUP -->|"0.60-0.89"| FLAG["Create, stage for review<br/>candidate named"]
  DUP -->|"self"| UPD["Update - a previous run got here"]
  DUP -->|"none"| ASSIGN

  MERGE --> DONE
  FLAG --> DONE
  UPD --> ASSIGN["Assign: 3 rungs<br/>workload counted, not stored<br/>fallback owner excluded from 1-2"]
  ASSIGN --> CLAIM["<b>Claim odoo_upsert:lead_uid</b>"]
  CLAIM --> WRITE["Write to Odoo"]
  WRITE --> DONE["Flip the claim to done<br/>+ result_ref"]
  DONE --> FAN["Confirmation · follow-ups<br/>SLA timer · audit"]

  VIP --> WAITAPP["wait for a human"]

  classDef stop fill:#f8d7da,stroke:#842029
  classDef human fill:#fff3cd,stroke:#997404
  classDef claim fill:#e7f1ff,stroke:#0a58ca,stroke-width:2px
  class DUPEV,QUAR,UNQ stop
  class MR,VIP,FLAG,DC,WAITAPP human
  class CLAIM,DONE claim
```

---

## 3. Queues and human checkpoints

The brief asks for queues and human checkpoints specifically, so they are called out on their own.

```mermaid
flowchart LR
  subgraph Q["Queues"]
    direction TB
    JOBS[("<b>lp_jobs</b><br/>due_at · state<br/>followup · sla")]
    DLQ[("<b>lp_dlq</b><br/>dead letters<br/>replayable")]
    IDEM[("<b>lp_idem</b><br/>claimed → done<br/><i>a stuck claim is a signal</i>")]
  end

  subgraph H["Human checkpoints"]
    direction TB
    H1{{"<b>VIP approval</b><br/>score ≥ 90 or strategic<br/>no outbound until decided"}}
    H2{{"<b>AI/rules conflict</b><br/>conf ≥ 0.7 and gap ≥ 2"}}
    H3{{"<b>Ambiguous duplicate</b><br/>confidence 0.60-0.89"}}
    H4{{"<b>Data Completion</b><br/>a critical field missing"}}
    H5{{"<b>Unassignable</b><br/>rung 3 + alert"}}
  end

  TICK["LP-04 Tick<br/>every 5 minutes"]
  TICK -->|"due_at ≤ now, cap 25<br/>re-check stops, then send"| JOBS
  TICK -->|"in-flight > 15 min<br/>requeue, 3 strikes"| JOBS
  TICK -->|"claimed > 10 min<br/>= a crash mid-write"| IDEM
  IDEM -->|"stale"| DLQ
  DLQ -->|"POST /lp-replay<br/>skips what completed"| REPLAY["LP-03"]

  H1 --> ODOO1["Odoo stage:<br/>Awaiting Approval"]
  H2 --> ODOO2["Odoo stage:<br/>Manual Review"]
  H3 --> ODOO2
  H4 --> ODOO3["Odoo stage:<br/>Data Completion"]
  H5 --> ALERT["Manager alert"]

  classDef q fill:#e7f1ff,stroke:#0a58ca
  classDef h fill:#e8f5e9,stroke:#1b5e20,stroke-width:2px
  class JOBS,DLQ,IDEM q
  class H1,H2,H3,H4,H5 h
```

Every human checkpoint is **a stage in Odoo**, not a queue in a tool only the automation knows
about. The sales team's review list lives where they already work.

---

## The funnel

Stage transitions are a single lookup table (`C.STAGE_TRANSITIONS`). Nothing else in the system
moves a stage, so "when does a lead reach Qualified" has exactly one place to read.

```mermaid
stateDiagram-v2
  [*] --> New: lead_created
  New --> DataCompletion: missing critical data
  New --> ManualReview: ambiguous duplicate<br/>or AI/rules conflict
  New --> AwaitingApproval: score ≥ 90 or strategic
  New --> Qualified: score ≥ 70
  New --> Nurture: score 40-69

  AwaitingApproval --> Qualified: manager approves
  AwaitingApproval --> Lost: manager rejects
  ManualReview --> Qualified: human resolves
  DataCompletion --> Qualified: data supplied

  Qualified --> Proposition: confirmation sent
  Nurture --> Proposition: confirmation sent
  Proposition --> MeetingBooked: booking event
  MeetingBooked --> Won: converted

  Qualified --> Lost: opted out
  Nurture --> Lost: opted out<br/>or sequence exhausted
  New --> Lost: score < 40<br/>or merged into a duplicate

  note right of Lost
    Lost is not a stage in Odoo.
    active=false + probability=0
    + a lost reason. Modelling it
    as a stage gives you a pipeline
    column full of corpses.
  end note
```

---

## Reading the diagrams against the code

| On the diagram | In the repo |
|---|---|
| A workflow box | `02_Workflows/_src/<name>.js` (spec) and `02_Workflows/<name>.json` (built) |
| The claim ledger | `lp_idem`, and `C.intakeIdemKey` / `C.personKeyOf` in `_shared/constants.js` |
| The scoring box | `_shared/scorer.js`, unit-tested by `scripts/test-scoring.js` |
| The band decision | `C.bandFor` and `C.materiallyConflicts` |
| The stage table | `C.STAGE_TRANSITIONS` |
| The three assignment rungs | `C.pickOwner` |
