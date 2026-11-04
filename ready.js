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
const OUT = path.resolve(process.env.OUT || "out"), PUB = path.resolve(process.env.PUB || "pub"), PAGES = +(process.env.PAGES || 4), GAP = 2.4, CH = 14 << 20, PACK = +(process.env.PACK || 1);
const T0 = Date.now(), SEEN = +process.env.SEEN || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sec = (t) => +((t - T0) / 1000).toFixed(1);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "+" + sec(Date.now()) + "s", ...a);
const stats = { group: G, t0: new Date(T0).toISOString(), seen: SEEN ? new Date(SEEN).toISOString() : null, steps: {} };
const step = (k) => { stats.steps[k] = sec(Date.now()); log("step", k); };
fs.mkdirSync(OUT, { recursive: true });
// ffmpeg arrives in the background while Chrome works (only needed once the frames are drawn). A static build from
// GitHub releases takes ~15 s; apt (the old way) sometimes took 7+ minutes, so it is only the fallback.
const FFDIR = path.resolve("ffbin");
const ffReady = new Promise((res) => { try { execFileSync("bash", ["-c", "command -v ffmpeg"]); return res("system"); } catch (e) {}
  const t = Date.now(), dl = spawn("bash", ["-c", "set -e; mkdir -p '" + FFDIR + "'; cd '" + FFDIR + "'; curl -fsSL --retry 3 --max-time 120 https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz | tar -xJ --strip-components=2 --wildcards '*/bin/ffmpeg' '*/bin/ffprobe'; ./ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libx264"], { stdio: "ignore" });
  dl.on("exit", (c) => { if (!c) { process.env.PATH = FFDIR + ":" + process.env.PATH; stats.ffmpeg = { how: "static", sec: (Date.now() - t) / 1000 }; return res("static"); }
    const p = spawn("bash", ["-c", "sudo apt-get update -qq >/dev/null 2>&1; sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ffmpeg >/dev/null 2>&1"], { stdio: "ignore" });
    p.on("exit", () => { stats.ffmpeg = { how: "apt", sec: (Date.now() - t) / 1000 }; res("apt"); }); }); });
