import type { Hub } from "./hub.js";
import type { ModuleId } from "./modules.js";

/**
 * The Mail screen's bundles (CONTRACT.md, Mail): which colored group each Inbox mail sits in, worked out from its
 * headers when the list is built, so a new record or a module switched off changes the sorting at once and nothing
 * stale is stored. The sender, the subject and what the headers say are read; of the text, only its start, and only
 * for the job and order phrases (a recruiter's note and signature, a shop's "estimated arrival").
 *
 * Bundles: purchases, trips, social, promos and other for every mail a system sent; bills, pet and jobs only while
 * their module is on (their part of BundleContext is null when it is off). A person's own mail stands alone (null),
 * so it is never lost among notices.
 *
 * The sender's name and the subject are whatever the sender wrote: a mail can put itself in the wrong bundle, nothing
 * more. The screen always shows the real address when a mail is opened.
 */

/** What bundleOf reads of a mail. */
export interface BundleMail {
  from: { name: string; address: string };
  subject: string;
  /** A system sent it (a notice, a newsletter), not a person: isAutomated in imports/icloud.ts. */
  automated: boolean;
  /** It carries List-Unsubscribe: marketing mail or a newsletter, most of the time. */
  unsubscribe: boolean;
  /** Its List-Id, when it comes from a mailing list. */
  list_id: string | null;
  /** The start of its text (TEXT_START characters), read only for the job and order phrases. */
  text?: string;
}

/** How much of a mail's text the phrases are looked for in: enough to reach a normal mail's signature. */
export const TEXT_START = 3000;

/** What the module bundles match against, from the owner's records; null while that module is off. */
export interface BundleContext {
  /** Job search: each application's company and the address of its posting. */
  jobs: { company: string; url: string | null }[] | null;
  /** Renewals and bills: each record's title and its address. */
  bills: { title: string; url: string | null }[] | null;
  /** Pet: the pets' names. */
  pets: string[] | null;
}

/** No modules on: only the bundles every mail can have. */
export const NO_MODULES: BundleContext = { jobs: null, bills: null, pets: null };

/** The records the module bundles match against, read once per list. */
export function bundleContext(hub: Hub): BundleContext {
  const on = (m: ModuleId) => hub.modules.on(m);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    jobs: on("jobs") ? hub.store.list({ kind: "application", limit: 100000 }).map((e) => ({ company: str(e.fields.company) ?? "", url: str(e.fields.url) })).filter((j) => j.company || j.url) : null,
    bills: on("renewals") ? hub.store.list({ kind: "watch", limit: 100000 }).map((e) => ({ title: str(e.fields.title) ?? "", url: str(e.fields.url) })).filter((b) => b.title || b.url) : null,
    pets: on("pet") ? [...new Set(hub.store.list({ kind: "pet_event", limit: 100000 }).map((e) => str(e.fields.pet)).filter((p): p is string => !!p))] : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Helpers for the rules

/** The domain of an address, lower case: "orders@mail.northwind.example" gives "mail.northwind.example". */
export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? "" : address.slice(at + 1).trim().toLowerCase();
}

/** The host of a web address, lower case, without "www."; "" when it is not one. */
export function hostOf(url: string | null): string {
  if (!url) return "";
  try { return new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

/**
 * Whether two hosts belong to the same site: their last two labels match ("mail.contoso.example" and
 * "careers.contoso.example" both end in "contoso.example"). Good enough for sorting, not for security: a site under a
 * two-part country ending ("shop.co.uk") is matched loosely.
 */
export function sameSite(a: string, b: string): boolean {
  const base = (h: string) => h.split(".").filter(Boolean).slice(-2).join(".");
  return !!a && !!b && base(a) === base(b);
}

/** Whether `text` has any of `words` as whole words, in any case: "order" is in "Your order shipped", not in "Border". */
export function hasWord(text: string, words: string[]): boolean {
  const re = wordPattern(words);
  // Runs of spaces and line breaks count as one space, so a phrase split across lines still matches.
  return !!re && re.test(text.toLowerCase().replace(/\s+/g, " "));
}

/**
 * One pattern for a list of words, made once and kept: the list is built for every mail, thousands at a time. Null for
 * an empty list (a pattern of no words would match everything).
 */
const patterns = new Map<string, RegExp | null>();
function wordPattern(words: string[]): RegExp | null {
  const key = words.join("\n");
  let re = patterns.get(key);
  if (re === undefined) {
    const parts = words.map((w) => w.trim().toLowerCase()).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, " "));
    re = parts.length ? new RegExp(`(^|[^a-z0-9])(${parts.join("|")})($|[^a-z0-9])`) : null;
    if (patterns.size > 2000) patterns.clear(); // records come and go; the kept patterns stay few
    patterns.set(key, re);
  }
  return re;
}

// ---------------------------------------------------------------------------------------------------------------------
// The rules

/** Hiring systems that send mail for many companies. */
const HIRING = ["greenhouse.io", "lever.co", "myworkday.com", "ashbyhq.com", "smartrecruiters.com", "icims.com"];
/** Social networks' mail domains. */
const SOCIAL = ["facebookmail.com", "linkedin.com", "instagram.com", "reddit.com", "redditmail.com", "discord.com", "nextdoor.com", "x.com"];
/**
 * Phrases that almost only hiring mail has, looked for in the subject and the start of the text: about an application,
 * about the next steps, and the titles in a recruiter's signature. Never single words like "interview" or "position",
 * which newsletters use all the time.
 */
