import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { CHART_NAMES, PLATFORM_ORDER, PLATFORMS, getPool } from "./trend.js";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheFile = path.join(rootDir, "data", "dispatch-cache.json");
const snapshotFile = path.join(rootDir, "public", "hot.json");

const EXCLUDED_SQL = "'hotsearch','myplaylist','stellar'";
const MAINSTREAM = new Set(["hot", "top500", "index"]);
const COPY = {
  points: "用近七日各平台歌曲榜归纳今日结论。",
  new: "近七日才出现在歌曲榜上的歌。已经在热歌榜或 TOP500 上的不列入。优先看多平台同时新上，以及近七日第一次出现的。",
  rising: "同一平台内，近七日名次升幅最大的歌。升幅大、覆盖榜多、现在名次更靠前的排前面。",
  potential: "已经有扩散、但还没进入热歌前 10。按新歌未破、指数先涨、歌单渗透、抖音领先、多平台露头计分，命中越多越靠前。近两日热歌 / TOP500 / 指数榜前 10 直接排除。",
  heat: "先按平台看新上和上升，再点进某张榜看当期前列。",
};

const diskCache = readCachedDispatch();
let cache = { at: diskCache.at, data: diskCache.data };
let refreshing = null;
const CACHE_MS = 30 * 60 * 1000;

function readCachedDispatch() {
  try {
    const stat = fs.statSync(cacheFile);
    const saved = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (saved && saved.ok && saved.insight) {
      delete saved.refreshing;
      return { data: saved, at: stat.mtimeMs };
    }
  } catch {
    /* 还没有落地的榜单 */
  }
  return { data: null, at: 0 };
}

function ymd(value) {
  return String(value || "").slice(0, 10);
}

function addDays(date, days) {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d));
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function dateSpan(start, end) {
  const days = [];
  for (let day = start; day && day <= end && days.length < 8; day = addDays(day, 1)) days.push(day);
  return days;
}

function stampKey(value) {
  return String(value || "").replace("T", " ").slice(0, 19);
}

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

function singerName(platform, singer) {
  const raw = String(singer || "").trim();
  if (platform === "douyin" && /^\d+$/.test(raw)) return raw ? `使用 ${raw}` : "抖音";
  return raw || "未知歌手";
}

function personName(singer) {
  const raw = String(singer || "").trim();
  if (!raw || raw === "未知歌手" || raw === "抖音" || raw === "歌手待补") return "";
  if (/^\d+$/.test(raw) || /^使用 \d+$/.test(raw)) return "";
  return raw;
}

function useCount(singer) {
  const raw = String(singer || "").trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  const match = raw.match(/^使用 (\d+)$/);
  return match ? Number(match[1]) : 0;
}

function pickSinger(rows, display) {
  for (const row of rows) {
    const person = personName(row.singerName);
    if (person) return person;
  }
  let best = 0;
  for (const row of rows) best = Math.max(best, useCount(row.singerName));
  if (best) return `使用 ${best}`;
  return singerName(display.platform, display.singerName);
}

function chartName(code, name) {
  return CHART_NAMES[code] || name || code;
}

function linkIn(part) {
  const match = String(part || "").match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : "";
}

function isAudioLink(url) {
  return /\.(mp3|m4a|aac)(\?|$)/i.test(url || "") || /douyinstatic\.com/i.test(url || "");
}

function sourceUrl(url, platform = "") {
  if (!url) return "";
  const parts = String(url).split("|||");
  const page = linkIn(parts[0]);
  const audio = parts.length > 1 ? linkIn(parts[1]) : "";
  if (audio && (platform === "douyin" || isAudioLink(audio))) return audio;
  return page;
}

function httpCover(url) {
  return /^https?:\/\//i.test(url || "") ? String(url) : "";
}

function qqSongUrl(id) {
  const clean = String(id || "").trim();
  if (!/^[0-9A-Za-z]{14}$/.test(clean)) return "";
  return `https://y.qq.com/n/ryqq/songDetail/${clean}`;
}

async function backfillQishuiSources(songs) {
  const missing = songs.filter((song) => !song.sourceUrl && song.songName);
  if (!missing.length) return;
  const names = [...new Set(missing.map((song) => song.songName))];
  const pool = getPool();
  const [rows] = await pool.query(
    `
    SELECT song_name, source_url
    FROM music_trend_snapshot
    WHERE platform = 'qishui'
      AND song_name IN (${names.map(() => "?").join(",")})
      AND source_url LIKE '%http%'
      AND snapshot_date >= DATE_SUB(CURDATE(), INTERVAL 21 DAY)
    ORDER BY snapshot_date DESC, id DESC
    `,
    names,
  );
  const found = new Map();
  for (const row of rows) {
    const name = String(row.song_name || "").trim();
    if (found.has(name)) continue;
    const url = sourceUrl(row.source_url);
    if (url) found.set(name, url);
  }
  for (const song of missing) song.sourceUrl = found.get(song.songName) || song.sourceUrl;
}

function betterCover(current, next) {
  if (!current) return next || "";
  if (!next) return current;
  if (current.startsWith("http://") && next.startsWith("https://")) return next;
  return current;
}

