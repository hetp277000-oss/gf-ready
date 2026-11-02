// Global Flash ready videos: one job per group of slots that share the same stories.
// The LIVE protected site does all the work in Chrome (its own news pick, script, voice, photos, clips, drawing):
//  1. main tab: Get News, then the voice lines are made in parallel tabs (Piper is single-threaded) while photos/clips load
//  2. the full timeline + sound track are made once (GFR.finish/audio), then the frames are split into ranges that
//     several tabs draw at the same time (GFR.load + GFR.render) - every frame comes from the site's fastExport
//  3. ffmpeg: each part to H.264 (x264), joined without re-encoding, sound copied; encrypted, one orphan branch per slot.
// Ready renders are brand-neutral: no channel name anywhere (GF_RR.blank) and a silent gap where the name line is
// spoken; the visitor's own name (text or logo + voice) is added on their device. Never print secrets.
const fs = require("fs"), crypto = require("crypto"), path = require("path"), { spawn, execFileSync } = require("child_process");
const puppeteer = require("puppeteer-core");
const API = "https://hetnews-ai-api.vercel.app/api/gf/unlock", SITE = "https://globalflashnews.surge.sh/";
const REPO = process.env.GITHUB_REPOSITORY || "hetp277000-oss/gf-ready";
const G = JSON.parse(process.env.GROUP || '{"len":"5","win":"6","slots":["5_6"]}');
const OUT = path.resolve(process.env.OUT || "out"), PUB = path.resolve(process.env.PUB || "pub"), PAGES = +(process.env.PAGES || 4), GAP = 2.4, CH = 14 << 20;
const T0 = Date.now(), SEEN = +process.env.SEEN || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sec = (t) => +((t - T0) / 1000).toFixed(1);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "+" + sec(Date.now()) + "s", ...a);
const stats = { group: G, t0: new Date(T0).toISOString(), seen: SEEN ? new Date(SEEN).toISOString() : null, steps: {} };
const step = (k) => (stats.steps[k] = sec(Date.now()));
fs.mkdirSync(OUT, { recursive: true });
// ffmpeg arrives in the background while Chrome works (apt is slow; it is only needed at the end)
const ffReady = new Promise((res) => { try { execFileSync("bash", ["-c", "command -v ffmpeg"]); return res(); } catch (e) {}
  const p = spawn("bash", ["-c", "sudo apt-get update -qq >/dev/null 2>&1; sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ffmpeg >/dev/null 2>&1"], { stdio: "ignore" }); p.on("exit", () => res()); });
