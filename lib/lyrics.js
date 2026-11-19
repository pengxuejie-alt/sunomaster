const HEADERS = {
  "User-Agent": "Mozilla/5.0",
  Referer: "https://y.qq.com/",
};

const CREDIT_LABEL = /^(词|曲|编曲|制作人?|监制|吉他|贝斯|鼓|合声编写|和声编写|合声|和声|弦乐|钢琴|录音助理|录音工程|录音师?|混音工程|混音师?|母带工程师|母带|出品|企划|缩混|键盘|萨克斯|统筹|OP|SP|音频编辑|编程)$/i;

export async function findLyrics(song, artist) {
  const title = String(song || "").trim();
  const singer = String(artist || "").trim();
  if (!title || title === "原创") return { lyrics: "", matched: "" };
  const query = [title, singer].filter(Boolean).join(" ");
  const attempts = [
    () => fromQQ(query, title, singer),
    () => fromNetease(query, title, singer),
  ];
  for (const attempt of attempts) {
    try {
      const found = await attempt();
      if (found?.lyrics) return found;
    } catch {
      // 换下一个来源
    }
  }
  return { lyrics: "", matched: "" };
}

async function fromQQ(query, title, singer) {
  const url = `https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?format=json&platform=h5&n=8&p=1&w=${encodeURIComponent(query)}`;
  const data = await getJson(url, HEADERS);
  const list = data?.data?.song?.list || [];
  const song = pick(list, title, singer, (item) => item.songname, (item) => (item.singer || []).map((row) => row.name));
  if (!song?.songmid) return null;
  const lyricUrl = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(song.songmid)}&format=json&nobase64=1`;
  const lyricData = await getJson(lyricUrl, HEADERS);
  const lyrics = cleanLrc(decodeLyric(lyricData?.lyric), title, singer);
  if (!lyrics) return null;
  return { lyrics, matched: label(song.songname, (song.singer || []).map((row) => row.name).filter(Boolean).join("、")) };
}

async function fromNetease(query, title, singer) {
  const url = `https://music.163.com/api/search/get/web?s=${encodeURIComponent(query)}&type=1&offset=0&limit=8`;
  const data = await getJson(url, { "User-Agent": HEADERS["User-Agent"], Referer: "https://music.163.com/" });
  const list = data?.result?.songs || [];
  const song = pick(list, title, singer, (item) => item.name, (item) => (item.artists || []).map((row) => row.name));
  if (!song?.id) return null;
  const lyricUrl = `https://music.163.com/api/song/lyric?id=${song.id}&lv=-1&tv=-1`;
  const lyricData = await getJson(lyricUrl, { "User-Agent": HEADERS["User-Agent"], Referer: "https://music.163.com/" });
  const lyrics = cleanLrc(lyricData?.lrc?.lyric, title, singer);
  if (!lyrics) return null;
  return { lyrics, matched: label(song.name, (song.artists || []).map((row) => row.name).filter(Boolean).join("、")) };
}

function pick(list, title, singer, nameOf, artistsOf) {
  const wantTitle = fold(title);
  const wantArtists = String(singer || "").split(/[、,，/&＆]/).map(fold).filter((item) => item.length >= 1);
  let best = null;
  let bestScore = 0;
  for (const item of list) {
    const name = fold(nameOf(item));
    if (!name || !wantTitle) continue;
    let score = 0;
    if (name === wantTitle) score += 50;
    else if (name.startsWith(wantTitle) || wantTitle.startsWith(name)) score += 18;
    else continue;
    const artists = artistsOf(item).map(fold).filter(Boolean);
    if (wantArtists.length) {
      const hit = wantArtists.some((who) => artists.some((itemName) => itemName.includes(who) || who.includes(itemName)));
      if (!hit) continue;
      score += 30;
    }
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

function cleanLrc(raw, title, singer) {
  const text = String(raw || "").replace(/^\uFEFF/, "").replace(/\r/g, "");
  const lines = [];
  for (const row of text.split("\n")) {
    const line = row.replace(/(\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\])+/g, "").replace(/\[[A-Za-z]+:[^\]]*\]/g, "").trim();
    if (!line || isCredit(line) || isTitleLine(line, title, singer)) continue;
    lines.push(line);
  }
  const body = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (body.replace(/\s/g, "").length < 8) return "";
  return body.slice(0, 8000);
}

function isCredit(line) {
  const index = line.search(/[:：]/);
  if (index <= 0 || index > 12) return false;
  return CREDIT_LABEL.test(line.slice(0, index).trim());
}

function isTitleLine(line, title, singer) {
  if (!/[-–—]/.test(line) || line.length > 48) return false;
  const flat = fold(line);
  const wanted = fold(title);
  if (!wanted || !flat.includes(wanted)) return false;
  const who = fold(singer);
  return !who || flat.includes(who.slice(0, Math.min(who.length, 4)));
}

function decodeLyric(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.includes("[") || /[\u4e00-\u9fff]/.test(text)) return text;
  try {
    const decoded = Buffer.from(text, "base64").toString("utf8");
    if (decoded.includes("[") || /[\u4e00-\u9fff]/.test(decoded)) return decoded;
  } catch {
    // 保持原文
  }
  return text;
}

function label(name, artist) {
  return [name, artist].filter(Boolean).join(" · ");
}

function fold(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[·・,，/&＆|｜\-–—]/g, "");
}

async function getJson(url, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`歌词来源 ${response.status}`);
  return response.json();
}
