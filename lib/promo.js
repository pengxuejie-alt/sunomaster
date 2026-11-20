import crypto from "crypto";
import fs from "fs";
import path from "path";
import { listLibrary } from "./publish.js";
import {
  PromoError,
  UNBOUND,
  buildPrompt,
  createVideoProviders,
  parsePromoRequest,
  requireSuno,
} from "./video-provider.js";

const jobs = new Map();

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function readSunoBinding(rootDir, userId) {
  const id = String(userId || "");
  if (!id) return null;
  const fromFile = readJson(path.join(rootDir, "data", "suno-bindings.json"));
  const row = fromFile && typeof fromFile === "object" ? fromFile[id] : null;
  const account = readJson(path.join(rootDir, "data", "accounts.json"));
  const user = Object.values(account?.users || {}).find((item) => item?.id === id);
  const saved = row || user?.suno || null;
  if (!saved || typeof saved !== "object") return null;
  const status = String(saved.status || "connected");
  if (status === "expired" || status === "disconnected") return null;
  const token = String(saved.accessToken || saved.token || saved.cookie || "").trim();
  if (!token) return null;
  return { token, name: String(saved.name || saved.email || "") };
}

function publicJob(job) {
  return {
    id: job.id,
    aspect: job.aspect,
    label: job.label,
    provider: job.provider,
    status: job.status,
    url: job.url || "",
    error: job.error || "",
  };
}

function songName(rootDir, songId, listSongs) {
  if (!songId) return "";
  const songs = listSongs(rootDir);
  const song = songs.find((item) => item.id === songId);
  if (!song) throw new PromoError("曲库里没有这首歌。");
  return song.name || "";
}

export function createPromoApi(options) {
  const rootDir = options.rootDir;
  const sessionUser = options.sessionUser || (() => null);
  const providers = options.providers || createVideoProviders();
  const listSongs = options.listSongs || listLibrary;
  const store = options.jobs || jobs;

  function binding(req) {
    return readSunoBinding(rootDir, sessionUser(req)?.id);
  }

  function songs(_req, res) {
    const list = listSongs(rootDir).map((song) => ({ id: song.id, name: song.name }));
    res.json({ ok: true, songs: list });
  }

  async function create(req, res) {
    try {
      const parsed = parsePromoRequest(req.body || {});
      const name = songName(rootDir, parsed.songId, listSongs);
      const suno = binding(req);
      requireSuno(suno?.token);
      const prompt = buildPrompt({ picture: parsed.picture, lyrics: parsed.lyrics, songName: name });
      const created = [];
      for (const item of parsed.aspects) {
        const job = {
          id: crypto.randomUUID(),
          aspect: item.aspect,
          label: item.label,
          provider: "suno",
          status: "submitted",
          url: "",
          error: "",
          remoteId: "",
          token: suno.token,
        };
        try {
          const started = await providers.start({
            token: job.token,
            prompt,
            aspect: item.aspect,
          });
          job.remoteId = started.remoteId || "";
          job.status = started.status || "submitted";
          job.url = started.url || "";
        } catch (error) {
          job.status = "failed";
          job.error = error.message || "没有生成";
        }
        store.set(job.id, job);
        created.push(publicJob(job));
      }
      res.json({ ok: true, provider: "suno", jobs: created });
    } catch (error) {
      const status = error instanceof PromoError ? error.status : 500;
      res.status(status).json({ ok: false, error: error.message || UNBOUND });
    }
  }

  async function job(req, res) {
    const current = store.get(String(req.params.id || ""));
    if (!current) return res.status(404).json({ ok: false, error: "没有这次生成。" });
    if (current.remoteId && current.status !== "succeeded" && current.status !== "failed") {
      try {
        const next = await providers.poll({
          token: current.token,
          remoteId: current.remoteId,
        });
        current.status = next.status || current.status;
        if (next.url) current.url = next.url;
        if (next.error) current.error = next.error;
      } catch (error) {
        current.status = "failed";
        current.error = error.message || "没有查到生成结果。";
      }
    }
    res.json({ ok: true, job: publicJob(current) });
  }

  return { songs, create, job };
}

export function mountPromo(app, rootDir, accounts) {
  const api = createPromoApi({
    rootDir,
    sessionUser: (req) => accounts.sessionUser(req),
  });
  app.get("/api/promo/songs", api.songs);
  app.post("/api/promo", api.create);
  app.get("/api/promo/jobs/:id", api.job);
}
