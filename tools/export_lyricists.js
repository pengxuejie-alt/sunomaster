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
  connectionLimit: 4,
});

const UA = "Mozilla/5.0";
const CACHE_PATH = "D:/sunomaster/data/lyricist-credits.json";
const RANK_PATH = "D:/sunomaster/排行榜词作者.txt";
const DETAIL_PATH = "D:/sunomaster/排行榜歌曲词作者.txt";
const CHART_JSON_PATH = "D:/sunomaster/public/chart-lyricists.json";

function nameKey(value) {
  return String(value || "")
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[·・.\s]/g, "")
    .toLowerCase();
}

function firstSinger(singer) {
  return String(singer || "").split(/[、,&/／|]/)[0].trim();
}

function songKey(songName, singerName) {
  return `${nameKey(songName)}||${nameKey(firstSinger(singerName))}`;
}

function clean(value) {
  return String(value || "").replace(/[\t\r\n]+/g, " ").trim();
}

const songs = new Map();

function addSong(entry) {
  const songName = clean(entry.songName);
  if (!songName) return;
  const singerName = clean(entry.singerName);
  const key = songKey(songName, singerName);
  let song = songs.get(key);
  if (!song) {
    song = {
      key,
      songName,
      singerName,
      charts: 0,
      bestRank: null,
      qq: "",
      netease: "",
      kugou: "",
    };
    songs.set(key, song);
  }
  song.charts += 1;
  if (entry.rank > 0 && (song.bestRank == null || entry.rank < song.bestRank)) song.bestRank = entry.rank;
  if (singerName.length > song.singerName.length) song.singerName = singerName;
  if (songName.length < song.songName.length) song.songName = songName;
  if (entry.platform === "qq" && entry.songId && !song.qq) song.qq = entry.songId;
  if (entry.platform === "netease" && /^\d+$/.test(entry.songId || "") && !song.netease) song.netease = entry.songId;
  if (entry.platform === "kugou" && entry.songId && !song.kugou) song.kugou = entry.songId;
}

