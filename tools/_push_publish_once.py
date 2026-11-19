import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("deploy", r"D:\sunomaster\tools\deploy.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
client, env = mod.connect()
sftp = client.open_sftp()
files = (
    (r"D:\sunomaster\public\index.html", "/tmp/sunomaster-index.html"),
    (r"D:\sunomaster\public\publish.js", "/tmp/sunomaster-publish.js"),
    (r"D:\sunomaster\lib\publish.js", "/tmp/sunomaster-lib-publish.js"),
    (r"D:\sunomaster\lib\clip.js", "/tmp/sunomaster-lib-clip.js"),
)
for local, remote in files:
    with sftp.file(remote, "wb") as handle:
        handle.write(Path(local).read_bytes())
sftp.close()
script = r"""
cp /tmp/sunomaster-index.html /opt/sunomaster/app/public/index.html
cp /tmp/sunomaster-publish.js /opt/sunomaster/app/public/publish.js
cp /tmp/sunomaster-lib-publish.js /opt/sunomaster/app/lib/publish.js
cp /tmp/sunomaster-lib-clip.js /opt/sunomaster/app/lib/clip.js
rm -f /tmp/sunomaster-index.html /tmp/sunomaster-publish.js /tmp/sunomaster-lib-publish.js /tmp/sunomaster-lib-clip.js
if ! command -v ffmpeg >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y ffmpeg
fi
ffmpeg -version | head -n 1
systemctl restart sunomaster
sleep 2
systemctl is-active sunomaster
"""
code, out, err = mod.run_cmd(client, script, env["PASSWORD"], timeout=180)
print(out)
print(err)
print("exit", code)
client.close()
