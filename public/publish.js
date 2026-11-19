const HIKOON_KEY_STORAGE = "sunomaster.hikoonKey";
const PUBLISH_SNAPSHOT = "sunomaster.publishSnapshot";
const DEFAULT_ALBUM_INTRO = "本专辑收录原创歌曲，欢迎收听。";
const VERSION_NOTES = ["", "伴奏", "未知", "Radio Edit", "清晰版", "Live", "TV Version", "Demo"];
const VERSION_LABELS = { 1: "原版", 2: "翻唱", 3: "衍生版" };
const PAY_HINT = { 1: "听众可以完整收听", 3: "当前默认档" };

const publishState = {
  booted: false,
  busy: false,
  step: 1,
  tracks: [],
  library: [],
  previewId: "",
  songId: "",
  singerId: "",
  singerName: "",
  singerSourceType: "",
  singerSource: null,
  albumTypeManual: false,
  token: "",
  contractUrl: "",
  contractOpened: false,
  constants: null,
  keySource: "",
  verified: false,
  verifyUrl: "https://mind.hikoon.com/account/verify",
  coverBlob: null,
  coverName: "",
  coverUrl: "",
  avatarBlob: null,
  avatarName: "",
  avatarUrl: "",
  singerTarget: null,
};

function readHikoonKey() {
  try {
    return localStorage.getItem(HIKOON_KEY_STORAGE) || "";
  } catch {
    return "";
  }
}

function writeHikoonKey(value) {
  try {
    if (value) localStorage.setItem(HIKOON_KEY_STORAGE, value);
    else localStorage.removeItem(HIKOON_KEY_STORAGE);
  } catch {
    /* 浏览器禁止本地存储时，这次密钥只留在内存里 */
  }
}

function normalizeHikoonKey(text) {
  const match = String(text || "").match(/[a-f0-9]{32,128}/i);
  return match ? match[0] : "";
}

function snapshotId() {
  const key = readHikoonKey();
  return key ? `custom:${key.slice(-8)}` : "server";
}

function readPublishSnapshot() {
  try {
    const saved = JSON.parse(localStorage.getItem(PUBLISH_SNAPSHOT) || "null");
    if (!saved || saved.id !== snapshotId() || !saved.payload?.configured) return null;
    if (!saved.savedAt || Date.now() - saved.savedAt > 24 * 60 * 60 * 1000) return null;
    return saved.payload;
  } catch {
    return null;
  }
}

function writePublishSnapshot(data) {
  if (!data?.configured || !data.account) return;
  const previous = readPublishSnapshot();
  try {
    localStorage.setItem(PUBLISH_SNAPSHOT, JSON.stringify({
      id: snapshotId(),
      savedAt: Date.now(),
      payload: {
        configured: true,
        keySource: data.keySource || previous?.keySource || "",
        account: data.account,
        constants: data.constants || previous?.constants || null,
        songs: data.songs?.length ? data.songs : (previous?.songs || []),
        releases: [],
        releaseTotal: 0,
      },
    }));
  } catch {
    /* 浏览器存不下时，这次仍用接口返回的结果 */
  }
}

function publishFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const key = readHikoonKey();
  if (key) headers.set("X-Hikoon-Key", key);
  return fetch(url, { ...options, headers });
}

const singerTypes = [["0", "男"], ["1", "女"], ["2", "组合"], ["5", "虚拟艺人"], ["3", "其他"]];
const singerRoles = [["0", "歌手"], ["1", "音乐人"], ["2", "DJ"], ["7", "演奏者"], ["9", "作词"], ["10", "作曲"], ["12", "制作人"], ["15", "其他"]];
const singerAreas = [["1", "内地"], ["0", "港台"], ["2", "日韩"], ["3", "欧美"], ["5", "东南亚"], ["4", "海外其他"]];
const ARTIST_PLATFORMS = [
  ["qq", "Q音"],
  ["netease", "网易云"],
  ["kugou", "酷狗"],
  ["douyin", "抖音"],
  ["qishui", "汽水"],
];
const ARTIST_PAGE = 6;
const artistBoard = { query: "", filter: "all", page: 1, profiles: [], artists: [], ready: false, blob: null, avatarUrl: "", locked: false, editing: "", fromUpload: false };
const ALBUM_AREAS = [
  ["1", "内地"],
  ["0", "港台"],
  ["3", "欧美"],
  ["5", "东南亚"],
  ["4", "其他"],
  ["6", "未知"],
].map(([value, label]) => ({ value, label }));
const ALBUM_TYPE_LABEL = { single: "Single", ep: "EP", album: "Album" };

