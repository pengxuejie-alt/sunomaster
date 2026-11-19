import { spawn } from "child_process";
import crypto from "crypto";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createAccounts } from "./lib/accounts.js";
import { createOAuth } from "./lib/oauth.js";
import { createBilling } from "./lib/billing.js";
import { hikoonConfigured } from "./lib/hikoon.js";
import { mountPublish } from "./lib/publish.js";
import { GEMINI_MODEL, geminiComplete, readGeminiKey } from "./lib/gemini.js";
import { hotSnapshotJson, loadChartBoard, loadDispatch, startDispatchSchedule } from "./lib/dispatch.js";
import { findLyrics } from "./lib/lyrics.js";
import { pingTrend } from "./lib/trend.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3800;
const HOST = process.env.HOST || "127.0.0.1";
const HINT_DIR = process.env.HINT_DIR || "D:\\hint";
const LYRIC_DIR = process.env.LYRIC_DIR || "D:\\lyricmaster\\web";
const HINT_PORT = Number(process.env.HINT_PORT) || 3781;
const LYRIC_PORT = Number(process.env.LYRIC_PORT) || 8766;
const INTERNAL_TOKEN = crypto.randomBytes(24).toString("hex");
const geminiKey = readGeminiKey(__dirname);
const VISIT_FILE = path.join(__dirname, "data", "visits.json");
const VISIT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function loadVisits() {
  try {
    const data = JSON.parse(fs.readFileSync(VISIT_FILE, "utf8"));
    const ids = Array.isArray(data.ids) ? data.ids : [];
    return new Set(ids.map((id) => String(id).toLowerCase()).filter((id) => VISIT_ID.test(id)));
  } catch {
    return new Set();
  }
}

const visits = loadVisits();

function saveVisits() {
  try {
    fs.mkdirSync(path.dirname(VISIT_FILE), { recursive: true });
    const payload = `${JSON.stringify({ count: visits.size, ids: [...visits] })}\n`;
    const tmp = `${VISIT_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, payload);
    try {
      fs.renameSync(tmp, VISIT_FILE);
    } catch {
      fs.copyFileSync(tmp, VISIT_FILE);
      fs.unlinkSync(tmp);
    }
  } catch (error) {
    console.warn(`[sunomaster] 访客计数没写上：${error.message}`);
  }
}

function loadEnv(file) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv(path.join(__dirname, ".env"));
loadEnv(process.env.TREND_ENV || "C:\\Users\\XIAO KA\\trend\\.env.local");

const billing = createBilling(__dirname);
const accounts = createAccounts(__dirname);
const oauth = createOAuth(__dirname, accounts.signInProvider);

function withAccount(handler) {
  return (req, res) => {
    req.account = accounts.sessionUser(req);
    return handler(req, res);
  };
}
const children = [];

function startEngine(name, command, args, cwd, env) {
  if (!fs.existsSync(cwd)) {
    console.warn(`[sunomaster] ${name} 目录不存在：${cwd}`);
    return null;
  }
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = `[${name}] `;
  child.stdout.on("data", (chunk) => process.stdout.write(prefix + chunk.toString()));
  child.stderr.on("data", (chunk) => process.stderr.write(prefix + chunk.toString()));
  child.on("exit", (code) => console.warn(`[sunomaster] ${name} 退出 ${code}`));
  children.push(child);
  return child;
}

startEngine("hint", process.execPath, ["server.js"], HINT_DIR, {
  PORT: String(HINT_PORT),
  HOST: "127.0.0.1",
  BASE_PATH: "",
});
startEngine("lyric", process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"), ["server.py"], LYRIC_DIR, {
  PORT: String(LYRIC_PORT),
  HOST: "127.0.0.1",
  PYTHONUNBUFFERED: "1",
  PYTHONIOENCODING: "utf-8",
});

function stopChildren() {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
}
process.on("exit", stopChildren);
process.on("SIGINT", () => { stopChildren(); process.exit(0); });
process.on("SIGTERM", () => { stopChildren(); process.exit(0); });

function wantsBailian(body) {
  const engine = String(body?.engine || body?.provider || "gemini").toLowerCase();
  return engine === "bailian" || engine === "qwen" || engine === "dashscope";
}

async function forward(port, targetPath, req, res, timeoutMs) {
  const url = `http://127.0.0.1:${port}${targetPath}`;
  try {
    const response = await fetch(url, {
      method: req.method,
      headers: { "Content-Type": "application/json" },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    res.status(response.status);
    res.type(response.headers.get("content-type") || "application/json");
    res.send(text);
  } catch (error) {
    const down = error?.cause?.code === "ECONNREFUSED" || error?.name === "TimeoutError";
    res.status(down ? 503 : 502).json({
      error: down ? "这个模块还在启动，请稍后再试。" : (error.message || "转发失败"),
    });
  }
}

const app = express();
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), billing.webhook);
app.use(express.json({ limit: "40mb" }));
app.use(express.urlencoded({ extended: false }));

app.post("/api/stripe/checkout", withAccount(billing.checkout));
app.post("/api/stripe/portal", withAccount(billing.portal));
app.get("/api/stripe/status", withAccount(billing.status));
app.get("/api/stripe/catalog", billing.catalog);
app.post("/api/stripe/invoices", billing.createInvoice);
app.post("/api/auth/register", accounts.register);
app.post("/api/auth/login", accounts.login);
app.post("/api/auth/logout", accounts.logout);
app.get("/api/auth/me", withAccount(accounts.me));
app.get("/api/auth/oauth/:provider", oauth.start);
app.get("/api/auth/oauth/:provider/callback", oauth.callback);
app.post("/api/auth/oauth/:provider/callback", oauth.callback);

app.get("/api/health", async (_req, res) => {
  const probe = async (url) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      return response.ok;
    } catch {
      return false;
    }
  };
  const [trendResult, hint, lyric] = await Promise.all([
    pingTrend()
      .then((result) => ({ ok: result.ok, error: "" }))
      .catch((error) => ({ ok: false, error: error.message || "数据库连不上" })),
    probe(`http://127.0.0.1:${HINT_PORT}/api/health`),
    probe(`http://127.0.0.1:${LYRIC_PORT}/api/tongues`),
  ]);
  res.json({
    ok: true,
    hint,
    lyric,
    trend: trendResult.ok,
    trendError: trendResult.error,
    engine: "gemini",
    model: GEMINI_MODEL,
    gemini: Boolean(geminiKey),
    stripe: Boolean(process.env.STRIPE_SECRET_KEY),
    hikoon: hikoonConfigured(),
  });
});

