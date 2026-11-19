const $ = (id) => document.getElementById(id);
const CLASHES = {
  更原声: ["更电子"],
  更电子: ["更原声"],
  速度更快: ["速度更慢"],
  速度更慢: ["速度更快"],
  纯器乐: ["人声更靠前"],
  人声更靠前: ["纯器乐"],
};
const SAMPLE = {
  title: "晚风信箱",
  style: "Mandarin vocals, sung in Mandarin, gentle male, nostalgic Chinese pop ballad, heartfelt storytelling, fingerpicking acoustic guitar, felt piano, cinematic emotional strings, warm fretless bass, mellow brushed drums, breathy, reflective, 76 bpm",
  exclude: "EDM drops, trap hi-hats, heavy autotune, distorted guitars, choir stacks",
  simple: "Mandarin pop ballad, close male vocal, acoustic guitar and piano, soft strings, 76 BPM, warm and nearby.",
  lyrics: "[Intro]\n[Warm acoustic piano melody, subtle acoustic guitar]\n\n[Verse 1]\n信箱里还留着去年的风\n我把它折好 没有寄出\n\n[Chorus]\n[Soft drums and fretless bass, strings lift]\n晚风替我送一封信\n不写名字 只写星辰\n\n[Outro]\n[End]",
  notes: "这是格式示例。Style 贴风格框，Lyrics 里单独成行的方括号是段落和伴奏，方括号外面才是要唱的词。",
};

const settings = loadSettings();
const PLAN_NAMES = { basic: "基础版", pro: "专业版", max: "Max" };
const userState = { credits: Number(localStorage.getItem("sm-credits") || 50) };
let accountUser = null;
let accountMode = "login";
let accountResolved = false;
let billingSnapshot = { subscriptionStatus: "none", plan: "", billingInterval: "" };
let priceCatalog = null;
let currentWorkspace = "hot";
const selectedTags = new Set();
let styleSource = "tags";
const lyricPair = { source: "", next: "", sourceEdited: false, note: "", state: "" };
let composerLyricKey = "";
let lyricLookupSeq = 0;
let lyricLookupTimer = 0;
let lyricDeskTimer = 0;
let lyricDeskSeq = 0;
const lyricCache = new Map();
let lyricView = "next";
const PROMPT_LIMITS = [
  ["style-text-content", "style-count", 1000],
  ["exclude-text-content", "exclude-count", 1000],
  ["simple-mode-content", "simple-count", 200],
];
let composerMode = "hybrid";
let audioPayload = null;
let audioReading = false;
let referenceAudioUrl = "";
let referenceAudio = null;
let curation = { songs: [], charts: [], platforms: [] };
const HOT_COPY = {
  new: "近七日才出现在歌曲榜上的歌。已经在热歌榜或 TOP500 上的不列入。优先看多平台同时新上，以及近七日第一次出现的。",
  rising: "同一平台内，近七日名次升幅最大的歌。升幅大、覆盖榜多、现在名次更靠前的排前面。",
  potential: "已经有扩散、但还没进入热歌前 10。按新歌未破、指数先涨、歌单渗透、抖音领先、多平台露头计分，命中越多越靠前。",
  heat: "先按平台看新上和上升，再看各张榜的更新时间。",
};
let filter = { platform: "all", chart: "all" };
const songMap = new Map();
let lyricState = { skills: [], chartLyricists: [], written: {}, expandedLyricists: new Set(), lyricistQuery: "", controls: null, tongues: [], tongue: "cmn", tightness: "wide", register: "written", skillId: "", golden: "", history: [], versions: [], revisionCursor: 0, lyricMode: "edit", committed: "", editTimer: 0, brought: false, draft: false, busyAction: "" };
let audioCtx = null;
let currentSynthInterval = null;
let busy = false;

const AUTH_ERRORS = {
  google_unconfigured: "Google 登录还没配好。需要 Google Cloud 里的客户端 ID 和密钥。",
  wechat_unconfigured: "微信登录还没配好。需要微信开放平台网站应用的 AppID 和 AppSecret。",
  denied: "你取消了这次登录",
  state: "登录状态过期了，请再点一次",
  failed: "第三方登录没有完成，请稍后再试",
};

function bind() {
  document.querySelectorAll(".nav-btn, .m-nav-btn[data-workspace]").forEach((btn) => btn.addEventListener("click", () => switchWorkspace(btn.dataset.workspace)));
  document.querySelectorAll(".lyric-mtab").forEach((btn) => btn.addEventListener("click", () => switchLyricTab(btn.dataset.lyricTab)));
  $("mobile-account").addEventListener("click", () => switchWorkspace("account"));
  $("open-account").addEventListener("click", () => switchWorkspace("account"));
  $("account-form").addEventListener("submit", submitAccount);
  $("account-switch-mode").addEventListener("click", () => setAccountMode(accountMode === "login" ? "register" : "login"));
  $("account-logout").addEventListener("click", logoutAccount);
  $("account-open-settings").addEventListener("click", openSettings);
  window.addEventListener("popstate", () => {
    const onAccount = location.pathname === "/account" || location.pathname === "/login" || location.pathname === "/pricing";
    switchWorkspace(onAccount ? "account" : (history.state?.workspace || "hot"), { silent: true });
  });
  $("charge-btn").addEventListener("click", () => startCheckout("credits"));
  document.querySelectorAll("[data-vip-interval]").forEach((button) => {
    button.addEventListener("click", () => setVipInterval(button.dataset.vipInterval));
  });
  document.querySelectorAll("[data-vip-plan]").forEach((button) => {
    button.addEventListener("click", () => startCheckout("subscription", {
      plan: button.dataset.vipPlan,
      interval: vipInterval,
      button,
    }));
  });
  $("manage-billing")?.addEventListener("click", openBillingPortal);
  $("open-settings").addEventListener("click", openSettings);
  $("close-settings").addEventListener("click", () => $("settings-modal").classList.add("hidden"));
  $("provider-gemini").addEventListener("click", () => setProvider("gemini"));
  $("provider-bailian").addEventListener("click", () => setProvider("bailian"));
  $("save-engine").addEventListener("click", saveSettings);
  $("test-engine").addEventListener("click", testEngine);
  $("bailian-file").addEventListener("change", onKeyFile);
  $("song-search").addEventListener("input", renderDispatch);
  $("btn-toggle-search").addEventListener("click", () => setSearchOpen(!searchOpen));
  $("btn-view-list").addEventListener("click", () => setHotView("list"));
  $("btn-view-grid").addEventListener("click", () => setHotView("grid"));
  document.querySelectorAll(".mode-btn").forEach((btn) => btn.addEventListener("click", () => switchComposerMode(btn.dataset.mode)));
  document.querySelectorAll("[data-tag]").forEach((btn) => {
    if (btn.classList.contains("active")) selectedTags.add(tagText(btn));
    btn.addEventListener("click", () => toggleTag(btn));
  });
  document.querySelectorAll("[data-direction]").forEach((btn) => btn.addEventListener("click", () => toggleDirection(btn)));
  $("audio-file").addEventListener("change", onAudio);
  $("compose-btn").addEventListener("click", generatePackage);
  $("analyze-song").addEventListener("click", analyzeReferenceSong);
  $("analyze-song-side").addEventListener("click", analyzeReferenceSong);
  $("ref-song").addEventListener("input", () => {
    refreshAnalyzeHint();
    scheduleSourceLyrics();
  });
  $("ref-artist").addEventListener("input", scheduleSourceLyrics);
  $("lyric-title-input").addEventListener("input", scheduleLyricDeskLyrics);
  $("lyric-artist-input").addEventListener("input", scheduleLyricDeskLyrics);
  $("show-sample").addEventListener("click", () => showPackage(SAMPLE));
  $("handoff-lyric").addEventListener("click", handoffToLyric);
  $("lyric-rollback").addEventListener("click", rollbackLyric);
  $("lyric-main-editor").addEventListener("input", onLyricInput);
  $("open-suno-composer").addEventListener("click", () => openSuno($("style-text-content").value, newLyricText()));
  $("open-suno-lyric").addEventListener("click", () => openSuno($("style-text-content").value, $("lyric-main-editor").value));
  $("close-suno").addEventListener("click", () => $("suno-modal").classList.add("hidden"));
  document.querySelectorAll("[data-copy]").forEach((btn) => btn.addEventListener("click", () => copyField(btn.dataset.copy)));
  $("simple-mode-content").addEventListener("input", updatePromptCounts);
  $("style-text-content").addEventListener("input", updatePromptCounts);
  $("exclude-text-content").addEventListener("input", updatePromptCounts);
  $("composer-lyrics-rich").addEventListener("input", () => {
    lyricPair[lyricView] = $("composer-lyrics-rich").value;
    if (lyricView === "source") lyricPair.sourceEdited = true;
  });
  document.querySelectorAll("[data-lyric-view]").forEach((btn) => btn.addEventListener("click", () => setLyricView(btn.dataset.lyricView)));
  $("rewrite-lyric").addEventListener("click", rewriteNextLyric);
  document.querySelectorAll("[data-meta]").forEach((btn) => btn.addEventListener("click", () => appendMetatag(btn.dataset.meta)));
  $("lyric-tongue").addEventListener("change", () => applyTongue($("lyric-tongue").value));
  $("lyric-tightness").addEventListener("change", () => {
    lyricState.tightness = $("lyric-tightness").value === "strict" ? "strict" : "wide";
    paintCraft(false);
  });
  $("lyric-register").addEventListener("change", () => {
    lyricState.register = $("lyric-register").value === "spoken" ? "spoken" : "written";
    paintCraft(false);
  });
  $("format-lyric").addEventListener("click", formatLyric);
  $("lyric-golden").addEventListener("input", () => {
    lyricState.golden = $("lyric-golden").value.trim();
    syncGoldenDraft(lyricState.golden, false);
  });
  $("lyric-golden-roll").addEventListener("click", rollGolden);
  $("lyric-expand-section").addEventListener("click", expandSection);
  $("lyric-expand-song").addEventListener("click", expandSong);
  paintSpark();
  $("lyric-mode-edit").addEventListener("click", () => setLyricMode("edit"));
  $("lyric-mode-diff").addEventListener("click", () => setLyricMode("diff"));
  $("lyric-revision-older").addEventListener("click", () => stepRevision(-1));
  $("lyric-revision-newer").addEventListener("click", () => stepRevision(1));
  $("lyric-revision-restore").addEventListener("click", restoreViewedLyric);
  $("ai-send").addEventListener("click", sendLyricChat);
  $("ai-command-input").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    if (event.ctrlKey) {
      event.preventDefault();
      sendLyricChat();
    }
  });
  $("stop-audition").addEventListener("click", stopAllAuditions);
  document.body.addEventListener("click", (event) => {
    const audition = event.target.closest("[data-audition], [data-play-file]");
    if (audition) {
      event.preventDefault();
      if (audition.dataset.playFile === "reference") playReferenceAudition(audition);
      else toggleAudioAudition(audition, audition.dataset.audition, audition.dataset.style || "chill");
      return;
    }
    const fill = event.target.closest("[data-fill]");
    if (fill) sendHotToComposer(fill.dataset.fill);
    const lyricSong = event.target.closest("[data-lyric-song]");
    if (lyricSong) sendHotToLyricDesk(lyricSong.dataset.lyricSong);
    const fav = event.target.closest("[data-fav]");
    if (fav) toggleFavorite(fav.dataset.fav);
    const jump = event.target.closest("[data-jump-song]");
    if (jump) jumpToSong(jump.dataset.jumpSong);
    const opener = event.target.closest("[data-open-chart]");
    if (opener) openChartBoard(opener.dataset.openChart, opener.dataset.chartCode, opener.dataset.chartName);
    const closer = event.target.closest("[data-close-chart]");
    if (closer) closeChart();
    const more = event.target.closest("[data-chart-more]");
    if (more) {
      chartExpanded = true;
      renderDispatch();
    }
    const restyle = event.target.closest("[data-restyle]");
    if (restyle) restyleWithSkill(restyle.dataset.restyle);
    const moreSongs = event.target.closest("[data-lyricist-more]");
    if (moreSongs) {
      const name = moreSongs.dataset.lyricistMore;
      if (lyricState.expandedLyricists.has(name)) lyricState.expandedLyricists.delete(name);
      else lyricState.expandedLyricists.add(name);
      renderLyricists(false);
    }
    const pick = event.target.closest("[data-pick-skill]");
    if (pick && !event.target.closest("[data-restyle]") && !event.target.closest("[data-lyricist-more]") && !event.target.closest("[data-audition]")) {
      selectSkill(pick.dataset.pickSkill, false);
    }
  });
  $("lyricist-search")?.addEventListener("input", () => {
    lyricState.lyricistQuery = $("lyricist-search").value;
    renderLyricists(true);
  });
  syncStyleFromTags();
  reflectEngine();
  updateCreditsUI();
  armAudition(document);
}

function newVisitorId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch { /* http 页面上没有 randomUUID */ }
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  const part = (n) => Array.from({ length: n }, hex).join("");
  return `${part(8)}-${part(4)}-4${part(3)}-a${part(3)}-${part(12)}`;
}

function getCustomerRef() {
  const key = "sm-visitor";
  let id = "";
  try { id = localStorage.getItem(key) || ""; } catch { id = ""; }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    id = newVisitorId();
    try { localStorage.setItem(key, id); } catch { /* 记不住就只用于当前页面 */ }
  }
  return id;
}

async function loadVisitCount() {
  const el = $("visit-count");
  if (!el) return;
  const id = getCustomerRef();
  try {
    const data = await fetch("/api/visit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).then((r) => r.json());
    if (Number.isFinite(data.count)) el.textContent = Number(data.count).toLocaleString("zh-CN");
  } catch { /* 接口没起来时保持横线 */ }
}

async function boot() {
  loadVisitCount();
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) renderAccount();
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== "sm-checkout-event") return;
    sessionStorage.setItem("sm-checkout-pending", "1");
    location.reload();
  });
  const params = new URLSearchParams(location.search);
  const checkoutResult = params.get("checkout");
  const authError = params.get("auth_error");
  if (sessionStorage.getItem("sm-checkout-pending")) {
    sessionStorage.removeItem("sm-checkout-pending");
    toast("付款已完成，正在确认到账");
    [1500, 3500, 7000].forEach((delay) => setTimeout(syncBillingStatus, delay));
  } else if (checkoutResult === "success") {
    localStorage.setItem("sm-checkout-event", String(Date.now()));
    toast("付款已完成，正在确认到账");
    [1500, 3500, 7000].forEach((delay) => setTimeout(syncBillingStatus, delay));
  } else if (checkoutResult === "cancelled") {
    toast("已取消付款");
  }
  if (params.get("auth") === "ok") toast("已登录");
  renderAccount();
  if (checkoutResult || authError || params.get("auth") || location.pathname === "/account" || location.pathname === "/login" || location.pathname === "/pricing") {
    if (checkoutResult || authError || params.get("auth")) history.replaceState({ workspace: "account" }, "", "/account");
    switchWorkspace("account", { silent: true });
  }
  if (authError) setAccountError(AUTH_ERRORS[authError] || AUTH_ERRORS.failed);
  loadCharts();
  const healthPromise = fetch("/api/health").then((r) => r.json()).catch(() => null);
  loadCatalog();
  await loadAccount();
  const health = await healthPromise;
  if (health && !health.gemini) toast("服务器没有读到 Gemini 密钥");
  loadLyric();
  if (health && !health.lyric) {
    const timer = setInterval(async () => {
      const next = await fetch("/api/health").then((r) => r.json()).catch(() => null);
      if (next?.lyric) {
        clearInterval(timer);
        loadLyric();
      }
    }, 2000);
  }
}

let hotPlatform = "all";
let hotView = "list";
let searchOpen = false;
let focusSongId = "";
let openChart = null;
let chartBoard = null;
let chartToken = 0;
let chartExpanded = false;
const favKey = "sunomaster-favs";
function loadFavs() {
  try { return new Set(JSON.parse(localStorage.getItem(favKey) || "[]")); } catch { return new Set(); }
}
let favorites = loadFavs();
const HOT_CACHE_KEY = "sunomaster-hot-v1";
let hotRendered = "";

function potentialBare(data) {
  const picks = data?.potential || [];
  return picks.length > 0 && !picks.some((song) => song.sourceUrl);
}

