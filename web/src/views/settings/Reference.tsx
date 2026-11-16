import { useEffect, useMemo, useRef, useState } from "react";
import { ModuleGate } from "../../components/ModuleGate";
import { HubError } from "../../sync/api";
import { useHubReady } from "../../sync/hooks";
import { useModules } from "../../lib/modules";
import { fmtDateTime } from "../../lib/time";
import { usePoll } from "../../lib/usePoll";
import {
  WIKIPEDIA, allLanguages, archiveDate, countText, downloadStateText, downloadsRunning, flavourText, groupSources, joinWords,
  languageName, languagesFor, matchLanguages, percentDone, planText, progressText, settingsSummary, sizeText, wantedBytes,
  type LanguageChoice, type RefBook, type RefDownload, type RefPlan, type RefSettings, type RefSource, type RefSources, type RefStatus,
} from "../../lib/reference";
import * as api from "../reference/api";
import { keepStatus, useRefStatus } from "../reference/store";
import { Segmented, SubPage, Toggle, errorText } from "./common";

/** Whether the hub lists Reference and has it on (a hub that does not know it yet has no such page). */
function useReferenceOn(): boolean {
  const { list } = useModules();
  return !!list?.some((m) => m.id === "reference" && m.on);
}

/** The Settings menu row's line, or null while Reference is off. */
export function useReferenceSummary(): string | null {
  const on = useReferenceOn();
  const { status } = useRefStatus(60_000, on);
  return on ? settingsSummary(status) : null;
}

/** Settings, Reference: what the hub keeps, how big it is, and the downloads. A module that is off offers to turn it on. */
export function ReferenceSettingsPage() {
  return (
    <ModuleGate path="/reference">
      <SubPage path="/settings/reference">
        <ReferenceSettings />
      </SubPage>
    </ModuleGate>
  );
}

const READER: Record<RefStatus["reader"]["state"], string> = {
  off: "The reader on the hub starts once a book is ready.",
  installing: "Installing the reader on the hub.",
  starting: "Starting the reader on the hub.",
  ready: "The reader on the hub is running.",
  failed: "The reader on the hub could not start",
};

