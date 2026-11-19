import fs from "fs";
import path from "path";

export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

export function readGeminiKey(root) {
  const file = process.env.GEMINI_KEY_FILE || path.join(root, "key.txt");
  try {
    const key = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").trim();
    if (key) return key;
  } catch {
    /* 服务器上的密钥文件不存在时再看环境变量 */
  }
  return String(process.env.GEMINI_API_KEY || "").trim();
}

export async function geminiComplete({
  apiKey,
  model = GEMINI_MODEL,
  system = "",
  userText = "",
  history = [],
  json = false,
  maxTokens = 8192,
  timeoutMs = 120000,
  thinkingLevel = "high",
}) {
  if (!apiKey) {
    const error = new Error("服务器上没有 Gemini 密钥。请把密钥放进 key.txt。");
    error.status = 400;
    throw error;
  }
  const contents = [];
  for (const item of history || []) {
    const text = String(item?.content || "").trim();
    if (!text || (item.role !== "user" && item.role !== "assistant")) continue;
    contents.push({
      role: item.role === "assistant" ? "model" : "user",
      parts: [{ text: text.slice(0, 8000) }],
    });
  }
  contents.push({ role: "user", parts: [{ text: String(userText || "").slice(0, 30000) }] });
  const generationConfig = {
    maxOutputTokens: maxTokens,
    thinkingConfig: { thinkingLevel: thinkingLevel || "high" },
  };
  if (json) generationConfig.responseMimeType = "application/json";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        contents,
        generationConfig,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
    const wrapped = new Error(timedOut ? "Gemini 响应超时，请再试一次。" : "连不上 Gemini。");
    wrapped.status = 502;
    throw wrapped;
  }
  let body = {};
  try {
    body = await response.json();
  } catch {
    const wrapped = new Error("Gemini 返回的不是 JSON。");
    wrapped.status = 502;
    throw wrapped;
  }
  if (!response.ok) {
    const detail = String(body.error?.message || "").replace(/\s+/g, " ").trim().slice(0, 240);
    const wrapped = new Error(detail || `Gemini 返回 ${response.status}`);
    wrapped.status = response.status === 400 || response.status === 404 ? 400 : response.status === 401 || response.status === 403 ? 401 : 502;
    throw wrapped;
  }
  const parts = body.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((part) => part.text && !part.thought).map((part) => part.text).join("\n").trim();
  const thoughts = parts.filter((part) => part.thought && part.text).map((part) => part.text).join("\n").trim();
  if (!text) {
    const reason = body.promptFeedback?.blockReason || body.candidates?.[0]?.finishReason || "";
    const wrapped = new Error(reason ? `Gemini 没有返回正文（${reason}）。` : "Gemini 没有返回正文。");
    wrapped.status = 502;
    throw wrapped;
  }
  return { text, thoughts };
}

const IMAGE_MODELS = ["gemini-nano-banana-2.1", "gemini-3.1-flash-lite-image", "gemini-3.1-flash-image"];

function imageModels() {
  const preferred = String(process.env.GEMINI_IMAGE_MODEL || "").trim();
  return [...new Set([preferred, ...IMAGE_MODELS].filter(Boolean))];
}

async function requestImage(apiKey, model, prompt, timeoutMs, withConfig) {
  const generationConfig = { responseModalities: ["IMAGE"] };
  if (withConfig) generationConfig.imageConfig = { aspectRatio: "1:1", imageSize: "1K" };
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
    const wrapped = new Error(timedOut ? "封面生成超时，请再试一次。" : "连不上 Gemini。");
    wrapped.status = 502;
    throw wrapped;
  }
  let body = {};
  try {
    body = await response.json();
  } catch {
    const wrapped = new Error("封面接口返回的不是 JSON。");
    wrapped.status = 502;
    throw wrapped;
  }
  if (!response.ok) {
    const detail = String(body.error?.message || "").replace(/\s+/g, " ").trim().slice(0, 240);
    const wrapped = new Error(detail || `封面接口返回 ${response.status}`);
    wrapped.status = response.status;
    throw wrapped;
  }
  const parts = body.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((part) => part.inlineData?.data || part.inline_data?.data);
  const blob = imagePart?.inlineData || imagePart?.inline_data;
  if (!blob?.data) {
    const reason = body.promptFeedback?.blockReason || body.candidates?.[0]?.finishReason || "";
    const wrapped = new Error(reason ? `没有生成出封面（${reason}）。` : "没有生成出封面。");
    wrapped.status = 502;
    throw wrapped;
  }
  const mimeType = String(blob.mimeType || blob.mime_type || "image/png").toLowerCase();
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") {
    const wrapped = new Error("生成的封面不是 jpg 或 png。");
    wrapped.status = 502;
    throw wrapped;
  }
  return { mimeType, data: Buffer.from(blob.data, "base64") };
}

export async function geminiImage({ apiKey, prompt, timeoutMs = 90000 }) {
  if (!apiKey) {
    const error = new Error("服务器上没有 Gemini 密钥，生成不了封面。");
    error.status = 400;
    throw error;
  }
  let lastError = null;
  for (const model of imageModels()) {
    for (const withConfig of [true, false]) {
      try {
        return await requestImage(apiKey, model, prompt, timeoutMs, withConfig);
      } catch (error) {
        lastError = error;
        if (error.status === 404) break;
        if (withConfig && error.status === 400) continue;
        if (error.status === 404 || error.status === 400) continue;
        throw error;
      }
    }
  }
  throw lastError || new Error("封面模型暂时不可用。");
}