function readHotCache() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(HOT_CACHE_KEY) || "null");
    if (saved && saved.ok && saved.insight && !potentialBare(saved)) return saved;
  } catch { /* 隐私模式或旧数据 */ }
  return null;
}

function writeHotCache(data) {
  try {
    const copy = { ...data };
    delete copy.refreshing;
    sessionStorage.setItem(HOT_CACHE_KEY, JSON.stringify(copy));
  } catch { /* 配额不够就下次再存 */ }
}

function hotStamp(data) {
  const pack = (list) => (list || []).map((song) => `${song.id}:${song.coverUrl ? 1 : 0}:${song.sourceUrl ? 1 : 0}`).join(",");
  const groups = (data.groups || []).map((group) => `${group.platform}:${(group.charts || []).length}`).join(",");
  return [data.updatedAt || "", data.insight?.headline || "", pack(data.newSongs), pack(data.risingSongs), pack(data.potential), groups].join("|");
}

function showHot(data) {
  const stamp = hotStamp(data);
  const same = stamp === hotRendered;
  curation = data;
  if (!same) {
    songMap.clear();
    for (const song of [...(data.newSongs || []), ...(data.risingSongs || []), ...(data.potential || [])]) {
      songMap.set(song.id, song);
    }
    hotRendered = stamp;
    renderDispatch();
  }
  const when = (data.updatedAt || "").replace("T", " ").slice(0, 16);
  $("hot-lead").textContent = when
    ? `榜单更新到 ${when}。约每 30 分钟刷新一次。官方试听打开原平台。`
    : "近七日榜单。约每 30 分钟刷新一次。";
}

function readEmbeddedHot() {
  const data = window.__hotSnapshot;
  if (data && data.ok && data.insight && !potentialBare(data)) return data;
  return null;
}

async function loadCharts() {
  const embedded = readEmbeddedHot();
  if (embedded) {
    showHot(embedded);
    writeHotCache(embedded);
    return;
  }
  if (!curation.insight) {
    const cached = readHotCache();
    if (cached) showHot(cached);
  }
  try {
    const response = await fetch("/hot.json");
    const data = await response.json();
    if (!response.ok || !data?.ok) throw new Error(data?.error || "榜单读取失败");
    showHot(data);
    writeHotCache(data);
  } catch (error) {
    if (!curation.insight) $("hot-lead").textContent = error.message || "榜单读取失败";
  }
}

function songOnPlatform(song, platform) {
  if (platform === "all") return true;
  if (song.platform === platform) return true;
  return (song.platforms || []).some((item) => {
    if (item === platform) return true;
    if (item && item.platform === platform) return true;
    return Array.isArray(item && item.platforms) && item.platforms.includes(platform);
  });
}

function setSearchOpen(open) {
  searchOpen = open;
  $("song-search-row").classList.toggle("hidden", !open);
  const button = $("btn-toggle-search");
  button.setAttribute("aria-expanded", open ? "true" : "false");
  button.className = open
    ? "shrink-0 rounded-xl bg-slate-900 px-3 py-2 text-sm font-bold text-white"
    : "shrink-0 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-600";
  if (open) $("song-search").focus();
  if (!open && $("song-search").value) {
    $("song-search").value = "";
    renderDispatch();
  }
}

function plainName(value) {
  return String(value || "").replace(/\s/g, "").toLowerCase();
}

function songsNamed(name) {
  const key = plainName(name);
  return [...songMap.values()].filter((song) => plainName(song.songName) === key);
}

function linkMentions(text) {
  return String(text || "").split(/(《[^》]+》)/g).map((part) => {
    const match = part.match(/^《([^》]+)》$/);
    if (!match) return esc(part);
    const hits = songsNamed(match[1]);
    const song = (/升/.test(text) ? hits.find((item) => item.maxDelta != null) : null) || hits[0];
    if (!song) return esc(part);
    return `<button type="button" data-jump-song="${esc(song.id)}" class="font-semibold text-orange-700 underline decoration-orange-200 underline-offset-4 hover:decoration-orange-500">《${esc(song.songName)}》</button>`;
  }).join("");
}

function jumpToSong(id) {
  if (!songMap.has(id)) return;
  closeChart(false);
  hotPlatform = "all";
  focusSongId = id;
  if ($("song-search").value) $("song-search").value = "";
  renderDispatch();
  const node = document.querySelector(`[data-song-card="${CSS.escape(id)}"]`);
  if (node) node.scrollIntoView({ behavior: "smooth", block: "center" });
}

function isPlaylistChart(chart) {
  const code = String(chart.chartCode || "").toLowerCase();
  const name = String(chart.chartName || "");
  return code === "haikuiplaylist" || code === "hotsearch" || code === "myplaylist" || code === "热门搜索" || name.includes("海葵") || name.includes("热门搜索");
}

function closeChart(redraw = true) {
  chartToken += 1;
  openChart = null;
  chartBoard = null;
  chartExpanded = false;
  if (redraw) renderDispatch();
}

async function openChartBoard(platform, code, name) {
  const token = ++chartToken;
  openChart = { platform, code, name: name || code };
  chartBoard = null;
  chartExpanded = false;
  focusSongId = "";
  renderDispatch();
  $("chart-board")?.scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    const data = await fetch(`/api/chart?platform=${encodeURIComponent(platform)}&code=${encodeURIComponent(code)}`).then(async (r) => {
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "读不到这张榜");
      return body;
    });
    if (token !== chartToken) return;
    chartBoard = data;
    for (const song of data.songs || []) songMap.set(song.id, song);
    renderDispatch();
  } catch (error) {
    if (token !== chartToken) return;
    chartBoard = { error: error.message || "读不到这张榜" };
    renderDispatch();
  }
}

function setHotView(view) {
  hotView = view;
  $("module-hot").classList.toggle("view-grid", view === "grid");
  $("btn-view-list").className = `px-3 py-1.5 rounded-lg text-sm font-bold ${view === "list" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`;
  $("btn-view-grid").className = `px-3 py-1.5 rounded-lg text-sm font-bold ${view === "grid" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`;
}

function renderDispatch() {
  const tabs = [
    { id: "all", label: "全部热点" },
    { id: "qq", label: "QQ音乐" },
    { id: "netease", label: "网易云" },
    { id: "kugou", label: "酷狗" },
    { id: "douyin", label: "抖音" },
    { id: "qishui", label: "汽水" },
    { id: "fanqie", label: "番茄" },
  ];
  $("hot-platform-tabs").innerHTML = tabs.map((tab) => `<button type="button" data-hot-platform="${tab.id}" class="px-3.5 py-1.5 rounded-lg whitespace-nowrap ${hotPlatform === tab.id ? "bg-white text-slate-900 shadow-sm" : "text-slate-600"}">${tab.label}</button>`).join("");
  $("hot-platform-tabs").querySelectorAll("[data-hot-platform]").forEach((btn) => {
    btn.addEventListener("click", () => {
      hotPlatform = btn.dataset.hotPlatform;
      if (openChart && openChart.platform !== hotPlatform) closeChart(false);
      renderDispatch();
    });
  });
  const q = $("song-search").value.trim().toLowerCase();
  const match = (song) => songOnPlatform(song, hotPlatform) && (!q || `${song.songName} ${song.singerName}`.toLowerCase().includes(q));
  const insight = curation.insight || {};
  const counts = insight.counts || {};
  $("insight-panel").innerHTML = `
    <div class="studio-box p-4 sm:p-6">
      <p class="text-sm font-semibold text-orange-600">热点速递</p>
      <h3 class="mt-2 text-xl font-bold text-slate-900 leading-snug sm:text-2xl">${linkMentions(insight.headline || "正在归纳")}</h3>
      <p class="mt-2 text-sm text-slate-500">${esc(insight.note || "")}</p>
      <p class="mt-1 text-sm text-slate-400">${esc([insight.today, insight.windowLabel].filter(Boolean).join(" · "))}</p>
      <div class="mt-5 grid grid-cols-2 md:grid-cols-4 gap-3">
        ${stat("新上榜", counts.newSongs)}
        ${stat("七日首现", counts.debuts)}
        ${stat("跨平台", counts.multi)}
        ${stat("上升最快", counts.rising)}
      </div>
      <p class="mt-4 text-base leading-7 text-slate-700">${esc(insight.brief || "")}</p>
      <ul class="mt-4 grid gap-2 sm:grid-cols-2">
        ${(insight.bullets || []).map((item) => `<li class="rounded-xl bg-slate-50 border border-slate-100 px-4 py-3 text-sm leading-6 text-slate-700">${linkMentions(item)}</li>`).join("")}
      </ul>
    </div>`;
  const fresh = (curation.newSongs || []).filter(match);
  const rising = (curation.risingSongs || []).filter(match);
  $("block-lists").innerHTML = `
    ${listBlock("新上榜", curation.copy?.new || HOT_COPY.new, fresh, counts.newSongs, (song) => newCard(song))}
    ${listBlock("上升最快", curation.copy?.rising || HOT_COPY.rising, rising, counts.rising, (song) => risingCard(song))}`;
  const picks = (curation.potential || []).filter(match);
  $("block-potential").innerHTML = `
    <div class="mb-4">
      <h3 class="text-xl font-black text-slate-900 sm:text-2xl">潜力池</h3>
      <p class="mt-2 max-w-3xl text-sm leading-6 text-slate-500">${esc(curation.copy?.potential || HOT_COPY.potential)}</p>
    </div>
    <div class="grid gap-3">${picks.map((song) => potentialCard(song)).join("") || `<p class="text-base text-slate-500">这一池按五条信号计分，曲库结果随后补上。</p>`}</div>`;
  const pulses = (curation.pulses || []).length ? curation.pulses : [
    { label: "QQ音乐", chartCount: "—", newCount: "—", risingCount: "—" },
    { label: "网易云", chartCount: "—", newCount: "—", risingCount: "—" },
    { label: "酷狗", chartCount: "—", newCount: "—", risingCount: "—" },
    { label: "抖音", chartCount: "—", newCount: "—", risingCount: "—" },
    { label: "汽水", chartCount: "—", newCount: "—", risingCount: "—" },
    { label: "番茄", chartCount: "—", newCount: "—", risingCount: "—" },
  ];
  const groups = (curation.groups || []).map((group) => ({
    ...group,
    charts: (group.charts || []).filter((chart) => !isPlaylistChart(chart)),
  }));
  $("block-heat").innerHTML = `
    <div class="mb-4">
      <h3 class="text-xl font-black text-slate-900 sm:text-2xl">平台热度</h3>
      <p class="mt-2 max-w-3xl text-sm leading-6 text-slate-500">${esc(curation.copy?.heat || HOT_COPY.heat)}</p>
    </div>
    <div class="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
      ${pulses.map((pulse) => `<div class="studio-box px-3 py-3 sm:px-5 sm:py-4"><div class="text-sm text-slate-500">${esc(pulse.label)}</div><div class="mt-1 text-2xl font-bold text-slate-900 sm:text-3xl">${pulse.chartCount} 榜</div><div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm text-slate-600"><span>新上 ${pulse.newCount}</span><span>上升 ${pulse.risingCount}</span></div></div>`).join("")}
    </div>
    <div class="grid gap-5">${groups.map((group) => `<div><div class="mb-2 text-lg font-bold text-slate-900">${esc(group.label)}</div><div class="flex flex-wrap gap-2">${(group.charts || []).map((chart) => {
      const on = openChart && openChart.platform === group.platform && openChart.code === chart.chartCode;
      return `<button type="button" data-open-chart="${esc(group.platform)}" data-chart-code="${esc(chart.chartCode)}" data-chart-name="${esc(chart.chartName)}" class="chart-pill rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700 ${on ? "is-on" : ""}">${esc(chart.chartName)}</button>`;
    }).join("")}</div></div>`).join("")}</div>`;
  renderChartBoard();
}

function stat(label, value) {
  return `<div class="rounded-2xl bg-slate-50 border border-slate-100 px-3 py-3 text-left sm:px-4"><div class="text-sm text-slate-500">${label}</div><div class="mt-1 text-2xl font-bold text-slate-900 sm:text-3xl">${value ?? "—"}</div></div>`;
}

function shownSongs(songs) {
  const head = songs.slice(0, 8);
  if (!focusSongId || head.some((song) => song.id === focusSongId)) return head;
  const extra = songs.find((song) => song.id === focusSongId);
  return extra ? [extra, ...head] : head;
}

function listBlock(title, copy, songs, total, render) {
  const empty = hotPlatform === "all" ? "歌曲名单还在传。" : "这个平台这一栏暂时没有歌。";
  const count = hotPlatform === "all" ? (total ?? songs.length) : songs.length;
  return `<div><div class="mb-3 sm:mb-4"><div class="flex items-baseline justify-between gap-3"><h3 class="text-xl font-black text-slate-900 sm:text-2xl">${title}</h3><span class="shrink-0 text-sm text-slate-400">全部 ${count}</span></div><p class="mt-1.5 text-sm leading-6 text-slate-500">${esc(copy || "")}</p></div><div class="song-stack grid gap-3">${shownSongs(songs).map(render).join("") || `<p class="text-base text-slate-500">${empty}</p>`}</div></div>`;
}

const HOT_PLATFORM_LABEL = { qq: "QQ音乐", netease: "网易云", kugou: "酷狗", douyin: "抖音", qishui: "汽水", fanqie: "番茄" };

function renderChartBoard() {
  const board = $("chart-board");
  if (!openChart) {
    board.classList.add("hidden");
    board.innerHTML = "";
    return;
  }
  for (const song of chartBoard?.songs || []) songMap.set(song.id, song);
  board.classList.remove("hidden");
  const title = `${HOT_PLATFORM_LABEL[openChart.platform] || openChart.platform} · ${openChart.name || ""}`;
  if (!chartBoard) {
    board.innerHTML = `<div class="studio-box p-5"><button type="button" data-close-chart class="text-sm font-semibold text-slate-500 hover:text-slate-900">← 返回选歌</button><h3 class="mt-3 text-xl font-black text-slate-900">${esc(title)}</h3><p class="mt-2 text-sm text-slate-500">正在打开这张榜…</p></div>`;
    return;
  }
  if (chartBoard.error) {
    board.innerHTML = `<div class="studio-box p-5"><button type="button" data-close-chart class="text-sm font-semibold text-slate-500 hover:text-slate-900">← 返回选歌</button><h3 class="mt-3 text-xl font-black text-slate-900">${esc(title)}</h3><p class="mt-2 text-sm text-slate-500">${esc(chartBoard.error)}</p></div>`;
    return;
  }
  const songs = chartBoard.songs || [];
  const visible = chartExpanded ? songs : songs.slice(0, 20);
  const more = songs.length > visible.length
    ? `<button type="button" data-chart-more class="rounded-xl bg-slate-100 px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-200">展开全部 ${songs.length} 首</button>`
    : "";
  board.innerHTML = `
    <div class="space-y-4">
      <div>
        <button type="button" data-close-chart class="text-sm font-semibold text-slate-500 hover:text-slate-900">← 返回选歌</button>
        <h3 class="mt-2 text-xl font-black text-slate-900 sm:text-2xl">${esc(chartBoard.platformLabel || "")} · ${esc(chartBoard.chartName || openChart.name || "")}</h3>
        <p class="mt-1.5 text-sm text-slate-500">当期 ${songs.length} 首。点歌可以试听，或带去作曲、对标写词。</p>
      </div>
      <div class="song-stack grid gap-3">${visible.map((song) => chartTrackCard(song)).join("") || `<p class="text-base text-slate-500">这张榜暂时没有歌。</p>`}</div>
      ${more}
    </div>`;
}

function coverHtml(song) {
  const box = "song-cover shrink-0 rounded-2xl bg-slate-100";
  if (!/^https?:\/\//i.test(song.coverUrl || "")) {
    return `<div class="${box} flex items-center justify-center text-xs text-slate-400">封面</div>`;
  }
  return `<img src="${esc(song.coverUrl)}" alt="" loading="lazy" decoding="async" class="${box} object-cover">`;
}

function chartLine(song) {
  const bits = [];
  for (const item of song.platforms || []) {
    for (const chart of item.charts || []) bits.push(`${item.label} ${chart.chartName} #${chart.rank}`);
  }
  for (const chart of song.charts || []) bits.push(`${song.platformLabel || ""} ${chart.chartName} #${chart.rank}`.trim());
  return bits.slice(0, 3).join(" · ");
}