const run = (cmd, args) => new Promise((res, rej) => { const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] }); let e = ""; p.stderr.on("data", (d) => (e = (e + d).slice(-2000))); p.on("exit", (c) => (c ? rej(new Error(cmd + " " + c + " " + e)) : res())); });
async function oidc() { const r = await fetch(process.env.ACTIONS_ID_TOKEN_REQUEST_URL + "&audience=gf-ready", { headers: { Authorization: "bearer " + process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN } }); return (await r.json()).value; }
async function gh(extra) { const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json", "user-agent": "gf-ready-render" }, body: JSON.stringify({ op: "gh", oidc: await oidc(), ...extra }) }); const j = await r.json(); if (!j.ok) throw new Error("auth refused " + r.status); return j; }
const BAN = /times\s*of\s*india|timesofindia|\btoi\b|reuters|\bani\b|associated press|\bap news\b|\bcnn\b|\bbbc\b|fox news|abc news|\bnbc\b|\bcbs\b|al jazeera|ndtv|india today|\bwion\b|republic tv|c-span|sky news|bloomberg|cnbc|msnbc|the guardian|new york times|\bnyt\b|washington post|global\s*flash/gi;
const clean = (s) => String(s || "").replace(BAN, "").replace(/\(\s*\)|\[\s*\]/g, "").replace(/[ \t]{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").replace(/^\s*[–|-]\s*/, "").trim();
const DATE = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "Asia/Kolkata" });
let browser, K;
async function openApp(label) {
  const p = await browser.newPage();
  await p.emulate({ viewport: { width: 1280, height: 900, deviceScaleFactor: 1, isMobile: true, hasTouch: true }, userAgent: "Mozilla/5.0 (Linux; Android 14; SM-E146B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36" });
  p.errs = []; p.on("pageerror", (e) => p.errs.push(label + ": " + String(e.message).slice(0, 160)));
  p.on("console", (m) => { const t = m.text(); if (/error|fail/i.test(t) && p.errs.length < 40) p.errs.push(label + " console: " + t.slice(0, 160)); });
  await p.setRequestInterception(true);
  const sx = Date.now() + 8 * 3600e3;
  p.on("request", (r) => {
    if (r.url() === API && r.method() === "POST") { let j = {}; try { j = JSON.parse(r.postData() || "{}"); } catch (e) {}
      const body = j.ping ? { ok: true, s: "gh." + sx, sx } : { ok: true, k: K, exp: 0, s: "gh." + sx, sx };
      return r.respond({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "https://globalflashnews.surge.sh" }, body: JSON.stringify(body) }); }
    r.continue();
  });
  await p.evaluateOnNewDocument((gap, date) => { try { if (location.hostname === "globalflashnews.surge.sh") localStorage.setItem("gf-key", "GF-"); } catch (e) {}
    window.GF_RR = { blank: true, gap, date }; }, GAP, DATE);
  await p.goto(SITE, { waitUntil: "load", timeout: 90000 });
  await p.waitForFunction(() => window.GFR && document.getElementById("get-news"), { timeout: 90000 });
  return p;
}
async function pull(p, file) { // the page's last blob -> file, 8 MB at a time
  const fd = fs.openSync(file, "w"); let o = 0;
  for (;;) { const s64 = await p.evaluate((o) => GFR.read(o, 8 << 20), o); if (!s64) break; const b = Buffer.from(s64, "base64"); fs.writeSync(fd, b); o += b.length; if (b.length < 8 << 20) break; }
  fs.closeSync(fd); return o;
}
async function ghApi(p, opt) { const r = await fetch("https://api.github.com/repos/" + REPO + p, { ...opt, headers: { Authorization: "Bearer " + process.env.GH_TOKEN, Accept: "application/vnd.github+json", "User-Agent": "gf-ready", ...(opt && opt.headers) } }); return r; }
(async () => {
  const { k } = await gh({}); K = k; console.log("::add-mask::" + k);
  browser = await puppeteer.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", headless: true, protocolTimeout: 3600e3,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required", "--disable-gpu", "--window-size=1280,900", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] });
  // main tab + helper tabs open together
  const helpersP = Promise.all(Array.from({ length: PAGES - 1 }, (_, i) => openApp("tab" + (i + 1))));
  const p = await openApp("main"); step("appOpen");
  await p.evaluate((len, win) => { const set = (id, v) => { const e = document.getElementById(id); if (e) { e.value = v; e.dispatchEvent(new Event("change", { bubbles: true })); } };
    set("opt-length", len); set("opt-window", win); set("opt-quality", "720"); set("opt-shape", "landscape"); const f = document.getElementById("opt-fast"); if (f && !f.checked) f.click(); }, G.len, G.win);
  await p.click("#get-news");
  for (let i = 0; ; i++) { await sleep(1000); const st = await p.evaluate(() => ({ n: (S.stories || []).length, busy: document.getElementById("get-news").disabled })); if (st.n && !st.busy) break; if (i > 400) throw new Error("news timeout"); }
  step("news");
  const stories = await p.evaluate(() => picked().map((s) => s.title || ""));
  log("news", stories.length, "stories");
  const pc = await p.evaluate(() => GFR.pieces());
  const helpers = await helpersP; step("tabsOpen");
  // voice: lines split over the helper tabs (longest first), photos + clips load in the main tab meanwhile
  const texts = pc.texts.slice().sort((a, b) => b.length - a.length), share = helpers.map(() => []), load = helpers.map(() => 0);
  texts.forEach((t) => { const i = load.indexOf(Math.min(...load)); share[i].push(t); load[i] += t.length; });
  const [voices] = await Promise.all([
    Promise.all(helpers.map((h, i) => h.evaluate((t, v, sp) => GFR.gen(t, v, sp), share[i], pc.v, pc.sp))).then((x) => { step("voice"); return x.flat(); }),
    p.evaluate(() => GFR.prepAssets()).then(() => step("assets")),
  ]);
  await p.evaluate((l, v, sp) => GFR.putVoice(l, v, sp), voices, pc.v, pc.sp);
  const info = await p.evaluate(() => GFR.finish()); step("timeline");
  log("timeline", info.total.toFixed(2) + "s", info.frames, "frames", info.gaps.length, "name gaps");
  // title / description / tags / thumbnail exactly as the site makes them (no channel name)
  let cr = ""; try { await p.click("#cr-check"); await sleep(4000); cr = await p.evaluate(() => (document.getElementById("cr-out") || {}).innerText || ""); } catch (e) {}
  const meta = await p.evaluate(async () => { try { if (typeof drawThumb === "function") await drawThumb(); } catch (e) {} await new Promise((r) => setTimeout(r, 800));
    const v = (i) => (document.getElementById(i) || {}).value || "";
    return { title: v("yt-title"), desc: v("yt-desc"), tags: v("yt-tags"), thumb: document.getElementById("thumb").toDataURL("image/jpeg", 0.9), thumbSpot: S.thumbSpot || null, voice: opt("opt-ai-voice"), speed: rate(), win: S.newsWindow }; });
  meta.title = clean(meta.title); meta.desc = clean(meta.desc);
  meta.tags = meta.tags.split(",").map((t) => t.trim()).filter((t) => t && !new RegExp(BAN.source, "i").test(t)).join(", ");
  Object.assign(meta, { stories: stories.map(clean), len: +G.len, info, gap: GAP, cr: cr.slice(0, 1500), t: Date.now() });
  const snap = await p.evaluate(() => GFR.snapshot());
  fs.writeFileSync(OUT + "/snapshot.json", snap); step("snapshot");
  // frame ranges (2 s / 48-frame aligned) for every tab; the main tab also makes the sound track first
  const n = info.frames, per = Math.ceil(n / PAGES / 48) * 48, ranges = [];
  for (let f = 0; f < n; f += per) ranges.push([f, Math.min(n, f + per)]);
  const tabs = [p, ...helpers], partRes = [], partDone = ranges.map((_, i) => new Promise((r) => (partRes[i] = r)));
  const audioP = (async () => { const a = await p.evaluate(() => GFR.audio()); const f = OUT + "/audio." + (/webm/.test(a.type) ? "webm" : "m4a"); await pull(p, f); step("audio"); return f; })();
  const loadP = helpers.map((h, i) => h.evaluate((s) => GFR.load(s), snap).then((l) => {
    if (!l.same || l.miss.length) log("tab" + (i + 1) + " load", JSON.stringify(l).slice(0, 300));
    if (!l.same) throw new Error("timeline mismatch in tab " + (i + 1));
    if (l.miss.length) throw new Error("tab " + (i + 1) + " could not load " + l.miss.length + " files");
    stats.steps["load" + (i + 1)] = sec(Date.now()); return l; }));
  const X264 = ["-c:v", "libx264", "-preset", process.env.X264P || "veryfast", "-crf", process.env.CRF || "24", "-g", "48", "-keyint_min", "48", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-profile:v", "high", "-f", "h264"];
  const partStats = [];
  // range 0 is drawn by the main tab after the sound track; the others start as soon as their tab has loaded the snapshot
  await Promise.all(ranges.map(async (rg, i) => {
    const ti = i % tabs.length, tab = tabs[ti];
    if (ti === 0) await audioP; else await loadP[ti - 1];
    if (i >= tabs.length) await partDone[i - tabs.length];
    const r = await tab.evaluate((a, b) => GFR.render(a, b), rg[0], rg[1]);
    const raw = OUT + "/part" + i + ".mp4"; await pull(tab, raw);
    partRes[i]();
    await ffReady;
    const t1 = Date.now(); await run("ffmpeg", ["-y", "-v", "error", "-i", raw, "-an", ...X264, OUT + "/part" + i + ".h264"]);
    partStats.push({ i, frames: rg[1] - rg[0], renderSec: +(r.ms / 1000).toFixed(1), fps: +((rg[1] - rg[0]) / (r.ms / 1000)).toFixed(1), x264Sec: (Date.now() - t1) / 1000, doneAt: sec(Date.now()) });
    fs.rmSync(raw);
  }));
  const audioFile = await audioP;
  step("frames");
  fs.writeFileSync(OUT + "/all.h264", Buffer.concat(ranges.map((_, i) => fs.readFileSync(OUT + "/part" + i + ".h264"))));
  await run("ffmpeg", ["-y", "-v", "error", "-framerate", "24", "-i", OUT + "/all.h264", "-i", audioFile, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", OUT + "/v.mp4"]);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_packets", "-show_streams", "-show_format", "-of", "json", OUT + "/v.mp4"]).toString());
  const vs = probe.streams.find((s) => s.codec_type === "video"), as = probe.streams.find((s) => s.codec_type === "audio");
  if (+vs.nb_read_packets !== n) throw new Error("frame count " + vs.nb_read_packets + " != " + n);
  step("joined");
  const buf = fs.readFileSync(OUT + "/v.mp4"), dur = +probe.format.duration;
  Object.assign(stats, { frames: n, dur, bytes: buf.length, mbps: +((buf.length * 8) / dur / 1e6).toFixed(2), video: vs.codec_name + " " + vs.width + "x" + vs.height, audio: as && as.codec_name, parts: partStats.sort((a, b) => a.i - b.i), errors: tabs.flatMap((t) => t.errs).slice(0, 40) });
  log("video", JSON.stringify({ bytes: buf.length, dur, mbps: stats.mbps }));
  await browser.close().catch(() => {});
  // one encrypted copy per slot (each slot branch holds exactly one video)
  const ids = [];
  for (const slot of G.slots) {
    const id = slot.replace("_", "-") + "-" + new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12) + "-" + crypto.randomBytes(3).toString("hex");
    const j = await gh({ id }); console.log("::add-mask::" + j.vk);
    const key = Buffer.from(j.vk, "base64"), seal = (d) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv); return Buffer.concat([iv, c.update(d), c.final(), c.getAuthTag()]); };
    const dir = PUB + "/" + slot + "/" + id; fs.mkdirSync(dir, { recursive: true });
    let nc = 0; for (let o = 0; o < buf.length; o += CH) fs.writeFileSync(dir + "/" + nc++ + ".bin", seal(buf.subarray(o, o + CH)));
    const m = { ...meta, slot, win: +slot.split("_")[1], dur, size: buf.length, n: nc, mime: "video/mp4", codec: "h264+" + (as && as.codec_name), fp: G.fp };
    fs.writeFileSync(dir + "/m.bin", seal(Buffer.from(JSON.stringify(m))));
    fs.writeFileSync(PUB + "/" + slot + "/info.json", JSON.stringify({ id, n: nc, size: buf.length, dur, t: meta.t, fp: G.fp, slot, seen: SEEN || null }));
    ids.push({ slot, id, n: nc });
  }
  fs.writeFileSync(OUT + "/ids.json", JSON.stringify(ids));
  step("packed");
  fs.writeFileSync(OUT + "/stats.json", JSON.stringify(stats, null, 1));
  console.log("STATS", JSON.stringify(stats));
})().catch((e) => { console.log("FATAL", e && e.stack ? e.stack.slice(0, 600) : e); process.exit(1); });
