/**
 * The body of an email and nothing else, for the Mail screen (CONTRACT.md, Mail conversations): the quoted history,
 * the signature, "Sent from my iPhone", the greeting at the top and the sign-off at the end are taken off, in code,
 * with rules anyone can read. What the rules cannot settle (an end that still looks like a signature) is marked
 * `unsure` for the local model, whose answer is kept only when it is a piece of this text (`isPieceOf`).
 *
 * Mail is hostile input: every rule works on one line at a time, with patterns whose length is bounded, so a crafted
 * message cannot make a pattern take long (no regular expression here can backtrack across a whole message).
 */

export interface Cleaned {
  /** The body, never empty for a message that had any text. */
  text: string;
  /** The end still looks like a signature: the local model may shorten it. */
  unsure: boolean;
}

/** Lines longer than this are never a greeting, sign-off or marker, so no pattern is tried on them. */
const SHORT = 200;

// ---------------------------------------------------------------------------------------------------------------------
// Where the quoted history starts

/**
 * The rules' version. Kept with each hub's mail: when it changes, kept mail is fetched again and cleaned by the new
 * rules (the original is not kept, so it cannot be cleaned again in place).
 */
export const CLEAN_VERSION = 2;

/** `On Tue, 4 Nov 2026 at 09:12, Alex <alex@example.com> wrote:` (Apple Mail, Gmail and most others). */
const ON_WROTE = /^on\b.{0,240}\bwrote:$/i;
/** Outlook and older clients. */
const ORIGINAL = /^-{2,}\s*original message\s*-{2,}$/i;
const FORWARD = /^(-{2,}\s*forwarded message\s*-{2,}|begin forwarded message:|-{2,}\s*forwarded by .{0,80}-{2,})$/i;
/** Outlook's line of underscores above the quoted message. */
const UNDERSCORES = /^_{10,}$/;
/** A header line of a quoted or forwarded message, with Outlook's bold stars (`*From:*`) allowed. */
const HEADER = /^\**(from|sent|date|to|cc|subject|reply-to)\**:\**\s/i;
const HEADER_FROM = /^\**from\**:\**\s/i;
const HEADER_NEXT = /^\**(sent|date|to|subject)\**:\**\s/i;

/** Whether the line at `i` starts quoted history: a marker, `On … wrote:` (also wrapped over up to three lines), a header block. */
function startsQuote(lines: string[], i: number): boolean {
  const l = lines[i];
  if (l.length > SHORT) return false;
  if (ON_WROTE.test(l) || ORIGINAL.test(l) || FORWARD.test(l) || UNDERSCORES.test(l)) return true;
  // "On ... Alex <alex@" / "example.com> wrote:": some clients wrap the line, Gmail up to three times.
  if (/^on\b/i.test(l)) {
    let joined = l;
    for (let k = 1; k <= 2 && i + k < lines.length && lines[i + k].length <= SHORT; k++) {
      joined = `${joined} ${lines[i + k]}`;
      if (ON_WROTE.test(joined)) return true;
    }
  }
  // An Outlook block: From: then Sent:, Date:, To: or Subject: within the next two lines.
  return HEADER_FROM.test(l) && lines.slice(i + 1, i + 3).some((n) => HEADER_NEXT.test(n));
}

/** The index of the first line of quoted history, or -1. */
function quoteStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) if (startsQuote(lines, i)) return i;
  // Quoted lines at the end with nothing of the sender's after them.
  let end = lines.length;
  while (end > 0 && (lines[end - 1] === "" || lines[end - 1].startsWith(">"))) end--;
  return end < lines.length && lines.slice(end).some((l) => l.startsWith(">")) ? end : -1;
}

// ---------------------------------------------------------------------------------------------------------------------
// Signature, device lines

/** The signature marker `-- ` (trailing space trimmed already, so `--` too). */
const SIG_MARK = /^--$/;
/** "Sent from my iPhone", "Get Outlook for iOS<link>": what a mail app adds, a link in <> or [] after it allowed. */
const DEVICE = /^(sent from my \w[\w ]{0,30}|sent (from|via) (mail|outlook|the \w+ \w+|my \w+)( for \w+)?|get outlook for \w+|sent from yahoo mail.{0,30}|sent with proton mail.{0,30}|sent from samsung.{0,40}|sent from gmail.{0,30})\.?\s*(<[^>\s]{1,200}>|\[[^\]\s]{1,200}\])?$/i;

/**
 * Where a legal notice or disclaimer starts at the end of a mail: it and everything after it go. Never the first line,
 * so a mail that is only such a notice still shows.
 */