function listenLink(song) {
  const icon = `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"></path></svg>`;
  if (!song.sourceUrl) {
    return `<span class="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm font-semibold text-slate-400">${icon}官方试听</span>`;
  }
  return `<a href="${esc(song.sourceUrl)}" target="_blank" rel="noreferrer" class="btn-audition">${icon}官方试听</a>`;
}

function fillButton(song) {
  return `<button type="button" data-fill="${esc(song.id)}" class="whitespace-nowrap rounded-xl bg-slate-100 py-2.5 text-sm font-bold text-slate-800 hover:bg-slate-200">填入作曲大师 →</button>`;
}

function favButton(song) {
  const loved = favorites.has(song.id);
  return `<button type="button" data-fav="${esc(song.id)}" aria-label="收藏" class="mt-0.5 h-9 w-9 shrink-0 rounded-full text-base leading-none ${loved ? "bg-rose-50 text-rose-500" : "bg-slate-50 text-slate-300"}">♥</button>`;
}

function songActions(song) {
  return `<div class="song-actions mt-1 grid grid-cols-2 gap-2 border-t border-slate-100 pt-3">
    ${fillButton(song)}
    <button type="button" data-lyric-song="${esc(song.id)}" class="whitespace-nowrap rounded-xl bg-slate-100 px-3 py-2.5 text-sm font-bold text-slate-700 hover:bg-orange-50 hover:text-orange-600">对标写词</button>
  </div>`;
}

function songShell(song, opts) {
  const extra = opts.extra ? `<p class="mt-1 line-clamp-2 text-sm leading-5 text-slate-500">${esc(opts.extra)}</p>` : "";
  const sub = opts.rankSub ? `<div class="mt-1 text-sm text-slate-400">${opts.rankSub}</div>` : "";
  const focus = song.id === focusSongId ? " is-focus" : "";
  return `<article class="song-card studio-box${focus}" data-song-card="${esc(song.id)}"><div class="song-layout">
    ${coverHtml(song)}
    <div class="song-body min-w-0">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap gap-1.5">${opts.badges}</div>
          <h3 class="mt-1 truncate text-lg font-bold text-slate-900 sm:text-xl">${esc(song.songName)}</h3>
          <p class="truncate text-sm text-slate-500 sm:text-base">${esc(song.singerName || "歌手待补")}</p>
        </div>
        <div class="flex shrink-0 items-start gap-1.5">
          <div class="rank-compact text-right leading-none">
            <div class="text-[10px] text-slate-400">${opts.rankLabel}</div>
            <div class="mt-1 text-lg font-bold text-slate-900">${opts.rankValue}</div>
          </div>
          ${favButton(song)}
        </div>
      </div>
      ${extra}
      <div class="mt-2.5">${listenLink(song)}</div>
    </div>
    <div class="song-rank text-right">
      <div class="text-sm text-slate-400">${opts.rankLabel}</div>
      <div class="text-4xl font-bold leading-none text-slate-900">${opts.rankValue}</div>
      ${sub}
    </div>
    ${songActions(song)}
  </div></article>`;
}

function newCard(song) {
  const badges = [
    song.isMultiPlatform ? `<span class="rounded-full bg-amber-100 px-2 py-0.5 text-sm text-amber-800">多平台</span>` : "",
    song.isDebut ? `<span class="rounded-full bg-emerald-100 px-2 py-0.5 text-sm text-emerald-800">七日首现</span>` : "",
    ...(song.platforms || []).map((item) => `<span class="rounded-full bg-slate-100 px-2 py-0.5 text-sm text-slate-600">${esc(item.label)}</span>`),
  ].join("");
  return songShell(song, { badges, rankLabel: "最好名次", rankValue: esc(song.bestRank), extra: chartLine(song) });
}

function risingCard(song) {
  const badges = `<span class="rounded-full bg-slate-100 px-2 py-0.5 text-sm text-slate-600">${esc(song.platformLabel)}</span><span class="font-semibold text-emerald-700">↑${esc(song.maxDelta)}</span>${song.chartCount > 1 ? `<span class="text-sm text-slate-500">同平台 ${esc(song.chartCount)} 榜</span>` : ""}`;
  const rankSub = song.bestRankOldest != null ? `七日前 #${esc(song.bestRankOldest)}` : "";
  return songShell(song, { badges, rankLabel: "现排名", rankValue: `#${esc(song.bestRankToday)}`, rankSub, extra: chartLine(song) });
}

function chartTrackCard(song) {
  const move = song.delta > 0
    ? `<span class="font-semibold text-emerald-700">↑${esc(song.delta)}</span>`
    : song.delta < 0
      ? `<span class="font-semibold text-rose-600">↓${esc(Math.abs(song.delta))}</span>`
      : "";
  const badges = `<span class="rounded-full bg-slate-100 px-2 py-0.5 text-sm text-slate-600">${esc(song.platformLabel || "")}</span>${song.isNew ? `<span class="rounded-full bg-emerald-100 px-2 py-0.5 text-sm text-emerald-800">新上榜</span>` : ""}${move}`;
  const rankSub = song.prevRank != null ? `上期 #${esc(song.prevRank)}` : "";
  return songShell(song, { badges, rankLabel: "名次", rankValue: `#${esc(song.rank)}`, rankSub });
}

function potentialCard(song) {
  const badges = (song.reasons || []).map((reason) => `<span class="rounded-full bg-amber-100 px-2 py-0.5 text-sm text-amber-800">${esc(reason)}</span>`).join("");
  return songShell(song, { badges, rankLabel: "潜力分", rankValue: esc(Math.round(song.score || 0)), extra: song.detail || "" });
}

async function sendHotToLyricDesk(id) {
  const song = songMap.get(id);
  if (!song) return;
  clearTimeout(lyricDeskTimer);
  const seq = ++lyricDeskSeq;
  $("lyric-title-input").value = song.songName;
  $("lyric-artist-input").value = song.singerName || "";
  if (!$("lyric-theme-input").value.trim()) $("lyric-theme-input").value = song.songName;
  switchWorkspace("lyric");
  switchLyricTab("editor");
  showLyricSource("", "正在搜索原词…");
  const found = await requestLyrics(song.songName, song.singerName);
  if (seq !== lyricDeskSeq) return;
  showLyricSource(found.lyrics, found.lyrics ? "原词来自网络搜索。" : "没搜到这首歌的原词。");
  if (!found.lyrics) {
    toast(`没搜到《${song.songName}》的原词`);
    return;
  }
  rememberComposerLyrics(song.songName, song.singerName, found.lyrics);
  const filled = adoptOriginalLyric(found.lyrics);
  toast(filled ? `已带《${song.songName}》的原词，仍保持原词作者风格` : `已显示《${song.songName}》的原词`);
}

function toggleFavorite(id) {
  if (favorites.has(id)) favorites.delete(id);
  else favorites.add(id);
  localStorage.setItem(favKey, JSON.stringify([...favorites]));
  renderDispatch();
  toast(favorites.has(id) ? "已加入收藏" : "已取消收藏");
}

function sendHotToComposer(id) {
  const song = songMap.get(id);
  if (!song) return;
  $("ref-song").value = song.songName;
  $("ref-artist").value = song.singerName;
  scheduleSourceLyrics();
  switchWorkspace("composer");
  refreshAnalyzeHint();
  markAnalyzePending();
  toast(`已带入《${song.songName}》。点「分析这首歌的提示词」重写右边`);
}

function refreshAnalyzeHint() {
  const song = $("ref-song").value.trim();
  const artist = $("ref-artist").value.trim();
  if (audioPayload && composerMode !== "tags") {
    const name = song ? `《${song}》` : "这段录音";
    const who = artist ? `${name} · ${artist}` : name;
    $("analyze-hint").textContent = `已改成上传的文件：${who}。分析和试听都按这个文件。`;
    return;
  }
  $("analyze-hint").textContent = song
    ? `已填入《${song}》。右边 Style 还是默认标签，点上面按这首歌重写。`
    : "从选歌带入后点这里。按这首歌重写右边 Style，不沿用左边默认标签。";
}

function markAnalyzePending() {
  $("analyze-song").classList.add("attn");
  $("analyze-song-side").classList.add("attn");
}

function clearAnalyzePending() {
  $("analyze-song").classList.remove("attn");
  $("analyze-song-side").classList.remove("attn");
}

async function analyzeReferenceSong() {
  if (audioReading) {
    toast("录音还在读取");
    return;
  }
  const hasAudio = composerMode !== "tags" && Boolean(audioPayload);
  const song = $("ref-song").value.trim();
  if (!song && !hasAudio) {
    toast("先从选歌大师带入一首歌，或上传录音");
    switchWorkspace("composer");
    $("ref-song").focus();
    return;
  }
  const directions = [...document.querySelectorAll("[data-direction].active")].map((btn) => btn.dataset.direction);
  const basis = hasAudio
    ? "只按上传录音里实际听到的声音写提示词，不要改用同名原曲的印象，也不要套用页面上预先点亮的默认标签"
    : "只按这首参考歌本身的公开听感写提示词，不要套用页面上预先点亮的默认标签";
  await runGenerate({
    song,
    artist: $("ref-artist").value.trim(),
    direction: [...directions, basis].join("，"),
    lyrics: $("keep-lyrics").checked ? newLyricText() : "",
    audio: hasAudio ? audioPayload : undefined,
    clearStyle: true,
    buttons: [$("analyze-song"), $("analyze-song-side")],
    busyLabel: "分析中",
    idleLabel: "分析这首歌的提示词",
    working: hasAudio ? `正在听上传的${song ? `《${song}》` : "录音"}…` : `正在按《${song}》的听感写提示词…`,
    done: hasAudio ? "已按上传的录音写好提示词" : "已按这首歌写好右边的提示词",
  });
}

function switchComposerMode(mode) {
  composerMode = mode;
  document.querySelectorAll(".mode-btn").forEach((btn) => {
    const on = btn.dataset.mode === mode;
    btn.className = `mode-btn rounded-md px-1 py-1.5 text-center sm:px-2.5 sm:py-1 ${on ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`;
  });
  $("section-audio-upload").classList.toggle("hidden", mode === "tags");
  $("section-tag-matrix").classList.toggle("hidden", mode === "audio");
  refreshAnalyzeHint();
}

function tagText(btn) {
  return btn.textContent.replace(/\s+/g, " ").trim();
}

function toggleTag(btn) {
  const tag = tagText(btn);
  if (selectedTags.has(tag)) {
    selectedTags.delete(tag);
    btn.classList.remove("active");
  } else {
    selectedTags.add(tag);
    btn.classList.add("active");
  }
  if (styleSource === "model") toast("已改回标签拼装");
  styleSource = "tags";
  syncStyleFromTags();
}

function syncStyleFromTags() {
  if (styleSource !== "tags") return;
  $("style-text-content").value = [...selectedTags].join(", ");
  updatePromptCounts();
}

function clearComposerStyle() {
  styleSource = "model";
  $("style-text-content").value = "";
  updatePromptCounts();
  const song = $("ref-song").value.trim();
  $("analyze-hint").textContent = song
    ? `正在按《${song}》重写 Style。右边先清空，避免把默认标签当成这首歌。`
    : "右边 Style 已清空。";
}

function toggleDirection(btn) {
  const value = btn.dataset.direction;
  const on = !btn.classList.contains("active");
  btn.classList.toggle("active", on);
  if (!on) return;
  for (const other of CLASHES[value] || []) {
    const node = document.querySelector(`[data-direction="${other}"]`);
    if (node) node.classList.remove("active");
  }
}

async function onAudio() {
  const file = $("audio-file").files && $("audio-file").files[0];
  if (!file) return;
  if (file.size > 18 * 1024 * 1024) {
    toast("录音请小于 18MB");
    $("audio-file").value = "";
    return;
  }
  if (settings.provider === "bailian") {
    toast("听录音只能用 Gemini，已切回 Gemini");
    settings.provider = "gemini";
    reflectEngine();
  }
  stopAllAuditions();
  audioPayload = null;
  audioReading = true;
  $("audio-label").textContent = "正在读取录音…";
  $("audio-result-pill").classList.add("hidden");
  try {
    const tags = await readTrackTags(file);
    $("ref-song").value = tags.title;
    $("ref-artist").value = tags.artist;
    audioPayload = await readAudioFile(file);
    scheduleSourceLyrics();
    if (referenceAudioUrl) URL.revokeObjectURL(referenceAudioUrl);
    referenceAudioUrl = URL.createObjectURL(file);
    $("audio-label").textContent = `${file.name} · ${Math.ceil(file.size / 1024)} KB`;
    $("audio-file-name").textContent = [tags.title, tags.artist].filter(Boolean).join(" · ") || file.name;
    $("audio-detected").textContent = tags.fromTags
      ? "歌名和歌手已按文件标签更新。试听播放的就是这个文件，分析也只听这段录音。"
      : "这个文件没有标签，歌名用了文件名，原来的歌手已清掉。试听播放的就是这个文件。";
    $("audio-result-pill").classList.remove("hidden");
    refreshAnalyzeHint();
  } catch (error) {
    audioPayload = null;
    toast(error.message || "读不了这个音频");
  } finally {
    audioReading = false;
  }
}

async function generatePackage() {
  if (audioReading) {
    toast("录音还在读取");
    return;
  }
  const song = $("ref-song").value.trim();
  const fileMode = composerMode !== "tags";
  if (fileMode && composerMode === "audio" && !audioPayload) {
    toast("纯音频需要先上传录音");
    return;
  }
  if (!song && !audioPayload) {
    $("ref-song").value = "原创";
  }
  const direction = [
    ...[...document.querySelectorAll("[data-direction].active")].map((btn) => btn.dataset.direction),
    ...selectedTags,
  ].join("，");
  await runGenerate({
    song: $("ref-song").value.trim(),
    artist: $("ref-artist").value.trim(),
    direction,
    lyrics: $("keep-lyrics").checked ? newLyricText() : "",
    audio: fileMode ? audioPayload || undefined : undefined,
    buttons: [$("compose-btn")],
    busyLabel: "生成中",
    idleLabel: "生成灵感配方",
    working: fileMode && audioPayload ? "正在听上传的录音，请稍候…" : "正在听编制、语种和动态，请稍候…",
    done: fileMode && audioPayload ? "已按上传的录音写好配方" : "配方已生成",
  });
}

async function runGenerate({ song, artist, direction, lyrics, audio, buttons, busyLabel, idleLabel, working, done, clearStyle, fromAssistant, keepTitle }) {
  if (busy && !fromAssistant) return;
  await ensureComposerLyrics();
  if (!fromAssistant && !checkAndDeduct(10)) return;
  if (clearStyle) clearComposerStyle();
  if (!fromAssistant) busy = true;
  clearAnalyzePending();
  const lock = [$("compose-btn"), $("analyze-song"), $("analyze-song-side")];
  for (const button of lock) button.disabled = true;
  for (const button of buttons) button.textContent = busyLabel;
  $("compose-working").textContent = working;
  $("compose-working").classList.remove("hidden");
  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        song,
        artist,
        direction,
        lyrics,
        audio,
        knownLyrics: lyricPair.source,
        ...enginePayload(),
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "生成失败");
    showPackage(data.result, { keepTitle });
    highlightTags(data.result);
    refreshAnalyzeHint();
    if (audio) $("analyze-hint").textContent = song ? `已按上传的《${song}》写好提示词。` : "已按上传的录音写好提示词。";
    else $("analyze-hint").textContent = song ? `已按《${song}》写好右边的提示词。` : "配方已写入右边。";
    toast(done);
  } catch (error) {
    if (!fromAssistant) refund(10);
    toast(error.message || "生成失败");
    if (fromAssistant) throw error;
  } finally {
    if (!fromAssistant) busy = false;
    for (const button of buttons) button.textContent = idleLabel;
    for (const button of [$("compose-btn"), $("analyze-song"), $("analyze-song-side")]) button.disabled = false;
    $("compose-working").classList.add("hidden");
    $("compose-working").textContent = "正在听编制、语种和动态，请稍候…";
  }
}

