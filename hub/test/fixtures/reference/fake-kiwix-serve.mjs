// A stand-in for kiwix-serve 3.8.1 in tests: started with the same arguments, it answers the endpoints the hub uses
// (catalog, suggest, search, raw content and metadata, random) from fake-books.json, for the archives it is given.
// A file whose name has "slow" in it answers searches after 3 s; one with "broken" is skipped as invalid.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const files = args.filter((a) => !a.startsWith("--"));
if (process.env.FAKE_KIWIX_LOG) fs.appendFileSync(process.env.FAKE_KIWIX_LOG, `${JSON.stringify(args)}\n`);
const books = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-books.json"), "utf8"));

/** The archives served, by the name the reader gives them (the file's name without .zim). */
const served = new Map();
for (const f of files) {
  const url = path.basename(f).replace(/\.zim$/, "");
  if (url.includes("broken") || !fs.existsSync(f)) continue;
  const name = url.replace(/(?:_(?:maxi|nopic|mini))?_\d{4}-\d\d$/, "").replace(/_slow$/, "");
  if (books[name]) served.set(url, { name, slow: url.includes("slow"), ...books[name] });
}

const plain = (html) => html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const fold = (s) => s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");

function titles(book) {
  const out = [];
  for (const [p, page] of Object.entries(book.pages)) if (page.title) out.push({ title: page.title, path: p });
  for (const [from] of Object.entries(book.redirects ?? {})) out.push({ title: from.replace(/_/g, " "), path: from });
  return out;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (status, body, type = "text/html", headers = {}) => { res.writeHead(status, { "content-type": type, ...headers }); res.end(body); };
  if (u.pathname === "/catalog/v2/entries") return send(200, "<feed xmlns=\"http://www.w3.org/2005/Atom\"></feed>", "application/atom+xml");
  if (u.pathname === "/__exit") { send(200, "bye"); setTimeout(() => process.exit(3), 20); return; }
  if (u.pathname === "/suggest") {
    const book = served.get(u.searchParams.get("content") ?? "");
    if (!book) return send(404, "<html>Content not found</html>");
    const term = fold(u.searchParams.get("term") ?? "");
    const count = Number(u.searchParams.get("count") ?? 10);
    const hits = titles(book).filter((t) => fold(t.title).includes(term)).slice(0, count);
    const rows = hits.map((h) => ({ value: h.title, label: esc(h.title), kind: "path", path: h.path }));
    rows.push({ value: `${term} `, label: `containing '${esc(term)}'...`, kind: "pattern" });
    return send(200, JSON.stringify(rows), "application/json; charset=utf-8");
  }
  if (u.pathname === "/search") {
    const url = u.searchParams.get("books.name") ?? "";
    const book = served.get(url);
    if (!book) return send(400, "<html>No such book</html>");
    if (book.slow) await new Promise((r) => setTimeout(r, 3000));
    const words = fold(u.searchParams.get("pattern") ?? "").split(/\s+/).filter(Boolean);
    const order = book.searchOrder ?? Object.keys(book.pages);
    const found = order.filter((p) => book.pages[p]?.html && words.every((w) => fold(plain(book.pages[p].html)).includes(w)));
    const start = Number(u.searchParams.get("start") ?? 0);
    const len = Number(u.searchParams.get("pageLength") ?? 25);
    const items = found.slice(start, start + len).map((p) => {
      const text = plain(book.pages[p].html);
      let snip = esc(text.slice(0, 220));
      for (const w of words) snip = snip.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<b>$1</b>");
      const n = text.split(" ").length * 10;
      return `<item><title>${esc(book.pages[p].title)}</title><link>/content/${url}/${enc(p)}</link><description>${snip}...</description><book><title>${esc(book.title ?? book.name)}</title></book><wordCount>${n.toLocaleString("en-US")}</wordCount></item>`;
    }).join("");
    return send(200, `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><channel><title>Search</title><opensearch:totalResults>${found.length}</opensearch:totalResults>${items}</channel></rss>`, "application/rss+xml");
  }
  if (u.pathname === "/random") {
    const url = u.searchParams.get("content") ?? "";
    const book = served.get(url);
    if (!book) return send(404, "");
    const pick = (book.random ?? Object.keys(book.pages))[Math.floor(Math.random() * (book.random ?? Object.keys(book.pages)).length)];
    return send(302, "", "text/plain", { location: `/content/${url}/${enc(pick)}` });
  }
  const raw = /^\/raw\/([^/]+)\/(content|meta)\/(.*)$/.exec(u.pathname);
  if (raw) {
    const url = decodeURIComponent(raw[1]);
    const book = served.get(url);
    if (!book) return send(404, "<html>Content not found</html>");
    const rest = raw[3].split("/").map(decodeURIComponent).join("/");
    if (raw[2] === "meta") return rest === "Name" ? send(200, book.name, "text/plain") : send(404, "");
    const target = book.redirects?.[rest];
    if (target) return send(302, "", "text/plain", { location: `/content/${url}/${enc(target)}` });
    const page = book.pages[rest];
    if (!page) return send(404, "<html>Content not found</html>");
    if (page.base64) return send(200, Buffer.from(page.base64, "base64"), page.type);
    return send(200, page.html ?? page.text ?? "", page.type ?? "text/html");
  }
  send(404, "<html>Content not found</html>");
});

server.listen(Number(opt("port")), opt("address") ?? "127.0.0.1");
// --attachToProcess: end with the process that started it.
const parent = Number(opt("attachToProcess"));
if (parent) setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(0); } }, 300).unref();