function ReferenceSettings() {
  const ready = useHubReady();
  const [fast, setFast] = useState(false);
  // Every 2 seconds while a download runs, else now and then; never while the app is hidden (usePoll).
  const st = usePoll(() => api.status(), fast ? 2_000 : 30_000);
  useEffect(() => {
    if (!st.data) return;
    keepStatus(st.data);
    setFast(downloadsRunning(st.data));
  }, [st.data]);

  const [choices, setChoices] = useState<RefSettings | null>(null);
  const [savedPlan, setSavedPlan] = useState<{ plan: RefPlan; at: number } | null>(null);
  const [catalog, setCatalog] = useState<RefSources | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [missing, setMissing] = useState(false);
  const [saveErr, setSaveErr] = useState("");
  const [busy, setBusy] = useState("");
  const [actErr, setActErr] = useState("");
  const saveSeq = useRef(0);
  const saving = useRef<Promise<void>>(Promise.resolve());

  const loadCatalog = () => api.sources().then(setCatalog, (e) => setLoadErr(errorText(e)));
  useEffect(() => {
    if (!ready) return;
    api.settings().then(
      (r) => {
        setChoices(r.settings);
        if (r.plan) setSavedPlan({ plan: r.plan, at: Date.now() });
      },
      (e) => {
        setLoadErr(errorText(e));
        setMissing(e instanceof HubError && e.status === 404);
      },
    );
    void loadCatalog();
  }, [ready]);

  /** A change of choices shows at once and goes to the hub in order; the hub's answer (choices and plan) wins. */
  const save = (changes: Partial<RefSettings>) => {
    if (!choices) return;
    const before = choices;
    const seq = ++saveSeq.current;
    setChoices({ ...choices, ...changes });
    setSaveErr("");
    saving.current = saving.current.then(() => api.saveSettings(changes).then(
      (r) => {
        if (seq === saveSeq.current) setChoices(r.settings);
        if (r.plan) setSavedPlan({ plan: r.plan, at: Date.now() });
        void st.reload();
      },
      (e) => {
        if (seq === saveSeq.current) setChoices(before);
        setSaveErr(`Not saved: ${errorText(e)}`);
      },
    ));
  };

  const act = async (name: string, run: () => Promise<unknown>) => {
    setBusy(name);
    setActErr("");
    try {
      await run();
      await st.reload();
    } catch (e) {
      setActErr(errorText(e));
    } finally {
      setBusy("");
    }
  };
  const remove = (b: RefBook) => {
    if (!confirm(`Remove ${b.title}, ${languageName(b.lang)}? Its ${sizeText(b.bytes)} file is deleted from the hub until you choose it again.`)) return;
    void act(`remove:${b.name}`, () => api.removeBook(b.name));
  };

  if (missing) {
    return (
      <div className="card col">
        <div>This hub does not have Reference yet.</div>
        <div className="muted small">Update the hub in <a href="#/settings/about">Settings, About</a>, then come back.</div>
      </div>
    );
  }

  const status = st.data;
  const plan = savedPlan && (!st.at || savedPlan.at > st.at.getTime()) ? savedPlan.plan : status?.plan ?? savedPlan?.plan ?? null;
  const downloads = status?.downloads ?? [];
  const books = status?.books ?? [];
  const moving = downloads.some((d) => d.state === "downloading" || d.state === "verifying" || d.state === "queued" || d.state === "waiting");
  const paused = downloads.some((d) => d.state === "paused");

  return (
    <>
      <div className="muted small">
        Wikipedia and other open references, kept on the hub. Search and read them on every device with no internet. Nothing downloads until you choose sources.
      </div>

      <section className="card col" aria-labelledby="rs-hub-h">
        <h2 id="rs-hub-h">Space and updates</h2>
        {!status ? (
          <div className={st.error ? "error small" : "muted small"}>{st.error ?? "Asking the hub."}</div>
        ) : (
          <>
            <div className={`small${status.reader?.state === "failed" ? " error" : " muted"}`}>
              {READER[status.reader?.state ?? "off"] ?? ""}{status.reader?.state === "failed" ? (status.reader.error ? `: ${status.reader.error}` : ".") : ""}
            </div>
            {plan && <PlanView plan={plan} />}
            {status.next_check && <div className="muted small">The hub looks for newer copies once a week. Next look: {fmtDateTime(status.next_check)}.</div>}
            {st.error && <div className="error small">The latest check did not reach the hub: {st.error}</div>}
          </>
        )}
        <div className="row">
          <button type="button" disabled={!!busy} onClick={() => void act("check", async () => { await api.checkNow(); await loadCatalog(); })}>
            {busy === "check" ? "Checking" : "Check now"}
          </button>
          {moving && <button type="button" disabled={!!busy} onClick={() => void act("pause", api.pause)}>{busy === "pause" ? "Pausing" : "Pause downloads"}</button>}
          {paused && <button type="button" disabled={!!busy} onClick={() => void act("resume", api.resume)}>{busy === "resume" ? "Resuming" : "Resume downloads"}</button>}
        </div>
        <div className="muted small">Check now reads Kiwix's list again and queues anything missing or newer.</div>
        {actErr && <div className="error small" role="alert">{actErr}</div>}
      </section>

      {downloads.length > 0 && <Downloads downloads={downloads} />}
      {books.length > 0 && <Books books={books} busy={busy} onRemove={remove} />}

      {saveErr && <div className="error" role="alert">{saveErr}</div>}
      {!choices ? (
        loadErr ? <div className="error">{loadErr}</div> : <div className="muted small">Asking the hub for your choices.</div>
      ) : (
        <Choices choices={choices} catalog={catalog} loadErr={loadErr} save={save} />
      )}
    </>
  );
}

