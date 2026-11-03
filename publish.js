// Publish each slot of this group. Commit A (orphan) = m.bin + chunk pack 0; further packs are their own orphan
// commits (made by ready.js, each under jsDelivr's 50 MB per-commit limit); commit B = latest.json {sha: A} with
// A and the packs as parents. B goes to a temporary branch w-<slot> first and every file is checked on jsDelivr;
// only then s-<slot> is moved to B (so a failed upload never replaces a working video) and w-<slot> is deleted.
// The branch holds exactly one video and no older history.
const fs = require("fs"), { execFileSync } = require("child_process");
const REPO = process.env.GITHUB_REPOSITORY, TOK = process.env.GH_TOKEN, PUB = require("path").resolve("pub");
const ids = JSON.parse(fs.readFileSync("out/ids.json", "utf8")), stats = JSON.parse(fs.readFileSync("out/stats.json", "utf8"));
const T0 = Date.parse(stats.t0), SEEN = +process.env.SEEN || 0, out = [];
const sleep = (ms) => new Promise((w) => setTimeout(w, ms));
const ENV = { ...process.env, GIT_AUTHOR_NAME: "gf-ready-bot", GIT_COMMITTER_NAME: "gf-ready-bot", GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com", GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com" };
const sh = (cwd, ...a) => execFileSync("git", a, { cwd, env: ENV, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const URL_ = process.env.REMOTE || "https://x-access-token:" + TOK + "@github.com/" + REPO + ".git";
async function push(dir, spec) { // big pushes sometimes time out (HTTP 408): retry
  for (let t = 1; ; t++) { try { sh(dir, "-c", "http.postBuffer=524288000", "-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=60", "push", "-q", "-f", URL_, spec); return t; }
    catch (e) { const m = String(e.stderr || e.message).replace(TOK, "***").split("\n").filter(Boolean).slice(-2).join(" | "); console.log("push", spec.replace(/^[0-9a-f]{40}/, (x) => x.slice(0, 7)), "try", t, "failed:", m.slice(0, 200)); if (t >= 4) throw new Error("push failed " + spec.split(":")[1]); await sleep(t * 10000); } }
}
async function serve(url) { // jsDelivr first; raw.githubusercontent is the site's fallback
  for (let t = 1; t <= 5; t++) { const r = await fetch(url).catch(() => null);
    if (r && r.ok) { await r.arrayBuffer(); return "cdn"; }
    const body = r ? (await r.text().catch(() => "")).slice(0, 120) : "network"; console.log("cdn", url.split("/").slice(-2).join("/"), "try", t, r && r.status, body);
    await sleep(t * 4000); }
  const raw = url.replace(/^https:\/\/cdn\.jsdelivr\.net\/gh\/([^/]+\/[^@/]+)@/, "https://raw.githubusercontent.com/$1/");
  const r = await fetch(raw).catch(() => null); if (r && r.ok) { await r.arrayBuffer(); return "raw"; }
  throw new Error(url.split("/").slice(-2).join("/") + " not served (cdn and raw)");
}
(async () => {
  for (const { slot, id, n, cb, packs } of ids) {
    const dir = PUB + "/" + slot, info = JSON.parse(fs.readFileSync(PUB + "/" + slot + ".info.json", "utf8"));
    sh(dir, "checkout", "-q", "--orphan", "s-" + slot); sh(dir, "add", "-A"); sh(dir, "commit", "-qm", "video " + id);
    const A = sh(dir, "rev-parse", "HEAD"); info.sha = A; if (packs.length) info.parts = packs;
    fs.writeFileSync(dir + "/latest.json", JSON.stringify(info)); sh(dir, "add", "latest.json");
    const tree = sh(dir, "write-tree"), B = sh(dir, "commit-tree", tree, "-p", A, ...packs.flatMap((c) => ["-p", c]), "-m", "latest " + id);
    const pushTries = await push(dir, B + ":refs/heads/w-" + slot);
    const pushedAt = Date.now();
    const via = {};
    for (const f of ["m", ...Array.from({ length: n }, (_, i) => i)]) {
      const sha = f === "m" || !cb[f] ? A : cb[f];
      via[f] = process.env.NOWARM ? "skip" : await serve("https://cdn.jsdelivr.net/gh/" + REPO + "@" + sha + "/" + id + "/" + f + ".bin");
    }
    await push(dir, B + ":refs/heads/s-" + slot);
    const playable = Date.now();
    try { sh(dir, "push", "-q", URL_, "--delete", "w-" + slot); } catch (e) { console.log("could not delete w-" + slot); }
    out.push({ slot, id, sha: A, packs, chunks: n, size: info.size, pushTries, rawFiles: Object.keys(via).filter((k) => via[k] === "raw"), pushedSec: (pushedAt - T0) / 1000, playableSec: (playable - T0) / 1000, fromSeenSec: SEEN ? (playable - SEEN) / 1000 : null, playableAt: new Date(playable).toISOString() });
    console.log("published", JSON.stringify(out[out.length - 1]));
  }
  fs.writeFileSync("out/published.json", JSON.stringify(out, null, 1));
})().catch((e) => { console.log("FATAL", String(e.message).replace(TOK, "***")); process.exit(1); });
