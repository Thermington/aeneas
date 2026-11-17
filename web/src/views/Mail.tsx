import { Fragment, useEffect, useState } from "react";
import { openExternal } from "../tauri/bridge";
import { engine } from "../sync/engine";
import { usePoll } from "../lib/usePoll";
import { useMediaQuery } from "../lib/useMediaQuery";
import { plainError } from "../lib/errors";
import { fmtDate, fmtDateTime, fmtTime } from "../lib/time";
import {
  cleanedNote,
  dayHeading,
  keepLabel,
  mailLink,
  mailPath,
  messageLines,
  nameHidesAddress,
  peopleLine,
  personLabel,
  previewLine,
  replyToWarning,
  toLine,
  withLabel,
  type MailConversation,
  type MailList,
  type MailMessage,
  type MailOriginal,
} from "../lib/mail";

/**
 * Mail (module mail_chat): iCloud mail as conversations, like a messaging app. The list of conversations on the left,
 * the open one on the right (on a phone they take turns), each message as a bubble with only its body: theirs on the
 * left, yours on the right. Read-only. Mail is shown as plain text only, never as HTML, with the sender's real address
 * on every message, a warning when replies would go elsewhere, and the whole message one tap away.
 */
export function Mail({ id }: { id: string | null }) {
  const narrow = useMediaQuery("(max-width: 767px)");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  // Search a quarter second after the last key, not on every key.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const list = usePoll((c) => c.mailConversations(query), 60_000);
  useEffect(() => { void list.reload(); }, [query]); // eslint-disable-line react-hooks/exhaustive-deps
  const showSide = !narrow || !id;

  return (
    <div className={id ? "split mail" : "split mail front"}>
      {showSide && (
        <div className="side mail-side">
          <h1>Mail</h1>
          <input type="search" placeholder="Search mail" aria-label="Search mail" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 8 }} />
          <Conversations list={list.data} error={list.error} openId={id} searching={!!query} />
          {list.data && <Footer data={list.data} reload={list.reload} />}
        </div>
      )}
      {(id || !narrow) && (
        <div className="mail-main">
          {id ? (
            <>
              {narrow && <a href={`#${mailPath()}`} className="wiki-back">{"‹"} Mail</a>}
              <Thread key={id} id={id} />
            </>
          ) : (
            list.data?.conversations.length ? <div className="empty">Pick a conversation.</div> : null
          )}
        </div>
      )}
    </div>
  );
}

function Conversations({ list, error, openId, searching }: { list: MailList | null; error: string | null; openId: string | null; searching: boolean }) {
  if (!list && error) return <div className="error">{error}</div>;
  if (!list) return <div className="muted small">Loading</div>;
  if (!list.mailboxes.length) {
    return <div className="empty">Link an iCloud mailbox in <a href="#/settings/connections">Settings, Connections</a> to see your mail here.</div>;
  }
  if (!list.conversations.length) {
    return <div className="muted small">{searching ? "No conversation has all of those words." : `No mail from the last ${keepLabel(list.keep_days)} yet. Refresh fetches it.`}</div>;
  }
  return (
    <nav className="list mail-list" aria-label="Conversations">
      {list.conversations.map((c) => (
        <a key={c.id} href={`#${mailPath(c.id)}`} className={`item mail-item${c.id === openId ? " active" : ""}`} aria-current={c.id === openId ? "page" : undefined}>
          <span className="body">
            <span className="row between" style={{ flexWrap: "nowrap" }}>
              <span className="t mail-who">{withLabel(c)}</span>
              <span className="meta">{fmtDate(c.last_at)}</span>
            </span>
            {/* One other person: their real address too, so a name alone never stands for who it is. */}
            {c.with.length === 1 && c.with[0].name.trim() && <span className="mail-address">{c.with[0].address}</span>}
            <span className="mail-subject">{c.subject || "(no subject)"}{c.count > 1 ? ` (${c.count})` : ""}</span>
            <span className="snippet">{previewLine(c)}</span>
          </span>
        </a>
      ))}
    </nav>
  );
}

