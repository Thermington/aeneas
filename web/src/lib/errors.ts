import { HubError } from "../sync/api";
import { kindLabel } from "./links";

/** What a request that never reached the hub says: Chrome "Failed to fetch", Safari "Load failed", Firefox "NetworkError...". */
const NETWORK = /failed to fetch|load failed|networkerror|network request failed|fetch failed|network connection was lost/i;
/** A screen's file that could not be loaded: opened here for the first time with the hub out of reach. */
const SCREEN_FILE = /dynamically imported module|importing a module script failed/i;

/** What a status code with no words from the hub means. */
function statusText(status: number): string {
  if (status === 401) return "The hub did not accept this device's key.";
  if (status === 403) return "The hub does not allow that.";
  if (status === 404) return "The hub does not have that.";
  if (status === 413) return "That is too large for the hub.";
  if (status === 429) return "Too many tries. Wait a moment, then try again.";
  if (status === 502 || status === 503 || status === 504) return "The hub can't be reached right now.";
  if (status >= 500) return "The hub ran into a problem. Try again in a moment.";
  return `The hub could not do that (${status}).`;
}

/**
 * An error in plain words, wherever one is shown: a hub out of reach, a hub that took too long and a bare status code
 * each become a sentence; the hub's own sentences are kept as they are.
 */
export function plainError(e: unknown): string {
  if (e instanceof HubError) {
    if (!e.message || /^(health )?\d{3}$/.test(e.message)) return statusText(e.status);
    if (e.message === "validation failed" || e.message === "invalid fields") return "The hub did not accept what was sent.";
    return e.message;
  }
  const name = e instanceof Error ? e.name : "";
  const message = e instanceof Error ? e.message : String(e);
  if (name === "TimeoutError") return "The hub took too long to answer. Try again in a moment.";
  if (SCREEN_FILE.test(message)) return "This screen has not been opened on this device before, and the hub can't be reached right now.";
  if (NETWORK.test(message)) return "The hub can't be reached right now.";
  return message;
}

/** "a", "a and b", "a, b and c". */
function inWords(xs: string[]): string {
  return xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** A field as words: "remind_at" is "remind at". */
const fieldWords = (k: string) => k.replace(/_/g, " ");

/**
 * Why the hub refused an edit, in plain words. The hub sends its sentence with the details as JSON after it, cut at
 * 300 characters; only the names of the fields it did not accept are taken from that.
 */
export function refusedReason(reason: string): string {
  const invalid = /^(invalid fields|validation failed)\b:?\s*(.*)$/s.exec(reason);
  if (invalid) {
    const fields = [...invalid[2].matchAll(/"path":\[([^\]]*)\]/g)]
      .map((m) => (m[1].match(/"[^"]+"/g) ?? []).map((q) => fieldWords(q.slice(1, -1))).join(" "))
      .filter(Boolean);
    return fields.length ? `the hub did not accept ${inWords([...new Set(fields)])}` : "the hub did not accept what was changed";
  }
  if (/^entity not found/.test(reason)) return "it is no longer on the hub";
  if (/^kind mismatch/.test(reason)) return "the hub has it as another kind of item";
  if (/^too large to send/.test(reason)) return `it was ${reason}`;
  return reason.replace(/:\s*[[{].*$/s, "").trim() || "the hub said no";
}

/**
 * What a refused edit changed, field by field in words ("title: Call the vet about Rex"), so the person can type it
 * again: the sentence names only the fields. Long values are cut at 200 characters; empty ones are left out.
 */
export function refusedValues(fields: Record<string, unknown>): string[] {
  return Object.entries(fields)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => {
      const text = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
      return `${fieldWords(k)}: ${text.length > 200 ? `${text.slice(0, 197)}...` : text}`;
    });
}

/** An edit the hub refused, as one plain sentence: what it was, what changed and when, and why. */
export function refusedSentence(r: { kind: string; title: string; reason: string; fields: Record<string, unknown> }, when: string): string {
  const kind = kindLabel(r.kind) || "item";
  const title = r.title.length > 60 ? `${r.title.slice(0, 57)}...` : r.title;
  const what = `${kind[0].toUpperCase()}${kind.slice(1)}${title ? ` "${title}"` : ""}`;
  const changed = Object.keys(r.fields).map(fieldWords);
  const fields = changed.length > 4 ? [...changed.slice(0, 3), `${changed.length - 3} more`] : changed;
  return `${what} (${when}): your change${fields.length ? ` to ${inWords(fields)}` : ""} was not kept, because ${refusedReason(r.reason)}.`;
}