const FOOTER = /^(\**\s*)?(confidentiality notice|confidential(ity)?:|disclaimer:|privileged (and|&) confidential|this (e-?mail|message|communication)( and any (attachments?|files?)( to it)?)?( transmitted with it)? (is|are|may (be|contain)|contains?|is intended) .{0,40}(confidential|intended|privileged)|the information (contained )?in this (e-?mail|message|communication)|if you (are not|have received this) .{0,40}(intended recipient|in error))/i;

// ---------------------------------------------------------------------------------------------------------------------
// Greeting and sign-off

/** Words that end in a comma at the top of a mail without being a name. */
const NOT_NAMES = new Set(["yes", "no", "ok", "okay", "sure", "sorry", "also", "so", "well", "fyi", "update", "note", "ps", "and", "but", "actually", "honestly", "anyway", "first", "great", "perfect", "agreed", "right", "oh", "ah", "hmm", "yep", "nope", "absolutely", "definitely", "unfortunately", "apologies"]);

const GREETING_WORDS = /^(hi|hello|hey|hiya|heya|dear|greetings|morning|afternoon|evening|good (morning|afternoon|evening|day))\b/i;

/** `Hi Robin,`  `Hello all`  `Dear Mr. Smith,`  `Hey!`  `Robin,`: a line that only greets. */
export function isGreeting(line: string): boolean {
  if (line.length > 60) return false;
  const m = GREETING_WORDS.exec(line);
  // A lone name and a comma, but not a word that starts a sentence ("Sure, ..." wrapped) or a sign-off.
  if (!m) return /^[A-Z][\w'’.-]{0,30}( [A-Z][\w'’.-]{0,30})?,$/.test(line) && !NOT_NAMES.has(line.slice(0, -1).toLowerCase()) && !isSignOff(line);
  const rest = line.slice(m[0].length).trim();
  // A comma, or "!", ":", "." or a dash ("Hi Robin -").
  const ended = /[,!:.\-–—]$/.test(rest) || rest === "";
  const words = rest.replace(/[,!:.\-–—]$/, "").trim();
  if (/[,!:?;]/.test(words)) return false; // something more follows the greeting: "Hi Sam, can you…"
  const n = words ? words.split(/\s+/).length : 0;
  // With a comma or the like after it, up to four words of names; without, at most two ("Hello all", "Hi Robin").
  return ended ? n <= 4 : n <= 2;
}

/**
 * Sign-off phrases, matched longest first: in a pattern `thanks|thanks and regards`, the first that fits wins, so
 * "Thanks and regards," read as "Thanks" followed by a sentence.
 */
const SIGN_OFF_PHRASES = [
  "thanks", "thank you", "thanks again", "thanks so much", "thank you so much", "thanks a lot", "thanks in advance", "thank you in advance",
  "thank you for your time", "many thanks", "thx", "ty", "best", "best regards", "best wishes", "all the best", "kind regards", "kindest regards",
  "warm regards", "warmest regards", "warm wishes", "regards", "thanks and regards", "thanks & regards", "cheers", "sincerely", "sincerely yours",
  "yours", "yours truly", "yours sincerely", "yours faithfully", "respectfully yours", "take care", "talk soon", "speak soon", "talk to you soon",
  "see you soon", "love", "warmly", "respectfully", "cordially", "with thanks", "v/r",
  ...["great", "good", "nice", "lovely"].flatMap((a) => ["day", "weekend", "week", "evening", "one"].map((b) => `have a ${a} ${b}`)),
];
const SIGN_OFF = new RegExp(`^(${[...SIGN_OFF_PHRASES].sort((a, b) => b.length - a.length).map((p) => p.replace(/[/&]/g, "\\$&")).join("|")}|xo+)(?![\\w])`, "i");

/** `Thanks,`  `Best, Alex`  `Cheers - Sam`  `Kind regards`: a line that only signs off (with a name at most). */
export function isSignOff(line: string): boolean {
  if (line.length > 50) return false;
  const m = SIGN_OFF.exec(line);
  if (!m) return false;
  const rest = line.slice(m[0].length).trim();
  if (rest === "" || /^[,!.]+$/.test(rest)) return true;
  // A name after a comma or a dash: "Best, Alex", "Cheers - Sam". "Thanks for the update" is a sentence, not this.
  const named = /^[,!.\-–—]\s*([A-Z][\w'’.-]{0,30}( [A-Z][\w'’.-]{0,30})?)\.?$/.exec(rest);
  return !!named;
}

// ---------------------------------------------------------------------------------------------------------------------
// A company's footer, and what automated mail adds around its message