function betterSource(current, next) {
  if (!current) return next || "";
  if (!next) return current;
  if (isAudioLink(next) && !isAudioLink(current)) return next;
  return current;
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function overview() {
  const pool = getPool();
  const [rows] = await pool.query(`
    SELECT MAX(snapshot_date) AS ts
    FROM music_trend_snapshot
    WHERE snapshot_date >= DATE_SUB(CURDATE(), INTERVAL 3 DAY)
      AND (
        platform IN ('qq', 'netease', 'kugou')
        OR (platform = 'douyin' AND chart_code = 'challenge')
      )
  `);
  const collectedAt = rows[0] && rows[0].ts ? String(rows[0].ts) : "";
  const latestDate = collectedAt ? ymd(collectedAt) : ymd(new Date());
  return { latestDate, windowStart: addDays(latestDate, -6), collectedAt };
}

async function dailyShots(platform, start, end, chartCode) {
  const pool = getPool();
  const chartSql = chartCode ? "AND chart_code = ?" : `AND chart_code NOT IN (${EXCLUDED_SQL})`;
  const params = chartCode ? [platform, start, end, chartCode] : [platform, start, end];
  const [rows] = await pool.query(
    `
    SELECT chart_code, MAX(snapshot_date) AS max_ts
    FROM music_trend_snapshot
    WHERE platform = ?
      AND snapshot_date >= ?
      AND snapshot_date < DATE_ADD(?, INTERVAL 1 DAY)
      ${chartSql}
    GROUP BY chart_code, DATE(snapshot_date)
    `,
    params,
  );
  return rows;
}

function edgeShots(shots) {
  const byChart = new Map();
  for (const shot of shots) {
    const code = String(shot.chart_code);
    const item = byChart.get(code);
    if (!item) {
      byChart.set(code, { early: shot, late: shot });
      continue;
    }
    if (String(shot.max_ts) < String(item.early.max_ts)) item.early = shot;
    if (String(shot.max_ts) > String(item.late.max_ts)) item.late = shot;
  }
  const out = [];
  for (const item of byChart.values()) {
    out.push(item.late);
    if (String(item.early.max_ts) !== String(item.late.max_ts)) out.push(item.early);
  }
  return out;
}

function chartClause(platform, chartCode) {
  if (chartCode) return { sql: "AND chart_code = ?", params: [chartCode] };
  const skips = ["hotsearch", "myplaylist", "stellar"];
  if (platform === "qishui") skips.push("热门搜索");
  return { sql: `AND chart_code NOT IN (${skips.map(() => "?").join(",")})`, params: skips };
}

async function loadPlatformRows(platform, day, chartCode, withMedia) {
  const pool = getPool();
  const chart = chartClause(platform, chartCode);
  const chartSql = chart.sql;
  const bound = [platform, day, day, ...chart.params];
  const [stamp] = await pool.query(
    `
    SELECT MAX(snapshot_date) AS max_ts
    FROM music_trend_snapshot
    WHERE platform = ?
      AND snapshot_date >= ?
      AND snapshot_date < DATE_ADD(?, INTERVAL 1 DAY)
      ${chartSql}
    `,
    bound,
  );
  const ts = stamp[0] && stamp[0].max_ts;
  if (!ts) return [];
  const params = [platform, ts, ...chart.params];
  const [rows] = await pool.query(
    `
    SELECT DATE(snapshot_date) AS d, platform, chart_code, chart_name, song_name, singer_name,
           rank_no, prev_rank_no, rank_delta, new_on_chart, cover_url
           ${withMedia ? ", source_url" : ""}
    FROM music_trend_snapshot
    WHERE platform = ? AND snapshot_date = ? ${chartSql}
    `,
    params,
  );
  const songs = rows.map((row) => ({
    d: ymd(row.d),
    platform: String(row.platform),
    chartCode: String(row.chart_code),
    chartName: chartName(String(row.chart_code), String(row.chart_name || "")),
    songName: String(row.song_name || "").trim(),
    singerName: row.singer_name,
    rank: Number(row.rank_no),
    prevRank: num(row.prev_rank_no),
    delta: num(row.rank_delta),
    isNew: Number(row.new_on_chart) === 1,
    coverUrl: /^https?:\/\//i.test(row.cover_url || "") ? String(row.cover_url) : "",
    sourceUrl: withMedia ? sourceUrl(row.source_url, platform) : "",
  })).filter((row) => row.songName);
  if (platform === "qishui" && withMedia) await backfillQishuiSources(songs);
  return songs;
}

async function loadSpanRows(platform, start, end) {
  const pool = getPool();
  const chart = chartClause(platform, platform === "douyin" ? "challenge" : "");
  const [shots] = await pool.query(
    `
    SELECT chart_code, MAX(snapshot_date) AS max_ts
    FROM music_trend_snapshot
    WHERE platform = ?
      AND snapshot_date >= ?
      AND snapshot_date < DATE_ADD(?, INTERVAL 1 DAY)
      ${chart.sql}
    GROUP BY chart_code, DATE(snapshot_date)
    `,
    [platform, start, end, ...chart.params],
  );
  if (!shots.length) return [];
  const times = [...new Set(shots.map((shot) => stampKey(shot.max_ts)))];
  const codes = [...new Set(shots.map((shot) => String(shot.chart_code)))];
  const wanted = new Set(shots.map((shot) => `${shot.chart_code}|${stampKey(shot.max_ts)}`));
  const [rows] = await pool.query(
    `
    SELECT DATE(snapshot_date) AS d, snapshot_date, platform, chart_code, chart_name, song_name, singer_name,
           rank_no, prev_rank_no, rank_delta, new_on_chart, cover_url, source_url
    FROM music_trend_snapshot
    WHERE platform = ?
      AND snapshot_date IN (${times.map(() => "?").join(",")})
      AND chart_code IN (${codes.map(() => "?").join(",")})
    `,
    [platform, ...times, ...codes],
  );
  const songs = rows.filter((row) => wanted.has(`${row.chart_code}|${stampKey(row.snapshot_date)}`)).map((row) => ({
    d: ymd(row.d),
    platform: String(row.platform),
    chartCode: String(row.chart_code),
    chartName: chartName(String(row.chart_code), String(row.chart_name || "")),
    songName: String(row.song_name || "").trim(),
    singerName: row.singer_name,
    rank: Number(row.rank_no),
    prevRank: num(row.prev_rank_no),
    delta: num(row.rank_delta),
    isNew: Number(row.new_on_chart) === 1,
    coverUrl: /^https?:\/\//i.test(row.cover_url || "") ? String(row.cover_url) : "",
    sourceUrl: sourceUrl(row.source_url, platform),
  })).filter((row) => row.songName);
  if (platform === "qishui") {
    let latest = "";
    for (const song of songs) if (song.d > latest) latest = song.d;
    await backfillQishuiSources(songs.filter((song) => song.d === latest));
  }
  return songs;
}

async function songsForShots(platform, shots) {
  const edges = edgeShots(shots);
  if (!edges.length) return [];
  const pool = getPool();
  const wanted = new Set(edges.map((shot) => `${shot.chart_code}|${String(shot.max_ts).slice(0, 19)}`));
  const uniqueTimes = [...new Set([...wanted].map((key) => key.split("|")[1]))];
  const codes = [...new Set(edges.map((shot) => String(shot.chart_code)))];
  const [rows] = await pool.query(
    `
    SELECT DATE(snapshot_date) AS d, snapshot_date, platform, chart_code, chart_name, song_name, singer_name,
           rank_no, prev_rank_no, rank_delta, new_on_chart
    FROM music_trend_snapshot
    WHERE platform = ?
      AND snapshot_date IN (${uniqueTimes.map(() => "?").join(",")})
      AND chart_code IN (${codes.map(() => "?").join(",")})
    `,
    [platform, ...uniqueTimes, ...codes],
  );
  const picked = rows.filter((row) => wanted.has(`${row.chart_code}|${String(row.snapshot_date).replace("T", " ").slice(0, 19)}`));
  return picked.map((row) => ({
    d: ymd(row.d),
    platform: String(row.platform),
    chartCode: String(row.chart_code),
    chartName: chartName(String(row.chart_code), String(row.chart_name || "")),
    songName: String(row.song_name || "").trim(),
    singerName: row.singer_name,
    rank: Number(row.rank_no),
    prevRank: num(row.prev_rank_no),
    delta: num(row.rank_delta),
    isNew: Number(row.new_on_chart) === 1,
    coverUrl: "",
    sourceUrl: "",
  })).filter((row) => row.songName);
}

function chartHits(rows) {
  const latest = new Map();
  for (const row of rows) {
    const prev = latest.get(row.chartCode);
    if (!prev || row.d > prev.d || (row.d === prev.d && row.rank < prev.rank)) latest.set(row.chartCode, row);
  }
  return [...latest.values()]
    .map((row) => ({
      chartCode: row.chartCode,
      chartName: row.chartName,
      rank: row.rank,
      delta: row.delta,
      isNew: row.isNew,
    }))
    .sort((a, b) => a.rank - b.rank);
}

function pickCover(rows) {
  return rows.reduce((best, row) => betterCover(best, row.coverUrl), "");
}

function pickSource(rows) {
  return rows.find((row) => row.sourceUrl)?.sourceUrl || "";
}

function latestDayByPlatform(rows) {
  const days = new Map();
  for (const row of rows) {
    const prev = days.get(row.platform);
    if (!prev || row.d > prev) days.set(row.platform, row.d);
  }
  return days;
}

function analyzeNew(rows, latestDate) {
  const latestDay = latestDayByPlatform(rows);
  const established = new Set();
  for (const row of rows) {
    if (!MAINSTREAM.has(row.chartCode)) continue;
    const title = nameKey(row.songName);
    if (!title) continue;
    if (row.d < latestDate || row.rank <= 20) established.add(title);
  }
  const grouped = new Map();
  for (const row of rows) {
    const key = songKey(row.songName, row.singerName);
    const list = grouped.get(key) || [];
    list.push(row);
    grouped.set(key, list);
  }
  const songs = [];
  for (const [key, allRows] of grouped) {
    const todayRows = allRows.filter((row) => row.d === latestDay.get(row.platform));
    if (!todayRows.length) continue;
    const byPlatform = new Map();
    for (const row of allRows) {
      const list = byPlatform.get(row.platform) || [];
      list.push(row);
      byPlatform.set(row.platform, list);
    }
    const platforms = [];
    for (const [platform, platformRows] of byPlatform) {
      const dates = [...new Set(platformRows.map((row) => row.d))].sort();
      const platformToday = latestDay.get(platform);
      const latestRows = platformRows.filter((row) => row.d === platformToday);
      if (!latestRows.length) continue;
      const isDebut = dates[0] === platformToday;
      const hasChartNew = latestRows.some((row) => row.isNew);
      if (!isDebut && !hasChartNew) continue;
      platforms.push({
        platform,
        label: PLATFORMS[platform] || platform,
        isDebut,
        bestRank: Math.min(...latestRows.map((row) => row.rank)),
        charts: chartHits(latestRows),
      });
    }
    if (!platforms.length) continue;
    const display = todayRows[0];
    if (established.has(nameKey(display.songName))) continue;
    songs.push({
      id: key,
      songName: display.songName,
      singerName: pickSinger(allRows, display),
      coverUrl: pickCover(todayRows),
      sourceUrl: pickSource(todayRows),
      platforms,
      platformCount: platforms.length,
      bestRank: Math.min(...platforms.map((item) => item.bestRank)),
      isMultiPlatform: platforms.length > 1,
      isDebut: platforms.some((item) => item.isDebut),
    });
  }
  songs.sort((a, b) => {
    if (a.isMultiPlatform !== b.isMultiPlatform) return a.isMultiPlatform ? -1 : 1;
    if (a.isDebut !== b.isDebut) return a.isDebut ? -1 : 1;
    if (a.platformCount !== b.platformCount) return b.platformCount - a.platformCount;
    return a.bestRank - b.bestRank;
  });
  return songs;
}

function analyzeRising(rows, latestDate) {
  const latestDay = latestDayByPlatform(rows);
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.platform}||${songKey(row.songName, row.singerName)}`;
    const list = grouped.get(key) || [];
    list.push(row);
    grouped.set(key, list);
  }
  const songs = [];
  for (const [key, allRows] of grouped) {
    const platformToday = latestDay.get(allRows[0].platform) || latestDate;
    const todayRows = allRows.filter((row) => row.d === platformToday);
    if (!todayRows.length) continue;
    const dates = [...new Set(allRows.map((row) => row.d))].sort();
    const oldestDate = dates[0];
    const oldestRows = allRows.filter((row) => row.d === oldestDate);
    const todayCharts = new Set(todayRows.map((row) => row.chartCode));
    const oldestCharts = new Set(oldestRows.map((row) => row.chartCode));
    const maxDelta = Math.max(0, ...todayRows.map((row) => row.delta || 0));
    const bestRankToday = Math.min(...todayRows.map((row) => row.rank));
    const bestRankOldest = oldestDate === platformToday ? null : Math.min(...oldestRows.map((row) => row.rank));
    const rankImprove = bestRankOldest == null ? 0 : Math.max(0, bestRankOldest - bestRankToday);
    const chartGrowth = todayCharts.size - oldestCharts.size;
    if (!(maxDelta > 0 || rankImprove > 0 || chartGrowth > 0)) continue;
    let score = maxDelta * 2 + rankImprove * 1.5 + todayCharts.size * 12 + Math.max(chartGrowth, 0) * 22;
    if (bestRankToday <= 3) score += 36;
    else if (bestRankToday <= 10) score += 22;
    else if (bestRankToday <= 30) score += 10;
    const display = [...todayRows].sort((a, b) => a.rank - b.rank)[0];
    songs.push({
      id: key,
      platform: display.platform,
      platformLabel: PLATFORMS[display.platform] || display.platform,
      songName: display.songName,
      singerName: pickSinger(allRows, display),
      coverUrl: pickCover(todayRows),
      sourceUrl: pickSource(todayRows),
      score: Math.round(score),
      maxDelta,
      bestRankToday,
      bestRankOldest,
      chartCount: todayCharts.size,
      charts: chartHits(todayRows),
    });
  }
  songs.sort((a, b) => b.score - a.score || b.maxDelta - a.maxDelta || a.bestRankToday - b.bestRankToday);
  return songs;
}

function insight(newSongs, risingSongs, meta) {
  const multi = newSongs.filter((song) => song.isMultiPlatform);
  const debuts = newSongs.filter((song) => song.isDebut);
  const byPlatform = new Map();
  for (const song of risingSongs) {
    const list = byPlatform.get(song.platformLabel) || [];
    list.push(song);
    byPlatform.set(song.platformLabel, list);
  }
  const fastest = risingSongs[0];
  const spread = risingSongs.find((song) => song.chartCount >= 2 && song.maxDelta >= 20) || risingSongs.find((song) => song.chartCount >= 2);
  const headline = multi[0]
    ? `多平台同步上榜：《${multi[0].songName}》值得优先看`
    : debuts[0]
      ? `新上榜焦点：《${debuts[0].songName}》登陆${debuts[0].platforms[0].label}`
      : fastest
        ? `上升最快：《${fastest.songName}》升 ${fastest.maxDelta} 位`
        : `${meta.latestDate} 热点速递`;
  return {
    headline,
    brief: `近七日 QQ、网易云、酷狗、抖音、汽水与番茄的歌曲榜。新上榜 ${newSongs.length} 首，其中近七日首次出现 ${debuts.length} 首，多个平台同时出现 ${multi.length} 首。上升最快 ${risingSongs.length} 首。`,
    note: COPY.points,
    windowLabel: `${meta.windowStart} → ${meta.latestDate}`,
    today: meta.latestDate,
    bullets: [
      `新上榜优先看跨平台：${multi.length} 首同时出现在 2 个及以上平台。`,
      fastest ? `升幅最大是${fastest.platformLabel}《${fastest.songName}》，升 ${fastest.maxDelta} 位，现最好名次第 ${fastest.bestRankToday}。` : "今日暂无显著升幅。",
      spread ? `跨榜可看《${spread.songName}》，同平台覆盖 ${spread.chartCount} 张榜。` : "跨榜变化不多。",
      `各平台上升：${[...byPlatform.entries()].map(([name, list]) => `${name} ${list.length} 首`).join("、") || "暂无"}。`,
    ],
    counts: {
      newSongs: newSongs.length,
      debuts: debuts.length,
      multi: multi.length,
      rising: risingSongs.length,
    },
  };
}

async function chartGroupRows(platform, days) {
  const pool = getPool();
  const [rows] = await pool.query(
    `
    SELECT chart_code, MAX(chart_name) AS chart_name, MAX(snapshot_date) AS latest_at
    FROM music_trend_snapshot
    WHERE platform = ?
      AND chart_code NOT IN ('hotsearch','myplaylist','haikuiplaylist','热门搜索')
      AND chart_name NOT LIKE '%海葵%'
      AND snapshot_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
    GROUP BY chart_code
    `,
    [platform, days],
  );
  return rows;
}

async function chartGroups() {
  const pin = ["hot", "top500", "soar", "new", "index", "douyin", "shortvideo", "challenge", "stellar", "热歌榜", "新歌榜", "音乐人歌曲榜"];
  const platforms = PLATFORM_ORDER.filter((platform) => platform !== "fanqie");
  const [groups, fanqie] = await Promise.all([
    Promise.all(platforms.map(async (platform) => {
      let rows = await chartGroupRows(platform, 2);
      if (!rows.length && platform === "qishui") rows = await chartGroupRows(platform, 14);
      const charts = rows
        .map((row) => ({
          chartCode: String(row.chart_code),
          chartName: chartName(String(row.chart_code), String(row.chart_name || "")),
          latestAt: String(row.latest_at || "").replace("T", " ").slice(5, 16),
        }))
        .sort((a, b) => {
          const ai = pin.indexOf(a.chartCode);
          const bi = pin.indexOf(b.chartCode);
          return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        });
      return { platform, label: PLATFORMS[platform], charts };
    })),
    fanqieGroup(),
  ]);
  if (fanqie.charts.length) groups.push(fanqie);
  return groups;
}

const FANQIE_PIN = ["热歌榜", "飙升榜", "抖音榜", "经典榜", "80后热歌", "70后热歌", "90后热歌", "00后热歌"];

function fanqieUrl(text) {
  const match = String(text || "").match(/https?:\/\/[^\s]+/);
  return match ? match[0] : "";
}

async function loadFanqieRows(day, withMedia) {
  const pool = getPool();
  const [rows] = await pool.query(
    `
    SELECT rank_type, song_name, singer, copy_link
    FROM tomato_music_ranking
    WHERE created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)
    ORDER BY rank_type, created_at, id
    `,
    [day, day],
  );
  const ranks = new Map();
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const chartName = String(row.rank_type || "").trim();
    const songName = String(row.song_name || "").trim();
    if (!chartName || !songName) continue;
    const key = `${chartName}|${songKey(songName, row.singer)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rank = (ranks.get(chartName) || 0) + 1;
    ranks.set(chartName, rank);
    out.push({
      d: day,
      platform: "fanqie",
      chartCode: chartName,
      chartName,
      songName,
      singerName: row.singer,
      rank,
      prevRank: null,
      delta: null,
      isNew: false,
      coverUrl: "",
      sourceUrl: withMedia ? fanqieUrl(row.copy_link) : "",
    });
  }
  return out;
}