const run = (cmd, args) => new Promise((res, rej) => { const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] }); let e = ""; p.stderr.on("data", (d) => (e = (e + d).slice(-2000))); p.on("exit", (c) => (c ? rej(new Error(cmd + " " + c + " " + e)) : res())); });
async function oidc() { const r = await fetch(process.env.ACTIONS_ID_TOKEN_REQUEST_URL + "&audience=gf-ready", { headers: { Authorization: "bearer " + process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN } }); return (await r.json()).value; }
async function gh(extra) { const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json", "user-agent": "gf-ready-render" }, body: JSON.stringify({ op: "gh", oidc: await oidc(), ...extra }) }); const j = await r.json(); if (!j.ok) throw new Error("auth refused " + r.status); return j; }
const BAN = /times\s*of\s*india|timesofindia|\btoi\b|reuters|\bani\b|associated press|\bap news\b|\bcnn\b|\bbbc\b|fox news|abc news|\bnbc\b|\bcbs\b|al jazeera|ndtv|india today|\bwion\b|republic tv|c-span|sky news|bloomberg|cnbc|msnbc|the guardian|new york times|\bnyt\b|washington post|global\s*flash/gi;
const clean = (s) => String(s || "").replace(BAN, "").replace(/\(\s*\)|\[\s*\]/g, "").replace(/[ \t]{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").replace(/^\s*[–|-]\s*/, "").trim();
const DATE = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "Asia/Kolkata" });
let K; const browsers = [];
const LAUNCH = { executablePath: process.env.CHROME || "/usr/bin/google-chrome", headless: true, protocolTimeout: 3600e3,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required", "--disable-gpu", "--window-size=1280,900", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] };
// Each worker is its own Chrome (its own foreground page), so no tab is ever throttled as a background tab.
async function openApp(label) {
  const br = await puppeteer.launch(LAUNCH); browsers.push(br);
  const p = (await br.pages())[0] || (await br.newPage()); p.label = label;
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
  await p.evaluateOnNewDocument((gap, date, bps) => { try { if (location.hostname === "globalflashnews.surge.sh") { localStorage.setItem("gf-key", "GF-"); localStorage.setItem("gf-tab", "make"); localStorage.removeItem("gf-channel"); } } catch (e) {}
    window.GF_RR = { blank: true, gap, date, bps }; }, GAP, DATE, +(process.env.RAWBPS || 12e6));
  await p.goto(SITE, { waitUntil: "load", timeout: 90000 });
  await p.waitForFunction(() => window.GFR && document.getElementById("get-news"), { timeout: 90000, polling: 500 });
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
  // watchdog: progress every 20 s; a stuck job ends itself (so its log is kept) instead of running on
  const dog = setInterval(async () => { const st = []; for (const br of browsers) { try { const pg = (await br.pages())[0]; st.push(await Promise.race([pg.evaluate(() => (document.getElementById("progress-text") || {}).textContent + " | " + (document.getElementById("status-text") || {}).textContent), sleep(3000).then(() => "busy")])); } catch (e) { st.push("x " + e.message.slice(0, 40)); } } log("..", JSON.stringify(st).slice(0, 600)); if (Date.now() - T0 > (+process.env.MAXMIN || 14) * 60e3) { log("FATAL watchdog: too slow, giving up", JSON.stringify(stats.steps)); process.exit(1); } }, 20000);
  dog.unref();
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
  const meta = await p.evaluate(async () => { try { if (S.tagsP) await Promise.race([S.tagsP, new Promise((r) => setTimeout(r, 40000))]); } catch (e) {} try { if (typeof drawThumb === "function") await drawThumb(); } catch (e) {} await new Promise((r) => setTimeout(r, 800));
    const v = (i) => (document.getElementById(i) || {}).value || "";
    return { title: v("yt-title"), desc: v("yt-desc"), tags: v("yt-tags"), thumb: document.getElementById("thumb").toDataURL("image/jpeg", 0.9), thumbSpot: S.thumbSpot || null, voice: opt("opt-ai-voice"), speed: rate(), win: S.newsWindow, tagStats: S.tagStats || null }; });
  meta.title = clean(meta.title); meta.desc = clean(meta.desc);
  meta.tags = meta.tags.split(",").map((t) => t.trim()).filter((t) => t && !new RegExp(BAN.source, "i").test(t)).join(", ");
  stats.tags = meta.tagStats; delete meta.tagStats;
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
  const X264 = ["-c:v", "libx264", "-preset", process.env.X264P || "faster", "-crf", process.env.CRF || "20", "-g", "48", "-keyint_min", "48", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-profile:v", "high", "-f", "h264"];
  const partStats = []; stats.enc = { x264: X264.slice(2, 6).join(" "), rawBps: +(process.env.RAWBPS || 12e6), pack: PACK };
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
    const ps = { i, frames: rg[1] - rg[0], renderSec: +(r.ms / 1000).toFixed(1), fps: +((rg[1] - rg[0]) / (r.ms / 1000)).toFixed(1), x264Sec: (Date.now() - t1) / 1000, doneAt: sec(Date.now()), rawMB: +(fs.statSync(raw).size / 1048576).toFixed(1), outMB: +(fs.statSync(OUT + "/part" + i + ".h264").size / 1048576).toFixed(1) };
    if (i === 1 && process.env.QSTAT !== "0") { // sharpness vs the tab's own high-bitrate frames: first 20 s of part 1
      try { const q = await new Promise((res) => { const pr = spawn("ffmpeg", ["-v", "info", "-t", "20", "-r", "24", "-i", OUT + "/part" + i + ".h264", "-t", "20", "-i", raw, "-lavfi", "[0:v]setpts=N/24/TB[a];[1:v]setpts=N/24/TB,split[b][c];[a]split[d][e];[d][b]ssim;[e][c]psnr", "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"] }); let e = ""; pr.stderr.on("data", (d) => (e += d)); pr.on("exit", () => res(e)); });
        ps.ssim = +((q.match(/SSIM[^\n]*All:([0-9.]+)/) || [])[1] || 0); ps.psnr = +((q.match(/PSNR[^\n]*average:([0-9.inf]+)/) || [])[1] || 0); } catch (e) {} }
    partStats.push(ps);
    fs.rmSync(raw);
  }));
  const audioFile = await audioP;
  step("frames");
  fs.writeFileSync(OUT + "/all.h264", Buffer.concat(ranges.map((_, i) => fs.readFileSync(OUT + "/part" + i + ".h264"))));
  await run("ffmpeg", ["-y", "-v", "error", "-framerate", "24", "-i", OUT + "/all.h264", "-i", audioFile, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-t", (n / 24).toFixed(3), "-movflags", "+faststart", OUT + "/v.mp4"]);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_packets", "-show_streams", "-show_format", "-of", "json", OUT + "/v.mp4"]).toString());
  const vs = probe.streams.find((s) => s.codec_type === "video"), as = probe.streams.find((s) => s.codec_type === "audio");
  if (+vs.nb_read_packets !== n) throw new Error("frame count " + vs.nb_read_packets + " != " + n);
  step("joined");
  const buf = fs.readFileSync(OUT + "/v.mp4"), dur = +probe.format.duration;
  Object.assign(stats, { frames: n, dur, bytes: buf.length, mbps: +((buf.length * 8) / dur / 1e6).toFixed(2), video: vs.codec_name + " " + vs.width + "x" + vs.height, audio: as && as.codec_name, parts: partStats.sort((a, b) => a.i - b.i), errors: tabs.flatMap((t) => t.errs).slice(0, 40) });
  log("video", JSON.stringify({ bytes: buf.length, dur, mbps: stats.mbps }));
  await Promise.all(browsers.map((br) => br.close().catch(() => {})));
  // one encrypted copy per slot (each slot branch holds exactly one video)
  const ids = [];
  for (const slot of G.slots) {
    const id = slot.replace("_", "-") + "-" + new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12) + "-" + crypto.randomBytes(3).toString("hex");
    const j = await gh({ id }); console.log("::add-mask::" + j.vk);
    const key = Buffer.from(j.vk, "base64"), seal = (d) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv); return Buffer.concat([iv, c.update(d), c.final(), c.getAuthTag()]); };
    // jsDelivr serves at most 50 MB per commit, so the chunks go in packs of PACK (3 x 14 MB = 42 MB + m.bin):
    // pack 0 + m.bin = the pointer commit (made by publish.js), every further pack = its own orphan commit made here,
    // and m.bin says which commit holds which chunk (cb, null = the pointer commit).
    const root = PUB + "/" + slot, dir = root + "/" + id; fs.mkdirSync(dir, { recursive: true });
    const git = (env, ...a) => execFileSync("git", a, { cwd: env.GIT_WORK_TREE || root, env: { GIT_DIR: root + "/.git",  ...process.env, GIT_AUTHOR_NAME: "gf-ready-bot", GIT_COMMITTER_NAME: "gf-ready-bot", GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com", GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com", ...env }, stdio: ["ignore", "pipe", "inherit"] }).toString().trim();
    execFileSync("git", ["init", "-q", root]);
    let nc = 0; const cb = [], packs = [];
    for (let o = 0; o < buf.length; o += CH) { const i = nc++, k = Math.floor(i / PACK), d = k ? root + ".p" + k + "/" + id : dir;
      fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(d + "/" + i + ".bin", seal(buf.subarray(o, o + CH))); }
    for (let k = 1; k * PACK < nc; k++) { const env = { GIT_WORK_TREE: root + ".p" + k, GIT_INDEX_FILE: root + "/.git/index-p" + k };
      git(env, "add", "-A"); const tree = git(env, "write-tree"), c = git(env, "commit-tree", tree, "-m", "video " + id + " part " + k); packs.push(c); }
    for (let i = 0; i < nc; i++) cb.push(i < PACK ? null : packs[Math.floor(i / PACK) - 1]);
    const m = { ...meta, slot, win: +slot.split("_")[1], dur, size: buf.length, n: nc, mime: "video/mp4", codec: "h264+" + (as && as.codec_name), fp: G.fp, ...(packs.length ? { cb } : {}) };
    fs.writeFileSync(dir + "/m.bin", seal(Buffer.from(JSON.stringify(m))));
    fs.writeFileSync(PUB + "/" + slot + ".info.json", JSON.stringify({ id, n: nc, size: buf.length, dur, t: meta.t, fp: G.fp, slot, seen: SEEN || null }));
    ids.push({ slot, id, n: nc, cb, packs });
  }
  fs.writeFileSync(OUT + "/ids.json", JSON.stringify(ids));
  step("packed");
  fs.writeFileSync(OUT + "/stats.json", JSON.stringify(stats, null, 1));
  console.log("STATS", JSON.stringify(stats));
})().catch((e) => { console.log("FATAL", e && e.stack ? e.stack.slice(0, 600) : e); process.exit(1); });