const SKIP_CHART = new Set(["hotsearch", "myplaylist", "haikuiplaylist", "热门搜索"]);
const platforms = ["qq", "netease", "kugou", "qishui", "haikui-tomato"];
for (const platform of platforms) {
  const [charts] = await pool.query(
    `
    SELECT chart_code, MAX(snapshot_date) AS latest
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
      SELECT song_name, singer_name, rank_no, platform_song_id
      FROM music_trend_snapshot
      WHERE platform = ? AND chart_code = ? AND snapshot_date = ?
      ORDER BY rank_no
      `,
      [platform, chart.chart_code, chart.latest],
    );
    for (const row of rows) {
      addSong({
        platform,
        songName: row.song_name,
        singerName: row.singer_name,
        rank: Number(row.rank_no) || 0,
        songId: clean(row.platform_song_id),
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
for (const [, rows] of byType) {
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
  latest.forEach((row, index) => {
    addSong({
      platform: "tomato",
      songName: row.song_name,
      singerName: row.singer,
      rank: index + 1,
      songId: "",
    });
  });
}

await pool.end();

const list = [...songs.values()].sort((a, b) => {
  if (b.charts !== a.charts) return b.charts - a.charts;
  const ar = a.bestRank == null ? 9999 : a.bestRank;
  const br = b.bestRank == null ? 9999 : b.bestRank;
  if (ar !== br) return ar - br;
  return a.songName.localeCompare(b.songName, "zh");
});
console.log("SONGS", list.length);

let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")); } catch { cache = {}; }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(String(response.status));
  return response.text();
}

function decodeMaybeBase64(value) {
  const text = String(value || "");
  if (!text) return "";
  if (/词\s*[:：]|作词|Lyric|\[ti:/i.test(text)) return text;
  try {
    const decoded = Buffer.from(text, "base64").toString("utf8");
    if (/词\s*[:：]|作词|Lyric|\[ti:/i.test(decoded)) return decoded;
  } catch {}
  return text;
}

function splitNames(raw) {
  const value = String(raw || "")
    .split(/\s*(?:作曲|曲|composer|compose)\s*[:：]/i)[0]
    .replace(/（[^）]{0,20}）/g, " ")
    .replace(/\([^)]{0,20}\)/g, " ")
    .replace(/@\S+/g, "")
    .trim();
  if (!value || value.length > 80) return [];
  let parts = value.split(/\s*[/／、|&＆]\s*|\s+and\s+|\s*，\s*|\s*,\s*/i);
  if (parts.length === 1 && /^[\u4e00-\u9fff]{2,4}(?:\s+[\u4e00-\u9fff]{2,4})+$/.test(value)) {
    parts = value.split(/\s+/);
  }
  const blocked = /^(未知|不详|暂无|无|none|n\/a|null|—|-|纯音乐|见专辑|版权所有)$/i;
  const names = [];
  for (const part of parts) {
    const name = part.replace(/[【】\[\]]/g, "").replace(/\s+/g, " ").trim();
    if (!name || blocked.test(name) || name.length > 40) continue;
    if (/纯音乐|暂无歌词|未经许可|请欣赏/.test(name)) continue;
    names.push(name);
  }
  return names;
}

function parseCredits(lyric) {
  const lines = String(lyric || "")
    .split(/\n/)
    .map((line) => line.replace(/\[[^\]]*\]/g, "").trim())
    .filter((line) => line && line.length <= 80);
  const names = [];
  const credits = [];
  let instrumental = false;
  const pattern = /^(?:作词人|作词|作詞|填词|填詞|词曲|詞曲|作词作曲|词\s*[/／]\s*曲|詞\s*[/／]\s*曲|词|詞)(?:\s*(?:lyrics?|lyricist|written by|lyrics by))?\s*[:：]\s*(.+)$|^(?:lyrics?|lyricist|written by|lyrics by)\s*[:：]\s*(.+)$/i;
  for (const line of lines) {
    if (/纯音乐|此歌曲为没有填词|暂无歌词/.test(line)) instrumental = true;
    const match = line.match(pattern);
    if (!match) continue;
    const found = splitNames(match[1] || match[2]);
    if (!found.length) continue;
    names.push(...found);
    credits.push(line);
  }
  const unique = [];
  const seen = new Set();
  for (const name of names) {
    const key = nameKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(name);
  }
  return {
    lyricists: unique,
    credit: credits.slice(0, 3).join("；"),
    instrumental: instrumental && unique.length === 0,
  };
}

async function lyricFromQq(mid) {
  const url = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(mid)}&format=json&nobase64=1`;
  const text = await fetchText(url, { Referer: "https://y.qq.com/", "User-Agent": UA });
  const data = JSON.parse(text);
  return decodeMaybeBase64(data.lyric || "");
}

async function lyricFromNetease(id) {
  const url = `https://music.163.com/api/song/lyric?id=${encodeURIComponent(id)}&lv=-1`;
  const text = await fetchText(url, { Referer: "https://music.163.com/", "User-Agent": UA });
  const data = JSON.parse(text);
  return data?.lrc?.lyric || "";
}

async function lyricFromKugou(keyword, hash) {
  const url = `https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${encodeURIComponent(keyword)}&duration=0&hash=${encodeURIComponent(hash || "")}`;
  const text = await fetchText(url, { Referer: "https://www.kugou.com/", "User-Agent": UA });
  const data = JSON.parse(text);
  const candidates = data.candidates || [];
  const wanted = nameKey(keyword.split(" - ")[0]);
  const hit = hash
    ? candidates[0]
    : candidates.find((item) => {
      const got = nameKey(item.song);
      return got && (got === wanted || wanted.includes(got) || got.includes(wanted));
    });
  if (!hit?.id || !hit.accesskey) return "";
  const download = await fetchText(
    `https://lyrics.kugou.com/download?ver=1&client=pc&id=${hit.id}&accesskey=${hit.accesskey}&fmt=lrc&charset=utf8`,
    { Referer: "https://www.kugou.com/", "User-Agent": UA },
  );
  const body = JSON.parse(download);
  return decodeMaybeBase64(body.content || "");
}

async function lyricFromQqSearch(songName, singerName) {
  const query = `${songName} ${firstSinger(singerName)}`.trim();
  const url = `https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?format=json&platform=h5&n=5&p=1&w=${encodeURIComponent(query)}`;
  const text = await fetchText(url, { Referer: "https://y.qq.com/", "User-Agent": UA });
  const data = JSON.parse(text);
  const found = (data?.data?.song?.list || []).find((item) => {
    const sameName = nameKey(item.songname) === nameKey(songName);
    const singers = (item.singer || []).map((singer) => singer.name).join("、");
    const sameSinger = nameKey(firstSinger(singers)) === nameKey(firstSinger(singerName));
    return sameName && sameSinger;
  });
  if (!found?.songmid) return { lyric: "", source: "" };
  return { lyric: await lyricFromQq(found.songmid), source: "qq-search" };
}

async function lookup(song) {
  const attempts = [];
  if (song.qq) attempts.push(async () => ({ lyric: await lyricFromQq(song.qq), source: "qq" }));
  if (song.netease) attempts.push(async () => ({ lyric: await lyricFromNetease(song.netease), source: "netease" }));
  if (song.kugou) attempts.push(async () => ({ lyric: await lyricFromKugou(`${song.songName} - ${firstSinger(song.singerName)}`, song.kugou), source: "kugou" }));
  attempts.push(async () => lyricFromQqSearch(song.songName, song.singerName));
  if (!song.kugou) attempts.push(async () => ({ lyric: await lyricFromKugou(`${song.songName} - ${firstSinger(song.singerName)}`, ""), source: "kugou-search" }));

  let lastError = "";
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      const parsed = parseCredits(result.lyric);
      if (parsed.lyricists.length) {
        return { status: "ok", source: result.source, lyricists: parsed.lyricists, credit: parsed.credit };
      }
      if (parsed.instrumental) {
        return { status: "instrumental", source: result.source, lyricists: [], credit: "纯音乐" };
      }
      if (result.lyric) lastError = "";
    } catch (error) {
      lastError = error.message || "error";
    }
  }
  if (lastError) return { status: "error", source: "", lyricists: [], credit: lastError };
  return { status: "missing", source: "", lyricists: [], credit: "" };
}