/** Refresh, how long mail is kept, and each mailbox's last refresh or problem. */
function Footer({ data, reload }: { data: MailList; reload: () => Promise<void> }) {
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
  const keep = async (days: number) => {
    if (!client || days === data.keep_days) return;
    if (days < data.keep_days && !confirm(`Keep mail for ${keepLabel(days)}? Mail older than that is deleted from the hub now. It stays in iCloud.`)) return;
    try {
      await client.setMailKeepDays(days);
      await reload();
    } catch (e) {
      setMsg({ ok: false, text: plainError(e) });
    }
  };
  return (
    <div className="col mail-footer">
      <div className="row">
        <button type="button" disabled={busy || !client} onClick={() => void refresh()}>{busy ? "Refreshing" : "Refresh"}</button>
        {msg && <span className={msg.ok ? "ok" : "error"}>{msg.text}</span>}
      </div>
      {data.mailboxes.map((m) => (
        <div key={m.email} className="small">
          <span className="muted">{m.email}: {m.last_refresh ? `refreshed ${fmtDateTime(m.last_refresh)}` : "not refreshed yet"}</span>
          {m.last_error && <div className="error">{m.last_error}</div>}
        </div>
      ))}
      <label className="row small muted">
        Keep mail on the hub for
        <select value={data.keep_days} onChange={(e) => void keep(Number(e.target.value))} aria-label="How long mail is kept on the hub">
          {data.choices.map((d) => <option key={d} value={d}>{keepLabel(d)}</option>)}
        </select>
      </label>
      <div className="muted small">Only each message's text is kept, without greetings, signatures or quoted mail, and only for that long. Older mail stays in iCloud: open it in Apple Mail.</div>
    </div>
  );
}

function Thread({ id }: { id: string }) {
  const conv = usePoll<MailConversation>((c) => c.mailConversation(id), 60_000);
  if (conv.unavailable) return <div className="empty">This conversation is no longer kept on the hub. It may be older than the time mail is kept.</div>;
  if (!conv.data && conv.error) return <div className="error">{conv.error}</div>;
  if (!conv.data) return <div className="muted small">Loading</div>;
  const msgs = conv.data.messages;
  return (
    <div className="col mail-thread">
      <h2 className="mail-thread-subject">{conv.data.subject || "(no subject)"}</h2>
      {!!conv.data.with?.length && <div className="muted small mail-with">With {peopleLine(conv.data.with)}</div>}
      {msgs.map((m, i) => {
        const day = dayHeading(m.at, i ? msgs[i - 1].at : null);
        return (
          <div key={m.id} className="col" style={{ gap: 6 }}>
            {day && <div className="mail-day muted small">{day}</div>}
            <Bubble m={m} />
          </div>
        );
      })}
    </div>
  );
}

function Bubble({ m }: { m: MailMessage }) {
  const [original, setOriginal] = useState<MailOriginal | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const warning = replyToWarning(m);
  const link = mailLink(m.link);
  const toggle = async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (original || !engine.client) return;
    setBusy(true);
    setErr("");
    try { setOriginal(await engine.client.mailOriginal(m.id)); } catch (e) { setErr(plainError(e)); } finally { setBusy(false); }
  };
  return (
    <div className={`mail-row${m.mine ? " mine" : ""}`}>
      <div className={`msg mail-bubble${m.mine ? " user" : ""}`}>
        {m.mine && toLine(m.to) && <div className="mail-from small muted">{toLine(m.to)}</div>}
        {!m.mine && (
          <div className="mail-from small">
            <strong>{personLabel(m.from)}</strong>{" "}
            {/* The real address, always: a display name can say anything. */}
            <span className="muted">{m.from.address}</span>
          </div>
        )}
        {nameHidesAddress(m.from) && <div className="warn small">The sender's name shows a different address than the one it came from.</div>}
        {warning && <div className="warn small" role="note">{warning}</div>}
        {cleanedNote(m) && <div className="muted small mail-note">{cleanedNote(m)}</div>}
        {/* Plain text in text nodes: React escapes it, and nothing in a mail is ever read as HTML. A button line is a link
            with its real host beside it, opened in the browser. */}
        <div className="mail-text">
          {messageLines(m).map((line, i) => (
            <Fragment key={i}>
              {i > 0 && "\n"}
              {line.link ? (
                <>
                  <a href={line.link.href} target="_blank" rel="noopener noreferrer" onClick={(e) => { e.preventDefault(); void openExternal(line.link!.href); }}>{line.text}</a>
                  <span className="muted small"> ({line.link.host})</span>
                </>
              ) : line.text}
            </Fragment>
          ))}
        </div>
        {open && (
          <div className="mail-original">
            {busy && <div className="muted small">Fetching the whole message from iCloud</div>}
            {err && <div className="error">{err}</div>}
            {original && <pre className="mail-original-text">{original.text}</pre>}
          </div>
        )}
        <div className="meta row" style={{ gap: 10 }}>
          <span>{fmtTime(m.at)}</span>
          {m.cleaned_by === "model" && <span title="Your hub's model shortened this message">shortened by your model</span>}
          <button type="button" className="ghost small" onClick={() => void toggle()} aria-expanded={open}>{open ? "Hide original" : "Show original"}</button>
          {link && <a href={link} className="small">Open in Apple Mail</a>}
        </div>
      </div>
    </div>
  );
}
