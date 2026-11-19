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
const pool = mysql.createPool({
  host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT||3306), user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD||"", database: env.MYSQL_DATABASE,
  connectTimeout: 8000, dateStrings: true, connectionLimit: 2,
});
async function step(name, sql) {
  const t = Date.now();
  try {
    const [rows] = await pool.query(sql);
    const n = Array.isArray(rows) ? rows.length : 0;
    console.log(name, Date.now()-t, "ms", "rows", n, JSON.stringify(rows[0]||{}).slice(0,120));
  } catch (e) {
    console.log(name, "ERR", Date.now()-t, e.message);
  }
}
await step("ping", "SELECT 1 AS ok");
await step("overview", "SELECT (SELECT MAX(snapshot_date) FROM music_trend_snapshot WHERE platform='qq' AND snapshot_date >= DATE_SUB(CURDATE(), INTERVAL 3 DAY)) AS qq");
await step("playlist-max", "SELECT MAX(snapshot_date) AS d FROM music_playlist_track");
await step("playlist-count", "SELECT COUNT(*) AS n FROM music_playlist_track WHERE snapshot_date >= DATE_SUB((SELECT MAX(snapshot_date) FROM music_playlist_track), INTERVAL 2 DAY)");
await pool.end();
JS
"""
code, out, err = mod.run_cmd(client, script, env["PASSWORD"], timeout=120)
print(out)
print(err)
print("exit", code)
