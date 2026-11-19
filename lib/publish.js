import crypto from "crypto";
import fs from "fs";
import path from "path";
import { cutChorusClip, cutClip, suggestChorusClip } from "./clip.js";
import { readGeminiKey, geminiImage } from "./gemini.js";
import {
  HikoonError,
  contractUrl,
  hikoonConfigured,
  hikoonGet,
  hikoonKeyTag,
  hikoonPost,
  hikoonUsingCustomKey,
  uploadBuffer,
  verifyUrl,
  withHikoonKey,
} from "./hikoon.js";
import { getPool } from "./trend.js";

const AUDIO_EXT = new Set([".mp3", ".wav", ".flac", ".m4a"]);
const DEFAULT_ALBUM_INTRO = "本专辑收录原创歌曲，欢迎收听。";
const SIGNING_SUBJECT_NO = "HZGJ";
const BRAND_SHOW_NAME = "泓声无限";
const BRAND_TYPOS = new Set(["Hikoon Music", "鸿声无限", "鸿升无限", "海声无限"]);
const DUPLICATE_SKIP = new Set(["DRAFT", "VOIDED", "BUSINESS_CANCELLED"]);
const COVER_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const LYRIC_SPLIT = "【未经著作权人许可 不得翻唱 翻录或使用】";
const LYRIC_SPLIT_COVER = "【本音乐作品已获得正版授权】";
const STATUS_LABEL = {
  DRAFT: "草稿",
  BUSINESS_REVIEWING: "审核中",
  PLATFORM_REVIEWING: "平台审核中",
  APPROVED_PENDING_ONLINE: "待上架",
  ONLINE: "已上架",
  BUSINESS_CANCELLED: "已撤销",
  BUSINESS_REJECTED: "业务未通过",
  PLATFORM_REJECTED: "平台拒绝",
  PLATFORM_REJECTED_PENDING: "驳回待确认",
  VOIDED: "已作废",
  OFFLINE: "已下架",
  SUBMISSION: "提交平台中",
  SUBFAIL: "提交失败",
};

function libraryRoot(rootDir) {
  return path.join(rootDir, "data", "library");
}

function settingsPath(rootDir) {
  return path.join(rootDir, "data", "publish-settings.json");
}

function submittedPath(rootDir) {
  return path.join(rootDir, "data", "publish-submitted.json");
}

function constantsPath(rootDir) {
  return path.join(rootDir, "data", `publish-constants-${hikoonKeyTag()}.json`);
}

function indexPath(rootDir) {
  return path.join(libraryRoot(rootDir), "index.json");
}

function loadIndex(rootDir) {
  const data = readJson(indexPath(rootDir), {});
  const files = data?.files && typeof data.files === "object" && !Array.isArray(data.files) ? data.files : {};
  const hashes = data?.hashes && typeof data.hashes === "object" && !Array.isArray(data.hashes) ? data.hashes : {};
  return { files, hashes };
}

function saveIndex(rootDir, index) {
  writeJson(indexPath(rootDir), index);
}

function shownFileName(storedName, meta) {
  if (meta?.fileName) return meta.fileName;
  return String(storedName || "").replace(/^\d{13,}-/, "");
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function loadSettings(rootDir) {
  const saved = readJson(settingsPath(rootDir), {});
  const envDir = String(process.env.SONG_LIBRARY_DIR || "").trim();
  return {
    libraryDir: String(saved.libraryDir || envDir || "").trim(),
  };
}

function saveSettings(rootDir, settings) {
  writeJson(settingsPath(rootDir), settings);
}

function insideRoot(root, target) {
  const base = path.resolve(root);
  const file = path.resolve(target);
  const baseKey = process.platform === "win32" ? base.toLowerCase() : base;
  const fileKey = process.platform === "win32" ? file.toLowerCase() : file;
  return fileKey === baseKey || fileKey.startsWith(baseKey + path.sep);
}

function allowedRoots(rootDir) {
  const roots = [libraryRoot(rootDir)];
  const extra = loadSettings(rootDir).libraryDir;
  if (extra) roots.push(extra);
  return roots.filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

function songId(filePath) {
  return crypto.createHash("sha1").update(path.resolve(filePath)).digest("hex").slice(0, 16);
}

function walkAudio(dir, depth, out) {
  if (depth > 2 || out.length >= 400) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkAudio(full, depth + 1, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    out.push({
      id: songId(full),
      name: entry.name.replace(/\.[^.]+$/, ""),
      fileName: entry.name,
      size: stat.size,
      mtime: stat.mtimeMs,
      path: full,
    });
  }
}

function singerRows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.list)) return value.list;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.records)) return value.records;
  return [];
}

function httpUrl(value) {
  const text = String(value || "").trim();
  return /^https?:\/\//i.test(text) ? text : "";
}

function singerDesc(item) {
  return String(item?.singer_desc || item?.singerDesc || item?.introduction || item?.intro || item?.desc || item?.profile || item?.brief || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function singerFans(item) {
  return [
    ["QQ", item?.qq_music_fans],
    ["酷狗", item?.kugou_fans],
    ["网易云", item?.wangyi_fans],
    ["汽水", item?.qishui_fans],
    ["抖音", item?.douyin_fans],
  ].flatMap(([label, value]) => {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? [{ label, count }] : [];
  });
}

function presentFoundSinger(item, source) {
  const id = String(source === "tme"
    ? (item.centralSingerId || item.singer_id || item.id || "")
    : (item.singer_id || item.centralSingerId || item.id || ""));
  const name = item.singerName || item.singer_name || item.name || "";
  return {
    id,
    name,
    pic: httpUrl(item.singerPic || item.avatar_url || item.avatar || item.cover || item.cover_url),
    desc: singerDesc(item),
    fans: singerFans(item),
    status: item.status,
    source,
    ...(source === "tme" ? { raw: item } : {}),
  };
}

function presentSong(rootDir, song) {
  const index = loadIndex(rootDir);
  const meta = index.files?.[path.basename(song.path)];
  const fileName = shownFileName(song.fileName, meta);
  return {
    id: song.id,
    name: meta?.name || fileName.replace(/\.[^.]+$/, "") || song.name,
    fileName,
    size: song.size,
    mtime: song.mtime,
    removable: insideRoot(libraryRoot(rootDir), song.path),
  };
}

export function listLibrary(rootDir) {
  const songs = [];
  for (const dir of allowedRoots(rootDir)) walkAudio(dir, 0, songs);
  songs.sort((a, b) => b.mtime - a.mtime);
  return songs.map((song) => presentSong(rootDir, song));
}

function findSong(rootDir, id) {
  const songs = [];
  for (const dir of allowedRoots(rootDir)) walkAudio(dir, 0, songs);
  return songs.find((song) => song.id === id) || null;
}

function safeName(name) {
  const base = path.basename(String(name || "track")).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return base.slice(0, 120) || "track";
}

function asOptions(map) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  return Object.entries(map).map(([value, label]) => ({ value, label: String(label) }));
}

function copyrightName(value) {
  if (Array.isArray(value)) return String(value[0] || "Hikoon Music");
  if (value && typeof value === "object") return String(Object.values(value)[0] || "Hikoon Music");
  return String(value || "Hikoon Music");
}

function publicConstants(data) {
  return {
    language: asOptions(data?.album?.language),
    albumArea: asOptions(data?.album?.album_area),
    version: asOptions(data?.song?.version),
    payPattern: asOptions(data?.song?.pay_pattern),
    adFlag: asOptions(data?.song?.ad_flag),
    firstGenre: asOptions(data?.ext?.first_genre),
    secondGenre: data?.ext?.second_genre || {},
    authArea: asOptions(data?.song_right?.auth_area),
    canCover: asOptions(data?.song_right?.can_cover),
    copyrightEnd: data?.copyright_end_time || {},
    subjectNo: signingSubjectNo(data),
    subjectName: signingSubjectName(data),
    brandShowName: BRAND_SHOW_NAME,
    copyrightName: copyrightName(data?.song_right?.original_copyright_name),
  };
}

function signingSubjectNo(data) {
  const maps = [data?.song?.subject_no, data?.album?.subject_no];
  for (const map of maps) {
    if (!map || typeof map !== "object") continue;
    for (const [code, value] of Object.entries(map)) {
      const name = typeof value === "string" ? value : value?.name;
      if (name === "海南海之轨迹文化传媒有限公司") return String(code);
    }
  }
  return SIGNING_SUBJECT_NO;
}

function signingSubjectName(data) {
  const code = signingSubjectNo(data);
  const maps = [data?.song?.subject_no, data?.album?.subject_no];
  for (const map of maps) {
    if (!map || typeof map !== "object") continue;
    const value = map[code];
    const name = typeof value === "string" ? value : value?.name;
    if (name) return String(name);
  }
  return "海南海之轨迹文化传媒有限公司";
}

function shownBrand(form) {
  const value = String(form?.brand || "").trim();
  if (!value || BRAND_TYPOS.has(value)) return BRAND_SHOW_NAME;
  return value.slice(0, 100);
}

const CONSTANTS_TTL = 12 * 60 * 60 * 1000;
const SESSION_FRESH_MS = 2 * 60 * 1000;
const SESSION_KEEP_MS = 24 * 60 * 60 * 1000;
const sessionMemory = new Map();
const sessionRefresh = new Set();

function sessionPath(rootDir) {
  return path.join(rootDir, "data", `publish-session-${hikoonKeyTag()}.json`);
}

function readSession(rootDir) {
  const tag = hikoonKeyTag();
  const memory = sessionMemory.get(tag);
  if (memory?.savedAt && memory.account) return memory;
  const disk = readJson(sessionPath(rootDir), null);
  if (!disk?.savedAt || !disk.account) return null;
  sessionMemory.set(tag, disk);
  return disk;
}

function writeSession(rootDir, session) {
  sessionMemory.set(hikoonKeyTag(), session);
  try {
    writeJson(sessionPath(rootDir), session);
  } catch {
    /* 磁盘写失败时，这次结果仍留在内存里，刷新页面不用重新握手 */
  }
}

async function fetchConstants(rootDir) {
  const data = await hikoonPost("/open-api/publish/constant", {});
  const pub = publicConstants(data);
  writeJson(constantsPath(rootDir), { savedAt: Date.now(), public: pub });
  return pub;
}

async function loadConstants(rootDir, { allowStale = false } = {}) {
  const cached = readJson(constantsPath(rootDir), null);
  const freshEnough = cached?.savedAt && Date.now() - cached.savedAt < CONSTANTS_TTL;
  if (cached?.public && (freshEnough || allowStale)) return cached.public;
  return fetchConstants(rootDir);
}

async function pullAccountBundle() {
  const [user, publishedResult] = await Promise.all([
    account(),
    releases().then((result) => ({ list: result.list, total: result.total, error: "" })).catch((error) => ({ list: [], total: 0, error: error.message || "" })),
  ]);
  if (publishedResult.error) user.releaseError = publishedResult.error;
  return { account: user, releases: publishedResult.list, releaseTotal: publishedResult.total || 0 };
}

function rememberSession(rootDir, bundle) {
  writeSession(rootDir, {
    savedAt: Date.now(),
    account: bundle.account,
    releases: bundle.releases || [],
    releaseTotal: bundle.releaseTotal || (bundle.releases || []).length,
    releasePageSize: RELEASE_PAGE_SIZE,
  });
}

function scheduleSessionRefresh(rootDir, key) {
  const tag = hikoonKeyTag();
  if (sessionRefresh.has(tag)) return;
  sessionRefresh.add(tag);
  const run = async () => {
    try {
      const [bundle] = await Promise.all([
        pullAccountBundle(),
        fetchConstants(rootDir).catch(() => null),
      ]);
      rememberSession(rootDir, bundle);
    } catch {
      /* 海葵这次没连上时，继续用上一次的账号和发行记录 */
    } finally {
      sessionRefresh.delete(tag);
    }
  };
  setImmediate(() => {
    if (key) withHikoonKey(key, run);
    else run();
  });
}

function artistId(value) {
  const text = String(value || "").trim();
  if (!/^\d+$/.test(text)) return null;
  const num = Number(text);
  return Number.isSafeInteger(num) ? num : text;
}

function nameList(value, fallback) {
  const list = String(value || "")
    .split(/[,，、/|]/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (list.length) return list;
  return fallback ? [fallback] : [];
}

function songArtists(item, shared) {
  const names = nameList(item?.singer, shared.singerName);
  const known = new Map((shared.artists || []).map((artist) => [String(artist.singer_name || ""), artist.singer_id]));
  const fallbackId = shared.artists?.[0]?.singer_id;
  return names.map((name) => ({
    singer_id: known.has(name) ? known.get(name) : fallbackId,
    singer_name: name,
  }));
}

function stamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseWhen(value, fallback) {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HikoonError("发行时间格式不对");
  return stamp(date);
}

function isCopyrightLine(line) {
  const text = String(line || "");
  return text.includes("未经著作权人许可") && text.includes("不得翻唱");
}

function isSunoCueLine(line) {
  const rest = String(line || "").trim().replace(/\[[0-9]{1,2}:[0-9]{2}(?:[.:][0-9]{1,3})?\]/g, "").trim();
  if (!rest || isCopyrightLine(rest)) return false;
  return /^(?:\s*(?:\[[^\]]*\]|【[^】]*】)\s*)+$/.test(rest);
}

function stripSunoCues(text) {
  return String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !isSunoCueLine(line))
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanLyric(text) {
  return stripSunoCues(
    String(text || "")
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
      .replaceAll(LYRIC_SPLIT_COVER, "")
      .replaceAll("【曲库专用】", "")
  );
}

function timedLyric(text) {
  return /\[[0-9]{1,2}:[0-9]{2}(?:[.:][0-9]{1,3})?\]/.test(String(text || ""));
}

function lyricPayload(item, shared, songName, singerName) {
  const raw = cleanLyric(item.lyric).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  if (!raw) return null;
  const split = shared.canCover === 1 ? LYRIC_SPLIT_COVER : LYRIC_SPLIT;
  const timed = item.lyricMode === "lrc" || timedLyric(raw);
  if (!timed) {
    const notice = raw.includes(split) ? "" : `${split}\n`;
    return {
      name: `${safeName(songName)}.txt`,
      text: `[ti:${songName}]\n[ar:${singerName}]\n[al:${shared.albumName}]\n[offset:0]\n${notice}${raw}\n`,
    };
  }
  let body = raw;
  if (!/^\[ti:/im.test(body)) body = `[ti:${songName}]\n${body}`;
  if (!/^\[ar:/im.test(body)) body = body.replace(/^(\[ti:[^\]]*\][ \t]*\n?)/i, `$1[ar:${singerName}]\n`);
  if (!/^\[al:/im.test(body)) body = body.replace(/^(\[ar:[^\]]*\][ \t]*\n?)/i, `$1[al:${shared.albumName}]\n`);
  if (!body.includes(split)) {
    const header = body.match(/^(?:(?:\[[a-zA-Z]+:[^\]]*\][ \t]*\n?)+)/);
    body = header ? `${header[0]}${split}\n${body.slice(header[0].length)}` : `${split}\n${body}`;
  }
  if (!body.endsWith("\n")) body += "\n";
  return { name: `${safeName(songName)}.lrc`, text: body };
}

function shownCopyright(name) {
  const value = String(name || "").trim();
  if (!value || BRAND_TYPOS.has(value)) return BRAND_SHOW_NAME;
  return value.slice(0, 50);
}

function shareOf(value) {
  const share = Number(value);
  if (!Number.isFinite(share)) return 100;
  return Math.min(100, Math.max(0, share));
}

function rightBlock(form, start, endDate, canCover, authForm, extra = {}) {
  return {
    auth_form: authForm,
    copyright_start_time: start,
    copyright_end_time: String(endDate || "").slice(0, 10),
    auth_area: Number(form.authArea ?? 0),
    lyrics_share: shareOf(extra.share ?? form.share ?? 100),
    rights_flag: Number(extra.rightsFlag) === 2 ? 2 : 1,
    auth_relationship: Number(extra.relationship) === 2 ? 2 : 1,
    original_copyright_name: shownCopyright(extra.copyrightName || form.copyrightName),
    copyright_map_id: "",
    can_cover: canCover,
    ...(canCover === 1 ? { can_cover_conditions: 1 } : {}),
    first_period_day: "",
  };
}

function originRight(value) {
  const right = Number(value);
  const owned = [1, 2, 3, 4].includes(right) ? right : 1;
  if (right === 0) return { type: "", date: "", rate: "", right: 0 };
  return { type: 1, date: "", rate: 100, right: owned };
}

function buildPlatforms(form, start, copyrightEnd, partFileId) {
  const selected = Array.isArray(form.platforms) ? form.platforms : [];
  const allowed = new Set(["wyy", "qs", "fq", "dy", "ks"]);
  const clipAuth = Number(form.clipAuth) === 2 ? 2 : 1;
  const clipId = Number(partFileId);
  return selected.filter((name) => allowed.has(name)).map((name) => {
    const end = copyrightEnd?.[name] || (name === "fq" ? copyrightEnd?.wyy : "") || "2026-12-31 00:00:00";
    const row = {
      plat_name: name,
      auth_start_time: start,
      auth_end_time: String(end),
      auth_issue_status: null,
      urls: [],
    };
    if (name === "dy" || name === "ks") {
      row.auth_form = clipAuth;
      row.part_file_ids = Number.isFinite(clipId) && clipId > 0 ? clipId : "";
    }
    return row;
  });
}

async function account() {
  const data = await hikoonGet("/open-api/auth/me");
  return {
    name: data?.name || data?.user_name || "",
    verified: Boolean(data?.personal_verified),
    verifyUrl: verifyUrl(),
  };
}

function sameTitle(left, right) {
  const a = String(left || "").replace(/\s+/g, "").toLowerCase();
  const b = String(right || "").replace(/\s+/g, "").toLowerCase();
  return Boolean(a) && a === b;
}

function fileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha1");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function knownHash(rootDir, song) {
  const meta = loadIndex(rootDir).files?.[path.basename(song.path)];
  return String(meta?.hash || "");
}

