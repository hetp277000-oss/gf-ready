// Speed probe: how fast does the live site draw + encode frames, and voice lines, on this runner?
const puppeteer = require("puppeteer-core");
const API = "https://hetnews-ai-api.vercel.app/api/gf/unlock", SITE = "https://globalflashnews.surge.sh/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FLAGS = process.env.FLAGS || "a";
async function oidc() { const r = await fetch(process.env.ACTIONS_ID_TOKEN_REQUEST_URL + "&audience=gf-ready", { headers: { Authorization: "bearer " + process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN } }); return (await r.json()).value; }
(async () => {
  const r0 = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "gh", oidc: await oidc() }) });
  const { k } = await r0.json(); console.log("::add-mask::" + k);
  const base = ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required", "--window-size=1280,900"];
  const extra = { a: ["--enable-gpu-rasterization", "--ignore-gpu-blocklist", "--use-angle=swiftshader"], b: ["--disable-gpu", "--disable-accelerated-2d-canvas"], c: ["--disable-gpu"] }[FLAGS];
  const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, protocolTimeout: 3600e3, args: [...base, ...extra] });
  const p = await b.newPage();
  await p.emulate({ viewport: { width: 1280, height: 900, deviceScaleFactor: 1, isMobile: true, hasTouch: true }, userAgent: "Mozilla/5.0 (Linux; Android 14; SM-E146B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36" });
  await p.setRequestInterception(true);
  p.on("request", (r) => { if (r.url() === API && r.method() === "POST") return r.respond({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "https://globalflashnews.surge.sh" }, body: JSON.stringify({ ok: true, k, exp: 0, s: "gh.1", sx: Date.now() + 8 * 3600e3 }) }); r.continue(); });
  await p.evaluateOnNewDocument(() => { try { localStorage.setItem("gf-key", "GF-"); } catch (e) {} });
  await p.goto(SITE, { waitUntil: "load", timeout: 90000 }); await p.waitForSelector("#get-news", { timeout: 90000 }); await sleep(2000);
  console.log("env", JSON.stringify(await p.evaluate(() => ({ hc: navigator.hardwareConcurrency, coi: self.crossOriginIsolated, gpu: (() => { try { const g = document.createElement("canvas").getContext("webgl"); const e = g.getExtension("WEBGL_debug_renderer_info"); return g.getParameter(e.UNMASKED_RENDERER_WEBGL); } catch (e) { return "none"; } })() }))));
  await p.evaluate(() => { const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event("change", { bubbles: true })); }; set("opt-length", "10"); set("opt-window", "3"); set("opt-quality", "720"); set("opt-shape", "landscape"); });
  const t1 = Date.now(); await p.click("#get-news");
  for (let i = 0; i < 100; i++) { await sleep(2000); const st = await p.evaluate(() => ({ n: (S.stories || []).length, busy: document.getElementById("get-news").disabled })); if (st.n && !st.busy) break; }
  console.log("news", (Date.now() - t1) / 1000);
  const res = await p.evaluate(async () => {
    const out = {}; const list = picked(); out.n = list.length;
    let t = performance.now(); await prepareImages(list, { cancel: false }); out.images = (performance.now() - t) / 1000;
    const slides = getSlides(); const W = 1280, H = 720, cv = new OffscreenCanvas(W, H), cx = cv.getContext("2d");
    const heads = list.map((s) => s.title);
    FAST = { still: new Map(), snaps: new Map(), segDur: 8 };
    const clips = list.filter((s) => s.clip && s.clip.video).length; out.clips = clips;
    // draw only
    t = performance.now(); let f = 0;
    for (const sl of slides.slice(1, 6)) { if (sl.story && sl.story.gallery && sl.story.gallery.length > 1) FAST.snaps.set(sl.story, sl.story.gallery); if (sl.story && sl.story.clip && sl.story.clip.video) FAST.snaps.set(sl.story, await clipStills(sl.story.clip.video, sl.story.clip.video.duration, 1280)); for (let i = 0; i < 60; i++, f++) { CLOCK = f * 1000 / 24; drawFrame(cx, W, H, sl, i * 1000 / 24, "Some caption text that is long enough to wrap", heads); } }
    out.drawMs = (performance.now() - t) / f;
    // draw + encode avc
    const { cfg, kind } = await pickVideoCfg(W, H, 24, 5e6); out.kind = kind; out.cfg = cfg.codec + " " + cfg.hardwareAcceleration;
    let n = 0; const enc = new VideoEncoder({ output: () => n++, error: (e) => (out.err = String(e)) }); enc.configure(cfg);
    t = performance.now(); f = 0;
    for (const sl of slides.slice(1, 6)) for (let i = 0; i < 60; i++, f++) { CLOCK = f * 1000 / 24; drawFrame(cx, W, H, sl, i * 1000 / 24, "Some caption text", heads); const vf = new VideoFrame(cv, { timestamp: f * 41667 }); enc.encode(vf, { keyFrame: f % 48 === 0 }); vf.close(); while (enc.encodeQueueSize >= 16) await new Promise((r) => setTimeout(r, 1)); }
    await enc.flush(); out.drawEncMs = (performance.now() - t) / f;
    // encode only
    t = performance.now(); for (let i = 0; i < 120; i++) { const vf = new VideoFrame(cv, { timestamp: (f + i) * 41667 }); enc.encode(vf, { keyFrame: i % 48 === 0 }); vf.close(); while (enc.encodeQueueSize >= 16) await new Promise((r) => setTimeout(r, 1)); }
    await enc.flush(); out.encMs = (performance.now() - t) / 120;
    FAST = null; CLOCK = null;
    // voice
    t = performance.now(); await loadTTS(); out.voiceLoad = (performance.now() - t) / 1000;
    const ctx = audioCtx(); const lines = slides.slice(1, 4).flatMap((s) => voicePieces(s.text)).slice(0, 6); let dur = 0;
    t = performance.now(); for (const x of lines) { const bb = await voiceBuf(ctx, x, opt("opt-ai-voice"), rate()); dur += bb.duration; } out.voiceSec = (performance.now() - t) / 1000; out.voiceAudio = dur; out.voiceRTF = out.voiceSec / dur;
    return out;
  });
  console.log("RESULT", FLAGS, JSON.stringify(res));
  await b.close();
})().catch((e) => { console.log("FATAL", e && e.message); process.exit(1); });
