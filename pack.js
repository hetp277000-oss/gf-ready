// Transcode the site's render to the distribution file (VP9 + Opus in MP4, fast start), then AES-256-GCM
// encrypt it in <=14 MB chunks plus an encrypted meta (title, description, tags, thumbnail).
// The chunk key comes from the Vercel unlock function (HMAC of the video id); it is never written to disk.
const fs = require("fs"), crypto = require("crypto"), { execFileSync } = require("child_process");
const slot = process.argv[2], OUT = process.env.OUT || "out", PUB = process.env.PUB || "pub";
const API = "https://hetnews-ai-api.vercel.app/api/gf/unlock", CH = 14 << 20;
async function oidc() { const r = await fetch(process.env.ACTIONS_ID_TOKEN_REQUEST_URL + "&audience=gf-ready", { headers: { Authorization: "bearer " + process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN } }); return (await r.json()).value; }
(async () => {
  const meta = JSON.parse(fs.readFileSync(OUT + "/meta.json", "utf8")), stats = JSON.parse(fs.readFileSync(OUT + "/stats.json", "utf8"));
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", OUT + "/raw.mp4"]).toString());
  const a = probe.streams.find((s) => s.codec_type === "audio"), dur = +probe.format.duration;
  const t0 = Date.now();
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", OUT + "/raw.mp4", "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", process.env.CRF || "33", "-deadline", "good", "-cpu-used", process.env.CPU || "4", "-row-mt", "1", "-tile-columns", "2", "-threads", "4", "-g", "96", "-pix_fmt", "yuv420p",
    ...(a && a.codec_name === "opus" ? ["-c:a", "copy"] : ["-c:a", "libopus", "-b:a", "128k", "-ar", "48000", "-ac", "2"]), "-movflags", "+faststart", OUT + "/v.mp4"], { stdio: "inherit" });
  const encSec = (Date.now() - t0) / 1000, buf = fs.readFileSync(OUT + "/v.mp4");
  // fidelity check vs the site's own render (first 60 s): SSIM 1.0 = identical
  let ssim = null;
  try { const r = require("child_process").spawnSync("ffmpeg", ["-hide_banner", "-t", "60", "-i", OUT + "/v.mp4", "-t", "60", "-i", OUT + "/raw.mp4", "-lavfi", "[0:v][1:v]ssim", "-f", "null", "-"], { encoding: "utf8" }); const m = /All:([\d.]+)/.exec(r.stderr || ""); ssim = m ? +m[1] : null; } catch (e) {}
  const id = slot.replace("_", "-") + "-" + new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12) + "-" + crypto.randomBytes(3).toString("hex");
  const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json", "user-agent": "gf-ready-render" }, body: JSON.stringify({ op: "gh", oidc: await oidc(), id }) });
  const j = await r.json(); if (!j.ok || !j.vk) throw new Error("no chunk key: " + r.status); console.log("::add-mask::" + j.vk); console.log("::add-mask::" + j.k);
  const key = Buffer.from(j.vk, "base64");
  const seal = (data) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv); return Buffer.concat([iv, c.update(data), c.final(), c.getAuthTag()]); };
  const dir = PUB + "/" + id; fs.mkdirSync(dir, { recursive: true });
  let n = 0; for (let o = 0; o < buf.length; o += CH) fs.writeFileSync(dir + "/" + n++ + ".bin", seal(buf.subarray(o, o + CH)));
  meta.dur = dur; meta.size = buf.length; meta.n = n; meta.mime = "video/mp4"; meta.codec = "vp9+opus";
  fs.writeFileSync(dir + "/m.bin", seal(Buffer.from(JSON.stringify(meta))));
  const info = { id, n, size: buf.length, dur, t: meta.t, fp: meta.fp, slot, enc: "aes-256-gcm iv12|ct|tag16, chunk " + CH };
  fs.writeFileSync(OUT + "/info.json", JSON.stringify(info));
  stats.encSec = encSec; stats.ssim60 = ssim; stats.distBytes = buf.length; stats.dur = dur; stats.mbps = +(buf.length * 8 / dur / 1e6).toFixed(2); stats.chunks = n; stats.rawAudio = a && a.codec_name; stats.rawVideo = (probe.streams.find((s) => s.codec_type === "video") || {}).codec_name;
  fs.writeFileSync(OUT + "/stats.json", JSON.stringify(stats, null, 1));
  console.log("packed", JSON.stringify({ id, n, size: buf.length, dur, encSec }));
})().catch((e) => { console.log("FATAL", e && e.message); process.exit(1); });
