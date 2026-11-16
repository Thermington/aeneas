import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHub } from "./helpers.js";
import { parseCatalog, curated } from "../src/reference/catalog.js";
import { DEFAULT_SETTINGS, planBooks, sourcesView, type Settings } from "../src/reference/plan.js";
import { isUpdate, referenceFor, startReference } from "../src/reference/index.js";
import { book, noNetwork, REF_FIXTURES, seedReference } from "./reference-helpers.js";

const catalog = curated(parseCatalog(fs.readFileSync(path.join(REF_FIXTURES, "catalog.xml"), "utf8")));
const plan = (s: Partial<Settings>, dropped: string[] = []) => planBooks({ ...DEFAULT_SETTINGS, ...s }, catalog, new Set(dropped)).map((w) => `${w.name}:${w.flavour}`);

test("reference plan: one book per chosen source and language, in the flavour the choices ask for", () => {
  assert.deepEqual(plan({}), [], "nothing is wanted until sources are picked");
  assert.deepEqual(plan({ sources: ["wikipedia"] }), ["wikipedia_en_all:nopic"], "text only by default; the main English one, not Simple English");
  assert.deepEqual(plan({ sources: ["wikipedia"], images: true }), ["wikipedia_en_all:maxi"]);
  assert.deepEqual(plan({ sources: ["wikipedia"], images: true, wikipedia: "intros" }), ["wikipedia_en_all:mini"], "intros: pictures do not apply");
  assert.deepEqual(plan({ sources: ["wikipedia"], languages: ["eng", "spa"] }), ["wikipedia_en_all:nopic", "wikipedia_es_all:nopic"]);
  assert.deepEqual(plan({ sources: ["wikipedia"], wikipedia: "intros", languages: ["spa"] }), ["wikipedia_es_all:nopic"], "no intros in Spanish: text only");
  // Per source: its own languages and pictures.
  assert.deepEqual(plan({ sources: ["wikipedia", "wiktionary"], languages: ["eng"], overrides: { wikipedia: { languages: ["spa"], images: true } } }), ["wikipedia_es_all:maxi", "wiktionary_en_all:nopic"]);
  // No nopic: the only kind; of two kinds, the smaller (mdwiki's maxi, not the one with videos).
  assert.deepEqual(plan({ sources: ["mdwiki"] }), ["mdwiki_en_all:maxi"]);
  assert.deepEqual(plan({ sources: ["mdwiki"], images: true }), ["mdwiki_en_all:maxi"]);
  assert.deepEqual(plan({ sources: ["archwiki"] }), ["archlinux_en_all:maxi"], "the only kind there is");
  // Sources of several archives want each one.
  assert.deepEqual(plan({ sources: ["libretexts", "devdocs"] }), ["libretexts.org_en_bio:", "libretexts.org_en_chem:", "devdocs_en_bash:", "devdocs_en_python:"]);
  assert.deepEqual(plan({ sources: ["gutenberg"] }), ["gutenberg_en_all:"], "never the every-language archive");
  // An archive with two languages counts for either, listed under its own.
  const so = planBooks({ ...DEFAULT_SETTINGS, sources: ["stackoverflow_es"] }, catalog);
  assert.deepEqual(so.map((w) => [w.name, w.lang, w.langs]), [["es.stackoverflow.com_mul_all", "spa", ["eng", "spa"]]]);
  assert.deepEqual(plan({ sources: ["wiktionary"], languages: ["spa"] }), [], "a language a source does not have wants nothing");
  assert.deepEqual(plan({ sources: ["wikipedia", "archwiki"] }, ["wikipedia_en_all"]), ["archlinux_en_all:maxi"], "a book the owner removed is left out");
  const w = planBooks({ ...DEFAULT_SETTINGS, sources: ["archwiki"] }, catalog)[0];
  assert.deepEqual({ ...w }, { name: "archlinux_en_all", flavour: "maxi", lang: "eng", langs: ["eng"], source: "archwiki", title: "ArchWiki & friends", date: "2026-10-21", updated: "2026-10-21T00:00:00Z", bytes: 38311936, articles: 16485, fulltext: true, images: true, file: "archlinux_en_all_maxi_2026-10.zim", meta4: "https://lb.download.kiwix.org/zim/test/archlinux_en_all_maxi_2026-10.zim.meta4" });
});

