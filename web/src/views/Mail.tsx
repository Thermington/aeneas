import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState } from "react";
import { openExternal } from "../tauri/bridge";
import { engine } from "../sync/engine";
import { usePoll } from "../lib/usePoll";
import { useModules } from "../lib/modules";
import { plainError } from "../lib/errors";
import { fmtDateTime } from "../lib/time";
import {
  bundleOf,
  frameLink,
  inboxSections,
  initials,
  logoSrc,
  matches,
  nameHidesAddress,
  personLabel,
  sendersLine,
  shownBundles,
  snoozeChoices,
  textParts,
  viewMessages,
  whenLabel,
  type Bundle,
  type MailList,
  type MailMessage,
  type MailSummary,
  type MailView,
  type TextPart,
} from "../lib/mail";

/**
 * Mail (module mail_inbox): the iCloud Inbox in the app's own look, with Pin, Done and Snooze. Mail grouped by
 * day, kinds of mail gathered into colored bundles, and a side list of Inbox, Snoozed, Done and the bundles; the bar at
 * the top takes the color of where you are. A message opens in place as a card with its whole text.
 *
 * Mail is hostile input: its HTML only as the hub cleaned it, in a frame where nothing runs (MailFrame), else as text
 * with links only through textParts, which checks them; the sender's real address on every open message; and a brand's
 * logo only when iCloud verified it (the hub checks iCloud's verdict).
 */

/**
 * What the rows and cards need from the screen: the verified logos, the bundles shown, and `act`, which asks the hub to
 * do something to a mail (Pin) and then loads the list again so every row shows it.
 */