const JOB_PHRASES = [
  "your application", "received your application", "thank you for applying", "thanks for applying", "applied for", "application status",
  "interview invitation", "schedule an interview", "schedule a phone screen", "a phone screen with", "next steps in the hiring process",
  "recruiter", "talent acquisition", "hiring manager", "hiring team", "people operations",
];
const VET_WORDS =["vet", "veterinary", "animal hospital"];
const BILL_WORDS = ["invoice", "bill", "statement", "payment due", "autopay"];
const TRIP_WORDS = ["flight", "boarding pass", "itinerary", "reservation", "check-in", "hotel", "booking"];
const PURCHASE_WORDS = ["order", "receipt", "shipped", "delivered", "delivery", "tracking", "purchase", "package", "pick up"];
/**
 * Order-status phrases, looked for in the start of the text: a shop's notice whose subject says nothing ("meet your
 * next coffee") still has them. Never "shipping" or "delivery" alone, which promos say all the time ("free shipping").
 */
const ORDER_PHRASES = ["estimated arrival", "estimated delivery", "order number", "order confirmation", "tracking number", "out for delivery", "has shipped", "your shipment"];

/**
 * The bundle a mail sits in, or null when it stands alone (a person's mail). The rules, most specific first (the first
 * that matches wins); test/mail-bundles.test.ts has a case for each:
 *  1. jobs:  ctx.jobs is not null, and the sender's domain is the same site as an application's url, or the sender's
 *            name has its company (a name of 4 or more letters, its domain too); or the mail comes from a hiring system (greenhouse.io, lever.co,
 *            myworkday.com, ashbyhq.com, smartrecruiters.com, icims.com); or a job phrase (JOB_PHRASES) is in the
 *            subject or the start of the text. The only rule that also takes a person's mail
 *            (a recruiter writes as a person).
 *  2. A person's mail (not automated, no unsubscribe) stands alone: return null.
 *  3. pet:   ctx.pets is not null, and a pet's name, or "vet", "veterinary", "animal hospital", is in the sender's name
 *            or the subject.
 *  4. bills: ctx.bills is not null, and the sender is the same site as a record's url or has its title; or the subject
 *            has invoice, bill, statement, payment due, autopay.
 *  5. trips:     flight, boarding pass, itinerary, reservation, check-in, hotel, booking.
 *  6. purchases: order, receipt, shipped, delivered, delivery, tracking, purchase, package, pick up in the subject; or an order-status
 *                phrase (ORDER_PHRASES) in the start of the text.
 *  7. social:    the sender's domain is a social network's (facebookmail.com, linkedin.com, instagram.com, reddit.com,
 *                redditmail.com, discord.com, nextdoor.com, x.com).
 *  8. promos:    anything left that carries unsubscribe.
 *  9. other:     anything else a system sent.
 */
export function bundleOf(mail: BundleMail, ctx: BundleContext): string | null {
  const domain = domainOf(mail.from.address);
  const name = mail.from.name;
  const subject = mail.subject;
  /** The start of the text, where the job and order phrases are looked for. */
  const start = (mail.text ?? "").slice(0, TEXT_START);
  /** Whether the sender's domain is one of these sites. */
  const fromAny = (sites: string[]) => sites.some((s) => sameSite(domain, s));
  /**
   * Whether a record's name is the sender's name or part of its domain ("Fabrikam" in no-reply@fabrikam.example). Only a
   * name of 4 or more letters is looked for inside a domain: "box" is inside dropbox.com, "ea" inside most domains.
   */
  const named = (record: string) => record !== "" && (hasWord(name, [record]) || (record.length >= 4 && domain.includes(record.toLowerCase())));

  // 1. Jobs: the one rule that takes a person's mail too, since a recruiter writes as a person.
  if (ctx.jobs) {
    const applied = ctx.jobs.some((j) => sameSite(domain, hostOf(j.url)) || named(j.company));
    const sounds = hasWord(subject, JOB_PHRASES) || hasWord(start, JOB_PHRASES);
    if (applied || fromAny(HIRING) || sounds) return "jobs";
  }

  // 2. A person's mail stands alone.
  if (!mail.automated && !mail.unsubscribe) return null;

  // 3. Pet: a pet's name or a vet word, in the sender's name or the subject.
  if (ctx.pets) {
    const words = [...ctx.pets, ...VET_WORDS];
    if (hasWord(name, words) || hasWord(subject, words)) return "pet";
  }

  // 4. Bills: a renewal record's site or name, or a bill word in the subject.
  if (ctx.bills) {
    const renews = ctx.bills.some((b) => sameSite(domain, hostOf(b.url)) || named(b.title));
    if (renews || hasWord(subject, BILL_WORDS)) return "bills";
  }

  // 5 to 9: the bundles every mail can have.
  if (hasWord(subject, TRIP_WORDS)) return "trips";
  if (hasWord(subject, PURCHASE_WORDS) || hasWord(start, ORDER_PHRASES)) return "purchases";
  if (fromAny(SOCIAL)) return "social";
  if (mail.unsubscribe) return "promos";
  return "other";
}