/** The total against free space, with a bar for how much of the free space the rest of the download takes. */
function PlanView({ plan }: { plan: RefPlan }) {
  const p = planText(plan);
  const pct = Math.round(p.share * 100);
  return (
    <div className="col ref-plan">
      <div className={`small${p.fits ? "" : " error"}`}>{p.lines.join(" ")}</div>
      <div className={`ref-bar${p.fits ? "" : " over"}`} role="img" aria-label={`Still to download: ${sizeText(plan.to_download_bytes)} of ${sizeText(plan.free_bytes)} free`}>
        <span style={{ width: `${Math.max(pct, plan.to_download_bytes > 0 ? 1 : 0)}%` }} />
      </div>
    </div>
  );
}

function Downloads({ downloads }: { downloads: RefDownload[] }) {
  return (
    <section className="card col" aria-labelledby="rs-dl-h">
      <h2 id="rs-dl-h">Downloads</h2>
      <ul className="plain col ref-dls">
        {downloads.map((d) => {
          const kind = flavourText(d.flavour);
          const pct = percentDone(d);
          const words = d.state === "downloading" ? progressText(d) : `${downloadStateText(d)}. ${d.done_bytes > 0 ? `${sizeText(d.done_bytes)} of ${sizeText(d.bytes)}` : sizeText(d.bytes)}.`;
          return (
            <li key={d.name} className="col ref-dl">
              <div className="row between">
                <span>{d.title} <span className="muted small">{languageName(d.lang)}{kind ? `, ${kind}` : ""}{d.date ? `, ${archiveDate(d.date)}` : ""}</span></span>
                {(d.state === "downloading" || d.state === "paused" || d.state === "verifying") && <span className="small muted">{pct}%</span>}
              </div>
              {d.state !== "queued" && d.state !== "failed" && (
                <progress className="ref-progress" value={d.state === "verifying" ? d.bytes || 1 : d.done_bytes} max={d.bytes || 1} aria-label={`${d.title}, ${pct}% downloaded`} />
              )}
              <div className={`small${d.state === "failed" ? " error" : " muted"}`}>{words}</div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Books({ books, busy, onRemove }: { books: RefBook[]; busy: string; onRemove: (b: RefBook) => void }) {
  return (
    <section className="card col" aria-labelledby="rs-books-h">
      <h2 id="rs-books-h">On the hub</h2>
      <ul className="plain col">
        {books.map((b) => {
          const kind = flavourText(b.flavour);
          const extra = [b.state === "update" ? "a newer copy is downloading" : "", b.state === "removing" ? "being removed" : "", b.fulltext ? "" : "titles only"].filter(Boolean);
          return (
            <li key={b.name} className="row between ref-book-row">
              <span className="grow">
                <span>{b.title}</span> <span className="muted small">{languageName(b.lang)}{kind ? `, ${kind}` : ""}</span>
                <span className="muted small ref-book-meta">{[sizeText(b.bytes), countText(b.articles, "article", "articles"), archiveDate(b.date), ...extra].join(", ")}</span>
              </span>
              <button type="button" className="small ghost danger" disabled={b.state === "removing" || busy === `remove:${b.name}`} aria-label={`Remove ${b.title}, ${languageName(b.lang)}`} onClick={() => onRemove(b)}>
                {busy === `remove:${b.name}` ? "Removing" : "Remove"}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Languages, pictures, Wikipedia's size, the sources by group, and when to download. */
function Choices({ choices: s, catalog, loadErr, save }: { choices: RefSettings; catalog: RefSources | null; loadErr: string; save: (c: Partial<RefSettings>) => void }) {
  const languages = useMemo(() => allLanguages(catalog?.sources ?? []), [catalog]);
  const setOverride = (id: string, v: "" | "on" | "off") => {
    const all = { ...s.overrides };
    const one = { ...(all[id] ?? {}) };
    if (v === "") delete one.images;
    else one.images = v === "on";
    if (Object.keys(one).length) all[id] = one;
    else delete all[id];
    save({ overrides: all });
  };
  return (
    <>
      <Languages all={languages} chosen={s.languages} onChange={(languages) => save({ languages })} />

      <section className="card col" aria-labelledby="rs-pics-h">
        <h2 id="rs-pics-h">Pictures and Wikipedia</h2>
        <Toggle checked={s.images} onChange={(images) => save({ images })} label="Pictures" note="With pictures, an archive is several times larger. Each chosen source can differ." />
        <div className="col">
          <div id="rs-wiki-l">Wikipedia</div>
          <Segmented value={s.wikipedia} options={[{ value: "text", label: "Full text" }, { value: "intros", label: "Intros only" }]} onChange={(wikipedia) => save({ wikipedia })} label="Wikipedia" />
          <div className="muted small">Intros only keeps the start of each article, a small part of the size, without pictures.</div>
        </div>
      </section>

      {!catalog ? (
        <section className="card">
          <div className={loadErr ? "error small" : "muted small"}>{loadErr || "Reading the list of sources."}</div>
        </section>
      ) : (
        <>
          {!catalog.sources.some((x) => x.languages.length) && (
            <div className="muted small">Kiwix's list has not been read yet. Check now reads it.</div>
          )}
          {groupSources(catalog.sources).map((g) => (
            <section key={g.group} className="card col ref-group" aria-label={g.group}>
              <h2>{g.group}</h2>
              {g.sources.map((src) => <SourceRow key={src.id} src={src} s={s} save={save} setOverride={setOverride} />)}
            </section>
          ))}
          {catalog.checked_at && <div className="muted small">Kiwix's list was read {fmtDateTime(catalog.checked_at)}.</div>}
        </>
      )}

      <section className="card col" aria-labelledby="rs-when-h">
        <h2 id="rs-when-h">When to download</h2>
        <Segmented value={s.schedule} options={[{ value: "nights", label: "At night" }, { value: "any", label: "Any time" }]} onChange={(schedule) => save({ schedule })} label="When to download" />
        <div className="muted small">
          {s.schedule === "nights" ? "Updates download between 01:00 and 07:00, hub time. A first download starts at once." : "Downloads start as soon as there is something to get."} Downloads pause while a game runs on the hub.
        </div>
        <SpeedCap value={s.max_mbps} onSave={(max_mbps) => save({ max_mbps })} />
      </section>
    </>
  );
}

/** One source: its switch, what it is, its size under the choices, and pictures for it alone. */
function SourceRow({ src, s, save, setOverride }: { src: RefSource; s: RefSettings; save: (c: Partial<RefSettings>) => void; setOverride: (id: string, v: "" | "on" | "off") => void }) {
  const chosen = s.sources.includes(src.id);
  const bytes = wantedBytes(src, s);
  const wanted = languagesFor(src.id, s);
  const have = src.languages.filter((l) => wanted.includes(l.code));
  const names = (ls: { name: string; code: string }[]) => (ls.length > 4 ? `${ls.length} languages` : joinWords(ls.map((l) => l.name || languageName(l.code))));
  const size = !src.languages.length
    ? "Not in Kiwix's list right now."
    : bytes === null
      ? `Not in your languages. It comes in ${names(src.languages)}.`
      : `${sizeText(bytes)} for ${names(have)}.`;
  const pictures = have.some((l) => l.books.some((b) => b.flavour === "maxi")) && !(src.id === WIKIPEDIA && s.wikipedia === "intros");
  const override = s.overrides[src.id]?.images;
  const id = `rs-pic-${src.id}`;
  return (
    <div className="ref-source">
      <Toggle
        checked={chosen}
        onChange={(on) => save({ sources: on ? [...s.sources, src.id] : s.sources.filter((x) => x !== src.id) })}
        label={src.title}
        note={
          <>
            {src.summary && <span>{src.summary} </span>}
            <span className={bytes === null ? "" : "ref-size-note"}>{size}</span>
            {src.license && <span> {src.license}.</span>}
          </>
        }
      />
      {chosen && pictures && (
        <div className="row ref-override">
          <label htmlFor={id} className="small muted">Pictures</label>
          <select id={id} value={override === undefined ? "" : override ? "on" : "off"} onChange={(e) => setOverride(src.id, e.target.value as "" | "on" | "off")}>
            <option value="">As set for all ({s.images ? "with pictures" : "without"})</option>
            <option value="on">With pictures</option>
            <option value="off">Without pictures</option>
          </select>
        </div>
      )}
    </div>
  );
}

/** The languages chosen, as chips, and a search over every language any source has, by English or own name. */
function Languages({ all, chosen, onChange }: { all: LanguageChoice[]; chosen: string[]; onChange: (codes: string[]) => void }) {
  const [q, setQ] = useState("");
  const found = useMemo(() => matchLanguages(all, q), [all, q]);
  const typed = q.trim();
  const shown = typed ? found.slice(0, 60) : found.filter((l) => !chosen.includes(l.code)).slice(0, 12);
  const toggle = (code: string) => onChange(chosen.includes(code) ? chosen.filter((c) => c !== code) : [...chosen, code]);
  const nameOf = (code: string) => {
    const l = all.find((x) => x.code === code);
    return l ? l.name : languageName(code);
  };
  return (
    <section className="card col" aria-labelledby="rs-lang-h">
      <h2 id="rs-lang-h">Languages</h2>
      <div className="muted small">Each source comes in every language picked here that it has.</div>
      <div className="chips" role="group" aria-label="Chosen languages">
        {chosen.map((c) => (
          <button key={c} type="button" className="chip on" aria-label={`Remove ${nameOf(c)}`} onClick={() => toggle(c)}>
            {nameOf(c)} <span aria-hidden="true">{"×"}</span>
          </button>
        ))}
        {!chosen.length && <span className="muted small">None chosen, so nothing downloads.</span>}
      </div>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a language, in English or in its own name" aria-label="Find a language" aria-controls="rs-langs" />
      <ul id="rs-langs" className="plain ref-langs" aria-label={typed ? "Languages found" : "Languages most sources have"}>
        {shown.map((l) => (
          <li key={l.code}>
            <label className="toggle-row ref-lang">
              <input type="checkbox" checked={chosen.includes(l.code)} onChange={() => toggle(l.code)} />
              <span className="grow">
                {l.name}
                {l.native && l.native.toLowerCase() !== l.name.toLowerCase() && <span className="muted" lang={l.tag || undefined}> {"·"} {l.native}</span>}
              </span>
              <span className="muted small">{countText(l.sources, "source", "sources")}</span>
            </label>
          </li>
        ))}
      </ul>
      {typed && !found.length && <div className="muted small">No language matches "{typed}".</div>}
      {!typed && all.length > shown.length && <div className="muted small">Type to find any of the {all.length} languages.</div>}
    </section>
  );
}

/** The speed cap in megabits per second; empty is no cap. Saved when the field is left or Enter is pressed. */
function SpeedCap({ value, onSave }: { value: number | null; onSave: (v: number | null) => void }) {
  const [text, setText] = useState(value ? String(value) : "");
  useEffect(() => setText(value ? String(value) : ""), [value]);
  const commit = () => {
    const t = text.trim();
    if (!t) {
      if (value !== null) onSave(null);
      return;
    }
    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0) {
      setText(value ? String(value) : "");
      return;
    }
    const v = Math.round(n * 10) / 10;
    if (v !== value) onSave(v);
  };
  return (
    <div className="col">
      <label htmlFor="rs-cap">Speed cap, in megabits per second</label>
      <div className="row">
        <input
          id="rs-cap"
          type="number"
          inputMode="decimal"
          min={1}
          step={1}
          value={text}
          placeholder="No cap"
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
          className="ref-cap"
        />
        {value !== null && <button type="button" className="small" onClick={() => { setText(""); onSave(null); }}>No cap</button>}
      </div>
      <div className="muted small">Empty means no cap.</div>
    </div>
  );
}
