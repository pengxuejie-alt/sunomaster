import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("deploy", ROOT / "tools" / "deploy.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

client, deploy_env = mod.connect()
sftp = client.open_sftp()
for local, remote in (
    (ROOT / "public" / "app.js", "/tmp/sunomaster-app.js"),
    (ROOT / "lib" / "billing.js", "/tmp/sunomaster-billing.js"),
):
    with sftp.file(remote, "wb") as handle:
        handle.write(local.read_bytes())

local_env = mod.read_env(ROOT / ".env")
with sftp.file("/opt/sunomaster/app/.env", "rb") as handle:
    remote_text = handle.read().decode("utf-8")

for key in ("STRIPE_CREDITS_PRICE_ID_HKD", "STRIPE_EBOOK_PRICE_ID_HKD"):
    value = local_env.get(key)
    if not value:
        continue
    lines = remote_text.splitlines()
    replaced = False
    for index, line in enumerate(lines):
        if line.startswith(f"{key}="):
            lines[index] = f"{key}={value}"
            replaced = True
            break
    if not replaced:
        lines.append(f"{key}={value}")
    remote_text = "\n".join(lines) + "\n"

with sftp.file("/tmp/sunomaster.env", "wb") as handle:
    handle.write(remote_text.encode("utf-8"))
sftp.close()

script = r"""
install -m 0644 /tmp/sunomaster-app.js /opt/sunomaster/app/public/app.js
install -m 0644 /tmp/sunomaster-billing.js /opt/sunomaster/app/lib/billing.js
install -m 0600 /tmp/sunomaster.env /opt/sunomaster/app/.env
systemctl restart sunomaster
sleep 2
systemctl is-active sunomaster
curl -sS -m 8 -H 'Host: 43.156.58.64' http://127.0.0.1/api/health
"""
code, out, err = mod.run_cmd(client, script, deploy_env["PASSWORD"], timeout=45)
client.close()
print(out)
print(err)
print("exit", code)
raise SystemExit(code)
