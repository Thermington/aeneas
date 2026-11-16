import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { plainError } from "../../lib/errors";
import { isTypingTarget } from "../../lib/keys";
import { showKeyboardHints } from "../../lib/keyboardHints";
import { go } from "../../lib/router";
import { relativePast } from "../../lib/time";
import {
  appendHits, archiveDate, bestHit, countText, downloadStateText, filterHits, hitKey, languageName, mayAppend, mayShow,
  pageKey, percentDone, progressText, readerPath, readyBooks, searchChips, searchPlaceholder, snippetParts, sourceTitle,
  type RecentPage, type RefBook, type RefHit, type RefStatus, type Shown, type Stage,
} from "../../lib/reference";
import * as api from "./api";
import { clearRecent, opening, readPositions, readRecent, searchMemo, useRefStatus } from "./store";

interface Results {
  gen: number; stage: Stage | null; hits: RefHit[]; total: number; partial: boolean; error: string;
  /** Loading more: "" idle, "busy", or why the last page did not come. */
  more: string;
}
const NONE: Results = { gen: 0, stage: null, hits: [], total: 0, partial: false, error: "", more: "" };

const sameList = (a: string[], b: string[]) => a.join(",") === b.join(",");

/**
 * Search as you type: titles (suggest) 120 ms after the last key, then the full results (search) at 250 ms. Each query
 * and each change of the chips is a newer generation; an answer shows only while its generation is the newest, so an
 * older query's answer never covers a newer one's (mayShow), and a query typed over aborts the requests still out.
 */
function useResults(query: string, narrow: api.Narrow, onOpen: (h: RefHit) => void) {
  const restore = useRef(searchMemo.current);
  const gate = useRef(0);
  const shown = useRef<Shown>({ gen: 0, stage: null });
  const [want, setWant] = useState(0);
  const [res, setRes] = useState<Results>(() => {
    const m = restore.current;
    return m && m.q.trim() ? { ...NONE, stage: m.stage, hits: m.hits, total: m.total, partial: m.partial } : NONE;
  });
  const live = useRef(res);
  live.current = res;
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const runNow = useRef<(() => void) | null>(null);
  const pendingOpen = useRef(0);
  const moreCtl = useRef<AbortController | null>(null);
  const q = query.trim();
  const key = `${q}\n${narrow.sources.join(",")}\n${narrow.langs.join(",")}`;

  useEffect(() => {
    const gen = ++gate.current;
    setWant(gen);
    pendingOpen.current = 0;
    moreCtl.current?.abort();
    const m = restore.current;
    restore.current = null;
    if (!q) {
      shown.current = { gen, stage: null };
      runNow.current = null;
      setRes({ ...NONE, gen });
      return;
    }
    if (m && m.stage === "search" && m.q.trim() === q && sameList(m.sources, narrow.sources) && sameList(m.langs, narrow.langs)) {
      // Back from a page: the results as they were, without asking again.
      shown.current = { gen, stage: "search" };
      runNow.current = null;
      setRes((r) => ({ ...r, gen }));
      return;
    }
    const ctlTitles = new AbortController();
    const ctlFull = new AbortController();
    const sent = { suggest: false, search: false };
    const accept = (stage: Stage, hits: RefHit[], total: number, partial: boolean) => {
      if (!mayShow(gate.current, shown.current, { gen, stage })) return;
      shown.current = { gen, stage };
      setRes({ gen, stage, hits, total, partial, error: "", more: "" });
      if (stage === "search" && pendingOpen.current === gen) {
        pendingOpen.current = 0;
        const i = bestHit(hits, q);
        if (i >= 0) openRef.current(hits[i]);
      }
    };
    const runSuggest = () => {
      if (sent.suggest) return;
      sent.suggest = true;
      api.suggest(q, ctlTitles.signal).then((a) => {
        const hits = filterHits(a.results ?? [], narrow.sources, narrow.langs);
        accept("suggest", hits, hits.length, false);
      }, () => undefined);
    };
    const runSearch = () => {
      if (sent.search) return;
      sent.search = true;
      api.search(q, narrow, 0, ctlFull.signal).then(
        (a) => accept("search", a.results ?? [], a.total ?? 0, !!a.partial),
        (e) => {
          if (ctlFull.signal.aborted || gate.current !== gen) return;
          pendingOpen.current = 0;
          shown.current = { gen, stage: "search" };
          setRes((r) => ({ ...r, gen, stage: "search", hits: r.gen === gen ? r.hits : [], total: 0, error: plainError(e), more: "" }));
        },
      );
    };
    const titles = setTimeout(runSuggest, 120);
    const full = setTimeout(runSearch, 250);
    runNow.current = () => {
      clearTimeout(titles);
      clearTimeout(full);
      runSuggest();
      runSearch();
    };
    return () => {
      clearTimeout(titles);
      clearTimeout(full);
      ctlTitles.abort();
      ctlFull.abort();
    };
  }, [key]);

  useEffect(() => () => moreCtl.current?.abort(), []);

  /** The next page of full results, from where the list ends. */
  const loadMore = useCallback(() => {
    const r = live.current;
    const gen = gate.current;
    if (!q || r.gen !== gen || r.stage !== "search" || r.more === "busy" || r.error || r.hits.length >= r.total) return;
    const offset = r.hits.length;
    const ctl = new AbortController();
    moreCtl.current?.abort();
    moreCtl.current = ctl;
    setRes((cur) => ({ ...cur, more: "busy" }));
    api.search(q, narrow, offset, ctl.signal).then(
      (a) => {
        if (!mayAppend(gate.current, shown.current, live.current.hits.length, { gen, offset })) return;
        const more = a.results ?? [];
        setRes((cur) => ({ ...cur, hits: appendHits(cur.hits, more), total: more.length ? a.total : cur.hits.length, partial: cur.partial || !!a.partial, more: "" }));
      },
      (e) => {
        if (!ctl.signal.aborted && gate.current === gen) setRes((cur) => ({ ...cur, more: plainError(e) }));
      },
    );
  }, [q, narrow]);

  /** Enter with nothing picked: the title that is the query, else the first result, as soon as the full results are in. */
  const openTop = () => {
    const r = live.current;
    if (r.gen === gate.current && r.stage === "search") {
      const i = bestHit(r.hits, q);
      if (i >= 0) openRef.current(r.hits[i]);
      return;
    }
    pendingOpen.current = gate.current;
    runNow.current?.();
  };

  const current = res.gen === want;
  return { res, stale: !current, busy: !!q && (!current || res.stage !== "search"), loadMore, openTop };
}

