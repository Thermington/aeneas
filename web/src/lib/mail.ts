/**
 * The Mail screen's types and the small rules it shows mail by (hub CONTRACT.md, Mail). Mail is hostile input:
 * everything here is shown as text, never as HTML, and only https links the screen checks itself are opened.
 */

export interface MailAddress { name: string; address: string }
export type MailState = "inbox" | "snoozed" | "done";
/** One message in the list (GET /mail): no text, `preview` is its first words. `bundle`: the bundle the hub sorted it into. */
export interface MailSummary {
  id: string; at: string; from: MailAddress; reply_to?: string; subject: string; preview: string;
  automated: boolean; bundle: string | null; state: MailState; pinned: boolean; snooze_until?: string;
  /** The sender's verified brand logo (the list's `logos` by this domain). */
  logo_domain?: string;
  /** When it came back from a snooze: the Inbox lists it by this, not by when it arrived. */
  back_at?: string;
}

/** The time a mail is listed by in the Inbox: when it came back from a snooze, else when it arrived. */
export const shownAt = (m: Pick<MailSummary, "at" | "back_at">) => (m.back_at && m.back_at > m.at ? m.back_at : m.at);

/** A snooze choice: "Tomorrow" at 8 AM and so on. */
export interface SnoozeChoice { id: "later" | "tomorrow" | "weekend" | "nextweek"; label: string; at: Date }

/**
 * The snooze choices from `now`: Later today (3 hours on, on the hour; only before 9 PM), Tomorrow 8 AM, This weekend
 * (Saturday 9 AM; next Saturday when it is the weekend), Next week (Monday 8 AM).
 */
export function snoozeChoices(now: Date = new Date()): SnoozeChoice[] {
  const at = (days: number, h: number) => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(h, 0, 0, 0); return d; };
  const out: SnoozeChoice[] = [];
  const later = new Date(now);
  later.setHours(now.getHours() + 3, 0, 0, 0);
  if (later.getDate() === now.getDate() && later.getHours() < 21) out.push({ id: "later", label: "Later today", at: later });
  out.push({ id: "tomorrow", label: "Tomorrow", at: at(1, 8) });
  const day = now.getDay();
  out.push({ id: "weekend", label: day === 6 || day === 0 ? "Next weekend" : "This weekend", at: at((6 - day + 7) % 7 || 7, 9) });
  out.push({ id: "nextweek", label: "Next week", at: at((1 - day + 7) % 7 || 7, 8) });
  return out;
}
/** An automated message's button: the line `text` shows as a link to `url` (kept for highlights; the hub sends none yet). */
export interface MailButton { text: string; url: string }
/** One message with its whole text (GET /mail/messages/:id). */
/**
 * One message whole. `html`: the mail as sent, cleaned by the hub into a page that loads nothing (its pictures written
 * in), or null when it has none; `pictures_pending`: the hub is still fetching its web pictures.
 */
export interface MailMessage extends MailSummary { text: string; links?: MailButton[]; html?: string | null; pictures_pending?: boolean }

