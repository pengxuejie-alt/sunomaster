import crypto from "crypto";
import fs from "fs";
import path from "path";

const PROVIDERS = ["google", "wechat"];
const STATE_MS = 10 * 60 * 1000;

function publicBase() {
  return String(process.env.PUBLIC_URL || "http://127.0.0.1:3800").replace(/\/+$/, "");
}

function redirectUri(provider) {
  return `${publicBase()}/api/auth/oauth/${provider}/callback`;
}

function configured(provider) {
  if (provider === "google") return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  if (provider === "wechat") return Boolean(process.env.WECHAT_APP_ID && process.env.WECHAT_APP_SECRET);
  return false;
}

function readStates(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function writeStates(file, states) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(states)}\n`);
  try {
    fs.renameSync(temp, file);
  } catch {
    fs.copyFileSync(temp, file);
    fs.unlinkSync(temp);
  }
}

function pruneStates(states) {
  const now = Date.now();
  for (const [key, row] of Object.entries(states)) {
    if (!row || row.exp < now) delete states[key];
  }
}

function takeState(file, provider, state) {
  if (!/^[a-f0-9]{32}$/.test(state)) return null;
  const states = readStates(file);
  const row = states[state];
  delete states[state];
  pruneStates(states);
  writeStates(file, states);
  if (!row || row.provider !== provider || row.exp < Date.now()) return null;
  return row;
}

function saveState(file, provider) {
  const states = readStates(file);
  pruneStates(states);
  const state = crypto.randomBytes(16).toString("hex");
  const nonce = crypto.randomBytes(16).toString("hex");
  states[state] = { provider, nonce, exp: Date.now() + STATE_MS };
  writeStates(file, states);
  return { state, nonce };
}

function fail(res, code) {
  const allowed = new Set(["denied", "state", "failed", "google_unconfigured", "wechat_unconfigured"]);
  const safe = allowed.has(code) ? code : "failed";
  res.redirect(303, `/account?auth_error=${safe}`);
}

async function postForm(url, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const error = new Error("token");
    error.code = "failed";
    throw error;
  }
  return data;
}

function verifiedEmail(email, flag) {
  const value = String(email || "").trim().toLowerCase();
  const ok = flag === true || flag === "true";
  return ok && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 120 ? value : "";
}

function authorizeUrl(provider, state, nonce) {
  const redirect = redirectUri(provider);
  if (provider === "google") {
    const query = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: redirect,
      response_type: "code",
      scope: "openid email profile",
      state,
      nonce,
      prompt: "select_account",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${query}`;
  }
  const query = new URLSearchParams({
    appid: process.env.WECHAT_APP_ID,
    redirect_uri: redirect,
    response_type: "code",
    scope: "snsapi_login",
    state,
  });
  return `https://open.weixin.qq.com/connect/qrconnect?${query}#wechat_redirect`;
}

async function profileFrom(provider, code) {
  const redirect = redirectUri(provider);
  if (provider === "google") {
    const token = await postForm("https://oauth2.googleapis.com/token", {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirect,
      grant_type: "authorization_code",
    });
    const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(15000),
    });
    const profile = await response.json().catch(() => ({}));
    if (!response.ok || !profile.sub) {
      const error = new Error("profile");
      error.code = "failed";
      throw error;
    }
    return {
      provider,
      subject: String(profile.sub),
      email: verifiedEmail(profile.email, profile.email_verified),
      name: profile.name || "",
    };
  }
  const query = new URLSearchParams({
    appid: process.env.WECHAT_APP_ID,
    secret: process.env.WECHAT_APP_SECRET,
    code,
    grant_type: "authorization_code",
  });
  const response = await fetch(`https://api.weixin.qq.com/sns/oauth2/access_token?${query}`, { signal: AbortSignal.timeout(15000) });
  const token = await response.json().catch(() => ({}));
  if (!response.ok || token.errcode || !token.openid) {
    const error = new Error("token");
    error.code = "failed";
    throw error;
  }
  let name = "";
  let subject = String(token.unionid || token.openid);
  const infoResponse = await fetch(`https://api.weixin.qq.com/sns/userinfo?access_token=${encodeURIComponent(token.access_token)}&openid=${encodeURIComponent(token.openid)}&lang=zh_CN`, {
    signal: AbortSignal.timeout(15000),
  });
  const profile = await infoResponse.json().catch(() => ({}));
  if (infoResponse.ok && !profile.errcode && profile.openid) {
    subject = String(profile.unionid || profile.openid);
    name = profile.nickname || "";
  }
  return { provider, subject, email: "", name };
}

export function createOAuth(rootDir, signInProvider) {
  const file = path.join(rootDir, "data", "oauth-states.json");

  function start(req, res) {
    const provider = req.params.provider;
    if (!PROVIDERS.includes(provider)) return res.status(404).json({ error: "不支持这个登录方式" });
    if (!configured(provider)) return fail(res, `${provider}_unconfigured`);
    try {
      const { state, nonce } = saveState(file, provider);
      res.redirect(302, authorizeUrl(provider, state, nonce));
    } catch {
      fail(res, "failed");
    }
  }

  async function callback(req, res) {
    const provider = req.params.provider;
    if (!PROVIDERS.includes(provider)) return res.status(404).json({ error: "不支持这个登录方式" });
    const body = req.method === "POST" ? req.body || {} : req.query || {};
    if (body.error) return fail(res, "denied");
    if (!configured(provider)) return fail(res, `${provider}_unconfigured`);
    const code = String(body.code || "");
    if (!code || code.length > 2048) return fail(res, "failed");
    const saved = takeState(file, provider, String(body.state || ""));
    if (!saved) return fail(res, "state");
    try {
      const profile = await profileFrom(provider, code);
      if (!profile.subject) return fail(res, "failed");
      const cookie = signInProvider(profile);
      res.setHeader("Set-Cookie", cookie);
      res.redirect(303, "/account?auth=ok");
    } catch (error) {
      fail(res, error.code || "failed");
    }
  }

  return { start, callback };
}