function Snippet({ html }: { html: string }) {
  const parts = useMemo(() => snippetParts(html), [html]);
  return <>{parts.map((p, i) => (p.bold ? <b key={i}>{p.text}</b> : <Fragment key={i}>{p.text}</Fragment>))}</>;
}

/** The Reference screen before a page is opened: one search field over every source on the hub. */
export function ReferenceSearch() {
  const memo = useRef(searchMemo.current).current;
  const [q, setQ] = useState(memo?.q ?? "");
  const [sources, setSources] = useState<string[]>(memo?.sources ?? []);
  const [langs, setLangs] = useState<string[]>(memo?.langs ?? []);
  const { status, error } = useRefStatus();
  const books = useMemo(() => readyBooks(status), [status]);
  const chips = useMemo(() => searchChips(books), [books]);
  // Chips for books no longer on the hub stop narrowing once the hub has said what it has.
  const narrowSources = status ? sources.filter((s) => chips.sources.some((c) => c.id === s)) : sources;
  const narrowLangs = status ? langs.filter((l) => chips.langs.some((c) => c.code === l)) : langs;
  const narrow = useMemo<api.Narrow>(() => ({ sources: narrowSources, langs: narrowLangs }), [narrowSources.join(","), narrowLangs.join(",")]);
  const input = useRef<HTMLInputElement | null>(null);
  const scrollY = useRef(memo?.scrollY ?? 0);
  const leaving = useRef(false);
  const byName = useMemo(() => new Map(books.map((b) => [b.name, b])), [books]);

  /** Keeps the search for Back, with the scroll position from before the page opened. */
  const leave = () => {
    if (!leaving.current) scrollY.current = window.scrollY;
    leaving.current = true;
  };
  const open = (h: RefHit) => {
    leave();
    opening.current = { book: h.book, path: h.path, title: h.title };
    go(readerPath(h.book, h.path));
  };
  const { res, stale, busy, loadMore, openTop } = useResults(q, narrow, open);

  const latest = useRef({ q, sources, langs, res });
  latest.current = { q, sources, langs, res };
  useEffect(() => {
    const onScroll = () => { if (!leaving.current) scrollY.current = window.scrollY; };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      const l = latest.current;
      searchMemo.current = { q: l.q, sources: l.sources, langs: l.langs, hits: l.res.hits, total: l.res.total, partial: l.res.partial, stage: l.res.stage, scrollY: scrollY.current };
    };
  }, []);

  // On a computer the field takes the keyboard at once; Back from a page lands where the list was.
  useLayoutEffect(() => {
    if (showKeyboardHints()) input.current?.focus({ preventScroll: true });
    if (memo?.scrollY) window.scrollTo(0, memo.scrollY);
  }, []);

  // `/` anywhere on the screen goes to the field (before the app's own `/`, which goes to Search everything).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || isTypingTarget(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      input.current?.focus();
      input.current?.select();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // The picked result, kept by what it is when the list changes under it (titles replaced by full results).
  const [active, setActive] = useState(-1);
  const activeKey = useRef<string | null>(null);
  useEffect(() => {
    activeKey.current = null;
    setActive(-1);
  }, [q]);
  useEffect(() => {
    if (!activeKey.current) return;
    const i = res.hits.findIndex((h) => hitKey(h) === activeKey.current);
    if (i < 0) activeKey.current = null;
    setActive(i);
  }, [res.hits]);
  const pick = (i: number, scroll: boolean) => {
    setActive(i);
    activeKey.current = i >= 0 && res.hits[i] ? hitKey(res.hits[i]) : null;
    if (scroll && i >= 0) document.getElementById(`ref-opt-${i}`)?.scrollIntoView({ block: "nearest" });
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = res.hits.length;
    if (e.key === "ArrowDown") {
      if (!n) return;
      e.preventDefault();
      pick(Math.min(n - 1, active + 1), true);
      if (active + 1 >= n - 3) loadMore();
    } else if (e.key === "ArrowUp") {
      if (!n) return;
      e.preventDefault();
      pick(Math.max(-1, active - 1), true);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active >= 0 && res.hits[active]) open(res.hits[active]);
      else if (q.trim()) openTop();
    } else if (e.key === "Escape" && q) {
      e.preventDefault();
      e.stopPropagation();
      setQ("");
    }
  };

  // More results as the end of the list comes near.
  const sentinel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) loadMore(); }, { rootMargin: "400px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, res.hits.length, res.total]);

  const typed = q.trim();
  const hasHits = !!typed && res.hits.length > 0;
  const titles = chips.sources.map((s) => s.label);
  const keys = showKeyboardHints();
  const toggle = (list: string[], x: string) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);
  const final = !!typed && !busy;

  return (
    <div className="ref col">
      <h1>Reference</h1>
      <div className="ref-searchbar" role="search">
        <input
          ref={input}
          type="search"
          className="ref-q"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          placeholder={searchPlaceholder(titles)}
          aria-label="Search the reference"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={hasHits}
          aria-controls={hasHits ? "ref-results" : undefined}
          aria-activedescendant={hasHits && active >= 0 ? `ref-opt-${active}` : undefined}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="search"
        />
        {busy && <span className="spinner ref-q-spin" aria-hidden="true" />}
      </div>
      {keys && <div className="muted small ref-keys"><kbd>/</kbd> search, <kbd>↑</kbd> <kbd>↓</kbd> move, <kbd>Enter</kbd> opens, <kbd>Esc</kbd> clears</div>}

      {(chips.sources.length > 1 || chips.langs.length > 1) && (
        <div className="ref-chips">
          {chips.sources.length > 1 && (
            <div className="chips" role="group" aria-label="Sources to search">
              <button type="button" className={`chip${!narrow.sources.length ? " on" : ""}`} aria-pressed={!narrow.sources.length} onClick={() => setSources([])}>All sources</button>
              {chips.sources.map((s) => (
                <button key={s.id} type="button" className={`chip${narrow.sources.includes(s.id) ? " on" : ""}`} aria-pressed={narrow.sources.includes(s.id)} onClick={() => setSources(toggle(narrowSources, s.id))}>
                  {s.label}
                </button>
              ))}
            </div>
          )}
          {chips.langs.length > 1 && (
            <div className="chips" role="group" aria-label="Languages to search">
              <button type="button" className={`chip${!narrow.langs.length ? " on" : ""}`} aria-pressed={!narrow.langs.length} onClick={() => setLangs([])}>All languages</button>
              {chips.langs.map((l) => (
                <button key={l.code} type="button" className={`chip${narrow.langs.includes(l.code) ? " on" : ""}`} aria-pressed={narrow.langs.includes(l.code)} onClick={() => setLangs(toggle(narrowLangs, l.code))}>
                  {l.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {typed ? (
        <section className="ref-found" aria-label="Results">
          <div className="muted small ref-found-head">
            {res.error && !stale ? (
              <span className="error">{res.error}</span>
            ) : final && !res.hits.length ? (
              <span>Nothing found for "{typed}". Check the spelling, or try fewer words.</span>
            ) : final ? (
              <span>{countText(res.total, "result", "results")}{res.partial ? ". Some sources took too long and were left out" : ""}</span>
            ) : res.hits.length && !stale ? (
              <span>Titles first. Full results in a moment.</span>
            ) : (
              <span>Searching</span>
            )}
            {final && !res.hits.length && (narrow.sources.length > 0 || narrow.langs.length > 0) && (
              <button type="button" className="small ref-inline" onClick={() => { setSources([]); setLangs([]); }}>Search everything</button>
            )}
          </div>
          <div className="sr-only" role="status">{final ? (res.error || (res.hits.length ? countText(res.total, "result", "results") : "Nothing found")) : ""}</div>
          {res.hits.length > 0 && (
            <ul id="ref-results" role="listbox" aria-label={`Results for ${typed}`} className={`ref-results${stale ? " stale" : ""}`}>
              {res.hits.map((h, i) => {
                const book = byName.get(h.book);
                return (
                  <li
                    key={hitKey(h)}
                    id={`ref-opt-${i}`}
                    role="option"
                    aria-selected={i === active}
                    className={`ref-hit${i === active ? " active" : ""}`}
                    onClick={() => open(h)}
                    onMouseMove={() => { if (active !== i) pick(i, false); }}
                  >
                    <span className="ref-hit-title">{h.title}</span>
                    {h.snippet ? <span className="ref-hit-snippet"><Snippet html={h.snippet} /></span> : null}
                    <span className="ref-hit-meta">
                      <span className="ref-badge">{book?.title || sourceTitle(books, h.source)}</span>
                      {h.lang && <span>{languageName(h.lang)}</span>}
                      {book?.date && <span>{archiveDate(book.date)}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <div ref={sentinel} />
          {res.stage === "search" && !stale && res.hits.length < res.total && !res.error && (
            <div className="row">
              {res.more === "busy" ? (
                <span className="muted small"><span className="spinner" aria-hidden="true" /> Loading more</span>
              ) : (
                <>
                  <button type="button" className="small" onClick={loadMore}>More results</button>
                  {res.more && <span className="error">{res.more}</span>}
                </>
              )}
            </div>
          )}
        </section>
      ) : (
        <Home status={status} error={error} books={books} narrow={narrow} onLeave={leave} />
      )}
    </div>
  );
}

/** Before anything is typed: pages to go back to, a random page, and the sources on the hub. */
function Home({ status, error, books, narrow, onLeave }: { status: RefStatus | null; error: { text: string; missing: boolean } | null; books: RefBook[]; narrow: api.Narrow; onLeave: () => void }) {
  const [recent, setRecent] = useState<RecentPage[]>(() => readRecent());
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const positions = useMemo(() => readPositions(), [recent]);

  const random = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await api.random(narrow);
      onLeave();
      opening.current = { book: r.book, path: r.path, title: r.title };
      go(readerPath(r.book, r.path));
    } catch (e) {
      setErr(plainError(e));
    } finally {
      setBusy(false);
    }
  };

  if (error?.missing) {
    return (
      <div className="card col">
        <div>This hub does not have Reference yet.</div>
        <div className="muted small">Update the hub, then come back. <a href="#/settings/about">Settings, About</a></div>
      </div>
    );
  }
  if (!status) return error ? <div className="error">{error.text}</div> : <div className="muted small">Asking the hub what it has.</div>;

  if (!books.length) {
    const downloads = status.downloads ?? [];
    return (
      <div className="card col ref-empty">
        <div className="ref-empty-t">Nothing is downloaded yet.</div>
        {downloads.length ? (
          <ul className="plain col">
            {downloads.map((d) => (
              <li key={d.name} className="col ref-dl-mini">
                <span className="small">{d.title}, {languageName(d.lang)}: {d.state === "downloading" ? `${percentDone(d)}%` : downloadStateText(d)}</span>
                {d.state === "downloading" && <progress value={d.done_bytes} max={d.bytes || 1} aria-label={`${d.title}, ${progressText(d)}`} />}
              </li>
            ))}
          </ul>
        ) : (
          <div className="muted small">Pick Wikipedia, dictionaries, medical and repair guides and more. The hub keeps them for reading here with no internet.</div>
        )}
        <div><a href="#/settings/reference">Choose sources in Settings, Reference</a></div>
      </div>
    );
  }

  const shownRecent = showAll ? recent : recent.slice(0, 8);
  return (
    <div className="col ref-home">
      {status.reader.state === "failed" && <div className="error">The reader on the hub could not start{status.reader.error ? `: ${status.reader.error}` : "."}</div>}
      {(status.reader.state === "installing" || status.reader.state === "starting") && <div className="muted small">The reader on the hub is getting ready. Search works in a moment.</div>}

      {recent.length > 0 && (
        <section className="col" aria-labelledby="ref-recent-h">
          <div className="row between">
            <h2 id="ref-recent-h" className="ref-h">Continue reading</h2>
            <button type="button" className="small ghost" onClick={() => { if (confirm("Clear the list of pages read on this device?")) { clearRecent(); setRecent([]); } }}>Clear</button>
          </div>
          <ul className="plain list">
            {shownRecent.map((p) => {
              const read = Math.round((positions[pageKey(p.book, p.path)]?.f ?? 0) * 100);
              return (
                <li key={pageKey(p.book, p.path)}>
                  <a
                    href={`#${readerPath(p.book, p.path)}`}
                    className="item ref-recent"
                    onClick={() => { onLeave(); opening.current = { book: p.book, path: p.path, title: p.title }; }}
                  >
                    <span className="body">
                      <span className="t">{p.title}</span>
                      <span className="meta">
                        {p.source && <span>{p.source}</span>}
                        {read > 1 && read < 99 && <span>{read}% read</span>}
                        {read >= 99 && <span>Read to the end</span>}
                        {p.at && <span>{relativePast(p.at)}</span>}
                      </span>
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
          {recent.length > 8 && (
            <button type="button" className="small ghost ref-inline" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
              {showAll ? "Show fewer" : `Show all ${recent.length}`}
            </button>
          )}
        </section>
      )}

      <div className="row">
        <button type="button" onClick={() => void random()} disabled={busy}>
          {busy ? "Opening" : narrow.sources.length || narrow.langs.length ? "Random page from these" : "Random page"}
        </button>
        {err && <span className="error">{err}</span>}
      </div>

      <section className="col" aria-labelledby="ref-sources-h">
        <h2 id="ref-sources-h" className="ref-h">On the hub</h2>
        <ul className="plain list">
          {books.map((b) => (
            <li key={b.name} className="item ref-book">
              <span className="body">
                <span className="t">{b.title}</span>
                <span className="meta">
                  <span>{languageName(b.lang)}</span>
                  <span>{countText(b.articles, "article", "articles")}</span>
                  <span>{archiveDate(b.date)}</span>
                  {!b.fulltext && <span>Titles only</span>}
                  {b.state === "update" && <span>A newer copy is downloading</span>}
                </span>
              </span>
            </li>
          ))}
        </ul>
        <div className="small"><a href="#/settings/reference">Sources and downloads</a></div>
      </section>
    </div>
  );
}
