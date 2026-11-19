import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("deploy", r"D:\sunomaster\tools\deploy.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
client, env = mod.connect()
sftp = client.open_sftp()
with sftp.file("/tmp/probe_qishui.js", "wb") as handle:
    handle.write(Path(r"D:\sunomaster\tools\probe_qishui.js").read_bytes())
sftp.close()
code, out, err = mod.run_cmd(
    client,
    "cp /tmp/probe_qishui.js /opt/sunomaster/app/probe_qishui.js && cd /opt/sunomaster/app && node probe_qishui.js; rm -f /opt/sunomaster/app/probe_qishui.js /tmp/probe_qishui.js",
    env["PASSWORD"],
    timeout=45,
)
print(out)
print(err)
print("exit", code)
client.close()