async function fanqieGroup() {
  const pool = getPool();
  const [rows] = await pool.query(`
    SELECT rank_type, MAX(created_at) AS latest_at
    FROM tomato_music_ranking
    WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
    GROUP BY rank_type
  `);
  const charts = rows
    .map((row) => ({
      chartCode: String(row.rank_type),
      chartName: String(row.rank_type),
      latestAt: String(row.latest_at || "").replace("T", " ").slice(5, 16),
    }))
    .sort((a, b) => {
      const ai = FANQIE_PIN.indexOf(a.chartCode);
      const bi = FANQIE_PIN.indexOf(b.chartCode);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
  return { platform: "fanqie", label: PLATFORMS.fanqie, charts };
}

async function loadFanqie(meta) {
  const pool = getPool();
  const [stamp] = await pool.query(
    `
    SELECT DATE(MAX(created_at)) AS d
    FROM tomato_music_ranking
    WHERE created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)
    `,
    [meta.windowStart, meta.latestDate],
  );
  const day = stamp[0] && stamp[0].d ? ymd(stamp[0].d) : "";
  if (!day) return [];
  const latest = await loadFanqieRows(day, true);
  const early = day === meta.windowStart ? [] : await loadFanqieRows(meta.windowStart, false);
  return [...latest, ...early];
}

async function loadFanqieBoard(chartCode) {
  const pool = getPool();
  const [days] = await pool.query(
    `
    SELECT DATE(created_at) AS d
    FROM tomato_music_ranking
    WHERE rank_type = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
    GROUP BY DATE(created_at)
    ORDER BY d DESC
    LIMIT 2
    `,
    [chartCode],
  );
  const latestDay = days[0] && ymd(days[0].d);
  if (!latestDay) {
    return { ok: true, platform: "fanqie", platformLabel: PLATFORMS.fanqie, chartCode, chartName: chartCode, songs: [] };
  }
  const prevDay = days[1] ? ymd(days[1].d) : "";
  const latest = (await loadFanqieRows(latestDay, true)).filter((row) => row.chartCode === chartCode);
  const previous = prevDay ? (await loadFanqieRows(prevDay, false)).filter((row) => row.chartCode === chartCode) : [];
  const prevRank = new Map(previous.map((row) => [songKey(row.songName, row.singerName), row.rank]));
  const songs = latest.map((row) => {
    const before = prevRank.get(songKey(row.songName, row.singerName));
    return {
      id: `fanqie:${chartCode}:${row.rank}:${nameKey(row.songName)}`,
      platform: "fanqie",
      platformLabel: PLATFORMS.fanqie,
      chartCode,
      chartName: chartCode,
      songName: row.songName,
      singerName: singerName("fanqie", row.singerName),
      rank: row.rank,
      prevRank: before ?? null,
      delta: before == null ? null : before - row.rank,
      isNew: before == null && Boolean(prevDay),
      coverUrl: "",
      sourceUrl: row.sourceUrl,
    };
  });
  return {
    ok: true,
    platform: "fanqie",
    platformLabel: PLATFORMS.fanqie,
    chartCode,
    chartName: chartCode,
    songs,
  };
}

const BOARD_SKIP = new Set(["hotsearch", "myplaylist", "haikuiplaylist", "热门搜索"]);

export async function loadChartBoard(platform, chartCode) {
  if (!PLATFORM_ORDER.includes(platform)) throw new Error("没有这个平台。");
  if (!/^[\w\u4e00-\u9fff-]{1,40}$/.test(chartCode) || BOARD_SKIP.has(chartCode)) throw new Error("这不是一张歌曲榜。");
  if (platform === "fanqie") return loadFanqieBoard(chartCode);
  const pool = getPool();
  const [stamp] = await pool.query(
    `
    SELECT MAX(snapshot_date) AS max_ts
    FROM music_trend_snapshot
    WHERE platform = ? AND chart_code = ?
      AND snapshot_date >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
    `,
    [platform, chartCode],
  );
  const ts = stamp[0] && stamp[0].max_ts;
  if (!ts) {
    return { ok: true, platform, platformLabel: PLATFORMS[platform], chartCode, chartName: chartName(chartCode, ""), songs: [] };
  }
  const [rows] = await pool.query(
    `
    SELECT chart_name, song_name, singer_name, rank_no, prev_rank_no, rank_delta, new_on_chart, cover_url, source_url
    FROM music_trend_snapshot
    WHERE platform = ? AND chart_code = ? AND snapshot_date = ?
    ORDER BY rank_no
    LIMIT 80
    `,
    [platform, chartCode, ts],
  );
  const label = chartName(chartCode, String(rows[0]?.chart_name || ""));
  if (label.includes("海葵")) throw new Error("这不是一张歌曲榜。");
  const songs = rows.map((row) => {
    const songName = String(row.song_name || "").trim();
    const rank = Number(row.rank_no);
    const delta = num(row.rank_delta);
    return {
      id: `${platform}:${chartCode}:${rank}:${nameKey(songName)}`,
      platform,
      platformLabel: PLATFORMS[platform],
      chartCode,
      chartName: label,
      songName,
      singerName: singerName(platform, row.singer_name),
      rank,
      prevRank: num(row.prev_rank_no),
      delta,
      isNew: Number(row.new_on_chart) === 1,
      coverUrl: /^https?:\/\//i.test(row.cover_url || "") ? String(row.cover_url) : "",
      sourceUrl: sourceUrl(row.source_url, platform),
    };
  }).filter((song) => song.songName);
  if (platform === "qishui") await backfillQishuiSources(songs);
  return {
    ok: true,
    platform,
    platformLabel: PLATFORMS[platform],
    chartCode,
    chartName: label,
    updatedAt: String(ts).replace("T", " ").slice(0, 16),
    songs,
  };
}

async function potential(limit = 10) {
  const pool = getPool();
  const safe = async (fn) => {
    try { return await fn(); } catch { return []; }
  };
  const [hotRows] = await pool.query(`
    SELECT song_name, MIN(rank_no) AS rank_no
    FROM music_trend_snapshot
    WHERE platform IN ('qq','netease','kugou')
      AND chart_code IN ('hot','top500','index')
      AND snapshot_date >= DATE_SUB(CURDATE(), INTERVAL 2 DAY)
      AND rank_no <= 20
    GROUP BY song_name
  `);
  const hot = new Map();
  for (const row of hotRows) hot.set(nameKey(row.song_name), Number(row.rank_no));
  const already = (title, cutoff) => {
    const rank = hot.get(nameKey(title));
    return rank != null && rank <= cutoff;
  };
  const [douyin, fresh, index, lists, cross] = await Promise.all([
  safe(async () => {
    const [rows] = await pool.query(`
      SELECT rank_no, song_name, singer_name, cover_url, source_url
      FROM music_trend_snapshot
      WHERE platform = 'douyin' AND chart_code = 'challenge'
        AND snapshot_date = (
          SELECT MAX(snapshot_date) FROM music_trend_snapshot
          WHERE platform = 'douyin' AND chart_code = 'challenge'
            AND snapshot_date >= DATE_SUB(CURDATE(), INTERVAL 3 DAY)
        )
      ORDER BY rank_no LIMIT 40
    `);
    return rows.filter((row) => !already(row.song_name, 20)).map((row) => ({
      songName: String(row.song_name),
      singerName: personName(row.singer_name) || (useCount(row.singer_name) ? singerName("douyin", row.singer_name) : ""),
      coverUrl: httpCover(row.cover_url),
      sourceUrl: sourceUrl(row.source_url, "douyin"),
      points: Math.max(16, 44 - Number(row.rank_no)),
      reason: "抖音领先",
      detail: `抖音挑战榜第 ${row.rank_no}，QQ / 网易云 / 酷狗热歌前 20 还没有`,
      platforms: ["douyin"],
    }));
  }),
  safe(async () => {
    const [rows] = await pool.query(`
      SELECT platform, chart_name, rank_no, song_name, singer_name, cover_url, source_url
      FROM music_trend_snapshot
      WHERE platform IN ('qq','netease','kugou') AND chart_code = 'new'
        AND rank_no <= 15 AND snapshot_date >= CURDATE()
      ORDER BY rank_no LIMIT 60
    `);
    return rows.filter((row) => !already(row.song_name, 10)).map((row) => ({
      songName: String(row.song_name),
      singerName: singerName(row.platform, row.singer_name),
      coverUrl: httpCover(row.cover_url),
      sourceUrl: sourceUrl(row.source_url),
      points: Math.max(14, 34 - Number(row.rank_no)),
      reason: "新歌未破",
      detail: `${PLATFORMS[row.platform] || row.platform} 新歌榜第 ${row.rank_no}，热歌前 10 还没站稳`,
      platforms: [String(row.platform)],
    }));
  }),
  safe(async () => {
    const [rows] = await pool.query(`
      SELECT song_name, platform_song_id, score, yesterday_change_pct
      FROM music_song_index
      WHERE platform = 'qq' AND yesterday_change_pct >= 12 AND score IS NOT NULL
      ORDER BY yesterday_change_pct DESC LIMIT 40
    `);
    return rows.filter((row) => !already(row.song_name, 20)).map((row) => ({
      songName: String(row.song_name),
      singerName: "",
      coverUrl: "",
      sourceUrl: qqSongUrl(row.platform_song_id),
      platformSongId: String(row.platform_song_id || ""),
      points: Math.min(36, 12 + Number(row.yesterday_change_pct) / 8),
      reason: "指数先涨",
      detail: `QQ 指数 ${row.score}，较昨日 ${row.yesterday_change_pct}%`,
      platforms: ["qq"],
    }));
  }),
  safe(() => playlistPush(already)),
  safe(async () => {
    const [rows] = await pool.query(`
      SELECT MAX(song_name) song_name, MAX(singer_name) singer_name,
             COUNT(DISTINCT platform) plats,
             GROUP_CONCAT(DISTINCT platform) platforms,
             MAX(CASE WHEN cover_url LIKE 'http%' THEN cover_url END) AS cover_url,
             MAX(CASE WHEN source_url LIKE '%http%' THEN source_url END) AS source_url
      FROM music_trend_snapshot
      WHERE snapshot_date >= CURDATE()
        AND platform IN ('qq','netease','kugou')
        AND chart_code NOT IN ('hotsearch','myplaylist','stellar')
      GROUP BY REPLACE(REPLACE(LOWER(song_name),' ',''),'·','')
      HAVING plats >= 2
      ORDER BY plats DESC LIMIT 80
    `);
    return rows.filter((row) => !already(row.song_name, 10)).map((row) => ({
      songName: String(row.song_name),
      singerName: singerName("qq", row.singer_name),
      coverUrl: httpCover(row.cover_url),
      sourceUrl: sourceUrl(row.source_url),
      points: 12 + Number(row.plats) * 8,
      reason: "多平台露头",
      detail: `${row.plats} 个平台在榜，热歌前 10 还没有`,
      platforms: String(row.platforms || "").split(",").filter(Boolean),
    }));
  }),
  ]);
  const fused = new Map();
  for (const seed of [...douyin, ...fresh, ...index, ...lists, ...cross]) {
    const key = nameKey(seed.songName);
    if (!key || already(seed.songName, 10)) continue;
    const current = fused.get(key);
    const ids = [...new Set([...(seed.platformSongId ? [seed.platformSongId] : [])])];
    if (!current) {
      fused.set(key, { ...seed, id: key, score: seed.points, reasons: [seed.reason], platformSongIds: ids });
      continue;
    }
    const reasons = current.reasons.includes(seed.reason) ? current.reasons : [...current.reasons, seed.reason];
    const singer = personName(current.singerName) || personName(seed.singerName) || current.singerName || seed.singerName;
    fused.set(key, {
      ...current,
      singerName: singer,
      coverUrl: betterCover(current.coverUrl, seed.coverUrl),
      sourceUrl: betterSource(current.sourceUrl, seed.sourceUrl),
      platformSongIds: [...new Set([...(current.platformSongIds || []), ...ids])].slice(0, 4),
      score: current.score + seed.points,
      reasons,
      detail: `${current.detail}；${seed.detail}`,
      platforms: [...new Set([...current.platforms, ...seed.platforms])],
    });
  }
  const emerging = new Set(["抖音领先", "新歌未破", "指数先涨", "歌单渗透"]);
  const picked = [...fused.values()]
    .filter((song) => song.reasons.some((reason) => emerging.has(reason)))
    .sort((a, b) => b.score - a.score || b.reasons.length - a.reasons.length)
    .slice(0, limit);
  await attachBySongId(picked);
  await attachNamedMedia(picked);
  return picked;
}

function sqlSongKey(songColumn, singerColumn) {
  const bare = (column) => `LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(${column}, '（[^）]*）', ''), '\\\\([^)]*\\\\)', ''), ' ', ''), '·', ''), '・', ''), '.', ''))`;
  const first = `SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(${singerColumn}, '、', 1), '&', 1), '/', 1), '／', 1), '|', 1)`;
  return `CONCAT(${bare(songColumn)}, '||', ${bare(first)})`;
}

async function playlistWindow(whereSql, params) {
  const pool = getPool();
  const [rows] = await pool.query(
    `
    SELECT MAX(t.song_name) AS song_name, MAX(t.singer_name) AS singer_name,
           MAX(CASE WHEN t.cover_url LIKE 'http%' THEN t.cover_url END) AS cover_url,
           MAX(CASE WHEN t.source_url LIKE '%http%' THEN t.source_url END) AS source_url,
           COUNT(DISTINCT CONCAT(t.platform, '-', t.playlist_id)) AS pl
    FROM (
      SELECT platform, playlist_id, MAX(snapshot_date) AS max_ts
      FROM music_playlist_track
      WHERE ${whereSql}
      GROUP BY platform, playlist_id
    ) latest
    STRAIGHT_JOIN music_playlist_track t
      ON t.platform = latest.platform
     AND t.playlist_id = latest.playlist_id
     AND t.snapshot_date = latest.max_ts
    WHERE t.song_name <> ''
    GROUP BY ${sqlSongKey("t.song_name", "t.singer_name")}
    `,
    params,
  );
  const map = new Map();
  for (const row of rows) {
    const title = String(row.song_name);
    const singer = String(row.singer_name || "");
    map.set(songKey(title, singer), {
      songName: title,
      singerName: singer,
      coverUrl: httpCover(row.cover_url),
      sourceUrl: sourceUrl(row.source_url),
      lists: { size: Number(row.pl) },
    });
  }
  return map;
}

async function playlistPush(already) {
  const pool = getPool();
  const [dateRows] = await pool.query(`SELECT MAX(snapshot_date) AS d FROM music_playlist_track`);
  const latest = String(dateRows[0]?.d || "");
  if (!latest) return [];
  const [recent, older] = await Promise.all([
    playlistWindow("snapshot_date >= DATE_SUB(?, INTERVAL 2 DAY)", [latest]),
    playlistWindow(
      "snapshot_date >= DATE_SUB(?, INTERVAL 9 DAY) AND snapshot_date < DATE_SUB(?, INTERVAL 2 DAY)",
      [latest, latest],
    ),
  ]);
  return [...recent.entries()]
    .map(([, item]) => ({
      songName: item.songName,
      singerName: item.singerName,
      coverUrl: item.coverUrl,
      sourceUrl: item.sourceUrl,
      recent: item.lists.size,
      older: older.get(songKey(item.songName, item.singerName))?.lists.size || 0,
    }))
    .filter((row) => row.recent >= 3 && row.recent > row.older && !already(row.songName, 10))
    .sort((a, b) => (b.recent - b.older) - (a.recent - a.older) || b.recent - a.recent)
    .slice(0, 40)
    .map((row) => {
      const growth = row.recent - row.older;
      return {
        songName: row.songName,
        singerName: row.singerName,
        coverUrl: row.coverUrl,
        sourceUrl: row.sourceUrl || "",
        points: Math.min(32, 10 + growth * 4 + row.recent),
        reason: "歌单渗透",
        detail: `近 3 日歌单 ${row.recent}，此前 ${row.older}，新增 ${growth}`,
        platforms: [],
      };
    });
}

function rememberMedia(found, songName, singer, cover, source) {
  const key = nameKey(songName);
  if (!key) return;
  const prev = found.get(key) || { person: "", count: 0, coverUrl: "", sourceUrl: "" };
  const coverUrl = /^https?:\/\//i.test(cover || "") ? String(cover) : "";
  const person = prev.person || personName(singer);
  const count = Math.max(prev.count || 0, useCount(singer));
  found.set(key, {
    person,
    count,
    singerName: person || (count ? `使用 ${count}` : ""),
    coverUrl: betterCover(prev.coverUrl, coverUrl),
    sourceUrl: betterSource(prev.sourceUrl, sourceUrl(source)),
  });
}

function applyMedia(song, item) {
  if (!item) return;
  if (item.singerName && !personName(song.singerName)) song.singerName = item.singerName;
  song.coverUrl = betterCover(song.coverUrl, item.coverUrl);
  song.sourceUrl = betterSource(song.sourceUrl, item.sourceUrl);
}

async function attachBySongId(songs) {
  const pending = songs.filter((song) => song.platformSongIds?.length && (!song.coverUrl || !personName(song.singerName)));
  if (!pending.length) {
    for (const song of songs) {
      delete song.platformSongIds;
      delete song.platformSongId;
    }
    return;
  }
  const ids = [...new Set(pending.flatMap((song) => song.platformSongIds))].slice(0, 40);
  if (ids.length) {
    const pool = getPool();
    const [rows] = await pool.query(
      `
      SELECT platform_song_id, singer_name, cover_url, source_url
      FROM music_trend_snapshot
      WHERE platform = 'qq'
        AND platform_song_id IN (${ids.map(() => "?").join(",")})
        AND snapshot_date >= DATE_SUB(CURDATE(), INTERVAL 21 DAY)
      ORDER BY snapshot_date DESC
      LIMIT 320
      `,
      ids,
    );
    const byId = new Map();
    for (const row of rows) {
      const id = String(row.platform_song_id || "");
      const list = byId.get(id) || [];
      if (list.length >= 8) continue;
      list.push(row);
      byId.set(id, list);
    }
    for (const song of pending) {
      for (const id of song.platformSongIds) {
        for (const row of byId.get(id) || []) {
          applyMedia(song, {
            singerName: personName(row.singer_name),
            coverUrl: /^https?:\/\//i.test(row.cover_url || "") ? String(row.cover_url) : "",
            sourceUrl: sourceUrl(row.source_url),
          });
        }
        if (song.coverUrl && personName(song.singerName)) break;
      }
    }
  }
  for (const song of songs) {
    delete song.platformSongIds;
    delete song.platformSongId;
  }
}

function stampMedia(songs, knownRows = []) {
  const wanted = new Set(songs.map((song) => nameKey(song.songName)));
  if (!wanted.size) return;
  const found = new Map();
  for (const row of knownRows) {
    if (wanted.has(nameKey(row.songName))) rememberMedia(found, row.songName, row.singerName, row.coverUrl, row.sourceUrl);
  }
  for (const song of songs) applyMedia(song, found.get(nameKey(song.songName)));
}

async function attachNamedMedia(songs) {
  const missing = [...new Set(songs.filter((song) => !song.coverUrl || !song.sourceUrl).map((song) => song.songName).filter(Boolean))];
  if (!missing.length) return;
  const pool = getPool();
  const [rows] = await pool.query(
    `
    SELECT song_name, singer_name, cover_url, source_url
    FROM music_trend_snapshot
    WHERE platform IN ('qq', 'netease', 'kugou', 'douyin', 'qishui')
      AND snapshot_date >= CURDATE()
      AND rank_no <= 80
      AND song_name IN (${missing.map(() => "?").join(",")})
    `,
    missing,
  );
  const found = new Map();
  for (const row of rows) rememberMedia(found, row.song_name, row.singer_name, row.cover_url, row.source_url);
  for (const song of songs) applyMedia(song, found.get(nameKey(song.songName)));
}

async function attachMedia(songs, knownRows = []) {
  stampMedia(songs, knownRows);
  await attachBySongId(songs);
  await attachNamedMedia(songs);
}

async function loadQishui(meta) {
  const pool = getPool();
  const [stamp] = await pool.query(
    `
    SELECT DATE(MAX(snapshot_date)) AS d
    FROM music_trend_snapshot
    WHERE platform = 'qishui'
      AND chart_code <> '热门搜索'
      AND snapshot_date >= ?
      AND snapshot_date < DATE_ADD(?, INTERVAL 1 DAY)
    `,
    [meta.windowStart, meta.latestDate],
  );
  const day = stamp[0] && stamp[0].d ? ymd(stamp[0].d) : "";
  if (!day) return [];
  const latest = await loadPlatformRows("qishui", day, "", true);
  const early = day === meta.windowStart ? [] : await loadPlatformRows("qishui", meta.windowStart, "", false);
  return [...latest, ...early];
}

function onPlatform(song, platform) {
  if (song.platform === platform) return true;
  return (song.platforms || []).some((item) => item === platform || item.platform === platform);
}

function withPlatformHeads(songs) {
  const picked = new Map();
  const add = (song) => {
    if (song && song.id && !picked.has(song.id)) picked.set(song.id, song);
  };
  for (const song of songs.slice(0, 24)) add(song);
  for (const platform of PLATFORM_ORDER) {
    let count = 0;
    for (const song of songs) {
      if (!onPlatform(song, platform)) continue;
      add(song);
      count += 1;
      if (count >= 8) break;
    }
  }
  return [...picked.values()];
}

function buildPulses(newSongs, risingSongs, rows) {
  const latestDay = latestDayByPlatform(rows);
  return PLATFORM_ORDER.map((platform) => {
    const day = latestDay.get(platform) || "";
    return {
      platform,
      label: PLATFORMS[platform],
      newCount: newSongs.filter((song) => song.platforms?.some((item) => item.platform === platform) || song.platform === platform).length,
      risingCount: risingSongs.filter((song) => song.platform === platform).length,
      chartCount: new Set(rows.filter((row) => row.platform === platform && row.d === day).map((row) => row.chartCode)).size,
    };
  });
}

async function computeDispatch() {
  const started = Date.now();
  const mark = (label) => console.log(`[dispatch] ${label} ${Date.now() - started}ms`);
  const meta = await overview();
  mark("overview");
  const days = dateSpan(meta.windowStart, meta.latestDate);
  const platforms = ["qq", "netease", "kugou", "douyin", "qishui"];
  const [chunks, fanqieChunks] = await Promise.all([
    Promise.all(platforms.map((platform) => loadSpanRows(platform, meta.windowStart, meta.latestDate))),
    Promise.all(days.map((day) => loadFanqieRows(day, true))),
  ]);
  const rows = chunks.flat().concat(...fanqieChunks);
  mark(`rows ${rows.length}`);
  const newSongs = analyzeNew(rows, meta.latestDate);
  const risingSongs = analyzeRising(rows, meta.latestDate);
  const pulses = buildPulses(newSongs, risingSongs, rows);
  const data = {
    ok: true,
    meta,
    copy: COPY,
    insight: insight(newSongs, risingSongs, meta),
    newSongs: withPlatformHeads(newSongs),
    risingSongs: withPlatformHeads(risingSongs),
    potential: [],
    pulses,
    groups: [],
    updatedAt: meta.collectedAt,
  };
  publish(data);
  mark(`lists new=${newSongs.length} rising=${risingSongs.length}`);
  const fill = async (label, fn) => {
    try {
      await fn();
      publish(data);
      mark(label);
    } catch (error) {
      console.log(`[dispatch] ${label} ${error.message}`);
    }
  };
  await Promise.all([
    fill("groups", async () => {
      data.groups = await chartGroups();
    }),
    fill("potential", async () => {
      const songs = await potential(10);
      stampMedia(songs, rows);
      data.potential = songs;
    }),
  ]);
  await fill("media", async () => {
    await attachMedia([...data.newSongs, ...data.risingSongs, ...data.potential], rows);
  });
  publish(data, true);
  mark("ready");
  return data;
}

function writeSnapshot(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body);
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.copyFileSync(tmp, file);
    fs.unlinkSync(tmp);
  }
}

