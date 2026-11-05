// Publish each slot of this group. Commit A (orphan) = m.bin + chunk pack 0; further packs are their own orphan
// commits (made by ready.js, each under jsDelivr's 50 MB per-commit limit); commit B = latest.json {sha: A} with
// A and the packs as parents. B goes to a temporary branch w-<slot> first and every file is checked on jsDelivr;
// only then s-<slot> is moved to B (so a failed upload never replaces a working video) and w-<slot> is deleted.
// The branch holds exactly one video and no older history.
const fs = require("fs"), { execFileSync, spawn } = require("child_process");
const REPO = process.env.GITHUB_REPOSITORY, TOK = process.env.GH_TOKEN, PUB = require("path").resolve("pub");
const ids = JSON.parse(fs.readFileSync("out/ids.json", "utf8")), stats = JSON.parse(fs.readFileSync("out/stats.json", "utf8"));
const T0 = Date.parse(stats.t0), SEEN = +process.env.SEEN || 0, out = [];
const sleep = (ms) => new Promise((w) => setTimeout(w, ms));
const ENV = { ...process.env, GIT_AUTHOR_NAME: "gf-ready-bot", GIT_COMMITTER_NAME: "gf-ready-bot", GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com", GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com" };
const sh = (cwd, ...a) => execFileSync("git", a, { cwd, env: ENV, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const URL_ = process.env.REMOTE || "https://x-access-token:" + TOK + "@github.com/" + REPO + ".git";
const shA = (cwd, ...a) => new Promise((res, rej) => { const p = spawn("git", a, { cwd, env: ENV, stdio: ["ignore", "ignore", "pipe"] }); let e = ""; p.stderr.on("data", (d) => (e = (e + d).slice(-1500))); p.on("exit", (c) => (c ? rej(Object.assign(new Error("git " + c), { stderr: e })) : res())); });
async function push(dir, spec, max) { // big pushes sometimes time out (HTTP 408): retry
  for (let t = 1; ; t++) { try { await shA(dir, "push", "-q", "-f", URL_, spec); return t; }
    catch (e) { const m = String(e.stderr || e.message).replace(TOK, "***").split("\n").filter(Boolean).slice(-2).join(" | "); console.log("push", spec.replace(/^[0-9a-f]{40}/, (x) => x.slice(0, 7)), "try", t, "failed:", m.slice(0, 200)); if (t >= (max || 4)) throw new Error("push failed " + spec.split(":")[1]); await sleep(Math.min(40000, 5000 * 2 ** (t - 1)) + Math.random() * 3000); } }
}
// GitHub answers "remote rejected (failed)" when too many pushes hit the repo at once (several slot jobs x 7-14 chunk
// pushes each): at most 3 chunk pushes at a time per job; if one still fails, everything goes up in one push.
async function pushAll(dir, list) {
  const tries = new Array(list.length).fill(0); let next = 0, bad = null;
  await Promise.all([0, 1, 2].map(async () => { while (next < list.length && !bad) { const k = next++; try { tries[k] = await push(dir, list[k], 5); } catch (e) { bad = e; } } }));
  if (!bad) return Math.max(...tries);
  console.log("chunk pushes failed (" + bad.message + "): one push with every ref");
  for (let t = 1; ; t++) { try { await shA(dir, "push", "-q", "-f", URL_, ...list); return 10 + t; }
    catch (e) { console.log("single push try", t, "failed:", String(e.stderr || e.message).replace(TOK, "***").split("\n").filter(Boolean).slice(-1).join("").slice(0, 200)); if (t >= 4) throw new Error("push failed (single push)"); await sleep(15000 * t); } }
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
    // every chunk commit goes up on its own connection at the same time (one push of 50+ MB was ~0.3 MB/s),
    // then B only adds latest.json on top of commits the server already has
    const tP = Date.now(), pre = [A, ...packs].map((c, k) => ({ c, ref: "w-" + slot + "-" + k }));
    const preTries = [await pushAll(dir, pre.map((x) => x.c + ":refs/heads/" + x.ref))];
    const pushTries = Math.max(...preTries, await push(dir, B + ":refs/heads/w-" + slot));
    const pushSec = (Date.now() - tP) / 1000;
    const pushedAt = Date.now();
    const via = {};
    for (const f of ["m", ...Array.from({ length: n }, (_, i) => i)]) {
      const sha = f === "m" || !cb[f] ? A : cb[f];
      via[f] = process.env.NOWARM ? "skip" : await serve("https://cdn.jsdelivr.net/gh/" + REPO + "@" + sha + "/" + id + "/" + f + ".bin");
    }
    await push(dir, B + ":refs/heads/s-" + slot);
    const playable = Date.now();
    try { sh(dir, "push", "-q", URL_, "--delete", "w-" + slot, ...pre.map((x) => x.ref)); } catch (e) { console.log("could not delete w-" + slot); }
    out.push({ slot, id, sha: A, packs, chunks: n, size: info.size, pushTries, pushSec, rawFiles: Object.keys(via).filter((k) => via[k] === "raw"), pushedSec: (pushedAt - T0) / 1000, playableSec: (playable - T0) / 1000, fromSeenSec: SEEN ? (playable - SEEN) / 1000 : null, playableAt: new Date(playable).toISOString() });
    console.log("published", JSON.stringify(out[out.length - 1]));
  }
  fs.writeFileSync("out/published.json", JSON.stringify(out, null, 1));
})().catch((e) => { console.log("FATAL", String(e.message).replace(TOK, "***")); process.exit(1); });
