import { Hono } from "hono";
import type { Hub } from "../hub.js";
import { readJsonObject } from "../http.js";
import { StoreError } from "../store.js";
import { referenceFor } from "../reference/index.js";
import { knownLanguage } from "../reference/languages.js";
import { isSourceId } from "../reference/sources.js";

/** The offline reference (module `reference`, CONTRACT "Offline reference"): sources, choices, downloads, search and reading. */
export function referenceRoutes() {
  const r = new Hono<{ Variables: { hub: Hub } }>();
  const svc = (c: { get(k: "hub"): Hub }) => referenceFor(c.get("hub"));

  /** A whole number in [min, max], or the default when the parameter is missing; anything else is 422. */
  const int = (v: string | undefined, name: string, dflt: number, min: number, max: number): number => {
    if (v === undefined || v === "") return dflt;
    if (!/^\d{1,6}$/.test(v)) throw new StoreError(422, `${name} must be a whole number`);
    const n = Number(v);
    if (n < min || n > max) throw new StoreError(422, `${name} must be from ${min} to ${max}`);
    return n;
  };
  const query = (v: string | undefined): string => {
    const q = (v ?? "").trim();
    if (q.length > 200) throw new StoreError(422, "q is at most 200 characters");
    return q;
  };
  /** A comma list of source ids or language codes; an unknown one is 422. */
  const list = (v: string | undefined, name: string, known: (x: string) => boolean): string[] => {
    const items = (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const unknown = items.filter((x) => !known(x));
    if (unknown.length) throw new StoreError(422, `${name}: unknown ${unknown.slice(0, 5).join(", ")}`);
    return [...new Set(items)];
  };
  /** A book's name and a page's path: plain text, no `.` or `..` part, no control characters. */
  const page = (c: { req: { query(k: string): string | undefined } }) => {
    const book = (c.req.query("book") ?? "").trim();
    const path = c.req.query("path") ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(book)) throw new StoreError(422, "book must be a book's name");
    // An empty part only at the end (a site's folder page, "www.example.org/").
    const parts = path.split("/");
    if (!path || path.length > 2000 || /[\u0000-\u001f\\]/.test(path) || parts.some((s, i) => s === "." || s === ".." || (s === "" && i < parts.length - 1))) throw new StoreError(422, "path must be a page's path in the book");
    return { book, path };
  };

  r.get("/reference/settings", (c) => c.json(svc(c).settingsView()));
  r.put("/reference/settings", async (c) => c.json(await svc(c).putSettings(await readJsonObject(c))));
  r.get("/reference/sources", async (c) => c.json(await svc(c).sourcesList()));
  r.get("/reference/status", (c) => c.json(svc(c).status()));
  r.post("/reference/pause", (c) => c.json(svc(c).pause()));
  r.post("/reference/resume", (c) => c.json(svc(c).resume()));
  r.post("/reference/check", async (c) => c.json(await svc(c).check()));
  r.delete("/reference/books/:name", (c) => c.json(svc(c).removeBook(c.req.param("name"))));

  r.get("/reference/suggest", async (c) => {
    const q = query(c.req.query("q"));
    return c.json(await svc(c).suggest(q, int(c.req.query("limit"), "limit", 8, 1, 50)));
  });
  r.get("/reference/search", async (c) => {
    const q = query(c.req.query("q"));
    const sources = list(c.req.query("sources"), "sources", isSourceId);
    const langs = list(c.req.query("langs"), "langs", knownLanguage);
    return c.json(await svc(c).search(q, { sources, langs, limit: int(c.req.query("limit"), "limit", 20, 1, 50), offset: int(c.req.query("offset"), "offset", 0, 0, 180) }));
  });
  r.get("/reference/article", async (c) => {
    const p = page(c);
    return c.json(await svc(c).article(p.book, p.path));
  });
  r.get("/reference/summary", async (c) => {
    const p = page(c);
    return c.json(await svc(c).summary(p.book, p.path));
  });
  r.get("/reference/media", async (c) => {
    const p = page(c);
    const m = await svc(c).media(p.book, p.path);
    // A picture is shown, never run: an SVG's scripts and links are switched off by its own policy.
    return c.body(new Uint8Array(m.body), 200, {
      "content-type": m.type,
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=604800",
    });
  });
  r.get("/reference/random", async (c) => {
    const sources = list(c.req.query("sources"), "sources", isSourceId);
    const langs = list(c.req.query("langs"), "langs", knownLanguage);
    return c.json(await svc(c).random({ sources, langs }));
  });
  return r;
}