function showPackage(result, options = {}) {
  styleSource = "model";
  $("package-title").textContent = result.title || "未命名";
  $("style-text-content").value = result.style || "";
  $("exclude-text-content").value = result.exclude || "";
  $("simple-mode-content").value = result.simple || "";
  lyricPair.next = result.lyrics || "";
  paintLyricView(lyricPair.next ? "next" : "source");
  $("composer-notes").textContent = result.notes || "";
  if (result.title && !options.keepTitle) $("lyric-title-input").value = result.title;
  updatePromptCounts();
}

async function rewriteNextLyric() {
  if (busy) return;
  await ensureComposerLyrics();
  if (lyricView === "next") lyricPair.next = $("composer-lyrics-rich").value;
  const style = $("style-text-content").value.trim();
  const source = String(lyricPair.source || "").trim();
  if (!style && !source) {
    toast("先分析这首歌");
    return;
  }
  if (!checkAndDeduct(10)) return;
  busy = true;
  const button = $("rewrite-lyric");
  button.disabled = true;
  button.textContent = "写作中";
  $("compose-working").textContent = "正在按曲风和原词再写一版…";
  $("compose-working").classList.remove("hidden");
  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lyricOnly: true,
        song: $("ref-song").value.trim(),
        style,
        exclude: $("exclude-text-content").value.trim(),
        sourceLyrics: source,
        previous: lyricPair.next,
        ...enginePayload(),
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "没有写成");
    lyricPair.next = data.result?.lyrics || "";
    if (!lyricPair.next) throw new Error("没有写成");
    paintLyricView("next");
    toast("已换一版新词");
  } catch (error) {
    refund(10);
    toast(error.message || "没有写成");
  } finally {
    busy = false;
    button.disabled = false;
    button.textContent = "换一首";
    $("compose-working").classList.add("hidden");
    $("compose-working").textContent = "正在听编制、语种和动态，请稍候…";
  }
}

function newLyricText() {
  if (lyricView === "next") lyricPair.next = $("composer-lyrics-rich").value;
  return String(lyricPair.next || "").trim();
}

function setLyricView(view) {
  lyricPair[lyricView] = $("composer-lyrics-rich").value;
  if (lyricView === "source") lyricPair.sourceEdited = true;
  paintLyricView(view === "source" ? "source" : "next");
}

function paintLyricView(view) {
  lyricView = view === "source" ? "source" : "next";
  $("composer-lyrics-rich").value = lyricPair[lyricView] || "";
  document.querySelectorAll("[data-lyric-view]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.lyricView === lyricView);
  });
  const hint = $("lyric-view-hint");
  if (hint) hint.textContent = lyricView === "source" ? sourceHint() : "新词按曲风和原词重填。原词用来对照。";
}

function sourceHint() {
  if (lyricPair.state === "loading" && !lyricPair.source) return "正在搜索原词…";
  if (lyricPair.source) return lyricPair.note || "原词来自网络搜索，用来对照。";
  if (lyricPair.state === "miss") return lyricPair.note || "没搜到这首歌的原词。";
  return "填入歌名和歌手后，这里显示搜到的原词。";
}

function scheduleSourceLyrics() {
  const song = $("ref-song").value.trim();
  const artist = $("ref-artist").value.trim();
  const key = `${song}\n${artist}`;
  if (key !== composerLyricKey) {
    composerLyricKey = key;
    lyricPair.sourceEdited = false;
    lyricPair.source = "";
    lyricPair.note = "";
    lyricPair.state = song && song !== "原创" ? "loading" : "";
    if (lyricView === "source") paintLyricView("source");
  }
  clearTimeout(lyricLookupTimer);
  lyricLookupTimer = setTimeout(() => { loadComposerLyrics(); }, 400);
}

async function ensureComposerLyrics() {
  clearTimeout(lyricLookupTimer);
  await loadComposerLyrics();
}

async function loadComposerLyrics() {
  const song = $("ref-song").value.trim();
  const artist = $("ref-artist").value.trim();
  const key = `${song}\n${artist}`;
  composerLyricKey = key;
  if (!song || song === "原创") {
    lyricPair.state = "";
    if (!lyricPair.sourceEdited) {
      lyricPair.source = "";
      lyricPair.note = "";
    }
    if (lyricView === "source") paintLyricView("source");
    return;
  }
  const seq = ++lyricLookupSeq;
  if (!lyricPair.sourceEdited) lyricPair.state = lyricPair.source ? lyricPair.state : "loading";
  try {
    const found = await requestLyrics(song, artist);
    if (seq !== lyricLookupSeq || composerLyricKey !== key || lyricPair.sourceEdited) return;
    lyricPair.source = found.lyrics;
    lyricPair.state = found.lyrics ? "ready" : "miss";
    lyricPair.note = found.lyrics ? "原词来自网络搜索，用来对照。" : "没搜到这首歌的原词。";
    paintLyricView(lyricPair.next ? lyricView : "source");
  } catch {
    if (seq !== lyricLookupSeq || composerLyricKey !== key) return;
    lyricPair.state = "miss";
    lyricPair.note = "原词搜索失败，请再试一次。";
    if (lyricView === "source") paintLyricView("source");
  }
}

function rememberComposerLyrics(song, artist, lyrics) {
  const key = `${String(song || "").trim()}\n${String(artist || "").trim()}`;
  composerLyricKey = key;
  lyricPair.sourceEdited = false;
  lyricPair.source = lyrics;
  lyricPair.state = "ready";
  lyricPair.note = "原词来自网络搜索，用来对照。";
  if (!lyricPair.next) paintLyricView("source");
  else if (lyricView === "source") paintLyricView("source");
}

function scheduleLyricDeskLyrics() {
  clearTimeout(lyricDeskTimer);
  lyricDeskTimer = setTimeout(() => { loadLyricDeskLyrics(); }, 400);
}

async function loadLyricDeskLyrics() {
  const song = $("lyric-title-input").value.trim();
  const artist = $("lyric-artist-input").value.trim();
  if (!song) {
    showLyricSource("", "");
    return;
  }
  const seq = ++lyricDeskSeq;
  showLyricSource("", "正在搜索原词…");
  $("lyric-source-box").classList.remove("hidden");
  try {
    const found = await requestLyrics(song, artist);
    if (seq !== lyricDeskSeq) return;
    if ($("lyric-title-input").value.trim() !== song || $("lyric-artist-input").value.trim() !== artist) return;
    showLyricSource(found.lyrics, found.lyrics ? "原词来自网络搜索。" : "没搜到这首歌的原词。");
  } catch {
    if (seq !== lyricDeskSeq) return;
    showLyricSource("", "原词搜索失败，请再试一次。");
  }
}

function showLyricSource(text, note) {
  const box = $("lyric-source-box");
  const view = $("lyric-source-view");
  if (!box || !view) return;
  view.value = text || "";
  const noteNode = $("lyric-source-note");
  if (noteNode) noteNode.textContent = text || note ? (note || "") : "";
  box.classList.toggle("hidden", !text && !note);
}

function adoptOriginalLyric(text) {
  const editor = $("lyric-main-editor");
  if (editor.value.trim()) return false;
  editor.value = text;
  lyricState.committed = text;
  lyricState.brought = sungLines(text).length > 0;
  lyricState.draft = false;
  paintSpark();
  paintRollback();
  return true;
}

