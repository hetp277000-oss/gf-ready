// Publish each slot of this group: orphan commit A (the video files) + commit B (latest.json pointing at A),
// force-pushed to s-<slot>, so the branch holds exactly one video and no history. Then warm jsDelivr @A and
// record when the video became playable there.
const fs = require("fs"), { execFileSync } = require("child_process");
const REPO = process.env.GITHUB_REPOSITORY, TOK = process.env.GH_TOKEN, PUB = require("path").resolve("pub");
const sh = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "inherit"] }).toString().trim();
const ids = JSON.parse(fs.readFileSync("out/ids.json", "utf8")), stats = JSON.parse(fs.readFileSync("out/stats.json", "utf8"));
const T0 = Date.parse(stats.t0), SEEN = +process.env.SEEN || 0, out = [];
(async () => {
  for (const { slot, id, n } of ids) {
    const dir = PUB + "/" + slot;
    const info = JSON.parse(fs.readFileSync(dir + "/info.json", "utf8")); fs.rmSync(dir + "/info.json");
    sh(dir, "init", "-q"); sh(dir, "config", "user.name", "gf-ready-bot"); sh(dir, "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");
    sh(dir, "checkout", "-q", "--orphan", "s-" + slot); sh(dir, "add", "-A"); sh(dir, "commit", "-qm", "video " + id);
    const A = sh(dir, "rev-parse", "HEAD"); info.sha = A;
    fs.writeFileSync(dir + "/latest.json", JSON.stringify(info)); sh(dir, "add", "latest.json"); sh(dir, "commit", "-qm", "latest " + id);
    sh(dir, "push", "-q", "-f", "https://x-access-token:" + TOK + "@github.com/" + REPO + ".git", "HEAD:refs/heads/s-" + slot);
    const pushedAt = Date.now();
    // warm the CDN: m.bin + every chunk must answer 200
    for (const f of ["m", ...Array.from({ length: n }, (_, i) => i)]) {
      let ok = false;
      for (let t = 1; t <= 6 && !ok; t++) { const r = await fetch("https://cdn.jsdelivr.net/gh/" + REPO + "@" + A + "/" + id + "/" + f + ".bin").catch(() => null); if (r && r.ok) { await r.arrayBuffer(); ok = true; } else { console.log(slot, f, "try", t, r && r.status); await new Promise((w) => setTimeout(w, t * 5000)); } }
      if (!ok) throw new Error(slot + " " + f + ".bin not served by jsDelivr");
    }
    const playable = Date.now();
    out.push({ slot, id, sha: A, chunks: n, size: info.size, pushedSec: (pushedAt - T0) / 1000, playableSec: (playable - T0) / 1000, fromSeenSec: SEEN ? (playable - SEEN) / 1000 : null, playableAt: new Date(playable).toISOString() });
    console.log("published", JSON.stringify(out[out.length - 1]));
  }
  fs.writeFileSync("out/published.json", JSON.stringify(out, null, 1));
})().catch((e) => { console.log("FATAL", e.message); process.exit(1); });
