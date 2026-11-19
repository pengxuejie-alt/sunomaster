import crypto from "crypto";
import fs from "fs";
import path from "path";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE = "sm_session";

function readStore(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      users: data.users && typeof data.users === "object" ? data.users : {},
      sessions: data.sessions && typeof data.sessions === "object" ? data.sessions : {},
    };
  } catch {
    return { users: {}, sessions: {} };
  }
}

function writeStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`);
  try {
    fs.renameSync(temp, file);
  } catch {
    fs.copyFileSync(temp, file);
    fs.unlinkSync(temp);
  }
}

function prune(store) {
  const now = Date.now();
  for (const [key, session] of Object.entries(store.sessions)) {
    if (!session || session.expires < now) delete store.sessions[key];
  }
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function displayName(value, email) {
  const cleaned = String(value || "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 24);
  if (cleaned) return cleaned;
  const local = email.split("@")[0].replace(/[^\w\u4e00-\u9fff.-]/g, "").slice(0, 24);
  return local || "制作人";
}

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name };
}

function tokenKey(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function passwordHash(password, salt) {
  return crypto.scryptSync(password, salt, 32);
}

function passwordMatches(user, password) {
  const actual = passwordHash(password, Buffer.from(user.salt, "hex"));
  const expected = Buffer.from(user.hash, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

function cookieHeader(token) {
  const secure = String(process.env.PUBLIC_URL || "").startsWith("https://");
  const base = "HttpOnly; SameSite=Lax; Path=/";
  const secureFlag = secure ? "; Secure" : "";
  if (!token) return `${COOKIE}=; ${base}; Max-Age=0${secureFlag}`;
  return `${COOKIE}=${token}; ${base}; Max-Age=${Math.floor(SESSION_MS / 1000)}${secureFlag}`;
}

function tokenFrom(req) {
  const raw = String(req.headers.cookie || "");
  const found = raw.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
  if (!found) return "";
  try {
    return decodeURIComponent(found.slice(COOKIE.length + 1));
  } catch {
    return "";
  }
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "local";
}

export function createAccounts(rootDir) {
  const file = path.join(rootDir, "data", "accounts.json");
  const attempts = new Map();

  function attemptBlocked(key) {
    const now = Date.now();
    let row = attempts.get(key);
    if (!row || row.reset < now) {
      row = { count: 0, reset: now + 10 * 60 * 1000 };
      attempts.set(key, row);
    }
    if (attempts.size > 1000) {
      for (const [name, item] of attempts) {
        if (item.reset < now) attempts.delete(name);
      }
    }
    return row.count >= 8;
  }

  function recordFailure(key) {
    const row = attempts.get(key);
    if (row) row.count += 1;
  }

  function issueSession(store, user, res) {
    prune(store);
    const token = crypto.randomBytes(32).toString("hex");
    store.sessions[tokenKey(token)] = { userId: user.id, expires: Date.now() + SESSION_MS };
    writeStore(file, store);
    res.setHeader("Set-Cookie", cookieHeader(token));
    res.json({ user: publicUser(user) });
  }

  function credentials(body) {
    const email = normalizeEmail(body?.email);
    const password = String(body?.password || "");
    if (!EMAIL.test(email) || email.length > 120) return { error: "请填写有效的邮箱" };
    if (password.length < 8 || password.length > 72) return { error: "密码至少 8 位" };
    return { email, password };
  }

  function sessionUser(req) {
    try {
      const token = tokenFrom(req);
      if (!/^[0-9a-f]{64}$/.test(token)) return null;
      const store = readStore(file);
      const session = store.sessions[tokenKey(token)];
      if (!session || session.expires < Date.now()) return null;
      const user = Object.values(store.users).find((item) => item && item.id === session.userId);
      return user ? publicUser(user) : null;
    } catch {
      return null;
    }
  }

  function register(req, res) {
    const parsed = credentials(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const limitKey = `register:${clientIp(req)}`;
    if (attemptBlocked(limitKey)) return res.status(429).json({ error: "试得太频繁，请稍后再来" });
    try {
      const store = readStore(file);
      if (store.users[parsed.email]) {
        recordFailure(limitKey);
        return res.status(409).json({ error: "这个邮箱已经注册过了" });
      }
      const salt = crypto.randomBytes(16);
      const user = {
        id: crypto.randomUUID(),
        email: parsed.email,
        name: displayName(req.body?.name, parsed.email),
        salt: salt.toString("hex"),
        hash: passwordHash(parsed.password, salt).toString("hex"),
        createdAt: new Date().toISOString(),
      };
      store.users[parsed.email] = user;
      issueSession(store, user, res);
    } catch {
      res.status(500).json({ error: "账号没有保存下来" });
    }
  }

  function login(req, res) {
    const parsed = credentials(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const limitKey = `login:${clientIp(req)}:${parsed.email}`;
    if (attemptBlocked(limitKey)) return res.status(429).json({ error: "试得太频繁，请稍后再来" });
    try {
      const store = readStore(file);
      const user = store.users[parsed.email];
      if (!user) passwordHash(parsed.password, Buffer.alloc(16, 7));
      if (user && !user.hash) {
        recordFailure(limitKey);
        return res.status(401).json({ error: "这个邮箱是用 Google 或微信登录的" });
      }
      if (!user || !passwordMatches(user, parsed.password)) {
        recordFailure(limitKey);
        return res.status(401).json({ error: "邮箱或密码不正确" });
      }
      attempts.delete(limitKey);
      issueSession(store, user, res);
    } catch {
      res.status(500).json({ error: "暂时没法登录" });
    }
  }

  function logout(req, res) {
    try {
      const token = tokenFrom(req);
      if (/^[0-9a-f]{64}$/.test(token)) {
        const store = readStore(file);
        delete store.sessions[tokenKey(token)];
        prune(store);
        writeStore(file, store);
      }
    } catch { /* 退出时清掉浏览器里的登录态即可 */ }
    res.setHeader("Set-Cookie", cookieHeader(""));
    res.json({ ok: true });
  }

  function me(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.json({ user: req.account || null });
  }

  function findByProvider(store, provider, subject) {
    return Object.values(store.users).find((user) => user?.providers?.[provider] === subject) || null;
  }

  function signInProvider(profile) {
    const provider = profile?.provider;
    const subject = String(profile?.subject || "");
    if (!["google", "wechat"].includes(provider) || subject.length < 1 || subject.length > 255 || /[\s<>]/.test(subject)) {
      const error = new Error("provider");
      error.code = "failed";
      throw error;
    }
    const email = normalizeEmail(profile.email);
    const verified = EMAIL.test(email);
    const store = readStore(file);
    let user = findByProvider(store, provider, subject);
    if (!user && verified) user = store.users[email] || null;
    if (!user) {
      const key = verified ? email : `${provider}:${subject}`;
      user = {
        id: crypto.randomUUID(),
        email: verified ? email : "",
        name: displayName(profile.name, verified ? email : ""),
        salt: "",
        hash: "",
        providers: { [provider]: subject },
        createdAt: new Date().toISOString(),
      };
      store.users[key] = user;
    } else {
      user.providers = user.providers && typeof user.providers === "object" ? user.providers : {};
      user.providers[provider] = subject;
      if (verified && !user.email) user.email = email;
      if (profile.name && (!user.name || user.name === "制作人")) user.name = displayName(profile.name, user.email || email);
    }
    prune(store);
    const token = crypto.randomBytes(32).toString("hex");
    store.sessions[tokenKey(token)] = { userId: user.id, expires: Date.now() + SESSION_MS };
    writeStore(file, store);
    return cookieHeader(token);
  }

  return { register, login, logout, me, sessionUser, signInProvider };
}