/** A line of only a link: `https://…`, `<https://…>`, `( https://… )`. */
const URL_ONLY = /^[(<[]?\s*https?:\/\/\S{1,2000}\s*[)>\]]?$/i;
/** A line that is a sure sign of a footer: a separator, copyright, unsubscribe or privacy links, who sent it. */
const FOOTER_MARK = /^([-_=*~]{5,}|(©|\(c\)|copyright\b).{0,300}|.{0,200}\ball rights reserved\b.{0,200}|.{0,100}\bunsubscribe\b.{0,200}|(privacy (policy|notice|statement)|terms (of (use|service)|and conditions)|manage (your )?(preferences|subscriptions?|email settings))\b.{0,200}|this (e-?mail|message) was sent (to|by)\b.{0,200}|you('re| are) receiving this\b.{0,200}|please do not reply\b.{0,300})$/i;
/** A line that fits in a footer: blank, a link, a short label or address line, or a footer mark. */
const footerLine = (l: string) => l === "" || URL_ONLY.test(l) || (l.length <= 60 && l.split(/\s+/).length <= 8 && !/[?!]$/.test(l) && !(/\.$/.test(l) && l.length > 30)) || (l.length <= 400 && FOOTER_MARK.test(l));

/**
 * Where a footer starts: the longest run of footer lines at the end that holds at least one sure mark (a separator,
 * copyright, unsubscribe, privacy policy, "this email was sent by"). -1 when there is none. Never the first line.
 */
export function footerStart(body: string[]): number {
  let start = -1;
  let marked = false;
  for (let i = body.length - 1; i > 0; i--) {
    const l = body[i];
    if (!footerLine(l)) break;
    if (l.length <= 400 && FOOTER_MARK.test(l)) marked = true;
    if (marked) start = i;
  }
  return start;
}

/** Lines automated mail adds around its message: view-in-browser links, survey scales, image names. */
const UPDATE_NOISE = /^((click here to )?view (this e-?mail )?(it )?(in|as) (a |your )?(web ?page|browser)\.?|having trouble (viewing|reading) this( e-?mail)?\??.{0,80}|[1-9]|10|not at all|extremely|helpful|how (helpful|useful) was this( e-?mail)?\??|(?=[\w.-]*[a-z])[\w.-]{24,})$/i;

/**
 * An automated message (a shipping notice, an account alert, a newsletter) cleaned for reading: links alone on their
 * line and the label just above one ("Your Orders" / https://…), links inside sentences, view-in-browser lines, survey
 * scales and image names go, as do the greeting and the footer. What is left is only the sender's lines, in order.
 */
function cleanUpdate(all: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < all.length; i++) {
    const l = all[i].replace(/[([<]\s*https?:\/\/[^\s)>\]]{1,2000}\s*[)\]>]/gi, "").replace(/\bhttps?:\/\/\S{40,2000}/gi, "").replace(/\s{2,}/g, " ").trim();
    if (URL_ONLY.test(all[i]) || (l.length > SHORT ? false : UPDATE_NOISE.test(l))) continue;
    // A label with its link on the next line (blank lines between allowed): navigation, not the message.
    let n = i + 1;
    while (n < all.length && all[n] === "") n++;
    if (l && l.length <= 40 && l.split(/\s+/).length <= 5 && n < all.length && URL_ONLY.test(all[n])) continue;
    if (l === "" && all[i] !== "") continue; // a line that was only links
    out.push(l);
  }
  return trimBlank(out);
}

/** At most this many lines of signature after a sign-off (blank lines not counted): name, title, company, phones, address, links. */
const AFTER_SIGN_OFF = 8;

/**
 * A line that can be part of a signature: short, and not a sentence ("Also, the meeting moved to 3pm." is the body).
 * An address line ("123 Main St, Suite 4, Springfield, IL 62704") is allowed: long enough, but no sentence's end.
 */
const signatureLine = (l: string) => l === "" || (l.length <= 80 && l.split(/\s+/).length <= 12 && !(/[.?!]$/.test(l) && l.length > 30));

/** The lines from `i` to the end hold at most AFTER_SIGN_OFF non-blank lines, all signature lines. */
const signatureAfter = (body: string[], i: number) => {
  const rest = body.slice(i + 1);
  return rest.filter((l) => l !== "").length <= AFTER_SIGN_OFF && rest.every(signatureLine);
};

// ---------------------------------------------------------------------------------------------------------------------
// What the rules cannot settle

