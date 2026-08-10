"""Find which Odoo API surface is actually alive on a demo.odoo.com database.

/xmlrpc/2/common answered 404 on a saas-193 build, so probe every candidate:
  1. /xmlrpc/2/common      legacy XML-RPC (documented, being removed)
  2. /xmlrpc/common        XML-RPC v1
  3. /jsonrpc              JSON-RPC (documented, being removed)
  4. /web/session/authenticate + /web/dataset/call_kw   the web client's own API
  5. /json/2/<model>/<method>   the new JSON-2 API (Odoo 19+)
"""
import json
import ssl
import urllib.error
import urllib.request
import xmlrpc.client

ctx = ssl.create_default_context()

info = xmlrpc.client.ServerProxy("https://demo.odoo.com/start", context=ctx).start()
URL, DB, USER, PW = info["host"], info["database"], info["user"], info["password"]
print(f"host={URL}\ndb={DB}\nuser={USER}\npw={PW}\n")


def http(path, payload=None, headers=None, method=None, cookie=None):
    """Returns (status, body_text, set_cookie)."""
    url = URL + path
    data = json.dumps(payload).encode() if payload is not None else None
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    if cookie:
        h["Cookie"] = cookie
    req = urllib.request.Request(url, data=data, headers=h, method=method or ("POST" if data else "GET"))
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=60) as r:
            return r.status, r.read().decode()[:1200], r.headers.get("Set-Cookie")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:600], e.headers.get("Set-Cookie")
    except Exception as e:
        return None, f"{type(e).__name__}: {e}", None


print("=" * 70)
print("1. XML-RPC /xmlrpc/2/common")
for p in ("/xmlrpc/2/common", "/xmlrpc/common"):
    try:
        v = xmlrpc.client.ServerProxy(URL + p, context=ctx).version()
        print(f"   {p} -> OK {v}")
    except Exception as e:
        print(f"   {p} -> {type(e).__name__}: {str(e)[:120]}")

print("=" * 70)
print("2. JSON-RPC /jsonrpc")
st, body, _ = http(
    "/jsonrpc",
    {
        "jsonrpc": "2.0",
        "method": "call",
        "params": {"service": "common", "method": "version", "args": []},
        "id": 1,
    },
)
print(f"   status={st}\n   {body[:400]}")

print("=" * 70)
print("3. /web/session/authenticate")
st, body, cookie = http(
    "/web/session/authenticate",
    {"jsonrpc": "2.0", "method": "call", "params": {"db": DB, "login": USER, "password": PW}},
)
print(f"   status={st}  cookie={'yes' if cookie else 'no'}")
try:
    parsed = json.loads(body)
    res = parsed.get("result") or {}
    print(f"   uid={res.get('uid')}  name={res.get('name')}  version={res.get('server_version')}")
    if parsed.get("error"):
        print(f"   error={json.dumps(parsed['error'])[:400]}")
except Exception:
    print(f"   raw={body[:400]}")

session = cookie.split(";")[0] if cookie else None

if session:
    print("=" * 70)
    print("4. /web/dataset/call_kw  (read, create, write)")

    def kw(model, method, args, kwargs=None):
        st, body, _ = http(
            "/web/dataset/call_kw",
            {
                "jsonrpc": "2.0",
                "method": "call",
                "params": {
                    "model": model,
                    "method": method,
                    "args": args,
                    "kwargs": kwargs or {},
                },
            },
            cookie=session,
        )
        try:
            p = json.loads(body)
        except Exception:
            return st, {"raw": body[:300]}
        if "error" in p:
            return st, {"error": p["error"].get("data", {}).get("message") or p["error"].get("message")}
        return st, p.get("result")

    st, r = kw("crm.lead", "search_count", [[]])
    print(f"   search_count crm.lead -> {st} {r}")

    st, stages = kw(
        "crm.stage", "search_read", [[], ["id", "name", "sequence", "is_won"]], {"limit": 20}
    )
    print(f"   crm.stage search_read -> {st}")
    if isinstance(stages, list):
        for s in stages:
            print(f"      {s['id']:>4} seq={s.get('sequence')} won={s.get('is_won')} {s['name']}")

    st, new_id = kw(
        "crm.lead",
        "create",
        [
            {
                "name": "LP probe - delete me",
                "contact_name": "Probe Contact",
                "email_from": "probe@example.com",
                "phone": "+201000000000",
                "type": "opportunity",
            }
        ],
    )
    print(f"   CREATE crm.lead -> {st} {new_id}")

    if isinstance(new_id, int):
        st, w = kw("crm.lead", "write", [[new_id], {"priority": "3", "ref": "LP-TEST-0001"}])
        print(f"   WRITE priority+ref -> {st} {w}")

        st, found = kw(
            "crm.lead", "search_read", [[["ref", "=", "LP-TEST-0001"]], ["id", "name", "ref"]]
        )
        print(f"   SEARCH by ref -> {st} {found}")

        if isinstance(stages, list) and stages:
            st, w = kw("crm.lead", "write", [[new_id], {"stage_id": stages[-1]["id"]}])
            print(f"   WRITE stage_id -> {st} {w}")

        st, sid = kw("crm.stage", "create", [{"name": "LP Manual Review", "sequence": 25}])
        print(f"   CREATE crm.stage -> {st} {sid}")

print("=" * 70)
print("5. JSON-2 API /json/2/<model>/<method>")
for auth_hdr in ({"Authorization": f"Bearer {PW}"}, {"X-Api-Key": PW}):
    st, body, _ = http(
        "/json/2/crm.lead/search_count",
        {"domain": []},
        headers={**auth_hdr, "X-Odoo-Database": DB},
    )
    print(f"   {list(auth_hdr)[0]} -> status={st}  {body[:250]}")
