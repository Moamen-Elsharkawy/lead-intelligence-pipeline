# Lead Intelligence Pipeline

A multi-source lead-processing pipeline in **n8n**, with **Odoo** as the central CRM and system of
record. Website form, WhatsApp and CSV import in; normalised, validated, de-duplicated, enriched,
scored by deterministic rules, classified separately by an LLM, routed by workload, written to Odoo,
followed up on a schedule, and audited end to end. Failures are classified, dead-lettered and
replayable.

Built for a technical assessment. **15 / 15 mandated edge cases pass** against a live deployment,
from a clean slate.

---

**The one idea:** every side effect is claimed in a ledger *before* it happens. A duplicate webhook,
a retried send, a lost acknowledgement and a manual re-run all converge on the same outcome, because
the question asked before acting is never "did this succeed?" but "has this already been claimed?".
Eleven of the fourteen edge cases fall out of that rather than being special-cased.

---

## Start here

| | |
|---|---|
| **[01_README/](01_README/README.md)** | What it is, the eleven workflows, how to run it. [Setup](01_README/SETUP.md) · [Running](01_README/RUNNING.md) |
| **[02_Workflows/](02_Workflows/)** | The exported n8n JSON, plus the specs and shared runtime it is built from |
| **[03_Technical_Design/](03_Technical_Design/DESIGN.md)** | The design document. [Data model](03_Technical_Design/DATA-MODEL.md) · [Business rules](03_Technical_Design/BUSINESS-RULES.md) · [Error strategy](03_Technical_Design/ERROR-STRATEGY.md) |
| **[04_Architecture/](04_Architecture/architecture.md)** | Mermaid diagrams: the system, one lead's path, queues and human checkpoints |
| **[05_Test_Evidence/](05_Test_Evidence/EDGE-CASES.md)** | The edge-case matrix and the runner that produced it. [Manual steps](05_Test_Evidence/MANUAL-STEPS.md) · [Demo script](05_Test_Evidence/DEMO-SCRIPT.md) |
| **[06_Sample_Data/](06_Sample_Data/)** | Website, WhatsApp and CSV payloads, including deliberately broken ones |

## At a glance

| | |
|---|---|
| Workflows | 11, 212 nodes, all validating clean |
| Tests | 158 unit assertions + 15 live edge-case tests + 32 live hardening checks |
| State | 8 n8n Data Tables |
| Running cost | ~$0.07 per 1,000 classified leads |
| Secrets in this repo | none - credentials are referenced by name, values live in n8n and a git-ignored `.env` |

## The three things a reviewer should check first

1. **[The edge-case matrix](05_Test_Evidence/EDGE-CASES.md)** - fifteen cases, each asserting on an
   observable outcome in Odoo or the ledger, and a runner you can execute against your own instance.
   It includes the four real bugs it found.
2. **[Known limitations](03_Technical_Design/DESIGN.md#12-known-limitations-and-next-improvements)** -
   the honest list, including the concurrency window that is still open and what it would take to
   close.
3. **[Idempotency strategy](03_Technical_Design/DESIGN.md#7-idempotency-strategy)** - two keys, why
   the claim is read-then-insert, and why that is acceptable here.
