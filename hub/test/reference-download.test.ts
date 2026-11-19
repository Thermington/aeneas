import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { downloadArchive, partialPaths, readPartial } from "../src/reference/download.js";
import { httpGet, NetError, type GetOptions } from "../src/reference/net.js";
import type { Metalink } from "../src/reference/metalink.js";
import { setDiskSpaceOverride } from "../src/diskspace.js";
import { startReference, referenceFor } from "../src/reference/index.js";
import { makeHub, roomyDisk } from "./helpers.js";
import { fakeReader, waitFor } from "./reference-helpers.js";

const PIECE = 16_384;
const SIZE = 100_000;
const DATA = Buffer.from(Array.from({ length: SIZE }, (_, i) => (i * 31 + (i >> 8)) & 255));
const sha1 = (b: Buffer) => createHash("sha1").update(b).digest("hex");
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const PIECES = Array.from({ length: Math.ceil(SIZE / PIECE) }, (_, i) => sha1(DATA.subarray(i * PIECE, (i + 1) * PIECE)));
/** Piece 3 (bytes 32768 to 49151) comes wrong from a bad mirror. */
const BAD = Buffer.from(DATA);
for (let i = 2 * PIECE + 10; i < 2 * PIECE + 20; i++) BAD[i] ^= 0xff;

interface Hit { path: string; range: string | null }

