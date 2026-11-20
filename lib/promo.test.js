import assert from "node:assert/strict";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import test from "node:test";
import { createPromoApi } from "./promo.js";
import {
  UNBOUND,
  buildPrompt,
  createVideoProviders,
  parsePromoRequest,
  requireSuno,
} from "./video-provider.js";

test("one prompt per aspect, about 5 seconds, no storyboard", () => {
  const parsed = parsePromoRequest({
    prompt: "雨夜的街头，一个人走路",
    lyrics: "暖色路灯",
    landscape: true,
    portrait: true,
  });
  assert.deepEqual(parsed.aspects.map((item) => item.aspect), ["16:9", "9:16"]);
  const prompt = buildPrompt({ picture: parsed.picture, lyrics: parsed.lyrics, songName: "晚风" });
  assert.match(prompt, /雨夜的街头/);
  assert.match(prompt, /大约 5 秒/);
  assert.doesNotMatch(prompt, /storyboard|分镜|可灵|kling/i);
  assert.throws(() => parsePromoRequest({ prompt: "", landscape: true }), /先写画面/);
  assert.throws(() => parsePromoRequest({ prompt: "画面", landscape: false, portrait: false }), /横屏或竖屏/);
});

test("unbound suno is a visible error", () => {
  assert.throws(() => requireSuno(""), (error) => error.status === 503 && error.message === UNBOUND);
  assert.equal(requireSuno("session-token"), "suno");
});

test("bound suno sends one 5 second clip per aspect", async () => {
  const calls = [];
  const providers = createVideoProviders({
    env: { SUNO_API_BASE: "https://suno.example/a" },
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : null, authorization: init.headers.Authorization });
      return new Response(JSON.stringify({ id: "clip-1", status: "submitted" }), { status: 200 });
    },
  });
  const started = await providers.start({ token: "bound-token", prompt: "雨夜", aspect: "9:16" });
  assert.equal(started.remoteId, "clip-1");
  assert.equal(calls[0].url, "https://suno.example/a/api/video/generate/");
  assert.equal(calls[0].authorization, "Bearer bound-token");
  assert.equal(calls[0].body.duration, 5);
  assert.equal(calls[0].body.aspect_ratio, "9:16");
  assert.equal(calls[0].body.prompt, "雨夜");
  assert.equal(calls[0].body.storyboard, undefined);
});

test("click route says Suno is not bound", async () => {
  const app = express();
  app.use(express.json());
  const api = createPromoApi({
    rootDir: "/tmp/promo-empty",
    sessionUser: () => null,
    providers: createVideoProviders({ env: {}, fetchImpl: async () => { throw new Error("should not call"); } }),
    listSongs: () => [],
    jobs: new Map(),
  });
  app.post("/api/promo", api.create);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/promo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "雨夜的街头", landscape: true, portrait: false }),
    });
    const data = await response.json();
    assert.equal(response.status, 503);
    assert.equal(data.ok, false);
    assert.equal(data.error, UNBOUND);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a bound account starts one job per checked ratio", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "promo-suno-"));
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "suno-bindings.json"), JSON.stringify({
    user: { accessToken: "bound-token", status: "connected", name: "晚风" },
  }));
  const calls = [];
  const app = express();
  app.use(express.json());
  const api = createPromoApi({
    rootDir: root,
    sessionUser: () => ({ id: "user" }),
    providers: createVideoProviders({
      env: { SUNO_API_BASE: "https://suno.example/a" },
      fetchImpl: async (url, init) => {
        calls.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ id: `job-${calls.length}`, status: "submitted" }), { status: 200 });
      },
    }),
    listSongs: () => [],
    jobs: new Map(),
  });
  app.post("/api/promo", api.create);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/promo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "雨夜的街头", landscape: true, portrait: true }),
    });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.provider, "suno");
    assert.equal(data.jobs.length, 2);
    assert.deepEqual(calls.map((body) => body.aspect_ratio), ["16:9", "9:16"]);
    assert.ok(calls.every((body) => body.duration === 5));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
