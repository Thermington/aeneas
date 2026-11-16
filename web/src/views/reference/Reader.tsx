import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { HubError } from "../../sync/api";
import { useHubReady } from "../../sync/hooks";
import { copyText } from "../../sync/memory";
import { plainError } from "../../lib/errors";
import { useEscape } from "../../lib/keys";
import { go } from "../../lib/router";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { isTauri, openExternal } from "../../tauri/bridge";
import {
  REFERENCE, TEXT_SIZES, archiveDate, askAboutText, bookTitle, citationText, findCountText, languageName, languageTag, linkKind,
  pageKey, readerPath, readerRoute, splitAnchor, stepTextSize,
  type RefArticle, type RefSummary, type RefTocEntry,
} from "../../lib/reference";
import * as api from "./api";
import { articleElement, captionOf, clearFinds, markFinds, sanitizeArticle, watchImages } from "./dom";
import { askAssistant, opening, readPositions, readTextSize, rememberPage, savePosition, searchMemo, useRefStatus, writeTextSize } from "./store";

/** The last pages opened, so Back shows one at once. */
const articles = new Map<string, RefArticle>();
function keepArticle(key: string, a: RefArticle): void {
  articles.delete(key);
  articles.set(key, a);
  if (articles.size > 12) articles.delete(articles.keys().next().value as string);
}

