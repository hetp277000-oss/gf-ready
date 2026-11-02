// Global Flash ready-video render job (GitHub Actions). Drives the live, protected site in Chrome
// exactly like a visitor would, then hands the finished file to pack.js. Never print secrets.
const fs = require("fs"), crypto = require("crypto");
const puppeteer = require("puppeteer-core");
const API = "https://hetnews-ai-api.vercel.app/api/gf/unlock", SITE = "https://globalflashnews.surge.sh/";
const slot = process.argv[2] || "2_3", [LEN, WIN] = slot.split("_"), OUT = process.env.OUT || "out";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
async function oidc() {
  const u = process.env.ACTIONS_ID_TOKEN_REQUEST_URL, t = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!u || !t) throw new Error("no OIDC env (needs permissions: id-token: write)");
  const r = await fetch(u + "&audience=gf-ready", { headers: { Authorization: "bearer " + t } }); const j = await r.json(); return j.value;
}
async function gh(extra) {
  const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json", "user-agent": "gf-ready-render" }, body: JSON.stringify({ op: "gh", oidc: await oidc(), ...extra }) });
  const j = await r.json(); if (!j.ok) throw new Error("auth refused: " + r.status + " " + (j.error || "")); return j;
}
const BAN = /times\s*of\s*india|timesofindia|\btoi\b|reuters|\bani\b|associated press|\bap news\b|\bcnn\b|\bbbc\b|fox news|abc news|\bnbc\b|\bcbs\b|al jazeera|ndtv|india today|\bwion\b|republic tv|c-span|sky news|bloomberg|\bbbg\b|cnbc|msnbc|the guardian|new york times|\bnyt\b|washington post/gi;
const clean = (s) => String(s || "").replace(BAN, "").replace(/\(\s*\)|\[\s*\]/g, "").replace(/[ \t]{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").trim();
(async () => {
  const T0 = Date.now(); fs.mkdirSync(OUT, { recursive: true });
  const { k } = await gh({}); console.log("::add-mask::" + k);
  const b = await puppeteer.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", headless: true, protocolTimeout: 3600e3,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required", "--enable-gpu-rasterization", "--ignore-gpu-blocklist", "--use-angle=swiftshader", "--window-size=1280,900"] });
  const p = await b.newPage();
  await p.emulate({ viewport: { width: 1280, height: 900, deviceScaleFactor: 1, isMobile: true, hasTouch: true }, userAgent: "Mozilla/5.0 (Linux; Android 14; SM-E146B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36" });
  const errs = []; p.on("pageerror", (e) => { errs.push(String(e.message).slice(0, 160)); });
  p.on("console", (m) => { const t = m.text(); if (/fail|error|warn/i.test(t) && errs.length < 60) errs.push("console: " + t.slice(0, 160)); });
  await p.setRequestInterception(true);
  const sx = Date.now() + 8 * 3600e3;
  p.on("request", (r) => {
    if (r.url() === API && r.method() === "POST") {
      let j = {}; try { j = JSON.parse(r.postData() || "{}"); } catch (e) {}
      const body = j.ping ? { ok: true, s: "gh." + sx, sx } : { ok: true, k, exp: 0, s: "gh." + sx, sx };
      return r.respond({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "https://globalflashnews.surge.sh" }, body: JSON.stringify(body) });
    }
    r.continue();
  });
  // "GF-" = a key with no id, so the site bakes no per-key watermark; the visitor's own one is added on their device.
  await p.evaluateOnNewDocument(() => { try { if (location.hostname === "globalflashnews.surge.sh") localStorage.setItem("gf-key", "GF-"); } catch (e) {}
    const o = URL.createObjectURL; window.__blobs = []; URL.createObjectURL = function (x) { if (x && x.type && /video/.test(x.type)) window.__blobs.push(x); return o.call(URL, x); }; });
  await p.goto(SITE, { waitUntil: "load", timeout: 90000 });
  await p.waitForSelector("#get-news", { timeout: 90000 });
  await sleep(2500);
  log("app open", Math.round((Date.now() - T0) / 1000) + "s");
  await p.evaluate((len, win) => { const set = (id, v) => { const e = document.getElementById(id); if (e) { e.value = v; e.dispatchEvent(new Event("change", { bubbles: true })); } };
    set("opt-length", len); set("opt-window", win); set("opt-quality", "720"); set("opt-shape", "landscape"); const f = document.getElementById("opt-fast"); if (f && !f.checked) f.click(); }, LEN, WIN);
  const t1 = Date.now();
  await p.click("#get-news");
  for (let i = 0; i < 200; i++) { await sleep(3000); const st = await p.evaluate(() => ({ n: (S.stories || []).length, busy: document.getElementById("get-news").disabled, msg: (document.querySelector(".x-status") || {}).textContent }));
    if (st.n && !st.busy) { log("news", st.n, Math.round((Date.now() - t1) / 1000) + "s"); break; } if (i % 10 == 0) log("..", JSON.stringify(st).slice(0, 160)); if (i === 199) throw new Error("news timeout"); }
  const stories = await p.evaluate(() => S.stories.filter((s) => s.checked !== false).map((s) => s.title || s.ytTitle || ""));
  const fp = crypto.createHash("sha256").update(stories.join("\n")).digest("hex").slice(0, 16);
  fs.writeFileSync(OUT + "/fp.txt", fp);
  let prev = null; try { prev = await (await fetch("https://raw.githubusercontent.com/hetp277000-oss/gf-ready/s-" + slot + "/latest.json?t=" + Date.now())).json(); } catch (e) {}
  if (prev && prev.fp === fp && process.env.FORCE !== "1") { log("same stories as the live video, skipping"); fs.writeFileSync(OUT + "/skip", "1"); await b.close(); return; }
  const t2 = Date.now();
  await p.click("#make-ai");
  let last = "";
  for (let i = 0; i < 720; i++) { await sleep(5000); const st = await p.evaluate(() => ({ n: window.__blobs.length, pt: (document.getElementById("progress-text") || {}).textContent, msg: (document.querySelector(".x-status") || {}).textContent }));
    if (st.n) break; const s2 = JSON.stringify(st).slice(0, 200); if (s2 !== last && i % 6 == 0) { log("..", s2); last = s2; } if (i === 719) throw new Error("render timeout"); }
  const renderSec = (Date.now() - t2) / 1000; log("video ready", Math.round(renderSec) + "s");
  // pull the file out in 8 MB slices
  const size = await p.evaluate(() => { window.__vb = window.__blobs[window.__blobs.length - 1]; return window.__vb.size; });
  const fd = fs.openSync(OUT + "/raw.mp4", "w");
  for (let o = 0; o < size; o += 8 << 20) { const s64 = await p.evaluate(async (o) => { const ab = await window.__vb.slice(o, o + (8 << 20)).arrayBuffer(); let s = ""; const u = new Uint8Array(ab); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }, o); fs.writeSync(fd, Buffer.from(s64, "base64")); }
  fs.closeSync(fd);
  // copyright check, title, description, tags and the thumbnail exactly as the site makes them
  let cr = ""; try { await p.click("#cr-check"); await sleep(8000); cr = await p.evaluate(() => (document.getElementById("cr-out") || {}).innerText || ""); } catch (e) {}
  const meta = await p.evaluate(async () => { try { if (typeof drawThumb === "function") await drawThumb(); } catch (e) {} await new Promise((r) => setTimeout(r, 1500));
    const v = (i) => (document.getElementById(i) || {}).value || "";
    return { title: v("yt-title"), desc: v("yt-desc"), tags: v("yt-tags"), thumb: document.getElementById("thumb").toDataURL("image/jpeg", 0.88), type: window.__vb.type }; });
  meta.title = clean(meta.title); meta.desc = clean(meta.desc);
  meta.tags = meta.tags.split(",").map((t) => t.trim()).filter((t) => t && !new RegExp(BAN.source, "i").test(t)).join(", ");
  meta.stories = stories.map(clean); meta.slot = slot; meta.len = +LEN; meta.win = +WIN; meta.t = Date.now(); meta.fp = fp; meta.cr = cr.slice(0, 1500);
  fs.writeFileSync(OUT + "/meta.json", JSON.stringify(meta));
  fs.writeFileSync(OUT + "/stats.json", JSON.stringify({ slot, renderSec, newsSec: (t2 - t1) / 1000, totalSec: (Date.now() - T0) / 1000, rawBytes: size, rawType: meta.type, stories: stories.length, errors: errs.slice(0, 40) }, null, 1));
  log("done", JSON.stringify({ size, type: meta.type, title: meta.title, errors: errs.length }));
  await b.close();
})().catch((e) => { console.log("FATAL", e && e.message); process.exit(1); });