test("reference sources: each curated source with its books by language, named in English and in itself", () => {
  const view = sourcesView(catalog);
  const wiki = view.find((s) => s.id === "wikipedia")!;
  assert.equal(wiki.group, "Encyclopedias");
  assert.equal(wiki.license, "CC BY-SA 4.0");
  assert.deepEqual(wiki.languages.map((l) => [l.code, l.tag, l.name, l.native]), [["eng", "en", "English", "English"], ["spa", "es", "Spanish", "Español"]]);
  assert.deepEqual(wiki.languages[0].books.map((b) => [b.name, b.flavour, b.images]), [["wikipedia_en_all", "mini", false], ["wikipedia_en_all", "nopic", false], ["wikipedia_en_all", "maxi", true]], "every flavour of the one archive per language, smallest first");
  const so = view.find((s) => s.id === "stackoverflow_es")!;
  assert.deepEqual(so.languages.map((l) => l.code), ["eng", "spa"]);
  assert.equal(view.find((s) => s.id === "ifixit")!.languages.length, 0, "a source the catalog lacks is listed with no languages");
  assert.ok(!view.some((s) => s.languages.some((l) => l.books.some((b) => b.name === "ted_en_all"))));
});

test("reference settings: defaults, every value checked (422), and the plan against the disk", async () => {
  const t = makeHub();
  try {
    const get = await (await t.api("/reference/settings")).json() as { settings: Settings; plan: Record<string, unknown> };
    assert.deepEqual(get.settings, { sources: [], languages: ["eng"], images: false, wikipedia: "text", overrides: {}, schedule: "nights", max_mbps: null });
    assert.deepEqual(Object.keys(get.plan).sort(), ["fits", "free_bytes", "to_download_bytes", "wanted_bytes"]);
    const bad = async (body: unknown) => (await t.api("/reference/settings", { method: "PUT", json: body })).status;
    for (const body of [
      { sources: "wikipedia" }, { sources: ["wikipedia", "encyclopaedia"] }, { languages: ["eng", "xx"] }, { languages: "eng" },
      { images: "yes" }, { wikipedia: "all" }, { schedule: "weekly" }, { max_mbps: -1 }, { max_mbps: "fast" }, { max_mbps: 0 },
      { overrides: { nope: { images: true } } }, { overrides: { wikipedia: { colour: "red" } } }, { overrides: { wikipedia: { languages: ["zz"] } } },
      { overrides: [] }, { sources: [], colour: "red" },
    ]) assert.equal(await bad(body), 422, JSON.stringify(body));
    assert.equal((await t.api("/reference/settings", { method: "PUT", body: "not json", headers: { "content-type": "application/json" } })).status, 400);
    // A catalog the hub read: the plan counts what the choices want.
    const s = startReference(t.hub, { fetch: (async () => new Response(fs.readFileSync(path.join(REF_FIXTURES, "catalog.xml")))) as typeof fetch, gameRunning: async () => null, reader: { binary: "none" } });
    try {
      assert.equal((await t.api("/reference/sources")).status, 200);
      const put = await (await t.api("/reference/settings", { method: "PUT", json: { sources: ["archwiki", "devdocs"], images: true, max_mbps: 40, schedule: "any" } })).json() as { settings: Settings; plan: { wanted_bytes: number; to_download_bytes: number; free_bytes: number; fits: boolean } };
      assert.deepEqual(put.settings.sources, ["archwiki", "devdocs"]);
      assert.equal(put.settings.max_mbps, 40);
      assert.equal(put.plan.wanted_bytes, 38311936 + 572416 + 20000000);
      assert.equal(put.plan.to_download_bytes, put.plan.wanted_bytes, "nothing is on the hub yet");
      assert.ok(put.plan.free_bytes > 0);
      assert.equal(typeof put.plan.fits, "boolean");
      const status = await (await t.api("/reference/status")).json() as { downloads: { name: string; state: string }[] };
      assert.deepEqual(status.downloads.map((d) => d.name), ["archlinux_en_all", "devdocs_en_bash", "devdocs_en_python"]);
    } finally { s(); }
    // Off: every path answers 404 with the module's message.
    t.hub.modules.set({ reference: false });
    const off = await t.api("/reference/settings");
    assert.equal(off.status, 404);
    assert.deepEqual(await off.json(), { error: "Offline reference is off. Turn it on in Settings, Modules.", module: "reference" });
  } finally { t.cleanup(); }
});

