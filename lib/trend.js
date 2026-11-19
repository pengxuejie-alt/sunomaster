import mysql from "mysql2/promise";

export const PLATFORMS = {
  qq: "QQ音乐",
  netease: "网易云",
  kugou: "酷狗",
  douyin: "抖音",
  qishui: "汽水",
  fanqie: "番茄",
};

export const PLATFORM_ORDER = ["qq", "netease", "kugou", "douyin", "qishui", "fanqie"];
const CHART_PIN = ["hot", "top500", "soar", "rising", "new", "index", "douyin", "shortvideo", "challenge", "stellar"];
const EXCLUDED = ["hotsearch", "myplaylist"];
export const CHART_NAMES = { stellar: "星耀榜" };

let pool;
let cache = { at: 0, data: null };
const CACHE_MS = 2 * 60 * 1000;

export function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST,
      port: Number(process.env.MYSQL_PORT || 3306),
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD || "",
      database: process.env.MYSQL_DATABASE,
      charset: "utf8mb4",
      timezone: "+08:00",
      dateStrings: true,
      waitForConnections: true,
      connectionLimit: 12,
      connectTimeout: 8000,
    });
  }
  return pool;
}

function pin(code) {
  const index = CHART_PIN.indexOf(code);
  return index === -1 ? CHART_PIN.length : index;
}

function singerName(platform, singer) {
  const raw = String(singer || "").trim();
  if (platform === "douyin" && /^\d+$/.test(raw)) return raw ? `使用 ${raw}` : "抖音";
  return raw || "未知歌手";
}

function sourceUrl(url, platform = "") {
  if (!url) return "";
  const parts = String(url).split("|||");
  const pick = (part) => {
    const match = String(part || "").match(/https?:\/\/[^\s]+/i);
    return match ? match[0] : "";
  };
  const page = pick(parts[0]);
  const audio = parts.length > 1 ? pick(parts[1]) : "";
  if (audio && (platform === "douyin" || /\.(mp3|m4a|aac)(\?|$)/i.test(audio) || /douyinstatic\.com/i.test(audio))) return audio;
  return page;
}

export async function pingTrend() {
  if (!process.env.MYSQL_HOST || !process.env.MYSQL_DATABASE) {
    return { ok: false, error: "没有读到 trend 的数据库配置。" };
  }
  const [rows] = await getPool().query("SELECT 1 AS ok");
  return { ok: Boolean(rows?.[0]?.ok) };
}

export async function loadCuration() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  const excluded = EXCLUDED.map(() => "?").join(",");
  const platforms = PLATFORM_ORDER.map(() => "?").join(",");
  const [rows] = await getPool().query(
    `
    SELECT s.platform, s.chart_code, s.chart_name, s.song_name, s.singer_name,
           s.rank_no, s.rank_delta, s.new_on_chart, s.cover_url, s.source_url, s.snapshot_date
    FROM music_trend_snapshot s
    INNER JOIN (
      SELECT platform, chart_code, MAX(snapshot_date) AS snapshot_date
      FROM music_trend_snapshot
      WHERE snapshot_date >= DATE_SUB(NOW(), INTERVAL 3 DAY)
        AND platform IN (${platforms})
        AND chart_code NOT IN (${excluded})
      GROUP BY platform, chart_code
    ) latest
      ON s.platform = latest.platform
     AND s.chart_code = latest.chart_code
     AND s.snapshot_date = latest.snapshot_date
    WHERE s.rank_no <= 8
    ORDER BY s.platform, s.chart_code, s.rank_no
    `,
    [...PLATFORM_ORDER, ...EXCLUDED],
  );

  const songs = rows.map((row, index) => {
    const platform = String(row.platform);
    const delta = row.rank_delta == null ? null : Number(row.rank_delta);
    return {
      id: `${platform}:${row.chart_code}:${row.rank_no}:${index}`,
      platform,
      platformLabel: PLATFORMS[platform] || platform,
      chartCode: String(row.chart_code),
      chartName: CHART_NAMES[String(row.chart_code)] || String(row.chart_name || row.chart_code),
      rank: Number(row.rank_no),
      delta: Number.isFinite(delta) ? delta : null,
      isNew: Number(row.new_on_chart) === 1,
      songName: String(row.song_name || "").trim(),
      singerName: singerName(platform, row.singer_name),
      coverUrl: row.cover_url || "",
      sourceUrl: sourceUrl(row.source_url, platform),
      snapshotAt: String(row.snapshot_date || ""),
    };
  }).filter((song) => song.songName);

  const seen = new Set();
  const charts = [];
  for (const song of songs) {
    const key = `${song.platform}:${song.chartCode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    charts.push({
      platform: song.platform,
      platformLabel: song.platformLabel,
      chartCode: song.chartCode,
      chartName: song.chartName,
      snapshotAt: song.snapshotAt,
    });
  }
  charts.sort((a, b) => {
    const platform = PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform);
    if (platform) return platform;
    return pin(a.chartCode) - pin(b.chartCode) || a.chartName.localeCompare(b.chartName, "zh");
  });

  const data = {
    ok: true,
    platforms: PLATFORM_ORDER.map((id) => ({ id, label: PLATFORMS[id] })),
    charts,
    songs,
    updatedAt: songs.reduce((max, song) => (song.snapshotAt > max ? song.snapshotAt : max), ""),
  };
  cache = { at: Date.now(), data };
  return data;
}