const PHONE = /(^|\s)\+?\(?\d[\d ().-]{7,18}\d(\s|$)/;
const WEB = /(https?:\/\/|\bwww\.)\S/i;
const ADDRESS = /\S@\S+\.\w/;

/** The last lines still look like a signature: a phone number, a web or mail address, or `|` between details. */
function signatureLike(lines: string[]): boolean {
  return lines.slice(-3).some((l) => l.length <= SHORT && (PHONE.test(l) || WEB.test(l) || ADDRESS.test(l) || l.includes(" | ")));
}

// ---------------------------------------------------------------------------------------------------------------------

/** Lines with their ends trimmed, odd spaces made plain, and no blank line at either end. */
function lines(text: string): string[] {
  const out = text.replace(/\r\n?/g, "\n").replace(/[   ]/g, " ").split("\n").map((l) => l.trim());
  return trimBlank(out);
}

function trimBlank(ls: string[]): string[] {
  let a = 0;
  let b = ls.length;
  while (a < b && ls[a] === "") a++;
  while (b > a && ls[b - 1] === "") b--;
  return ls.slice(a, b);
}

/** Runs of blank lines become one: paragraphs stay apart, gaps do not grow. */
const join = (ls: string[]) => ls.filter((l, i) => l !== "" || ls[i - 1] !== "").join("\n");

/**
 * The sender signing with only their name ("Sam", "- Sam", "Sam R."): a last line that is the sender's first name or
 * full name, as the mail's From shows it. Without a name to compare, a lone word is never taken: it may be the message.
 */
export function isNameSignOff(line: string, names: string[]): boolean {
  if (line.length > 40) return false;
  const bare = line.replace(/^[-–—~]\s*/, "").replace(/[.,!]$/, "").trim().toLowerCase();
  if (!bare) return false;
  return names.some((n) => {
    const full = n.replace(/["']/g, "").trim().toLowerCase();
    if (full.length < 2) return false;
    const first = full.split(/\s+/)[0];
    if (bare === full || (first.length >= 2 && bare === first)) return true;
    // "Sam R." : the first name and an initial. Plain string checks: the name is the sender's text, never a pattern.
    return first.length >= 2 && bare.startsWith(`${first} `) && /^[a-z]\.?$/.test(bare.slice(first.length + 1));
  });
}

/**
 * A message forwarded with nothing written above it: the marker and the forwarded message's header lines (From:, Date:,
 * Subject:, To: and the like) are taken off, so what shows is the forwarded message itself. Null when `all` does not
 * start with a forward or a header block.
 */
function forwardedBody(all: string[]): string[] | null {
  if (!all.length || !startsQuote(all, 0) || ON_WROTE.test(all[0])) return null;
  let i = FORWARD.test(all[0]) || ORIGINAL.test(all[0]) || UNDERSCORES.test(all[0]) ? 1 : 0;
  while (i < all.length && (all[i] === "" || (all[i].length <= SHORT && HEADER.test(all[i])))) i++;
  const rest = trimBlank(all.slice(i));
  return rest.length ? rest : null;
}

/**
 * The body of one message: what the sender wrote for this message, without greeting, sign-off or what it quotes.
 * `automated`: a mail a system sent (a shipping notice, an alert, a newsletter): its links, navigation and footer go
 * too, and it is always `unsure`, so the local model may pick its lines that matter (a summary of the sender's lines).
 */
export function cleanMail(text: string, opts: { names?: string[]; automated?: boolean } = {}): Cleaned {
  let all = lines(text);
  if (!all.length) return { text: "", unsure: false };
  // 0. Forwarded with no words of its own: the forwarded message is the one to clean (one level).
  const fwd = forwardedBody(all);
  if (fwd) all = fwd;
  if (opts.automated) {
    let body = cleanUpdate(all);
    // In a system's mail, everything from its copyright line down is footer, whatever follows it.
    const copyright = body.findIndex((l, i) => i > 0 && l.length <= 600 && /^(©|\(c\)\s|copyright\b)|\ball rights reserved\b/i.test(l));
    if (copyright > 0) body = trimBlank(body.slice(0, copyright));
    const foot = footerStart(body);
    if (foot > 0) body = trimBlank(body.slice(0, foot));
    // The greeting can come after a headline or two ("Apply now" / "Your form is ready" / "Robin,"): within the first
    // three lines, the first greeting line goes.
    const lead = body.slice(0, 6).map((l, i) => [l, i] as const).filter(([l]) => l !== "").slice(0, 3);
    const greet = lead.find(([l]) => isGreeting(l));
    if (greet && body.length > 1) body = trimBlank([...body.slice(0, greet[1]), ...body.slice(greet[1] + 1)]);
    if (!body.length) body = all;
    return { text: join(body), unsure: true };
  }

  // 1. The quoted history and everything under it.
  let body = all;
  const q = quoteStart(body);
  if (q >= 0) body = trimBlank(body.slice(0, q));

  // 2. The signature after `-- `, a legal notice at the end, and device lines wherever they are.
  const sig = body.findIndex((l) => SIG_MARK.test(l));
  if (sig >= 0) body = trimBlank(body.slice(0, sig));
  const footer = body.findIndex((l, i) => i > 0 && l.length <= 2000 && FOOTER.test(l));
  if (footer > 0) body = trimBlank(body.slice(0, footer));
  const foot = footerStart(body);
  if (foot > 0) body = trimBlank(body.slice(0, foot));
  body = trimBlank(body.filter((l) => l.length > SHORT || !DEVICE.test(l)));
  const beforeGreeting = body;

  // 3. A greeting line at the top.
  if (body.length && isGreeting(body[0])) body = trimBlank(body.slice(1));

  // 4. A sign-off line near the end, with a signature of a few short lines after it.
  for (let i = body.length - 1, seen = 0; i >= 0 && seen <= AFTER_SIGN_OFF; i--) {
    if (isSignOff(body[i]) && signatureAfter(body, i)) { body = trimBlank(body.slice(0, i)); break; }
    if (body[i] !== "") seen++;
  }
  // 5. The sender's own name, alone on a line near the end, with nothing but a signature after it ("Sam", "Sam Rivera
  //    / Leasing / 555 0100"). Without the sender's name, a line is never taken for it.
  const names = opts.names ?? [];
  for (let i = body.length - 1, seen = 0; i > 0 && seen <= AFTER_SIGN_OFF; i--) {
    if (isNameSignOff(body[i], names) && signatureAfter(body, i)) { body = trimBlank(body.slice(0, i)); break; }
    if (body[i] !== "") seen++;
  }

  // Never empty: "Thanks!" alone is the message. A forward with no words of its own shows what it forwards.
  if (!body.length) body = beforeGreeting.length ? beforeGreeting : all;
  return { text: join(body), unsure: signatureLike(body) };
}

/** At most this many lines in a summary of an automated message. */
export const SUMMARY_MAX = 6;
/** The lines the model may pick from, numbered from 1 in its prompt: the non-blank lines, at most 80. */
export function summaryLines(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 80);
}
/**
 * The summary made of the lines the model picked, by number, in the message's own order; null for any other answer
 * (not whole numbers, out of range, repeated, none, more than SUMMARY_MAX). The model never writes a word of it: every
 * line is the sender's, as written.
 */
export function pickLines(picked: unknown, text: string): string | null {
  const ls = summaryLines(text);
  if (!Array.isArray(picked) || !picked.length || picked.length > SUMMARY_MAX) return null;
  if (!picked.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= ls.length)) return null;
  const ns = [...new Set(picked as number[])].sort((a, b) => a - b);
  if (ns.length !== picked.length) return null;
  return ns.map((n) => ls[n - 1]).join("\n");
}

/** Text with every run of whitespace made one space, for comparing pieces. */
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Whether `piece` is one unbroken piece of `whole`, whitespace aside. The model's shortened text is kept only when it
 * is, so a mail cannot get the model to show words the sender never wrote: at worst it cuts too much, and Show original
 * is one tap away.
 */
export function isPieceOf(piece: string, whole: string): boolean {
  const p = flat(piece);
  return p.length > 0 && flat(whole).includes(p);
}

/**
 * The model's shortened text, taken from `whole` itself: when `piece` is the start of `whole` (whitespace aside), the
 * same start cut from `whole` with its own line breaks; otherwise null. The model may only cut the end of a message
 * (where the code was unsure), never a line from the middle, and never adds a word: what is kept is the sender's
 * text, not the model's.
 */
export function startOf(piece: string, whole: string): string | null {
  const p = flat(piece);
  if (!p) return null;
  // Walk `whole`, counting characters as flat() would see them, until p.length of them are matched.
  let n = 0;
  let prevSpace = true; // flat() trims the start
  for (let i = 0; i < whole.length; i++) {
    const space = /\s/.test(whole[i]);
    if (space && prevSpace) continue;
    if ((space ? " " : whole[i]) !== p[n]) return null;
    prevSpace = space;
    if (++n === p.length) {
      // A cut in the middle of a word is no cut at the end of a line: "Call me" from "Call meanwhile".
      const next = whole[i + 1];
      return next === undefined || /\s/.test(next) ? whole.slice(0, i + 1).trimEnd() : null;
    }
  }
  return null;
}
