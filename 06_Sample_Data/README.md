# Sample data

Payloads for driving the pipeline by hand. Two of the four are deliberately broken - a sample set
where everything is valid only proves the happy path.

| File | What it is |
|---|---|
| `website-lead.json` | A website form submission. $15,000, urgent, strategic account, so it scores **100** and lands in **Awaiting Approval** with no outbound message |
| `whatsapp-inbound.json` | A real **WhatsApp Business Cloud API** envelope: `entry[].changes[].value.messages[]`. No email, no company - the case the scoring had to be fixed for |
| `whatsapp-status-callback.json` | A delivery-status callback (`statuses[]`), which Meta sends far more often than messages. **Must be acknowledged and ignored.** Treating it as a lead is the mistake this file exists to catch |
| `leads-import.csv` | Four rows: two valid, one structurally broken (3 columns instead of 8), one with no email and no phone |

## Using them

```bash
curl -X POST $N8N/webhook/lp-web-lead   -H "X-LP-Token: $LP_WEBHOOK_TOKEN" \
     -H 'Content-Type: application/json' -d @06_Sample_Data/website-lead.json

curl -X POST $N8N/webhook/lp-wa-inbound -H "X-LP-Token: $LP_WEBHOOK_TOKEN" \
     -H 'Content-Type: application/json' -d @06_Sample_Data/whatsapp-inbound.json
```

The CSV goes in a JSON envelope, because the import carries a batch id and a consent attestation
alongside the file:

```bash
node -e "
const fs=require('fs');
console.log(JSON.stringify({batch_id:'sample', attested_consent:true,
  csv: fs.readFileSync('06_Sample_Data/leads-import.csv','utf8')}));
" > /tmp/import.json

curl -X POST $N8N/webhook/lp-csv-import -H "X-LP-Token: $LP_WEBHOOK_TOKEN" \
     -H 'Content-Type: application/json' -d @/tmp/import.json
```

Expect `accepted: 2, quarantined: 2`, with both bad rows in the dead-letter queue carrying their
**original text**, so the fix is to correct the cell and replay.

## The domains

`acme-logistics.com`, `nilecargo.com`, `deltaclinics.com`, `gulftech.ae`, `smallshop.com`,
`brightlearn.com`, `apexrealty.com`, `northstarco.com` and `luckyspin.com` are the nine entries in
the mock enrichment directory in LP-99. They are invented, and they are chosen to span the scoring
range:

- `acme-logistics.com` - 420 staff, logistics, EG, **strategic** → forces VIP
- `nilecargo.com` - 180 staff, logistics, EG → Qualified
- `smallshop.com` - 8 staff, retail, EG → Nurture
- `luckyspin.com` - gambling → **excluded industry, hard disqualify**

Any other domain is a legitimate enrichment *miss*, which the scorer prices as `unknown` rather than
zero. Most WhatsApp leads have no domain at all.
