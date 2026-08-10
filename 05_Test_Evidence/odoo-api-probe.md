# Odoo API probe - measured, not assumed

Everything the Odoo integration depends on was verified against a live Odoo
before a single node was built. Reproduce with `scripts/../probes` steps below;
each result is copied from the actual run on **2026-08-10**.

Odoo build under test: `saas~19.3+e`, provisioned from `https://demo.odoo.com/start`.

---

## 1. Which pricing plans allow the external API

Odoo's own documentation (18.0 and 19.0, *External API*) states:

> "Access to data via the external API is only available on **Custom** Odoo
> pricing plans. Access to the external API is not available on **One App
> Free** or **Standard** plans."

**Consequence for this build.** The obvious free route - an Odoo Online free
plan - is closed for writes, and this pipeline is almost entirely writes. The
route taken instead is Odoo's own public sandbox, `demo.odoo.com/start`, which
is documented in that same API reference as the way to get a test database. It
returns `{host, database, user, password}` and needs no account, no card and no
infrastructure.

## 2. The 404 that was not a 404

First contact with the sandbox:

```
POST https://demo4.odoo.com/xmlrpc/2/common   ->  404 NOT FOUND
POST https://demo4.odoo.com/jsonrpc           ->  404 NOT FOUND
```

The `/jsonrpc` body explained itself:

```
No database is selected and the requested URL was not found in the
server-wide controllers.
<!-- Alternatively, use the X-Odoo-Database header. -->
```

So the endpoints are alive; the multi-tenant host simply could not choose a
database. Adding one header fixes all of them:

```
POST /jsonrpc      + X-Odoo-Database: <db>   ->  200
  {"result":{"server_version":"saas~19.3+e", ...}}
POST /xmlrpc/2/common + X-Odoo-Database: <db> ->  200 (custom transport)
POST /web/session/authenticate                ->  200, uid 2, is_admin true
```

**Consequence.** The n8n **Odoo node cannot be used here**: it speaks XML-RPC
with no way to attach a request header, so on a multi-tenant host every call is
a 404. All Odoo traffic goes through `LP-90 Odoo Gateway`, an HTTP Request pair
that sends the header explicitly.

## 3. `/jsonrpc` returns HTTP 200 when the call failed

The single most important measurement in this document:

```
POST /jsonrpc  execute_kw crm.lead write {"ref": "LP-TEST-0001"}
->  HTTP 200
    {"error":{"data":{"name":"builtins.ValueError",
      "message":"Invalid field 'ref' in 'crm.lead'"}}}
```

A failed write, reported as HTTP 200. Anything that decides success from the
status code records this as done. `LP-90`'s `Inspect Response` node exists for
exactly this, and it is why retry classification happens in a Code node rather
than in `retryOnFail`.

## 4. `crm.lead` has no `ref` field

Confirmed by the error above, and by the search failing the same way:

```
search_read crm.lead [["ref","=","LP-TEST-0001"]]
->  "Invalid field crm.lead.ref in condition ('ref', '=', 'LP-TEST-0001')"
```

**Consequence.** Idempotent upsert needs a searchable external key, so the
pipeline creates one. This works over the API:

```
ir.model      search_read [["model","=","crm.lead"]]        ->  id 2420
ir.model.fields create {name:"x_lp_lead_id", ttype:"char",
                        model_id:2420, store:true, index:true}
                                                            ->  id 45281
crm.lead create {..., x_lp_lead_id:"LP-20260810-ABC123"}    ->  id 46
crm.lead search_read [["x_lp_lead_id","=","LP-20260810-ABC123"]]
                                                            ->  1 row
```

## 5. What else the integration needs, and whether it exists

| Capability | Result |
|---|---|
| `crm.lead` create / write | works |
| Move `stage_id` | works (`write` returned `true`) |
| `crm.stage` create | works - the five extra funnel stages are created by `LP-00` |
| `message_post` on a lead | works, returned message id `4140` - this is the CRM-side audit trail a salesperson can read |
| `mail.activity.type` | To-Do, Email, Call, Meeting, Inbox |
| Default stages shipped | New (1), Qualified (2), Proposition (3), Won (70, `is_won`) |
| JSON-2 API `/json/2/<model>/<method>` | **401 with user+password.** It requires a minted API key, which a throwaway sandbox cannot carry. Not used; noted in known limitations. |

## 6. Lost is not a stage

Odoo represents a lost opportunity as `active = false` plus `probability = 0`
plus a lost reason - not as a stage. Every search in this pipeline therefore
passes `{"context": {"active_test": false}}`, which `LP-90` injects
automatically on `search`, `search_read` and `search_count`. Without it a
previously-lost lead is invisible to the duplicate check and gets recreated.

---

## How to reproduce

```bash
python probes/odoo_probe2.py     # endpoint matrix: xmlrpc / jsonrpc / web session
python probes/odoo_probe3.py     # header routing, custom field, message_post
```

Both provision their own sandbox, so they are safe to run at any time and leave
nothing behind that matters.