async function requestLyrics(song, artist) {
  const key = `${String(song || "").trim()}\n${String(artist || "").trim()}`;
  if (lyricCache.has(key)) return lyricCache.get(key);
  const response = await fetch(`/api/lyrics?song=${encodeURIComponent(song)}&artist=${encodeURIComponent(artist)}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "原词没搜到");
  const found = { lyrics: String(data.lyrics || "").trim(), matched: String(data.matched || "").trim() };
  lyricCache.set(key, found);
  if (lyricCache.size > 30) lyricCache.delete(lyricCache.keys().next().value);
  return found;
}

function highlightTags(result) {
  const style = typeof result === "string" ? result : (result?.style || "");
  const fromModel = tagsFromResult(typeof result === "object" && result ? result : null);
  const fromStyle = tagsFromStyle(style);
  const grouped = {};
  for (const group of ["genre", "vocal", "instruments", "mood"]) {
    grouped[group] = fromModel[group].length ? fromModel[group] : fromStyle[group];
  }
  selectedTags.clear();
  document.querySelectorAll("[data-tag]").forEach((btn) => btn.classList.remove("active"));
  for (const group of ["genre", "vocal", "instruments", "mood"]) {
    for (const label of grouped[group]) {
      const btn = ensureTagChip(group, label);
      if (!btn) continue;
      btn.classList.add("active");
      selectedTags.add(tagText(btn));
    }
  }
}

function tagsFromResult(result) {
  const raw = result?.tags;
  const empty = { genre: [], vocal: [], instruments: [], mood: [] };
  if (!raw || typeof raw !== "object") return empty;
  return {
    genre: cleanTagList(raw.genre),
    vocal: cleanTagList(raw.vocal),
    instruments: cleanTagList(raw.instruments || raw.instrument),
    mood: cleanTagList(raw.mood),
  };
}

function tagsFromStyle(style) {
  const grouped = { genre: [], vocal: [], instruments: [], mood: [] };
  for (const part of String(style || "").split(/[,，]/)) {
    const text = part.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const group = classifyStylePhrase(text);
    if (!grouped[group].some((item) => item.toLowerCase() === text.toLowerCase())) {
      grouped[group].push(text);
    }
  }
  for (const group of Object.keys(grouped)) grouped[group] = grouped[group].slice(0, 8);
  return grouped;
}

function classifyStylePhrase(text) {
  const scores = { genre: 0, vocal: 0, instruments: 0, mood: 0 };
  if (/\b\d+\s*bpm\b/i.test(text)) scores.mood += 4;
  if (/(guitar|piano|keys|keyboard|drum|bass|string|violin|cello|viola|guzheng|erhu|pipa|flute|dizi|sax|synth|organ|percussion|snare|hi-hat|brass|trumpet|horn|harp|ukulele|rhodes|pad\b|shaker|guqin|suona|yangqin|banjo|accordion|harmonica|marimba|kalimba|oud|sitar)/i.test(text)) scores.instruments += 3;
  if (/(vocal|vocals|voice|sung|singing|male|female|choir|raspy|breathy|falsetto|tenor|alto|soprano|baritone|whisper|harmony|vibrato|belting|singer)/i.test(text)) scores.vocal += 3;
  if (/(pop|ballad|r&b|rnb|rock|jazz|folk|hip[\s-]?hop|trap|edm|house|cantopop|mandopop|soul|funk|disco|indie|electronic|blues|country|metal|punk|reggae|bossa|latin|k-pop|j-pop|ambient|orchestral|cinematic|future bass|synthwave|boom bap|gospel|phonk|afrobeats|reggaeton|techno|trance|dubstep|lo-fi|lofi|dancehall)/i.test(text)) scores.genre += 3;
  if (/(nostalgic|heartfelt|melanchol|dreamy|intimate|reflective|warm|dark|bright|emotional|uplifting|somber|bittersweet|groovy|laid-back|tender|longing|wistful|mellow|energetic|sparse|lush|raw|polished|vintage|tape|studio|wide|gentle|soft)/i.test(text)) scores.mood += 2;
  let best = "mood";
  let bestScore = 0;
  for (const group of ["instruments", "vocal", "genre", "mood"]) {
    if (scores[group] > bestScore) {
      best = group;
      bestScore = scores[group];
    }
  }
  return best;
}

function cleanTagList(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(/[,，]/);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const text = String(item || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 48 || text.split(" ").length > 8) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= 8) break;
  }
  return out;
}

function ensureTagChip(group, label) {
  const text = String(label || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 48 || text.split(" ").length > 8) return null;
  const found = [...document.querySelectorAll("[data-tag]")].find((btn) => tagText(btn).toLowerCase() === text.toLowerCase());
  if (found) return found;
  const host = document.querySelector(`#section-tag-matrix [data-tags="${group}"]`);
  if (!host) return null;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tag-chip";
  btn.dataset.tag = "";
  btn.textContent = text;
  btn.addEventListener("click", () => toggleTag(btn));
  host.appendChild(btn);
  return btn;
}

function handoffToLyric() {
  const text = newLyricText();
  if (text) {
    clearTimeout(lyricState.editTimer);
    const editor = $("lyric-main-editor");
    if (editor.value !== text) {
      flushLyricHistory();
      rememberRevision(editor.value);
      editor.value = text;
      lyricState.committed = text;
    }
    lyricState.brought = sungLines(text).length > 0;
    lyricState.draft = false;
  }
  const title = $("package-title").textContent.trim();
  if (title && title !== "还没有生成") $("lyric-title-input").value = title;
  paintRollback();
  paintSpark();
  clearTimeout(lyricDeskTimer);
  lyricDeskSeq += 1;
  if (lyricPair.source) showLyricSource(lyricPair.source, "原词来自网络搜索，用来对照。");
  switchWorkspace("lyric");
  switchLyricTab("editor");
  setLyricMode("edit");
  toast(text ? "歌词已带到作词大师" : "已打开作词大师");
}

function pushLyricToComposer() {
  const text = $("lyric-main-editor").value;
  lyricPair.next = text;
  if (lyricView !== "source") $("composer-lyrics-rich").value = text;
  const title = $("lyric-title-input").value.trim();
  if (title) $("package-title").textContent = title;
}

function onLyricInput() {
  const lines = sungLines($("lyric-main-editor").value);
  if (!lines.length) {
    lyricState.brought = false;
    lyricState.draft = false;
  } else if (lyricState.draft && !isGoldenDraft()) lyricState.draft = false;
  paintSpark();
  pushLyricToComposer();
  clearTimeout(lyricState.editTimer);
  lyricState.editTimer = setTimeout(() => {
    flushLyricHistory();
    paintRollback();
  }, 700);
  paintRollback();
}

function flushLyricHistory() {
  const current = $("lyric-main-editor").value;
  if (current === lyricState.committed) return false;
  rememberRevision(lyricState.committed);
  lyricState.committed = current;
  return true;
}

function paintRollback() {
  const button = $("lyric-rollback");
  if (!button) return;
  const pending = $("lyric-main-editor").value !== lyricState.committed;
  button.disabled = !lyricState.versions.length && !pending;
}

async function loadLyric() {
  try {
    const [skills, controls, tongues, chart, written] = await Promise.all([
      fetch("/api/lyric/skills").then((r) => r.json()),
      fetch("/api/lyric/controls").then((r) => r.json()),
      fetch("/api/lyric/tongues").then((r) => r.json()).catch(() => null),
      fetch("/chart-lyricists.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/lyric-written.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (skills.error) throw new Error(skills.error);
    lyricState.skills = Array.isArray(skills) ? skills : [];
    lyricState.chartLyricists = Array.isArray(chart?.list) ? chart.list : [];
    lyricState.written = written?.byName && typeof written.byName === "object" ? written.byName : {};
    lyricState.controls = controls;
    lyricState.tongues = Array.isArray(tongues) ? tongues : [];
    lyricState.skillId = "";
    fillOriginalControls();
    renderLyricists();
  } catch (error) {
    $("lyricist-list").innerHTML = `<p class="text-[11px] text-slate-400 px-1">${esc(error.message || "词库还在加载")}</p>`;
  }
}

function tongueChoices() {
  const loaded = lyricState.tongues.filter((item) => item && (item.id === "cmn" || item.id === "yue"));
  return loaded.length ? loaded : [
    { id: "cmn", name: "国语" },
    { id: "yue", name: "粤语" },
  ];
}

function skillTongue(skill) {
  if (skill && (skill.tongue === "yue" || skill.tongue === "cmn")) return skill.tongue;
  if (skill && String(skill.group || "").includes("粤")) return "yue";
  return "cmn";
}

function defaultTightness(id) {
  return id === "yue" ? "strict" : "wide";
}

function craftHint() {
  const tongue = lyricState.tongue === "yue" ? "yue" : "cmn";
  const strict = lyricState.tightness === "strict";
  const skill = lyricState.skills.find((item) => item.id === lyricState.skillId);
  const native = skill ? skillTongue(skill) : "";
  const lead = skill && native !== tongue
    ? `${skill.name}惯写${native === "yue" ? "粤语" : "国语"}。这首按${tongue === "yue" ? "粤语" : "国语"}押。`
    : "";
  const rule = tongue === "yue"
    ? (strict
      ? "粤语按粤音韵母押严：韵腹和韵尾都要一致，-m、-n、-ng 各押各的。"
      : "粤语按粤音韵母押宽：韵尾相同即可，韵腹长短可以通。")
    : (strict
      ? "国语押严：韵母要一致。in 不跟 en，ang 不跟 eng。"
      : "国语按十三辙押宽：同辙即可。心和深都算人辰。");
  const spoken = lyricState.register === "spoken";
  const voice = spoken && tongue === "yue"
    ? "语体是口语：可以写唔、咗、佢、嘅、啲、冇、喺。"
    : spoken
      ? "语体是口语：用普通话白话，像说话。"
      : tongue === "yue"
        ? "语体是书面：不要写唔、咗、佢、嘅、啲、冇、喺。"
        : "语体是书面：用能唱的书面语。";
  return lead + rule + voice;
}

function paintCraft(resetRhyme) {
  const tongue = lyricState.tongue === "yue" ? "yue" : "cmn";
  lyricState.tongue = tongue;
  if (lyricState.tightness !== "strict" && lyricState.tightness !== "wide") {
    lyricState.tightness = defaultTightness(tongue);
  }
  if (lyricState.register !== "spoken" && lyricState.register !== "written") {
    lyricState.register = "written";
  }
  const tightness = lyricState.controls?.tightness?.length
    ? lyricState.controls.tightness
    : [{ id: "wide", name: "宽" }, { id: "strict", name: "严" }];
  const named = lyricState.controls?.registers || [];
  const registers = [
    { id: "spoken", name: "口语" },
    { id: "written", name: "书面" },
  ].map((item) => named.find((row) => row.id === item.id) || item);
  $("lyric-tongue").innerHTML = tongueChoices().map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("");
  $("lyric-tongue").value = tongue;
  $("lyric-tightness").innerHTML = tightness.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("");
  $("lyric-tightness").value = lyricState.tightness;
  $("lyric-register").innerHTML = registers.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("");
  $("lyric-register").value = lyricState.register;
  const rhymes = lyricState.controls?.rhymes?.[tongue] || [];
  const rhyme = $("lyric-rhyme");
  const previous = resetRhyme ? "follow" : (rhyme.value || "follow");
  rhyme.innerHTML = rhymes.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("");
  rhyme.value = rhymes.some((item) => item.id === previous) ? previous : (rhymes[0]?.id || "");
  $("rhyme-label").textContent = tongue === "yue" ? "粤语韵脚" : "十三辙韵脚";
  $("lyric-tongue-hint").textContent = craftHint();
}

function applyTongue(id) {
  lyricState.tongue = id === "yue" ? "yue" : "cmn";
  lyricState.tightness = defaultTightness(lyricState.tongue);
  paintCraft(true);
}

function adoptCraft(data) {
  if (!data) return;
  if (data.tongue === "yue" || data.tongue === "cmn") lyricState.tongue = data.tongue;
  if (data.tightness === "strict" || data.tightness === "wide") lyricState.tightness = data.tightness;
  if (data.register === "spoken" || data.register === "written") lyricState.register = data.register;
  paintCraft(false);
  if (data.skillId && data.skillId !== lyricState.skillId) {
    const skill = lyricState.skills.find((item) => item.id === data.skillId);
    if (skill) {
      lyricState.skillId = skill.id;
      fillSkillStyles(skill.styles, data.styleId);
      renderLyricists();
    }
  }
  if (data.rhymeId && [...$("lyric-rhyme").options].some((item) => item.value === data.rhymeId)) {
    $("lyric-rhyme").value = data.rhymeId;
  }
}

function fillOriginalControls() {
  $("lyric-style").innerHTML = `<option value="">原词曲风</option>`;
  paintCraft(false);
}

function selectSkill(id, announce) {
  if (!id || id === "original") {
    lyricState.skillId = "";
    fillOriginalControls();
    renderLyricists();
    if (announce) toast("已回到原词作者风格");
    return;
  }
  const skill = lyricState.skills.find((item) => item.id === id);
  if (!skill) return;
  const changed = lyricState.skillId !== id;
  lyricState.skillId = id;
  fillSkillStyles(skill.styles, "all");
  if (changed) applyTongue(skillTongue(skill));
  else paintCraft(false);
  renderLyricists();
  if (announce) toast(`已选定${skill.name}`);
}

function styleRows(styles) {
  const rows = Array.isArray(styles) ? styles.filter((item) => item && item.id) : [];
  if (rows.length && !rows.some((item) => item.id === "all")) {
    rows.unshift({ id: "all", name: "全部风格" });
  }
  return rows;
}

function fillSkillStyles(styles, preferred) {
  const rows = styleRows(styles);
  const select = $("lyric-style");
  select.innerHTML = rows.map((style) => `<option value="${esc(style.id)}">${esc(style.name)}</option>`).join("");
  const want = preferred && rows.some((item) => item.id === preferred) ? preferred : "all";
  if ([...select.options].some((item) => item.value === want)) select.value = want;
}

function foldFind(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, "");
}

function markHit(value, query) {
  const text = String(value || "");
  const needle = String(query || "").trim();
  const safe = esc(text);
  if (!needle) return safe;
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return safe;
  return `${esc(text.slice(0, at))}<mark>${esc(text.slice(at, at + needle.length))}</mark>${esc(text.slice(at + needle.length))}`;
}

function skillByName(name) {
  const key = foldFind(name);
  return lyricState.skills.find((skill) => foldFind(skill.name) === key) || null;
}

function writtenCount(name, fallback) {
  const stored = lyricState.written?.[name];
  return stored || fallback || 0;
}

function lyricistRoster() {
  const seen = new Set();
  const rows = lyricState.chartLyricists.map((person) => {
    const songs = person.songs || [];
    seen.add(foldFind(person.name));
    return {
      person: { ...person, count: writtenCount(person.name, person.count || songs.length) },
      songs,
    };
  });
  for (const skill of lyricState.skills) {
    const key = foldFind(skill.name);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      person: { name: skill.name, count: writtenCount(skill.name, skill.corpusCount || 0), songs: [] },
      songs: [],
    });
  }
  rows.sort((a, b) => (b.person.count - a.person.count) || String(a.person.name).localeCompare(String(b.person.name), "zh"));
  return rows;
}

function visibleLyricists() {
  const roster = lyricistRoster();
  const needle = foldFind(lyricState.lyricistQuery);
  if (!needle) return roster;
  const rows = [];
  for (const row of roster) {
    const songs = row.songs || [];
    if (foldFind(row.person.name).includes(needle)) {
      rows.push(row);
      continue;
    }
    const matched = songs.filter((song) => foldFind(song.title).includes(needle));
    if (matched.length) rows.push({ person: row.person, songs: matched });
  }
  return rows;
}

function lyricistSongsHtml(name, songs, query) {
  const all = songs || [];
  if (!all.length) return "";
  const open = lyricState.expandedLyricists.has(name);
  const shown = open ? all : all.slice(0, 3);
  const songHtml = shown.map((song) => `<p class="lyricist-song">${markHit(song.title, query)} · ${esc(song.artist || "")}</p>`).join("");
  const toggle = all.length > 3
    ? `<button type="button" data-lyricist-more="${esc(name)}" class="lyricist-more">${open ? "收起" : "展开全部"}</button>`
    : "";
  return `<div class="lyricist-songs">${songHtml}${toggle}</div>`;
}

function renderLyricists(resetScroll) {
  const list = $("lyricist-list");
  const scroll = resetScroll ? 0 : list.scrollTop;
  const query = String(lyricState.lyricistQuery || "").trim();
  const original = `<div class="lyricist-card px-2.5 py-1.5 rounded-lg ${lyricState.skillId ? "" : "active"}" data-pick-skill="original">
      <span class="text-[13px] font-bold text-slate-900 leading-tight">原词作者风格</span>
      <p class="lyricist-summary text-xs text-slate-500 leading-snug mt-0.5">不换词人。改词时保持这首歌现在的口吻。</p>
    </div>`;
  if (!lyricState.chartLyricists.length) {
    const count = $("lyricist-count");
    if (count) count.textContent = lyricState.skills.length ? `${lyricState.skills.length} 位已提炼写法` : "";
    list.innerHTML = original + lyricState.skills.map((skill) => {
      const ready = skill.status === "ready" && skill.styles?.length;
      const active = skill.id === lyricState.skillId ? "active" : "";
      return `<div class="lyricist-card px-2.5 py-1.5 rounded-lg ${active}" data-pick-skill="${esc(skill.id)}">
        <span class="text-[13px] font-bold text-slate-900 leading-tight">${esc(skill.name)}</span>
        <p class="lyricist-summary text-xs text-slate-500 leading-snug mt-0.5">${esc(skill.summary || skill.group || "")}</p>
        ${ready ? `<button type="button" data-restyle="${esc(skill.id)}" class="mt-0.5 text-xs text-orange-600 font-bold leading-tight hover:underline">按此词人风格重构 →</button>` : `<p class="mt-0.5 text-xs text-slate-400 leading-tight">写法还没提炼完</p>`}
      </div>`;
    }).join("");
    list.scrollTop = scroll;
    return;
  }
  const rows = visibleLyricists();
  const count = $("lyricist-count");
  if (count) {
    count.textContent = query
      ? `找到 ${rows.length} 位`
      : `${lyricistRoster().length} 位，按做词歌曲数`;
  }
  const cards = rows.map(({ person, songs }) => {
    const skill = skillByName(person.name);
    const ready = skill && skill.status === "ready" && skill.styles?.length;
    const active = skill && skill.id === lyricState.skillId ? "active" : "";
    const pick = skill ? ` data-pick-skill="${esc(skill.id)}"` : "";
    return `<div class="lyricist-card${skill ? "" : " catalog"} px-2.5 py-1.5 rounded-lg ${active}"${pick}>
      <div class="flex items-baseline justify-between gap-2">
        <span class="text-[13px] font-bold text-slate-900 leading-tight">${markHit(person.name, query)}</span>
        <span class="shrink-0 text-[11px] text-slate-400">${person.count || songs.length} 首</span>
      </div>
      ${skill?.summary ? `<p class="lyricist-summary text-xs text-slate-500 leading-snug mt-0.5">${esc(skill.summary)}</p>` : ""}
      ${lyricistSongsHtml(person.name, songs, query)}
      ${ready ? `<button type="button" data-restyle="${esc(skill.id)}" class="mt-0.5 text-xs text-orange-600 font-bold leading-tight hover:underline">按此词人风格重构 →</button>` : ""}
    </div>`;
  }).join("");
  const empty = query && !rows.length ? `<p class="text-[11px] text-slate-400 px-1">没有这位词作者，也没有这首歌。</p>` : "";
  list.innerHTML = original + cards + empty;
  list.scrollTop = scroll;
}

async function restyleWithSkill(id) {
  selectSkill(id, false);
  if (busy) return;
  if (!checkAndDeduct(10)) return;
  const skill = lyricState.skills.find((item) => item.id === id);
  const name = skill?.name || "这位词作者";
  const current = $("lyric-main-editor").value.trim();
  const message = current ? `用${name}的笔法改左边这首。` : `用${name}的笔法写一首。`;
  busy = true;
  pushChat("user", `按${name}的风格重构`);
  lyricState.history.push({ role: "user", content: message });
  const pending = pushChat("assistant", "正在写。");
  try {
    const data = await lyricPost("/api/lyric/chat", craftPayload({
      message,
      lyric: toLyricMaster(current),
      history: lyricState.history.slice(-8),
    }));
    adoptCraft(data);
    if (data.lyric) applyLyric(data);
    const reply = data.reply || "";
    fillChat(pending, reply);
    lyricState.history.push({ role: "assistant", content: reply });
  } catch (error) {
    refund(10);
    fillChat(pending, error.message || "重构失败");
  } finally {
    busy = false;
  }
}

async function sendLyricChat() {
  const input = $("ai-command-input");
  const message = input.value.trim();
  if (!message || busy) return;
  if (!checkAndDeduct(10)) return;
  busy = true;
  input.value = "";
  pushChat("user", message);
  lyricState.history.push({ role: "user", content: message });
  const pending = pushChat("assistant", "正在写。");
  try {
    const data = await lyricPost("/api/lyric/chat", craftPayload({
      message,
      lyric: toLyricMaster($("lyric-main-editor").value),
      history: lyricState.history.slice(-8),
    }));
    adoptCraft(data);
    if (data.lyric) applyLyric(data);
    let reply = data.reply || "";
    if (data.analyze?.song) {
      fillChat(pending, `正在分析《${data.analyze.song}》的曲风。`);
      try {
        await runGenerate({
          song: data.analyze.song,
          artist: data.analyze.artist || "",
          direction: "只按这首参考歌本身的公开听感写提示词，不要套用页面上预先点亮的默认标签",
          lyrics: "",
          clearStyle: true,
          buttons: [],
          busyLabel: "分析中",
          idleLabel: "分析这首歌的提示词",
          working: `正在按《${data.analyze.song}》的听感写提示词…`,
          done: `已按《${data.analyze.song}》写好曲风`,
          fromAssistant: true,
          keepTitle: Boolean(data.lyric),
        });
        const style = $("style-text-content").value.trim();
        const notes = $("composer-notes").textContent.trim();
        const heard = [`《${data.analyze.song}》的曲风已经写进作曲大师。`, style, notes].filter(Boolean).join("\n");
        reply = [reply, heard].filter(Boolean).join("\n\n");
      } catch (error) {
        reply = [reply, error.message || "曲风没分析成。"].filter(Boolean).join("\n");
      }
    }
    fillChat(pending, reply);
    lyricState.history.push({ role: "assistant", content: reply });
  } catch (error) {
    refund(10);
    fillChat(pending, error.message || "改词失败");
  } finally {
    busy = false;
  }
}

function craftPayload(extra) {
  return {
    skillId: lyricState.skillId,
    tongue: lyricState.tongue === "yue" ? "yue" : "cmn",
    scheme: "chorus",
    structure: "standard",
    length: "mid",
    tightness: lyricState.tightness === "strict" ? "strict" : "wide",
    register: lyricState.register === "spoken" ? "spoken" : "written",
    rhymeId: $("lyric-rhyme").value || "follow",
    hook: "head",
    person: "any",
    when: "any",
    theme: $("lyric-theme-input").value.trim(),
    styleId: $("lyric-style").value,
    techniqueIds: [],
    golden: lyricState.golden || "",
    seed: Date.now(),
    engine: settings.provider,
    api: settings.provider === "bailian" ? bailianApi() : undefined,
    ...extra,
  };
}

async function lyricPost(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || "作词接口失败");
  return data;
}

function sungLines(text) {
  return String(text || "").split("\n").map((line) => line.trim()).filter((line) => line && !/^\[[^\]]+\]$/.test(line) && !/^《.+》$/.test(line));
}

function isGoldenDraft() {
  const lines = sungLines($("lyric-main-editor").value);
  const golden = $("lyric-golden").value.trim();
  return lines.length === 1 && Boolean(golden) && lines[0] === golden;
}

function lyricBrought() {
  return lyricState.brought && sungLines($("lyric-main-editor").value).length > 0;
}

function paintSpark() {
  const spark = $("lyric-spark");
  if (!spark) return;
  const show = !lyricBrought();
  spark.classList.toggle("hidden", !show);
  $("lyric-main-editor").placeholder = show
    ? "歌词框是空的。先出一句，再扩写一段或扩写整首。"
    : "这首是从作曲大师带过来的。要改词，直接跟右边助手说。";
  paintSparkBusy();
}

function paintSparkBusy() {
  const roll = $("lyric-golden-roll");
  const section = $("lyric-expand-section");
  const song = $("lyric-expand-song");
  if (!roll || !section || !song) return;
  roll.disabled = busy;
  section.disabled = busy;
  song.disabled = busy;
  roll.textContent = busy && lyricState.busyAction === "golden" ? "在写…" : "出一句";
  section.textContent = busy && lyricState.busyAction === "section" ? "在扩…" : "扩写一段";
  song.textContent = busy && lyricState.busyAction === "song" ? "在铺…" : "扩写整首";
}

function requireLyricist() {
  if (!lyricState.skillId) {
    toast("先点一位词人");
    return false;
  }
  const skill = lyricState.skills.find((item) => item.id === lyricState.skillId);
  if (!skill || skill.status !== "ready" || !skill.styles?.length) {
    toast("这位词人的写法还没提炼完");
    return false;
  }
  return true;
}