function pub(id) {
  return document.getElementById(id);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function fanCount(count) {
  const value = Number(count) || 0;
  if (value >= 100000000) return `${(value / 100000000).toFixed(1)}亿`;
  if (value >= 10000) return `${(value / 10000).toFixed(value >= 100000 ? 0 : 1)}万`;
  return String(value);
}

function singerNote(item) {
  const fans = Array.isArray(item.fans) ? item.fans.map((fan) => `${fan.label} ${fanCount(fan.count)}粉`).join(" · ") : "";
  if (item.desc && fans) return `${item.desc}\n${fans}`;
  if (item.desc) return item.desc;
  if (fans) return fans;
  return item.source === "used" ? "这个账号已经用过，曲库没有更多介绍。" : "曲库没有返回简介。";
}

function singerCard(item, index) {
  const pic = /^https?:\/\//i.test(item.pic || "")
    ? `<img src="${esc(item.pic)}" alt="" referrerpolicy="no-referrer" class="h-12 w-12 shrink-0 rounded-lg object-cover bg-slate-100">`
    : `<span class="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-sm font-bold text-slate-400">${esc(String(item.name || "?").slice(0, 1))}</span>`;
  const tag = item.source === "tme" ? "TME 曲库" : "已用艺人";
  return `<button type="button" data-singer="${index}" class="flex w-full items-start gap-3 rounded-xl border border-slate-200 px-3 py-2 text-left text-sm">
    ${pic}
    <span class="min-w-0">
      <strong class="text-slate-900">${esc(item.name)}</strong>
      <span class="text-slate-400"> ${tag}</span>
      <span class="mt-0.5 block whitespace-pre-line text-xs leading-5 text-slate-500">${esc(singerNote(item))}</span>
    </span>
  </button>`;
}

function fillSelect(id, options, selected) {
  const node = pub(id);
  if (!node) return;
  const list = (options || []).filter((item) => item && item.value != null && String(item.label || "").trim());
  const keep = selected != null ? String(selected) : node.value;
  if (!list.length) {
    if ([...node.options].some((option) => option.value === keep)) node.value = keep;
    return;
  }
  node.innerHTML = list.map((item) => `<option value="${esc(item.value)}">${esc(item.label)}</option>`).join("");
  if ([...node.options].some((option) => option.value === keep)) node.value = keep;
}

function localStamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fillSecondGenre() {
  const map = publishState.constants?.secondGenre || {};
  const first = pub("publish-genre")?.value || "2";
  const options = Object.entries(map[first] || {}).map(([value, label]) => ({ value, label: String(label) }));
  const selected = first === "2" ? "201" : (pub("publish-genre2")?.value || options[0]?.value);
  fillSelect("publish-genre2", options, selected);
}

function applyConstants(constants) {
  publishState.constants = constants || {};
  fillSelect("publish-language", constants.language, pub("publish-language")?.value || "0");
  fillSelect("publish-area", ALBUM_AREAS, pub("publish-area")?.value || "1");
  fillSelect("publish-genre", constants.firstGenre, pub("publish-genre")?.value || "2");
  fillSecondGenre();
  fillSelect("publish-pay", constants.payPattern, "3");
  fillSelect("publish-auth-area", constants.authArea, "0");
  fillSelect("publish-cover", constants.canCover, "2");
  const brand = pub("publish-brand");
  const brandTypos = ["Hikoon Music", "鸿声无限", "鸿升无限", "海声无限"];
  const brandName = constants.brandShowName && !brandTypos.includes(constants.brandShowName)
    ? constants.brandShowName
    : "泓声无限";
  if (brand && (!brand.value || brandTypos.includes(brand.value))) brand.value = brandName;
  const rightEnd = pub("publish-right-end");
  if (rightEnd) rightEnd.value = String(constants.copyrightEnd?.tme || "2027-12-31").slice(0, 10);
  renderPayCards();
  paintAlbumPreset();
  paintAuthPreset();
  if (publishState.tracks.length) {
    readTracksFromDom();
    renderTracks();
  }
}

function renderPayCards() {
  const box = pub("publish-pay-cards");
  const select = pub("publish-pay");
  if (!box || !select) return;
  const current = select.value;
  box.innerHTML = [...select.options].map((option) => {
    const on = option.value === current;
    return `<label class="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-700">
      <input type="radio" name="publish-pay-radio" value="${esc(option.value)}" ${on ? "checked" : ""} class="accent-orange-500">
      ${esc(option.textContent)}
    </label>`;
  }).join("");
}

function paintAuthPreset() {
  const area = selectedText("publish-auth-area", "中国大陆");
  const end = String(publishState.constants?.copyrightEnd?.tme || "2027-12-31").slice(0, 10);
  const brand = pub("publish-brand")?.value.trim() || "泓声无限";
  const lines = {
    recording: `${area} · 重点版权 · 自有 · 可维权 · ${brand} · 至 ${end}`,
    lyrics: `${area} · 普通版权 · 自有 · 份额 100% · 可维权 · ${brand} · 至 ${end}`,
    composing: `${area} · 普通版权 · 自有 · 份额 100% · 可维权 · ${brand} · 至 ${end}`,
  };
  document.querySelectorAll("[data-auth-preset]").forEach((node) => {
    node.textContent = lines[node.dataset.authPreset] || lines.recording;
  });
}

function secondGenreOptions(first) {
  const map = publishState.constants?.secondGenre || {};
  const key = String(first || "2");
  const options = Object.entries(map[key] || {}).map(([value, label]) => ({ value, label: String(label) }));
  return { options, selected: key === "2" ? "201" : options[0]?.value || "" };
}

function optionLabel(list, value) {
  const hit = (list || []).find((item) => String(item.value) === String(value));
  return hit?.label || "";
}

function selectHtml(field, options, selected) {
  const opts = (options || []).map((item) => {
    const on = String(item.value) === String(selected) ? " selected" : "";
    return `<option value="${esc(item.value)}"${on}>${esc(item.label)}</option>`;
  }).join("");
  return `<select data-field="${field}" class="field mt-1">${opts}</select>`;
}

const RIGHT_LYRIC = [["0", "无"], ["1", "自有"], ["2", "代理"], ["4", "授权"]];
const RIGHT_PERFORM = [["0", "无"], ["1", "自有"], ["2", "代理"]];

function rightWord(value) {
  return { 0: "无", 1: "自有", 2: "代理", 4: "授权" }[Number(value)] || "自有";
}

function rightSummary(track) {
  const version = VERSION_LABELS[track.version] || "原版";
  return `${version} · 词${rightWord(track.lyricsRight)} · 曲${rightWord(track.tuneRight)} · 表演${rightWord(track.performerRight)} · 录音${rightWord(track.tapeRight)}`;
}

function radioHtml(group, attr, items, current) {
  return items.map(([value, label]) => `<label class="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-700">
    <input type="radio" name="${esc(group)}" ${attr}="${esc(value)}" value="${esc(value)}" ${String(current) === String(value) ? "checked" : ""} class="accent-orange-500">
    ${esc(label)}
  </label>`).join("");
}

function blankTrack(song) {
  const artist = publishState.singerName || pub("publish-artist")?.value.trim() || "";
  return {
    songId: song.id,
    name: song.name || "",
    fileName: song.fileName || "",
    isAi: 1,
    version: "1",
    versionNote: "",
    language: pub("publish-language")?.value || "0",
    firstGenre: pub("publish-genre")?.value || "2",
    secondGenre: pub("publish-genre2")?.value || "201",
    singer: artist,
    lyricist: artist,
    composer: artist,
    lyricsRight: "1",
    tuneRight: "1",
    performerRight: "1",
    tapeRight: "1",
    contractComplete: "0",
    contractRemark: "",
    contractFileId: "",
    contractName: "",
    clipStart: "",
    clipPicked: false,
    subtitle: "",
    arranger: "",
    producer: "",
    planer: "",
    lyricMode: "txt",
    lyric: "",
    accomSongId: "",
    accomFileName: "",
    accomUploading: false,
    accomRatio: 0,
    accomWait: false,
    accomLabel: "",
    open: true,
  };
}

function readTracksFromDom() {
  const root = pub("publish-tracks");
  if (!root || root.dataset.ready !== "1") return;
  const cards = [...root.querySelectorAll("[data-track]")];
  if (!cards.length) return;
  publishState.tracks = cards.map((card) => {
    const songId = card.dataset.track;
    const prev = publishState.tracks.find((track) => track.songId === songId) || {};
    const field = (name) => card.querySelector(`[data-field="${name}"]`)?.value ?? "";
    const lyricMode = card.querySelector("[data-lyric-mode]:checked")?.value || "txt";
    return {
      songId,
      name: field("name"),
      fileName: prev.fileName || "",
      isAi: card.querySelector("[data-ai]:checked")?.value === "0" ? 0 : 1,
      version: card.querySelector("[data-version]:checked")?.value || "1",
      versionNote: field("versionNote"),
      language: field("language") || "0",
      firstGenre: field("firstGenre") || "2",
      secondGenre: field("secondGenre") || "201",
      singer: field("singer"),
      lyricist: field("lyricist"),
      composer: field("composer"),
      lyricsRight: card.querySelector("[data-right-group='lyrics'] input:checked")?.value || "1",
      tuneRight: card.querySelector("[data-right-group='tune'] input:checked")?.value || "1",
      performerRight: card.querySelector("[data-right-group='performer'] input:checked")?.value || "1",
      tapeRight: card.querySelector("[data-right-group='tape'] input:checked")?.value || "1",
      contractComplete: card.querySelector("[data-contract-complete]:checked")?.value || "0",
      contractRemark: field("contractRemark"),
      contractFileId: prev.contractFileId || "",
      contractName: prev.contractName || "",
      clipStart: prev.clipStart === 0 || prev.clipStart ? prev.clipStart : "",
      clipPicked: Boolean(prev.clipPicked),
      subtitle: field("subtitle"),
      arranger: field("arranger"),
      producer: field("producer"),
      planer: field("planer"),
      lyricMode,
      lyric: lyricMode === "none" ? "" : field("lyric"),
      accomSongId: prev.accomSongId || "",
      accomFileName: prev.accomFileName || "",
      accomUploading: Boolean(prev.accomUploading),
      accomRatio: Number(prev.accomRatio) || 0,
      accomWait: Boolean(prev.accomWait),
      accomLabel: prev.accomLabel || "",
      open: prev.open !== false,
    };
  });
}

function selectedText(id, fallback) {
  const label = pub(id)?.selectedOptions?.[0]?.textContent?.trim();
  return label || fallback;
}

function paintAlbumPreset() {
  const summary = pub("publish-preset-summary");
  const subject = pub("publish-subject");
  if (subject) subject.value = publishState.constants?.subjectName || "海南海之轨迹文化传媒有限公司";
  if (!summary) return;
  const area = selectedText("publish-area", "内地");
  const language = selectedText("publish-language", "普通话");
  const genre = selectedText("publish-genre", "流行");
  const genre2 = selectedText("publish-genre2", "中文流行");
  const kind = ALBUM_TYPE_LABEL[pub("publish-album-type")?.value] || "Single";
  summary.textContent = `${kind} · ${area} · ${language} · ${genre} / ${genre2}`;
}

function suggestedAlbumType(count) {
  if (count >= 6) return "album";
  if (count >= 2) return "ep";
  return "single";
}

function updateAlbumHint() {
  const node = pub("publish-album-type");
  const count = pub("publish-track-count");
  const total = publishState.tracks.length;
  const real = publishState.tracks.filter((track) => track.versionNote !== "伴奏").length;
  if (count) count.textContent = `${total} 首`;
  if (node && !publishState.albumTypeManual) node.value = suggestedAlbumType(real);
  paintAlbumPreset();
}

function accomBlock(track) {
  const percent = Math.max(0, Math.min(100, Math.round((Number(track.accomRatio) || 0) * 100)));
  const uploading = Boolean(track.accomUploading);
  const progress = `<div data-accom-progress class="${uploading ? "" : "hidden"} mt-2">
    <div class="flex items-center justify-between gap-3 text-xs font-bold">
      <span data-accom-label class="min-w-0 truncate text-slate-600">${esc(track.accomLabel || "正在上传伴奏")}</span>
      <span data-accom-percent class="shrink-0 tabular-nums text-orange-600">${percent}%</span>
    </div>
    <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
      <div data-accom-bar class="publish-upload-bar h-full rounded-full${track.accomWait ? " is-wait" : ""}" style="width:${percent}%"></div>
    </div>
  </div>`;
  if (track.accomSongId && !uploading) {
    return `<div class="text-sm font-bold text-slate-700">伴奏<span class="ml-1 text-xs font-semibold text-slate-400">可选</span>
      <audio class="mt-1 w-full" controls preload="none" src="/api/publish/audio/${encodeURIComponent(track.accomSongId)}"></audio>
      <div class="mt-1 flex items-center justify-between gap-2">
        <p class="min-w-0 truncate text-xs font-medium text-slate-400">${esc(track.accomFileName || "伴奏")}</p>
        <span class="flex shrink-0 items-center gap-3">
          <label class="cursor-pointer text-xs font-bold text-amber-600">更换
            <input data-accom-file type="file" accept=".mp3,.wav,.flac,.m4a,audio/*" class="hidden">
          </label>
          <button type="button" data-accom-clear class="text-xs font-bold text-slate-400 hover:text-red-600">移除</button>
        </span>
      </div>
    </div>`;
  }
  return `<div class="text-sm font-bold text-slate-700">伴奏<span class="ml-1 text-xs font-semibold text-slate-400">可选</span>
    <label class="mt-1 flex cursor-pointer items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white px-3 py-3 text-xs font-bold text-slate-500 ${uploading ? "pointer-events-none opacity-50" : ""}">
      ${uploading ? "正在上传伴奏" : "上传伴奏"}
      <input data-accom-file type="file" accept=".mp3,.wav,.flac,.m4a,audio/*" class="hidden" ${uploading ? "disabled" : ""}>
    </label>
    ${progress}
  </div>`;
}

function paintAccomProgress(songId) {
  const track = publishState.tracks.find((item) => item.songId === songId);
  const card = document.querySelector(`[data-track="${CSS.escape(songId)}"]`);
  if (!track || !card) return;
  const box = card.querySelector("[data-accom-progress]");
  const bar = card.querySelector("[data-accom-bar]");
  const label = card.querySelector("[data-accom-label]");
  const percentNode = card.querySelector("[data-accom-percent]");
  if (!box || !bar) return;
  const percent = Math.max(0, Math.min(100, Math.round((Number(track.accomRatio) || 0) * 100)));
  box.classList.remove("hidden");
  if (label) label.textContent = track.accomLabel || "正在上传伴奏";
  if (percentNode) percentNode.textContent = `${percent}%`;
  bar.style.width = `${percent}%`;
  bar.classList.toggle("is-wait", Boolean(track.accomWait));
}

async function uploadTrackAccom(songId, file) {
  readTracksFromDom();
  const track = publishState.tracks.find((item) => item.songId === songId);
  if (!track || !file) return;
  if (publishState.busy) {
    toast("正在上传，请稍等");
    return;
  }
  if (!/\.(mp3|wav|flac|m4a)$/i.test(file.name) || file.name.startsWith(".")) {
    toast("伴奏只接收 mp3、wav、flac 或 m4a");
    return;
  }
  track.accomUploading = true;
  track.accomRatio = 0;
  track.accomWait = false;
  track.accomLabel = `正在上传 ${file.name}`;
  renderTracks();
  setLibraryBusy(true);
  try {
    const data = await uploadAudio(file, (ratio) => {
      const current = publishState.tracks.find((item) => item.songId === songId);
      if (!current) return;
      const waiting = ratio >= 1;
      current.accomRatio = waiting ? 0.92 : Math.min(ratio, 0.92);
      current.accomWait = waiting;
      current.accomLabel = waiting ? `正在处理 ${file.name}` : `正在上传 ${file.name}`;
      paintAccomProgress(songId);
    });
    const saved = publishState.tracks.find((item) => item.songId === songId);
    if (!saved) return;
    const attached = data.song;
    saved.accomUploading = false;
    saved.accomWait = false;
    if (!attached?.id || attached.id === songId) {
      renderTracks();
      toast(attached?.id === songId ? "伴奏不能和原曲是同一个文件" : "伴奏没有传上去");
      return;
    }
    saved.accomSongId = attached.id;
    saved.accomFileName = attached.fileName || file.name;
    if (Array.isArray(data.songs)) renderSongs(data.songs);
    renderTracks();
    toast("伴奏已上传");
  } catch (error) {
    const saved = publishState.tracks.find((item) => item.songId === songId);
    if (saved) {
      saved.accomUploading = false;
      saved.accomWait = false;
    }
    renderTracks();
    toast(error.message || "伴奏上传失败");
  } finally {
    setLibraryBusy(false);
  }
}

function renderTracks() {
  const root = pub("publish-tracks");
  if (!root) return;
  if (!publishState.tracks.length) {
    root.innerHTML = '<p class="text-sm text-slate-500">还没有歌曲。</p>';
    updateAlbumHint();
    return;
  }
  const languages = publishState.constants?.language || [];
  const genres = publishState.constants?.firstGenre || [];
  root.innerHTML = publishState.tracks.map((track, index) => {
    const version = VERSION_LABELS[track.version] || "原版";
    const language = optionLabel(languages, track.language) || "普通话";
    const second = secondGenreOptions(track.firstGenre);
    const secondValue = (second.options || []).some((item) => String(item.value) === String(track.secondGenre))
      ? track.secondGenre
      : second.selected;
    const albumOptions = (id) => [...(pub(id)?.options || [])].map((option) => ({ value: option.value, label: option.textContent }));
    const languageList = languages.length ? languages : (albumOptions("publish-language").length ? albumOptions("publish-language") : [{ value: track.language || "0", label: "普通话" }]);
    const genreList = genres.length ? genres : (albumOptions("publish-genre").length ? albumOptions("publish-genre") : [{ value: track.firstGenre || "2", label: "流行" }]);
    const secondList = (second.options || []).length ? second.options : (albumOptions("publish-genre2").length ? albumOptions("publish-genre2") : [{ value: secondValue || "201", label: "中文流行" }]);
    const moreOpen = [track.subtitle, track.arranger, track.producer, track.planer].some(Boolean);
    return `<article data-track="${esc(track.songId)}" class="rounded-2xl border border-amber-200 bg-amber-50/50">
      <header class="flex items-center gap-3 px-4 py-3">
        <span class="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white text-xs font-black text-slate-500">${index + 1}</span>
        <div class="min-w-0 flex-1">
          <div data-track-title class="truncate text-sm font-bold text-slate-900">${esc(track.name || "未命名")}</div>
          <div data-track-meta class="text-xs text-slate-500">${esc(track.singer || "未填歌手")} · 版本：${esc(version)} · 语言：${esc(language)}${track.accomSongId ? " · 含伴奏" : ""}</div>
        </div>
        <button type="button" data-collapse class="shrink-0 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600">${track.open ? "收起" : "展开"}</button>
        <button type="button" data-remove class="shrink-0 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-400 hover:text-red-600">移出</button>
      </header>
      <div data-track-body class="${track.open ? "" : "hidden"} space-y-4 border-t border-amber-100 px-4 py-4">
        <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div class="space-y-3">
          <label class="block text-sm font-bold text-slate-700">歌曲名称<span class="text-orange-500"> *</span>
            <input data-field="name" class="field mt-1" value="${esc(track.name)}">
          </label>
          <div class="text-sm font-bold text-slate-700">歌手<span class="text-orange-500"> *</span>
            <div class="mt-1 flex gap-2">
              <input data-field="singer" class="field min-w-0 flex-1" value="${esc(track.singer)}" placeholder="输入即查找，多人用顿号分隔">
              <button type="button" data-new-singer class="shrink-0 text-sm font-bold text-amber-600">新建歌手</button>
            </div>
            <div data-singer-results class="mt-2 hidden space-y-2"></div>
          </div>
          <label class="block text-sm font-bold text-slate-700">语种<span class="text-orange-500"> *</span>${selectHtml("language", languageList, track.language)}</label>
          <label class="block text-sm font-bold text-slate-700">曲风流派<span class="text-orange-500"> *</span>${selectHtml("firstGenre", genreList, track.firstGenre)}</label>
          <label class="block text-sm font-bold text-slate-700">二级流派<span class="text-orange-500"> *</span>${selectHtml("secondGenre", secondList, secondValue)}</label>
          <div class="text-sm font-bold text-slate-700">AI 内容声明
            <div class="mt-1 flex flex-wrap gap-4">${radioHtml(`ai-${index}`, "data-ai", [["0", "非 AI 生成"], ["1", "AI 生成"]], String(track.isAi))}</div>
          </div>
          <details class="rounded-xl border border-slate-200 bg-white px-3 py-2">
            <summary class="cursor-pointer text-sm font-bold text-slate-700">版权信息<span data-right-summary class="ml-2 font-semibold text-slate-400">${esc(rightSummary(track))}</span></summary>
            <div class="mt-3 space-y-4">
              <div class="text-sm font-bold text-slate-700">词著作权<span class="text-orange-500"> *</span>
                <div class="mt-2 flex flex-wrap gap-4" data-right-group="lyrics">${radioHtml(`lyrics-right-${index}`, "data-right-choice", RIGHT_LYRIC, track.lyricsRight || "1")}</div>
              </div>
              <div class="text-sm font-bold text-slate-700">曲著作权<span class="text-orange-500"> *</span>
                <div class="mt-2 flex flex-wrap gap-4" data-right-group="tune">${radioHtml(`tune-right-${index}`, "data-right-choice", RIGHT_LYRIC, track.tuneRight || "1")}</div>
              </div>
              <div class="text-sm font-bold text-slate-700">表演者权<span class="text-orange-500"> *</span>
                <div class="mt-2 flex flex-wrap gap-4" data-right-group="performer">${radioHtml(`performer-right-${index}`, "data-right-choice", RIGHT_PERFORM, track.performerRight || "1")}</div>
              </div>
              <div class="text-sm font-bold text-slate-700">录音制作权<span class="text-orange-500"> *</span>
                <div class="mt-2 flex flex-wrap gap-4" data-right-group="tape">${radioHtml(`tape-right-${index}`, "data-right-choice", RIGHT_PERFORM, track.tapeRight || "1")}</div>
              </div>
              <div class="text-sm font-bold text-slate-700">版本类型<span class="text-orange-500"> *</span>
                <div class="mt-2 flex flex-wrap gap-4">${radioHtml(`version-${index}`, "data-version", [["1", "原版"], ["2", "翻唱"], ["3", "衍生版"]], track.version || "1")}</div>
              </div>
              <div class="text-sm font-bold text-slate-700">版本合同<span class="ml-1 font-semibold text-slate-400">可不传</span>
                <label class="mt-2 flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-3 text-sm text-slate-500">
                  <span class="text-xs font-bold text-slate-600">${track.contractName ? "已上传" : "上传"}</span>
                  <span class="min-w-0 truncate">${esc(track.contractName || "pdf、word 或图片")}<input data-contract-file type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" class="mt-1 block text-xs"></span>
                </label>
              </div>
            </div>
          </details>
          <details class="rounded-xl border border-slate-200 bg-white px-3 py-2">
            <summary class="cursor-pointer text-sm font-bold text-slate-700">作者</summary>
            <div class="mt-3 space-y-3">
              <label class="block text-sm font-bold text-slate-700">词作者<input data-field="lyricist" class="field mt-1" value="${esc(track.lyricist)}" placeholder="多人用顿号分隔"></label>
              <label class="block text-sm font-bold text-slate-700">曲作者<input data-field="composer" class="field mt-1" value="${esc(track.composer)}" placeholder="多人用顿号分隔"></label>
            </div>
          </details>
          <details class="rounded-xl border border-slate-200 bg-white px-3 py-2" ${moreOpen ? "open" : ""}>
            <summary class="cursor-pointer text-sm font-bold text-slate-700">更多选填</summary>
            <div class="mt-3 space-y-3">
              <label class="block text-sm font-bold text-slate-700">副标题<input data-field="subtitle" class="field mt-1" value="${esc(track.subtitle)}"></label>
              <label class="block text-sm font-bold text-slate-700">编曲<input data-field="arranger" class="field mt-1" value="${esc(track.arranger)}" placeholder="多人用顿号分隔"></label>
              <label class="block text-sm font-bold text-slate-700">制作人<input data-field="producer" class="field mt-1" value="${esc(track.producer)}" placeholder="多人用顿号分隔"></label>
              <label class="block text-sm font-bold text-slate-700">策划/工作室<input data-field="planer" class="field mt-1" value="${esc(track.planer)}"></label>
            </div>
          </details>
        </div>
        <div class="space-y-3">
          <div class="text-sm font-bold text-slate-700">原曲音频
            <audio class="mt-1 w-full" controls preload="none" src="/api/publish/audio/${encodeURIComponent(track.songId)}"></audio>
            <p class="mt-1 text-xs text-slate-400">${esc(track.fileName || "")}</p>
          </div>
          ${accomBlock(track)}
          <div class="text-sm font-bold text-slate-700">歌词
            <div class="mt-1 flex flex-wrap gap-4">${radioHtml(`lyric-${index}`, "data-lyric-mode", [["txt", "TXT"], ["lrc", "LRC"], ["none", "无歌词"]], track.lyricMode === "lrc" ? "lrc" : (track.lyricMode === "none" ? "none" : "txt"))}</div>
          </div>
          <div data-lyric-box class="${track.lyricMode === "none" ? "hidden" : ""} space-y-2">
            <textarea data-field="lyric" rows="8" class="field font-mono" placeholder="${track.lyricMode === "lrc" ? "LRC 歌词，保留时间轴。" : "纯文本歌词。"}">${esc(track.lyric)}</textarea>
            <label class="inline-flex cursor-pointer rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600">上传 TXT 或 LRC
              <input data-lyric-file type="file" accept=".txt,.lrc,text/plain" class="hidden">
            </label>
          </div>
        </div>
        </div>
      </div>
    </article>`;
  }).join("");
  updateAlbumHint();
  paintClipRows();
}

function clipPlatformsOn() {
  return Boolean(pub("publish-dy")?.checked || pub("publish-ks")?.checked);
}

function clockTime(seconds) {
  const whole = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function paintClipLabel(row, duration, start, loading) {
  const node = row.querySelector("[data-clip-label]");
  if (!node) return;
  if (loading) {
    node.textContent = "正在定位副歌，也可以直接拖动。";
    return;
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    node.textContent = "还没有读到时长。";
    return;
  }
  const length = Math.min(30, duration);
  const end = Math.min(duration, (Number(start) || 0) + length);
  node.textContent = length < 30
    ? `整首 ${clockTime(duration)}，将整首作为推广片段`
    : `${clockTime(start)} – ${clockTime(end)} · 30 秒`;
}

function clipTrack(songId) {
  return publishState.tracks.find((item) => item.songId === songId) || null;
}

async function setupClipRow(audio) {
  const row = audio.closest("[data-clip-row]");
  const slider = row?.querySelector("[data-clip-start]");
  if (!row || !slider) return;
  const duration = audio.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    paintClipLabel(row, NaN, 0, false);
    return;
  }
  const maxStart = Math.max(0, duration - Math.min(30, duration));
  slider.max = String(Math.floor(maxStart));
  slider.disabled = maxStart < 1;
  const track = clipTrack(row.dataset.songId);
  const saved = track && track.clipStart !== "" && Number.isFinite(Number(track.clipStart));
  let start = saved ? Number(track.clipStart) : null;
  if (start == null && maxStart >= 1) {
    paintClipLabel(row, duration, 0, true);
    try {
      const response = await publishFetch(`/api/publish/clip-suggest/${encodeURIComponent(row.dataset.songId)}`);
      const data = await response.json().catch(() => ({}));
      if (!row.isConnected) return;
      if (track?.clipPicked) return;
      if (!response.ok || data.ok === false) throw new Error(data.error || "副歌没有定位出来");
      start = Number(data.start) || 0;
    } catch {
      if (!row.isConnected || track?.clipPicked) return;
      start = Math.min(Math.floor(duration * 0.3), maxStart);
    }
  }
  if (track?.clipPicked && !saved) return;
  start = Math.min(Math.max(0, start || 0), maxStart);
  slider.value = String(Math.round(start));
  if (track) track.clipStart = Math.round(start);
  paintClipLabel(row, duration, Number(slider.value), false);
}

function bindClipAudio(audio) {
  if (audio.dataset.bound === "1") return;
  audio.dataset.bound = "1";
  audio.addEventListener("loadedmetadata", () => setupClipRow(audio));
  audio.addEventListener("error", () => {
    const row = audio.closest("[data-clip-row]");
    const node = row?.querySelector("[data-clip-label]");
    const slider = row?.querySelector("[data-clip-start]");
    if (slider) slider.disabled = true;
    if (node) node.textContent = "这首歌的音频没有读出来。";
  });
  audio.addEventListener("timeupdate", () => {
    const end = Number(audio.dataset.clipEnd);
    if (audio.dataset.clipPreview === "1" && Number.isFinite(end) && audio.currentTime >= end) {
      audio.pause();
      audio.dataset.clipPreview = "";
    }
  });
  if (audio.readyState >= 1) setupClipRow(audio);
}

function paintClipRows() {
  const box = pub("publish-clip-box");
  const list = pub("publish-clip-list");
  if (!box || !list) return;
  const on = clipPlatformsOn();
  box.classList.toggle("hidden", !on);
  if (!on) return;
  const tracks = publishState.tracks;
  if (!tracks.length) {
    list.dataset.songs = "";
    list.innerHTML = '<p class="text-xs text-slate-500">先在上一步放进歌曲，再来选推广片段。</p>';
    return;
  }
  const ids = tracks.map((track) => track.songId).join("\n");
  if (list.dataset.songs === ids && list.querySelector("[data-clip-row]")) {
    tracks.forEach((track) => {
      const name = list.querySelector(`[data-clip-row][data-song-id="${CSS.escape(track.songId)}"] [data-clip-name]`);
      if (name) name.textContent = track.name || "未命名";
    });
    return;
  }
  list.dataset.songs = ids;
  list.innerHTML = tracks.map((track) => `<div data-clip-row data-song-id="${esc(track.songId)}" class="rounded-xl border border-slate-200 bg-white px-3 py-3">
      <div data-clip-name class="truncate text-sm font-bold text-slate-800">${esc(track.name || "未命名")}</div>
      <audio data-clip-audio class="mt-2 w-full" controls preload="metadata" src="/api/publish/audio/${encodeURIComponent(track.songId)}"></audio>
      <label class="mt-2 block text-xs font-bold text-slate-500">起点
        <input data-clip-start class="clip-range" type="range" min="0" max="0" step="1" value="0" disabled>
      </label>
      <div class="mt-1 flex items-center justify-between gap-3">
        <div data-clip-label class="text-xs text-slate-500">正在读取歌曲…</div>
        <button type="button" data-clip-preview class="shrink-0 text-xs font-bold text-amber-600">试听这段</button>
      </div>
    </div>`).join("");
  list.querySelectorAll("[data-clip-audio]").forEach(bindClipAudio);
}

function patchTrackHeader(card) {
  const track = publishState.tracks.find((item) => item.songId === card.dataset.track);
  if (!track) return;
  const title = card.querySelector("[data-track-title]");
  const meta = card.querySelector("[data-track-meta]");
  if (title) title.textContent = track.name || "未命名";
  if (meta) {
    const language = optionLabel(publishState.constants?.language, track.language) || "普通话";
    const accom = track.accomSongId ? " · 含伴奏" : "";
    meta.textContent = `${track.singer || "未填歌手"} · 版本：${VERSION_LABELS[track.version] || "原版"} · 语言：${language}${accom}`;
  }
}

function addTrack(song, options = {}) {
  if (!song?.id) return;
  readTracksFromDom();
  if (publishState.tracks.some((track) => track.songId === song.id)) {
    if (!options.silent) {
      document.querySelector(`[data-track="${CSS.escape(song.id)}"]`)?.scrollIntoView({ block: "nearest" });
      toast("这首已经在专辑里");
    }
    return;
  }
  publishState.tracks.push(blankTrack(song));
  if (!pub("publish-album").value.trim()) pub("publish-album").value = song.name || "";
  renderTracks();
  renderSongs(publishState.library || []);
  document.querySelector(`[data-track="${CSS.escape(song.id)}"]`)?.scrollIntoView({ block: "nearest" });
  if (!options.silent) toast(`已放入专辑：${song.name || "未命名"}`);
}

function previewSong(id) {
  if (!id) return;
  publishState.previewId = id;
  publishState.songId = id;
  const player = pub("publish-player");
  if (player) player.src = `/api/publish/audio/${encodeURIComponent(id)}`;
  renderSongs(publishState.library || []);
}

function syncAlbumFromSongs() {
  readTracksFromDom();
  const track = publishState.tracks.find((item) => item.name.trim()) || publishState.tracks[0];
  if (!track) {
    toast("先添加一首歌");
    return;
  }
  const name = track.name.trim();
  const singer = track.singer.trim();
  if (name) pub("publish-album").value = name;
  if (singer) pub("publish-artist").value = singer;
  if (singer) publishState.singerName = singer;
  toast(name ? `专辑名已同步为「${name}」` : "这首歌还没有歌名");
}

function syncTrack(songId) {
  const album = pub("publish-album").value.trim();
  if (!album) {
    toast("先写专辑名");
    return;
  }
  readTracksFromDom();
  const track = publishState.tracks.find((item) => item.songId === songId);
  if (!track) return;
  track.name = album;
  track.language = pub("publish-language").value;
  track.firstGenre = pub("publish-genre").value;
  track.secondGenre = pub("publish-genre2").value;
  const artist = publishState.singerName || pub("publish-artist").value.trim();
  if (artist) track.singer = artist;
  if (artist && !track.lyricist) track.lyricist = artist;
  if (artist && !track.composer) track.composer = artist;
  renderTracks();
  toast("已按专辑同步歌名、歌手、语言和曲风");
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

function plainLyric(text) {
  return stripSunoCues(text)
    .replace(/^\[(ti|ar|al|by|offset):.*\]$/gim, "")
    .replace(/\[[0-9]{1,2}:[0-9]{2}(?:[.:][0-9]{1,3})?\]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function lyricFromFile(name, text) {
  const raw = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  const timed = /\[[0-9]{1,2}:[0-9]{2}(?:[.:][0-9]{1,3})?\]/.test(raw);
  if (timed || /\.lrc$/i.test(name || "")) return { mode: "lrc", text: stripSunoCues(raw) };
  return { mode: "txt", text: plainLyric(raw) };
}

function setPublishStep(step) {
  const next = Math.min(3, Math.max(1, Number(step) || 1));
  publishState.step = next;
  document.querySelectorAll("[data-publish-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", Number(panel.dataset.publishPanel) !== next);
  });
  document.querySelectorAll("[data-step-tab]").forEach((tab) => {
    const at = Number(tab.dataset.stepTab);
    tab.classList.toggle("is-on", at === next);
    tab.classList.toggle("is-done", at < next);
  });
  if (next === 2) {
    readTracksFromDom();
    paintClipRows();
  }
  pub("publish-back").classList.toggle("hidden", next === 1);
  pub("publish-next").classList.toggle("hidden", next === 3);
  pub("publish-draft").classList.toggle("hidden", next !== 3);
  pub("publish-submit").classList.toggle("hidden", next !== 3);
}

function validateAlbumStep(options = {}) {
  readTracksFromDom();
  const result = pub("publish-result");
  if (!publishState.tracks.length) {
    result.textContent = "先放进至少一首歌。";
    return false;
  }
  publishState.tracks.forEach((track) => {
    const singer = track.singer.trim();
    if (!track.lyricist.trim() && singer) track.lyricist = singer;
    if (!track.composer.trim() && singer) track.composer = singer;
  });
  const missingSinger = publishState.tracks.find((track) => !track.singer.trim());
  if (missingSinger) {
    result.textContent = "有一首歌没有歌手。";
    return false;
  }
  const missing = publishState.tracks.find((track) => !track.name.trim());
  if (missing) {
    result.textContent = "有一首歌没有歌名。";
    return false;
  }
  if (!pub("publish-album").value.trim()) {
    result.textContent = "专辑名还没填。";
    return false;
  }
  if (!publishState.singerId || !publishState.singerName) {
    result.textContent = "先查找或新建艺人，并选中一位。";
    return false;
  }
  if (options.cover) {
    const hasCover = Boolean(pub("publish-cover-file")?.files?.[0] || publishState.coverBlob);
    if (!hasCover) {
      result.textContent = "专辑封面还没上传。";
      return false;
    }
  }
  result.textContent = "";
  return true;
}

function renderSongs(songs) {
  publishState.library = songs || [];
  const box = pub("publish-songs");
  if (!box) return;
  if (!songs?.length) {
    box.innerHTML = '<p class="text-sm text-slate-500">曲库是空的。读取本机文件夹，或加入歌曲。</p>';
    return;
  }
  const inAlbum = new Set(publishState.tracks.map((track) => track.songId));
  box.innerHTML = songs.map((song) => {
    const on = song.id === publishState.previewId;
    const added = inAlbum.has(song.id);
    const size = `${(song.size / 1024 / 1024).toFixed(1)} MB`;
    const remove = song.removable === false ? "" : `<button type="button" data-delete="${esc(song.id)}" class="shrink-0 text-xs font-bold text-slate-400 hover:text-red-600">删除</button>`;
    return `<div class="flex items-start gap-2 rounded-xl border px-3 py-2 ${on ? "border-emerald-500 bg-emerald-50" : "border-slate-200 bg-white"}">
      <button type="button" data-song="${esc(song.id)}" class="min-w-0 flex-1 text-left">
        <span class="block text-sm font-bold text-slate-900">${esc(song.name)}</span>
        <span class="block text-xs text-slate-400">${size}</span>
      </button>
      <button type="button" data-add="${esc(song.id)}" class="shrink-0 text-xs font-bold ${added ? "text-emerald-600" : "text-slate-700"}">${added ? "已加入" : "加入"}</button>
      ${remove}
    </div>`;
  }).join("");
  box.querySelectorAll("[data-song]").forEach((button) => {
    button.addEventListener("click", () => previewSong(button.dataset.song));
  });
  box.querySelectorAll("[data-add]").forEach((button) => {
    button.addEventListener("click", () => {
      const song = songs.find((item) => item.id === button.dataset.add);
      if (song) addTrack(song);
    });
  });
  box.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", () => removeSong(button.dataset.delete, songs));
  });
}

