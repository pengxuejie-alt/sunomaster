import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("deploy", r"D:\sunomaster\tools\deploy.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
client, env = mod.connect()
sftp = client.open_sftp()
files = {
    r"D:\sunomaster\public\app.js": "/tmp/sunomaster-app.js",
    r"D:\sunomaster\lib\dispatch.js": "/tmp/sunomaster-dispatch.js",
    r"D:\sunomaster\lib\trend.js": "/tmp/sunomaster-trend.js",
}
for local, remote in files.items():
    with sftp.file(remote, "wb") as handle:
        handle.write(Path(local).read_bytes())
sftp.close()
script = r"""
cp /tmp/sunomaster-app.js /opt/sunomaster/app/public/app.js
cp /tmp/sunomaster-dispatch.js /opt/sunomaster/app/lib/dispatch.js
cp /tmp/sunomaster-trend.js /opt/sunomaster/app/lib/trend.js
systemctl restart sunomaster
sleep 2
systemctl is-active sunomaster
curl -sS -m 8 -o /dev/null -w 'page %{http_code}\n' -H 'Host: 43.156.58.64' http://127.0.0.1/
"""
code, out, err = mod.run_cmd(client, script, env["PASSWORD"], timeout=40)
print(out)
print(err)
print("exit", code)
client.close()