const PUBLISH_ADMIN_EMAIL = "pengxuejie@gmail.com";

function ownersPath(rootDir) {
  return path.join(rootDir, "data", `publish-owners-${hikoonKeyTag()}.json`);
}

function loadOwners(rootDir) {
  const saved = readJson(ownersPath(rootDir), {});
  return saved.songs && typeof saved.songs === "object" && !Array.isArray(saved.songs) ? saved.songs : {};
}

function saveOwners(rootDir, songs) {
  writeJson(ownersPath(rootDir), { songs });
}

function publishCatalog(req, releases, total) {
  const viewer = viewerFrom(req);
  if (!viewer.seeAll) return { releases: [], releaseTotal: 0, scope: viewer.loggedIn ? "own" : "login" };
  const list = Array.isArray(releases) ? releases : [];
  return {
    releases: list,
    releaseTotal: total || list.length,
    scope: viewer.admin ? "admin" : "key",
  };
}

function viewerFrom(req) {
  const email = String(req?.account?.email || "").trim().toLowerCase();
  const custom = hikoonUsingCustomKey();
  const admin = email === PUBLISH_ADMIN_EMAIL;
  return {
    userId: req?.account?.id || "",
    email,
    admin,
    custom,
    seeAll: admin || custom,
    loggedIn: Boolean(req?.account?.id),
  };
}

function rememberOwners(rootDir, viewer, created, songNames, singerName) {
  const ids = Array.isArray(created?.song_ids) ? created.song_ids : [];
  const names = Array.isArray(songNames) ? songNames : [songNames];
  if (!viewer?.userId || !ids.length) return;
  const songs = loadOwners(rootDir);
  ids.forEach((id, index) => {
    const key = String(id);
    if (!key) return;
    songs[key] = {
      userId: viewer.userId,
      email: viewer.email,
      name: String(names[index] || names[0] || "").slice(0, 100),
      singer: String(singerName || "").slice(0, 100),
      albumId: created?.album_id || null,
      at: new Date().toISOString(),
    };
  });
  saveOwners(rootDir, songs);
}

function ownsSong(rootDir, viewer, id, name) {
  if (viewer.seeAll) return true;
  if (!viewer.loggedIn) return false;
  const songs = loadOwners(rootDir);
  if (Number.isFinite(id) && id > 0) {
    const row = songs[String(id)];
    return Boolean(row && row.userId === viewer.userId);
  }
  return Object.values(songs).some((row) => row?.userId === viewer.userId && sameTitle(row.name, name));
}

function loadSubmissions(rootDir) {
  const saved = readJson(submittedPath(rootDir), {});
  return saved.files && typeof saved.files === "object" && !Array.isArray(saved.files) ? saved.files : {};
}

function rememberSubmission(rootDir, hash, name, albumId, viewer) {
  if (!hash) return;
  const files = loadSubmissions(rootDir);
  files[hash] = {
    name: String(name || "").slice(0, 100),
    albumId: albumId || null,
    userId: viewer?.userId || "",
    at: new Date().toISOString(),
  };
  writeJson(submittedPath(rootDir), { files });
}

async function submittedByName(names) {
  const hits = [];
  const seen = new Set();
  for (const name of names) {
    const keyword = String(name || "").trim().slice(0, 100);
    if (!keyword) continue;
    const data = await hikoonGet("/open-api/publish/song-list", { keyword, page: 1, limit: 20 });
    const list = Array.isArray(data?.list) ? data.list : [];
    for (const song of list) {
      if (!sameTitle(song.name, keyword)) continue;
      if (DUPLICATE_SKIP.has(song.status)) continue;
      const id = String(song.id || `${song.name}-${song.album?.id || ""}`);
      if (seen.has(id)) continue;
      seen.add(id);
      hits.push({
        name: song.name || keyword,
        singer: song.singer || "",
        status: song.status || "",
        statusLabel: STATUS_LABEL[song.status] || song.status || "已提交",
        albumName: song.album?.album_name || "",
        file: false,
      });
    }
  }
  return hits;
}

function presentRelease(song, fallback = {}) {
  return {
    id: song?.id ?? fallback.id,
    name: song?.name || fallback.name || "",
    singer: song?.singer || fallback.singer || "",
    status: song?.status || "",
    statusLabel: STATUS_LABEL[song?.status] || song?.status || fallback.statusLabel || "已提交",
    issuedTime: String(song?.issued_time || fallback.issuedTime || "").slice(0, 16),
    albumId: song?.album?.id || song?.album_id || fallback.albumId || null,
    albumName: song?.album?.album_name || fallback.albumName || "",
    createdAt: textOf(song?.created_at, fallback.createdAt),
    submitter: textOf(song?.user?.name, fallback.submitter),
    company: textOf(song?.subject?.name, fallback.company),
  };
}

const RELEASE_PAGE_SIZE = 20;
const RELEASE_FETCH_LIMIT = 100;
const RELEASE_CATALOG_FRESH_MS = 10 * 60 * 1000;
const RELEASE_CATALOG_KEEP_MS = 24 * 60 * 60 * 1000;
const releaseCatalogMemory = new Map();
const releaseCatalogInflight = new Map();
const ownedCatalogMemory = new Map();
const ownedCatalogInflight = new Map();
const catalogRefresh = new Set();

function releaseCatalogFile(rootDir) {
  return path.join(rootDir, "data", `publish-catalog-${hikoonKeyTag()}.json`);
}

function ownedCatalogFile(rootDir, userId) {
  const safe = String(userId || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 48) || "user";
  return path.join(rootDir, "data", `publish-owned-${hikoonKeyTag()}-${safe}.json`);
}

function readCachedList(memory, tag, file) {
  const hit = memory.get(tag);
  if (hit?.savedAt && Array.isArray(hit.list)) return hit;
  const disk = readJson(file, null);
  if (!disk?.savedAt || !Array.isArray(disk.list)) return null;
  memory.set(tag, disk);
  return disk;
}