async function removeSong(id, songs) {
  const song = songs.find((item) => item.id === id);
  if (!song) return;
  if (!window.confirm(`从曲库里删掉「${song.name}」？`)) return;
  try {
    const data = await publishJson("/api/publish/remove", { id });
    if (publishState.previewId === id || publishState.tracks.some((track) => track.songId === id)) {
      if (publishState.previewId === id) {
        publishState.previewId = "";
        publishState.songId = "";
        pub("publish-player")?.removeAttribute("src");
        pub("publish-player")?.load();
      }
      readTracksFromDom();
      publishState.tracks = publishState.tracks.filter((track) => track.songId !== id);
  renderTracks();
}
    renderSongs(data.songs || []);
    toast("已从曲库删除");
  } catch (error) {
    toast(error.message);
  }
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

let incomeByPair = new Map();

function incomeFor(name, singer) {
  const key = incomePairKey(name, singer);
  return incomeByPair.has(key) ? incomeByPair.get(key) : null;
}

function rememberIncome(songs) {
  incomeByPair = new Map();
  for (const row of songs || []) {
    if (!row?.name) continue;
    incomeByPair.set(incomePairKey(row.name, row.singer), Number(row.income) || 0);
  }
}

function yuan(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  return `¥${num.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function countText(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value ?? "—");
  return num.toLocaleString("zh-CN");
}

const RELEASE_BROWSER_PAGE = 20;
const releaseBrowser = {
  list: [],
  scope: "",
  query: "",
  filter: "all",
  page: 1,
  showAll: false,
  ready: false,
};

const RELEASE_FILTERS = [
  ["all", "全部"],
  ["submitted", "已提交"],
  ["review", "审核中"],
  ["pending", "待上架"],
  ["online", "已上架"],
  ["offline", "已下架"],
  ["void", "已作废"],
  ["rejected", "未通过"],
];

function releaseQueryMatch(song, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;
  return [song.name, song.singer, song.albumName, song.statusLabel, song.status].join(" ").toLowerCase().includes(needle);
}

const RELEASE_STATUS_LABEL = {
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

function releaseStatusText(song) {
  return RELEASE_STATUS_LABEL[song?.status] || song?.statusLabel || song?.status || "";
}

function releaseGroup(song) {
  const status = song?.status || "";
  if (status === "BUSINESS_REVIEWING" || status === "PLATFORM_REVIEWING") return "review";
  if (status === "APPROVED_PENDING_ONLINE") return "pending";
  if (status === "ONLINE") return "online";
  if (status === "OFFLINE") return "offline";
  if (status === "VOIDED") return "void";
  if (["BUSINESS_REJECTED", "PLATFORM_REJECTED", "PLATFORM_REJECTED_PENDING", "SUBFAIL"].includes(status)) return "rejected";
  if (status === "DRAFT" || status === "SUBMISSION" || !status || song?.statusLabel === "已提交") return "submitted";
  return "";
}

function releaseFilterBar() {
  const counts = Object.fromEntries(RELEASE_FILTERS.map(([id]) => [id, 0]));
  counts.all = releaseBrowser.list.length;
  releaseBrowser.list.forEach((song) => {
    const group = releaseGroup(song);
    if (counts[group] != null) counts[group] += 1;
  });
  return `<div class="flex flex-wrap gap-2 pb-3">${RELEASE_FILTERS.map(([id, label]) => {
    const on = releaseBrowser.filter === id;
    const face = on ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-600";
    return `<button type="button" data-release-filter="${id}" class="rounded-full border px-3 py-1 text-xs font-bold ${face}">${esc(label)} ${countText(counts[id] || 0)}</button>`;
  }).join("")}</div>`;
}

function paintReleaseBrowser() {
  const box = pub("publish-releases");
  if (!box) return;
  const query = releaseBrowser.query.trim();
  const grouped = releaseBrowser.list.filter((song) => releaseBrowser.filter === "all" || releaseGroup(song) === releaseBrowser.filter);
  const matched = grouped.filter((song) => releaseQueryMatch(song, query));
  const bar = releaseFilterBar();
  if (!matched.length) {
    const empty = query ? `没有找到和「${query.slice(0, 40)}」匹配的歌。` : "这个分类里没有歌。";
    box.innerHTML = `${bar}<p class="text-sm text-slate-500">${esc(empty)}</p>`;
    syncIncomeMatch();
    return;
  }
  const pages = Math.max(1, Math.ceil(matched.length / RELEASE_BROWSER_PAGE) || 1);
  const showAll = releaseBrowser.showAll && matched.length > RELEASE_BROWSER_PAGE;
  const page = Math.min(Math.max(releaseBrowser.page, 1), pages);
  releaseBrowser.page = page;
  const visible = showAll ? matched : matched.slice((page - 1) * RELEASE_BROWSER_PAGE, page * RELEASE_BROWSER_PAGE);
  const scopeLine = releaseBrowser.scope === "own"
    ? "只显示你这个账号提交的歌。"
    : releaseBrowser.scope === "admin"
      ? "管理员可以看到这个海葵账号提交的全部歌曲。"
      : "";
  const countLine = query
    ? `找到 ${countText(matched.length)} 首，一共 ${countText(releaseBrowser.list.length)} 首。`
    : `一共 ${countText(releaseBrowser.list.length)} 首。`;
  const lead = [scopeLine, countLine].filter(Boolean).join(" ");
  const mode = matched.length > RELEASE_BROWSER_PAGE
    ? `<button type="button" data-release-all="${showAll ? "0" : "1"}" class="font-bold text-slate-700">${showAll ? "分页显示" : "查看全部"}</button>`
    : "";
  const pager = pages > 1 ? `<div class="flex flex-wrap items-center justify-between gap-3 pt-2 text-xs">
    <button type="button" data-release-page="${page - 1}" class="font-bold text-slate-700 disabled:opacity-40" ${showAll || page <= 1 ? "disabled" : ""}>上一页</button>
    <span class="text-slate-400">${showAll ? `全部 ${countText(matched.length)} 首` : `${page} / ${pages}`}</span>
    <span class="flex items-center gap-3">
      ${mode}
      <button type="button" data-release-page="${page + 1}" class="font-bold text-slate-700 disabled:opacity-40" ${showAll || page >= pages ? "disabled" : ""}>下一页</button>
    </span>
  </div>` : "";
  box.innerHTML = `${bar}${lead ? `<p class="pb-2 text-xs text-slate-500">${esc(lead)}</p>` : ""}<div class="space-y-2">${visible.map((song) => {
    const play = song.status === "ONLINE"
      ? `<button type="button" data-play-id="${esc(song.id)}" data-play-name="${esc(song.name)}" data-play-singer="${esc(song.singer)}" class="px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs font-bold">查看数据</button>`
      : "";
    const cancel = song.status === "BUSINESS_REVIEWING"
      ? `<button type="button" data-cancel-id="${esc(song.id)}" data-cancel-album="${esc(song.albumId || "")}" data-cancel-name="${esc(song.name)}" class="px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs font-bold text-slate-600">撤销</button>`
      : "";
    const income = incomeFor(song.name, song.singer);
    const money = income == null ? "" : `<span class="text-xs font-bold text-emerald-700">${esc(yuan(income))}</span>`;
    return `<div class="flex items-center justify-between gap-3 border-b border-slate-100 py-2">
    <div class="min-w-0"><div class="font-bold text-slate-900">${esc(song.name)}</div><div class="text-xs text-slate-400">${esc(song.singer)} · ${esc(song.albumName)}</div></div>
    <div class="flex items-center gap-2 shrink-0">
      ${money}
      <span class="text-xs font-bold text-slate-600">${esc(releaseStatusText(song))}</span>
      ${cancel}
      ${play}
    </div>
  </div>`;
  }).join("")}</div>${pager}`;
  syncIncomeMatch();
}

function syncIncomeMatch() {
  const node = pub("publish-income-match");
  if (!node) return;
  if (!releaseBrowser.ready || !incomeByPair.size) {
    node.textContent = "";
    return;
  }
  const matched = new Set(releaseBrowser.list.filter((song) => incomeFor(song.name, song.singer) != null).map((song) => incomePairKey(song.name, song.singer))).size;
  node.textContent = `已提交的歌对上 ${matched} 首。`;
}

function holdReleaseCatalog(list, meta = {}) {
  releaseBrowser.list = Array.isArray(list) ? list : [];
  if (meta.scope) releaseBrowser.scope = meta.scope;
  releaseBrowser.ready = true;
  releaseBrowser.page = 1;
  paintReleaseBrowser();
  if (pub("publish-artists") && !pub("publish-artists").classList.contains("hidden")) renderArtistBoard();
}

function renderReleases(list, meta = {}) {
  const box = pub("publish-releases");
  if (meta.loading) {
    box.textContent = "正在读取全部已提交的歌。第一次会稍等，之后翻页和搜索直接用这份列表。";
    return;
  }
  if (meta.message && !list?.length) {
    releaseBrowser.list = [];
    releaseBrowser.ready = false;
    box.textContent = meta.message;
    return;
  }
  holdReleaseCatalog(list, meta);
}

function statCard(label, value, extra) {
  return `<div class="rounded-xl border border-slate-100 px-3 py-2"><div class="text-xs text-slate-400">${esc(label)}</div><div class="mt-1 text-sm font-black text-slate-900">${esc(value)}</div>${extra ? `<div class="text-xs text-slate-400">${esc(extra)}</div>` : ""}</div>`;
}

function songMoneyRows(rows, empty) {
  if (!rows?.length) return `<p class="text-xs text-slate-400">${esc(empty)}</p>`;
  return rows.map((row) => `<div class="flex items-center justify-between gap-3 py-1.5 border-b border-slate-50">
    <div class="min-w-0"><span class="text-xs text-slate-400">${esc(row.rank || "")}</span> <span class="font-bold text-slate-900">${esc(row.name || "未命名")}</span><span class="text-xs text-slate-400"> ${esc([row.singer, row.submitter].filter(Boolean).join(" · "))}</span></div>
    <span class="shrink-0 text-sm font-bold">${esc(yuan(row.income))}</span>
  </div>`).join("");
}

function peopleRows(people) {
  if (!people?.length) return "";
  return `<div>
    <div class="text-xs font-bold text-slate-500 mb-1">按提交人</div>
    ${people.map((person) => `<div class="flex items-center justify-between gap-3 py-1.5 border-b border-slate-50">
      <div class="min-w-0"><span class="font-bold text-slate-900">${esc(person.name)}</span><span class="text-xs text-slate-400"> ${esc(person.songCount)} 首</span></div>
      <span class="shrink-0 text-sm font-bold">${esc(yuan(person.income))}</span>
    </div>`).join("")}
  </div>`;
}

function renderIncome(data) {
  const box = pub("publish-income");
  if (!box) return;
  const account = data.account?.ok ? data.account.account : null;
  const stats = data.stats?.ok ? data.stats.stats : null;
  const ranking = data.ranking?.ok ? data.ranking.ranking : [];
  const songs = data.songs?.ok ? data.songs.songs : [];
  const people = data.people?.ok ? data.people.people : [];
  rememberIncome(songs.length ? songs : ranking);
  const trend = (account?.trend || []).map((item) => `${item.month} ${yuan(item.amount)}`).join(" · ");
  const channels = (account?.channels || []).filter((item) => item.name).map((item) => `${item.name} ${yuan(item.amount)}`).join(" · ");
  const span = [stats?.from, stats?.to].filter(Boolean).join(" → ");
  const lead = data.scope === "own"
    ? "这是你提交的歌。海之轨迹渠道，按收益从高到低。"
    : "海之轨迹全部收益，按收益从高到低。提交人汇总在歌曲列表上面。";
  box.innerHTML = `<div class="space-y-4">
    <p class="text-xs text-slate-500">${esc(lead)}<span id="publish-income-match"></span></p>
    <div>
      <div class="text-xs font-bold text-slate-500 mb-2">收益汇总</div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
        ${statCard("累计收入", account ? yuan(account.total) : "—")}
        ${statCard("有收入的歌", stats ? countText(stats.count) : "—")}
        ${statCard("明细行数", stats ? countText(stats.rows) : "—")}
        ${statCard("结算期间", span || "—")}
      </div>
      ${channels ? `<p class="mt-2 text-xs text-slate-500">平台 ${esc(channels)}</p>` : ""}
      ${trend ? `<p class="mt-1 text-xs text-slate-500">按月 ${esc(trend)}</p>` : ""}
    </div>
    ${peopleRows(people)}
    <div>
      <div class="text-xs font-bold text-slate-500 mb-1">歌曲收益</div>
      ${songMoneyRows(ranking, data.scope === "own" ? (data.catalogCount ? "你提交的歌里还没有海之轨迹收入。" : "没有读到你提交的歌，暂时对不上收益。") : "还没有歌曲收入。")}
    </div>
  </div>`;
  if (releaseBrowser.ready) paintReleaseBrowser();
  else syncIncomeMatch();
}

function renderPlays(name, singer, platforms, shelf, shelfError) {
  const box = pub("publish-plays");
  const shelfLine = (shelf || []).map((item) => `${item.name} ${item.statusLabel}${item.reason ? `（${item.reason}）` : ""}`).join(" · ");
  box.innerHTML = `<div class="font-bold text-slate-900">${esc(name)}${singer ? ` · ${esc(singer)}` : ""}</div>
    ${shelfLine ? `<p class="mt-1 text-xs text-slate-500">其他平台 ${esc(shelfLine)}</p>` : ""}
    ${shelfError ? `<p class="mt-1 text-xs text-red-600">${esc(shelfError)}</p>` : ""}
    <div class="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">${(platforms || []).map((item) => {
      if (!item.ok) return `<div class="rounded-xl border border-slate-200 p-3"><div class="font-bold">${esc(item.label)}</div><p class="mt-1 text-xs text-red-600">${esc(item.error || "查询失败")}</p></div>`;
      if (!item.found) return `<div class="rounded-xl border border-slate-200 p-3"><div class="font-bold">${esc(item.label)}</div><p class="mt-1 text-xs text-slate-400">没有找到这首歌。</p></div>`;
      const same = item.name === name;
      const metrics = (item.metrics || []).map((metric) => `<span>${esc(metric.label)} ${esc(countText(metric.value))}</span>`).join('<span class="text-slate-300"> · </span>');
      return `<div class="rounded-xl border border-slate-200 p-3"><div class="font-bold">${esc(item.label)}</div><p class="mt-1 text-xs text-slate-500">${esc(item.name)}${item.singer ? ` / ${esc(item.singer)}` : ""}${same ? "" : " · 同名匹配"}</p><p class="mt-1 text-sm text-slate-800">${metrics || "这个平台没有返回播放、评论或收藏。"}</p></div>`;
    }).join("")}</div>`;
}

async function loadIncome() {
  const box = pub("publish-income");
  if (!box) return;
  box.textContent = "正在读取收益和账单…";
  try {
    const response = await publishFetch("/api/publish/income", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || "收益没有读出来");
    renderIncome(data);
  } catch (error) {
    box.textContent = error.message;
  }
}

async function loadPlays(name, singer, id) {
  const box = pub("publish-plays");
  box.textContent = `正在查「${name}」的播放数据和上架状态…`;
  try {
    const songId = id ? `&id=${encodeURIComponent(id)}` : "";
    const response = await publishFetch(`/api/publish/plays?name=${encodeURIComponent(name)}&singer=${encodeURIComponent(singer || "")}${songId}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || "播放数据没有查到");
    renderPlays(name, singer, data.platforms || [], data.shelf || [], data.shelfError || "");
  } catch (error) {
    box.textContent = error.message;
  }
}

