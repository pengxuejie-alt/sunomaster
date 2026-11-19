import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("deploy", r"D:\sunomaster\tools\deploy.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
client, env = mod.connect()
sftp = client.open_sftp()
for name, remote in (
    (r"D:\sunomaster\lib\dispatch.js", "/tmp/dispatch.js"),
    (r"D:\sunomaster\server.js", "/tmp/sunomaster-server.js"),
    (r"D:\sunomaster\public\app.js", "/tmp/sunomaster-app.js"),
):
    with sftp.file(remote, "wb") as handle:
        handle.write(Path(name).read_bytes())
sftp.close()
script = r"""
cp /tmp/dispatch.js /opt/sunomaster/app/lib/dispatch.js
cp /tmp/sunomaster-server.js /opt/sunomaster/app/server.js
cp /tmp/sunomaster-app.js /opt/sunomaster/app/public/app.js
systemctl kill --kill-who=all -s SIGKILL sunomaster || true
sleep 1
systemctl start sunomaster
sleep 2
curl -sS -m 8 -H 'Host: 43.156.58.64' http://127.0.0.1/api/health; echo
curl -sS -m 8 -H 'Host: 43.156.58.64' http://127.0.0.1/api/charts -o /tmp/charts.json -w 'charts %{http_code} %{time_total}\n' || true
python3 - <<'PY'
import json, os
p="/tmp/charts.json"
b=json.load(open(p)) if os.path.exists(p) and os.path.getsize(p) else {}
print("pending", b.get("pending"), "headline", (b.get("insight") or {}).get("headline"))
PY
"""
code, out, err = mod.run_cmd(client, script, env["PASSWORD"], timeout=110)
print(out)
print(err)
print("exit", code)