let saving = Promise.resolve();
function saveCache() {
  saving = saving.then(() => fs.promises.writeFile(CACHE_PATH, JSON.stringify(cache)));
  return saving;
}

const pending = list.filter((song) => {
  const saved = cache[song.key];
  return !saved || saved.status === "error" || (process.argv.includes("--retry-missing") && saved.status === "missing");
});
console.log("PENDING", pending.length, "CACHED", list.length - pending.length);

let done = 0;
let cursor = 0;
const workers = 4;
async function worker() {
  while (cursor < pending.length) {
    const song = pending[cursor];
    cursor += 1;
    const result = await lookup(song);
    cache[song.key] = {
      songName: song.songName,
      singerName: song.singerName,
      ...result,
    };
    done += 1;
    if (done % 40 === 0 || done === pending.length) {
      const ok = Object.values(cache).filter((item) => item.status === "ok").length;
      console.log("PROGRESS", done, "/", pending.length, "ok", ok);
      await saveCache();
    }
    await sleep(60);
  }
}
await Promise.all(Array.from({ length: workers }, () => worker()));
await saveCache();

const authors = new Map();
let okCount = 0;
let instrumentalCount = 0;
let missingCount = 0;
let errorCount = 0;

for (const song of list) {
  const saved = cache[song.key] || { status: "missing", lyricists: [], source: "", credit: "" };
  if (saved.status === "ok" && saved.credit) {
    const parsed = parseCredits(String(saved.credit).replace(/；/g, "\n"));
    if (parsed.lyricists.length) saved.lyricists = parsed.lyricists;
  }
  song.lyricists = saved.lyricists || [];
  song.creditStatus = saved.status || "missing";
  song.creditSource = saved.source || "";
  if (saved.status === "ok") okCount += 1;
  else if (saved.status === "instrumental") instrumentalCount += 1;
  else if (saved.status === "error") errorCount += 1;
  else missingCount += 1;
  for (const name of song.lyricists) {
    const key = nameKey(name);
    let author = authors.get(key);
    if (!author) {
      author = { name, count: 0, songs: [] };
      authors.set(key, author);
    }
    author.count += 1;
    author.songs.push(song);
  }
}

const ranked = [...authors.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh"));
await saveCache();

const rankLines = [
  "各平台最新一期排行榜歌曲的词作者。歌曲范围与排行榜歌曲列表相同，同一首歌按歌名和首位歌手合并。",
  "署名来自 QQ 音乐、网易云或酷狗歌词信息里的「作词 / 词 / 词曲」。一首歌有多位词作者时，每位都计 1 首。",
  `去重歌曲 ${list.length} 首。查到署名 ${okCount} 首，纯音乐 ${instrumentalCount} 首，有歌词但没有词作者署名 ${missingCount} 首，查询失败 ${errorCount} 首。`,
  `词作者 ${ranked.length} 人，按上榜歌曲数从多到少。`,
  "",
  "词作者\t上榜歌曲数\t歌曲",
  ...ranked.map((author) => {
    const titles = author.songs
      .slice()
      .sort((a, b) => b.charts - a.charts || a.songName.localeCompare(b.songName, "zh"))
      .map((song) => `${song.songName} / ${song.singerName}`);
    return [author.name, author.count, titles.join("、")].join("\t");
  }),
  "",
];

const detailLines = [
  "歌名\t歌手\t上榜数\t最好名次\t词作者\t来源\t状态",
  ...list.map((song) => [
    song.songName,
    song.singerName,
    song.charts,
    song.bestRank ?? "",
    song.lyricists.join("、"),
    song.creditSource,
    song.creditStatus,
  ].join("\t")),
  "",
];

fs.writeFileSync(RANK_PATH, `\uFEFF${rankLines.join("\r\n")}`, "utf8");
fs.writeFileSync(DETAIL_PATH, `\uFEFF${detailLines.join("\r\n")}`, "utf8");
fs.writeFileSync(CHART_JSON_PATH, JSON.stringify({
  updated: new Date().toISOString().slice(0, 10),
  authors: ranked.length,
  list: ranked.map((author) => ({
    name: author.name,
    count: author.count,
    songs: author.songs.map((song) => ({ title: song.songName, artist: song.singerName })),
  })),
}));
console.log("AUTHORS", ranked.length);
console.log("OK", okCount, "INSTRUMENTAL", instrumentalCount, "MISSING", missingCount, "ERROR", errorCount);
console.log("TOP");
for (const author of ranked.slice(0, 40)) console.log(`${author.count}\t${author.name}`);
console.log("FILE", RANK_PATH);