interface LookValue {
  logos: Record<string, string>; shown: Bundle[]; act: (run: (c: NonNullable<typeof engine.client>) => Promise<unknown>) => Promise<void>;
  /** Done (to Archive) or back to the Inbox, with an Undo bar afterwards. */
  move: (ids: string[], to: "done" | "inbox") => Promise<void>;
  /** Snooze until a time (with Undo), or bring back now. */
  snooze: (m: MailSummary, until: Date) => Promise<void>;
  unsnooze: (m: MailSummary) => Promise<void>;
  /** The open mail whose snooze choices show (a row's Snooze opens the mail with them). */
  snoozeFor: string | null; setSnoozeFor: (id: string | null) => void; openMail: (id: string) => void;
}
const Look = createContext<LookValue>({ logos: {}, shown: [], act: async () => {}, move: async () => {}, snooze: async () => {}, unsnooze: async () => {}, snoozeFor: null, setSnoozeFor: () => {}, openMail: () => {} });
export function Mail() {
  const list = usePoll((c) => c.mailList(), 60_000);
  const { on } = useModules();
  const [view, setView] = useState<MailView>("inbox");
  const [q, setQ] = useState("");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [openBundles, setOpenBundles] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState(false);
  const shown = shownBundles(on);
  // A view of a bundle whose module was switched off goes back to the Inbox.
  useEffect(() => {
    if (view.startsWith("b:") && !shown.some((b) => b.id === view.slice(2))) setView("inbox");
  }, [view, shown]);

  const messages = useMemo(() => (list.data?.messages ?? []).filter((m) => matches(m, q)), [list.data, q]);
  const go = (v: MailView) => { setView(v); setOpen(null); setMenu(false); };
  const toggleBundle = (id: string) => setOpenBundles((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const here = view.startsWith("b:") ? shown.find((b) => b.id === view.slice(2)) : null;
  const title = here?.name ?? (view === "snoozed" ? "Snoozed" : view === "done" ? "Done" : "Inbox");
  const barClass = here ? `b-${here.id}` : `v-${view}`;
  const [actErr, setActErr] = useState("");
  // The last Done or Sweep, for its Undo bar (gone after a few seconds, or with the next one).
  const [undo, setUndo] = useState<{ text: string; run: () => Promise<void> } | null>(null);
  const [snoozeFor, setSnoozeFor] = useState<string | null>(null);
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 10_000);
    return () => clearTimeout(t);
  }, [undo]);
  const move: LookValue["move"] = async (ids, to) => {
    const c = engine.client;
    if (!c || !ids.length) return;
    setActErr("");
    try {
      const r = to === "done" ? await c.mailDone(ids) : await c.mailUndo(ids);
      if (r.error) setActErr(r.error);
      if (r.moved.length && to === "done") {
        const ids2 = r.moved;
        setUndo({ text: r.moved.length === 1 ? "Marked done" : `${r.moved.length} marked done`, run: () => move(ids2, "inbox") });
        if (open && r.moved.includes(open)) setOpen(null);
      } else if (to === "inbox") setUndo(null);
    } catch (e) { setActErr(plainError(e)); }
    await list.reload();
  };
  const unsnooze: LookValue["unsnooze"] = async (m) => {
    setActErr("");
    try { await engine.client?.mailUnsnooze(m.id); } catch (e) { setActErr(plainError(e)); }
    setSnoozeFor(null);
    await list.reload();
  };
  const snooze: LookValue["snooze"] = async (m, until) => {
    const c = engine.client;
    if (!c) return;
    setActErr("");
    try {
      await c.mailSnooze(m.id, until.toISOString());
      setSnoozeFor(null);
      if (open === m.id) setOpen(null);
      setUndo({ text: `Snoozed until ${until.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`, run: () => unsnooze(m) });
    } catch (e) { setActErr(plainError(e)); }
    await list.reload();
  };
  const act: LookValue["act"] = async (run) => {
    if (!engine.client) return;
    setActErr("");
    try { await run(engine.client); } catch (e) { setActErr(plainError(e)); }
    await list.reload();
  };

  return (
    <Look.Provider value={{ logos: list.data?.logos ?? {}, shown, act, move, snooze, unsnooze, snoozeFor, setSnoozeFor, openMail: (id) => setOpen(id) }}>
    <div className={`mailx${menu ? " menu-open" : ""}`}>
      <div className={`mailx-bar ${barClass}`}>
        <button type="button" className="mailx-menu" aria-label="Show Inbox, Snoozed, Done and the bundles" aria-expanded={menu} onClick={() => setMenu((x) => !x)}>
          <Icon name="menu" />
        </button>
        <h1>{title}</h1>
        <input type="search" className="mailx-search" placeholder="Search mail" aria-label="Search mail" value={q} onChange={(e) => setQ(e.target.value)} />
        {view === "inbox" && (
          <button type="button" className="mailx-switch" aria-pressed={pinnedOnly} onClick={() => setPinnedOnly((x) => !x)}>
            <span className="lbl">Pinned only</span><span className="sw" aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="mailx-body">
        <nav className="mailx-rail" aria-label="Mail views">
          <Nav view="inbox" current={view} go={go} icon="inbox" label="Inbox" count={list.data?.messages.filter((m) => m.state === "inbox").length} />
          <Nav view="snoozed" current={view} go={go} icon="clock" label="Snoozed" count={list.data?.messages.filter((m) => m.state === "snoozed").length} />
          <Nav view="done" current={view} go={go} icon="check" label="Done" />
          <div className="mailx-label">Bundles</div>
          {shown.filter((b) => !b.module).map((b) => <BundleNav key={b.id} b={b} current={view} go={go} list={list.data} />)}
          {shown.some((b) => b.module) && <div className="mailx-label">From your modules</div>}
          {shown.filter((b) => b.module).map((b) => <BundleNav key={b.id} b={b} current={view} go={go} list={list.data} />)}
          {list.data && <Mailboxes data={list.data} reload={list.reload} />}
        </nav>
        {menu && <div className="mailx-scrim" onClick={() => setMenu(false)} aria-hidden="true" />}
        <div className="mailx-main">
          {actErr && <div className="error mailx-acterr" role="alert">{actErr}</div>}
          {undo && (
            <div className="mailx-undo" role="status">
              <span>{undo.text}</span>
              <button type="button" onClick={() => { const run = undo.run; setUndo(null); void run(); }}>Undo</button>
            </div>
          )}
          {!list.data && list.error ? <div className="error">{list.error}</div>
            : !list.data ? <div className="muted small">Loading</div>
            : !list.data.mailboxes.length ? <div className="empty">Link an iCloud mailbox in <a href="#/settings/connections">Settings, Connections</a> to see your mail here.</div>
            : view === "inbox"
              ? <InboxList messages={messages} shown={shown} pinnedOnly={pinnedOnly} open={open} setOpen={setOpen} openBundles={openBundles} toggleBundle={toggleBundle} searching={!!q.trim()} waiting={!list.data.mailboxes.some((m) => m.last_refresh)} />
              : <Flat messages={viewMessages(messages, view, shown)} view={view} bundle={here ?? null} open={open} setOpen={setOpen} />}
          {list.data?.mailboxes.some((m) => m.more) && <div className="muted small mailx-hint">Bringing in more of your Inbox. The rest arrives over the next few minutes.</div>}
        </div>
      </div>
    </div>
    </Look.Provider>
  );
}

function Nav({ view, current, go, icon, label, count }: { view: MailView; current: MailView; go: (v: MailView) => void; icon: string; label: string; count?: number }) {
  return (
    <button type="button" className={`mailx-nav v-${view}`} aria-current={current === view ? "page" : undefined} onClick={() => go(view)}>
      <span className="ico"><Icon name={icon} /></span>{label}{!!count && <span className="n">{count}</span>}
    </button>
  );
}

function BundleNav({ b, current, go, list }: { b: Bundle; current: MailView; go: (v: MailView) => void; list: MailList | null }) {
  const view = `b:${b.id}` as MailView;
  const n = list?.messages.filter((m) => m.state === "inbox" && m.bundle === b.id).length;
  return (
    <button type="button" className={`mailx-nav b-${b.id}`} aria-current={current === view ? "page" : undefined} onClick={() => go(view)}>
      <span className="ico"><Icon name={b.id} /></span>{b.name}{!!n && <span className="n">{n}</span>}
    </button>
  );
}

/** Each mailbox's last refresh or problem, and Refresh. */
function Mailboxes({ data, reload }: { data: MailList; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const client = engine.client;
  const refresh = async () => {
    if (!client) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await client.mailRefresh();
      const kept = r.mailboxes.reduce((n, m) => n + ("kept" in m ? m.kept : 0), 0);
      const failed = r.mailboxes.filter((m) => "error" in m).length;
      setMsg(failed ? { ok: false, text: `${failed === 1 ? "A mailbox" : `${failed} mailboxes`} could not be refreshed.` } : { ok: true, text: kept ? `${kept} new.` : "Nothing new." });
      await reload();
    } catch (e) {
      setMsg({ ok: false, text: plainError(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mailx-boxes small">
      <div className="row">
        <button type="button" className="small" disabled={busy || !client} onClick={() => void refresh()}>{busy ? "Refreshing" : "Refresh"}</button>
        {msg && <span className={msg.ok ? "ok" : "error"}>{msg.text}</span>}
      </div>
      {data.mailboxes.map((m) => (
        <div key={m.email}>
          <span className="muted">{m.email}: {m.last_refresh ? `refreshed ${fmtDateTime(m.last_refresh)}` : "not refreshed yet"}</span>
          {m.last_error && <div className="error">{m.last_error}</div>}
        </div>
      ))}
      <div className="muted">Nothing is marked read in iCloud. Done moves mail to Archive there; Undo moves it back.</div>
    </div>
  );
}

function InboxList({ messages, shown, pinnedOnly, open, setOpen, openBundles, toggleBundle, searching, waiting }: {
  messages: MailSummary[]; shown: Bundle[]; pinnedOnly: boolean; open: string | null; setOpen: (id: string | null) => void;
  openBundles: Set<string>; toggleBundle: (id: string) => void; searching: boolean; waiting: boolean;
}) {
  const sections = inboxSections(messages, shown, { pinnedOnly });
  if (!sections.length) {
    if (searching) return <div className="muted small">No mail has all of those words.</div>;
    if (waiting) return <div className="empty">Your Inbox arrives with the first refresh, a minute or so after the hub starts. Refresh brings it now.</div>;
    return <Empty title={pinnedOnly ? "No pinned mail" : "You're all done"} text={pinnedOnly ? "Pinned mail stays here." : "Nothing left in your Inbox."} />;
  }
  return (
    <div className="mailx-col">
      {sections.map((s) => (
        <section key={s.title} className="mailx-group">
          <h2>{s.title}<Sweep mails={s.rows.flatMap((r) => (r.kind === "mail" ? [r.mail] : r.mails))} /></h2>
          <div className="mailx-list">
            {s.rows.map((r) => r.kind === "mail"
              ? <Row key={r.mail.id} m={r.mail} open={open === r.mail.id} setOpen={setOpen} />
              : <BundleRow key={`${s.title}:${r.bundle.id}`} b={r.bundle} mails={r.mails} isOpen={openBundles.has(`${s.title}:${r.bundle.id}`)} toggle={() => toggleBundle(`${s.title}:${r.bundle.id}`)} open={open} setOpen={setOpen} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

function Flat({ messages, view, bundle, open, setOpen }: { messages: MailSummary[]; view: MailView; bundle: Bundle | null; open: string | null; setOpen: (id: string | null) => void }) {
  if (!messages.length) {
    if (view === "snoozed") return <Empty title="Nothing snoozed" text="Snoozed mail waits here until its time." />;
    if (view === "done") return <Empty title="Nothing done yet" text="Mail you mark done shows here." />;
    return <div className="mailx-col">{bundle && <ModuleLink b={bundle} />}<Empty title={`No ${bundle?.name.toLowerCase() ?? ""} mail`} text="New mail of this kind gathers here." /></div>;
  }
  return (
    <div className="mailx-col">
      {bundle && <ModuleLink b={bundle} />}
      <div className="mailx-list">
        {messages.map((m) => <Row key={m.id} m={m} open={open === m.id} setOpen={setOpen} />)}
      </div>
    </div>
  );
}

function ModuleLink({ b }: { b: Bundle }) {
  if (!b.module || !b.screen) return null;
  return (
    <div className={`mailx-module b-${b.id}`}>
      <span>Sorted using your {b.moduleName} records.</span>
      <a href={`#${b.screen}`}>Open {b.moduleName} ›</a>
    </div>
  );
}

function BundleRow({ b, mails, isOpen, toggle, open, setOpen }: { b: Bundle; mails: MailSummary[]; isOpen: boolean; toggle: () => void; open: string | null; setOpen: (id: string | null) => void }) {
  return (
    <div className={`mailx-bundle b-${b.id}${isOpen ? " open" : ""}`}>
      <button type="button" className="mailx-row" aria-expanded={isOpen} onClick={toggle}>
        <span className="mailx-av bundle"><Icon name={b.id} /></span>
        <span className="mailx-what">
          <span className="who"><b className="bname">{b.name}</b><span className="chip">{mails.length}</span></span>
          <span className="line">{sendersLine(mails)}</span>
        </span>
        <span className="when">{whenLabel(mails[0].at)}</span>
      </button>
      {isOpen && (
        <>
          <ModuleLink b={b} />
          <div className="mailx-bundle-acts"><Sweep mails={mails} /></div>
          {mails.map((m) => <Row key={m.id} m={m} open={open === m.id} setOpen={setOpen} />)}
        </>
      )}
    </div>
  );
}

function Row({ m, open, setOpen }: { m: MailSummary; open: boolean; setOpen: (id: string | null) => void }) {
  if (open) return <Card m={m} close={() => setOpen(null)} />;
  // The row opens the mail; its actions show when it is pointed at or tabbed to (on a phone, open the mail for them).
  return (
    <div className="mailx-item">
      <button type="button" className="mailx-row" onClick={() => setOpen(m.id)}>
        <Avatar m={m} />
        <span className="mailx-what">
          <span className="who"><b>{personLabel(m.from)}</b>{m.pinned && <span className="pinmark" title="Pinned"><Icon name="pin" /></span>}</span>
          <span className="line"><span className="subj">{m.subject || "(no subject)"}</span>{m.preview && <> · {m.preview}</>}</span>
        </span>
        <span className="when">{m.state === "snoozed" && m.snooze_until ? `Until ${whenLabel(m.snooze_until)}` : whenLabel(m.at)}</span>
      </button>
      <span className="mailx-acts"><PinButton m={m} /><SnoozeButton m={m} /><DoneButton m={m} /></span>
    </div>
  );
}

/**
 * A sender's circle: the brand's logo when iCloud verified it; for other mail a system sent, the sender's initials on
 * its bundle's color (TC for Trade Coffee on Purchases green); for a person, or mail in no bundle, initials on gray.
 */
function Avatar({ m }: { m: MailSummary }) {
  const { logos, shown } = useContext(Look);
  const logo = m.logo_domain ? logoSrc(logos[m.logo_domain]) : null;
  if (logo) return <span className="mailx-av logo" aria-hidden="true"><img src={logo} alt="" /></span>;
  const b = m.automated ? bundleOf(m, shown) : null;
  if (b) return <span className={`mailx-av bundle b-${b.id}`} aria-hidden="true">{initials(m.from)}</span>;
  return <span className="mailx-av" aria-hidden="true">{initials(m.from)}</span>;
}

/** Pin or unpin: the pin filled while pinned. `labelled`: with its word beside it (an open mail's bar). */
function PinButton({ m, labelled = false }: { m: MailSummary; labelled?: boolean }) {
  const { act } = useContext(Look);
  const [busy, setBusy] = useState(false);
  const label = m.pinned ? "Unpin" : "Pin";
  return (
    <button type="button" className={`mailx-act${m.pinned ? " on" : ""}`} aria-pressed={m.pinned} title={label} aria-label={label} disabled={busy}
      onClick={async () => { setBusy(true); await act((c) => c.mailPin(m.id, !m.pinned)); setBusy(false); }}>
      <Icon name="pin" />{labelled && <span>{label}</span>}
    </button>
  );
}

/** Done (moves the mail to Archive in iCloud), or for done mail, Move to Inbox. */
function DoneButton({ m, labelled = false }: { m: MailSummary; labelled?: boolean }) {
  const { move } = useContext(Look);
  const [busy, setBusy] = useState(false);
  const back = m.state === "done";
  const label = back ? "Move to Inbox" : "Done";
  return (
    <button type="button" className="mailx-act" title={back ? "Move back to the Inbox in iCloud" : "Done: moves it to Archive in iCloud"} aria-label={label} disabled={busy}
      onClick={async () => { setBusy(true); await move([m.id], back ? "inbox" : "done"); setBusy(false); }}>
      <Icon name={back ? "inbox" : "check"} />{labelled && <span>{label}</span>}
    </button>
  );
}

/**
 * Snooze: shows the snooze choices on the open mail (a row's button opens it with them). For a snoozed mail, Unsnooze
 * brings it back now; its choices change the time.
 */
function SnoozeButton({ m, labelled = false }: { m: MailSummary; labelled?: boolean }) {
  const { snoozeFor, setSnoozeFor, openMail, unsnooze } = useContext(Look);
  if (m.state === "done") return null;
  const showing = snoozeFor === m.id;
  return (
    <>
      <button type="button" className={`mailx-act${showing ? " on" : ""}`} aria-expanded={showing} title={m.state === "snoozed" ? "Change when it comes back" : "Snooze: hide it until a time you pick"} aria-label="Snooze"
        onClick={() => { setSnoozeFor(showing ? null : m.id); if (!showing) openMail(m.id); }}>
        <Icon name="clock" />{labelled && <span>{m.state === "snoozed" ? "Change snooze" : "Snooze"}</span>}
      </button>
      {labelled && m.state === "snoozed" && (
        <button type="button" className="mailx-act" onClick={() => void unsnooze(m)}><Icon name="inbox" /><span>Unsnooze</span></button>
      )}
    </>
  );
}

/** The snooze choices (later today, tomorrow, the weekend, next week) and a date and time of your own. */
function SnoozePicker({ m }: { m: MailSummary }) {
  const { snooze } = useContext(Look);
  const [own, setOwn] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async (at: Date) => { setBusy(true); await snooze(m, at); setBusy(false); };
  const ownAt = own ? new Date(own) : null;
  const ownOk = !!ownAt && !Number.isNaN(ownAt.getTime()) && ownAt.getTime() > Date.now() + 60_000;
  return (
    <div className="mailx-snooze mailx-card-pad" role="group" aria-label="Snooze until">
      {snoozeChoices().map((c) => (
        <button key={c.id} type="button" className="mailx-snooze-choice" disabled={busy} onClick={() => void go(c.at)}>
          <b>{c.label}</b><span>{c.at.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>
        </button>
      ))}
      <label className="mailx-snooze-own">
        <span>Pick a date and time</span>
        <input type="datetime-local" value={own} onChange={(e) => setOwn(e.target.value)} />
        <button type="button" disabled={busy || !ownOk} onClick={() => ownAt && void go(ownAt)}>Snooze</button>
      </label>
    </div>
  );
}

/** Sweep: every unpinned mail here marked done at once (pinned mail stays), with one Undo. */
function Sweep({ mails }: { mails: MailSummary[] }) {
  const { move } = useContext(Look);
  const [busy, setBusy] = useState(false);
  const ids = mails.filter((m) => !m.pinned && m.state !== "done").map((m) => m.id);
  if (!ids.length) return null;
  return (
    <button type="button" className="mailx-act mailx-sweep" title={`Mark ${ids.length} done (pinned mail stays)`} disabled={busy}
      onClick={async () => { setBusy(true); await move(ids, "done"); setBusy(false); }}>
      <Icon name="check" /><span>Sweep</span>
    </button>
  );
}

/** An open message: the mail as sent (the hub's cleaned page), or its text; fetched from the hub when it opens. */
function Card({ m, close }: { m: MailSummary; close: () => void }) {
  const { snoozeFor } = useContext(Look);
  const [full, setFull] = useState<MailMessage | null>(null);
  const [err, setErr] = useState("");
  const [asText, setAsText] = useState(false);
  const [pictures, setPictures] = useState<{ busy: boolean; error: string }>({ busy: false, error: "" });
  useEffect(() => {
    let live = true;
    engine.client?.mailMessage(m.id).then((x) => { if (live) setFull(x); }).catch((e) => { if (live) setErr(plainError(e)); });
    return () => { live = false; };
  }, [m.id]);
  // Show pictures (a hub without Tor): the hub fetches this mail's pictures from its sender now, and the mail comes
  // back with them written in.
  const showPictures = async () => {
    const c = engine.client;
    if (!c) return;
    setPictures({ busy: true, error: "" });
    try {
      setFull(await c.mailShowPictures(m.id));
      setPictures({ busy: false, error: "" });
    } catch (e) { setPictures({ busy: false, error: plainError(e) }); }
  };
  const askPictures = !!full?.html && !asText && !!full.pictures_ask;
  return (
    <article className="mailx-card">
      <button type="button" className="mailx-card-head" onClick={close} aria-expanded="true">
        <Avatar m={m} />
        <span className="mailx-what">
          <span className="subject">{m.subject || "(no subject)"}</span>
          {/* The real address, always: a display name can say anything. */}
          <span className="meta"><b>{personLabel(m.from)}</b> &lt;{m.from.address}&gt; · {fmtDateTime(m.at)}</span>
        </span>
      </button>
      <div className="mailx-card-acts mailx-card-pad"><DoneButton m={m} labelled /><SnoozeButton m={m} labelled /><PinButton m={m} labelled /></div>
      {m.state === "snoozed" && m.snooze_until && <div className="muted small mailx-card-pad">Snoozed until {fmtDateTime(m.snooze_until)}. It comes back to the top of your Inbox then; its task, called Snoozed mail, is in Tasks and Reminders.</div>}
      {snoozeFor === m.id && <SnoozePicker m={m} />}
      {nameHidesAddress(m.from) && <div className="warn small mailx-card-pad">The sender's name shows a different address than the one it came from.</div>}
      {askPictures && (
        <div className="mailx-pictures mailx-card-pad small">
          <button type="button" disabled={pictures.busy} onClick={() => void showPictures()}>{pictures.busy ? "Fetching pictures" : "Show pictures"}</button>
          <span className="muted">This mail's pictures are not loaded. Your hub would fetch them from the sender, who then sees your home's internet address. A hub with Tor loads pictures on its own, without showing it.</span>
          {pictures.error && <span className="error" role="alert">{pictures.error}</span>}
        </div>
      )}
      {err ? <div className="error mailx-card-pad">{err}</div>
        : !full ? <div className="muted small mailx-card-pad">Loading</div>
        : full.html && !asText ? <div className="mailx-page"><MailFrame doc={full.html} title={m.subject || "Mail"} /></div>
        : <div className="mailx-text mailx-card-pad"><Linked text={full.text} /></div>}
      {full && (
        <div className="mailx-card-foot mailx-card-pad muted small">
          {full.html ? (
            <>
              {asText ? "Shown as text." : full.pictures_pending ? "The hub is still fetching this mail's pictures." : full.pictures_ask ? "Shown as sent, without its pictures." : "Shown as sent. Pictures were fetched by the hub, not this device."}
              {" "}<button type="button" className="link" onClick={() => setAsText(!asText)}>{asText ? "Show as sent" : "Show as text"}</button>
            </>
          ) : "Shown as text: this mail has no other version."}
        </div>
      )}
    </article>
  );
}

/**
 * The mail as sent, in a frame sandboxed without the permission to run scripts: nothing in it can run, whatever got past the hub's
 * cleaning, and its own policy (mail-html.ts on the hub) loads nothing. `allow-same-origin` only lets this screen's
 * code reach in to size the frame to the mail and take its link clicks: a link opens in the browser (http, https or
 * mailto only), never inside the frame, and shows its real address when pointed at.
 */
/** The tallest a mail's frame gets, in px (a long newsletter is 10,000 to 15,000). */
const FRAME_MAX = 30_000;

function MailFrame({ doc, title }: { doc: string; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | null = null;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a) return;
      e.preventDefault();
      const href = frameLink(a.getAttribute("href"));
      if (href) void openExternal(href);
    };
    const ready = () => {
      const d = frame.contentDocument;
      if (!d) return;
      // The mail's own height: measured with the frame at no height, then given to the frame. Measured in a frame
      // of its last height, a mail sized by the frame itself (height: 100% all the way up, or 110vh) grew with every
      // measurement: an ordinary newsletter by 24 px a frame without end, a crafted one to millions of px in seconds
      // (2026-11-20). At most FRAME_MAX tall; a longer mail scrolls inside its frame.
      const fit = () => {
        frame.style.height = "0px";
        frame.style.height = `${Math.min(Math.max(d.documentElement.scrollHeight, 60), FRAME_MAX)}px`;
      };
      for (const a of d.querySelectorAll("a[href]")) a.setAttribute("title", a.getAttribute("href") ?? "");
      d.addEventListener("click", onClick);
      observer = new ResizeObserver(fit);
      observer.observe(d.documentElement);
      fit();
    };
    frame.addEventListener("load", ready);
    return () => { frame.removeEventListener("load", ready); observer?.disconnect(); frame.contentDocument?.removeEventListener("click", onClick); };
  }, [doc]);
  return <iframe ref={ref} className="mailx-frame" title={title} sandbox="allow-same-origin" referrerPolicy="no-referrer" srcDoc={doc} />;
}

function Empty({ title, text }: { title: string; text: string }) {
  return <div className="mailx-empty"><Icon name="sun" /><b>{title}</b><span>{text}</span></div>;
}

/**
 * Text with the https addresses written in it as links (the address itself is the link's text), opened in the browser.
 * An address in another alphabet's letters has its real host beside it.
 */
function Linked({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => (
        <Fragment key={i}>
          {i > 0 && "\n"}
          <Parts parts={textParts(line)} />
        </Fragment>
      ))}
    </>
  );
}

/** A line's pieces from textParts (which checks every link): text, and links opened in the browser. */
function Parts({ parts }: { parts: TextPart[] }) {
  return (
    <>
      {parts.map((p, j) => p.href ? (
        <Fragment key={j}>
          <a href={p.href} target="_blank" rel="noopener noreferrer" onClick={(e) => { e.preventDefault(); void openExternal(p.href!); }}>{p.text}</a>
          {p.host && <span className="muted small"> ({p.host})</span>}
          {p.warnHost && <span className="warn small" title="This address uses letters from another alphabet that look like these."> ({p.warnHost})</span>}
        </Fragment>
      ) : <Fragment key={j}>{p.text}</Fragment>)}
    </>
  );
}

/** The screen's own icons, drawn here (no image or font is loaded for them). */
const ICONS: Record<string, string> = {
  menu: "M4 7h16M4 12h16M4 17h16",
  inbox: "M4 13l2.5-7h11L20 13v5H4zM4 13h4.5l1 2h5l1-2H20",
  clock: "M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16zM12 8v4l3 2",
  check: "m5 12.5 4.5 4.5L19 7.5",
  pin: "M9 4h6l-1 6 3 3H7l3-3zM12 13v7",
  sun: "M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  purchases: "M4 5h2l2 10h10l2-7H7M9 17.7a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6zM17 17.7a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6z",
  trips: "M10 18 8 21M3 13l7 1 6-8c1-1.3 3-1 3 .5L17 14l3 5-2 1-4-4-4 1z",
  social: "M9 6a3 3 0 1 0 0 6a3 3 0 1 0 0-6zM17 7.7a2.3 2.3 0 1 0 0 4.6a2.3 2.3 0 1 0 0-4.6zM3.5 19c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5M15 15c2.4-.4 4.6.8 5.5 3.5",
  promos: "M4 4h7l9 9-7 7-9-9zM8.5 7.2a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6z",
  bills: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3",
  pet: "M7 8.2a1.8 1.8 0 1 0 0 3.6a1.8 1.8 0 1 0 0-3.6zM11 4.7a1.8 1.8 0 1 0 0 3.6a1.8 1.8 0 1 0 0-3.6zM15.5 5.2a1.8 1.8 0 1 0 0 3.6a1.8 1.8 0 1 0 0-3.6zM18 9.2a1.8 1.8 0 1 0 0 3.6a1.8 1.8 0 1 0 0-3.6zM8.5 18c0-3 1.8-5.5 4-5.5s4 2.5 4 5.5c0 1.5-1.3 2-2.5 1.6l-1.5-.5-1.5.5C9.8 20 8.5 19.5 8.5 18z",
  jobs: "M5 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zM9 7V5h6v2M3 12h18",
  other: "M4 6h16M4 12h16M4 18h10",
};
function Icon({ name }: { name: string }) {
  return <svg className="mailx-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={ICONS[name] ?? ICONS.other} /></svg>;
}
