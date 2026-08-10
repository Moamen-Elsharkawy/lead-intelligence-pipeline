"""Settle two questions that decide how n8n will talk to Odoo.

Q1. Was the /xmlrpc + /jsonrpc 404 really "endpoint removed", or just
    "multi-tenant host could not pick a database"? The 404 body itself said
    "Alternatively, use the X-Odoo-Database header", so test that.

Q2. Can we create a proper external-reference field on crm.lead
    (x_lp_lead_id) via ir.model.fields? crm.lead has no `ref` field, and the
    idempotency design needs a searchable external key.
"""
import http.client
import json
import ssl
import urllib.error
import urllib.request
import xmlrpc.client

ctx = ssl.create_default_context()

info = xmlrpc.client.ServerProxy("https://demo.odoo.com/start", context=ctx).start()
URL, DB, USER, PW = info["host"], info["database"], info["user"], info["password"]
HOST = URL.replace("https://", "")
print(f"host={URL}\ndb={DB}\n")


def post(path, payload, headers=None, cookie=None):
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    if cookie:
        h["Cookie"] = cookie
    req = urllib.request.Request(URL + path, data=json.dumps(payload).encode(), headers=h)
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=60) as r:
            return r.status, r.read().decode(), r.headers.get("Set-Cookie")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300], None


print("=" * 70)
print("Q1a. /jsonrpc WITH X-Odoo-Database header")
st, body, _ = post(
    "/jsonrpc",
    {"jsonrpc": "2.0", "method": "call",
     "params": {"service": "common", "method": "version", "args": []}, "id": 1},
    headers={"X-Odoo-Database": DB},
)
print(f"   status={st}")
print(f"   {body[:300]}")

jsonrpc_alive = st == 200 and '"result"' in body

if jsonrpc_alive:
    print("\nQ1b. /jsonrpc authenticate + execute_kw WITH the header")
    st, body, _ = post(
        "/jsonrpc",
        {"jsonrpc": "2.0", "method": "call",
         "params": {"service": "common", "method": "authenticate",
                    "args": [DB, USER, PW, {}]}, "id": 2},
        headers={"X-Odoo-Database": DB},
    )
    uid = json.loads(body).get("result")
    print(f"   authenticate -> {uid}")

    if uid:
        st, body, _ = post(
            "/jsonrpc",
            {"jsonrpc": "2.0", "method": "call",
             "params": {"service": "object", "method": "execute_kw",
                        "args": [DB, uid, PW, "crm.lead", "search_count", [[]]]}, "id": 3},
            headers={"X-Odoo-Database": DB},
        )
        print(f"   search_count -> {body[:200]}")

        st, body, _ = post(
            "/jsonrpc",
            {"jsonrpc": "2.0", "method": "call",
             "params": {"service": "object", "method": "execute_kw",
                        "args": [DB, uid, PW, "crm.lead", "create",
                                 [{"name": "LP jsonrpc probe", "type": "opportunity"}]]}, "id": 4},
            headers={"X-Odoo-Database": DB},
        )
        print(f"   create -> {body[:200]}")

print("=" * 70)
print("Q1c. /xmlrpc/2/common WITH X-Odoo-Database header (custom transport)")


class HeaderTransport(xmlrpc.client.SafeTransport):
    def send_headers(self, connection, headers):
        connection.putheader("X-Odoo-Database", DB)
        super().send_headers(connection, headers)


try:
    v = xmlrpc.client.ServerProxy(
        URL + "/xmlrpc/2/common", transport=HeaderTransport(context=ctx)
    ).version()
    print(f"   OK {v}")
    xmlrpc_alive = True
except Exception as e:
    print(f"   {type(e).__name__}: {str(e)[:160]}")
    xmlrpc_alive = False

print("=" * 70)
print("Q2. custom field x_lp_lead_id on crm.lead, via the web session API")
st, body, cookie = post(
    "/web/session/authenticate",
    {"jsonrpc": "2.0", "method": "call", "params": {"db": DB, "login": USER, "password": PW}},
)
session = cookie.split(";")[0] if cookie else None
print(f"   session={'yes' if session else 'no'}")


def kw(model, method, args, kwargs=None):
    st, body, _ = post(
        "/web/dataset/call_kw",
        {"jsonrpc": "2.0", "method": "call",
         "params": {"model": model, "method": method, "args": args, "kwargs": kwargs or {}}},
        cookie=session,
    )
    p = json.loads(body)
    if "error" in p:
        return {"ERROR": (p["error"].get("data") or {}).get("message")}
    return p.get("result")

model_id = kw("ir.model", "search_read", [[["model", "=", "crm.lead"]], ["id", "model"]])
print(f"   ir.model crm.lead -> {model_id}")

if isinstance(model_id, list) and model_id:
    r = kw("ir.model.fields", "create", [{
        "name": "x_lp_lead_id",
        "field_description": "LP Lead ID",
        "model_id": model_id[0]["id"],
        "ttype": "char",
        "store": True,
        "index": True,
    }])
    print(f"   create x_lp_lead_id -> {r}")

    nid = kw("crm.lead", "create", [{"name": "LP extref probe", "type": "opportunity",
                                     "x_lp_lead_id": "LP-20260810-ABC123"}])
    print(f"   create lead with x_lp_lead_id -> {nid}")

    found = kw("crm.lead", "search_read",
               [[["x_lp_lead_id", "=", "LP-20260810-ABC123"]], ["id", "name", "x_lp_lead_id"]])
    print(f"   search by x_lp_lead_id -> {found}")

    # message_post, for the audit trail in Odoo's own chatter
    if isinstance(nid, int):
        mp = kw("crm.lead", "message_post", [[nid]], {"body": "LP: qualified, score 78"})
        print(f"   message_post -> {mp}")

    # activity, for the SLA / next-action story
    acts = kw("mail.activity.type", "search_read", [[], ["id", "name"]], {"limit": 5})
    print(f"   activity types -> {acts}")

print("=" * 70)
print(json.dumps({"xmlrpc_alive": xmlrpc_alive, "jsonrpc_alive": jsonrpc_alive,
                  "web_session_alive": bool(session)}, indent=2))
