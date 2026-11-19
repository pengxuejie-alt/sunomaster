import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("deploy", r"D:\sunomaster\tools\deploy.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
client, env = mod.connect()
sftp = client.open_sftp()
for name, remote in (
    (r"D:\sunomaster\public\index.html", "/tmp/sunomaster-index.html"),
    (r"D:\sunomaster\public\app.js", "/tmp/sunomaster-app.js"),
    (r"D:\sunomaster\server.js", "/tmp/sunomaster-server.js"),
):
    with sftp.file(remote, "wb") as handle:
        handle.write(Path(name).read_bytes())
sftp.close()
script = r"""
cp /tmp/sunomaster-index.html /opt/sunomaster/app/public/index.html
cp /tmp/sunomaster-app.js /opt/sunomaster/app/public/app.js
cp /tmp/sunomaster-server.js /opt/sunomaster/app/server.js
systemctl restart sunomaster
sleep 1
curl -sS -m 8 -o /dev/null -w 'page %{http_code}\n' -H 'Host: 43.156.58.64' http://127.0.0.1/
"""
code, out, err = mod.run_cmd(client, script, env["PASSWORD"], timeout=30)
print(out)
print(err)
print("exit", code)
