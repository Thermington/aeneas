/**
 * The Mail screen's types and the small rules it shows mail by (hub CONTRACT.md, Mail conversations). Mail is hostile
 * input: everything here is shown as text, never as HTML, and only links the hub makes itself are opened.
 */

export interface MailAddress { name: string; address: string }
/** `with`: the other people, who wrote to you and who you wrote to. `last_mine`: the newest message is yours. */
export interface MailConversationSummary { id: string; subject: string; with: MailAddress[]; last_at: string; count: number; preview: string; last_mine?: boolean }
export interface MailMailbox { email: string; last_refresh: string | null; last_error: string | null }
export interface MailList { conversations: MailConversationSummary[]; keep_days: number; choices: number[]; mailboxes: MailMailbox[] }
/** An automated message's button: the line `text` shows as a link to `url`. */
export interface MailButton { text: string; url: string }
/** `to`: who you wrote to, on your own messages. `automated`: a system sent it (a notice, a newsletter). `links`: its buttons. */
export interface MailMessage { id: string; at: string; mine: boolean; automated?: boolean; links?: MailButton[]; from: MailAddress; to?: MailAddress[]; reply_to?: string; subject: string; text: string; cleaned_by: string; link: string }
export interface MailConversation { id: string; subject: string; with?: MailAddress[]; messages: MailMessage[] }
export interface MailOriginal { id: string; at: string; from: MailAddress; reply_to: string | null; subject: string; text: string }
export type MailRefresh = { mailboxes: ({ email: string; listed: number; kept: number } | { email: string; error: string })[] };

/** The screen's route: `#/mail`, or `#/mail?c=<conversation id>` with one open. */
export const mailPath = (id?: string | null) => (id ? `/mail?c=${encodeURIComponent(id)}` : "/mail");

/** How a person is named in the list: their name, else their address. */
export const personLabel = (p: MailAddress) => p.name.trim() || p.address;

/** Who a conversation is with: "Alex", "Alex and Sam", "Alex, Sam and 2 more"; "You" for mail only to yourself. */
export function withLabel(c: Pick<MailConversationSummary, "with">): string {
  const names = c.with.map(personLabel);
  if (!names.length) return "You";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/**
 * What a message's text is, when it is not simply the sender's message cleaned: a short label for the line under it
 * (beside Show original) and the longer explanation for its tooltip. Null for a person's mail cleaned by the rules.
 */
export function cleanedLabel(m: Pick<MailMessage, "cleaned_by" | "automated">): { label: string; title: string } | null {
  if (m.cleaned_by === "summary") return { label: "Summary", title: "Lines your model picked from an automated email, as the sender wrote them." };
  if (m.cleaned_by === "key-lines") return { label: "Key lines", title: "Lines the hub picked from an automated email, as the sender wrote them." };
  if (m.cleaned_by === "model") return { label: "Shortened", title: "Your model cut a signature off the end." };
  if (m.automated) return { label: "Automated", title: "An automated email, its links and footer left out." };
  return null;
}

/** The list's preview: "You: " before it when the newest message is yours, so a one-message conversation says which way it went. */
export const previewLine = (c: Pick<MailConversationSummary, "preview" | "last_mine">) => (c.last_mine ? `You: ${c.preview}` : c.preview);

/** "Jordan Lee <jordan@work.example>, sam@example.com": names with their real addresses. */
export const peopleLine = (people: MailAddress[]) => people.map((p) => (p.name.trim() ? `${p.name.trim()} <${p.address}>` : p.address)).join(", ");

/** Above your own message: "To Jordan Lee and Sam", or null when who it went to is not known. */
export function toLine(to: MailAddress[] | undefined): string | null {
  return to?.length ? `To ${withLabel({ with: to })}` : null;
}

/**
 * Said under a message whose replies would go elsewhere than its sender. Phishing mail often uses this, and the
 * cleaned text has lost what usually gives it away, so the screen says it plainly.
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

/**
 * The link to open a message in Apple Mail, or null. Only the two kinds the hub makes are allowed (a `message://`
 * link, or iCloud Mail on the web), so nothing in a mail can turn into a link to somewhere else.
 */
export function mailLink(link: string | undefined, ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): string | null {
  if (!link) return null;
  // message:// opens Apple Mail, which exists only on a Mac, iPhone or iPad; elsewhere the link would do nothing.
  if (/^message:\/\/%3C[^\s]+%3E$/i.test(link)) return /Macintosh|iPhone|iPad/.test(ua) ? link : null;
  if (link === "https://www.icloud.com/mail/") return link;
  return null;
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
 * A message's lines, each with its link when it is one of the message's buttons. A label that names a site
 * ("Track at fedex.com") gets no link unless the link goes to that site: the label must not say one place and go another.
 */
export function messageLines(m: Pick<MailMessage, "text" | "links">): { text: string; link?: { href: string; host: string } }[] {
  const byText = new Map<string, { href: string; host: string }>();
  for (const b of m.links ?? []) {
    const link = httpsLink(b.url);
    const named = /\b[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}\b/i.exec(b.text)?.[0].toLowerCase();
    if (!link || byText.has(b.text) || (named && link.host !== named && !link.host.endsWith(`.${named}`))) continue;
    byText.set(b.text, link);
  }
  return m.text.split("\n").map((text) => {
    const link = byText.get(text.trim());
    return link ? { text, link } : { text };
  });
}

/** "Mon, Nov 17": a day heading between messages, shown when the day changes. */
export function dayHeading(iso: string, prevIso: string | null): string | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  if (prevIso) {
    const p = new Date(prevIso);
    if (p.toDateString() === d.toDateString()) return null;
  }
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

/** "7 days", "1 year": how long mail text is kept. */
export const keepLabel = (days: number) => (days === 365 ? "1 year" : `${days} days`);
