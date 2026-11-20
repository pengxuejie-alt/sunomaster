const SUNO_BASE = "https://suno.com/a";

export const UNBOUND = "还没有绑定 Suno 的视频工具。";

export class PromoError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function clean(value, max) {
  return String(value || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
}

export function buildPrompt({ picture, lyrics, songName }) {
  const lines = [clean(picture, 800)];
  const song = clean(songName, 80);
  const words = clean(lyrics, 400);
  if (song) lines.push(`歌曲：${song}`);
  if (words) lines.push(`歌词：${words}`);
  lines.push("一个镜头，大约 5 秒。");
  return lines.filter(Boolean).join("\n").slice(0, 2000);
}

export function parsePromoRequest(body) {
  const picture = clean(body?.prompt, 800);
  const lyrics = clean(body?.lyrics, 400);
  const songId = clean(body?.songId, 64);
  const landscape = Boolean(body?.landscape);
  const portrait = Boolean(body?.portrait);
  if (!picture) throw new PromoError("先写画面。");
  if (!landscape && !portrait) throw new PromoError("至少勾选横屏或竖屏。");
  const aspects = [];
  if (landscape) aspects.push({ aspect: "16:9", label: "横屏 16:9" });
  if (portrait) aspects.push({ aspect: "9:16", label: "竖屏 9:16" });
  return { picture, lyrics, songId, aspects };
}

export function requireSuno(token) {
  if (!clean(token, 4000)) throw new PromoError(UNBOUND, 503);
  return "suno";
}

function mapStatus(status) {
  const value = String(status || "").toLowerCase();
  if (["succeed", "succeeded", "success", "completed", "complete"].includes(value)) return "succeeded";
  if (["failed", "error", "cancelled", "canceled"].includes(value)) return "failed";
  if (value === "processing" || value === "running") return "processing";
  return "submitted";
}

async function readJson(response) {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 180) };
  }
}

function failMessage(data, fallback) {
  const message = data?.detail || data?.message || data?.error || data?.msg;
  if (typeof message === "string" && message.trim()) return message.trim().slice(0, 180);
  return fallback;
}

function videoUrl(value) {
  const url = String(value || "");
  return /^https?:\/\//i.test(url) ? url : "";
}

export function createVideoProviders(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;

  function sunoBase() {
    return String(env.SUNO_API_BASE || SUNO_BASE).replace(/\/+$/, "");
  }

  function sunoHeaders(token) {
    const headers = {
      "Content-Type": "application/json",
      Origin: "https://suno.com",
      Referer: "https://suno.com/",
    };
    if (/^cookie\s+/i.test(token)) headers.Cookie = token.replace(/^cookie\s+/i, "");
    else headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async function start({ token, prompt, aspect }) {
    requireSuno(token);
    const response = await fetchImpl(`${sunoBase()}/api/video/generate/`, {
      method: "POST",
      headers: sunoHeaders(token),
      body: JSON.stringify({
        prompt,
        aspect_ratio: aspect,
        duration: 5,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await readJson(response);
    if (!response.ok) throw new PromoError(failMessage(data, "Suno 视频工具没有接受这次生成。"), 502);
    const payload = data.data && typeof data.data === "object" ? data.data : data;
    const remoteId = String(payload.id || payload.clip_id || payload.task_id || data.id || "");
    const url = videoUrl(payload.video_url || payload.videoUrl || payload.url);
    if (!remoteId && !url) throw new PromoError(failMessage(data, "Suno 视频工具没有返回任务。"), 502);
    return { remoteId, status: url ? "succeeded" : mapStatus(payload.status), url };
  }

  async function poll({ token, remoteId }) {
    requireSuno(token);
    if (!remoteId) return { status: "failed", url: "", error: "Suno 视频工具没有返回任务。" };
    const response = await fetchImpl(`${sunoBase()}/api/video/generate/${encodeURIComponent(remoteId)}/status/`, {
      headers: sunoHeaders(token),
      signal: AbortSignal.timeout(20000),
    });
    const data = await readJson(response);
    if (!response.ok) throw new PromoError(failMessage(data, "Suno 视频任务没有查到。"), 502);
    const payload = data.data && typeof data.data === "object" ? data.data : data;
    const url = videoUrl(payload.video_url || payload.videoUrl || payload.url);
    const status = url ? "succeeded" : mapStatus(payload.status);
    return {
      status,
      url,
      error: status === "failed" ? failMessage(payload, "Suno 视频生成失败。") : "",
    };
  }

  return { start, poll };
}