async function exportIncome(kind) {
  try {
    const response = await publishFetch(`/api/publish/income/export?kind=${encodeURIComponent(kind)}`, { cache: "no-store" });
    const type = response.headers.get("content-type") || "";
    if (!response.ok || type.includes("json")) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "没有导出文件");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = kind === "bills" ? "song-income-details.csv" : "song-income.csv";
    link.click();
    URL.revokeObjectURL(url);
    toast(kind === "bills" ? "收入明细已导出" : "歌曲收入已导出");
  } catch (error) {
    toast(error.message);
  }
}

function setKeyPanel(open) {
  const panel = pub("publish-key-panel");
  const toggle = pub("publish-key-toggle");
  if (!panel || !toggle) return;
  panel.classList.toggle("hidden", !open);
  const own = readHikoonKey();
  toggle.textContent = open ? "收起" : (own ? "更换" : "填写密钥");
}

function renderKeyHint(data) {
  const hint = pub("publish-key-hint");
  const input = pub("publish-key");
  if (!hint) return;
  const own = readHikoonKey();
  if (input && !input.value) {
    input.placeholder = own ? `已保存，末四位 ${own.slice(-4)}。要更换再粘贴新密钥` : "粘贴 secret key";
  }
  if (own) {
    hint.textContent = `已保存你的密钥，末四位 ${own.slice(-4)}。发行走这个账号。`;
    return;
  }
  hint.textContent = data?.configured
    ? "正在用站点默认账号。要换成自己的海葵账号，再打开这里填写。"
    : "还没有密钥。打开后粘贴，或上传一个只含密钥的文本文件。";
  if (pub("publish-key-panel")?.classList.contains("hidden")) setKeyPanel(false);
}

function renderPublishAccount(data) {
  const box = pub("publish-account");
  renderKeyHint(data);
  publishState.keySource = data?.keySource || "";
  if (!data?.configured) {
    publishState.verified = false;
    if (box) box.textContent = "还没有可用的海葵密钥。在下面粘贴或上传你的密钥。";
    return;
  }
  const account = data.account || {};
  publishState.verified = Boolean(account.verified);
  publishState.verifyUrl = account.verifyUrl || publishState.verifyUrl;
  if (!box) return;
  if (account.verified) {
    box.innerHTML = `海葵账号 <strong>${esc(account.name || "已认证")}</strong> 已实名，可以保存草稿或提交发行。`;
    return;
  }
  box.innerHTML = `海葵账号 <strong>${esc(account.name || "未命名")}</strong> 还没完成实名认证。认证通过前，草稿和正式提交都会被拒绝。<a class="font-bold text-emerald-700" href="${esc(publishState.verifyUrl)}" target="_blank" rel="noreferrer">去分贝完成实名认证</a>`;
}

function labelOf(pairs, value) {
  const hit = pairs.find(([id]) => String(id) === String(value));
  return hit ? hit[1] : "";
}

function artistKey(name) {
  return String(name || "").trim().toLowerCase();
}

function splitArtistNames(value) {
  return String(value || "").split(/[、,，&/／|]/).map((name) => name.trim()).filter(Boolean);
}

function artistStamp(value) {
  const text = String(value || "").replace("T", " ").trim();
  return text ? text.slice(0, 16) : "";
}

function emptyPlatforms() {
  return Object.fromEntries(ARTIST_PLATFORMS.map(([id]) => [id, { mode: "link", url: "", fans: 0 }]));
}

function artistStatus(row) {
  const official = row.official;
  if (official) {
    const status = Number(official.status);
    if (status === 1) return { key: "passed", label: official.statusText || "审核通过", className: "bg-emerald-50 text-emerald-700" };
    if (status === 3 || status === 4) return { key: "rejected", label: official.statusText || "未通过", className: "bg-rose-50 text-rose-700" };
    return { key: "review", label: official.statusText || "审核中", className: "bg-amber-50 text-amber-700" };
  }
  if (row.works) return { key: "filed", label: "已提交", className: "bg-slate-100 text-slate-600" };
  return { key: "filed", label: "已建档", className: "bg-sky-50 text-sky-700" };
}

function songArtistStats() {
  const byName = new Map();
  for (const song of releaseBrowser.list || []) {
    for (const name of splitArtistNames(song.singer)) {
      const key = artistKey(name);
      const row = byName.get(key) || { works: 0, latest: "", submitter: "", company: "" };
      row.works += 1;
      const stamp = artistStamp(song.createdAt || song.issuedTime);
      if (stamp && stamp > row.latest) {
        row.latest = stamp;
        if (song.submitter) row.submitter = song.submitter;
        if (song.company) row.company = song.company;
      } else {
        if (!row.submitter && song.submitter) row.submitter = song.submitter;
        if (!row.company && song.company) row.company = song.company;
      }
      byName.set(key, row);
    }
  }
  return byName;
}