function writeCachedList(memory, tag, file, row) {
  memory.set(tag, row);
  try {
    writeJson(file, row);
  } catch {
    /* 磁盘写失败时，这份列表仍留在内存里 */
  }
}

function usableCatalog(row) {
  if (!row?.savedAt || !Array.isArray(row.list)) return null;
  if (Date.now() - row.savedAt >= RELEASE_CATALOG_KEEP_MS) return null;
  return row;
}

async function releases() {
  const data = await hikoonGet("/open-api/publish/song-list", { page: 1, limit: RELEASE_PAGE_SIZE });
  const list = Array.isArray(data?.list) ? data.list : Array.isArray(data) ? data : [];
  return {
    list: list.map((song) => presentRelease(song)),
    total: Number(data?.total) || list.length,
  };
}

async function listReleaseCatalog() {
  const first = await hikoonGet("/open-api/publish/song-list", { page: 1, limit: RELEASE_FETCH_LIMIT });
  const firstList = Array.isArray(first?.list) ? first.list : [];
  const reported = Number(first?.total);
  const total = Number.isFinite(reported) && reported >= 0 ? reported : firstList.length;
  const pages = Math.max(1, Math.ceil(total / RELEASE_FETCH_LIMIT) || 1);
  const restPages = [];
  for (let page = 2; page <= pages; page += 1) restPages.push(page);
  const rest = restPages.length
    ? await mapPool(restPages, 4, (page) => hikoonGet("/open-api/publish/song-list", { page, limit: RELEASE_FETCH_LIMIT }))
    : [];
  const seen = new Set();
  const list = [];
  for (const song of [first, ...rest].flatMap((data) => (Array.isArray(data?.list) ? data.list : []))) {
    const key = String(song?.id ?? "") || `${song?.name || ""}-${song?.album?.id || ""}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    list.push(presentRelease(song));
  }
  return { list, total: Math.max(total, list.length) };
}

function scheduleListRefresh(tag, key, run) {
  if (catalogRefresh.has(tag)) return;
  catalogRefresh.add(tag);
  const job = async () => {
    try {
      await run();
    } catch {
      /* 海葵这次没拉全时，继续用缓存里的列表 */
    } finally {
      catalogRefresh.delete(tag);
    }
  };
  setImmediate(() => {
    if (key) withHikoonKey(key, job);
    else job();
  });
}

async function loadReleaseCatalog(rootDir) {
  const tag = hikoonKeyTag();
  let pending = releaseCatalogInflight.get(tag);
  if (!pending) {
    pending = listReleaseCatalog().then((built) => {
      const row = { savedAt: Date.now(), list: built.list, total: built.total };
      writeCachedList(releaseCatalogMemory, tag, releaseCatalogFile(rootDir), row);
      releaseCatalogInflight.delete(tag);
      return row;
    }).catch((error) => {
      releaseCatalogInflight.delete(tag);
      throw error;
    });
    releaseCatalogInflight.set(tag, pending);
  }
  return pending;
}

async function ownedReleases(rootDir, viewer) {
  const rows = Object.entries(loadOwners(rootDir)).filter(([, row]) => row?.userId === viewer.userId);
  let byId = new Map();
  try {
    const catalog = await catalogReleases(rootDir, false, "");
    byId = new Map((catalog.releases || []).map((song) => [String(song.id), song]));
  } catch {
    /* 整份目录暂时读不到时，再按歌名单独查 */
  }
  const missing = [];
  const found = [];
  for (const [id, row] of rows) {
    const hit = byId.get(String(id));
    if (hit) found.push(hit);
    else missing.push([id, row]);
  }
  const lookedUp = await mapPool(missing, 4, async ([id, row]) => {
    try {
      const data = await hikoonGet("/open-api/publish/song-list", { keyword: row.name || "", page: 1, limit: 20 });
      const list = Array.isArray(data?.list) ? data.list : [];
      const hit = list.find((song) => String(song.id) === String(id))
        || list.find((song) => sameTitle(song.name, row.name));
      if (hit) return presentRelease(hit);
    } catch {
      /* 海葵这次没按编号对上时，仍显示这条提交记录 */
    }
    return presentRelease(null, {
      id: Number(id) || id,
      name: row.name || "",
      singer: row.singer || "",
      albumId: row.albumId || null,
      statusLabel: "已提交",
    });
  });
  return [...found, ...lookedUp].filter(Boolean);
}

async function catalogReleases(rootDir, fresh, key) {
  const tag = hikoonKeyTag();
  const file = releaseCatalogFile(rootDir);
  if (!fresh) {
    const cached = usableCatalog(readCachedList(releaseCatalogMemory, tag, file));
    if (cached) {
      if (Date.now() - cached.savedAt >= RELEASE_CATALOG_FRESH_MS) {
        scheduleListRefresh(tag, key, () => loadReleaseCatalog(rootDir));
      }
      return { releases: cached.list, total: cached.total || cached.list.length };
    }
  }
  const row = await loadReleaseCatalog(rootDir);
  return { releases: row.list, total: row.total || row.list.length };
}

async function loadOwnedCatalog(rootDir, viewer) {
  const tag = `${hikoonKeyTag()}:${viewer.userId}`;
  let pending = ownedCatalogInflight.get(tag);
  if (!pending) {
    pending = ownedReleases(rootDir, viewer).then((list) => {
      const row = { savedAt: Date.now(), list, total: list.length };
      writeCachedList(ownedCatalogMemory, tag, ownedCatalogFile(rootDir, viewer.userId), row);
      ownedCatalogInflight.delete(tag);
      return row;
    }).catch((error) => {
      ownedCatalogInflight.delete(tag);
      throw error;
    });
    ownedCatalogInflight.set(tag, pending);
  }
  return pending;
}

async function ownedReleaseView(rootDir, viewer, fresh, key) {
  const tag = `${hikoonKeyTag()}:${viewer.userId}`;
  const file = ownedCatalogFile(rootDir, viewer.userId);
  if (!fresh) {
    const cached = usableCatalog(readCachedList(ownedCatalogMemory, tag, file));
    if (cached) {
      if (Date.now() - cached.savedAt >= RELEASE_CATALOG_FRESH_MS) {
        scheduleListRefresh(`owned:${tag}`, key, () => loadOwnedCatalog(rootDir, viewer));
      }
      return cached;
    }
  }
  return loadOwnedCatalog(rootDir, viewer);
}

function stampCancelled(rootDir, viewer, songId, albumId, scene) {
  const apply = (memory, tag, file) => {
    const row = readCachedList(memory, tag, file);
    if (!row) return;
    let changed = false;
    row.list = row.list.map((song) => {
      const sameSong = String(song.id) === String(songId);
      const sameAlbum = scene === "album" && albumId && String(song.albumId) === String(albumId) && song.status === "BUSINESS_REVIEWING";
      if (!sameSong && !sameAlbum) return song;
      changed = true;
      return { ...song, status: "BUSINESS_CANCELLED", statusLabel: STATUS_LABEL.BUSINESS_CANCELLED };
    });
    if (!changed) return;
    row.savedAt = Date.now();
    writeCachedList(memory, tag, file, row);
  };
  apply(releaseCatalogMemory, hikoonKeyTag(), releaseCatalogFile(rootDir));
  if (viewer?.userId) apply(ownedCatalogMemory, `${hikoonKeyTag()}:${viewer.userId}`, ownedCatalogFile(rootDir, viewer.userId));
}

function cachedRelease(rootDir, viewer, songId) {
  const spots = [[releaseCatalogMemory, hikoonKeyTag(), releaseCatalogFile(rootDir)]];
  if (viewer?.userId) spots.push([ownedCatalogMemory, `${hikoonKeyTag()}:${viewer.userId}`, ownedCatalogFile(rootDir, viewer.userId)]);
  for (const [memory, tag, file] of spots) {
    const row = readCachedList(memory, tag, file);
    const hit = row?.list?.find((song) => String(song.id) === String(songId));
    if (hit) return hit;
  }
  return null;
}

function prependReleaseCache(rootDir, viewer, songs) {
  const incoming = (Array.isArray(songs) ? songs : []).filter((song) => song && (song.id || song.name));
  if (!incoming.length) return null;
  const seeAll = Boolean(viewer?.seeAll);
  const tag = seeAll ? hikoonKeyTag() : `${hikoonKeyTag()}:${viewer?.userId || ""}`;
  const file = seeAll ? releaseCatalogFile(rootDir) : ownedCatalogFile(rootDir, viewer?.userId);
  const memory = seeAll ? releaseCatalogMemory : ownedCatalogMemory;
  if (!seeAll && !viewer?.userId) return null;
  const row = readCachedList(memory, tag, file);
  if (!row) return null;
  const previous = new Map(row.list.map((song) => [String(song.id), song]));
  const merged = incoming.map((song) => {
    const older = previous.get(String(song.id));
    if (!older) return song;
    return {
      ...older,
      ...song,
      status: song.status || older.status || "",
      statusLabel: song.status ? (song.statusLabel || older.statusLabel) : (older.statusLabel || song.statusLabel),
    };
  });
  const ids = new Set(merged.map((song) => String(song.id)));
  row.list = [...merged, ...row.list.filter((song) => !ids.has(String(song.id)))];
  row.total = Math.max(Number(row.total) || 0, row.list.length);
  row.savedAt = Date.now();
  writeCachedList(memory, tag, file, row);
  return row;
}

async function releaseView(rootDir, req, fresh) {
  const viewer = viewerFrom(req);
  const key = String(req.get?.("x-hikoon-key") || "").trim();
  if (!viewer.seeAll && !viewer.loggedIn) {
    return {
      releases: [],
      total: 0,
      scope: "login",
      message: "请先登录。登录后只能查看自己提交的歌。",
    };
  }
  if (!viewer.seeAll) {
    const row = await ownedReleaseView(rootDir, viewer, fresh, key);
    return {
      releases: row.list,
      total: row.list.length,
      scope: "own",
      message: row.list.length ? "" : "还没有你提交的歌。",
    };
  }
  const catalog = await catalogReleases(rootDir, fresh, key);
  return {
    ...catalog,
    scope: viewer.admin ? "admin" : "key",
    message: "",
  };
}

function listOf(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.list?.data)) return value.list.data;
  if (Array.isArray(value?.list)) return value.list;
  return [];
}

function textOf(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function amountOf(item) {
  for (const key of ["total_income", "settled_amount", "amount", "income"]) {
    const num = Number(item?.[key]);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function presentIncome(data) {
  return {
    total: data?.total_income ?? null,
    totalMom: data?.total_income_mom ?? null,
    settled: data?.settled_income ?? null,
    pending: data?.pending_income ?? null,
    channels: listOf(data?.channel_breakdown).slice(0, 8).map((item) => ({
      name: textOf(item.channel_name, item.name, item.platform, item.channel),
      amount: amountOf(item),
    })),
    trend: listOf(data?.revenue_trend).map((item) => ({ month: item.month || "", amount: item.amount ?? null })),
  };
}

function presentBillStats(data) {
  return {
    count: data?.total_count ?? null,
    amount: data?.total_amount ?? null,
    settled: data?.settled_amount ?? null,
    pending: data?.pending_amount ?? null,
    settledRatio: data?.settled_ratio ?? null,
  };
}

function presentRanking(data) {
  const fromList = listOf(data?.list);
  const fromData = listOf(data);
  const rows = (fromList.length ? fromList : fromData.length ? fromData : listOf(data?.top3)).slice(0, 20);
  return rows.map((item, index) => ({
    rank: item.rank ?? item.ranking ?? index + 1,
    name: textOf(item.song_name, item.name),
    singer: textOf(item.singer_name, item.singer),
    income: amountOf(item),
  }));
}

function presentBills(data) {
  return listOf(data?.list).slice(0, 20).map((item) => ({
    name: textOf(item.song_name, item.name, item.bill_no, item.title),
    month: textOf(item.month, item.bill_month, item.date),
    platform: textOf(item.platform, item.channel_name, item.channel),
    status: textOf(item.status_label, item.status, item.bill_status),
    amount: amountOf(item),
  }));
}

function incomeFold(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

function incomeArtistKey(value) {
  return String(value || "").split(/[，,、/／|&＆]/).map(incomeFold).filter(Boolean).sort().join("+");
}

function incomePairKey(name, artist) {
  return `${incomeFold(name)}||${incomeArtistKey(artist)}`;
}

function roundMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Number(num.toFixed(2));
}

function periodLabel(value) {
  const text = String(value || "");
  return text.length === 6 ? `${text.slice(0, 4)}-${text.slice(4)}` : text;
}

let songIncomeCache = { at: 0, data: null };
const SONG_INCOME_MS = 5 * 60 * 1000;
const INCOME_CHANNEL = "海之轨迹";

async function loadSongIncome() {
  if (songIncomeCache.data && Date.now() - songIncomeCache.at < SONG_INCOME_MS) return songIncomeCache.data;
  const pool = getPool();
  const [totals] = await pool.query(`
    SELECT COUNT(*) AS line_count, SUM(income) AS income,
           MIN(settlement_period) AS period_start, MAX(settlement_period) AS period_end
    FROM music_db.song_income_monthly
    WHERE distribution_channel = ?
  `, [INCOME_CHANNEL]);
  const [grouped] = await pool.query(`
    SELECT platform, settlement_period, song_name, artist_name, SUM(income) AS income, COUNT(*) AS line_count
    FROM music_db.song_income_monthly
    WHERE distribution_channel = ?
    GROUP BY platform, settlement_period, song_name, artist_name
  `, [INCOME_CHANNEL]);
  const total = roundMoney(totals[0]?.income);
  const channels = new Map();
  const months = new Map();
  const songs = new Map();
  const bills = [];
  for (const row of grouped) {
    const amount = Number(row.income) || 0;
    const platform = String(row.platform || "");
    const month = periodLabel(row.settlement_period);
    channels.set(platform, (channels.get(platform) || 0) + amount);
    months.set(month, (months.get(month) || 0) + amount);
    const key = incomePairKey(row.song_name, row.artist_name);
    const current = songs.get(key) || {
      name: String(row.song_name || ""),
      singer: String(row.artist_name || ""),
      income: 0,
      lines: 0,
    };
    current.income += amount;
    current.lines += Number(row.line_count) || 0;
    songs.set(key, current);
    bills.push({
      name: String(row.song_name || ""),
      singer: String(row.artist_name || ""),
      month,
      platform,
      amount: roundMoney(amount),
      lines: Number(row.line_count) || 0,
    });
  }
  const ranking = [...songs.values()]
    .map((song) => ({ ...song, income: roundMoney(song.income) }))
    .sort((a, b) => b.income - a.income || a.name.localeCompare(b.name, "zh-CN"));
  ranking.forEach((song, index) => {
    song.rank = index + 1;
  });
  const data = {
    channel: INCOME_CHANNEL,
    account: {
      ok: true,
      account: {
        total,
        channels: [...channels.entries()]
          .map(([name, amount]) => ({ name, amount: roundMoney(amount) }))
          .sort((a, b) => b.amount - a.amount),
        trend: [...months.entries()]
          .map(([month, amount]) => ({ month, amount: roundMoney(amount) }))
          .sort((a, b) => a.month.localeCompare(b.month)),
      },
    },
    stats: {
      ok: true,
      stats: {
        count: ranking.length,
        amount: total,
        rows: Number(totals[0]?.line_count) || 0,
        from: periodLabel(totals[0]?.period_start),
        to: periodLabel(totals[0]?.period_end),
      },
    },
    ranking: { ok: true, ranking: ranking.slice(0, 20) },
    songs: { ok: true, songs: ranking },
    bills: {
      ok: true,
      bills: bills.sort((a, b) => b.month.localeCompare(a.month) || b.amount - a.amount),
    },
  };
  songIncomeCache = { at: Date.now(), data };
  return data;
}

async function viewerReleases(rootDir, req) {
  const viewer = viewerFrom(req);
  const key = String(req.get?.("x-hikoon-key") || "").trim();
  try {
    if (viewer.seeAll) {
      const catalog = await catalogReleases(rootDir, false, key);
      return catalog.releases || [];
    }
    const row = await ownedReleaseView(rootDir, viewer, false, key);
    return row.list || [];
  } catch {
    return [];
  }
}

function viewIncome(full, releases, viewer) {
  const allSongs = full.songs?.songs || [];
  const byPair = new Map(allSongs.map((song) => [incomePairKey(song.name, song.singer), song]));
  const peopleMap = new Map();
  const owners = new Map();
  const owned = new Map();
  for (const release of releases || []) {
    const key = incomePairKey(release.name, release.singer);
    const hit = byPair.get(key);
    if (!hit) continue;
    owned.set(key, hit);
    const person = String(release.submitter || "").trim() || "未署名";
    const names = owners.get(key) || new Set();
    names.add(person);
    owners.set(key, names);
    const bucket = peopleMap.get(person) || { name: person, income: 0, keys: new Set() };
    if (!bucket.keys.has(key)) {
      bucket.keys.add(key);
      bucket.income += Number(hit.income) || 0;
    }
    peopleMap.set(person, bucket);
  }
  const seeAll = Boolean(viewer.seeAll);
  const songs = (seeAll ? allSongs : [...owned.values()])
    .map((song) => ({ ...song }))
    .sort((a, b) => b.income - a.income || a.name.localeCompare(b.name, "zh-CN"));
  songs.forEach((song, index) => {
    song.rank = index + 1;
    const names = owners.get(incomePairKey(song.name, song.singer));
    song.submitter = names ? [...names].join("、") : "";
  });
  const people = [...peopleMap.values()]
    .map((person) => ({ name: person.name, income: roundMoney(person.income), songCount: person.keys.size }))
    .sort((a, b) => b.income - a.income || a.name.localeCompare(b.name, "zh-CN"));
  const keys = new Set(songs.map((song) => incomePairKey(song.name, song.singer)));
  const bills = (full.bills?.bills || []).filter((row) => keys.has(incomePairKey(row.name, row.singer)));
  const channels = new Map();
  const months = new Map();
  let lines = 0;
  for (const row of bills) {
    channels.set(row.platform, (channels.get(row.platform) || 0) + Number(row.amount));
    months.set(row.month, (months.get(row.month) || 0) + Number(row.amount));
    lines += Number(row.lines) || 0;
  }
  const total = seeAll ? full.account.account.total : roundMoney(songs.reduce((sum, song) => sum + Number(song.income), 0));
  return {
    scope: seeAll ? "all" : "own",
    catalogCount: (releases || []).length,
    channel: full.channel,
    account: {
      ok: true,
      account: {
        total,
        channels: [...channels.entries()].map(([name, amount]) => ({ name, amount: roundMoney(amount) })).sort((a, b) => b.amount - a.amount),
        trend: [...months.entries()].map(([month, amount]) => ({ month, amount: roundMoney(amount) })).sort((a, b) => a.month.localeCompare(b.month)),
      },
    },
    stats: {
      ok: true,
      stats: {
        count: songs.length,
        amount: total,
        rows: seeAll ? full.stats.stats.rows : lines,
        from: full.stats.stats.from,
        to: full.stats.stats.to,
      },
    },
    people: { ok: true, people: seeAll ? people : [] },
    ranking: { ok: true, ranking: songs },
    songs: { ok: true, songs },
    bills: { ok: true, bills },
  };
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvTable(header, rows) {
  return `\uFEFF${[header, ...rows].map((line) => line.map(csvCell).join(",")).join("\r\n")}`;
}

const PLAY_PLATFORMS = [
  { id: "kugou", label: "酷狗", search: "/open-api/kugou/search", detail: "/open-api/kugou/song-by-hash" },
  { id: "qq", label: "QQ音乐", search: "/open-api/qq-direct/search", detail: "/open-api/qq-direct/song-by-mid" },
  { id: "netease", label: "网易云", search: "/open-api/netease/search", detail: "/open-api/netease/song-by-id" },
  { id: "qishui", label: "汽水", search: "/open-api/qishui/search", detail: "/open-api/qishui/song-by-id" },
];

const PLAY_METRICS = [
  ["play_count", "播放"],
  ["comment_total", "评论"],
  ["collect_total", "收藏"],
  ["now_play_count", "在听"],
  ["listeners_current", "在听"],
  ["listeners_total", "累计听众"],
  ["latest_zhishu", "Q音指数"],
  ["zhishu_change", "指数变化"],
  ["latest_rank", "排名"],
  ["rank_position", "排名"],
  ["platform_index", "热度"],
  ["platform_index_change", "热度变化"],
  ["popularity", "流行度"],
  ["publish_date", "发行"],
  ["release_date", "发行"],
];

function compact(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function songTitle(item) {
  return textOf(item?.song_name, item?.name);
}

function songArtist(item) {
  return textOf(item?.singer_name, item?.singer);
}

function chooseCandidate(rows, name, singer) {
  const wantedName = compact(name);
  const wantedSinger = compact(singer);
  const titled = rows.filter((item) => {
    const title = compact(songTitle(item));
    return title === wantedName || title.includes(wantedName);
  });
  const exact = wantedSinger
    ? titled.find((item) => compact(songArtist(item)).includes(wantedSinger))
    : titled.find((item) => compact(songTitle(item)) === wantedName);
  return exact || titled[0] || null;
}

function playMetrics(data) {
  const seen = new Set();
  const metrics = [];
  for (const [key, label] of PLAY_METRICS) {
    if (seen.has(label)) continue;
    const value = data?.[key];
    if (value == null || value === "" || Array.isArray(value)) continue;
    seen.add(label);
    metrics.push({ label, value: String(value) });
  }
  return metrics;
}

function detailQuery(item, platformId) {
  const query = {};
  for (const [key, value] of Object.entries(item || {})) {
    if (value == null || typeof value === "object") continue;
    const text = String(value);
    if (!text || text.length > 500) continue;
    query[key] = text;
  }
  if (platformId === "netease" && query.id && !query.song_id) query.song_id = query.id;
  return query;
}

async function settle(label, run) {
  try {
    return { ok: true, ...await run() };
  } catch (error) {
    return { ok: false, error: error.message || `${label}失败` };
  }
}

const SHELF_LABEL = {
  pending: "待发行",
  submitting: "提交中",
  reviewing: "审核中",
  online: "已上架",
  reject: "上架失败",
  submit_failed: "提交失败",
  offline: "已下架",
};
const SHELF_ORDER = ["online", "reviewing", "submitting", "pending", "reject", "submit_failed", "offline"];
const PLATFORM_ORDER = ["网易云", "汽水", "番茄", "抖音", "快手"];
const analyticsCache = new Map();
const ANALYTICS_TTL_MS = 10 * 60 * 1000;
const ONLINE_PAGE_SIZE = 20;

async function mapPool(items, size, run) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await run(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

function presentPlatforms(rows) {
  return (Array.isArray(rows) ? rows : []).map((item) => ({
    name: textOf(item.name, item.key),
    status: item.status || "",
    statusLabel: textOf(item.status_label, SHELF_LABEL[item.status], item.status),
    reason: textOf(item.fail_reason),
  })).filter((item) => item.name);
}

function presentStatusCount(counts) {
  return Object.entries(counts || {})
    .map(([status, count]) => ({ status, label: STATUS_LABEL[status] || status, count: Number(count) || 0 }))
    .filter((item) => item.count > 0);
}

function rollupPlatforms(songs, total) {
  const buckets = new Map(PLATFORM_ORDER.map((name) => [name, {}]));
  for (const song of songs) {
    for (const plat of song.platforms || []) {
      if (!buckets.has(plat.name)) buckets.set(plat.name, {});
      const bucket = buckets.get(plat.name);
      const status = plat.status || "unknown";
      bucket[status] = (bucket[status] || 0) + 1;
    }
  }
  return [...buckets.entries()].map(([name, counts]) => {
    const recorded = Object.values(counts).reduce((sum, count) => sum + count, 0);
    return {
      name,
      recorded,
      missing: Math.max(0, total - recorded),
      counts: SHELF_ORDER.filter((status) => counts[status]).map((status) => ({
        status,
        label: SHELF_LABEL[status] || status,
        count: counts[status],
      })),
    };
  }).filter((item) => item.recorded > 0);
}

async function listOnlineSongs() {
  const first = await hikoonGet("/open-api/publish/song-list", { status: "ONLINE", page: 1, limit: 100 });
  const total = Number(first?.total) || (Array.isArray(first?.list) ? first.list.length : 0);
  const pages = Math.max(1, Math.ceil(total / 100));
  const restPages = [];
  for (let page = 2; page <= pages; page += 1) restPages.push(page);
  const rest = await mapPool(restPages, 4, (page) => hikoonGet("/open-api/publish/song-list", {
    status: "ONLINE",
    page,
    limit: 100,
  }));
  return {
    total,
    statusCount: presentStatusCount(first?.status_count),
    list: [first, ...rest].flatMap((data) => (Array.isArray(data?.list) ? data.list : [])),
  };
}

async function buildAnalytics() {
  const { total, statusCount, list } = await listOnlineSongs();
  const ids = list.map((song) => Number(song.id)).filter((id) => Number.isFinite(id) && id > 0);
  const chunks = [];
  for (let index = 0; index < ids.length; index += 100) chunks.push(ids.slice(index, index + 100));
  const shelves = await mapPool(chunks, 4, async (songIds) => {
    try {
      return { ok: true, data: await hikoonPost("/open-api/publish/platform-status", { song_ids: songIds }) };
    } catch (error) {
      return { ok: false, error: error.message || "平台状态没有读出来", data: { songs: [] } };
    }
  });
  const byId = new Map();
  for (const shelf of shelves) {
    for (const song of shelf.data?.songs || []) byId.set(Number(song.id), presentPlatforms(song.platforms));
  }
  const songs = list.map((song) => ({
    id: song.id,
    name: song.name || "",
    singer: song.singer || "",
    albumName: song.album?.album_name || "",
    issuedTime: String(song.issued_time || "").slice(0, 10),
    platforms: byId.get(Number(song.id)) || [],
  }));
  const warning = shelves.filter((item) => !item.ok).map((item) => item.error).filter(Boolean)[0] || "";
  return {
    total,
    statusCount,
    platforms: rollupPlatforms(songs, total),
    songs,
    warning,
  };
}

function analyticsPage(cached, page) {
  const pages = Math.max(1, Math.ceil(cached.songs.length / ONLINE_PAGE_SIZE) || 1);
  const current = Math.min(Math.max(page, 1), pages);
  const start = (current - 1) * ONLINE_PAGE_SIZE;
  return {
    total: cached.total,
    statusCount: cached.statusCount,
    platforms: cached.platforms,
    warning: cached.warning || "",
    songs: cached.songs.slice(start, start + ONLINE_PAGE_SIZE),
    page: current,
    pages,
  };
}

async function ownAnalytics(rootDir, viewer, page) {
  const releases = await ownedReleases(rootDir, viewer);
  const ids = releases.map((song) => Number(song.id)).filter((id) => Number.isFinite(id) && id > 0);
  const chunks = [];
  for (let index = 0; index < ids.length; index += 100) chunks.push(ids.slice(index, index + 100));
  const shelves = await mapPool(chunks, 4, async (songIds) => {
    try {
      return await hikoonPost("/open-api/publish/platform-status", { song_ids: songIds });
    } catch {
      return { songs: [] };
    }
  });
  const byId = new Map();
  for (const shelf of shelves) {
    for (const song of shelf?.songs || []) byId.set(Number(song.id), presentPlatforms(song.platforms));
  }
  const songs = releases.map((song) => ({
    ...song,
    issuedTime: String(song.issuedTime || "").slice(0, 10),
    platforms: byId.get(Number(song.id)) || [],
  }));
  const counts = {};
  for (const song of songs) {
    if (!song.status) continue;
    counts[song.status] = (counts[song.status] || 0) + 1;
  }
  return {
    ...analyticsPage({
      total: songs.length,
      statusCount: presentStatusCount(counts),
      platforms: rollupPlatforms(songs, songs.length),
      songs,
      warning: "",
    }, page),
    scope: "own",
    message: songs.length ? "" : "还没有你提交的歌。",
  };
}

async function accountAnalytics(rootDir, viewer, page, fresh) {
  if (!viewer.seeAll && !viewer.loggedIn) {
    return {
      total: 0,
      statusCount: [],
      platforms: [],
      warning: "",
      songs: [],
      page: 1,
      pages: 1,
      scope: "login",
      message: "请先登录。登录后只能查看自己提交的歌。",
    };
  }
  if (!viewer.seeAll) return ownAnalytics(rootDir, viewer, page);
  const tag = `${hikoonKeyTag()}:all`;
  if (fresh) analyticsCache.delete(tag);
  let cached = analyticsCache.get(tag);
  if (!cached || Date.now() - cached.at > ANALYTICS_TTL_MS) {
    const built = await buildAnalytics();
    cached = { at: Date.now(), ...built };
    analyticsCache.set(tag, cached);
  }
  return { ...analyticsPage(cached, page), scope: viewer.admin ? "admin" : "key", message: "" };
}

async function songShelf(id) {
  const data = await hikoonPost("/open-api/publish/platform-status", { song_ids: [id] });
  const song = (data?.songs || []).find((item) => Number(item.id) === id) || data?.songs?.[0];
  return presentPlatforms(song?.platforms);
}

async function songPlays(name, singer) {
  return Promise.all(PLAY_PLATFORMS.map(async (platform) => {
    try {
      const found = await hikoonGet(platform.search, { song_name: name, singer_name: singer || "" });
      const rows = listOf(found);
      const hit = chooseCandidate(rows, name, singer);
      if (!hit) return { id: platform.id, label: platform.label, ok: true, found: false };
      const detail = await hikoonGet(platform.detail, detailQuery(hit, platform.id));
      return {
        id: platform.id,
        label: platform.label,
        ok: true,
        found: true,
        name: songTitle(hit),
        singer: songArtist(hit),
        metrics: playMetrics(detail),
      };
    } catch (error) {
      return { id: platform.id, label: platform.label, ok: false, error: error.message || "查询失败" };
    }
  }));
}

function sendError(res, error) {
  const status = Number(error.status) || (error instanceof HikoonError && error.code === 401 ? 401 : 400);
  const code = status >= 400 && status < 600 ? status : 400;
  res.status(code).json({ ok: false, error: error.message || "发行失败" });
}

function coverPrompt(body) {
  const songName = String(body.songName || "").trim().slice(0, 80);
  const artist = String(body.artist || "").trim().slice(0, 80);
  const genre = String(body.genre || "").trim().slice(0, 40);
  const lyric = String(body.lyric || "").replace(/\s+/g, " ").trim().slice(0, 280);
  return [
    "Square music album cover, 1:1, professional streaming artwork.",
    "No text, no letters, no numbers, no logo, no watermark, no frame.",
    `Song mood: ${songName}.`,
    artist ? `Artist mood: ${artist}.` : "",
    genre ? `Genre: ${genre}.` : "",
    lyric ? `Lyric mood: ${lyric}` : "",
    "Cinematic, cohesive colors, high detail, suitable as a commercial album cover.",
  ].filter(Boolean).join("\n");
}

function avatarPrompt(body) {
  const artist = String(body.artist || "").trim().slice(0, 80);
  const kind = String(body.singerType || "").trim().slice(0, 20);
  const desc = String(body.desc || "").replace(/\s+/g, " ").trim().slice(0, 200);
  return [
    "Square 1:1 original musician portrait, head and shoulders, centered.",
    "No text, no letters, no numbers, no logo, no watermark, no frame.",
    "Do not depict a real public figure. Invent an original face.",
    `Artist name mood: ${artist}.`,
    kind ? `Artist type: ${kind}.` : "",
    desc ? `Bio: ${desc}` : "",
    "Clean background, suitable as a streaming artist avatar.",
  ].filter(Boolean).join("\n");
}

const ARTIST_PLATFORM_IDS = ["qq", "netease", "kugou", "douyin", "qishui"];

function artistProfileFile(rootDir) {
  return path.join(rootDir, "data", `publish-artists-${hikoonKeyTag()}.json`);
}

function loadArtistProfiles(rootDir) {
  const saved = readJson(artistProfileFile(rootDir), {});
  const profiles = saved.profiles && typeof saved.profiles === "object" && !Array.isArray(saved.profiles) ? saved.profiles : {};
  return Object.values(profiles).filter((item) => item && item.name);
}

function cleanArtistProfile(body) {
  const name = String(body?.name || "").trim().slice(0, 50);
  if (!name) return null;
  const roles = (Array.isArray(body.roles) ? body.roles : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .slice(0, 8);
  const incoming = body.platforms && typeof body.platforms === "object" ? body.platforms : {};
  const platforms = {};
  for (const id of ARTIST_PLATFORM_IDS) {
    const row = incoming[id] && typeof incoming[id] === "object" ? incoming[id] : {};
    const mode = row.mode === "create" ? "create" : "link";
    platforms[id] = {
      mode,
      url: mode === "link" ? String(row.url || "").trim().slice(0, 300) : "",
      fans: Math.max(0, Math.round(Number(row.fans) || 0)),
    };
  }
  return {
    id: String(body.id || "").slice(0, 40),
    name,
    singerType: String(body.singerType ?? "").slice(0, 8),
    roles,
    area: String(body.area ?? "").slice(0, 8),
    desc: String(body.desc || "").trim().slice(0, 255),
    company: String(body.company || "").trim().slice(0, 80),
    platforms,
    avatar: safeAvatarUrl(body.avatar),
    createdAt: String(body.createdAt || "").slice(0, 40),
  };
}

function artistAvatarDir(rootDir) {
  return path.join(rootDir, "data", `artist-avatars-${hikoonKeyTag()}`);
}

function safeAvatarUrl(value) {
  const text = String(value || "").trim();
  return /^\/api\/publish\/artist-avatar\/[a-z0-9]+\.(?:jpg|jpeg|png|webp)$/i.test(text) ? text : "";
}

function saveArtistAvatar(rootDir, filename, buffer) {
  const ext = path.extname(String(filename || "")).toLowerCase();
  const allowed = new Set([".jpg", ".jpeg", ".png", ".webp"]);
  if (!allowed.has(ext)) throw new HikoonError("头像只收 jpg、png 或 webp");
  if (!buffer?.length) throw new HikoonError("头像是空的");
  const dir = artistAvatarDir(rootDir);
  fs.mkdirSync(dir, { recursive: true });
  const stored = `${crypto.randomBytes(8).toString("hex")}${ext === ".jpeg" ? ".jpg" : ext}`;
  fs.writeFileSync(path.join(dir, stored), buffer);
  return `/api/publish/artist-avatar/${stored}`;
}

function accountPlatform(url, fans, created) {
  const mode = Number(created) === 1 ? "create" : "link";
  return {
    mode,
    url: mode === "link" ? String(url || "").trim().slice(0, 300) : "",
    fans: Math.max(0, Math.round(Number(fans) || 0)),
  };
}

function presentAccountArtist(row) {
  const roles = String(row?.singer_role || "")
    .split(/[,，]/)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  return {
    id: String(row?.id || ""),
    singerId: String(row?.singer_id || ""),
    name: String(row?.singer_name || "").trim().slice(0, 50),
    coverUrl: httpUrl(row?.cover_url),
    status: Number(row?.status) || 0,
    statusText: String(row?.status_text || "").trim().slice(0, 20),
    singerType: String(row?.singer_type ?? ""),
    singerTypeText: String(row?.singer_type_text || "").trim().slice(0, 20),
    roles,
    roleText: String(row?.singer_role_text || "").trim().slice(0, 40),
    area: String(row?.area ?? ""),
    areaText: String(row?.area_text || "").trim().slice(0, 20),
    desc: String(row?.singer_desc || "").trim().slice(0, 255),
    company: String(row?.brand_name || "").trim().slice(0, 80),
    submitter: String(row?.created_by_name || "").trim().slice(0, 40),
    createdAt: String(row?.created_at || "").slice(0, 19),
    platforms: {
      qq: accountPlatform(row?.qq_music_homepage, row?.qq_music_fans, row?.qq_music_new),
      netease: accountPlatform(row?.wangyi_homepage, row?.wangyi_fans, row?.wangyi_new),
      kugou: accountPlatform(row?.kugou_homepage, row?.kugou_fans, row?.kugou_new),
      douyin: accountPlatform(row?.douyin_homepage, row?.douyin_fans, row?.douyin_new),
      qishui: accountPlatform(row?.qishui_homepage, row?.qishui_fans, row?.qishui_new),
    },
  };
}

async function listAccountArtists() {
  const limit = 100;
  const first = await hikoonGet("/open-api/singers", { page: 1, limit });
  const rows = Array.isArray(first?.data) ? [...first.data] : [];
  const total = Number(first?.total) || rows.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  for (let page = 2; page <= pages; page += 1) {
    const next = await hikoonGet("/open-api/singers", { page, limit });
    if (Array.isArray(next?.data)) rows.push(...next.data);
  }
  const seen = new Set();
  const artists = [];
  for (const row of rows) {
    const artist = presentAccountArtist(row);
    const key = artist.name.toLowerCase();
    if (!artist.name || seen.has(key)) continue;
    seen.add(key);
    artists.push(artist);
  }
  return artists;
}

function upsertArtistProfile(rootDir, profile) {
  const saved = readJson(artistProfileFile(rootDir), {});
  const profiles = saved.profiles && typeof saved.profiles === "object" && !Array.isArray(saved.profiles) ? saved.profiles : {};
  const previous = profiles[profile.name] || {};
  const next = {
    ...previous,
    ...profile,
    id: profile.id || previous.id || "",
    avatar: profile.avatar || previous.avatar || "",
    createdAt: previous.createdAt || profile.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  profiles[profile.name] = next;
  writeJson(artistProfileFile(rootDir), { profiles });
  return next;
}

export function mountPublish(app, rootDir) {
  fs.mkdirSync(libraryRoot(rootDir), { recursive: true });

  app.use("/api/publish", (req, res, next) => {
    const header = String(req.get("x-hikoon-key") || "").trim();
    if (!header) return next();
    if (!/^[a-f0-9]{32,128}$/i.test(header)) {
      return res.status(400).json({ ok: false, error: "海葵密钥格式不对" });
    }
    return withHikoonKey(header, () => next());
  });

  app.get("/api/publish/bootstrap", async (req, res) => {
    if (!hikoonConfigured()) {
      return res.json({
        ok: true,
        configured: false,
        keySource: "none",
        libraryDir: loadSettings(rootDir).libraryDir,
        inbox: libraryRoot(rootDir),
        songs: listLibrary(rootDir),
      });
    }
    try {
      const force = String(req.query.fresh || "") === "1";
      const songs = listLibrary(rootDir);
      const libraryDir = loadSettings(rootDir).libraryDir;
      const inbox = libraryRoot(rootDir);
      const cached = force ? null : readSession(rootDir);
      const age = cached ? Date.now() - cached.savedAt : Infinity;
      if (cached && age < SESSION_KEEP_MS) {
        const constants = await loadConstants(rootDir, { allowStale: true });
        if (age >= SESSION_FRESH_MS) scheduleSessionRefresh(rootDir, String(req.get("x-hikoon-key") || "").trim());
        return res.json({
          ok: true,
          configured: true,
          cached: true,
          keySource: hikoonUsingCustomKey() ? "custom" : "server",
          account: cached.account,
          constants,
          libraryDir,
          inbox,
          songs,
          ...publishCatalog(req, cached.releases || [], cached.releaseTotal),
        });
      }
      const [bundle, constants] = await Promise.all([
        pullAccountBundle(),
        loadConstants(rootDir),
      ]);
      rememberSession(rootDir, bundle);
      res.json({
        ok: true,
        configured: true,
        cached: false,
        keySource: hikoonUsingCustomKey() ? "custom" : "server",
        account: bundle.account,
        constants,
        libraryDir,
        inbox,
        songs,
        ...publishCatalog(req, bundle.releases, bundle.releaseTotal),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/publish/library", (req, res) => {
    const dir = String(req.body?.dir || "").trim();
    if (!dir) {
      saveSettings(rootDir, { libraryDir: "" });
      return res.json({ ok: true, libraryDir: "", songs: listLibrary(rootDir) });
    }
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch {
      return res.status(400).json({ ok: false, error: "这个文件夹不存在" });
    }
    if (!stat.isDirectory()) return res.status(400).json({ ok: false, error: "请填写文件夹路径" });
    saveSettings(rootDir, { libraryDir: path.resolve(dir) });
    res.json({ ok: true, libraryDir: path.resolve(dir), songs: listLibrary(rootDir) });
  });

  app.post("/api/publish/import", (req, res, next) => {
    const name = safeName(decodeURIComponent(String(req.headers["x-filename"] || "track.mp3")));
    const ext = path.extname(name).toLowerCase();
    if (!AUDIO_EXT.has(ext)) return res.status(400).json({ ok: false, error: "只接收 mp3、wav、flac、m4a" });
    expressRaw(req, res, next, 200 * 1024 * 1024, (buffer) => {
      const hash = crypto.createHash("sha1").update(buffer).digest("hex");
      const index = loadIndex(rootDir);
      let previous = index.hashes[hash];
      if (!previous) {
        const inbox = libraryRoot(rootDir);
        for (const entry of fs.readdirSync(inbox)) {
          if (entry === "index.json" || entry.startsWith(".")) continue;
          const candidate = path.join(inbox, entry);
          let stat;
          try {
            stat = fs.statSync(candidate);
          } catch {
            continue;
          }
          if (!stat.isFile() || stat.size !== buffer.length) continue;
          const candidateHash = crypto.createHash("sha1").update(fs.readFileSync(candidate)).digest("hex");
          index.hashes[candidateHash] = entry;
          if (!index.files[entry]) {
            const visible = shownFileName(entry, null);
            index.files[entry] = { name: visible.replace(/\.[^.]+$/, ""), fileName: visible, hash: candidateHash };
          }
          if (candidateHash === hash) previous = entry;
        }
        saveIndex(rootDir, index);
      }
      if (previous) {
        const existingPath = path.join(libraryRoot(rootDir), previous);
        if (fs.existsSync(existingPath)) {
          const stat = fs.statSync(existingPath);
          return res.json({
            ok: true,
            duplicate: true,
            song: presentSong(rootDir, {
              id: songId(existingPath),
              name: name.replace(/\.[^.]+$/, ""),
              fileName: previous,
              size: stat.size,
              mtime: stat.mtimeMs,
              path: existingPath,
            }),
            songs: listLibrary(rootDir),
          });
        }
      }
      let stored = `${hash.slice(0, 16)}${ext}`;
      let full = path.join(libraryRoot(rootDir), stored);
      if (fs.existsSync(full)) stored = `${hash.slice(0, 24)}${ext}`;
      full = path.join(libraryRoot(rootDir), stored);
      fs.writeFileSync(full, buffer);
      const stat = fs.statSync(full);
      index.files[stored] = { name: name.replace(/\.[^.]+$/, ""), fileName: name, hash };
      index.hashes[hash] = stored;
      saveIndex(rootDir, index);
      res.json({
        ok: true,
        duplicate: false,
        song: presentSong(rootDir, {
          id: songId(full),
          name: name.replace(/\.[^.]+$/, ""),
          fileName: stored,
          size: stat.size,
          mtime: stat.mtimeMs,
          path: full,
        }),
        songs: listLibrary(rootDir),
      });
    });
  });

  app.post("/api/publish/remove", (req, res) => {
    const song = findSong(rootDir, String(req.body?.id || ""));
    if (!song) return res.status(404).json({ ok: false, error: "找不到这首歌" });
    if (!insideRoot(libraryRoot(rootDir), song.path)) {
      return res.status(400).json({ ok: false, error: "这是原文件夹里的文件，不能从这里删除" });
    }
    const base = path.basename(song.path);
    fs.unlinkSync(song.path);
    const index = loadIndex(rootDir);
    const meta = index.files[base];
    if (meta?.hash) delete index.hashes[meta.hash];
    delete index.files[base];
    saveIndex(rootDir, index);
    res.json({ ok: true, songs: listLibrary(rootDir) });
  });

  app.get("/api/publish/audio/:id", (req, res) => {
    const song = findSong(rootDir, String(req.params.id || ""));
    if (!song) return res.status(404).json({ ok: false, error: "找不到这首歌" });
    res.sendFile(song.path);
  });

  app.get("/api/publish/clip-suggest/:id", async (req, res) => {
    try {
      const song = findSong(rootDir, String(req.params.id || ""));
      if (!song) return res.status(404).json({ ok: false, error: "找不到这首歌" });
      const stat = fs.statSync(song.path);
      const clip = await suggestChorusClip(song.path, `${song.path}:${stat.mtimeMs}:${stat.size}`);
      res.json({ ok: true, start: clip.start, length: clip.length, duration: clip.duration });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/publish/artist-avatar", (req, res, next) => {
    const filename = safeName(decodeURIComponent(String(req.query.name || "avatar.png")));
    expressRaw(req, res, next, 8 * 1024 * 1024, (buffer) => {
      try {
        const url = saveArtistAvatar(rootDir, filename, buffer);
        res.json({ ok: true, url });
      } catch (error) {
        sendError(res, error);
      }
    });
  });

  app.get("/api/publish/artist-avatar/:file", (req, res) => {
    const file = path.basename(String(req.params.file || ""));
    if (!/^[a-z0-9]+\.(?:jpg|jpeg|png|webp)$/i.test(file)) {
      return res.status(404).json({ ok: false, error: "找不到这张头像" });
    }
    const full = path.join(artistAvatarDir(rootDir), file);
    if (!fs.existsSync(full)) return res.status(404).json({ ok: false, error: "找不到这张头像" });
    res.sendFile(full);
  });

  app.get("/api/publish/artist-profiles", async (req, res) => {
    const profiles = loadArtistProfiles(rootDir);
    if (!viewerFrom(req).seeAll || !hikoonConfigured()) {
      return res.json({ ok: true, profiles, artists: [] });
    }
    try {
      res.json({ ok: true, profiles, artists: await listAccountArtists() });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/publish/artist-profiles", (req, res) => {
    const profile = cleanArtistProfile(req.body || {});
    if (!profile) return res.status(400).json({ ok: false, error: "艺人名不能空" });
    res.json({ ok: true, profile: upsertArtistProfile(rootDir, profile) });
  });

  app.get("/api/publish/singers", async (req, res) => {
    try {
      const name = String(req.query.name || "").trim();
      if (!name) return res.status(400).json({ ok: false, error: "先写艺人名" });
      const [usedResult, tmeResult] = await Promise.allSettled([
        hikoonGet("/open-api/singer-skill/used-search", { name }),
        hikoonGet("/open-api/singer-skill/tme-search", { singerName: name, page: 1, size: 8 }),
      ]);
      if (usedResult.status === "rejected" && tmeResult.status === "rejected") throw usedResult.reason;
      const usedList = singerRows(usedResult.status === "fulfilled" ? usedResult.value : null);
      const tmeList = singerRows(tmeResult.status === "fulfilled" ? tmeResult.value : null);
      res.json({
        ok: true,
        used: usedList.map((item) => presentFoundSinger(item, "used")).filter((item) => item.id && item.name),
        tme: tmeList.map((item) => presentFoundSinger(item, "tme")).filter((item) => item.id && item.name),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/publish/singers", async (req, res) => {
    try {
      const body = req.body || {};
      const singerName = String(body.singerName || "").trim();
      const desc = String(body.desc || "").trim();
      const coverId = Number(body.coverId);
      const roleSource = Array.isArray(body.singerRoles) && body.singerRoles.length ? body.singerRoles : [body.singerRole ?? 0];
      const singerRole = roleSource.map(Number).filter((value) => Number.isFinite(value));
      if (!singerName) return res.status(400).json({ ok: false, error: "艺人名不能空" });
      if (desc.length < 10 || desc.length > 255) return res.status(400).json({ ok: false, error: "艺人简介需要 10 到 255 字" });
      if (!Number.isFinite(coverId) || coverId <= 0) return res.status(400).json({ ok: false, error: "先上传一张 1:1 的艺人头像" });
      const created = await hikoonPost("/open-api/singer-skill/create", {
        singer_name: singerName.slice(0, 50),
        singer_type: Number(body.singerType ?? 0),
        singer_role: singerRole.length ? singerRole : [0],
        area: [Number(body.area ?? 1)],
        cover_id: coverId,
        singer_desc: desc,
      });
      const id = created?.id;
      await hikoonPost("/open-api/singer-skill/bind", {
        singer_id: String(id),
        singer_name: singerName,
        source: 2,
      });
      res.json({ ok: true, singer: { id: String(id), name: singerName } });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/publish/upload", (req, res, next) => {
    const type = String(req.query.type || "");
    const contract = type === "contract";
    if (!contract && !["album_cover", "singer_cover"].includes(type)) {
      return res.status(400).json({ ok: false, error: "封面类型不对" });
    }
    const filename = safeName(decodeURIComponent(String(req.query.name || (contract ? "contract.pdf" : "cover.jpg"))));
    const ext = path.extname(filename).toLowerCase();
    const allowed = contract ? new Set([".pdf", ".doc", ".docx", ".jpg", ".jpeg", ".png"]) : COVER_EXT;
    if (!allowed.has(ext)) {
      return res.status(400).json({ ok: false, error: contract ? "合同只收 pdf、word 或图片" : "封面只收 jpg 或 png" });
    }
    expressRaw(req, res, next, 20 * 1024 * 1024, async (buffer) => {
      try {
        const uploaded = await uploadBuffer(type, filename, buffer);
        res.json({ ok: true, fileId: uploaded.file_id });
      } catch (error) {
        sendError(res, error);
      }
    });
  });

  app.post("/api/publish/cover", async (req, res) => {
    try {
      const kind = String(req.body?.kind || "album");
      const artist = String(req.body?.artist || "").trim();
      const songName = String(req.body?.songName || "").trim();
      if (kind === "avatar") {
        if (!artist) return res.status(400).json({ ok: false, error: "先写艺人名，再生成头像" });
      } else if (!songName) {
        return res.status(400).json({ ok: false, error: "先写歌曲名，再生成封面" });
      }
      const image = await geminiImage({
        apiKey: readGeminiKey(rootDir),
        prompt: kind === "avatar" ? avatarPrompt(req.body || {}) : coverPrompt(req.body || {}),
      });
      const ext = image.mimeType === "image/jpeg" ? "jpg" : "png";
      res.json({
        ok: true,
        mime: image.mimeType,
        name: `${kind === "avatar" ? "avatar" : "cover"}.${ext}`,
        image: image.data.toString("base64"),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/publish/duplicates", async (req, res) => {
    try {
      const song = findSong(rootDir, String(req.body?.songId || ""));
      const typed = String(req.body?.songName || "").trim();
      const libraryName = song ? presentSong(rootDir, song).name : "";
      const names = [...new Set([typed, libraryName].filter(Boolean))];
      const viewer = viewerFrom(req);
      let hits = [];
      if (viewer.seeAll && hikoonConfigured() && names.length) {
        try {
          hits = await submittedByName(names);
        } catch {
          hits = [];
        }
      } else if (viewer.loggedIn) {
        hits = Object.values(loadOwners(rootDir))
          .filter((row) => row?.userId === viewer.userId && names.some((name) => sameTitle(name, row.name)))
          .map((row) => ({
            name: row.name,
            singer: row.singer || "",
            status: "",
            statusLabel: "已提交",
            albumName: "",
            file: false,
          }));
      }
      if (song) {
        const hash = knownHash(rootDir, song) || await fileHash(song.path);
        const logged = loadSubmissions(rootDir)[hash];
        const ownFile = viewer.seeAll || (viewer.loggedIn && logged.userId && logged.userId === viewer.userId);
        if (ownFile && !hits.some((hit) => sameTitle(hit.name, logged.name))) {
          hits.unshift({
            name: logged.name || typed || libraryName || "未命名",
            singer: "",
            status: "",
            statusLabel: "",
            albumName: "",
            file: true,
          });
        }
      }
      res.json({ ok: true, hits });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/publish/token", async (_req, res) => {
    try {
      const data = await hikoonPost("/open-api/publish/evidence/create-token", {});
      if (!data?.token) throw new HikoonError("没有拿到授权书令牌");
      res.json({
        ok: true,
        token: data.token,
        expiresIn: data.expires_in,
        contractUrl: contractUrl(data.token),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

function songForms(form) {
  if (Array.isArray(form.songs) && form.songs.length) return form.songs;
  if (!form.songId && !form.songName) return [];
  return [{
    songId: form.songId,
    songName: form.songName,
    subtitle: form.subtitle,
    version: form.version,
    versionNote: form.versionNote,
    language: form.language,
    firstGenre: form.firstGenre,
    secondGenre: form.secondGenre,
    singer: form.singer,
    lyricist: form.lyricist,
    lyricsRight: form.lyricsRight,
    tuneRight: form.tuneRight,
    performerRight: form.performerRight,
    tapeRight: form.tapeRight,
    contractComplete: form.contractComplete,
    contractRemark: form.contractRemark,
    contractFileId: form.contractFileId,
    composer: form.composer,
    arranger: form.arranger,
    producer: form.producer,
    planer: form.planer,
    lyric: form.lyric,
    isAi: form.isAi,
    clipStart: form.clipStart,
  }];
}

async function prepareSong(rootDir, item, shared) {
  const songName = String(item.songName || "").trim().slice(0, 100);
  const song = findSong(rootDir, String(item.songId || ""));
  if (!song) throw new HikoonError(songName ? `曲库里找不到「${songName}」` : "有一首歌还没选音频");
  if (!songName) throw new HikoonError("每首歌都要填歌曲名");
  if (song.size > 180 * 1024 * 1024) throw new HikoonError(`「${songName}」超过 180MB，海葵 URL 转存上限是 200MB`);
  const listed = presentSong(rootDir, song);
  const audioBuffer = fs.readFileSync(song.path);
  const audioHash = crypto.createHash("sha1").update(audioBuffer).digest("hex");
  const audio = await uploadBuffer("audio", listed.fileName || song.fileName, audioBuffer);
  const accomId = String(item.accomSongId || "").trim();
  let accomFileId = 0;
  if (accomId) {
    if (accomId === String(item.songId || "")) throw new HikoonError(`「${songName}」的伴奏不能和原曲是同一个文件`);
    const accom = findSong(rootDir, accomId);
    if (!accom) throw new HikoonError(`「${songName}」的伴奏文件找不到了，请重新上传`);
    if (accom.size > 180 * 1024 * 1024) throw new HikoonError(`「${songName}」的伴奏超过 180MB，海葵 URL 转存上限是 200MB`);
    const accomListed = presentSong(rootDir, accom);
    const uploadedAccom = await uploadBuffer("audio", accomListed.fileName || accom.fileName, fs.readFileSync(accom.path));
    accomFileId = uploadedAccom.file_id;
  }
  const selectedPlatforms = new Set(Array.isArray(shared.form.platforms) ? shared.form.platforms : []);
  let partFileId = "";
  if (selectedPlatforms.has("dy") || selectedPlatforms.has("ks")) {
    const picked = Number(item.clipStart);
    const hasPick = item.clipStart !== "" && item.clipStart != null && Number.isFinite(picked) && picked >= 0;
    const clip = hasPick ? await cutClip(song.path, picked, 30) : await cutChorusClip(song.path);
    const uploaded = await uploadBuffer("audio", `${safeName(songName)}.clip.mp3`, clip);
    partFileId = uploaded.file_id;
  }
  let lyric = { lyric_head: "", lyric_text: "", file_id: "" };
  const singerName = nameList(item.singer, shared.singerName).join("、") || shared.singerName;
  const lyricFile = lyricPayload(item, shared, songName, singerName);
  if (lyricFile) {
    const uploaded = await uploadBuffer("lyric", lyricFile.name, Buffer.from(lyricFile.text, "utf8"));
    const parsed = await hikoonPost("/open-api/publish/lyric-parse", { id: uploaded.file_id });
    lyric = { lyric_head: parsed?.lyric_head || "", lyric_text: parsed?.lyric_text || lyricFile.text, file_id: uploaded.file_id };
  }
  const lyricsRight = originRight(item.lyricsRight);
  const tuneRight = originRight(item.tuneRight);
  const performerRight = originRight(item.performerRight);
  const tapeRight = originRight(item.tapeRight);
  const contractFileId = Number(item.contractFileId);
  return {
    name: songName,
    hash: audioHash,
    body: {
      name: songName,
      subject_no: SIGNING_SUBJECT_NO,
      brand_id: null,
      stamper: null,
      subtitle: String(item.subtitle || "").trim().slice(0, 100),
      version: Number(item.version ?? 1),
      version_note: String(item.versionNote || "").trim().slice(0, 50),
      language: Number(item.language ?? shared.form.language ?? 0),
      issued_time: shared.issued,
      online_time: shared.online,
      first_genre: Number(item.firstGenre ?? shared.form.firstGenre ?? 2),
      second_genre: Number(item.secondGenre ?? shared.form.secondGenre ?? 201),
      pay_pattern: Number(shared.form.payPattern ?? 3),
      ad_flag: Number(shared.form.adFlag ?? 1),
      has_accom: accomFileId ? 1 : 0,
      ...(accomFileId ? { accom_audio_file_id: accomFileId } : {}),
      is_ai: Number(item.isAi) === 0 ? 0 : 1,
      need_fans: Number(shared.form.needFans) === 1 ? 1 : 0,
      lyric_type: 1,
      accom_lyric_sync: 1,
      contract_complete: Number(item.contractComplete) === 1 ? 1 : 0,
      ...(Number.isFinite(contractFileId) && contractFileId > 0 ? { contract_files_id: contractFileId } : {}),
      ...(String(item.contractRemark || "").trim() ? { contract_remark: String(item.contractRemark || "").trim().slice(0, 200) } : {}),
      tme_singers: songArtists(item, shared),
      lyricist: nameList(item.lyricist, shared.singerName),
      composer: nameList(item.composer, shared.singerName),
      arranger: nameList(item.arranger),
      producer: nameList(item.producer),
      planer: nameList(item.planer),
      audio_file_id: audio.file_id,
      txt_file_id: lyric.file_id || "",
      lyric_head: lyric.lyric_head,
      lyric: lyric.lyric_text,
      origins: {
        tape_right: tapeRight.right,
        tape_right_type: tapeRight.type,
        tape_right_date: tapeRight.date,
        tape_right_rate: tapeRight.rate,
        lyrics_right: lyricsRight.right,
        lyrics_right_type: lyricsRight.type,
        lyrics_right_date: lyricsRight.date,
        lyrics_right_rate: lyricsRight.rate,
        tune_right: tuneRight.right,
        tune_right_type: tuneRight.type,
        tune_right_date: tuneRight.date,
        tune_right_rate: tuneRight.rate,
        performer_right: performerRight.right,
        performer_right_type: performerRight.type,
        performer_right_date: performerRight.date,
        performer_right_rate: performerRight.rate,
      },
      recording: shared.recordingRights,
      lyrics: shared.lyricRights,
      composing: shared.composingRights,
      platforms: buildPlatforms(shared.form, shared.issued, shared.copyrightEnd, partFileId),
      singer_sources: shared.form.singerSource ? [shared.form.singerSource] : [],
    },
  };
}

function albumTypeFor(form, songs) {
  const picked = String(form?.albumType || "").trim();
  if (picked === "single" || picked === "ep" || picked === "album") return picked;
  const counted = songs.filter((song) => String(song.versionNote || "").trim() !== "伴奏").length;
  if (counted >= 6) return "album";
  if (counted >= 2) return "ep";
  return "single";
}

  app.post("/api/publish/create", async (req, res) => {
    try {
      const form = req.body || {};
      const viewer = viewerFrom(req);
      if (!viewer.loggedIn && !viewer.custom) {
        return res.status(401).json({ ok: false, error: "请先登录再提交。歌曲会记在这个账号下。" });
      }
      const user = await account();
      if (!user.verified) {
        return res.status(400).json({
          ok: false,
          error: "这个分贝账号还没完成实名认证，海葵会拒绝发行。",
          verifyUrl: user.verifyUrl,
        });
      }
      const constants = await loadConstants(rootDir);
      const forms = songForms(form);
      if (!forms.length) return res.status(400).json({ ok: false, error: "先放进至少一首歌" });
      if (forms.length > 30) return res.status(400).json({ ok: false, error: "一次最多放 30 首" });
      const ids = forms.map((item) => String(item.songId || ""));
      if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
        return res.status(400).json({ ok: false, error: "同一张专辑里每首歌都要有音频，而且不能重复" });
      }
      const coverId = Number(form.coverId);
      const draft = form.draft ? 1 : 0;
      if (!draft && (!Number.isFinite(coverId) || coverId <= 0)) {
        return res.status(400).json({ ok: false, error: "正式提交需要专辑封面" });
      }
      const singerName = String(form.singerName || "").trim();
      const singerId = artistId(form.singerId);
      if (singerId == null || singerId === 0 || !singerName) {
        return res.status(400).json({ ok: false, error: "先选定或新建艺人" });
      }
      if (form.singerSourceType === "tme") {
        try {
          await hikoonPost("/open-api/singer-skill/bind", {
            singer_id: String(form.singerId),
            singer_name: singerName,
            source: 1,
          });
        } catch (error) {
          if (!/已绑定|已存在|重复|已经/.test(error.message || "")) throw error;
        }
      }
      if (!form.confirmed) return res.status(400).json({ ok: false, error: "请先预览授权书，并在授权书页面里确认" });
      const token = String(form.signedContract || "").trim();
      if (!token) return res.status(400).json({ ok: false, error: "授权书令牌缺失，请重新预览" });

      const albumName = String(form.albumName || forms[0]?.songName || "").trim().slice(0, 200);
      if (!albumName || forms.some((item) => !String(item.songName || "").trim())) {
        return res.status(400).json({ ok: false, error: "专辑名和每首歌的歌名都要填" });
      }

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(10, 0, 0, 0);
      const fallbackWhen = stamp(tomorrow);
      const issued = parseWhen(form.issuedTime, fallbackWhen);
      const online = parseWhen(form.onlineTime, fallbackWhen);
      const canCover = Number(form.canCover) === 1 ? 1 : 2;
      const artists = [{ singer_id: singerId, singer_name: singerName }];
      const typedCopyright = String(form.copyrightName || "").trim();
      const rightForm = { ...form, copyrightName: typedCopyright || constants.copyrightName };
      const rightEnd = constants.copyrightEnd?.tme;
      const recordingForm = [1, 2, 3].includes(Number(form.recordingAuthForm)) ? Number(form.recordingAuthForm) : 1;
      const lyricForm = Number(form.lyricAuthForm) === 1 ? 1 : 3;
      const composingForm = Number(form.composingAuthForm) === 1 ? 1 : 3;
      const recordingRights = rightBlock(rightForm, issued, rightEnd, canCover, recordingForm, {
        relationship: form.recordingRelation,
        rightsFlag: form.recordingProtect,
        share: 100,
      });
      const lyricRights = rightBlock(rightForm, issued, rightEnd, canCover, lyricForm, {
        relationship: form.lyricRelation,
        rightsFlag: form.lyricProtect,
        share: form.lyricShare,
      });
      const composingRights = rightBlock(rightForm, issued, rightEnd, canCover, composingForm, {
        relationship: form.composingRelation,
        rightsFlag: form.composingProtect,
        share: form.composingShare,
      });
      const prepared = [];
      for (const item of forms) {
        prepared.push(await prepareSong(rootDir, item, {
          form,
          singerName,
          albumName,
          canCover,
          issued,
          online,
          artists,
          recordingRights,
          lyricRights,
          composingRights,
          copyrightEnd: constants.copyrightEnd,
        }));
      }
      const payload = {
        draft,
        from: "decibel",
        is_manager: 0,
        scene: "all",
        signed_contract: token,
        album: {
          album_name: albumName,
          subject_no: SIGNING_SUBJECT_NO,
          brand_id: null,
          tme_album_id: null,
          album_type: albumTypeFor(form, forms),
          album_area: Number(form.albumArea ?? 1),
          language: Number(form.language ?? 0),
          cover_map_id: Number.isFinite(coverId) && coverId > 0 ? coverId : "",
          brand_show_name: shownBrand(form),
          issued_time: issued,
          online_time: online,
          introduction: String(form.introduction || DEFAULT_ALBUM_INTRO).trim().slice(0, 500) || DEFAULT_ALBUM_INTRO,
          first_genre: Number(form.firstGenre ?? 2),
          second_genre: Number(form.secondGenre ?? 201),
          stamper: null,
          tme_singers: artists,
        },
        songList: prepared.map((item) => item.body),
      };
      const created = await hikoonPost("/open-api/publish/create", payload);
      if (!draft) {
        for (const item of prepared) rememberSubmission(rootDir, item.hash, item.name, created?.album_id, viewer);
      }
      rememberOwners(rootDir, viewer, created, prepared.map((item) => item.name), singerName);
      const createdSongs = (Array.isArray(created?.song_ids) ? created.song_ids : []).map((id, index) => presentRelease({
        id,
        name: prepared[index]?.name || "",
        singer: singerName,
        status: draft ? "DRAFT" : "BUSINESS_REVIEWING",
        album_id: created?.album_id || null,
      }));
      const cacheTag = viewer.seeAll ? hikoonKeyTag() : `${hikoonKeyTag()}:${viewer.userId}`;
      const cacheFile = viewer.seeAll ? releaseCatalogFile(rootDir) : ownedCatalogFile(rootDir, viewer.userId);
      const cacheMemory = viewer.seeAll ? releaseCatalogMemory : ownedCatalogMemory;
      const hadList = Boolean(viewer.seeAll || viewer.userId) && Boolean(readCachedList(cacheMemory, cacheTag, cacheFile));
      if (hadList) prependReleaseCache(rootDir, viewer, createdSongs);
      const visible = hadList
        ? await releaseView(rootDir, req, false).catch(() => ({ releases: createdSongs, total: createdSongs.length }))
        : { releases: createdSongs, total: createdSongs.length, scope: viewer.admin ? "admin" : viewer.seeAll ? "key" : "own" };
      res.json({
        ok: true,
        albumId: created?.album_id,
        songIds: created?.song_ids || [],
        draft: Boolean(draft),
        complete: hadList,
        created: createdSongs,
        releases: visible.releases || createdSongs,
        total: visible.total || (visible.releases || createdSongs).length,
        scope: visible.scope || "",
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/publish/income", async (req, res) => {
    const viewer = viewerFrom(req);
    if (!viewer.seeAll && !viewer.loggedIn) {
      return res.status(401).json({ ok: false, error: "请先登录。登录后查看自己提交的歌的收益。" });
    }
    try {
      const full = await loadSongIncome();
      const releases = await viewerReleases(rootDir, req);
      res.json({ ok: true, ...viewIncome(full, releases, viewer) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/publish/income/export", async (req, res) => {
    const viewer = viewerFrom(req);
    if (!viewer.seeAll && !viewer.loggedIn) {
      return res.status(401).json({ ok: false, error: "请先登录。登录后查看自己提交的歌的收益。" });
    }
    try {
      const full = await loadSongIncome();
      const data = viewIncome(full, await viewerReleases(rootDir, req), viewer);
      const bills = String(req.query.kind || "") === "bills";
      const body = bills
        ? csvTable(
          ["发行渠道", "平台", "结算期间", "歌名", "歌手", "收入", "明细行数"],
          data.bills.bills.map((row) => [data.channel, row.platform, row.month, row.name, row.singer, row.amount, row.lines]),
        )
        : csvTable(
          ["发行渠道", "排名", "歌名", "歌手", "收入", "明细行数"],
          data.songs.songs.map((row) => [data.channel, row.rank, row.name, row.singer, row.income, row.lines]),
        );
      const filename = bills ? "song-income-details.csv" : "song-income.csv";
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(body);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/publish/cancel", async (req, res) => {
    try {
      const viewer = viewerFrom(req);
      const songId = Number(req.body?.id);
      if (!Number.isFinite(songId) || songId <= 0) return res.status(400).json({ ok: false, error: "先选一首歌" });
      if (!ownsSong(rootDir, viewer, songId, "")) {
        return res.status(403).json({ ok: false, error: viewer.loggedIn ? "只能撤销自己提交的歌" : "请先登录" });
      }
      const cached = cachedRelease(rootDir, viewer, songId);
      if (cached?.status && cached.status !== "BUSINESS_REVIEWING") {
        return res.status(400).json({ ok: false, error: "只有审核中的歌可以撤销" });
      }
      const albumId = Number(cached?.albumId || req.body?.albumId);
      let scene = Number.isFinite(albumId) && albumId > 0 ? "album" : "song";
      try {
        await hikoonPost("/open-api/publish/cancel", { id: scene === "album" ? albumId : songId, scene });
      } catch (error) {
        if (scene !== "album") throw error;
        await hikoonPost("/open-api/publish/cancel", { id: songId, scene: "song" });
        scene = "song";
      }
      stampCancelled(rootDir, viewer, songId, albumId, scene);
      res.json({ ok: true, status: "BUSINESS_CANCELLED", statusLabel: STATUS_LABEL.BUSINESS_CANCELLED, scene });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/publish/releases", async (req, res) => {
    try {
      const fresh = String(req.query.fresh || "") === "1";
      const viewer = viewerFrom(req);
      if (viewer.seeAll) {
        const cached = fresh ? null : readSession(rootDir);
        const age = cached ? Date.now() - cached.savedAt : Infinity;
        if (cached && age >= SESSION_FRESH_MS && age < SESSION_KEEP_MS) {
          scheduleSessionRefresh(rootDir, String(req.get("x-hikoon-key") || "").trim());
        }
      }
      res.json({ ok: true, ...await releaseView(rootDir, req, fresh) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/publish/analytics", async (req, res) => {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const fresh = String(req.query.fresh || "") === "1";
      res.json({ ok: true, ...await accountAnalytics(rootDir, viewerFrom(req), page, fresh) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/publish/plays", async (req, res) => {
    const name = String(req.query.name || "").trim();
    const singer = String(req.query.singer || "").trim();
    const id = Number(req.query.id);
    const viewer = viewerFrom(req);
    if (!name) return res.status(400).json({ ok: false, error: "先选一首已上架的歌" });
    if (!ownsSong(rootDir, viewer, id, name)) {
      return res.status(403).json({ ok: false, error: viewer.loggedIn ? "只能查看自己提交的歌" : "请先登录" });
    }
    let shelf = [];
    let shelfError = "";
    if (Number.isFinite(id) && id > 0) {
      try {
        shelf = await songShelf(id);
      } catch (error) {
        shelfError = error.message || "平台状态没有读出来";
      }
    }
    res.json({ ok: true, name, singer, shelf, shelfError, platforms: await songPlays(name, singer) });
  });
}

function expressRaw(req, res, next, limit, handler) {
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > limit) {
      res.status(413).json({ ok: false, error: "文件太大" });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (res.headersSent) return;
    Promise.resolve(handler(Buffer.concat(chunks))).catch(next);
  });
  req.on("error", next);
}