/** A link from inside a mail's page that the app opens: http, https or mailto, nothing else. */
export function frameLink(href: string | null): string | null {
  const h = (href ?? "").trim();
  if (/^mailto:[^\s<>"]{1,500}$/i.test(h)) return h;
  try {
    const u = new URL(h);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname ? u.toString() : null;
  } catch { return null; }
}
/** `more`: the last refresh left new mail for the next one (a big Inbox comes in batches). */
export interface MailMailbox { email: string; last_refresh: string | null; last_error: string | null; more: boolean }
/** What Done or Undo did: the mails moved, how many were not, and the hub's words when some were not. */
export interface MailMoved { moved: string[]; failed: number; error?: string }

/** `logos`: the verified brand logos the messages use, by domain (a message's `logo_domain`). */
export interface MailList { messages: MailSummary[]; mailboxes: MailMailbox[]; logos?: Record<string, string> }
export type MailRefresh = { mailboxes: ({ email: string; kept: number; gone: number; more: boolean } | { email: string; error: string })[] };

/** How a person is named in the list: their name, else their address. */
export const personLabel = (p: MailAddress) => p.name.trim() || p.address;

// ---------------------------------------------------------------------------------------------------------------------
// Bundles

/**
 * A bundle: a colored group of one kind of mail. The always-there ones, then the ones tied to a module, shown only while
 * that module is on (`module`), with a link to its screen. `Other` takes automated mail nothing stronger claimed.
 */
export interface Bundle { id: string; name: string; module?: string; moduleName?: string; screen?: string }
export const BUNDLES: Bundle[] = [
  { id: "purchases", name: "Purchases" },
  { id: "trips", name: "Trips" },
  { id: "social", name: "Social" },
  { id: "promos", name: "Promos" },
  { id: "bills", name: "Bills", module: "renewals", moduleName: "Renewals and bills", screen: "/renewals" },
  { id: "pet", name: "Pet", module: "pet", moduleName: "Pet", screen: "/pet" },
  { id: "jobs", name: "Jobs", module: "jobs", moduleName: "Job search", screen: "/lists/jobs" },
  { id: "other", name: "Other" },
];

/** The bundles shown: the always-there ones, and a module's only while it is on. */
export const shownBundles = (on: (module: string) => boolean) => BUNDLES.filter((b) => !b.module || on(b.module));

/** The bundle a message shows in, or null: an unknown bundle, or one whose module is off, shows the mail on its own. */
export function bundleOf(m: Pick<MailSummary, "bundle">, shown: Bundle[]): Bundle | null {
  return (m.bundle && shown.find((b) => b.id === m.bundle)) || null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The list

/** What the screen shows: the Inbox, Snoozed, Done, or one bundle (`b:<id>`). */
export type MailView = "inbox" | "snoozed" | "done" | `b:${string}`;

const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const daysBefore = (iso: string, now: Date) => Math.round((startOfDay(now).getTime() - startOfDay(new Date(iso)).getTime()) / 86_400_000);

/** The heading a message is under: Today, Yesterday, This week, This month, then the month ("October 2026"). */
export function dayGroup(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "Earlier";
  const n = daysBefore(iso, now);
  if (n <= 0) return "Today";
  if (n === 1) return "Yesterday";
  if (n < 7) return "This week";
  if (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) return "This month";
  return d.toLocaleDateString([], { month: "long", year: "numeric" });
}

/** The time beside a message: the hour today, the weekday this week, else the date. */
export function whenLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const n = daysBefore(iso, now);
  if (n <= 0) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (n < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}

/** The letter in a sender's circle: the first letter or digit of their name or address. */
export const initial = (from: MailAddress) => (/[\p{L}\p{N}]/u.exec(personLabel(from))?.[0] ?? "?").toUpperCase();
/**
 * The letters in a sender's circle, as Apple Mail draws them: the first letters of the first and last words of their
 * name ("Alumni Relations Team" gives AT), or one letter when the name is one word or only an address.
 */
export function initials(from: MailAddress): string {
  const first = (w: string) => /[\p{L}\p{N}]/u.exec(w)?.[0] ?? "";
  const words = from.name.trim().split(/\s+/).map(first).filter(Boolean);
  return words.length >= 2 ? `${words[0]}${words[words.length - 1]}`.toUpperCase() : initial(from);
}

/** A verified brand logo as the hub sends it (a data: SVG, shown only as a picture), or null for anything else. */
export function logoSrc(v: string | undefined): string | null {
  return v && v.length < 200_000 && /^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/.test(v) ? v : null;
}

/** Whether a message has every word of a search, in its sender, subject or first words (case aside). */
export function matches(m: MailSummary, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${m.from.name} ${m.from.address} ${m.subject} ${m.preview}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** A row of the Inbox: one message, or a bundle with its messages (newest first). */
export type InboxRow = { kind: "mail"; mail: MailSummary } | { kind: "bundle"; bundle: Bundle; mails: MailSummary[] };
export interface InboxSection { title: string; rows: InboxRow[] }

/**
 * The Inbox as the screen lists it: newest first, under day headings. A bundle is one row, where its newest message is
 * in each day; pinned mail always stands on its own. With `pinnedOnly`, only pinned mail, none bundled.
 */
export function inboxSections(messages: MailSummary[], shown: Bundle[], opts: { pinnedOnly?: boolean; now?: Date } = {}): InboxSection[] {
  const now = opts.now ?? new Date();
  const ms = messages.filter((m) => m.state === "inbox" && (!opts.pinnedOnly || m.pinned)).sort((a, b) => shownAt(b).localeCompare(shownAt(a)));
  const sections: InboxSection[] = [];
  for (const m of ms) {
    const title = dayGroup(shownAt(m), now);
    let s = sections[sections.length - 1];
    if (!s || s.title !== title) { s = { title, rows: [] }; sections.push(s); }
    const b = !m.pinned && !opts.pinnedOnly ? bundleOf(m, shown) : null;
    if (!b) { s.rows.push({ kind: "mail", mail: m }); continue; }
    const row = s.rows.find((r) => r.kind === "bundle" && r.bundle.id === b.id);
    if (row && row.kind === "bundle") row.mails.push(m);
    else s.rows.push({ kind: "bundle", bundle: b, mails: [m] });
  }
  return sections;
}

/** The messages a view lists flat (Snoozed soonest first, Done and a bundle newest first). */
export function viewMessages(messages: MailSummary[], view: MailView, shown: Bundle[]): MailSummary[] {
  if (view === "snoozed") return messages.filter((m) => m.state === "snoozed").sort((a, b) => (a.snooze_until ?? "").localeCompare(b.snooze_until ?? ""));
  if (view === "done") return messages.filter((m) => m.state === "done").sort((a, b) => b.at.localeCompare(a.at));
  if (view.startsWith("b:")) return messages.filter((m) => m.state === "inbox" && bundleOf(m, shown)?.id === view.slice(2)).sort((a, b) => shownAt(b).localeCompare(shownAt(a)));
  return messages.filter((m) => m.state === "inbox").sort((a, b) => shownAt(b).localeCompare(shownAt(a)));
}

/** "Purchases: Northwind, Larkspur Books": who a bundle's mail is from, each name once. */
export const sendersLine = (mails: MailSummary[]) => [...new Set(mails.map((m) => personLabel(m.from)))].join(", ");

// ---------------------------------------------------------------------------------------------------------------------
// Showing a message safely

/**
 * Where a reply would go, when that is not the sender: for the reply view (not shown in the list, since
 * Reply-To only matters when replying). Phishing mail often uses it to collect answers at another address.
 */
export function replyToWarning(m: Pick<MailMessage, "reply_to" | "from">): string | null {
  if (!m.reply_to || m.reply_to.toLowerCase() === m.from.address.toLowerCase()) return null;
  return `Replies go to ${m.reply_to}, not to ${m.from.address}.`;
}

/** Whether the sender's shown name looks like an address other than the real one ("support@bank.example" <x@evil>). */
export function nameHidesAddress(from: MailAddress): boolean {
  // Letters, digits and the usual address marks only, so brackets around it ("Alex (alex@example.com)") are not part of it.
  const inName = /[\w.+'-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,}/i.exec(from.name)?.[0];
  return !!inName && inName.toLowerCase() !== from.address.toLowerCase();
}

/** A button's link as the screen may open it: https only, a host, no user name; with the host to show beside it. */
export function httpsLink(url: string): { href: string; host: string } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return null;
    return { href: u.toString(), host: u.hostname };
  } catch { return null; }
}

/**
 * A message's lines: a line that is one of the message's buttons with its `link`; any other line in `parts`, where a
 * link's label inside it ("take the quiz HERE and…", its first time in the line) is a link with its host beside it,
 * and web addresses written in the rest are links too (textParts). A label that names a site ("Track at fedex.com")
 * gets no link unless the link goes to that site: the label must not say one place and go another.
 */
export function messageLines(m: Pick<MailMessage, "text" | "links">): { text: string; link?: { href: string; host: string }; parts?: TextPart[] }[] {
  const byText = new Map<string, { href: string; host: string }>();
  for (const b of m.links ?? []) {
    const link = httpsLink(b.url);
    const named = /\b[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}\b/i.exec(b.text)?.[0].toLowerCase();
    if (!link || b.text.trim().length < 2 || byText.has(b.text) || (named && link.host !== named && !link.host.endsWith(`.${named}`))) continue;
    byText.set(b.text, link);
  }
  return m.text.split("\n").map((text) => {
    const link = byText.get(text.trim());
    return link ? { text, link } : { text, parts: labelParts(text, byText) };
  });
}

/** A line with the links' labels in it as links (each label's first time, longest labels first), the rest by textParts. */
function labelParts(line: string, links: Map<string, { href: string; host: string }>): TextPart[] {
  let parts: TextPart[] = [{ text: line }];
  for (const [label, link] of [...links].sort((a, b) => b[0].length - a[0].length)) {
    const i = parts.findIndex((p) => !p.href && p.text.includes(label));
    if (i < 0) continue;
    const t = parts[i].text;
    const at = t.indexOf(label);
    const split: TextPart[] = [{ text: t.slice(0, at) }, { text: label, href: link.href, host: link.host }, { text: t.slice(at + label.length) }];
    parts = [...parts.slice(0, i), ...split.filter((p) => p.text), ...parts.slice(i + 1)];
  }
  return parts.flatMap((p) => (p.href ? [p] : textParts(p.text)));
}

/**
 * A piece of a line of mail text: plain text, or a link. `host` is shown beside a link whose text is a label (not the
 * address itself); `warnHost` beside an address whose host is written in another alphabet's letters.
 */
export interface TextPart { text: string; href?: string; host?: string; warnHost?: string }

/**
 * A line of mail text in pieces, its web addresses as links: `https://…`, and `www.…` (opened as https). The link's
 * text is the address itself, so a mail cannot show one place and go to another. Anything else (`http:`, `javascript:`,
 * `mailto:`, a user name in the address) stays plain text. A trailing period, comma or bracket ends the address. When
 * the host is written in another alphabet (`xn--…` once read), `warnHost` is that real host, to show beside it.
 */
export function textParts(line: string): TextPart[] {
  const out: TextPart[] = [];
  const plain = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && !last.href) last.text += t;
    else out.push({ text: t });
  };
  let at = 0;
  for (const m of line.matchAll(/(https:\/\/|www\.)[^\s<>"]+/gi)) {
    const start = m.index ?? 0;
    // Not the middle of another word or address: "http://www.…", "me@www.…", "awww.…".
    if (start > 0 && /[\w.@/:-]/.test(line[start - 1])) continue;
    let url = m[0];
    // Punctuation after an address is the sentence's; a closing bracket only when the address has no opening one.
    for (;;) {
      const c = url[url.length - 1];
      if (/[.,;:!?'"’”]/.test(c) || (/[)\]}]/.test(c) && (url.match(/[(\[{]/g)?.length ?? 0) < (url.match(/[)\]}]/g)?.length ?? 0))) url = url.slice(0, -1);
      else break;
    }
    const link = httpsLink(/^www\./i.test(url) ? `https://${url}` : url);
    if (!link || !link.host.includes(".")) continue;
    plain(line.slice(at, start));
    out.push({ text: url, href: link.href, ...(link.host.split(".").some((p) => p.startsWith("xn--")) ? { warnHost: link.host } : {}) });
    at = start + url.length;
  }
  plain(line.slice(at));
  return out.length ? out : [{ text: line }];
}

