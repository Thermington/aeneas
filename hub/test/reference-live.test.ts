import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { makeHub } from "./helpers.js";
import { referenceFor, startReference } from "../src/reference/index.js";
import { sourceOfBook } from "../src/reference/sources.js";
import { installKiwix, kiwixPlatform, KIWIX_PINS } from "../src/reference/kiwix.js";
import { runTool, type ToolContext } from "../src/ai/tools.js";
import { book, noNetwork, waitFor } from "./reference-helpers.js";

/*
 * The offline reference with Kiwix's real reader and a real archive, run by hand:
 *   EA_TEST_KIWIX_SERVE=<path to kiwix-serve 3.8.1> EA_TEST_ZIM=<an archive, ArchWiki for the most checks> npm test
 * and, to install the reader from Kiwix's own release archive (served from this machine, checked against its pin):
 *   EA_TEST_KIWIX_ARCHIVE=<the kiwix-tools archive for this machine>
 * Nothing here contacts another machine.
 */
const SERVE = process.env.EA_TEST_KIWIX_SERVE;
const ZIM = process.env.EA_TEST_ZIM;
const ARCHIVE = process.env.EA_TEST_KIWIX_ARCHIVE;

test("reference live: search, read, preview, pictures and the assistant with the real reader", { skip: !SERVE || !ZIM ? "set EA_TEST_KIWIX_SERVE and EA_TEST_ZIM to run" : false, timeout: 120_000 }, async () => {
  const t = makeHub();
  const file = path.basename(ZIM!);
  const name = file.replace(/\.zim$/, "").replace(/(?:_(?:maxi|nopic|mini))?_\d{4}-\d\d$/, "");
  const source = sourceOfBook(name)?.source.id ?? "archwiki";
  const files = path.join(t.hub.cfg.referenceDir, "files");
  fs.mkdirSync(files, { recursive: true });
  fs.copyFileSync(ZIM!, path.join(files, file), fs.constants.COPYFILE_FICLONE);
  fs.writeFileSync(path.join(t.hub.cfg.referenceDir, "state.json"), JSON.stringify({ version: 1, settings: { sources: [source], languages: ["eng"] }, catalog: { checked_at: null, books: [] }, books: [book(name, file, { source, bytes: fs.statSync(ZIM!).size })], downloads: [], dropped: [], paused: false }));
  const stop = startReference(t.hub, { reader: { binary: SERVE }, gameRunning: async () => null, fetch: noNetwork });
  const json = async (p: string) => { const r = await t.api(p); return { status: r.status, body: (await r.json()) as any, headers: r.headers }; };
  try {
    await waitFor(() => referenceFor(t.hub).reader.state === "ready", 30_000, "the real reader");
    const status = await json("/reference/status");
    assert.equal(status.body.reader.state, "ready");
    assert.equal(status.body.books[0].state, "ready");
    const rnd = await json("/reference/random");
    assert.equal(rnd.status, 200);
    const page = await json(`/reference/article?book=${name}&path=${encodeURIComponent(rnd.body.path)}`);
    assert.equal(page.status, 200, `article ${rnd.body.path}`);
    assert.doesNotMatch(page.body.html, /<(script|style|iframe|object|embed|form|link|meta)\b|\son[a-z]+=|javascript:|\ssrc=|\sstyle=|\sclass=/i);
    if (name !== "archlinux_en_all") return;

    // ArchWiki: what a person would do.
    const sug = await json("/reference/suggest?q=bluetooth&limit=8");
    assert.equal(sug.body.results[0].title, "Bluetooth");
    assert.equal(sug.body.partial, false);
    const s = await json("/reference/search?q=bluetooth%20headset&limit=20");
    assert.equal(s.status, 200);
    const hits = s.body.results as { title: string; path: string; kind: string; snippet: string }[];
    assert.equal(hits[0].title, "Bluetooth headset", "the English page first, not its Russian copy the reader ranks first");
    assert.equal(hits[0].path, "Bluetooth_headset");
    assert.match(hits[0].snippet, /<b>/);
    const copies = hits.map((h, i) => (/\((Русский|Español|Magyar|Português|Italiano|Deutsch|Français|日本語|简体中文|Polski|Čeština|Українська)\)$/.test(h.title) ? i : -1)).filter((i) => i >= 0);
    const firstCopy = copies[0] ?? hits.length;
    assert.ok(hits.slice(firstCopy).every((h) => /\(.+\)$/.test(h.title)), "copies in other languages after everything else");
    assert.ok(s.body.total > 10);
    const a = await json(`/reference/article?book=${name}&path=Bluetooth_Headset`);
    assert.equal(a.body.path, "Bluetooth_headset", "the redirect was followed");
    assert.equal(a.body.url, "https://wiki.archlinux.org/title/Bluetooth_headset");
    assert.equal(a.body.license, "GFDL 1.3 or later");
    assert.ok(a.body.toc.some((x: { text: string; level: number }) => x.text === "Headset via PipeWire" && x.level === 2));
    assert.match(a.body.html, /data-book="archlinux_en_all" data-path="PipeWire"/);
    assert.match(a.body.html, /rel="noopener noreferrer" data-external=""/);
    const sum = await json(`/reference/summary?book=${name}&path=Systemd%2FUser`);
    assert.match(sum.body.text, /^systemd offers the ability to manage services under the user's control/);
    const png = await t.api(`/reference/media?book=${name}&path=_res_%2Ffavicon.png`);
    assert.equal(png.status, 200);
    assert.equal(png.headers.get("content-type"), "image/png");
    assert.equal(png.headers.get("content-security-policy"), "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    assert.equal((await t.api(`/reference/media?book=${name}&path=_mw_%2Fskins.vector.styles.css`)).status, 404, "a stylesheet is not a picture");
    // The assistant looks it up and reads the part that answers.
    const api = async (method: string, p: string, body?: unknown) => { const r = await t.api(p, { method, json: body }); return { status: r.status, data: await r.json() }; };
    const ctx = { sessionId: "s", lastUser: "my bluetooth headset is way too loud, how do I fix the volume?", topic: "", store: t.hub.store, cfg: t.hub.cfg, hosts: null, moduleOn: t.hub.modules.check } as ToolContext;
    const found = JSON.parse((await runTool(api, { name: "reference_search", arguments: { query: "bluetooth headset", source: "ArchWiki" } }, ctx)).text) as { results: { title: string; date: string }[] };
    assert.equal(found.results[0].title, "Bluetooth headset");
    assert.equal(found.results[0].date, "2026-10-21");
    const read = JSON.parse((await runTool(api, { name: "reference_read", arguments: { book: name, path: "Bluetooth_headset" } }, ctx)).text) as { text: string };
    assert.match(read.text, /## Troubleshooting/);
    assert.match(read.text, /volume/i);
    assert.ok(read.text.length <= 6000);
  } finally { stop(); await referenceFor(t.hub).stop(); t.cleanup(); }
});

test("reference live: the reader installed from Kiwix's own archive, checked against its pin", { skip: !ARCHIVE ? "set EA_TEST_KIWIX_ARCHIVE to run" : process.platform === "win32" ? "not on Windows" : false, timeout: 120_000 }, async () => {
  const platform = kiwixPlatform();
  assert.ok(platform, "a system Kiwix builds for");
  const pin = KIWIX_PINS[platform!];
  assert.equal(path.basename(ARCHIVE!), pin.file, "the archive for this machine");
  const bytes = fs.readFileSync(ARCHIVE!);
  const server = http.createServer((req, res) => {
    if (req.url === `/release/${pin.file}`) { res.writeHead(200, { "content-length": String(bytes.length) }); res.end(bytes); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-ref-real-install-"));
  try {
    const exe = await installKiwix({ binDir, releaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/release/`, allowHttpLoopback: true });
    assert.match(execFileSync(exe, ["--version"], { encoding: "utf8", timeout: 10_000 }), /kiwix-tools 3\.8\.1/);
  } finally { server.close(); fs.rmSync(binDir, { recursive: true, force: true }); }
});
