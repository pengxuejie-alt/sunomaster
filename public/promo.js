function promoNode(id) {
  return document.getElementById(id);
}

function promoEsc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function promoUrl(value) {
  return /^https?:\/\//i.test(String(value || "")) ? String(value) : "";
}

let promoBound = false;
let promoPollTimer = 0;

function setPromoStatus(text, tone) {
  const node = promoNode("promo-status");
  if (!node) return;
  node.textContent = text;
  node.className = tone === "bad"
    ? "text-sm font-semibold text-rose-600"
    : "text-sm text-slate-500";
}

function renderPromoJobs(jobs) {
  const box = promoNode("promo-results");
  if (!box) return;
  box.innerHTML = jobs.map((job) => {
    const url = promoUrl(job.url);
    const media = url
      ? `<video class="mt-2 w-full rounded-xl bg-black" controls playsinline src="${promoEsc(url)}"></video>`
      : "";
    const detail = job.error
      ? `<p class="mt-1 text-sm font-semibold text-rose-600">${promoEsc(job.error)}</p>`
      : `<p class="mt-1 text-sm text-slate-500">${job.status === "succeeded" ? "好了" : "正在生成…"}</p>`;
    return `<article class="rounded-xl border border-slate-200 p-3" data-promo-job="${promoEsc(job.id)}">
      <div class="text-sm font-bold text-slate-800">${promoEsc(job.label)}</div>
      ${detail}
      ${media}
    </article>`;
  }).join("");
}

async function pollPromoJobs(jobs) {
  window.clearInterval(promoPollTimer);
  const pending = new Map(jobs.filter((job) => job.status !== "succeeded" && job.status !== "failed").map((job) => [job.id, job]));
  if (!pending.size) return;
  const tick = async () => {
    for (const [id, job] of pending) {
      try {
        const response = await fetch(`/api/promo/jobs/${encodeURIComponent(id)}`, { cache: "no-store" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.job) {
          job.status = "failed";
          job.error = data.error || "没有查到生成结果。";
        } else {
          Object.assign(job, data.job);
        }
      } catch {
        job.status = "failed";
        job.error = "没有查到生成结果。";
      }
      if (job.status === "succeeded" || job.status === "failed") pending.delete(id);
    }
    renderPromoJobs(jobs);
    if (!pending.size) window.clearInterval(promoPollTimer);
  };
  await tick();
  if (pending.size) promoPollTimer = window.setInterval(tick, 3000);
}

async function fillPromoSongs() {
  const select = promoNode("promo-song");
  if (!select || select.dataset.loaded === "1") return;
  try {
    const response = await fetch("/api/promo/songs", { cache: "no-store" });
    const data = await response.json();
    const current = select.value;
    const options = [`<option value="">不选，自己写</option>`]
      .concat((data.songs || []).map((song) => `<option value="${promoEsc(song.id)}">${promoEsc(song.name)}</option>`));
    select.innerHTML = options.join("");
    if ([...select.options].some((option) => option.value === current)) select.value = current;
    select.dataset.loaded = "1";
  } catch {
    setPromoStatus("曲库暂时没读出来，仍可以自己写画面。", "bad");
  }
}

async function makePromo() {
  const button = promoNode("promo-make");
  const prompt = promoNode("promo-prompt")?.value.trim() || "";
  const lyrics = promoNode("promo-lyrics")?.value.trim() || "";
  const landscape = Boolean(promoNode("promo-land")?.checked);
  const portrait = Boolean(promoNode("promo-port")?.checked);
  const songId = promoNode("promo-song")?.value || "";
  if (!prompt) {
    setPromoStatus("先写画面。", "bad");
    return;
  }
  if (!landscape && !portrait) {
    setPromoStatus("至少勾选横屏或竖屏。", "bad");
    return;
  }
  if (button) button.disabled = true;
  setPromoStatus("正在提交，每条约 5 秒…");
  const results = promoNode("promo-results");
  if (results) results.innerHTML = "";
  try {
    const response = await fetch("/api/promo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, lyrics, landscape, portrait, songId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || "没有生成");
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    const failed = jobs.filter((job) => job.status === "failed");
    if (jobs.length && failed.length === jobs.length) setPromoStatus(failed[0].error || "没有生成", "bad");
    else setPromoStatus("已交给绑定的 Suno 视频工具，正在生成…");
    renderPromoJobs(jobs);
    await pollPromoJobs(jobs);
  } catch (error) {
    setPromoStatus(error.message || "没有生成", "bad");
  } finally {
    if (button) button.disabled = false;
  }
}

function bootPromo() {
  fillPromoSongs();
  const button = promoNode("promo-make");
  if (!button || promoBound) return;
  promoBound = true;
  button.addEventListener("click", makePromo);
}

window.bootPromo = bootPromo;
bootPromo();
