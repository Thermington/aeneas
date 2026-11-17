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

/** `On Tue, 4 Nov 2026 at 09:12, Alex <alex@example.com> wrote:` (Apple Mail, Gmail and most others). */
const ON_WROTE = /^on\b.{0,180}\bwrote:$/i;
/** Outlook and older clients. */
const ORIGINAL = /^-{2,}\s*original message\s*-{2,}$/i;
const FORWARD = /^(-{2,}\s*forwarded message\s*-{2,}|begin forwarded message:)$/i;
/** Outlook's line of underscores above the quoted message. */
const UNDERSCORES = /^_{10,}$/;
const HEADER_FROM = /^from:\s/i;
const HEADER_NEXT = /^(sent|date|to|subject):\s/i;

/** The index of the first line of quoted history, or -1. */
function quoteStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.length > SHORT) continue;
    if (ON_WROTE.test(l) || ORIGINAL.test(l) || FORWARD.test(l) || UNDERSCORES.test(l)) return i;
    // "On ... Alex <alex@" / "example.com> wrote:": some clients wrap the line.
    if (/^on\b/i.test(l) && i + 1 < lines.length && lines[i + 1].length <= SHORT && ON_WROTE.test(`${l} ${lines[i + 1]}`)) return i;
    // An Outlook block: From: then Sent:, Date:, To: or Subject: within the next two lines.
    if (HEADER_FROM.test(l) && lines.slice(i + 1, i + 3).some((n) => HEADER_NEXT.test(n))) return i;
  }
  // Quoted lines at the end with nothing of the sender's after them.
  let end = lines.length;
  while (end > 0 && (lines[end - 1] === "" || lines[end - 1].startsWith(">"))) end--;
  return end < lines.length && lines.slice(end).some((l) => l.startsWith(">")) ? end : -1;
}

// ---------------------------------------------------------------------------------------------------------------------
// Signature, device lines

/** The signature marker `-- ` (trailing space trimmed already, so `--` too). */
const SIG_MARK = /^--$/;
const DEVICE = /^(sent from my \w[\w ]{0,30}|sent from (mail|outlook) for \w+|get outlook for \w+|sent from yahoo mail.{0,30}|sent with proton mail.{0,30})\.?$/i;

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
  const ended = /[,!:.]$/.test(rest) || rest === "";
  const words = rest.replace(/[,!:.]$/, "").trim();
  if (/[,!:?;]/.test(words)) return false; // something more follows the greeting: "Hi Sam, can you…"
  const n = words ? words.split(/\s+/).length : 0;
  // With a comma or the like after it, up to four words of names; without, at most two ("Hello all", "Hi Robin").
  return ended ? n <= 4 : n <= 2;
}

const SIGN_OFF = /^(thanks|thank you|thanks again|thanks so much|thank you so much|many thanks|thx|ty|best|best regards|best wishes|all the best|kind regards|warm regards|warmest regards|regards|cheers|sincerely|yours|yours truly|yours sincerely|take care|talk soon|speak soon|love|warmly|respectfully|cordially|with thanks|xo+)\b/i;

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

/** At most this many short lines after a sign-off: a name, a title, a phone number. */
const AFTER_SIGN_OFF = 4;

/** A line that can follow a sign-off: short, and not a sentence ("Also, the meeting moved to 3pm." is the body). */
const signatureLine = (l: string) => l.length <= 60 && l.split(/\s+/).length <= 7 && !(/[.?!]$/.test(l) && l.length > 30);

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

/** The body of one message: what the sender wrote for this message, without greeting, sign-off or what it quotes. */
export function cleanMail(text: string, opts: { names?: string[] } = {}): Cleaned {
  const all = lines(text);
  if (!all.length) return { text: "", unsure: false };

  // 1. The quoted history and everything under it.
  let body = all;
  const q = quoteStart(body);
  if (q >= 0) body = trimBlank(body.slice(0, q));

  // 2. The signature after `-- `, and device lines wherever they are.
  const sig = body.findIndex((l) => SIG_MARK.test(l));
  if (sig >= 0) body = trimBlank(body.slice(0, sig));
  body = trimBlank(body.filter((l) => l.length > SHORT || !DEVICE.test(l)));
  const beforeGreeting = body;

  // 3. A greeting line at the top.
  if (body.length && isGreeting(body[0])) body = trimBlank(body.slice(1));

  // 4. A sign-off line near the end, with at most a few short lines after it.
  for (let i = body.length - 1; i >= 0 && i >= body.length - 1 - AFTER_SIGN_OFF; i--) {
    if (isSignOff(body[i]) && body.slice(i + 1).every(signatureLine)) { body = trimBlank(body.slice(0, i)); break; }
  }
  // 5. The sender's own name alone on the last line.
  if (body.length > 1 && isNameSignOff(body[body.length - 1], opts.names ?? [])) body = trimBlank(body.slice(0, -1));

  // Never empty: "Thanks!" alone is the message. A forward with no words of its own shows what it forwards.
  if (!body.length) body = beforeGreeting.length ? beforeGreeting : all;
  return { text: join(body), unsure: signatureLike(body) };
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