const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
const smooth = (): ScrollBehavior => (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

interface PreviewTarget { book: string; path: string; label: string; rect: DOMRect; touch: boolean; link: HTMLAnchorElement }
interface Zoomed { path: string; alt: string; caption: string }

/**
 * The reader: one page of a book, in the app's theme, at the device's text size, with its contents beside it on a wide
 * screen (a sheet on a phone), find in page, link previews, pictures loaded as they come into view, Ask about this page
 * and Copy citation. Where reading stopped is kept per page on this device.
 */
export function ReferenceReader({ book, path, anchor }: { book: string; path: string; anchor: string | null }) {
  const key = `${book}\n${path}`;
  const [art, setArt] = useState<RefArticle | null>(() => articles.get(key) ?? null);
  const [err, setErr] = useState<{ text: string; gone: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const ready = useHubReady();
  const { status } = useRefStatus(60_000);
  const books = status?.books ?? [];
  const sourceName = art ? bookTitle(books, art.book, art.source) : "";
  // While the page loads: the title of the link or result that opened it, else one made from its path.
  const pendingTitle = (opening.current && opening.current.book === book && opening.current.path === path ? opening.current.title : "")
    || decode(path.split("/").pop() ?? "").replace(/_/g, " ");

  const docRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const contentsBtn = useRef<HTMLButtonElement | null>(null);
  const findBtn = useRef<HTMLButtonElement | null>(null);
  const [rendered, setRendered] = useState(0);
  const [size, setSize] = useState(readTextSize);
  const wide = useMediaQuery("(min-width: 1100px)");
  const [sheet, setSheet] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Zoomed | null>(null);
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const [note, setNote] = useState("");
  const lastFraction = useRef(0);

  useEffect(() => {
    if (art || !ready) return;
    const ctl = new AbortController();
    setErr(null);
    api.article(book, path, ctl.signal).then(
      (a) => { keepArticle(key, a); setArt(a); },
      (e) => { if (!ctl.signal.aborted) setErr({ text: plainError(e), gone: e instanceof HubError && e.status === 404 }); },
    );
    return () => ctl.abort();
  }, [key, ready, attempt]);

  // The page goes in as nodes; then the reader starts at the section asked for, else where reading stopped, else the top.
  // Once more on the next frame: coming from another screen, the app scrolls the new screen to its top after this.
  useLayoutEffect(() => {
    const el = docRef.current;
    if (!el || !art) return;
    el.replaceChildren(sanitizeArticle(art.html ?? "", art.title));
    if (opening.current?.book === book && opening.current.path === path) opening.current = null;
    const f = readPositions()[pageKey(book, path)]?.f ?? 0;
    lastFraction.current = f;
    const start = () => {
      const target = anchor ? articleElement(el, anchor) : null;
      if (target) { target.scrollIntoView({ block: "start" }); return; }
      const max = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, f > 0.002 && max > 0 ? Math.round(f * max) : 0);
    };
    start();
    const again = requestAnimationFrame(start);
    titleRef.current?.focus({ preventScroll: true });
    setRendered((n) => n + 1);
    return () => cancelAnimationFrame(again);
  }, [art]);

  useEffect(() => {
    if (!art) return;
    rememberPage({ book, path, title: art.title, source: sourceName, lang: art.lang, at: new Date().toISOString() });
  }, [art, sourceName]);

  // Where reading stopped, as a fraction of the page, kept as the page scrolls and when it is left.
  useEffect(() => {
    if (!art) return;
    let timer = 0;
    const measure = () => {
      if (!docRef.current?.isConnected) return;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      lastFraction.current = max > 0 ? window.scrollY / max : 0;
    };
    const onScroll = () => {
      measure();
      if (!timer) timer = window.setTimeout(() => { timer = 0; savePosition(book, path, lastFraction.current); }, 500);
    };
    const onHide = () => savePosition(book, path, lastFraction.current);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", onHide);
      if (timer) clearTimeout(timer);
      savePosition(book, path, lastFraction.current);
    };
  }, [art]);

  // Pictures as they come into view.
  useEffect(() => {
    const el = docRef.current;
    if (!el || !art || !rendered) return;
    return watchImages(el, (p, signal) => api.media(art.book, p, signal));
  }, [rendered]);

  // The section in view, for the contents.
  const toc = art?.toc ?? [];
  useEffect(() => {
    const el = docRef.current;
    if (!el || !toc.length || !rendered) return;
    const heads = toc.map((t) => ({ id: t.id, el: articleElement(el, t.id) })).filter((h): h is { id: string; el: HTMLElement } => !!h.el);
    let raf = 0;
    const update = () => {
      raf = 0;
      let cur: string | null = null;
      for (const h of heads) if (h.el.getBoundingClientRect().top <= 120) cur = h.id;
      setCurrent(cur);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    window.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [rendered]);

  const goTo = useCallback((id: string) => {
    const t = articleElement(docRef.current, id);
    if (!t) return;
    t.scrollIntoView({ block: "start", behavior: smooth() });
    if (!t.hasAttribute("tabindex")) t.tabIndex = -1;
    t.focus({ preventScroll: true });
  }, []);

  // ---------- Find in page ----------
  const [finding, setFinding] = useState(false);
  const [fq, setFq] = useState("");
  const [found, setFound] = useState<HTMLElement[][]>([]);
  const [at, setAt] = useState(0);
  const findInput = useRef<HTMLInputElement | null>(null);
  const findingRef = useRef(false);
  findingRef.current = finding;
  const openFind = useCallback(() => {
    setFinding(true);
    requestAnimationFrame(() => { findInput.current?.focus(); findInput.current?.select(); });
  }, []);
  const closeFind = () => {
    setFinding(false);
    findBtn.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    const el = docRef.current;
    if (!el) return;
    if (!finding) { clearFinds(el); setFound((f) => (f.length ? [] : f)); return; }
    const t = setTimeout(() => { setFound(markFinds(el, fq)); setAt(0); }, fq.trim().length < 3 ? 250 : 120);
    return () => clearTimeout(t);
  }, [fq, finding, rendered]);
  useEffect(() => {
    found.forEach((m, i) => m.forEach((x) => x.classList.toggle("ref-find-current", i === at)));
    found[at]?.[0]?.scrollIntoView({ block: "center" });
  }, [found, at]);
  const step = useCallback((d: 1 | -1) => setAt((i) => (found.length ? (i + d + found.length) % found.length : 0)), [found.length]);
  const stepRef = useRef(step);
  stepRef.current = step;

  // Ctrl or Cmd+F opens this find bar in place of the browser's; Ctrl or Cmd+G and F3 go through the matches.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        openFind();
      } else if (findingRef.current && ((mod && e.key.toLowerCase() === "g") || e.key === "F3")) {
        e.preventDefault();
        stepRef.current(e.shiftKey ? -1 : 1);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openFind]);

  const onFindKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeFind();
    }
  };

  // Escape closes what is open over the page, the top one first.
  useEscape(useCallback(() => {
    if (zoom) setZoom(null);
    else if (sheet) {
      setSheet(false);
      contentsBtn.current?.focus({ preventScroll: true });
    } else if (preview) setPreview(null);
    else if (finding) setFinding(false);
  }, [zoom, sheet, preview, finding]));

  // ---------- Link previews: 350 ms of hover with a mouse, a long press on a touch screen ----------
  const hoverTimer = useRef(0);
  const hideTimer = useRef(0);
  const pressTimer = useRef(0);
  const pressAt = useRef<{ x: number; y: number } | null>(null);
  const suppressUntil = useRef(0);
  const previewRef = useRef(preview);
  previewRef.current = preview;

  const pageLink = (t: EventTarget | null): HTMLAnchorElement | null => {
    const a = (t as Element | null)?.closest?.("a[data-book][data-path]") as HTMLAnchorElement | null;
    return a && docRef.current?.contains(a) ? a : null;
  };
  const show = (a: HTMLAnchorElement, touch: boolean) => {
    const dest = splitAnchor(a.getAttribute("data-path") ?? "");
    setPreview({ book: a.getAttribute("data-book") ?? "", path: dest.path, label: (a.textContent ?? "").replace(/\s+/g, " ").trim(), rect: a.getBoundingClientRect(), touch, link: a });
  };
  const hideSoon = () => {
    clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setPreview(null), 250);
  };
  const keepShown = () => clearTimeout(hideTimer.current);
  const cancelPress = () => {
    clearTimeout(pressTimer.current);
    pressAt.current = null;
  };
  useEffect(() => () => { clearTimeout(hoverTimer.current); clearTimeout(hideTimer.current); clearTimeout(pressTimer.current); }, []);
  // A preview stays in place only while the page does.
  useEffect(() => {
    if (!preview) return;
    const close = () => setPreview(null);
    const outside = (e: globalThis.PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.(".ref-preview")) setPreview(null);
    };
    window.addEventListener("scroll", close, { passive: true });
    window.addEventListener("resize", close);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("scroll", close);
      window.removeEventListener("resize", close);
      document.removeEventListener("pointerdown", outside);
    };
  }, [preview]);

  const onPointerOver = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse") return;
    const a = pageLink(e.target);
    if (!a) return;
    keepShown();
    if (previewRef.current?.link === a) return;
    clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => show(a, false), 350);
  };
  const onPointerOut = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse") return;
    const a = pageLink(e.target);
    if (!a || a.contains(e.relatedTarget as Node | null)) return;
    clearTimeout(hoverTimer.current);
    if (previewRef.current) hideSoon();
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse") return;
    const a = pageLink(e.target);
    if (!a) return;
    cancelPress();
    pressAt.current = { x: e.clientX, y: e.clientY };
    pressTimer.current = window.setTimeout(() => {
      pressAt.current = null;
      suppressUntil.current = Date.now() + 800;
      show(a, true);
    }, 500);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = pressAt.current;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) cancelPress();
  };

  // ---------- Links and pictures in the page ----------
  const openPage = (dest: { book: string; path: string; anchor: string | null }, title: string) => {
    if (dest.book === book && dest.path === path) {
      if (dest.anchor) goTo(dest.anchor);
      return;
    }
    savePosition(book, path, lastFraction.current);
    setPreview(null);
    opening.current = { book: dest.book, path: dest.path, title };
    go(readerPath(dest.book, dest.path, dest.anchor));
  };

  const onDocClick = (e: MouseEvent<HTMLDivElement>) => {
    const t = e.target as Element;
    if (Date.now() < suppressUntil.current) {
      e.preventDefault();
      return;
    }
    const img = t.closest?.("img[data-media]") as HTMLImageElement | null;
    if (img && docRef.current?.contains(img)) {
      e.preventDefault();
      setZoom({ path: img.getAttribute("data-media") ?? "", alt: img.alt, caption: captionOf(img) });
      return;
    }
    const a = t.closest?.("a") as HTMLAnchorElement | null;
    if (!a || !docRef.current?.contains(a)) return;
    const href = a.getAttribute("href");
    const kind = linkKind(href, { book: a.getAttribute("data-book"), path: a.getAttribute("data-path"), external: a.hasAttribute("data-external") });
    // In a browser, Ctrl, Cmd or Shift with a click opens a page of the book in a new tab, as any link does.
    if (kind === "reader" && !isTauri && (e.metaKey || e.ctrlKey || e.shiftKey)) return;
    e.preventDefault();
    if (kind === "reader") {
      const b = a.getAttribute("data-book");
      const p = a.getAttribute("data-path");
      const [hp, hq] = (href ?? "").replace(/^#/, "").split("?");
      const dest = b && p ? { book: b, ...splitAnchor(p) } : readerRoute(hp, new URLSearchParams(hq ?? ""));
      if (dest) openPage(dest, (a.textContent ?? "").trim());
    } else if (kind === "external" && href) {
      void openExternal(href).catch(() => undefined);
    } else if (kind === "anchor" && href) {
      goTo(decode(href.slice(1)));
    }
  };

  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    // A long press on a link shows its preview, not the system's link menu.
    if (pageLink(e.target) && (pressAt.current || Date.now() < suppressUntil.current)) e.preventDefault();
  };

  // ---------- Tools ----------
  const resize = (d: 1 | -1) => {
    const next = stepTextSize(size, d);
    setSize(next);
    writeTextSize(next);
  };
  const say = (text: string) => {
    setNote(text);
    window.setTimeout(() => setNote((n) => (n === text ? "" : n)), 2500);
  };
  const copy = async () => {
    if (!art) return;
    say((await copyText(citationText(art, sourceName))) ? "Citation copied." : "Could not copy. Select the text instead.");
  };
  const ask = () => {
    if (!art) return;
    savePosition(book, path, lastFraction.current);
    void askAssistant(askAboutText(art, sourceName)).catch((e) => say(plainError(e)));
  };
  const searchFor = (q: string) => {
    searchMemo.current = { q, sources: [], langs: [], hits: [], total: 0, partial: false, stage: null, scrollY: 0 };
    go(REFERENCE);
  };

  const showSide = wide && toc.length > 0;
  const docStyle = useMemo(() => ({ "--ref-size": `${size}px` }) as CSSProperties, [size]);

  if (err) {
    const guess = decode(path.split("/").pop() ?? "").replace(/_/g, " ").trim();
    return (
      <div className="ref-reader col">
        <a className="ref-back" href={`#${REFERENCE}`}>{"‹"} Reference</a>
        <div className="card col">
          {err.gone ? <div>This page is not in this archive. It may have a different name here.</div> : <div className="error">Could not open the page: {err.text}</div>}
          <div className="row">
            {err.gone && guess && <button type="button" className="primary" onClick={() => searchFor(guess)}>Search for "{guess}"</button>}
            {!err.gone && <button type="button" onClick={() => { setErr(null); setAttempt((n) => n + 1); }}>Try again</button>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <article className={`ref-reader${showSide ? " with-toc" : ""}`} aria-busy={!art}>
      <a className="ref-back" href={`#${REFERENCE}`}>{"‹"} Reference</a>
      <header className="ref-head">
        <h1 ref={titleRef} tabIndex={-1} className="ref-title">{art?.title || pendingTitle}</h1>
        {art ? (
          <>
            <div className="ref-meta">
              <span className="ref-badge">{sourceName}</span>
              {art.lang && <span>{languageName(art.lang)}</span>}
              {art.date && <span>Offline copy of {archiveDate(art.date, "long")}</span>}
              {art.url && (
                <a
                  className="ref-ext"
                  href={art.url}
                  rel="noopener noreferrer"
                  title="Opens in your browser. Needs the internet."
                  onClick={(e) => { e.preventDefault(); void openExternal(art.url!).catch(() => undefined); }}
                >
                  Original page<span className="sr-only"> (needs the internet)</span>
                </a>
              )}
            </div>
            <div className="ref-tools" role="group" aria-label="Page tools">
              {!showSide && toc.length > 0 && (
                <button ref={contentsBtn} type="button" className="small" aria-haspopup="dialog" onClick={() => setSheet(true)}>Contents</button>
              )}
              <button ref={findBtn} type="button" className="small" aria-keyshortcuts="Control+F Meta+F" onClick={openFind}>Find</button>
              <span className="ref-size" role="group" aria-label={`Text size, ${size} pixels`}>
                <button type="button" className="small" aria-label="Smaller text" disabled={size <= TEXT_SIZES[0]} onClick={() => resize(-1)}>
                  <span aria-hidden="true" className="ref-a-small">A</span>
                </button>
                <button type="button" className="small" aria-label="Larger text" disabled={size >= TEXT_SIZES[TEXT_SIZES.length - 1]} onClick={() => resize(1)}>
                  <span aria-hidden="true" className="ref-a-large">A</span>
                </button>
              </span>
              <button type="button" className="small" onClick={ask}>Ask about this page</button>
              <button type="button" className="small" onClick={() => void copy()}>Copy citation</button>
            </div>
            <div className="sr-only" role="status">{note}</div>
            {note && <div className="small muted ref-note" aria-hidden="true">{note}</div>}
          </>
        ) : (
          <div className="muted small"><span className="spinner" aria-hidden="true" /> Opening</div>
        )}
      </header>

      {finding && (
        <div className="ref-find" role="search" aria-label="Find in page">
          <input
            ref={findInput}
            type="search"
            value={fq}
            onChange={(e) => setFq(e.target.value)}
            onKeyDown={onFindKey}
            placeholder="Find in page"
            aria-label="Find in page"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
          />
          <span className="muted small ref-find-count" aria-live="polite">{fq.trim() ? findCountText(at, found.length) : ""}</span>
          <button type="button" className="small" aria-label="Previous match" disabled={!found.length} onClick={() => step(-1)}>{"‹"}</button>
          <button type="button" className="small" aria-label="Next match" disabled={!found.length} onClick={() => step(1)}>{"›"}</button>
          <button type="button" className="small" onClick={closeFind}>Done</button>
        </div>
      )}

      <div className="ref-body">
        <div
          ref={docRef}
          className="ref-doc"
          lang={art ? languageTag(art.lang) : undefined}
          style={docStyle}
          onClick={onDocClick}
          onPointerOver={onPointerOver}
          onPointerOut={onPointerOut}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={cancelPress}
          onPointerCancel={cancelPress}
          onContextMenu={onContextMenu}
        />
        {showSide && (
          <aside className="ref-side">
            <Contents toc={toc} current={current} onGo={goTo} />
          </aside>
        )}
      </div>

      {art && (
        <footer className="muted small ref-foot">
          From {sourceName}, offline copy of {archiveDate(art.date, "long")}.{art.license ? ` License: ${art.license}.` : ""}
        </footer>
      )}

      {sheet && (
        <ContentsSheet
          toc={toc}
          current={current}
          onGo={(id) => { setSheet(false); goTo(id); }}
          onClose={() => { setSheet(false); contentsBtn.current?.focus({ preventScroll: true }); }}
        />
      )}
      {preview && (
        <LinkPreview
          target={preview}
          onOpen={() => openPage({ book: preview.book, path: preview.path, anchor: null }, preview.label)}
          onClose={() => setPreview(null)}
          onEnter={keepShown}
          onLeave={() => { if (!preview.touch) hideSoon(); }}
        />
      )}
      {zoom && art && <Picture book={art.book} item={zoom} onClose={() => setZoom(null)} />}
    </article>
  );
}

/** The page's sections, the one in view marked. */
function Contents({ toc, current, onGo }: { toc: RefTocEntry[]; current: string | null; onGo: (id: string) => void }) {
  return (
    <nav className="ref-toc" aria-label="Contents">
      <ol className="plain">
        <li>
          <button type="button" className={`ref-toc-link${current === null ? " on" : ""}`} aria-current={current === null ? "location" : undefined} onClick={() => window.scrollTo({ top: 0, behavior: smooth() })}>
            Top
          </button>
        </li>
        {toc.map((t) => (
          <li key={t.id} className={t.level > 2 ? "sub" : undefined}>
            <button type="button" className={`ref-toc-link${current === t.id ? " on" : ""}`} aria-current={current === t.id ? "location" : undefined} onClick={() => onGo(t.id)}>
              {t.text}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** The contents on a phone: a sheet from the bottom, its section in view first in reach. */
function ContentsSheet({ toc, current, onGo, onClose }: { toc: RefTocEntry[]; current: string | null; onGo: (id: string) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const on = box.current?.querySelector<HTMLButtonElement>(".ref-toc-link.on") ?? box.current?.querySelector<HTMLButtonElement>(".ref-toc-link");
    on?.scrollIntoView({ block: "center" });
    on?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="ref-sheet-back" onClick={onClose}>
      <div ref={box} className="ref-sheet" role="dialog" aria-modal="true" aria-label="Contents" onClick={(e) => e.stopPropagation()}>
        <div className="row between ref-sheet-head">
          <h2 className="ref-h">Contents</h2>
          <button type="button" className="small" onClick={onClose}>Close</button>
        </div>
        <Contents toc={toc} current={current} onGo={onGo} />
      </div>
    </div>
  );
}

function cardPlace(rect: DOMRect): CSSProperties {
  const width = Math.min(360, window.innerWidth - 16);
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const below = rect.bottom + 8;
  return window.innerHeight - below > 240 ? { left, top: below, width } : { left, bottom: window.innerHeight - rect.top + 8, width };
}

/** A linked page's first paragraph and picture, from its summary. */
function LinkPreview({ target, onOpen, onClose, onEnter, onLeave }: { target: PreviewTarget; onOpen: () => void; onClose: () => void; onEnter: () => void; onLeave: () => void }) {
  const [sum, setSum] = useState<RefSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [img, setImg] = useState("");
  useEffect(() => {
    let live = true;
    setSum(null);
    setFailed(false);
    api.summary(target.book, target.path).then((s) => { if (live) setSum(s); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [target.book, target.path]);
  useEffect(() => {
    const m = sum?.media;
    if (!m) return;
    const ctl = new AbortController();
    let made = "";
    api.media(target.book, m, ctl.signal).then((u) => {
      if (ctl.signal.aborted) { URL.revokeObjectURL(u); return; }
      made = u;
      setImg(u);
    }, () => undefined);
    return () => {
      ctl.abort();
      if (made) URL.revokeObjectURL(made);
      setImg("");
    };
  }, [target.book, sum?.media]);
  const title = sum?.title || target.label;
  return (
    <div className="ref-preview card" role="dialog" aria-label={`Preview of ${title}`} style={cardPlace(target.rect)} onPointerEnter={onEnter} onPointerLeave={onLeave}>
      {img && <img src={img} alt="" className="ref-preview-img" />}
      <div className="ref-preview-t">{title}</div>
      <div className="small ref-preview-text">{failed ? "No preview for this page." : sum ? sum.text || "This page starts without a summary." : "Loading"}</div>
      <div className="row">
        <button type="button" className="small primary" onClick={onOpen}>Open</button>
        {target.touch && <button type="button" className="small" onClick={onClose}>Close</button>}
      </div>
    </div>
  );
}

/** A picture of the page, large, over everything. */
function Picture({ book, item, onClose }: { book: string; item: Zoomed; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const closeBtn = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    let made = "";
    api.media(book, item.path, ctl.signal).then((u) => {
      if (ctl.signal.aborted) { URL.revokeObjectURL(u); return; }
      made = u;
      setUrl(u);
    }, () => { if (!ctl.signal.aborted) setFailed(true); });
    return () => {
      ctl.abort();
      if (made) URL.revokeObjectURL(made);
    };
  }, [book, item.path]);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    return () => before?.focus?.({ preventScroll: true });
  }, []);
  const label = item.caption || item.alt || "Picture";
  return (
    <div className="lightbox ref-lightbox" role="dialog" aria-modal="true" aria-label={label}>
      <div className="lightbox-stage ref-lightbox-stage" onClick={onClose}>
        {url ? <img src={url} alt={item.alt} /> : <span className="ref-lightbox-cap">{failed ? "The picture could not be loaded." : "Loading"}</span>}
      </div>
      <div className="lightbox-bar">
        {item.caption && <span className="small ref-lightbox-cap">{item.caption}</span>}
        <span className="spacer" />
        <button ref={closeBtn} type="button" className="small" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
