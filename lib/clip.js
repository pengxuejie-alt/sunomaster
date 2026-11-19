import { spawn } from "node:child_process";
import { HikoonError } from "./hikoon.js";

const CLIP_SECONDS = 30;

function ffmpeg(args, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { windowsHide: true });
    const out = [];
    const err = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ffmpeg timeout"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() });
    });
  });
}

function samplesFrom(buffer) {
  const count = Math.floor(buffer.length / 4);
  const aligned = buffer.byteOffset % 4 === 0 ? buffer : Buffer.from(buffer);
  return new Float32Array(aligned.buffer, aligned.byteOffset, count);
}

function loudestStart(samples) {
  const rate = 8000;
  const duration = samples.length / rate;
  if (duration < 8) return { start: 0, length: Math.max(1, duration) };
  const length = Math.min(CLIP_SECONDS, duration);
  const seconds = Math.floor(duration);
  const rms = new Float64Array(seconds);
  const frame = rate;
  for (let second = 0; second < seconds; second += 1) {
    let sum = 0;
    const offset = second * frame;
    for (let i = 0; i < frame; i += 1) {
      const value = samples[offset + i] || 0;
      sum += value * value;
    }
    rms[second] = Math.sqrt(sum / frame);
  }
  const span = Math.round(length);
  const from = Math.min(Math.floor(duration * 0.18), Math.max(0, seconds - span));
  const to = Math.max(from, Math.min(seconds - span, Math.floor(duration * 0.72)));
  let best = from;
  let bestScore = -1;
  for (let start = from; start <= to; start += 1) {
    let sum = 0;
    for (let i = 0; i < span; i += 1) sum += rms[start + i] || 0;
    const center = (start + span / 2) / duration;
    const score = (sum / span) * (1 - Math.abs(center - 0.45) * 0.55);
    if (score > bestScore) {
      bestScore = score;
      best = start;
    }
  }
  return { start: best, length: span };
}

async function encodeClip(filePath, start, length) {
  const shared = ["-v", "error", "-ss", String(start), "-t", String(length), "-i", filePath, "-vn", "-ac", "2", "-ar", "44100"];
  const mp3 = await ffmpeg([...shared, "-c:a", "libmp3lame", "-b:a", "192k", "-f", "mp3", "pipe:1"]);
  if (mp3.code === 0 && mp3.stdout.length > 1000) return mp3.stdout;
  const wav = await ffmpeg([...shared, "-c:a", "pcm_s16le", "-f", "wav", "pipe:1"]);
  if (wav.code === 0 && wav.stdout.length > 1000) return wav.stdout;
  throw new HikoonError("副歌片段没有切出来");
}

const chorusCache = new Map();

async function analyze(filePath) {
  let decoded;
  try {
    decoded = await ffmpeg(["-v", "error", "-i", filePath, "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"]);
  } catch (error) {
    if (error.code === "ENOENT") throw new HikoonError("服务器还没有安装音频工具，切不出推广片段");
    throw new HikoonError("副歌片段没有切出来");
  }
  if (decoded.code !== 0 || decoded.stdout.length < 8000) throw new HikoonError("这首歌读不出音频，切不出推广片段");
  const samples = samplesFrom(decoded.stdout);
  const duration = samples.length / 8000;
  const picked = loudestStart(samples);
  return {
    duration: Math.round(duration * 10) / 10,
    start: picked.start,
    length: picked.length,
  };
}

export function suggestChorusClip(filePath, cacheKey = filePath) {
  if (!chorusCache.has(cacheKey)) {
    chorusCache.set(cacheKey, analyze(filePath).catch((error) => {
      chorusCache.delete(cacheKey);
      throw error;
    }));
  }
  return chorusCache.get(cacheKey);
}

export async function cutChorusClip(filePath) {
  const { start, length } = await suggestChorusClip(filePath);
  return encodeClip(filePath, start, length);
}

export async function cutClip(filePath, start, length = CLIP_SECONDS) {
  const safeStart = Math.max(0, Number(start) || 0);
  const safeLength = Math.min(60, Math.max(1, Number(length) || CLIP_SECONDS));
  try {
    return await encodeClip(filePath, safeStart, safeLength);
  } catch (error) {
    if (error instanceof HikoonError) throw new HikoonError("选中的片段没有切出来，换一个起点");
    throw error;
  }
}