test("reference sources: the catalog is read when first needed, at most once a day, and its failure is said", async () => {
  const t = makeHub();
  let calls = 0;
  let fail = true;
  const s = startReference(t.hub, { fetch: (async () => { calls++; if (fail) throw new TypeError("fetch failed"); return new Response(fs.readFileSync(path.join(REF_FIXTURES, "catalog.xml"))); }) as typeof fetch, reader: { binary: "none" } });
  try {
    const first = await t.api("/reference/sources");
    assert.equal(first.status, 502);
    assert.match(((await first.json()) as { error: string }).error, /catalog could not be read/);
    fail = false;
    const ok = await (await t.api("/reference/sources")).json() as { checked_at: string; sources: { id: string }[] };
    assert.ok(ok.checked_at);
    assert.ok(ok.sources.some((x) => x.id === "archwiki"));
    await t.api("/reference/sources");
    assert.equal(calls, 2, "read again only after a day");
    const saved = JSON.parse(fs.readFileSync(path.join(t.hub.cfg.referenceDir, "state.json"), "utf8")) as { catalog: { books: { tags: string[] }[] } };
    assert.ok(saved.catalog.books.length > 10 && saved.catalog.books.every((b) => b.tags.length === 0), "kept in state.json, trimmed");
    assert.equal(t.hub.cfg.referenceDir, path.join(t.dir, "reference"));
  } finally { s(); t.cleanup(); }
});

test("reference books: removing one drops it until it is chosen again; unchoosing a source removes its books", async () => {
  const t = makeHub();
  seedReference(t, [book("archlinux_en_all", "archlinux_en_all_maxi_2026-10.zim"), book("devdocs_en_bash", "devdocs_en_bash_2026-10.zim", { source: "devdocs", title: "Bash Docs", flavour: "" })]);
  const fetchCatalog = (async () => new Response(fs.readFileSync(path.join(REF_FIXTURES, "catalog.xml")))) as typeof fetch;
  // Not started: no reader, no downloads; the choices and the books are still the owner's to change.
  const svc = referenceFor(t.hub, { fetch: fetchCatalog });
  try {
    assert.equal((await t.api("/reference/books/nope", { method: "DELETE" })).status, 404);
    const after = await (await t.api("/reference/books/archlinux_en_all", { method: "DELETE" })).json() as { books: { name: string; state: string }[] };
    assert.equal(after.books.find((b) => b.name === "archlinux_en_all")?.state, "removing");
    // The catalog read: archlinux is not wanted again while it stays chosen as before.
    await t.api("/reference/sources");
    let st = await (await t.api("/reference/settings", { method: "PUT", json: { sources: ["archwiki", "devdocs"] } })).json() as { settings: Settings };
    assert.deepEqual(st.settings.sources, ["archwiki", "devdocs"]);
    let status = await (await t.api("/reference/status")).json() as { downloads: { name: string }[]; books: { name: string; state: string }[] };
    assert.ok(!status.downloads.some((d) => d.name === "archlinux_en_all"), "removed: not downloaded again");
    // Chosen again (the source off, then on): wanted again.
    await t.api("/reference/settings", { method: "PUT", json: { sources: ["devdocs"] } });
    await t.api("/reference/settings", { method: "PUT", json: { sources: ["devdocs", "archwiki"] } });
    status = await (await t.api("/reference/status")).json() as typeof status;
    assert.ok(status.downloads.some((d) => d.name === "archlinux_en_all"), "chosen again");
    // DevDocs no longer chosen: its book goes too.
    st = await (await t.api("/reference/settings", { method: "PUT", json: { sources: ["archwiki"] } })).json() as typeof st;
    status = await (await t.api("/reference/status")).json() as typeof status;
    assert.ok(!status.books.some((b) => b.name === "devdocs_en_bash" && b.state === "ready"), "unchosen: removing or gone");
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!fs.existsSync(path.join(t.hub.cfg.referenceDir, "files", "devdocs_en_bash_2026-10.zim")), "its file went: no reader had it open");
  } finally { await svc.stop(); t.cleanup(); }
});