function collectArtists() {
  const songs = songArtistStats();
  const byName = new Map();
  for (const artist of artistBoard.artists || []) {
    const key = artistKey(artist.name);
    if (!key) continue;
    const song = songs.get(key) || {};
    byName.set(key, {
      name: artist.name,
      coverUrl: artist.coverUrl || "",
      official: artist,
      works: song.works || 0,
      latest: artistStamp(artist.createdAt) || song.latest || "",
      submitter: artist.submitter || song.submitter || "",
      company: artist.company || song.company || "",
    });
  }
  for (const profile of artistBoard.profiles) {
    const key = artistKey(profile.name);
    if (!key) continue;
    const song = songs.get(key) || {};
    const row = byName.get(key) || {
      name: profile.name,
      coverUrl: "",
      works: song.works || 0,
      latest: artistStamp(profile.createdAt) || song.latest || "",
      submitter: song.submitter || "",
      company: profile.company || song.company || "",
    };
    row.profile = profile;
    if (profile.avatar) row.coverUrl = profile.avatar;
    if (!row.company && profile.company) row.company = profile.company;
    if (!row.latest) row.latest = artistStamp(profile.createdAt);
    byName.set(key, row);
  }
  return [...byName.values()].sort((left, right) => String(right.latest).localeCompare(String(left.latest)) || left.name.localeCompare(right.name, "zh"));
}

function artistMeta(row) {
  const profile = row.profile || {};
  const official = row.official || {};
  const bits = [
    official.singerTypeText || labelOf(singerTypes, profile.singerType),
    official.roleText || (profile.roles || []).map((role) => labelOf(singerRoles, role)).filter(Boolean).join("、"),
    official.areaText || labelOf(singerAreas, profile.area),
    row.company || profile.company || "",
  ].filter(Boolean);
  if (row.works) bits.push(`${row.works} 首作品`);
  return bits.join(" · ");
}

function artistPortrait(row) {
  const profile = row.profile || {};
  const url = profile.avatar || row.coverUrl || "";
  if (!url) {
    const initial = esc(String(row.name || "艺").slice(0, 1));
    return `<span class="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-slate-100 text-sm font-black text-slate-500">${initial}</span>`;
  }
  return `<img src="${esc(url)}" alt="" referrerpolicy="no-referrer" class="h-12 w-12 shrink-0 rounded-xl object-cover bg-slate-100">`;
}

function renderArtistBoard() {
  const box = pub("artist-list");
  const filters = pub("artist-filters");
  if (!box) return;
  const all = collectArtists();
  if (!["all", "passed", "review", "rejected", "filed"].includes(artistBoard.filter)) artistBoard.filter = "all";
  const counts = { all: all.length, passed: 0, review: 0, rejected: 0, filed: 0 };
  all.forEach((row) => { counts[artistStatus(row).key] += 1; });
  if (filters) {
    const options = [["all", "全部"], ["passed", "审核通过"], ["review", "审核中"], ["rejected", "未通过"], ["filed", "已建档"]];
    filters.innerHTML = options.map(([key, label]) => {
      const on = artistBoard.filter === key;
      return `<button type="button" data-artist-filter="${key}" class="rounded-full px-3 py-1 text-xs font-bold ${on ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}">${label} ${counts[key] || 0}</button>`;
    }).join("");
  }
  const query = artistBoard.query.trim().toLowerCase();
  const matched = all.filter((row) => {
    if (artistBoard.filter !== "all" && artistStatus(row).key !== artistBoard.filter) return false;
    if (!query) return true;
    return row.name.toLowerCase().includes(query) || String(row.profile?.id || "").includes(query);
  });
  const lead = pub("artist-lead");
  if (lead) {
    lead.textContent = artistBoard.ready
      ? `共 ${matched.length} 位艺人${query || artistBoard.filter !== "all" ? `，名单里一共 ${all.length} 位` : ""}。头像和档案来自海葵分贝。`
      : "正在读取作品和艺人档案…";
  }
  if (!matched.length) {
    box.innerHTML = `<p class="py-8 text-center text-sm text-slate-500">${query ? "没有找到这位艺人。" : "还没有艺人。可以先提交作品，或添加一位新艺人。"}</p>`;
    return;
  }
  const pages = Math.max(1, Math.ceil(matched.length / ARTIST_PAGE));
  const page = Math.min(Math.max(artistBoard.page, 1), pages);
  artistBoard.page = page;
  const visible = matched.slice((page - 1) * ARTIST_PAGE, page * ARTIST_PAGE);
  const pageButtons = [];
  for (let index = 1; index <= pages; index += 1) {
    const on = index === page;
    pageButtons.push(`<button type="button" data-artist-page="${index}" class="grid h-8 w-8 place-items-center rounded-full text-xs font-bold ${on ? "bg-slate-900 text-white" : "text-slate-600"}">${index}</button>`);
  }
  box.innerHTML = `<div class="divide-y divide-slate-100">${visible.map((row) => {
    const status = artistStatus(row);
    const profile = row.profile || {};
    const idValue = row.official?.id || profile.id || "";
    const id = idValue ? `艺人 ID ${idValue}` : "艺人";
    const who = row.submitter ? `提交人 ${row.submitter}` : "提交人 —";
    const when = row.latest ? row.latest : "还没有提交时间";
    const portrait = artistPortrait(row);
    return `<article class="py-4">
      <div class="flex items-start justify-between gap-3">
        <p class="text-[11px] text-slate-400">${esc(id)} · ${esc(who)} · ${esc(when)}</p>
        <div class="flex shrink-0 items-center gap-1.5">
          <span class="rounded-full px-2 py-0.5 text-[11px] font-bold ${status.className}">${esc(status.label)}</span>
          <button type="button" data-artist-copy="${esc(row.name)}" class="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-50 hover:text-slate-700" title="复制">
            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2" stroke-width="2"></rect><path stroke-width="2" d="M5 15V5h10"></path></svg>
          </button>
          <button type="button" data-artist-edit="${esc(row.name)}" class="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-50 hover:text-slate-700" title="编辑">
            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 20h9"></path><path stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M16.5 3.5a2.1 2.1 0 013 3L8 18l-4 1 1-4 11.5-11.5z"></path></svg>
          </button>
        </div>
      </div>
      <div class="mt-2 flex items-center gap-3">
        ${portrait}
        <div class="min-w-0">
          <div class="font-black text-slate-900">${esc(row.name)}</div>
          <div class="mt-0.5 text-xs text-slate-500">${esc(artistMeta(row) || "还没有类型和地区")}</div>
        </div>
      </div>
    </article>`;
  }).join("")}</div>
  <div class="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
    <span>共 ${matched.length} 条</span>
    <div class="flex items-center gap-1">${pageButtons.join("")}</div>
    <span>共 ${matched.length} 位艺人</span>
  </div>`;
}

function readArtistPlatforms() {
  const platforms = {};
  for (const [id] of ARTIST_PLATFORMS) {
    const mode = document.querySelector(`input[name="artist-platform-${id}"]:checked`)?.value === "create" ? "create" : "link";
    platforms[id] = {
      mode,
      url: mode === "link" ? (pub(`artist-platform-url-${id}`)?.value.trim() || "") : "",
      fans: mode === "link" ? Math.max(0, Number(pub(`artist-platform-fans-${id}`)?.value) || 0) : 0,
    };
  }
  return platforms;
}

function paintArtistPlatforms(platforms) {
  const box = pub("artist-platforms");
  if (!box) return;
  const saved = platforms || emptyPlatforms();
  box.innerHTML = ARTIST_PLATFORMS.map(([id, label]) => {
    const row = saved[id] || { mode: "link", url: "", fans: 0 };
    const create = row.mode === "create";
    return `<div class="rounded-xl border border-slate-200 p-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="text-sm font-bold text-slate-800">${label}</div>
        <div class="flex flex-wrap gap-3 text-xs font-bold text-slate-600">
          <label class="inline-flex items-center gap-1"><input type="radio" name="artist-platform-${id}" value="link" ${create ? "" : "checked"} class="accent-amber-500"> 填写主页链接</label>
          <label class="inline-flex items-center gap-1"><input type="radio" name="artist-platform-${id}" value="create" ${create ? "checked" : ""} class="accent-amber-500"> 新建艺人</label>
        </div>
      </div>
      <div class="mt-2 grid grid-cols-[minmax(0,1fr)_5.5rem] gap-2">
        <input id="artist-platform-url-${id}" class="field" placeholder="主页链接（选填）" value="${esc(create ? "" : row.url || "")}" ${create ? "disabled" : ""}>
        <input id="artist-platform-fans-${id}" type="number" min="0" class="field" placeholder="粉丝" value="${create ? "" : esc(row.fans || 0)}" ${create ? "disabled" : ""}>
      </div>
    </div>`;
  }).join("");
}

function paintArtistRoles(selected, locked) {
  const box = pub("artist-roles");
  if (!box) return;
  const picked = new Set((selected || []).map((value) => String(value)));
  if (!picked.size && !locked) picked.add("0");
  box.innerHTML = singerRoles.map(([value, label]) => {
    const on = picked.has(String(value));
    return `<button type="button" data-artist-role="${esc(value)}" aria-pressed="${on ? "true" : "false"}" class="rounded-full border px-3 py-1 text-xs font-bold ${on ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-600"} ${locked ? "pointer-events-none" : ""}">${esc(label)}</button>`;
  }).join("");
}

function selectedArtistRoles() {
  return [...document.querySelectorAll("#artist-roles [data-artist-role][aria-pressed='true']")].map((node) => node.dataset.artistRole);
}

function setArtistLocked(locked) {
  artistBoard.locked = locked;
  pub("artist-lock-note")?.classList.toggle("hidden", !locked);
  ["artist-name", "artist-type", "artist-area", "artist-desc", "artist-company"].forEach((id) => {
    const node = pub(id);
    if (!node) return;
    node.disabled = locked;
    node.classList.toggle("bg-slate-50", locked);
  });
}

function showArtistCover(url, name) {
  const preview = pub("artist-cover-preview");
  const fallback = pub("artist-cover-fallback");
  if (url && preview) {
    preview.src = url;
    preview.classList.remove("hidden");
    fallback?.classList.add("hidden");
  } else if (preview) {
    preview.classList.add("hidden");
    preview.removeAttribute("src");
    if (fallback) {
      fallback.textContent = String(name || "艺").slice(0, 1);
      fallback.classList.remove("hidden");
    }
  }
}

function openArtistEditor(row) {
  const editor = pub("artist-editor");
  if (!editor) return;
  const profile = row?.profile || {};
  const official = row?.official || {};
  const creating = !row;
  artistBoard.editing = row?.name || "";
  artistBoard.blob = null;
  pub("artist-editor-title").textContent = creating ? "新增艺人" : "编辑艺人";
  pub("artist-save").textContent = creating ? "新增艺人" : "保存修改";
  pub("artist-name").value = row?.name || "";
  fillSelect("artist-type", singerTypes.map(([value, label]) => ({ value, label })), profile.singerType || official.singerType || "0");
  fillSelect("artist-area", singerAreas.map(([value, label]) => ({ value, label })), profile.area || official.area || "1");
  pub("artist-company").value = row?.company || profile.company || official.company || pub("publish-subject")?.value || "海南海之轨迹文化传媒有限公司";
  pub("artist-desc").value = profile.desc || official.desc || "";
  pub("artist-desc-count").textContent = `${pub("artist-desc").value.length}/255`;
  const cover = pub("artist-cover");
  if (cover) cover.value = "";
  const coverName = pub("artist-cover-name");
  if (coverName) coverName.textContent = "";
  artistBoard.avatarUrl = profile.avatar || "";
  showArtistCover(profile.avatar || row?.coverUrl || "", row?.name || "");
  const locked = !creating && (Boolean(profile.id) || Boolean(official.id) || row.works > 0);
  paintArtistRoles(profile.roles?.length ? profile.roles : (official.roles || []), locked);
  paintArtistPlatforms(profile.platforms || official.platforms || emptyPlatforms());
  setArtistLocked(locked);
  editor.classList.remove("hidden");
  document.body.classList.add("overflow-hidden");
  if (!locked) pub("artist-name")?.focus();
}

function closeArtistEditor() {
  pub("artist-editor")?.classList.add("hidden");
  document.body.classList.remove("overflow-hidden");
  artistBoard.blob = null;
  artistBoard.editing = "";
  artistBoard.fromUpload = false;
}

async function loadArtistProfiles() {
  try {
    const response = await publishFetch("/api/publish/artist-profiles", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || "艺人档案没有读出来");
    artistBoard.profiles = data.profiles || [];
    artistBoard.artists = data.artists || [];
    artistBoard.ready = true;
  } catch (error) {
    artistBoard.ready = true;
    const lead = pub("artist-lead");
    if (lead) lead.textContent = error.message;
  }
  renderArtistBoard();
}

async function storeArtistAvatar() {
  const file = pub("artist-cover")?.files?.[0] || artistBoard.blob;
  if (!file) return artistBoard.avatarUrl || "";
  const response = await publishFetch(`/api/publish/artist-avatar?name=${encodeURIComponent(file.name || "avatar.png")}`, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || "头像没有保存");
  artistBoard.avatarUrl = data.url || "";
  return artistBoard.avatarUrl;
}

async function saveArtistProfile(profile) {
  const data = await publishJson("/api/publish/artist-profiles", profile);
  const next = data.profile || profile;
  artistBoard.profiles = artistBoard.profiles.filter((item) => artistKey(item.name) !== artistKey(next.name));
  artistBoard.profiles.push(next);
  return next;
}

