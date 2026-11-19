import importlib.util

spec = importlib.util.spec_from_file_location("deploy", r"D:\sunomaster\tools\deploy.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
client, env = mod.connect()
script = r"""
sleep 20
journalctl -u sunomaster --since '3 min ago' --no-pager | grep dispatch || true
curl -sS -m 8 -H 'Host: 43.156.58.64' http://127.0.0.1/api/charts -o /tmp/charts.json -w 'charts %{http_code} %{time_total}\n' || true
python3 - <<'PY'
import json, os
p="/tmp/charts.json"
b=json.load(open(p)) if os.path.exists(p) and os.path.getsize(p) else {}
songs=b.get("newSongs") or []
print("pending", b.get("pending"), "headline", (b.get("insight") or {}).get("headline"))
print("counts", (b.get("insight") or {}).get("counts"))
print("n", len(songs), "rise", len(b.get("risingSongs") or []), "pot", len(b.get("potential") or []))
print("listen", sum(1 for s in songs if str(s.get("sourceUrl") or "").startswith("http")))
print("cover", sum(1 for s in songs if str(s.get("coverUrl") or "").startswith("http")))
PY
"""
code, out, err = mod.run_cmd(client, script, env["PASSWORD"], timeout=95)
print(out)
print(err)
print("exit", code)