/** Mirrors on 127.0.0.1: good, bad (one wrong piece), cut (drops after 20 KB), norange (ignores ranges), stall, slow. */
async function mirrors(data: () => Buffer = () => DATA): Promise<{ base: string; hits: Hit[]; close(): Promise<void> }> {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    const kind = (req.url ?? "").split("/")[1];
    const range = req.headers.range ?? null;
    hits.push({ path: req.url ?? "", range });
    const body = kind === "bad" || kind === "bad2" ? BAD : data();
    const m = /^bytes=(\d+)-/.exec(range ?? "");
    let start = m ? Number(m[1]) : 0;
    if (kind === "norange") start = 0;
    if (start >= body.length) { res.writeHead(416); res.end(); return; }
    const slice = body.subarray(start);
    res.writeHead(start > 0 ? 206 : 200, { "content-length": String(slice.length), ...(start > 0 ? { "content-range": `bytes ${start}-${body.length - 1}/${body.length}` } : {}) });
    if (kind === "cut") { res.write(slice.subarray(0, 20_000)); setTimeout(() => res.socket?.destroy(), 20); return; }
    if (kind === "stall") { res.write(slice.subarray(0, 1000)); return; }
    if (kind === "slow") {
      let at = 0;
      const tick = setInterval(() => {
        if (res.destroyed) { clearInterval(tick); return; }
        res.write(slice.subarray(at, at + 2048)); at += 2048;
        if (at >= slice.length) { clearInterval(tick); res.end(); }
      }, 15);
      return;
    }
    res.end(slice);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, hits, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const meta = (urls: string[], over: Partial<Metalink> = {}): Metalink => ({ file: "devdocs_en_bash_2026-10.zim", size: SIZE, sha256: sha256(DATA), pieceLength: PIECE, pieces: PIECES, urls, ...over });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ea-ref-dl-"));

test("reference download: every piece checked as it lands, then the whole file's SHA-256", async () => {
  const m = await mirrors();
  const dir = tmp();
  try {
    const seen: number[] = [];
    let verifying = false;
    const r = await downloadArchive({ partialDir: dir, meta: meta([`${m.base}/good/f.zim`]), signal: new AbortController().signal, allowHttpLoopback: true, onProgress: (n) => seen.push(n), onVerifying: () => { verifying = true; } });
    assert.deepEqual(r, { ok: true, file: path.join(dir, "devdocs_en_bash_2026-10.zim") });
    assert.deepEqual(fs.readFileSync(path.join(dir, "devdocs_en_bash_2026-10.zim")), DATA);
    assert.equal(readPartial(dir, "devdocs_en_bash_2026-10.zim")?.verified, PIECES.length);
    assert.ok(verifying && seen.at(-1) === SIZE);
    assert.equal(m.hits[0].range, "bytes=0-");
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, "devdocs_en_bash_2026-10.zim")).mode & 0o077, 0, "the partial file is the hub's alone");
  } finally { await m.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("reference download: a cut goes on with a range from the last checked piece; a stop keeps them for the next start", async () => {
  const m = await mirrors();
  const dir = tmp();
  try {
    const r = await downloadArchive({ partialDir: dir, meta: meta([`${m.base}/cut/f.zim`]), signal: new AbortController().signal, allowHttpLoopback: true });
    assert.equal(r.ok, true);
    assert.deepEqual(fs.readFileSync(path.join(dir, "devdocs_en_bash_2026-10.zim")), DATA);
    const starts = m.hits.map((h) => Number(/bytes=(\d+)-/.exec(h.range ?? "")?.[1]));
    assert.ok(starts.length > 3, "several requests");
    assert.ok(starts.every((s, i) => s % PIECE === 0 && (i === 0 || s > starts[i - 1])), `each from a piece boundary, further on: ${starts.join(",")}`);

    // Stopped at about 40 KB: two pieces are kept, and the next start asks from the third.
    fs.rmSync(dir, { recursive: true, force: true });
    m.hits.length = 0;
    const ctl = new AbortController();
    const first = await downloadArchive({ partialDir: dir, meta: meta([`${m.base}/slow/f.zim`]), signal: ctl.signal, allowHttpLoopback: true, onProgress: (n) => { if (n >= 40_000) ctl.abort(); } });
    assert.equal(first.ok, false);
    assert.equal((first as { kind: string }).kind, "aborted");
    assert.equal(readPartial(dir, "devdocs_en_bash_2026-10.zim")?.verified, 2);
    // A mirror that ignores ranges is passed over once the download is under way.
    const second = await downloadArchive({ partialDir: dir, meta: meta([`${m.base}/norange/f.zim`, `${m.base}/good/f.zim`]), signal: new AbortController().signal, allowHttpLoopback: true });
    assert.equal(second.ok, true);
    assert.deepEqual(fs.readFileSync(path.join(dir, "devdocs_en_bash_2026-10.zim")), DATA);
    assert.deepEqual(m.hits.slice(-2).map((h) => [h.path.split("/")[1], h.range]), [["norange", `bytes=${2 * PIECE}-`], ["good", `bytes=${2 * PIECE}-`]]);
  } finally { await m.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("reference download: a bad piece is fetched again from the next mirror; one no mirror sends right ends it", async () => {
  const m = await mirrors();
  const dir = tmp();
  try {
    const r = await downloadArchive({ partialDir: dir, meta: meta([`${m.base}/bad/f.zim`, `${m.base}/good/f.zim`]), signal: new AbortController().signal, allowHttpLoopback: true });
    assert.equal(r.ok, true);
    assert.deepEqual(fs.readFileSync(path.join(dir, "devdocs_en_bash_2026-10.zim")), DATA);
    assert.deepEqual(m.hits.map((h) => [h.path.split("/")[1], h.range]), [["bad", "bytes=0-"], ["good", `bytes=${2 * PIECE}-`]]);

    fs.rmSync(dir, { recursive: true, force: true });
    const r2 = await downloadArchive({ partialDir: dir, meta: meta([`${m.base}/bad/f.zim`, `${m.base}/bad2/f.zim`]), signal: new AbortController().signal, allowHttpLoopback: true });
    assert.deepEqual(r2, { ok: false, kind: "bad", error: "piece 3 did not match its SHA-1 from any mirror" });
    const p = partialPaths(dir, "devdocs_en_bash_2026-10.zim");
    assert.ok(!fs.existsSync(p.data) && !fs.existsSync(p.json), "starts again from nothing next time");
  } finally { await m.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("reference download: a SHA-256 that does not match is never used", async () => {
  const m = await mirrors();
  const dir = tmp();
  try {
    const r = await downloadArchive({ partialDir: dir, meta: meta([`${m.base}/good/f.zim`], { sha256: "0".repeat(64) }), signal: new AbortController().signal, allowHttpLoopback: true });
    assert.deepEqual(r, { ok: false, kind: "bad", error: "the file's SHA-256 did not match the metalink" });
    assert.deepEqual(fs.readdirSync(dir), [], "the file and its progress are gone");
    // No piece hashes: only the whole file's SHA-256, which still decides.
    const noPieces = await downloadArchive({ partialDir: dir, meta: meta([`${m.base}/cut/f.zim`], { pieceLength: 0, pieces: [] }), signal: new AbortController().signal, allowHttpLoopback: true });
    assert.equal(noPieces.ok, true);
    assert.deepEqual(fs.readFileSync(path.join(dir, "devdocs_en_bash_2026-10.zim")), DATA);
  } finally { await m.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("reference download: https only, time limits, offline when no mirror answers, and the speed cap", async () => {
  const m = await mirrors();
  const dir = tmp();
  try {
    const plain = await downloadArchive({ partialDir: dir, meta: meta([`${m.base}/good/f.zim`]), signal: new AbortController().signal });
    assert.equal((plain as { kind: string }).kind, "offline", "plain http is refused, so nothing answered");
    assert.equal(m.hits.length, 0, "not even asked");
    fs.rmSync(dir, { recursive: true, force: true });
    const closed = await downloadArchive({ partialDir: dir, meta: meta(["http://127.0.0.1:1/f.zim"]), signal: new AbortController().signal, allowHttpLoopback: true });
    assert.equal((closed as { kind: string }).kind, "offline");
    // A mirror that stops sending is dropped after the idle limit; the next one finishes.
    fs.rmSync(dir, { recursive: true, force: true });
    const stalled = await downloadArchive({ partialDir: dir, meta: meta([`${m.base}/stall/f.zim`, `${m.base}/good/f.zim`]), signal: new AbortController().signal, allowHttpLoopback: true, idleTimeoutMs: 300 });
    assert.equal(stalled.ok, true);
    // 100 kB at 200 kB/s takes about half a second.
    fs.rmSync(dir, { recursive: true, force: true });
    const t0 = Date.now();
    const capped = await downloadArchive({ partialDir: dir, meta: meta([`${m.base}/good/f.zim`]), signal: new AbortController().signal, allowHttpLoopback: true, maxBytesPerSecond: () => 200_000 });
    assert.equal(capped.ok, true);
    assert.ok(Date.now() - t0 >= 300, `took ${Date.now() - t0} ms`);
    // Redirects are followed over https only.
    await assert.rejects(httpGet("https://127.0.0.1:1/x", { connectTimeoutMs: 2000 }), /connection failed|no answer/);
  } finally { await m.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

/** A catalog with one ArchWiki file and its metalink, both on Kiwix's addresses; the mirror is the test server. */
function kiwix(file: () => string, data: () => Buffer) {
  const catalog = () => `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>urn:uuid:1</id><title>ArchWiki</title><updated>2026-10-21T00:00:00Z</updated><summary>s</summary><language>eng</language><name>archlinux_en_all</name><flavour>maxi</flavour><tags>_pictures:yes;_ftindex:yes</tags><articleCount>10</articleCount><link rel="http://opds-spec.org/acquisition/open-access" type="application/x-zim" href="https://lb.download.kiwix.org/zim/other/${file()}.meta4" length="${data().length}"/></entry></feed>`;
  const pieces = () => Array.from({ length: Math.ceil(data().length / PIECE) }, (_, i) => `<hash>${sha1(data().subarray(i * PIECE, (i + 1) * PIECE))}</hash>`).join("");
  const metalink = () => `<?xml version="1.0"?><metalink xmlns="urn:ietf:params:xml:ns:metalink"><file name="${file()}"><size>${data().length}</size><hash type="sha-256">${sha256(data())}</hash><pieces length="${PIECE}" type="sha-1">${pieces()}</pieces><url priority="1">https://mirror.test/good/${file()}</url></file></metalink>`;
  const asked: string[] = [];
  const fetchFn = (async (url: string) => {
    asked.push(String(url));
    if (String(url).startsWith("https://library.kiwix.org/")) return new Response(catalog());
    if (String(url).endsWith(".meta4")) return new Response(metalink());
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, asked };
}

/** Archives come only from the test's mirror; any other address (download.kiwix.org, the metalink's last) is refused. */
function mirrorGet(base: string, kind: () => string) {
  return (url: string, opts: GetOptions) => url.startsWith("https://mirror.test/good/")
    ? httpGet(url.replace("https://mirror.test/good/", `${base}/${kind()}/`), { ...opts, allowHttpLoopback: true })
    : Promise.reject(new NetError("not in this test", "refused"));
}

type Status = { reader: { state: string }; books: { name: string; state: string; file: string }[]; downloads: { name: string; state: string; reason?: string; done_bytes: number; bytes: number; speed_bps: number; eta_s: number | null; error?: string }[]; plan: { wanted_bytes: number; to_download_bytes: number; fits: boolean } };

test("reference downloads: one at a time, waiting for a game, the disk and the night; done, the reader serves it and an update replaces it", async () => {
  let current = Buffer.from(DATA);
  let file = "archlinux_en_all_maxi_2026-10.zim";
  const m = await mirrors(() => current);
  const t = makeHub();
  let game: string | null = "steam game is using the GPU";
  let clock = new Date(2026, 10, 16, 12, 0, 0).getTime();
  const k = kiwix(() => file, () => current);
  const stop = startReference(t.hub, { fetch: k.fetchFn, get: mirrorGet(m.base, () => "good"), allowHttpLoopback: true, gameRunning: async () => game, reader: fakeReader(), everyMs: 40, now: () => clock });
  const svc = referenceFor(t.hub);
  const status = async () => (await (await t.api("/reference/status")).json()) as Status;
  try {
    assert.equal(k.asked.length, 0, "nothing is asked of Kiwix before the owner opens the sources");
    await t.api("/reference/sources");
    await t.api("/reference/settings", { method: "PUT", json: { sources: ["archwiki"] } });
    await waitFor(async () => (await status()).downloads[0]?.reason === "game", 5000, "waiting for the game");
    // The disk: low, or no room for the file plus 5 GB besides the 2 GB the disk watch keeps.
    game = null;
    setDiskSpaceOverride(() => ({ free_bytes: 1.5 * 1024 ** 3, total_bytes: 100 * 1024 ** 3, used_pct: 98.5, low: true }));
    await waitFor(async () => (await status()).downloads[0]?.reason === "disk", 5000, "waiting for the disk");
    setDiskSpaceOverride(() => ({ free_bytes: 6 * 1024 ** 3, total_bytes: 100 * 1024 ** 3, used_pct: 94, low: false }));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await status()).downloads[0]?.reason, "disk", "6 GB free is not room for the file and 7 GB more");
    assert.equal((await status()).plan.fits, false);
    roomyDisk();
    // A first download goes at once, even at noon with updates kept to the night.
    await waitFor(async () => (await status()).books.some((b) => b.name === "archlinux_en_all" && b.state === "ready"), 15_000, "the book");
    await waitFor(async () => (await status()).reader.state === "ready", 15_000, "the reader");
    let st = await status();
    assert.deepEqual(st.downloads, []);
    assert.deepEqual(st.books.map((b) => b.file), ["archlinux_en_all_maxi_2026-10.zim"]);
    assert.deepEqual(fs.readFileSync(path.join(t.hub.cfg.referenceDir, "files", "archlinux_en_all_maxi_2026-10.zim")), DATA);
    assert.deepEqual(fs.readdirSync(path.join(t.hub.cfg.referenceDir, "partial")), [], "nothing left in partial/");
    const sugg = await (await t.api("/reference/suggest?q=bluetooth")).json() as { results: { title: string }[] };
    assert.ok(sugg.results.some((r) => r.title === "Bluetooth"), "the reader serves the new book");

    // A newer file: an update, kept to 01:00 to 07:00.
    current = Buffer.concat([DATA, Buffer.from("newer")]);
    file = "archlinux_en_all_maxi_2026-11.zim";
    const checked = await (await t.api("/reference/check", { method: "POST" })).json() as Status;
    assert.equal(checked.books[0].state, "update", "a newer file is on its way");
    await waitFor(async () => (await status()).downloads[0]?.reason === "night", 5000, "waiting for the night");
    // Paused by the owner, then resumed.
    assert.equal(((await (await t.api("/reference/pause", { method: "POST" })).json()) as Status).downloads[0].state, "paused");
    assert.equal(((await (await t.api("/reference/resume", { method: "POST" })).json()) as Status).downloads[0].state, "queued");
    await waitFor(async () => (await status()).downloads[0]?.reason === "night", 5000, "back to waiting for the night");
    // The module off: everything waits and the reader stops; the files stay.
    t.hub.modules.set({ reference: false });
    await waitFor(() => svc.status().downloads[0]?.reason === "module" && svc.reader.state === "off", 5000, "the module off");
    assert.ok(fs.existsSync(path.join(t.hub.cfg.referenceDir, "files", "archlinux_en_all_maxi_2026-10.zim")));
    t.hub.modules.set({ reference: true });
    clock = new Date(2026, 10, 17, 2, 0, 0).getTime();
    await waitFor(async () => (await status()).books[0]?.file === "archlinux_en_all_maxi_2026-11.zim", 15_000, "the update");
    // The older file goes once the reader answers with the new one.
    await waitFor(() => fs.readdirSync(path.join(t.hub.cfg.referenceDir, "files")).join() === "archlinux_en_all_maxi_2026-11.zim", 15_000, "the old file to go");
    st = await status();
    assert.equal(st.books[0].state, "ready");
    const saved = JSON.parse(fs.readFileSync(path.join(t.hub.cfg.referenceDir, "state.json"), "utf8")) as { books: { file: string; old_file: string | null }[] };
    assert.deepEqual(saved.books.map((b) => [b.file, b.old_file]), [["archlinux_en_all_maxi_2026-11.zim", null]]);
    assert.ok(k.asked.every((u) => u.startsWith("https://library.kiwix.org/") || u.startsWith("https://lb.download.kiwix.org/")), "only Kiwix's own addresses");
  } finally { roomyDisk(); stop(); await svc.stop(); await m.close(); t.cleanup(); }
});

test("reference downloads: a cut download goes on after the hub restarts; a file that fails its checks is failed, the book in use kept", async () => {
  const m = await mirrors();
  const t = makeHub();
  let file = "archlinux_en_all_maxi_2026-10.zim";
  let data = DATA;
  const k = kiwix(() => file, () => data);
  let kind = "slow";
  const opts = { fetch: k.fetchFn, get: mirrorGet(m.base, () => kind), allowHttpLoopback: true, gameRunning: async () => null, reader: fakeReader(), everyMs: 40 };
  let stop = startReference(t.hub, opts);
  try {
    await t.api("/reference/sources");
    await t.api("/reference/settings", { method: "PUT", json: { sources: ["archwiki"], schedule: "any" } });
    await waitFor(() => (referenceFor(t.hub).status().downloads[0]?.done_bytes ?? 0) >= 2 * PIECE, 10_000, "some progress");
    // The hub stops and starts again: the download goes on from its checked pieces.
    stop();
    await referenceFor(t.hub).stop();
    m.hits.length = 0;
    kind = "good";
    stop = startReference(t.hub, opts);
    await waitFor(() => referenceFor(t.hub).status().books.some((b) => b.state === "ready"), 15_000, "the book");
    const resumed = m.hits.find((h) => h.path.startsWith("/good/"));
    assert.ok(resumed && Number(/bytes=(\d+)-/.exec(resumed.range ?? "")?.[1]) >= 2 * PIECE, `resumed with ${resumed?.range}`);
    assert.deepEqual(fs.readFileSync(path.join(t.hub.cfg.referenceDir, "files", "archlinux_en_all_maxi_2026-10.zim")), DATA);
    // A newer file whose bytes do not match its metalink: failed with the reason; the book in use stays.
    file = "archlinux_en_all_maxi_2026-11.zim";
    data = Buffer.from(DATA);
    data[5] ^= 1;
    await t.api("/reference/check", { method: "POST" });
    await waitFor(() => referenceFor(t.hub).status().downloads[0]?.state === "failed", 10_000, "the failure");
    assert.match(referenceFor(t.hub).status().downloads[0].error ?? "", /piece 1 did not match/);
    assert.equal(referenceFor(t.hub).status().books[0].file, "archlinux_en_all_maxi_2026-10.zim");
    assert.equal(referenceFor(t.hub).status().books[0].state, "update");
  } finally { stop(); await referenceFor(t.hub).stop(); await m.close(); t.cleanup(); }
});
