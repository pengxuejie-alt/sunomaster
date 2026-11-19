import fs from "fs";
import mysql from "mysql2/promise";

const env = {};
for (const line of fs.readFileSync("/opt/sunomaster/app/.env", "utf8").split(/\n/)) {
  const i = line.indexOf("=");
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const pool = mysql.createPool({
  host: env.MYSQL_HOST,
  port: Number(env.MYSQL_PORT || 3306),
  user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD,
  database: env.MYSQL_DATABASE,
  connectTimeout: 8000,
  dateStrings: true,
});
const [rows] = await pool.query(`
  SELECT DATE(snapshot_date) AS d, chart_code, COUNT(*) AS n,
         SUM(rank_delta > 0) AS up,
         SUM(source_url LIKE 'http%') AS links
  FROM music_trend_snapshot
  WHERE platform = 'qishui'
    AND snapshot_date >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
  GROUP BY DATE(snapshot_date), chart_code
  ORDER BY d, chart_code
`);
console.log(JSON.stringify(rows));
await pool.end();
