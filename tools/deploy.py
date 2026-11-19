# -*- coding: utf-8 -*-
"""Upload SunoMaster and the two local engines, then start them behind nginx."""

from __future__ import annotations

import io
import os
import shlex
import sys
import tarfile
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parents[1]
HINT = Path(os.environ.get("HINT_DIR", r"D:\hint"))
LYRIC = Path(os.environ.get("LYRIC_ROOT", r"D:\lyricmaster"))
TREND_ENV = Path(os.environ.get("TREND_ENV", r"C:\Users\XIAO KA\trend\.env.local"))
REMOTE = "/opt/sunomaster"


def read_env(path: Path) -> dict:
    data = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        key, value = text.split("=", 1)
        data[key.strip()] = value.strip().strip('"').strip("'")
    return data


def should_pack(path: Path) -> bool:
    parts = set(path.parts)
    if parts & {"node_modules", ".git", "__pycache__", ".next"}:
        return False
    if path.name in {".deploy.env", ".env"}:
        return False
    if path.suffix in {".pyc", ".log"}:
        return False
    if path.name == "music.json":
        return False
    return True


def add_tree(tar: tarfile.TarFile, source: Path, prefix: str) -> None:
    if source.is_file():
        if should_pack(source):
            tar.add(source, arcname=f"{prefix}/{source.name}")
        return
    for path in source.rglob("*"):
        if not path.is_file() or not should_pack(path):
            continue
        rel = path.relative_to(source).as_posix()
        tar.add(path, arcname=f"{prefix}/{rel}")


def make_bundle() -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name in ("server.js", "package.json", "package-lock.json", "key.txt"):
            add_tree(tar, ROOT / name, "app")
        add_tree(tar, ROOT / "lib", "app/lib")
        add_tree(tar, ROOT / "public", "app/public")
        for name in ("server.js", "package.json", "package-lock.json"):
            add_tree(tar, HINT / name, "vendor/hint")
        add_tree(tar, LYRIC / "web", "vendor/lyricmaster/web")
        add_tree(tar, LYRIC / ".cursor" / "skills", "vendor/lyricmaster/.cursor/skills")
        if (LYRIC / "lyric").exists():
            add_tree(tar, LYRIC / "lyric", "vendor/lyricmaster/lyric")
    return buf.getvalue()