function currentStyleId() {
  const select = $("lyric-style");
  if (select.value) return select.value;
  const option = [...select.options].find((item) => item.value);
  if (!option) return "";
  select.value = option.value;
  return option.value;
}

function syncGoldenDraft(line, flash) {
  if (lyricBrought()) return;
  const text = String(line || "").trim();
  const editor = $("lyric-main-editor");
  const existing = sungLines(editor.value);
  const editable = !existing.length || (lyricState.draft && existing.length === 1);
  if (!editable) return;
  if (!text) {
    if (!existing.length) return;
    editor.value = "";
    lyricState.committed = "";
    lyricState.draft = false;
    pushLyricToComposer();
    paintSpark();
    return;
  }
  const next = `[Chorus]\n${text}\n`;
  if (editor.value === next) {
    lyricState.draft = true;
    return;
  }
  editor.value = next;
  lyricState.committed = next;
  lyricState.draft = true;
  lyricState.brought = false;
  pushLyricToComposer();
  paintRollback();
  if (flash) {
    editor.classList.remove("lyric-flash");
    void editor.offsetWidth;
    editor.classList.add("lyric-flash");
  }
  setLyricMode("edit");
  paintSpark();
}

function sectionKindFromTag(tag) {
  const name = String(tag || "").replace(/[\[\]]/g, "");
  if (/chorus|副歌/i.test(name)) return "副歌";
  if (/bridge|桥/i.test(name)) return "桥段";
  if (/verse|主歌|pre-chorus/i.test(name)) return "主歌";
  return "";
}

function sunoTag(kind) {
  if (kind === "主歌") return "[Verse]";
  if (kind === "桥段") return "[Bridge]";
  return "[Chorus]";
}

function lyricBlocks(text) {
  const blocks = [];
  let current = null;
  String(text || "").split("\n").forEach((line) => {
    if (/^\s*\[[^\]]+\]\s*$/.test(line)) {
      current = { tag: line.trim(), lines: [] };
      blocks.push(current);
      return;
    }
    if (!current) {
      if (!line.trim()) return;
      current = { tag: "[Chorus]", lines: [line] };
      blocks.push(current);
      return;
    }
    current.lines.push(line);
  });
  return blocks;
}

function blockIndexAtCursor(text, cursor) {
  const lines = String(text || "").split("\n");
  let at = 0;
  let lineNo = 0;
  for (let i = 0; i < lines.length; i += 1) {
    at += lines[i].length + 1;
    lineNo = i;
    if (cursor <= at) break;
  }
  let block = -1;
  for (let i = 0; i <= lineNo && i < lines.length; i += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) block += 1;
  }
  return block;
}

function blocksToText(blocks) {
  const body = blocks.map((block) => {
    const lines = block.lines.join("\n").replace(/\s+$/, "");
    return `${block.tag}\n${lines}`.trimEnd();
  }).filter(Boolean).join("\n\n");
  return body ? `${body}\n` : "";
}

function takeSectionLines(lyric, kind, golden) {
  const blocks = lyricBlocks(toSuno(String(lyric || "")));
  const matches = blocks.filter((block) => sectionKindFromTag(block.tag) === kind);
  const pool = matches.length ? matches : blocks;
  const hit = pool.find((block) => golden && block.lines.some((line) => line.trim() === golden)) || pool[0];
  if (!hit) return [];
  const lines = hit.lines.map((line) => line.trim()).filter((line) => line && !/^\[[^\]]+\]$/.test(line));
  if (kind === "副歌" && golden && !lines.includes(golden)) lines.unshift(golden);
  return lines;
}

function writeEditor(next) {
  const editor = $("lyric-main-editor");
  if (next === editor.value) return false;
  clearTimeout(lyricState.editTimer);
  flushLyricHistory();
  rememberRevision(editor.value);
  editor.value = next;
  lyricState.committed = next;
  lyricState.draft = isGoldenDraft();
  pushLyricToComposer();
  paintRollback();
  renderRevision();
  editor.classList.remove("lyric-flash");
  void editor.offsetWidth;
  editor.classList.add("lyric-flash");
  setLyricMode("edit");
  paintSpark();
  return true;
}

async function rollGolden() {
  if (busy) return;
  if (!requireLyricist()) return;
  const current = $("lyric-golden").value.trim();
  lyricState.golden = current;
  busy = true;
  lyricState.busyAction = "golden";
  paintSparkBusy();
  try {
    const data = await lyricPost("/api/lyric/golden", craftPayload({ golden: current }));
    const line = String(data.line || "").trim();
    if (!line) throw new Error("没有写出金句");
    $("lyric-golden").value = line;
    lyricState.golden = line;
    $("lyric-golden-sense").textContent = String(data.sense || "").split("\n").find((row) => row.trim()) || "";
    if (data.styleId && [...$("lyric-style").options].some((item) => item.value === data.styleId)) {
      $("lyric-style").value = data.styleId;
    }
    syncGoldenDraft(line, true);
    toast("已出一句金句");
  } catch (error) {
    toast(error.message || "金句没写成");
  } finally {
    busy = false;
    lyricState.busyAction = "";
    paintSparkBusy();
  }
}

async function expandSection() {
  if (busy) return;
  if (!requireLyricist()) return;
  const golden = $("lyric-golden").value.trim();
  const editor = $("lyric-main-editor");
  const source = editor.value;
  const hasSong = sungLines(source).length > 0 && !isGoldenDraft();
  let kind = "副歌";
  if (hasSong) {
    const blocks = lyricBlocks(source);
    const index = blockIndexAtCursor(source, editor.selectionStart || 0);
    kind = sectionKindFromTag(blocks[index]?.tag) || "副歌";
  }
  if (!hasSong && !golden) {
    toast("先出一句，或自己写一句");
    return;
  }
  if (!checkAndDeduct(10)) return;
  if (!hasSong && golden) syncGoldenDraft(golden, false);
  const message = [
    `只扩写${kind}这一段，写成四句。`,
    golden && kind === "副歌" ? `其中一句必须原样保留：「${golden}」。` : "已有的句子保留，不够的补上。",
    "不要改其他段落，也不要新增段落。",
    "新句接着这一段往下写。",
  ].join("");
  busy = true;
  lyricState.busyAction = "section";
  paintSparkBusy();
  pushChat("user", `扩写${kind}`);
  lyricState.history.push({ role: "user", content: message });
  const pending = pushChat("assistant", "正在扩这一段。");
  try {
    const data = await lyricPost("/api/lyric/chat", craftPayload({
      message,
      lyric: toLyricMaster($("lyric-main-editor").value),
      history: lyricState.history.slice(-8),
      golden,
    }));
    const lines = takeSectionLines(data.lyric, kind, kind === "副歌" ? golden : "");
    if (lines.length < 2) throw new Error(data.reply || "这段没有扩开");
    const blocks = lyricBlocks($("lyric-main-editor").value);
    let index = hasSong ? blockIndexAtCursor(source, editor.selectionStart || 0) : 0;
    if (index < 0 || sectionKindFromTag(blocks[index]?.tag) !== kind) {
      index = blocks.findIndex((block) => sectionKindFromTag(block.tag) === kind);
    }
    if (index < 0) blocks.push({ tag: sunoTag(kind), lines });
    else blocks[index] = { tag: blocks[index].tag || sunoTag(kind), lines };
    writeEditor(blocksToText(blocks));
    lyricState.draft = false;
    const reply = data.reply || `已把${kind}扩成一段。`;
    fillChat(pending, reply);
    lyricState.history.push({ role: "assistant", content: reply });
    toast(`已扩写${kind}`);
  } catch (error) {
    refund(10);
    fillChat(pending, error.message || "这段没扩开");
  } finally {
    busy = false;
    lyricState.busyAction = "";
    paintSparkBusy();
  }
}

async function expandSong() {
  if (busy) return;
  if (!requireLyricist()) return;
  const golden = $("lyric-golden").value.trim();
  if (!golden) {
    toast("先出一句，或自己写一句");
    return;
  }
  const styleId = currentStyleId() || "all";
  if (!checkAndDeduct(10)) return;
  busy = true;
  lyricState.busyAction = "song";
  paintSparkBusy();
  try {
    const data = await lyricPost("/api/lyric/expand", craftPayload({ golden, styleId }));
    lyricState.draft = false;
    lyricState.brought = false;
    adoptCraft(data);
    applyLyric(data);
    if (data.reply) {
      pushChat("assistant", data.reply);
      lyricState.history.push({ role: "assistant", content: data.reply });
    }
    toast("已扩成整首");
  } catch (error) {
    refund(10);
    toast(error.message || "整首没写成");
  } finally {
    busy = false;
    lyricState.busyAction = "";
    paintSparkBusy();
  }
}

function applyLyric(data) {
  if (data.golden) {
    lyricState.golden = data.golden;
    $("lyric-golden").value = data.golden;
  }
  let body = String(data.lyric || "");
  const titleMatch = body.match(/^《([^》]+)》\s*/);
  let title = data.title || "";
  if (titleMatch) {
    title = title || titleMatch[1];
    body = body.slice(titleMatch[0].length).trim();
  }
  if (title) $("lyric-title-input").value = title;
  if (body) {
    const editor = $("lyric-main-editor");
    const before = editor.value;
    const next = toSuno(body);
    if (next !== before) {
      clearTimeout(lyricState.editTimer);
      flushLyricHistory();
      rememberRevision(editor.value);
      editor.value = next;
      lyricState.committed = next;
      pushLyricToComposer();
      paintRollback();
      renderRevision();
      editor.classList.remove("lyric-flash");
      void editor.offsetWidth;
      editor.classList.add("lyric-flash");
      setLyricMode("edit");
    }
    lyricState.draft = isGoldenDraft();
    if (!sungLines(editor.value).length) lyricState.brought = false;
    paintSpark();
  }
}

function rememberRevision(before) {
  if (lyricState.versions[lyricState.versions.length - 1] === before) {
    lyricState.revisionCursor = lyricState.versions.length - 1;
    return;
  }
  lyricState.versions.push(before);
  if (lyricState.versions.length > 20) lyricState.versions.shift();
  lyricState.revisionCursor = lyricState.versions.length - 1;
}

function rollbackLyric() {
  clearTimeout(lyricState.editTimer);
  flushLyricHistory();
  const editor = $("lyric-main-editor");
  if (!lyricState.versions.length) {
    paintRollback();
    toast("没有上一版");
    return;
  }
  const previous = lyricState.versions.pop();
  editor.value = previous;
  lyricState.committed = previous;
  lyricState.revisionCursor = Math.max(0, lyricState.versions.length - 1);
  if (!sungLines(previous).length) lyricState.brought = false;
  lyricState.draft = isGoldenDraft();
  pushLyricToComposer();
  renderRevision();
  setLyricMode("edit");
  paintRollback();
  paintSpark();
  toast("已回到上一版");
}

function revisionPair() {
  const versions = lyricState.versions;
  if (!versions.length) return null;
  const cursor = Math.max(0, Math.min(lyricState.revisionCursor, versions.length - 1));
  lyricState.revisionCursor = cursor;
  const before = versions[cursor];
  const after = cursor === versions.length - 1 ? $("lyric-main-editor").value : versions[cursor + 1];
  return { before, after, cursor, latest: cursor === versions.length - 1 };
}