app.post("/api/visit", (req, res) => {
  const id = String(req.body?.id || "").trim().toLowerCase();
  res.setHeader("Cache-Control", "no-store");
  if (VISIT_ID.test(id) && !visits.has(id)) {
    visits.add(id);
    saveVisits();
  }
  res.json({ count: visits.size });
});

app.get("/api/engine", (_req, res) => {
  res.json({
    defaultProvider: "gemini",
    model: GEMINI_MODEL,
    gemini: Boolean(geminiKey),
    bailian: true,
  });
});

app.get("/api/charts", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=1800");
  try {
    const data = loadDispatch();
    res.json(data || { ok: false, pending: true });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message || "读不到榜单。" });
  }
});

app.get("/api/chart", async (req, res) => {
  try {
    const data = await loadChartBoard(String(req.query.platform || ""), String(req.query.code || ""));
    res.json(data);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "读不到这张榜。" });
  }
});

app.get("/api/lyrics", async (req, res) => {
  try {
    const data = await findLyrics(req.query.song, req.query.artist);
    res.json({ ok: true, lyrics: data.lyrics, matched: data.matched });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message || "原词没搜到" });
  }
});

app.post("/api/generate", (req, res) => {
  const body = req.body || {};
  if (!wantsBailian(body)) {
    body.provider = "gemini";
    body.apiKey = geminiKey;
    body.model = GEMINI_MODEL;
  }
  req.body = body;
  return forward(HINT_PORT, "/api/generate", req, res, 200000);
});

app.post("/api/ping", (req, res) => {
  const body = req.body || {};
  if (!wantsBailian(body)) {
    body.provider = "gemini";
    body.apiKey = geminiKey;
    body.model = GEMINI_MODEL;
  }
  req.body = body;
  return forward(HINT_PORT, "/api/ping", req, res, 35000);
});

app.post("/compat/v1/chat/completions", async (req, res) => {
  const header = String(req.headers.authorization || "");
  if (header !== `Bearer ${INTERNAL_TOKEN}`) {
    return res.status(404).json({ error: { message: "not found" } });
  }
  try {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const system = messages.filter((item) => item.role === "system").map((item) => String(item.content || "")).join("\n\n");
    const dialog = messages.filter((item) => item.role === "user" || item.role === "assistant");
    const last = dialog.pop();
    const result = await geminiComplete({
      apiKey: geminiKey,
      model: GEMINI_MODEL,
      system,
      userText: String(last?.content || ""),
      history: dialog,
      json: req.body?.response_format?.type === "json_object",
      maxTokens: 8192,
      thinkingLevel: req.body?.thinking_level || "high",
    });
    res.json({
      choices: [{
        message: {
          role: "assistant",
          content: result.text,
          reasoning_content: result.thoughts || "",
        },
      }],
    });
  } catch (error) {
    res.status(error.status || 502).json({ error: { message: error.message || "Gemini 失败" } });
  }
});

app.use((req, _res, next) => {
  req.account = accounts.sessionUser(req);
  next();
});

mountPublish(app, __dirname);

app.use("/api/lyric", async (req, res) => {
  const lyricPath = String(req.url || "").split("?")[0];
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
    if (!wantsBailian(req.body)) {
      req.body.api = {
        base: `http://127.0.0.1:${PORT}/compat/v1`,
        model: GEMINI_MODEL,
        key: INTERNAL_TOKEN,
      };
    }
  }
  const target = `/api${req.url.startsWith("/") ? req.url : `/${req.url}`}`;
  return forward(LYRIC_PORT, target, req, res, 180000);
});

function sendHome(_req, res) {
  const file = path.join(__dirname, "public", "index.html");
  const html = fs.readFileSync(file, "utf8").replace("/*HOT_SNAPSHOT*/", `window.__hotSnapshot=${hotSnapshotJson()};`);
  res.setHeader("Cache-Control", "no-cache");
  res.type("html").send(html);
}

app.get(["/", "/account", "/login", "/pricing"], sendHome);

app.use(express.static(path.join(__dirname, "public"), {
  index: false,
  setHeaders(res, filePath) {
    const cacheable = filePath.endsWith(`${path.sep}hot.json`);
    res.setHeader("Cache-Control", cacheable ? "public, max-age=1800" : "no-cache");
  },
}));

app.listen(PORT, HOST, () => {
  console.log(`[sunomaster] http://${HOST}:${PORT}`);
  console.log(`[sunomaster] engine=gemini model=${GEMINI_MODEL} key=${geminiKey ? "yes" : "missing"}`);
  startDispatchSchedule();
});
