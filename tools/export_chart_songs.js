import fs from "fs";
import mysql from "mysql2/promise";

const env = {};
function load(file) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!env[key]) env[key] = value;
  }
}
load("D:/sunomaster/.env");
load("C:/Users/XIAO KA/trend/.env.local");

const pool = mysql.createPool({
  host: env.MYSQL_HOST,
  port: Number(env.MYSQL_PORT || 3306),
  user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD || "",
  database: env.MYSQL_DATABASE,
  connectTimeout: 8000,
  dateStrings: true,
});

const PLATFORM_LABEL = {
  qq: "QQ音乐",
  netease: "网易云",
  kugou: "酷狗",
  qishui: "汽水",
  "haikui-tomato": "番茄星图",
  tomato: "番茄",
};
const PLATFORM_ORDER = ["qq", "netease", "kugou", "qishui", "haikui-tomato", "tomato"];
const SKIP_CHART = new Set(["hotsearch", "myplaylist", "haikuiplaylist", "热门搜索"]);
const CHART_LABEL = { stellar: "星耀榜" };

function nameKey(value) {
  return String(value || "")
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[·・.\s]/g, "")
    .toLowerCase();
}

function firstSinger(singer) {
  return nameKey(String(singer || "").split(/[、,&/／|]/)[0]);
}

function songKey(songName, singerName) {
  return `${nameKey(songName)}||${firstSinger(singerName)}`;
}

function clean(value) {
  return String(value || "").replace(/[\t\r\n]+/g, " ").trim();
}

function chartTitle(platform, chartName) {
  const label = PLATFORM_LABEL[platform] || platform;
  const name = clean(chartName);
  if (!name || name === label || name.startsWith(label)) return name || label;
  return `${label} · ${name}`;
}

const songs = new Map();
const chartNotes = [];

function addSong(entry) {
  const songName = clean(entry.songName);
  if (!songName) return;
  const singerName = clean(entry.singerName);
  const key = songKey(songName, singerName);
  let song = songs.get(key);
  if (!song) {
    song = {
      songName,
      singerName,
      charts: 0,
      bestRank: null,
      platforms: new Set(),
    };
    songs.set(key, song);
  }
  song.charts += 1;
  song.platforms.add(entry.platform);
  if (entry.rank > 0 && (song.bestRank == null || entry.rank < song.bestRank)) song.bestRank = entry.rank;
  if (singerName.length > song.singerName.length) song.singerName = singerName;
  if (songName.length < song.songName.length) song.songName = songName;
}

const platforms = ["qq", "netease", "kugou", "qishui", "haikui-tomato"];
for (const platform of platforms) {
  const [charts] = await pool.query(
    `
    SELECT chart_code, MAX(chart_name) AS name, MAX(snapshot_date) AS latest
    FROM music_trend_snapshot
    WHERE platform = ? AND snapshot_date >= DATE_SUB(NOW(), INTERVAL 14 DAY)
    GROUP BY chart_code
    `,
    [platform],
  );
  for (const chart of charts) {
    if (SKIP_CHART.has(String(chart.chart_code))) continue;
    const [rows] = await pool.query(
      `
      SELECT song_name, singer_name, rank_no
      FROM music_trend_snapshot
      WHERE platform = ? AND chart_code = ? AND snapshot_date = ?
      ORDER BY rank_no
      `,
      [platform, chart.chart_code, chart.latest],
    );
    const chartName = CHART_LABEL[chart.chart_code] || clean(chart.name) || chart.chart_code;
    chartNotes.push(`${chartTitle(platform, chartName)} ${chart.latest} ${rows.length}首`);
    for (const row of rows) {
      addSong({
        platform,
        songName: row.song_name,
        singerName: row.singer_name,
        rank: Number(row.rank_no) || 0,
      });
    }
  }
}

const [tomatoRows] = await pool.query(`
  SELECT rank_type, song_name, singer, created_at, id
  FROM tomato_music_ranking
  WHERE created_at >= DATE_SUB(NOW(), INTERVAL 5 DAY)
  ORDER BY rank_type, created_at, id
`);
const byType = new Map();
for (const row of tomatoRows) {
  const list = byType.get(row.rank_type) || [];
  list.push(row);
  byType.set(row.rank_type, list);
}
for (const [rankType, rows] of byType) {
  const batches = [];
  let batch = [];
  let prev = null;
  for (const row of rows) {
    const at = new Date(String(row.created_at).replace(" ", "T")).getTime();
    if (batch.length && prev != null && at - prev > 30 * 60 * 1000) {
      batches.push(batch);
      batch = [];
    }
    batch.push(row);
    prev = at;
  }
  if (batch.length) batches.push(batch);
  const latest = batches[batches.length - 1] || [];
  const stamp = latest.length ? String(latest[latest.length - 1].created_at).slice(0, 19) : "";
  chartNotes.push(`${chartTitle("tomato", rankType)} ${stamp} ${latest.length}首`);
  latest.forEach((row, index) => {
    addSong({
      platform: "tomato",
      songName: row.song_name,
      singerName: row.singer,
      rank: index + 1,
    });
  });
}

const list = [...songs.values()].sort((a, b) => {
  if (b.charts !== a.charts) return b.charts - a.charts;
  const ar = a.bestRank == null ? 9999 : a.bestRank;
  const br = b.bestRank == null ? 9999 : b.bestRank;
  if (ar !== br) return ar - br;
  return a.songName.localeCompare(b.songName, "zh");
});

const lines = [
  "各平台最新一期排行榜歌曲。同一首歌按歌名和首位歌手合并，只留一行。",
  "上榜数是这首歌出现在多少张榜上。最好名次是这些榜里最靠前的名次。",
  "不含搜索热榜、我的歌单、海葵歌单、汽水热门搜索。抖音挑战榜是挑战名，不是歌曲，也没有放进来。",
  `去重后 ${list.length} 首。`,
  "",
  "各榜快照：",
  ...chartNotes.map((note) => `- ${note}`),
  "",
  "歌名\t歌手\t上榜数\t最好名次\t平台",
  ...list.map((song) => {
    const platformsText = PLATFORM_ORDER.filter((id) => song.platforms.has(id)).map((id) => PLATFORM_LABEL[id]).join("、");
    return [song.songName, song.singerName, song.charts, song.bestRank ?? "", platformsText].join("\t");
  }),
  "",
];

const outPath = "D:/sunomaster/排行榜歌曲列表.txt";
fs.writeFileSync(outPath, `\uFEFF${lines.join("\r\n")}`, "utf8");
console.log("SONGS", list.length);
console.log("CHARTS", chartNotes.length);
console.log("FILE", outPath);

await pool.end();
