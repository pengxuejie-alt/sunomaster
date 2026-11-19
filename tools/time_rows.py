import importlib.util

spec = importlib.util.spec_from_file_location("deploy", r"D:\sunomaster\tools\deploy.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
client, env = mod.connect()
script = r"""
cd /opt/sunomaster/app
node --input-type=module <<'JS'
import fs from "fs";
import mysql from "mysql2/promise";
const env = Object.fromEntries(fs.readFileSync(".env","utf8").split(/\n/).filter(l=>l.includes("=")).map(l=>{const i=l.indexOf("="); return [l.slice(0,i), l.slice(i+1)];}));
const conn = await mysql.createConnection({
  host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT||3306), user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD||"", database: env.MYSQL_DATABASE, connectTimeout: 8000,
});
const [rows] = await conn.query("SELECT id, time, state, LEFT(REPLACE(info,'\\n',' '), 90) AS info FROM information_schema.processlist WHERE command <> 'Sleep' ORDER BY time DESC");
for (const row of rows) console.log([row.id, row.time, row.state, row.info].join(" | "));
const stuck = rows.filter(r => r.time > 20 && String(r.info||"").includes("music_trend_snapshot"));
for (const row of stuck) {
  await conn.query("KILL ?", [row.id]);
  console.log("killed", row.id, row.time);
}
await conn.end();
JS
"""
code, out, err = mod.run_cmd(client, script, env["PASSWORD"], timeout=40)
print(out)
print(err)
print("exit", code)