test("reference catalog: checked weekly (a week missed while the hub was off is made up), never with no sources", async () => {
  const t = makeHub();
  const xml = fs.readFileSync(path.join(REF_FIXTURES, "catalog.xml"));
  let calls = 0;
  const checked = new Date(2026, 10, 1, 0, 50).getTime();
  let clock = checked + 3 * 24 * 3_600_000;
  seedReference(t, [], { settings: { sources: [] }, catalog: { checked_at: new Date(checked).toISOString(), books: [] } });
  const svc = referenceFor(t.hub, { fetch: (async () => { calls++; return new Response(xml); }) as typeof fetch, now: () => clock, gameRunning: async () => null, reader: { binary: "none" } });
  const weekly = () => (svc as unknown as { weekly(): Promise<void> }).weekly();
  try {
    await weekly();
    assert.equal(calls, 0, "no sources chosen: Kiwix is not asked");
    await t.api("/reference/settings", { method: "PUT", json: { sources: ["archwiki"] } });
    await weekly();
    assert.equal(calls, 0, "three days after the last check: not yet");
    assert.equal((await (await t.api("/reference/status")).json() as { next_check: string }).next_check, new Date(2026, 10, 8, 0, 50).toISOString());
    clock = checked + 9 * 24 * 3_600_000;
    await weekly();
    assert.equal(calls, 1, "more than a week: checked");
    await weekly();
    assert.equal(calls, 1, "and not again the same day");
  } finally { await svc.stop(); t.cleanup(); }
});

test("reference: its folder is in no backup outbox and no notes export", async () => {
  const { fillOutbox, settingsZip } = await import("../src/outbox.js");
  const { execFileSync } = await import("node:child_process");
  const t = makeHub();
  try {
    seedReference(t, [book("archlinux_en_all", "archlinux_en_all_maxi_2026-10.zim")]);
    fs.mkdirSync(path.join(t.hub.cfg.referenceDir, "partial"), { recursive: true });
    fs.writeFileSync(path.join(t.hub.cfg.referenceDir, "partial", "wikipedia_en_all_maxi_2026-08.zim"), "part");
    const report = await fillOutbox(t.hub.cfg.dataDir, t.hub.backupKey, []);
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    assert.ok(!walk(report.dir).some((f) => /reference|\.zim/.test(f)), "nothing of the reference in the outbox");
    assert.ok((settingsZip(t.hub.cfg.dataDir)?.files ?? 0) < 20);
    const tgz = path.join(t.dir, "notes.tgz");
    fs.writeFileSync(tgz, Buffer.from(await (await t.api("/vault/export")).arrayBuffer()));
    assert.doesNotMatch(execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" }), /reference|\.zim/, "nor in the notes export");
  } finally { t.cleanup(); }
});

test("reference: a newer file of the same kind is an update; pictures or intros switched by the owner is not", () => {
  const books = [{ name: "wikipedia_en_all", flavour: "nopic", state: "ready" as const }, { name: "archlinux_en_all", flavour: "maxi", state: "removing" as const }];
  assert.equal(isUpdate(books, { name: "wikipedia_en_all", flavour: "nopic" }), true);
  assert.equal(isUpdate(books, { name: "wikipedia_en_all", flavour: "maxi" }), false, "pictures switched on starts at once");
  assert.equal(isUpdate(books, { name: "wikipedia_en_all", flavour: "mini" }), false, "intros only starts at once");
  assert.equal(isUpdate(books, { name: "archlinux_en_all", flavour: "maxi" }), false, "a book being removed is not one to update");
  assert.equal(isUpdate(books, { name: "wiktionary_en_all", flavour: "nopic" }), false);
});