function lineDiff(before, after) {
  const oldLines = String(before || "").split(/\n/);
  const newLines = String(after || "").split(/\n/);
  const rows = oldLines.length;
  const cols = newLines.length;
  const next = Array.from({ length: rows + 1 }, () => Array(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      next[i][j] = oldLines[i] === newLines[j] ? next[i + 1][j + 1] + 1 : Math.max(next[i + 1][j], next[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (oldLines[i] === newLines[j]) {
      out.push({ type: "same", text: oldLines[i] });
      i += 1;
      j += 1;
    } else if (next[i + 1][j] >= next[i][j + 1]) {
      out.push({ type: "del", text: oldLines[i] });
      i += 1;
    } else {
      out.push({ type: "add", text: newLines[j] });
      j += 1;
    }
  }
  while (i < rows) out.push({ type: "del", text: oldLines[i++] });
  while (j < cols) out.push({ type: "add", text: newLines[j++] });
  return out;
}

function renderRevision() {
  const hint = $("lyric-revision-hint");
  const bar = $("lyric-revision-bar");
  const note = $("lyric-revision-note");
  const pane = $("lyric-revision");
  const pair = revisionPair();
  if (!pair) {
    hint.classList.add("hidden");
    bar.classList.add("hidden");
    pane.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "px-3 text-sm text-slate-400";
    empty.textContent = "助手改完词之后，这里会标出删掉和新增的句子。";
    pane.appendChild(empty);
    return;
  }
  const diff = lineDiff(pair.before, pair.after);
  const removed = diff.filter((line) => line.type === "del" && line.text.trim()).length;
  const added = diff.filter((line) => line.type === "add" && line.text.trim()).length;
  const where = pair.latest ? "最近一次修改" : `第 ${pair.cursor + 1} 版`;
  hint.classList.remove("hidden");
  hint.textContent = "";
  const hintText = document.createTextNode(`${where}：删了 ${removed} 句，新增 ${added} 句。`);
  const look = document.createElement("button");
  look.type = "button";
  look.className = "ml-1 font-semibold text-slate-800 hover:underline";
  look.textContent = "看修订";
  look.addEventListener("click", () => setLyricMode("diff"));
  hint.append(hintText, look);
  bar.classList.remove("hidden");
  note.textContent = pair.latest ? "左边划掉的是改前，绿色是现在这版。" : "正在看更早的一版。恢复后会换回编辑台。";
  $("lyric-revision-older").disabled = pair.cursor === 0;
  $("lyric-revision-newer").disabled = pair.latest;
  $("lyric-revision-older").classList.toggle("opacity-40", pair.cursor === 0);
  $("lyric-revision-newer").classList.toggle("opacity-40", pair.latest);
  $("lyric-revision-restore").textContent = pair.latest ? "恢复改前" : "恢复这一版";
  pane.replaceChildren();
  diff.forEach((line) => {
    const row = document.createElement("div");
    row.className = `rev-line rev-${line.type}`;
    row.textContent = line.text.length ? line.text : " ";
    pane.appendChild(row);
  });
}

function setLyricMode(mode) {
  lyricState.lyricMode = mode === "diff" ? "diff" : "edit";
  const diff = lyricState.lyricMode === "diff";
  $("lyric-main-editor").classList.toggle("hidden", diff);
  $("lyric-revision").classList.toggle("hidden", !diff);
  $("lyric-mode-edit").classList.toggle("active", !diff);
  $("lyric-mode-diff").classList.toggle("active", diff);
  if (diff) renderRevision();
}

function stepRevision(step) {
  if (!lyricState.versions.length) return;
  lyricState.revisionCursor = Math.max(0, Math.min(lyricState.versions.length - 1, lyricState.revisionCursor + step));
  setLyricMode("diff");
}

function restoreViewedLyric() {
  const pair = revisionPair();
  if (!pair) return;
  const target = pair.latest ? pair.before : pair.after;
  const editor = $("lyric-main-editor");
  if (editor.value === target) return;
  clearTimeout(lyricState.editTimer);
  flushLyricHistory();
  rememberRevision(editor.value);
  editor.value = target;
  lyricState.committed = target;
  lyricState.revisionCursor = lyricState.versions.length - 1;
  if (!sungLines(target).length) lyricState.brought = false;
  lyricState.draft = isGoldenDraft();
  pushLyricToComposer();
  paintRollback();
  renderRevision();
  setLyricMode("edit");
  paintSpark();
  toast(pair.latest ? "已恢复改前的一版" : "已恢复这一版");
}

function toSuno(text) {
  let verse = 0;
  return text
    .replace(/\[主歌\]/g, () => `[Verse ${++verse}]`)
    .replace(/\[副歌\]/g, "[Chorus]")
    .replace(/\[桥段\]/g, "[Bridge]");
}

function toLyricMaster(text) {
  return text
    .replace(/\[Verse(?:\s*\d+)?\]/gi, "[主歌]")
    .replace(/\[Pre-Chorus\]/gi, "[主歌]")
    .replace(/\[Chorus(?:\s*\d+)?\]/gi, "[副歌]")
    .replace(/\[Bridge\]/gi, "[桥段]");
}

function appendMetatag(tag) {
  const editor = $("lyric-main-editor");
  clearTimeout(lyricState.editTimer);
  flushLyricHistory();
  const at = editor.selectionStart || editor.value.length;
  const next = `${editor.value.slice(0, at)}\n${tag}\n${editor.value.slice(at)}`;
  if (next !== editor.value) {
    rememberRevision(editor.value);
    editor.value = next;
    lyricState.committed = next;
    pushLyricToComposer();
    paintRollback();
  }
  editor.focus();
}

function formatLyric() {
  const editor = $("lyric-main-editor");
  clearTimeout(lyricState.editTimer);
  flushLyricHistory();
  const next = editor.value.replace(/\n\s*\n\s*\n/g, "\n\n").trim();
  if (next !== editor.value) {
    rememberRevision(editor.value);
    editor.value = next;
    lyricState.committed = next;
    pushLyricToComposer();
    paintRollback();
  }
  toast("排版已收好");
}

function pushChat(role, text, thinking) {
  const node = document.createElement("div");
  node.className = role === "user"
    ? "p-2 rounded-lg bg-slate-100 text-slate-800 text-sm"
    : "p-2.5 rounded-lg bg-slate-50 border border-slate-200 text-slate-700 text-sm";
  fillChat(node, text, thinking, role);
  $("ai-chat-history").appendChild(node);
  $("ai-chat-history").scrollTop = $("ai-chat-history").scrollHeight;
  return node;
}

function fillChat(node, text, thinking) {
  node.replaceChildren();
  const steps = Array.isArray(thinking) ? thinking.map((line) => String(line || "").trim()).filter(Boolean) : [];
  if (steps.length) {
    const details = document.createElement("details");
    details.className = "think-block";
    details.open = true;
    const summary = document.createElement("summary");
    summary.textContent = "思考";
    details.appendChild(summary);
    const list = document.createElement("ul");
    steps.forEach((line) => {
      const item = document.createElement("li");
      item.textContent = line;
      list.appendChild(item);
    });
    details.appendChild(list);
    node.appendChild(details);
  }
  const body = document.createElement("div");
  body.textContent = text || "";
  node.appendChild(body);
}

function enginePayload() {
  if (settings.provider === "bailian") {
    return { provider: "bailian", engine: "bailian", apiBase: settings.apiBase, apiKey: settings.apiKey, model: settings.model };
  }
  return { provider: "gemini", engine: "gemini" };
}

function bailianApi() {
  return { base: settings.apiBase, model: settings.model, key: settings.apiKey };
}

function openSettings() {
  setProvider(settings.provider || "gemini");
  $("bailian-base").value = settings.apiBase || "https://dashscope.aliyuncs.com/compatible-mode/v1";
  $("bailian-model").value = settings.model || "qwen-plus";
  $("bailian-key").value = settings.apiKey || "";
  $("settings-note").textContent = "";
  $("settings-modal").classList.remove("hidden");
}

function setProvider(provider) {
  settings.provider = provider === "bailian" ? "bailian" : "gemini";
  const gemini = settings.provider === "gemini";
  $("provider-gemini").className = `px-3 py-1 rounded-md ${gemini ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`;
  $("provider-bailian").className = `px-3 py-1 rounded-md ${gemini ? "text-slate-500" : "bg-white text-slate-900 shadow-sm"}`;
  $("bailian-fields").classList.toggle("hidden", gemini);
  reflectEngine();
}

function saveSettings() {
  if (settings.provider === "bailian") {
    settings.apiBase = $("bailian-base").value.trim();
    settings.model = $("bailian-model").value.trim();
    settings.apiKey = $("bailian-key").value.trim();
    if (!settings.apiBase || !settings.model || !settings.apiKey) {
      $("settings-note").textContent = "百炼需要地址、模型和密钥。";
      $("settings-note").className = "text-[11px] text-red-600";
      return;
    }
  }
  localStorage.setItem("sunomaster-settings", JSON.stringify(settings));
  reflectEngine();
  $("settings-modal").classList.add("hidden");
  toast(settings.provider === "gemini" ? "已使用服务器上的 Gemini" : "已改用阿里百炼");
}

async function testEngine() {
  $("settings-note").textContent = "测试中…";
  $("settings-note").className = "text-[11px] text-slate-500";
  const payload = settings.provider === "bailian"
    ? { provider: "bailian", apiBase: $("bailian-base").value.trim(), apiKey: $("bailian-key").value.trim(), model: $("bailian-model").value.trim() }
    : { provider: "gemini" };
  try {
    const response = await fetch("/api/ping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "连接失败");
    $("settings-note").textContent = "连接成功。";
    $("settings-note").className = "text-[11px] text-emerald-700";
  } catch (error) {
    $("settings-note").textContent = error.message || "连接失败";
    $("settings-note").className = "text-[11px] text-red-600";
  }
}

async function onKeyFile(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = "";
  if (!file) return;
  const fields = parseKeyFile(await file.text());
  const base = fields.openAiCompatible || fields.openaiCompatible || fields.base_url || fields.baseUrl || fields.apiHost || "";
  const key = fields.apiKey || fields.api_key || fields.apikey || "";
  if (base) $("bailian-base").value = /aliyuncs\.com/i.test(base) && !/compatible-mode/i.test(base) ? "https://dashscope.aliyuncs.com/compatible-mode/v1" : base;
  if (key) $("bailian-key").value = key;
  if (!$("bailian-model").value.trim()) $("bailian-model").value = "qwen-plus";
  $("settings-note").textContent = "已读入密钥文件，确认后保存。";
  $("settings-note").className = "text-[11px] text-emerald-700";
}

function parseKeyFile(text) {
  const source = String(text || "").replace(/^\uFEFF/, "").trim();
  if (!source) return {};
  if (source.startsWith("{")) return JSON.parse(source);
  const fields = {};
  for (const line of source.split(/\r?\n/)) {
    const comma = line.indexOf(",");
    const equals = line.indexOf("=");
    const splitAt = comma === -1 ? equals : equals === -1 ? comma : Math.min(comma, equals);
    if (splitAt <= 0) continue;
    const name = line.slice(0, splitAt).trim().replace(/^"|"$/g, "");
    const value = line.slice(splitAt + 1).trim().replace(/^"|"$/g, "");
    if (name && !(name in fields)) fields[name] = value;
  }
  return fields;
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("sunomaster-settings") || "{}");
    return {
      provider: saved.provider === "bailian" ? "bailian" : "gemini",
      apiBase: saved.apiBase || "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: saved.model || "qwen-plus",
      apiKey: saved.apiKey || "",
    };
  } catch {
    return { provider: "gemini", apiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", apiKey: "" };
  }
}

function reflectEngine() {
  const name = settings.provider === "bailian" ? "百炼" : "Gemini";
  $("engine-label").textContent = name;
  $("account-engine-label").textContent = name;
  $("package-engine").textContent = settings.provider === "bailian" ? (settings.model || "百炼") : "Gemini 3.8 Flash";
}

function openSuno(style, lyrics) {
  $("suno-style-preview").textContent = style || "（还没有 Style）";
  $("suno-exclude-preview").textContent = $("exclude-text-content").value.trim() || "（还没有 Exclude）";
  $("suno-lyric-preview").textContent = lyrics || "（还没有歌词）";
  $("suno-modal").classList.remove("hidden");
}

function switchLyricTab(tab) {
  $("module-lyric").dataset.lyricTab = tab;
  document.querySelectorAll(".lyric-mtab").forEach((btn) => {
    const on = btn.dataset.lyricTab === tab;
    btn.className = `lyric-mtab flex-1 rounded-lg py-2 text-center text-xs font-bold ${on ? "bg-white text-slate-900 shadow-sm" : "text-slate-600"}`;
  });
}

function switchWorkspace(moduleKey, options = {}) {
  const previous = currentWorkspace;
  currentWorkspace = moduleKey;
  const enteringLyric = moduleKey === "lyric" && $("module-lyric").classList.contains("hidden");
  ["hot", "composer", "lyric", "publish", "account"].forEach((key) => {
    const module = $("module-" + key);
    if (module) module.classList.toggle("hidden", key !== moduleKey);
    const on = key === moduleKey;
    const nav = $("nav-btn-" + key);
    if (nav) nav.className = `nav-btn w-full flex items-center gap-3.5 px-4 py-3 rounded-xl text-sm font-semibold transition-all ${on ? "bg-slate-900 text-white shadow-sm" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"}`;
    const mobile = $("m-nav-" + key);
    if (mobile) mobile.className = `m-nav-btn flex-1 py-2 ${on ? "text-orange-600" : "text-slate-400"}`;
  });
  $("open-account")?.classList.toggle("is-on", moduleKey === "account");
  if (enteringLyric) switchLyricTab("editor");
  if (moduleKey === "publish" && window.bootPublish) window.bootPublish();
  if (!options.silent) {
    const accountPaths = ["/account", "/login", "/pricing"];
    const onAccountPath = accountPaths.includes(location.pathname);
    if (moduleKey === "account" && !onAccountPath) {
      history.replaceState({ workspace: previous }, "", `${location.pathname}${location.search}`);
      history.pushState({ workspace: "account" }, "", "/account");
    } else if (moduleKey !== "account" && onAccountPath) {
      history.pushState({ workspace: moduleKey }, "", "/");
    }
  }
  window.scrollTo(0, 0);
  if (moduleKey === "account" && location.pathname === "/pricing") {
    requestAnimationFrame(() => $("account-plans")?.scrollIntoView({ block: "start" }));
  }
}

function openAccount() {
  switchWorkspace("account");
  if (!accountUser) setAccountError("积分不够。登录后可以购买积分，或开通会员。");
}

async function billingRequest(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "支付服务暂时不可用");
  return data;
}

let vipInterval = "month";

function setVipInterval(interval) {
  vipInterval = interval === "year" ? "year" : "month";
  applyBillingSelectors();
}

function applyBillingSelectors() {
  document.querySelectorAll("[data-vip-interval]").forEach((button) => {
    const on = button.dataset.vipInterval === vipInterval;
    button.classList.toggle("bg-slate-900", on);
    button.classList.toggle("text-white", on);
    button.classList.toggle("text-slate-600", !on);
  });
  document.querySelectorAll(".vip-price").forEach((node) => {
    node.textContent = node.dataset[vipInterval] || node.dataset.month;
  });
  document.querySelectorAll(".vip-period").forEach((node) => {
    node.textContent = vipInterval === "year" ? "/ 年" : "/ 月";
  });
  const note = $("vip-interval-note");
  if (note) {
    note.textContent = vipInterval === "year"
      ? "按年价格，一次付清 12 个月。积分仍每个月重置为该档额度。"
      : "按月价格，开通后有效一个月，积分当月到账。";
  }
  const credits = priceCatalog?.credits;
  if ($("credit-pack-copy") && credits?.amount) {
    $("credit-pack-copy").textContent = `一次性 ${credits.credits} 积分，${formatMoney(credits.amount, credits.currency || "usd")}。买完就到账，不按月重置。`;
  }
  if ($("charge-btn") && credits?.amount) {
    $("charge-btn").textContent = `购买 100 积分 · ${formatMoney(credits.amount, credits.currency || "usd")}`;
  }
  renderAccount();
}

function subscriptionLive() {
  return ["active", "past_due", "trialing", "incomplete"].includes(billingSnapshot.subscriptionStatus);
}

function subscriptionLabel() {
  if (!accountUser) return accountResolved ? "登录后开通会员" : "未订阅";
  const planName = PLAN_NAMES[billingSnapshot.plan] || "会员";
  const intervalName = billingSnapshot.billingInterval === "year" ? "按年" : "按月";
  const labels = {
    active: `${planName} · ${intervalName}，已生效`,
    past_due: `${planName} 扣款失败，请更新付款方式`,
    canceled: "订阅已取消，可以重新开通",
    trialing: `${planName} 试用中`,
    incomplete: "这笔订阅还没付完",
  };
  return labels[billingSnapshot.subscriptionStatus] || "未订阅";
}

function readAccountHint() {
  try {
    const hint = JSON.parse(localStorage.getItem("sm-account-hint") || "null");
    if (!hint || typeof hint.name !== "string" || !hint.name) return null;
    return hint;
  } catch {
    return null;
  }
}

function writeAccountHint(user) {
  try {
    if (!user) localStorage.removeItem("sm-account-hint");
    else localStorage.setItem("sm-account-hint", JSON.stringify({ name: user.name || "", email: user.email || "" }));
  } catch { /* 隐私模式记不住这次显示 */ }
}

function renderIdentity() {
  const hint = !accountUser && !accountResolved ? readAccountHint() : null;
  if (!accountUser && !accountResolved && !hint) return;
  const name = accountUser?.name || hint?.name || "登录账号";
  const avatar = $("account-avatar");
  if (avatar) avatar.textContent = accountUser || hint ? (Array.from(name)[0] || "创") : "登";
  const display = $("account-display-name");
  if (display) display.textContent = name;
  const planName = PLAN_NAMES[billingSnapshot.plan] || "";
  const active = Boolean(accountUser && billingSnapshot.subscriptionStatus === "active" && planName);
  const meta = $("account-meta");
  if (meta) meta.textContent = accountUser ? `${active ? `${planName} · ` : ""}${userState.credits} 积分` : "会员与积分";
  const action = $("account-side-action");
  if (action) {
    if (!accountUser && !hint) action.textContent = "登录";
    else if (!accountUser) action.textContent = "已登录";
    else if (active) action.textContent = planName;
    else if (billingSnapshot.subscriptionStatus === "trialing") action.textContent = "试用中";
    else action.textContent = "未订阅";
  }
  if ($("mobile-credits")) $("mobile-credits").textContent = String(userState.credits);
  if ($("account-credits")) $("account-credits").textContent = String(userState.credits);
}

function formatMoney(cents, currency = "usd") {
  const code = String(currency || "usd").toUpperCase();
  return (Number(cents) / 100).toLocaleString(code === "CNY" ? "zh-CN" : "en-US", { style: "currency", currency: code });
}

async function loadCatalog() {
  try {
    const response = await fetch("/api/stripe/catalog", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    priceCatalog = data;
    for (const plan of data.plans || []) {
      const price = document.querySelector(`[data-plan-card="${plan.id}"] .vip-price`);
      if (!price || !plan.month || !plan.year) continue;
      price.dataset.month = formatMoney(plan.month, plan.currency);
      price.dataset.year = formatMoney(plan.year, plan.currency);
    }
    applyBillingSelectors();
    const note = $("pay-live-note");
    if (note && !data.livemode) note.textContent = "当前是测试付款。确认后进入 Stripe 结账页，不会产生真实扣款。";
    renderAccount();
  } catch { /* 接口没起来时保留页面上的价格 */ }
}

function renderAccount() {
  const loggedIn = Boolean(accountUser);
  const hint = !loggedIn && !accountResolved ? readAccountHint() : null;
  $("account-gate")?.classList.toggle("hidden", !accountResolved || loggedIn);
  $("account-profile")?.classList.toggle("hidden", !loggedIn && !hint);
  if (loggedIn || hint) {
    const name = loggedIn ? accountUser.name : hint.name;
    $("account-profile-name").textContent = name;
    if (loggedIn || hint.email) $("account-profile-email").textContent = loggedIn ? accountUser.email : hint.email;
    $("account-profile-avatar").textContent = Array.from(name || "")[0] || "创";
  }
  const status = $("subscription-status");
  if (status) status.textContent = subscriptionLabel();
  const subscribed = loggedIn && subscriptionLive();
  $("manage-billing")?.classList.toggle("hidden", !subscribed);
  if ($("charge-btn")) {
    $("charge-btn").disabled = !accountResolved || priceCatalog?.credits?.ready === false;
  }
  document.querySelectorAll("[data-plan-card]").forEach((card) => {
    const plan = card.dataset.planCard;
    const current = loggedIn && billingSnapshot.subscriptionStatus === "active" && billingSnapshot.plan === plan;
    card.classList.toggle("current", current);
    const button = card.querySelector("[data-vip-plan]");
    if (!button) return;
    const listed = priceCatalog?.plans?.find((item) => item.id === plan);
    const ready = listed?.ready;
    if (!accountResolved) {
      button.disabled = true;
      if (loggedIn || hint) button.textContent = `开通${PLAN_NAMES[plan] || "会员"}`;
      return;
    }
    if (listed && ready === false) {
      button.disabled = true;
      button.textContent = "价格未就绪";
      return;
    }
    button.disabled = current;
    if (!loggedIn) button.textContent = "登录后开通";
    else if (current) button.textContent = "当前方案";
    else if (subscribed && billingSnapshot.billingSource !== "prepaid") button.textContent = "到账单里更换";
    else button.textContent = `开通${PLAN_NAMES[plan] || "会员"}`;
  });
  renderIdentity();
}

function setAccountError(message) {
  const node = $("account-form-error");
  if (!node) return;
  node.textContent = message || "";
  node.classList.toggle("hidden", !message);
}

function setAccountMode(mode) {
  accountMode = mode === "register" ? "register" : "login";
  const register = accountMode === "register";
  $("account-name-field")?.classList.toggle("hidden", !register);
  $("account-password-2-field")?.classList.toggle("hidden", !register);
  if ($("account-submit")) $("account-submit").textContent = register ? "注册并登录" : "登录";
  if ($("account-switch-mode")) $("account-switch-mode").textContent = register ? "已有账号？去登录" : "没有账号？注册";
  if ($("account-form-title")) $("account-form-title").textContent = register ? "注册账号" : "账号登录";
  if ($("account-password")) $("account-password").autocomplete = register ? "new-password" : "current-password";
  setAccountError("");
}

function applyAccountUser(user) {
  accountResolved = true;
  accountUser = user || null;
  writeAccountHint(accountUser);
  if (!accountUser) {
    const saved = Number(localStorage.getItem("sm-credits") || 50);
    userState.credits = Number.isFinite(saved) ? saved : 50;
    billingSnapshot = { subscriptionStatus: "none", plan: "", billingInterval: "" };
    updateCreditsUI();
    renderAccount();
    return;
  }
  updateCreditsUI();
  renderAccount();
  syncBillingStatus();
}

async function loadAccount() {
  try {
    const response = await fetch("/api/auth/me", { cache: "no-store" });
    const data = await response.json();
    applyAccountUser(data.user || null);
  } catch {
    applyAccountUser(null);
  }
}

async function submitAccount(event) {
  event.preventDefault();
  const email = $("account-email").value.trim();
  const password = $("account-password").value;
  const name = $("account-name").value.trim();
  if (!email || !password) {
    setAccountError("请填写邮箱和密码");
    return;
  }
  if (accountMode === "register" && password !== $("account-password-2").value) {
    setAccountError("两次密码不一致");
    return;
  }
  const button = $("account-submit");
  button.disabled = true;
  try {
    const response = await fetch(accountMode === "register" ? "/api/auth/register" : "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "没有完成");
    $("account-password").value = "";
    $("account-password-2").value = "";
    setAccountError("");
    applyAccountUser(data.user);
    toast(accountMode === "register" ? "账号已创建" : "已登录");
  } catch (error) {
    setAccountError(error.message);
  } finally {
    button.disabled = false;
  }
}

async function logoutAccount() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch { /* 本地先退出，下次打开会再对一下 */ }
  $("account-password").value = "";
  applyAccountUser(null);
  setAccountMode("login");
  toast("已退出");
}

function requireAccount(message) {
  switchWorkspace("account");
  setAccountMode("login");
  setAccountError(message);
  $("account-email")?.focus();
}

async function startCheckout(kind, extra = {}) {
  if (!accountUser) {
    requireAccount(kind === "subscription" ? "先登录，再开通会员。" : "先登录，再购买积分。");
    return;
  }
  if (kind === "subscription" && subscriptionLive() && billingSnapshot.billingSource !== "prepaid") {
    if (billingSnapshot.subscriptionStatus === "active" && billingSnapshot.plan === extra.plan) return;
    return openBillingPortal();
  }
  const checkoutTab = window.open("", "_blank");
  const button = extra.button || (kind === "credits" ? $("charge-btn") : null);
  if (button) button.disabled = true;
  try {
    const data = await billingRequest("/api/stripe/checkout", {
      kind,
      ...(extra.plan ? { plan: extra.plan, interval: extra.interval || vipInterval } : {}),
    });
    if (checkoutTab && !checkoutTab.closed) {
      checkoutTab.location.href = data.url;
      checkoutTab.focus();
    } else {
      location.href = data.url;
    }
  } catch (error) {
    if (checkoutTab && !checkoutTab.closed) checkoutTab.close();
    toast(error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

async function openBillingPortal() {
  if (!accountUser) {
    requireAccount("先登录，再管理账单。");
    return;
  }
  try {
    const data = await billingRequest("/api/stripe/portal", {});
    location.href = data.url;
  } catch (error) {
    toast(error.message);
  }
}

async function syncBillingStatus() {
  if (!accountUser) return;
  try {
    const response = await fetch("/api/stripe/status", { cache: "no-store" });
    if (response.status === 401) {
      applyAccountUser(null);
      return;
    }
    if (!response.ok) return;
    const data = await response.json();
    billingSnapshot = data;
    if (Number.isFinite(data.credits)) userState.credits = data.credits;
    updateCreditsUI();
    renderAccount();
  } catch { /* 离线时保持当前显示 */ }
}

function checkAndDeduct(amount) {
  if (userState.credits < amount) {
    toast(`积分不足，需要 ${amount}`);
    openAccount();
    return false;
  }
  userState.credits -= amount;
  updateCreditsUI();
  return true;
}

function refund(amount) {
  userState.credits += amount;
  updateCreditsUI();
}

function updateCreditsUI() {
  if (!accountUser) {
    try { localStorage.setItem("sm-credits", String(userState.credits)); } catch { /* 隐私模式写不进去 */ }
  }
  renderIdentity();
}

function updatePromptCounts() {
  for (const [field, count, limit] of PROMPT_LIMITS) {
    const node = $(count);
    if (!node || !$(field)) continue;
    const length = $(field).value.length;
    node.textContent = `${length}/${limit}`;
    node.classList.toggle("text-red-600", length > limit);
    node.classList.toggle("text-slate-400", length <= limit);
  }
}

async function copyField(id) {
  const node = $(id);
  const text = (node.value !== undefined ? node.value : node.textContent).trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  toast("已复制");
}

function readTrackTags(file) {
  const stem = file.name.replace(/\.[^.]+$/, "").trim();
  return file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer().then(async (headBuf) => {
    let head = new Uint8Array(headBuf);
    const declared = id3v2DeclaredSize(head);
    if (declared > head.length && declared <= 8 * 1024 * 1024) {
      head = new Uint8Array(await file.slice(0, declared).arrayBuffer());
    }
    const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 128)).arrayBuffer());
    const tags = parseId3(head, tail);
    let title = tags.title || "";
    let artist = tags.artist || "";
    if (!title && !artist && stem) {
      const parts = stem.split(/\s+[-–—]\s+/);
      if (parts.length === 2 && parts[0] && parts[1]) {
        title = parts[0];
        artist = parts[1];
      } else title = stem;
    } else if (!title) title = stem;
    return { title: title.slice(0, 80), artist: artist.slice(0, 80), fromTags: Boolean(tags.title || tags.artist) };
  });
}

function id3v2DeclaredSize(bytes) {
  if (bytes.length < 10 || asciiAt(bytes, 0, 3) !== "ID3") return 0;
  return synchsafe(bytes, 6) + 10;
}

function parseId3(head, tail) {
  const found = readId3v2(head);
  if (!found.title || !found.artist) {
    const v1 = readId3v1(tail);
    if (v1) {
      if (!found.title && v1.title) found.title = v1.title;
      if (!found.artist && v1.artist) found.artist = v1.artist;
    }
  }
  return found;
}

function readId3v2(bytes) {
  const empty = { title: "", artist: "" };
  if (bytes.length < 10 || asciiAt(bytes, 0, 3) !== "ID3") return empty;
  const major = bytes[3];
  if (major < 2 || major > 4) return empty;
  const flags = bytes[5];
  const size = synchsafe(bytes, 6);
  let body = bytes.subarray(10, Math.min(bytes.length, 10 + size));
  if (flags & 0x80) body = deunsync(body);
  let offset = 0;
  if (flags & 0x40) {
    if (major === 3) {
      if (offset + 4 > body.length) return empty;
      offset += 4 + u32(body, offset);
    } else if (major >= 4) {
      if (offset + 4 > body.length) return empty;
      offset += synchsafe(body, offset);
    }
  }
  const out = { title: "", artist: "" };
  if (major === 2) {
    while (offset + 6 <= body.length) {
      if (body[offset] === 0) break;
      const id = asciiAt(body, offset, 3);
      const frameSize = (body[offset + 3] << 16) | (body[offset + 4] << 8) | body[offset + 5];
      offset += 6;
      if (frameSize <= 0 || offset + frameSize > body.length) break;
      const text = decodeId3Text(body.subarray(offset, offset + frameSize));
      offset += frameSize;
      if (id === "TT2" && text) out.title = text;
      if (id === "TP1" && text) out.artist = text;
    }
    return out;
  }
  while (offset + 10 <= body.length) {
    if (body[offset] === 0) break;
    const id = asciiAt(body, offset, 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const frameSize = major === 4 ? synchsafe(body, offset + 4) : u32(body, offset + 4);
    const format = body[offset + 9];
    offset += 10;
    if (frameSize <= 0 || offset + frameSize > body.length) break;
    let data = body.subarray(offset, offset + frameSize);
    offset += frameSize;
    if (major === 4) {
      if (format & 0x08 || format & 0x04) continue;
      if (format & 0x40 && data.length) data = data.subarray(1);
      if (format & 0x01 && data.length >= 4) data = data.subarray(4);
      if (format & 0x02) data = deunsync(data);
    } else if (format & 0x80 || format & 0x40) continue;
    else if (format & 0x20 && data.length) data = data.subarray(1);
    const text = decodeId3Text(data);
    if (id === "TIT2" && text) out.title = text;
    if (id === "TPE1" && text) out.artist = text;
  }
  return out;
}

function readId3v1(bytes) {
  if (bytes.length < 128 || asciiAt(bytes, bytes.length - 128, 3) !== "TAG") return null;
  const start = bytes.length - 128;
  return {
    title: decodeLegacy(bytes.subarray(start + 3, start + 33)),
    artist: decodeLegacy(bytes.subarray(start + 33, start + 63)),
  };
}

function decodeId3Text(data) {
  if (!data || data.length < 2) return "";
  const encoding = data[0];
  const body = data.subarray(1);
  let text = "";
  try {
    if (encoding === 0) text = decodeLegacy(body);
    else if (encoding === 1) text = decodeUtf16(body);
    else if (encoding === 2) text = new TextDecoder("utf-16be").decode(body);
    else text = new TextDecoder("utf-8").decode(body);
  } catch {
    return "";
  }
  return text.replace(/^\uFEFF/, "").split("\0").map((part) => part.trim()).find(Boolean) || "";
}

function decodeUtf16(body) {
  if (body.length >= 2 && body[0] === 0xFF && body[1] === 0xFE) return new TextDecoder("utf-16le").decode(body.subarray(2));
  if (body.length >= 2 && body[0] === 0xFE && body[1] === 0xFF) return new TextDecoder("utf-16be").decode(body.subarray(2));
  return new TextDecoder("utf-16le").decode(body);
}

function decodeLegacy(bytes) {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0 || bytes[end - 1] === 0x20)) end -= 1;
  const slice = bytes.subarray(0, end);
  if (!slice.length) return "";
  if (slice.some((value) => value >= 0x80)) {
    try { return new TextDecoder("gbk").decode(slice).trim(); } catch { /* use latin1 */ }
  }
  return new TextDecoder("iso-8859-1").decode(slice).trim();
}

function deunsync(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 1) {
    out.push(bytes[i]);
    if (bytes[i] === 0xFF && bytes[i + 1] === 0x00) i += 1;
  }
  return Uint8Array.from(out);
}

function synchsafe(bytes, offset) {
  return ((bytes[offset] & 0x7f) << 21)
    | ((bytes[offset + 1] & 0x7f) << 14)
    | ((bytes[offset + 2] & 0x7f) << 7)
    | (bytes[offset + 3] & 0x7f);
}

function u32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function asciiAt(bytes, offset, length) {
  let text = "";
  for (let i = 0; i < length; i += 1) text += String.fromCharCode(bytes[offset + i]);
  return text;
}

function readAudioFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result || "");
      const comma = raw.indexOf(",");
      resolve({ mimeType: audioMime(file), data: raw.slice(comma + 1) });
    };
    reader.onerror = () => reject(new Error("读不了这个音频"));
    reader.readAsDataURL(file);
  });
}