def mysql_env() -> str:
    found = read_env(TREND_ENV) if TREND_ENV.exists() else {}
    lines = [f"{key}={found[key]}" for key in ("MYSQL_HOST", "MYSQL_PORT", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE") if found.get(key)]
    lines.append("GEMINI_MODEL=gemini-3.8-flash")
    return "\n".join(lines) + "\n"


REMOTE_SCRIPT = r"""
set -e
export DEBIAN_FRONTEND=noninteractive
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  apt-get update -y
  apt-get install -y ca-certificates curl xz-utils
  curl -fsSL https://nodejs.org/dist/v22.21.0/node-v22.21.0-linux-x64.tar.xz -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
fi
apt-get update -y
apt-get install -y python3 nginx
mkdir -p /opt/sunomaster
tar -xzf /tmp/sunomaster.tgz -C /opt/sunomaster
cd /opt/sunomaster/app
npm install --omit=dev
cd /opt/sunomaster/vendor/hint
npm install --omit=dev
cat > /etc/systemd/system/sunomaster.service << 'EOF'
[Unit]
Description=SunoMaster
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/sunomaster/app
Environment=NODE_ENV=production
Environment=PORT=3800
Environment=HOST=127.0.0.1
Environment=PYTHON=python3
Environment=HINT_DIR=/opt/sunomaster/vendor/hint
Environment=LYRIC_DIR=/opt/sunomaster/vendor/lyricmaster/web
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=/opt/sunomaster/app/.env
ExecStart=/usr/bin/env node /opt/sunomaster/app/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
if [ -f /etc/nginx/sites-available/sunomaster ] && grep -q "managed by Certbot" /etc/nginx/sites-available/sunomaster; then
  echo "keep existing sunomaster nginx site"
else
cat > /etc/nginx/sites-available/sunomaster << 'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name sunomaster.xyz www.sunomaster.xyz 43.156.58.64;
    client_max_body_size 40m;
    location / {
        proxy_pass http://127.0.0.1:3800;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 180s;
    }
}
EOF
fi
ln -sfn /etc/nginx/sites-available/sunomaster /etc/nginx/sites-enabled/sunomaster
if [ -f /tmp/sunomaster.env ]; then
  mv /tmp/sunomaster.env /opt/sunomaster/app/.env
  chmod 600 /opt/sunomaster/app/.env
fi
nginx -t
systemctl daemon-reload
systemctl enable sunomaster
systemctl restart sunomaster
systemctl reload nginx
sleep 5
systemctl is-active sunomaster
curl -sS -H 'Host: 43.156.58.64' http://127.0.0.1/api/health || true
echo
python3 - << 'PY'
import json
import urllib.request
from pathlib import Path
key = Path("/opt/sunomaster/app/key.txt").read_text(encoding="utf-8").strip()
body = json.dumps({
    "contents": [{"role": "user", "parts": [{"text": "Reply with the single word ok."}]}],
    "generationConfig": {"maxOutputTokens": 64, "thinkingConfig": {"thinkingLevel": "low"}},
}).encode()
req = urllib.request.Request(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
    data=body,
    headers={"Content-Type": "application/json", "x-goog-api-key": key},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=40) as response:
        raw = response.read().decode("utf-8", errors="replace")
        print("gemini", response.status)
        print(raw.replace(key, "***")[:300])
except Exception as exc:
    detail = str(exc).replace(key, "***")
    if hasattr(exc, "read"):
        detail += " " + exc.read().decode("utf-8", errors="replace").replace(key, "***")[:300]
    print("gemini-error", detail[:400])
PY
"""


def connect():
    env = read_env(ROOT / ".deploy.env")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        env["HOST"],
        port=int(env.get("PORT") or 22),
        username=env["USER"],
        password=env["PASSWORD"],
        timeout=25,
        allow_agent=False,
        look_for_keys=False,
    )
    return client, env


def run_cmd(client, command, password, timeout=60):
    stdin, stdout, stderr = client.exec_command(f"sudo -S -p '' bash -lc {shlex.quote(command)}", timeout=timeout)
    stdin.write(password + "\n")
    stdin.flush()
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    err = "\n".join(line for line in err.splitlines() if line.strip() and password.strip() not in line)
    return code, out, err


def run(client, command, password, timeout=900):
    stdin, stdout, stderr = client.exec_command(f"sudo -S -p '' bash {command}", timeout=timeout)
    stdin.write(password + "\n")
    stdin.flush()
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    secret = password.strip()
    err = "\n".join(line for line in err.splitlines() if line.strip() and secret not in line)
    return code, out, err


def main():
    client, env = connect()
    if "--probe" in sys.argv:
        code, out, err = run_cmd(client, "uname -a; node -v || true; python3 --version || true; nginx -v || true; ss -lntp | head -n 40 || true", env["PASSWORD"], timeout=60)
        print(out)
        print(err)
        print("exit", code)
        return
    payload = make_bundle()
    print(f"bundle {len(payload) / 1024 / 1024:.1f} MB")
    sftp = client.open_sftp()
    with sftp.file("/tmp/sunomaster.tgz", "wb") as handle:
        handle.write(payload)
    with sftp.file("/tmp/sunomaster.env", "wb") as handle:
        handle.write(mysql_env().encode("utf-8"))
    with sftp.file("/tmp/sunomaster-setup.sh", "wb") as handle:
        handle.write(REMOTE_SCRIPT.replace("\r\n", "\n").encode("utf-8"))
    sftp.close()
    code, out, err = run(client, "/tmp/sunomaster-setup.sh", env["PASSWORD"], timeout=900)
    print(out[-5000:])
    print(err[-2000:])
    if code != 0:
        raise SystemExit(code)


if __name__ == "__main__":
    main()