function bindArtistDesk() {
  pub("artist-query")?.addEventListener("input", (event) => {
    artistBoard.query = event.target.value;
    artistBoard.page = 1;
    renderArtistBoard();
  });
  pub("artist-add")?.addEventListener("click", () => {
    artistBoard.fromUpload = false;
    publishState.singerTarget = null;
    openArtistEditor(null);
  });
  pub("artist-filters")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-artist-filter]");
    if (!button) return;
    artistBoard.filter = button.dataset.artistFilter || "all";
    artistBoard.page = 1;
    renderArtistBoard();
  });
  pub("artist-list")?.addEventListener("click", async (event) => {
    const pageButton = event.target.closest("[data-artist-page]");
    if (pageButton) {
      artistBoard.page = Number(pageButton.dataset.artistPage) || 1;
      renderArtistBoard();
      return;
    }
    const copyButton = event.target.closest("[data-artist-copy]");
    if (copyButton) {
      const row = collectArtists().find((item) => item.name === copyButton.dataset.artistCopy);
      const text = row?.official?.id || row?.profile?.id || row?.name || "";
      try {
        await navigator.clipboard.writeText(text);
        toast(row?.official?.id || row?.profile?.id ? "艺人 ID 已复制" : "艺人名已复制");
      } catch {
        toast("复制失败，请手动选择");
      }
      return;
    }
    const editButton = event.target.closest("[data-artist-edit]");
    if (!editButton) return;
    const row = collectArtists().find((item) => item.name === editButton.dataset.artistEdit);
    if (row) openArtistEditor(row);
  });
  pub("artist-editor")?.addEventListener("click", (event) => {
    if (event.target.closest("[data-artist-close]")) closeArtistEditor();
  });
  pub("artist-roles")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-artist-role]");
    if (!button || artistBoard.locked) return;
    const on = button.getAttribute("aria-pressed") === "true";
    button.setAttribute("aria-pressed", on ? "false" : "true");
    button.className = `rounded-full border px-3 py-1 text-xs font-bold ${on ? "border-slate-200 bg-white text-slate-600" : "border-slate-900 bg-slate-900 text-white"}`;
  });
  pub("artist-platforms")?.addEventListener("change", (event) => {
    const input = event.target.closest("input[type='radio']");
    if (!input) return;
    const id = input.name.replace("artist-platform-", "");
    const create = input.value === "create";
    const url = pub(`artist-platform-url-${id}`);
    const fans = pub(`artist-platform-fans-${id}`);
    if (url) {
      url.disabled = create;
      if (create) url.value = "";
    }
    if (fans) {
      fans.disabled = create;
      if (create) fans.value = "";
    }
  });
  pub("artist-desc")?.addEventListener("input", () => {
    pub("artist-desc-count").textContent = `${pub("artist-desc").value.length}/255`;
  });
  pub("artist-cover-pick")?.addEventListener("click", () => pub("artist-cover")?.click());
  pub("artist-cover")?.addEventListener("change", () => {
    const file = pub("artist-cover").files?.[0];
    artistBoard.blob = null;
    const name = pub("artist-cover-name");
    if (name) name.textContent = file?.name || "";
    if (!file) return showArtistCover("", pub("artist-name").value);
    showArtistCover(URL.createObjectURL(file), "");
  });
  pub("artist-avatar-generate")?.addEventListener("click", async () => {
    const button = pub("artist-avatar-generate");
    const artist = pub("artist-name").value.trim();
    if (!artist) return toast("先写艺人名，再生成头像");
    button.disabled = true;
    button.textContent = "正在生成头像…";
    try {
      const data = await publishJson("/api/publish/cover", {
        kind: "avatar",
        artist,
        singerType: pub("artist-type").selectedOptions?.[0]?.textContent || "",
        desc: pub("artist-desc").value.trim(),
      });
      const mime = data.mime || "image/png";
      const blob = await (await fetch(`data:${mime};base64,${data.image}`)).blob();
      const file = new File([blob], data.name || "avatar.png", { type: blob.type || mime });
      artistBoard.blob = file;
      const input = pub("artist-cover");
      try {
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
      } catch {
        /* 写不进文件框时，创建艺人仍会用刚生成的这张头像 */
      }
      showArtistCover(URL.createObjectURL(file), "");
      const coverName = pub("artist-cover-name");
      if (coverName) coverName.textContent = file.name;
      toast("头像已生成，并已选为艺人封面");
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
      button.textContent = "智能生成头像";
    }
  });
  pub("artist-save")?.addEventListener("click", async () => {
    const button = pub("artist-save");
    const name = pub("artist-name").value.trim();
    const platforms = readArtistPlatforms();
    const company = pub("artist-company").value.trim();
    if (artistBoard.locked) {
      const current = collectArtists().find((item) => item.name === artistBoard.editing);
      const profile = current?.profile || {};
      button.disabled = true;
      try {
        const avatar = await storeArtistAvatar();
        await saveArtistProfile({
          ...profile,
          name: artistBoard.editing,
          company: company || profile.company || "",
          platforms,
          avatar,
        });
        closeArtistEditor();
        renderArtistBoard();
        toast(avatar && avatar !== profile.avatar ? "头像和平台信息已保存" : "平台信息已保存");
      } catch (error) {
        toast(error.message);
      } finally {
        button.disabled = false;
      }
      return;
    }
    if (!name) return toast("先写艺人名");
    if (collectArtists().some((item) => artistKey(item.name) === artistKey(name))) return toast("这位艺人已经在名单里");
    if (!pub("artist-cover")?.files?.[0] && !artistBoard.blob) return toast("先上传一张 1:1 的艺人封面");
    const roles = selectedArtistRoles();
    if (!roles.length) return toast("至少选一个艺人角色");
    const desc = pub("artist-desc").value.trim();
    if (desc.length < 10 || desc.length > 255) return toast("个人简介需要 10 到 255 字");
    button.disabled = true;
    button.textContent = "正在创建…";
    try {
      const coverId = await uploadCover(pub("artist-cover"), "singer_cover", artistBoard.blob);
      const avatar = await storeArtistAvatar();
      const created = await publishJson("/api/publish/singers", {
        singerName: name,
        singerType: pub("artist-type").value,
        singerRoles: roles,
        area: pub("artist-area").value,
        desc,
        coverId,
      });
      await saveArtistProfile({
        id: created.singer?.id || "",
        name,
        singerType: pub("artist-type").value,
        roles,
        area: pub("artist-area").value,
        desc,
        company,
        platforms,
        avatar,
        createdAt: new Date().toISOString(),
      });
      const target = artistBoard.fromUpload ? publishState.singerTarget : null;
      const createdSinger = { id: String(created.singer?.id || ""), name, source: "used" };
      closeArtistEditor();
      artistBoard.filter = "all";
      artistBoard.query = "";
      if (pub("artist-query")) pub("artist-query").value = "";
      renderArtistBoard();
      if (target?.kind === "track" && target.songId && createdSinger.id) chooseTrackSinger(target.songId, createdSinger);
      else if (target && createdSinger.id) chooseAlbumSinger(createdSinger);
      else toast(`已创建艺人 ${name}`);
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
      button.textContent = "新增艺人";
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !pub("artist-editor")?.classList.contains("hidden")) closeArtistEditor();
  });
}

async function publishJson(url, body) {
  const response = await publishFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || "发行请求失败");
    error.verifyUrl = data.verifyUrl;
    throw error;
  }
  return data;
}

async function uploadCover(input, type, extraFile) {
  let file = input?.files?.[0] || extraFile || null;
  if (!file && type === "album_cover" && publishState.coverBlob) {
    file = new File([publishState.coverBlob], publishState.coverName || "cover.png", { type: publishState.coverBlob.type || "image/png" });
  }
  if (!file && type === "singer_cover" && publishState.avatarBlob) {
    file = new File([publishState.avatarBlob], publishState.avatarName || "avatar.png", { type: publishState.avatarBlob.type || "image/png" });
  }
  if (!file) return 0;
  const response = await publishFetch(`/api/publish/upload?type=${encodeURIComponent(type)}&name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || (type === "contract" ? "合同上传失败" : "封面上传失败"));
  return data.fileId;
}

function formPayload(draft) {
  readTracksFromDom();
  const platforms = [];
  if (pub("publish-wyy").checked) platforms.push("wyy");
  if (pub("publish-qs").checked) platforms.push("qs");
  if (pub("publish-fq")?.checked) platforms.push("fq");
  if (pub("publish-dy")?.checked) platforms.push("dy");
  if (pub("publish-ks")?.checked) platforms.push("ks");
  const first = publishState.tracks[0] || {};
  return {
    draft,
    songId: first.songId || "",
    songName: first.name || "",
    songs: publishState.tracks.map((track) => ({
      songId: track.songId,
      songName: track.name.trim(),
      subtitle: track.subtitle.trim(),
      version: track.version,
      versionNote: track.versionNote,
      language: track.language,
      firstGenre: track.firstGenre,
      secondGenre: track.secondGenre,
      singer: track.singer.trim(),
      lyricist: track.lyricist.trim(),
      lyricsRight: track.lyricsRight || "1",
      tuneRight: track.tuneRight || "1",
      performerRight: track.performerRight || "1",
      tapeRight: track.tapeRight || "1",
      contractComplete: track.contractComplete || "0",
      contractRemark: track.contractRemark || "",
      contractFileId: track.contractFileId || "",
      composer: track.composer.trim(),
      arranger: track.arranger.trim(),
      producer: track.producer.trim(),
      planer: track.planer.trim(),
      lyric: track.lyricMode === "none" ? "" : track.lyric,
      lyricMode: track.lyricMode === "lrc" ? "lrc" : (track.lyricMode === "none" ? "none" : "txt"),
      isAi: track.isAi,
      clipStart: track.clipStart === 0 || track.clipStart ? track.clipStart : "",
      accomSongId: track.accomSongId || "",
    })),
    albumName: pub("publish-album").value.trim(),
    albumType: pub("publish-album-type")?.value || "single",
    singerId: publishState.singerId,
    singerName: publishState.singerName,
    singerSourceType: publishState.singerSourceType,
    singerSource: publishState.singerSource,
    language: pub("publish-language").value,
    albumArea: pub("publish-area").value,
    firstGenre: pub("publish-genre").value,
    secondGenre: pub("publish-genre2").value,
    payPattern: pub("publish-pay").value,
    authArea: pub("publish-auth-area").value,
    canCover: pub("publish-cover").value,
    needFans: document.querySelector("[name='publish-fans']:checked")?.value || "0",
    adFlag: document.querySelector("[name='publish-ad']:checked")?.value || "1",
    recordingAuthForm: document.querySelector("[name='publish-auth-recording']:checked")?.value || "1",
    lyricAuthForm: document.querySelector("[name='publish-auth-lyric']:checked")?.value || "3",
    composingAuthForm: document.querySelector("[name='publish-auth-composing']:checked")?.value || "3",
    recordingRelation: document.querySelector("[name='publish-rel-recording']:checked")?.value || "1",
    lyricRelation: document.querySelector("[name='publish-rel-lyric']:checked")?.value || "1",
    composingRelation: document.querySelector("[name='publish-rel-composing']:checked")?.value || "1",
    recordingProtect: document.querySelector("[name='publish-protect-recording']:checked")?.value || "1",
    lyricProtect: document.querySelector("[name='publish-protect-lyric']:checked")?.value || "1",
    composingProtect: document.querySelector("[name='publish-protect-composing']:checked")?.value || "1",
    lyricShare: pub("publish-lyric-share")?.value || "100",
    composingShare: pub("publish-composing-share")?.value || "100",
    copyrightName: pub("publish-copyright-name")?.value.trim() || "",
    clipAuth: document.querySelector("[name='publish-clip-auth']:checked")?.value || "1",
    issuedTime: pub("publish-issued").value,
    onlineTime: pub("publish-online").value,
    brand: pub("publish-brand").value.trim(),
    introduction: pub("publish-intro").value.trim() || DEFAULT_ALBUM_INTRO,
    platforms,
    confirmed: publishState.contractOpened,
    signedContract: publishState.token,
  };
}

function singerToken(text) {
  const parts = String(text || "").split(/[、,，]/);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const token = parts[index].trim();
    if (token) return token;
  }
  return "";
}

function replaceSingerToken(text, name) {
  const parts = String(text || "").split(/[、,，]/);
  let index = -1;
  for (let cursor = parts.length - 1; cursor >= 0; cursor -= 1) {
    if (parts[cursor].trim()) {
      index = cursor;
      break;
    }
  }
  if (index < 0) return name;
  parts[index] = name;
  return parts.map((part) => part.trim()).filter(Boolean).join("、");
}

function hideSingerResults(keep) {
  const album = pub("publish-singers");
  if (album && album !== keep) {
    album.classList.add("hidden");
    album.innerHTML = "";
  }
  document.querySelectorAll("[data-singer-results]").forEach((node) => {
    if (node === keep) return;
    node.classList.add("hidden");
    node.innerHTML = "";
  });
}

function singerResultBox(target) {
  if (target?.kind === "track" && target.songId) {
    const card = document.querySelector(`[data-track="${CSS.escape(target.songId)}"]`);
    return card?.querySelector("[data-singer-results]") || null;
  }
  return pub("publish-singers");
}

function bindAlbumSinger(item) {
  publishState.singerId = item.id;
  publishState.singerName = item.name;
  publishState.singerSourceType = item.source === "tme" ? "tme" : "used";
  publishState.singerSource = item.raw || null;
  const input = pub("publish-artist");
  if (input) input.value = item.name;
}

function chooseAlbumSinger(item) {
  bindAlbumSinger(item);
  hideSingerResults();
  toast(`已选择 ${item.name}`);
}

function chooseTrackSinger(songId, item) {
  readTracksFromDom();
  const track = publishState.tracks.find((row) => row.songId === songId);
  if (track) {
    track.singer = replaceSingerToken(track.singer, item.name);
    if (!track.lyricist.trim()) track.lyricist = item.name;
    if (!track.composer.trim()) track.composer = item.name;
  }
  bindAlbumSinger(item);
  renderTracks();
  hideSingerResults();
  toast(`已选择 ${item.name}，专辑歌手已同步`);
}

function setLibraryStatus(text) {
  const node = pub("publish-library-status");
  if (node) node.textContent = text || "";
}

let uploadUiGeneration = 0;

function setUploadProgress({ visible = true, label = "", ratio = 0, state = "upload" } = {}) {
  const box = pub("publish-upload-progress");
  const bar = pub("publish-upload-bar");
  const labelNode = pub("publish-upload-label");
  const percentNode = pub("publish-upload-percent");
  if (!box || !bar) return;
  if (!visible) {
    box.classList.add("hidden");
    bar.style.width = "0%";
    bar.classList.remove("is-wait", "is-done", "is-error");
    box.setAttribute("aria-valuenow", "0");
    return;
  }
  box.classList.remove("hidden");
  if (labelNode && label) labelNode.textContent = label;
  const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  bar.style.width = `${percent}%`;
  bar.classList.toggle("is-wait", state === "wait");
  bar.classList.toggle("is-done", state === "done");
  bar.classList.toggle("is-error", state === "error");
  box.setAttribute("aria-valuenow", String(percent));
  if (percentNode) {
    percentNode.textContent = `${percent}%`;
    percentNode.classList.toggle("text-emerald-600", state === "done");
    percentNode.classList.toggle("text-rose-600", state === "error");
    percentNode.classList.toggle("text-orange-600", state !== "done" && state !== "error");
  }
}

function beginUploadUi() {
  uploadUiGeneration += 1;
  return uploadUiGeneration;
}

function finishUploadUi(generation, state) {
  setUploadProgress(state);
  window.setTimeout(() => {
    if (generation !== uploadUiGeneration) return;
    setUploadProgress({ visible: false });
  }, 2200);
}

function setLibraryBusy(busy) {
  publishState.busy = busy;
  const scan = pub("publish-scan");
  if (scan) scan.disabled = busy;
  const input = pub("publish-import");
  if (input) input.disabled = busy;
  pub("publish-import-label")?.classList.toggle("opacity-50", busy);
  pub("publish-import-label")?.classList.toggle("pointer-events-none", busy);
  pub("publish-drop")?.classList.toggle("opacity-50", busy);
}

function uploadAudio(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/publish/import");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
    const key = readHikoonKey();
    if (key) xhr.setRequestHeader("X-Hikoon-Key", key);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    };
    xhr.onerror = () => reject(new Error("上传中断了，请再试一次"));
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText || "{}");
      } catch {
        data = {};
      }
      if (xhr.status < 200 || xhr.status >= 300 || data.ok === false) {
        reject(new Error(data.error || "加入曲库失败"));
        return;
      }
      resolve(data);
    };
    xhr.send(file);
  });
}

async function ingestFiles(fileList) {
  const files = [...(fileList || [])].filter((file) => /\.(mp3|wav|flac|m4a)$/i.test(file.name) && !file.name.startsWith("."));
  if (pub("publish-folder")) pub("publish-folder").value = "";
  if (pub("publish-import")) pub("publish-import").value = "";
  if (!files.length) {
    setLibraryStatus("没有找到 mp3、wav、flac 或 m4a。");
    toast("没有找到音频文件");
    return;
  }
  setLibraryBusy(true);
  const generation = beginUploadUi();
  let latest = null;
  let songs = [];
  let added = 0;
  let skipped = 0;
  let shown = 0;
  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const prefix = `${index + 1}/${files.length} · ${file.name}`;
      shown = index / files.length;
      setLibraryStatus(`正在上传 ${prefix}`);
      setUploadProgress({ visible: true, label: `正在上传 ${prefix}`, ratio: shown, state: "upload" });
      const data = await uploadAudio(file, (ratio) => {
        const waiting = ratio >= 1;
        const capped = waiting ? 0.92 : Math.min(ratio, 0.92);
        shown = (index + capped) / files.length;
        const label = waiting ? `正在处理 ${prefix}` : `正在上传 ${prefix}`;
        setLibraryStatus(label);
        setUploadProgress({ visible: true, label, ratio: shown, state: waiting ? "wait" : "upload" });
      });
      songs = data.songs || songs;
      latest = data.song || latest;
      if (data.duplicate) skipped += 1;
      else added += 1;
      if (data.song) addTrack(data.song, { silent: true });
      renderSongs(songs);
      shown = (index + 1) / files.length;
    }
    if (latest?.id) previewSong(latest.id);
    if (files.length === 1 && skipped === 1) {
      setLibraryStatus("这首已经在曲库里，没有重复添加。");
      toast("这首已经在曲库里");
      finishUploadUi(generation, { visible: true, label: "这首已经在曲库里，没有重复添加。", ratio: 1, state: "done" });
    } else {
      const text = skipped ? `新加入 ${added} 首，${skipped} 首本来就在。` : `已加入 ${added} 首。`;
      setLibraryStatus(text);
      toast(text);
      finishUploadUi(generation, { visible: true, label: text, ratio: 1, state: "done" });
    }
  } catch (error) {
    setLibraryStatus(error.message);
    toast(error.message);
    setUploadProgress({ visible: true, label: error.message, ratio: shown, state: "error" });
  } finally {
    setLibraryBusy(false);
  }
}

let bootSerial = 0;

function paintPublish(data, options = {}) {
  if (publishState.keySource && data.keySource && publishState.keySource !== data.keySource) {
    publishState.constants = null;
  }
  const incoming = data.constants;
  const incomingReady = Array.isArray(incoming?.language) && incoming.language.length > 0;
  const currentReady = Array.isArray(publishState.constants?.language) && publishState.constants.language.length > 0;
  if (incoming && incomingReady && !currentReady) applyConstants(incoming);
  renderPublishAccount(data);
  renderSongs(data.songs || []);
  if (options.releases !== false && Array.isArray(data.releases) && data.releases.length) {
    renderReleases(data.releases, { total: data.releaseTotal });
  }
}

let releaseSerial = 0;

async function loadReleases(options = {}) {
  const serial = ++releaseSerial;
  const box = pub("publish-releases");
  const showing = releaseBrowser.ready && Boolean(box?.querySelector("[data-play-name], [data-release-page], [data-release-all]"));
  if (options.fresh || !showing) {
    box.textContent = options.fresh
      ? "正在重新读取全部已提交的歌…"
      : "正在读取全部已提交的歌。第一次会稍等，之后翻页和搜索直接用这份列表。";
  }
  try {
    const fresh = options.fresh ? "?fresh=1" : "";
    const response = await publishFetch(`/api/publish/releases${fresh}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (serial !== releaseSerial) return;
    if (!response.ok || data.ok === false) throw new Error(data.error || "发行记录没有读出来");
    renderReleases(data.releases || [], { message: data.message || "", scope: data.scope || "" });
  } catch (error) {
    if (serial !== releaseSerial) return;
    if (options.fresh || !showing) box.textContent = error.message;
  }
}