function publish(data, done = false) {
  if (!done) return;
  delete data.refreshing;
  cache = { at: Date.now(), data };
  const body = JSON.stringify(data);
  try {
    writeSnapshot(cacheFile, body);
    writeSnapshot(snapshotFile, body);
  } catch (error) {
    console.log(`[dispatch] snapshot ${error.message}`);
  }
}

function poolHasLinks(data) {
  const picks = data?.potential || [];
  if (!picks.length) return true;
  return picks.some((song) => song.sourceUrl);
}

function refreshDispatch() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      await computeDispatch();
    } catch (error) {
      console.log(`[dispatch] ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await computeDispatch();
    }
  })().catch((error) => {
    console.log(`[dispatch] ${error.message}`);
  }).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export function loadDispatch() {
  return cache.data;
}

export function hotSnapshotJson() {
  if (!cache.data) return "null";
  return JSON.stringify(cache.data).replace(/</g, "\\u003c");
}

export function startDispatchSchedule() {
  if (cache.data) {
    try {
      writeSnapshot(snapshotFile, JSON.stringify(cache.data));
    } catch (error) {
      console.log(`[dispatch] snapshot ${error.message}`);
    }
  }
  const stale = !cache.data || !poolHasLinks(cache.data) || Date.now() - cache.at >= CACHE_MS;
  const wait = stale ? 0 : CACHE_MS - (Date.now() - cache.at);
  setTimeout(() => {
    refreshDispatch();
    setInterval(() => refreshDispatch(), CACHE_MS);
  }, wait);
  console.log(`[dispatch] static snapshot, refresh in ${Math.round(wait / 1000)}s`);
}
