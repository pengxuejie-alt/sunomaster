import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "crypto";

const DEFAULT_BASE = "https://mind.hikoon.com";
const keyScope = new AsyncLocalStorage();

export function withHikoonKey(key, fn) {
  return keyScope.run(String(key || "").trim(), fn);
}

function activeKey() {
  const scoped = keyScope.getStore();
  if (scoped) return scoped;
  return String(process.env.HIKOON_SECRET_KEY || "").trim();
}

export function hikoonUsingCustomKey() {
  return Boolean(keyScope.getStore());
}

export function hikoonKeyTag() {
  const key = activeKey();
  if (!key) return "none";
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);
}

export class HikoonError extends Error {
  constructor(message, code = -1) {
    super(message);
    this.name = "HikoonError";
    this.code = code;
  }
}

function baseUrl() {
  return String(process.env.HIKOON_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
}

function secret() {
  const key = activeKey();
  if (!key) throw new HikoonError("还没有填写海葵密钥", 401);
  return key;
}

export function hikoonConfigured() {
  return Boolean(activeKey());
}

export function contractUrl(token) {
  return `${baseUrl()}/contract?t=${encodeURIComponent(token)}`;
}

export function verifyUrl() {
  return `${baseUrl()}/account/verify`;
}

async function readBody(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HikoonError(text.slice(0, 180) || "海葵返回了无法解析的内容", response.status);
  }
}

export async function hikoonRequest(method, pathname, { query, body, form, timeoutMs = 60000 } = {}) {
  const url = new URL(baseUrl() + pathname);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }
  const headers = { Authorization: `Bearer ${secret()}`, Accept: "application/json" };
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new HikoonError(error?.name === "TimeoutError" ? "海葵接口超时" : (error.message || "海葵接口连不上"));
  }
  const json = await readBody(response);
  if (!response.ok || json.code !== 0) {
    throw new HikoonError(json.message || `海葵接口失败（${response.status}）`, json.code ?? response.status);
  }
  return json.data;
}

export function hikoonGet(pathname, query) {
  return hikoonRequest("GET", pathname, { query });
}

export function hikoonPost(pathname, body) {
  return hikoonRequest("POST", pathname, { body: body ?? {} });
}

export async function uploadBuffer(type, filename, buffer) {
  const form = new FormData();
  form.append("type", type);
  form.append("file", new Blob([buffer]), filename || "file");
  const data = await hikoonRequest("POST", "/open-api/upload/file", { form, timeoutMs: 180000 });
  const fileId = Number(data?.file_id);
  if (!Number.isFinite(fileId) || fileId <= 0) throw new HikoonError("物料上传没有返回文件编号");
  return { ...data, file_id: fileId };
}