function audioMime(file) {
  const type = (file.type || "").toLowerCase();
  if (type.startsWith("audio/")) return type === "audio/mp3" ? "audio/mpeg" : type === "audio/x-wav" ? "audio/wav" : type;
  const ext = file.name.split(".").pop().toLowerCase();
  return { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", flac: "audio/flac", ogg: "audio/ogg" }[ext] || "audio/mpeg";
}

function initAudioContext() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

function playSyntheticChords(styleType) {
  initAudioContext();
  if (audioCtx.state === "suspended") audioCtx.resume();
  const chordNotes = {
    chill: [261.63, 329.63, 392, 523.25],
    guzheng: [261.63, 293.66, 329.63, 392],
    acoustic: [196, 246.94, 293.66, 392],
  };
  const notes = chordNotes[styleType] || chordNotes.chill;
  let noteIndex = 0;
  currentSynthInterval = setInterval(() => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = styleType === "guzheng" ? "triangle" : "sine";
    osc.frequency.setValueAtTime(notes[noteIndex % notes.length], audioCtx.currentTime);
    gain.gain.setValueAtTime(0.05, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.45);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.5);
    noteIndex += 1;
  }, 280);
}

function playReferenceAudition(btn) {
  const playing = btn.classList.contains("playing");
  stopAllAuditions();
  if (playing || !referenceAudioUrl) return;
  referenceAudio = new Audio(referenceAudioUrl);
  referenceAudio.onended = () => stopAllAuditions();
  btn.classList.add("playing");
  const text = btn.querySelector(".btn-text");
  const wave = btn.querySelector(".soundwave-box");
  if (text) text.textContent = "暂停";
  if (wave) wave.classList.remove("hidden");
  const song = $("ref-song").value.trim();
  const artist = $("ref-artist").value.trim();
  $("player-track-name").textContent = [song, artist].filter(Boolean).join(" · ") || "上传的录音";
  $("global-player-bar").classList.remove("translate-y-full");
  document.body.classList.add("player-open");
  referenceAudio.play().catch(() => {
    stopAllAuditions();
    toast("这段录音播不了");
  });
}

function toggleAudioAudition(btn, trackName, styleType) {
  const playing = btn.classList.contains("playing");
  stopAllAuditions();
  if (playing) return;
  btn.classList.add("playing");
  const text = btn.querySelector(".btn-text");
  const wave = btn.querySelector(".soundwave-box");
  if (text) text.textContent = "暂停";
  if (wave) wave.classList.remove("hidden");
  playSyntheticChords(styleType);
  $("player-track-name").textContent = `${trackName} · 节奏示意`;
  $("global-player-bar").classList.remove("translate-y-full");
  document.body.classList.add("player-open");
}

function stopAllAuditions() {
  if (referenceAudio) {
    referenceAudio.onended = null;
    referenceAudio.pause();
    referenceAudio = null;
  }
  if (currentSynthInterval) {
    clearInterval(currentSynthInterval);
    currentSynthInterval = null;
  }
  document.querySelectorAll(".btn-audition").forEach((btn) => {
    btn.classList.remove("playing");
    const text = btn.querySelector(".btn-text");
    const wave = btn.querySelector(".soundwave-box");
    if (text) text.textContent = text.dataset.default || "试听";
    if (wave) wave.classList.add("hidden");
  });
  $("global-player-bar").classList.add("translate-y-full");
  document.body.classList.remove("player-open");
}

function armAudition(root) {
  root.querySelectorAll(".btn-audition .btn-text").forEach((node) => {
    if (!node.dataset.default) node.dataset.default = node.textContent;
  });
}

function chip(label, active, attrs) {
  return `<button type="button" ${attrs} class="tag-chip${active ? " active" : ""}">${esc(label)}</button>`;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.classList.remove("translate-y-16", "opacity-0");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.add("translate-y-16", "opacity-0"), 2200);
}

bind();
boot();
