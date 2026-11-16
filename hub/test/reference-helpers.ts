import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestHub } from "./helpers.js";
import type { ReferenceOptions, StoredBook } from "../src/reference/index.js";

/** Fixtures for the offline reference: a small catalog, a metalink, a stand-in reader and its books. */
export const REF_FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "reference");
export const FAKE_SERVE = path.join(REF_FIXTURES, "fake-kiwix-serve.mjs");

/** The stand-in kiwix-serve, run with node and the same arguments the hub gives the real one. */
export function fakeReader(): NonNullable<ReferenceOptions["reader"]> {
  return { binary: "kiwix-serve", command: (_bin, args) => ({ file: process.execPath, args: [FAKE_SERVE, ...args] }), startTimeoutMs: 15_000 };
}

/** No request leaves the test. */
export const noNetwork = (async () => { throw new TypeError("fetch failed: no network in tests"); }) as unknown as typeof fetch;

export function book(name: string, file: string, extra: Partial<StoredBook> = {}): StoredBook {
  return { name, flavour: "maxi", lang: "eng", langs: ["eng"], source: "archwiki", title: "ArchWiki", date: "2026-10-21", updated: "2026-10-21T00:00:00Z", bytes: 1000, articles: 10, fulltext: true, images: true, file, state: "ready", old_file: null, ...extra };
}

/** A reference folder as a hub that already downloaded `books` leaves it (each file a placeholder the stand-in reader accepts). */
export function seedReference(t: TestHub, books: StoredBook[], extra: Record<string, unknown> = {}): string {
  const dir = t.hub.cfg.referenceDir;
  fs.mkdirSync(path.join(dir, "files"), { recursive: true });
  for (const b of books) fs.writeFileSync(path.join(dir, "files", b.file), "zim");
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ version: 1, settings: { sources: [...new Set(books.map((b) => b.source))], languages: ["eng"] }, catalog: { checked_at: null, books: [] }, books, downloads: [], dropped: [], paused: false, ...extra }));
  return dir;
}

export async function waitFor(cond: () => boolean | Promise<boolean>, ms = 15_000, what = "the condition"): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}