async function bootPublish(options = {}) {
  const serial = ++bootSerial;
  const remembered = options.fresh ? null : readPublishSnapshot();
  if (remembered) paintPublish(remembered, { releases: false });
  else if (pub("publish-account")) pub("publish-account").textContent = "正在连接海葵…";
  if (options.fresh || !remembered?.releases?.length) renderReleases([], { loading: true });
  loadReleases({ fresh: Boolean(options.fresh) });
  const fresh = options.fresh ? "?fresh=1" : "";
  const response = await publishFetch(`/api/publish/bootstrap${fresh}`, { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (serial !== bootSerial) return false;
  if (!response.ok || data.ok === false) {
    if (!remembered) renderKeyHint(data);
    return false;
  }
  paintPublish(data, { releases: false });
  writePublishSnapshot(data);
  loadIncome();
  publishState.booted = true;
  return true;
}

async function applyHikoonKey(raw) {
  const key = normalizeHikoonKey(raw);
  if (!key) {
    toast("没有读到海葵密钥");
    return;
  }
  const previous = readHikoonKey();
  writeHikoonKey(key);
  publishState.constants = null;
  const ok = await bootPublish();
  if (!ok) {
    writeHikoonKey(previous);
    publishState.constants = null;
    await bootPublish();
    toast("这把密钥没有通过，已改回原来的");
    return;
  }
  pub("publish-key").value = "";
  setKeyPanel(false);
  toast("密钥已保存");
}

function setPublishMode(mode) {
  const works = mode !== "artists";
  pub("publish-hikoon")?.classList.toggle("hidden", !works);
  pub("publish-artists")?.classList.toggle("hidden", works);
  document.querySelectorAll("#publish-mode button").forEach((button) => {
    const on = button.dataset.publishMode === (works ? "works" : "artists");
    button.className = `px-3 py-2 rounded-lg ${on ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`;
  });
  if (!works) {
    const stale = releaseBrowser.ready && releaseBrowser.list.some((song) => song.singer) && releaseBrowser.list.every((song) => !song.createdAt && !song.submitter);
    if (!releaseBrowser.ready || stale) loadReleases(stale ? { fresh: true } : {}).finally(() => renderArtistBoard());
    loadArtistProfiles();
  } else {
    closeArtistEditor();
  }
}

function bindPublish() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(10, 0, 0, 0);
  const when = localStamp(tomorrow);
  pub("publish-issued").value = when;
  pub("publish-online").value = when;
  if (!pub("publish-intro").value.trim()) pub("publish-intro").value = DEFAULT_ALBUM_INTRO;
  renderContractStatus();
  fillSelect("publish-singer-type", singerTypes.map(([value, label]) => ({ value, label })), "0");
  fillSelect("publish-singer-role", singerRoles.map(([value, label]) => ({ value, label })), "0");
  fillSelect("publish-singer-area", singerAreas.map(([value, label]) => ({ value, label })), "1");

  document.querySelectorAll("#publish-mode button").forEach((button) => {
    button.addEventListener("click", () => setPublishMode(button.dataset.publishMode));
  });
  bindArtistDesk();
  pub("publish-genre")?.addEventListener("change", () => {
    fillSecondGenre();
    paintAlbumPreset();
  });
  pub("publish-album-type")?.addEventListener("change", () => {
    publishState.albumTypeManual = true;
    paintAlbumPreset();
  });
  ["publish-language", "publish-area", "publish-genre2"].forEach((id) => {
    pub(id)?.addEventListener("change", paintAlbumPreset);
  });
  pub("publish-preset-edit")?.addEventListener("click", () => {
    const fields = pub("publish-preset-fields");
    const hidden = fields.classList.toggle("hidden");
    pub("publish-preset-edit").textContent = hidden ? "展开" : "收起";
  });
  paintAlbumPreset();
  pub("publish-scan")?.addEventListener("click", () => {
    if (publishState.busy) return;
    pub("publish-folder")?.click();
  });
  pub("publish-folder")?.addEventListener("change", () => {
    if (publishState.busy) return;
    ingestFiles(pub("publish-folder").files);
  });
  pub("publish-import")?.addEventListener("change", () => {
    if (publishState.busy) return;
    ingestFiles(pub("publish-import").files);
  });
  pub("publish-key-toggle")?.addEventListener("click", () => {
    const panel = pub("publish-key-panel");
    setKeyPanel(panel.classList.contains("hidden"));
  });
  pub("publish-key-save")?.addEventListener("click", () => applyHikoonKey(pub("publish-key").value));
  pub("publish-key-file")?.addEventListener("change", () => {
    const file = pub("publish-key-file").files?.[0];
    pub("publish-key-file").value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => applyHikoonKey(String(reader.result || ""));
    reader.onerror = () => toast("密钥文件没有读出来");
    reader.readAsText(file);
  });
  pub("publish-key-clear")?.addEventListener("click", async () => {
    if (!readHikoonKey()) return toast("这台浏览器还没保存密钥");
    if (!window.confirm("清除这台浏览器里保存的海葵密钥？")) return;
    writeHikoonKey("");
    publishState.constants = null;
    if (pub("publish-key")) pub("publish-key").value = "";
    setKeyPanel(false);
    await bootPublish();
    toast("已清除密钥");
  });
  pub("publish-cover-file").addEventListener("change", () => {
    const file = pub("publish-cover-file").files?.[0];
    if (!file) return;
    publishState.coverBlob = null;
    if (publishState.coverUrl) URL.revokeObjectURL(publishState.coverUrl);
    publishState.coverUrl = URL.createObjectURL(file);
    const preview = pub("publish-cover-preview");
    preview.src = publishState.coverUrl;
    preview.classList.remove("hidden");
  });
  pub("publish-cover-generate").addEventListener("click", async () => {
    const button = pub("publish-cover-generate");
    readTracksFromDom();
    const songName = pub("publish-album").value.trim() || publishState.tracks[0]?.name || "";
    if (!songName) return toast("先写专辑名，再生成封面");
    button.disabled = true;
    button.textContent = "正在生成封面…";
    try {
      const genre = pub("publish-genre").selectedOptions?.[0]?.textContent || "";
      const data = await publishJson("/api/publish/cover", {
        songName,
        artist: publishState.singerName || pub("publish-artist").value.trim(),
        genre,
        lyric: publishState.tracks[0]?.lyric || "",
      });
      const mime = data.mime || "image/png";
      const blob = await (await fetch(`data:${mime};base64,${data.image}`)).blob();
      const file = new File([blob], data.name || "cover.png", { type: blob.type || mime });
      publishState.coverBlob = file;
      publishState.coverName = file.name;
      const input = pub("publish-cover-file");
      try {
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
      } catch {
        /* 写不进文件框时，提交仍会用刚生成的这张封面 */
      }
      if (publishState.coverUrl) URL.revokeObjectURL(publishState.coverUrl);
      publishState.coverUrl = URL.createObjectURL(file);
      const preview = pub("publish-cover-preview");
      preview.src = publishState.coverUrl;
      preview.classList.remove("hidden");
      toast("封面已生成，并已选为专辑封面");
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
      button.textContent = "智能生成封面";
    }
  });
  let singerSearchSerial = 0;
  let singerSearchTimer = 0;
  function paintSingerChoices(box, items, query, target) {
    if (!box) return;
    box.classList.remove("hidden");
    const create = `<button type="button" data-open-create-singer class="w-full rounded-xl border border-dashed border-amber-300 bg-amber-50 px-3 py-2 text-sm font-bold text-amber-700">新建歌手</button>`;
    if (!items.length) {
      box.innerHTML = `<p class="text-sm text-slate-500">没有叫「${esc(query)}」的歌手。</p>${create}`;
    } else {
      box.innerHTML = items.map((item, index) => singerCard(item, index)).join("") + create;
      box.querySelectorAll("[data-singer]").forEach((node) => {
        node.addEventListener("click", () => {
          const item = items[Number(node.dataset.singer)];
          if (target.kind === "track") chooseTrackSinger(target.songId, item);
          else chooseAlbumSinger(item);
        });
      });
    }
    box.querySelector("[data-open-create-singer]")?.addEventListener("click", () => openCreateSinger(query, target));
  }
  async function runSingerSearch(query, target, serial) {
    const box = singerResultBox(target);
    try {
      const response = await publishFetch(`/api/publish/singers?name=${encodeURIComponent(query)}`);
      const data = await response.json();
      if (serial !== singerSearchSerial) return;
      if (!response.ok || !data.ok) throw new Error(data.error || "没有查到艺人");
      hideSingerResults(box);
      paintSingerChoices(box, [...(data.used || []), ...(data.tme || [])], query, target);
    } catch (error) {
      if (serial !== singerSearchSerial) return;
      if (box) {
        box.classList.remove("hidden");
        box.innerHTML = `<p class="text-sm text-slate-500">${esc(error.message)}</p>`;
      } else toast(error.message);
    }
  }
  function scheduleSingerSearch(raw, target) {
    clearTimeout(singerSearchTimer);
    const query = singerToken(raw);
    const box = singerResultBox(target);
    publishState.singerTarget = { kind: target.kind, songId: target.songId || "", name: query };
    if (!query) {
      hideSingerResults();
      return;
    }
    hideSingerResults(box);
    if (box) {
      box.classList.remove("hidden");
      box.innerHTML = `<p class="text-sm text-slate-500">正在查找「${esc(query)}」…</p>`;
    }
    const serial = ++singerSearchSerial;
    singerSearchTimer = setTimeout(() => runSingerSearch(query, target, serial), 200);
  }
  function searchAlbumSinger() {
    const input = pub("publish-artist");
    if (!input) return;
    if (input.value.trim() !== publishState.singerName) {
      publishState.singerId = "";
      publishState.singerSourceType = "";
      publishState.singerSource = null;
    }
    scheduleSingerSearch(input.value, { kind: "album" });
  }
  function openCreateSinger(name, target) {
    const picked = target || { kind: "album" };
    const value = singerToken(name) || String(name || "").trim();
    publishState.singerTarget = { kind: picked.kind || "album", songId: picked.songId || "", name: value };
    artistBoard.fromUpload = true;
    openArtistEditor(null);
    if (value && pub("artist-name")) pub("artist-name").value = value;
    pub("artist-editor-title").textContent = "新增艺人";
    pub("artist-save").textContent = "新增艺人";
    pub("publish-new-singer")?.classList.add("hidden");
  }
  pub("publish-find-singer").addEventListener("click", () => {
    const query = singerToken(pub("publish-artist").value);
    if (!query) return toast("先写艺人名");
    clearTimeout(singerSearchTimer);
    const serial = ++singerSearchSerial;
    const target = { kind: "album" };
    publishState.singerTarget = { kind: "album", songId: "", name: query };
    const box = singerResultBox(target);
    hideSingerResults(box);
    if (box) {
      box.classList.remove("hidden");
      box.innerHTML = `<p class="text-sm text-slate-500">正在查找「${esc(query)}」…</p>`;
    }
    runSingerSearch(query, target, serial);
  });
  pub("publish-artist").addEventListener("input", (event) => {
    if (event.isComposing) return;
    searchAlbumSinger();
  });
  pub("publish-artist").addEventListener("compositionend", searchAlbumSinger);
  pub("publish-new-toggle").addEventListener("click", () => {
    openCreateSinger(pub("publish-artist").value, { kind: "album" });
  });
  pub("publish-singer-cover").addEventListener("change", () => {
    const file = pub("publish-singer-cover").files?.[0];
    if (!file) return;
    publishState.avatarBlob = null;
    if (publishState.avatarUrl) URL.revokeObjectURL(publishState.avatarUrl);
    publishState.avatarUrl = URL.createObjectURL(file);
    const preview = pub("publish-avatar-preview");
    preview.src = publishState.avatarUrl;
    preview.classList.remove("hidden");
  });
  pub("publish-avatar-generate").addEventListener("click", async () => {
    const button = pub("publish-avatar-generate");
    const artist = publishState.singerTarget?.name || pub("publish-artist").value.trim();
    if (!artist) return toast("先写艺人名，再生成头像");
    button.disabled = true;
    button.textContent = "正在生成头像…";
    try {
      const data = await publishJson("/api/publish/cover", {
        kind: "avatar",
        artist,
        singerType: pub("publish-singer-type").selectedOptions?.[0]?.textContent || "",
        desc: pub("publish-singer-desc").value.trim(),
      });
      const mime = data.mime || "image/png";
      const blob = await (await fetch(`data:${mime};base64,${data.image}`)).blob();
      const file = new File([blob], data.name || "avatar.png", { type: blob.type || mime });
      publishState.avatarBlob = file;
      publishState.avatarName = file.name;
      const input = pub("publish-singer-cover");
      try {
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
      } catch {
        /* 写不进文件框时，创建艺人仍会用刚生成的这张头像 */
      }
      if (publishState.avatarUrl) URL.revokeObjectURL(publishState.avatarUrl);
      publishState.avatarUrl = URL.createObjectURL(file);
      const preview = pub("publish-avatar-preview");
      preview.src = publishState.avatarUrl;
      preview.classList.remove("hidden");
      toast("头像已生成，并已选为艺人头像");
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
      button.textContent = "智能生成头像";
    }
  });
  pub("publish-create-singer").addEventListener("click", async () => {
    try {
      const coverId = await uploadCover(pub("publish-singer-cover"), "singer_cover");
      const singerName = publishState.singerTarget?.name || pub("publish-artist").value.trim();
      const data = await publishJson("/api/publish/singers", {
        singerName,
        singerType: pub("publish-singer-type").value,
        singerRole: pub("publish-singer-role").value,
        area: pub("publish-singer-area").value,
        desc: pub("publish-singer-desc").value.trim(),
        coverId,
      });
      const created = { id: data.singer.id, name: data.singer.name, source: "used" };
      const target = publishState.singerTarget;
      if (target?.kind === "track" && target.songId) chooseTrackSinger(target.songId, created);
      else chooseAlbumSinger(created);
    } catch (error) {
      toast(error.message);
    }
  });
  pub("publish-contract").addEventListener("click", async () => {
    try {
      const data = await publishJson("/api/publish/token", {});
      publishState.token = data.token;
      publishState.contractUrl = data.contractUrl;
      const link = pub("publish-contract-link");
      link.href = data.contractUrl;
      link.classList.remove("hidden");
      window.open(data.contractUrl, "_blank", "noopener");
      publishState.contractOpened = true;
      renderContractStatus();
      pub("publish-result").textContent = "授权书已打开。请在那个页面里点确认，再回到这里保存或提交。";
    } catch (error) {
      toast(error.message);
    }
  });
  function renderContractStatus() {
    const status = pub("publish-contract-status");
    if (!status) return;
    status.textContent = publishState.contractOpened
      ? "授权书已打开。请在那个页面里点确认，确认后回到这里提交。"
      : "还没有打开授权书。确认是在授权书页面里完成的。";
  }
  function duplicatePrompt(hits) {
    const hit = hits[0];
    const detail = [hit.singer, hit.albumName, hit.statusLabel].filter(Boolean).join(" · ");
    const lead = hit.file
      ? `这份音频已经提交过发行，当时的歌名是「${hit.name}」`
      : `「${hit.name}」已经提交过发行`;
    const extra = hits.length > 1 ? `，一共 ${hits.length} 条记录` : "";
    return `${lead}${detail ? `（${detail}）` : ""}${extra}。还要再提交一次吗？`;
  }
  async function confirmFreshSubmit() {
    readTracksFromDom();
    for (const track of publishState.tracks) {
      const data = await publishJson("/api/publish/duplicates", {
        songId: track.songId,
        songName: track.name,
      });
      const hits = data.hits || [];
      if (hits.length && !window.confirm(duplicatePrompt(hits))) return false;
    }
    return true;
  }
  async function submit(draft) {
    const result = pub("publish-result");
    if (!validateAlbumStep({ cover: !draft })) return;
    if (!publishState.contractOpened || !publishState.token) {
      result.textContent = "请先打开授权书。确认要在授权书页面里完成，再回到这里提交。";
      toast("请先在授权书页面里确认");
      return;
    }
    if (!pub("publish-intro").value.trim()) pub("publish-intro").value = DEFAULT_ALBUM_INTRO;
    result.textContent = draft ? "正在保存草稿…" : "正在提交发行…";
    try {
      if (!draft) {
        const fresh = await confirmFreshSubmit();
        if (!fresh) {
          result.textContent = "已取消这次提交。";
          return;
        }
      }
      const coverId = await uploadCover(pub("publish-cover-file"), "album_cover");
      const data = await publishJson("/api/publish/create", { ...formPayload(draft), coverId });
      result.textContent = draft ? `草稿已保存，专辑编号 ${data.albumId || ""}` : `已提交发行，专辑编号 ${data.albumId || ""}`;
      if (data.complete && Array.isArray(data.releases)) {
        renderReleases(data.releases, { scope: data.scope || "" });
      } else if (Array.isArray(data.created) && data.created.length && releaseBrowser.ready) {
        const ids = new Set(data.created.map((song) => String(song.id)));
        releaseBrowser.list = [...data.created, ...releaseBrowser.list.filter((song) => !ids.has(String(song.id)))];
        releaseBrowser.page = 1;
        paintReleaseBrowser();
      } else {
        renderReleases(data.releases || data.created || [], { scope: data.scope || "" });
      }
      toast(draft ? "草稿已保存" : "已提交发行");
    } catch (error) {
      const contractHint = /暂未确认授权书/.test(error.message || "") ? "请回到授权书页面点确认，再提交。" : "";
      result.textContent = [error.verifyUrl ? `${error.message} ${error.verifyUrl}` : error.message, contractHint].filter(Boolean).join(" ");
      toast(error.message);
    }
  }
  pub("publish-draft").addEventListener("click", () => submit(1));
  pub("publish-submit").addEventListener("click", () => submit(0));
  pub("publish-refresh").addEventListener("click", () => bootPublish({ fresh: true }));
  pub("publish-export-ranking").addEventListener("click", () => exportIncome("ranking"));
  pub("publish-export-bills").addEventListener("click", () => exportIncome("bills"));
  pub("publish-release-query")?.addEventListener("input", (event) => {
    releaseBrowser.query = event.target.value;
    releaseBrowser.page = 1;
    if (releaseBrowser.ready) paintReleaseBrowser();
  });
  function openSongData(event) {
    const cancelButton = event.target.closest("[data-cancel-id]");
    if (cancelButton) {
      cancelRelease(cancelButton);
      return;
    }
    const filterButton = event.target.closest("[data-release-filter]");
    if (filterButton) {
      releaseBrowser.filter = filterButton.dataset.releaseFilter || "all";
      releaseBrowser.page = 1;
      releaseBrowser.showAll = false;
      paintReleaseBrowser();
      return;
    }
    const modeButton = event.target.closest("[data-release-all]");
    if (modeButton) {
      releaseBrowser.showAll = modeButton.dataset.releaseAll === "1";
      releaseBrowser.page = 1;
      paintReleaseBrowser();
      return;
    }
    const releaseButton = event.target.closest("[data-release-page]");
    if (releaseButton) {
      if (releaseButton.disabled) return;
      releaseBrowser.showAll = false;
      releaseBrowser.page = Number(releaseButton.dataset.releasePage) || 1;
      paintReleaseBrowser();
      return;
    }
    const button = event.target.closest("[data-play-name]");
    if (!button) return;
    loadPlays(button.dataset.playName, button.dataset.playSinger, button.dataset.playId);
  }
  async function cancelRelease(button) {
    const name = button.dataset.cancelName || "这首歌";
    const songId = Number(button.dataset.cancelId);
    const albumId = Number(button.dataset.cancelAlbum);
    if (!window.confirm(`撤销《${name}》的审核？`)) return;
    button.disabled = true;
    button.textContent = "撤销中";
    try {
      await publishJson("/api/publish/cancel", {
        id: songId,
        albumId: Number.isFinite(albumId) && albumId > 0 ? albumId : undefined,
      });
      const others = releaseBrowser.list.filter((song) => (
        String(song.id) !== String(songId)
        && albumId > 0
        && String(song.albumId) === String(albumId)
        && song.status === "BUSINESS_REVIEWING"
      )).length;
      releaseBrowser.list = releaseBrowser.list.map((song) => {
        const sameSong = String(song.id) === String(songId);
        const sameAlbum = albumId > 0 && String(song.albumId) === String(albumId) && song.status === "BUSINESS_REVIEWING";
        if (!sameSong && !sameAlbum) return song;
        return { ...song, status: "BUSINESS_CANCELLED", statusLabel: "已撤销" };
      });
      paintReleaseBrowser();
      toast(others
        ? `《${name}》审核已撤销。同一专辑下其他 ${others} 首歌也已撤销。`
        : `《${name}》审核已撤销。同一专辑下的其他歌也已撤销。`);
    } catch (error) {
      button.disabled = false;
      button.textContent = "撤销";
      toast(error.message || "撤销失败");
    }
  }
  pub("publish-releases").addEventListener("click", openSongData);
  pub("publish-sync-album")?.addEventListener("click", syncAlbumFromSongs);
  pub("publish-pay-cards").addEventListener("change", (event) => {
    const input = event.target.closest("input[name='publish-pay-radio']");
    if (!input) return;
    pub("publish-pay").value = input.value;
  });
  pub("publish-auth-edit")?.addEventListener("click", () => {
    const box = pub("publish-auth-fields");
    const open = box?.classList.toggle("hidden") === false;
    pub("publish-auth-edit").textContent = open ? "收起" : "展开";
  });
  pub("publish-dy")?.addEventListener("change", paintClipRows);
  pub("publish-ks")?.addEventListener("change", paintClipRows);
  pub("publish-clip-list")?.addEventListener("input", (event) => {
    const slider = event.target.closest("[data-clip-start]");
    if (!slider) return;
    const row = slider.closest("[data-clip-row]");
    const track = clipTrack(row?.dataset.songId || "");
    const start = Number(slider.value) || 0;
    if (track) {
      track.clipStart = start;
      track.clipPicked = true;
    }
    const audio = row?.querySelector("[data-clip-audio]");
    if (row) paintClipLabel(row, audio?.duration, start, false);
  });
  pub("publish-clip-list")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-clip-preview]");
    if (!button) return;
    const row = button.closest("[data-clip-row]");
    const audio = row?.querySelector("[data-clip-audio]");
    const slider = row?.querySelector("[data-clip-start]");
    if (!audio || !slider) return;
    const start = Number(slider.value) || 0;
    const length = Math.min(30, Number.isFinite(audio.duration) ? audio.duration : 30);
    audio.dataset.clipEnd = String(start + length);
    audio.dataset.clipPreview = "1";
    const play = () => audio.play().catch(() => toast("这段暂时播不了"));
    if (Math.abs(audio.currentTime - start) > 0.4) {
      const onSeek = () => {
        audio.removeEventListener("seeked", onSeek);
        play();
      };
      audio.addEventListener("seeked", onSeek);
      audio.currentTime = start;
      return;
    }
    play();
  });
  pub("publish-auth-area")?.addEventListener("change", paintAuthPreset);
  pub("publish-cover")?.addEventListener("change", paintAuthPreset);
  pub("publish-issued")?.addEventListener("change", paintAuthPreset);
  renderPayCards();
  paintAuthPreset();
  document.querySelectorAll("[data-step-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = Number(tab.dataset.stepTab);
      if (target > publishState.step && !validateAlbumStep({ cover: publishState.step === 1 })) return;
      if (target > publishState.step + 1) return;
      setPublishStep(target);
    });
  });
  pub("publish-next").addEventListener("click", () => {
    if (publishState.step === 1 && !validateAlbumStep({ cover: true })) return;
    setPublishStep(publishState.step + 1);
  });
  pub("publish-back").addEventListener("click", () => setPublishStep(publishState.step - 1));
  const drop = pub("publish-drop");
  drop.addEventListener("click", () => {
    if (!publishState.busy) pub("publish-import").click();
  });
  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("border-amber-400", "bg-amber-50");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("border-amber-400", "bg-amber-50"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("border-amber-400", "bg-amber-50");
    if (publishState.busy) return;
    ingestFiles(event.dataTransfer?.files);
  });
  pub("publish-tracks").addEventListener("compositionend", (event) => {
    const singer = event.target.closest?.("[data-field='singer']");
    const card = event.target.closest?.("[data-track]");
    if (!singer || !card) return;
    scheduleSingerSearch(singer.value, { kind: "track", songId: card.dataset.track });
  });
  pub("publish-tracks").addEventListener("click", (event) => {
    const card = event.target.closest("[data-track]");
    if (!card) return;
    if (event.target.closest("[data-new-singer]")) {
      const input = card.querySelector("[data-field='singer']");
      openCreateSinger(input?.value || "", { kind: "track", songId: card.dataset.track });
      return;
    }
    if (event.target.closest("[data-accom-clear]")) {
      readTracksFromDom();
      const track = publishState.tracks.find((item) => item.songId === card.dataset.track);
      if (track && !track.accomUploading) {
        track.accomSongId = "";
        track.accomFileName = "";
      }
      renderTracks();
      return;
    }
    if (event.target.closest("[data-remove]")) {
      readTracksFromDom();
      publishState.tracks = publishState.tracks.filter((track) => track.songId !== card.dataset.track);
      renderTracks();
      renderSongs(publishState.library || []);
      return;
    }
    if (event.target.closest("[data-collapse]")) {
      const track = publishState.tracks.find((item) => item.songId === card.dataset.track);
      if (!track) return;
      track.open = !track.open;
      card.querySelector("[data-track-body]")?.classList.toggle("hidden", !track.open);
      event.target.closest("[data-collapse]").textContent = track.open ? "收起" : "展开";
      return;
    }
    if (event.target.closest("[data-sync]")) syncTrack(card.dataset.track);
  });
  pub("publish-tracks").addEventListener("input", (event) => {
    const card = event.target.closest("[data-track]");
    if (!card) return;
    readTracksFromDom();
    patchTrackHeader(card);
    const singer = event.target.closest?.("[data-field='singer']");
    if (!singer || event.isComposing) return;
    scheduleSingerSearch(singer.value, { kind: "track", songId: card.dataset.track });
  });
  pub("publish-tracks").addEventListener("change", async (event) => {
    const card = event.target.closest("[data-track]");
    if (!card) return;
    const accomInput = event.target.closest("[data-accom-file]");
    if (accomInput?.files?.[0]) {
      const file = accomInput.files[0];
      accomInput.value = "";
      uploadTrackAccom(card.dataset.track, file);
      return;
    }
    if (event.target.matches("[data-field='firstGenre']")) {
      const { options, selected } = secondGenreOptions(event.target.value);
      const second = card.querySelector("[data-field='secondGenre']");
      if (second) {
        second.innerHTML = options.map((item) => `<option value="${esc(item.value)}">${esc(item.label)}</option>`).join("");
        second.value = selected || "";
      }
    }
    if (event.target.matches("[data-field='lyric']")) {
      const cleaned = event.target.value.includes("[") || event.target.value.includes("【")
        ? stripSunoCues(event.target.value)
        : event.target.value;
      if (cleaned !== event.target.value) event.target.value = cleaned;
    }
    if (event.target.matches("[data-version], [data-right-choice]")) {
      readTracksFromDom();
      const track = publishState.tracks.find((item) => item.songId === card.dataset.track);
      const summary = card.querySelector("[data-right-summary]");
      if (summary && track) summary.textContent = rightSummary(track);
      patchTrackHeader(card);
    }
    if (event.target.matches("[data-lyric-mode]")) {
      card.querySelector("[data-lyric-box]")?.classList.toggle("hidden", event.target.value === "none");
      const area = card.querySelector("[data-field='lyric']");
      if (area) area.placeholder = event.target.value === "lrc" ? "LRC 歌词，保留时间轴。" : "纯文本歌词。";
    }
    const contractInput = event.target.closest("[data-contract-file]");
    if (contractInput?.files?.[0]) {
      const file = contractInput.files[0];
      try {
        const fileId = await uploadCover(contractInput, "contract");
        readTracksFromDom();
        const track = publishState.tracks.find((item) => item.songId === card.dataset.track);
        if (track) {
          track.contractFileId = String(fileId || "");
          track.contractName = file.name;
        }
        renderTracks();
        toast(fileId ? "合同已上传" : "合同没有传上去");
      } catch (error) {
        toast(error.message || "合同上传失败");
      }
      return;
    }
    const fileInput = event.target.closest("[data-lyric-file]");
    if (fileInput?.files?.[0]) {
      const file = fileInput.files[0];
      try {
        const lyric = lyricFromFile(file.name, await file.text());
        const area = card.querySelector("[data-field='lyric']");
        if (area) {
          area.value = lyric.text;
          area.placeholder = lyric.mode === "lrc" ? "LRC 歌词，保留时间轴。" : "纯文本歌词。";
        }
        const mode = card.querySelector(`[data-lyric-mode][value='${lyric.mode}']`);
        if (mode) mode.checked = true;
        card.querySelector("[data-lyric-box]")?.classList.remove("hidden");
        fileInput.value = "";
        toast(lyric.text ? (lyric.mode === "lrc" ? "LRC 歌词已导入" : "歌词已导入") : "这个文件里没有歌词正文");
      } catch {
        toast("歌词文件没有读出来");
      }
    }
    readTracksFromDom();
    patchTrackHeader(card);
    updateAlbumHint();
  });
  renderTracks();
  setPublishStep(1);
}

bindPublish();
window.bootPublish = bootPublish;
