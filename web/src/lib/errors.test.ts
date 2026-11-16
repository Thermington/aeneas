import { describe, expect, it } from "vitest";
import { HubError } from "../sync/api";
import { plainError, refusedReason, refusedSentence, refusedValues } from "./errors";

describe("errors in plain words", () => {
  it("a hub out of reach says so, in every browser's words", () => {
    for (const m of ["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."]) {
      expect(plainError(new TypeError(m))).toBe("The hub can't be reached right now.");
    }
  });
  it("a request that took too long, and a screen that could not load offline", () => {
    expect(plainError(new DOMException("signal timed out", "TimeoutError"))).toBe("The hub took too long to answer. Try again in a moment.");
    expect(plainError(new TypeError("Failed to fetch dynamically imported module: https://hub.test/app/assets/Tasks-abc.js"))).toMatch(/^This screen has not been opened/);
  });
  it("a bare status code becomes a sentence; the hub's own sentence stays", () => {
    expect(plainError(new HubError(502, "502"))).toBe("The hub can't be reached right now.");
    expect(plainError(new HubError(500, "500"))).toBe("The hub ran into a problem. Try again in a moment.");
    expect(plainError(new HubError(401, "health 401"))).toBe("The hub did not accept this device's key.");
    expect(plainError(new HubError(401, "That pairing code is wrong, used or older than 10 minutes."))).toBe("That pairing code is wrong, used or older than 10 minutes.");
    expect(plainError(new HubError(422, "validation failed", []))).toBe("The hub did not accept what was sent.");
    expect(plainError("plain words")).toBe("plain words");
  });
  it("never has an en or em dash", () => {
    for (const e of [new TypeError("Failed to fetch"), new HubError(404, "404"), new HubError(429, "429"), new HubError(418, "418")]) expect(plainError(e)).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("refused edits", () => {
  const invalid = 'invalid fields: [{"code":"invalid_type","expected":"string","received":"number","path":["due"],"message":"Expected string, received number"},{"code":"custom","path":["block","start"],"message":"bad"},{"code":"invalid_ty';
  it("names the fields the hub did not accept, never its JSON", () => {
    expect(refusedReason(invalid)).toBe("the hub did not accept due and block start");
    expect(refusedReason("invalid fields")).toBe("the hub did not accept what was changed");
    expect(refusedReason("entity not found; send create: true to create it")).toBe("it is no longer on the hub");
    expect(refusedReason("too large to send (over 2 MB)")).toBe("it was too large to send (over 2 MB)");
    expect(refusedReason('the work space is off: {"space":"work"}')).toBe("the work space is off");
  });
  it("is one sentence: what, when, what changed and why", () => {
    const s = refusedSentence({ kind: "task", title: "Buy a new bike seat", reason: invalid, fields: { due: 5, status: "next" } }, "9:41 AM");
    expect(s).toBe('Task "Buy a new bike seat" (9:41 AM): your change to due and status was not kept, because the hub did not accept due and block start.');
    expect(s).not.toMatch(/[{}[\]]/);
    const many = refusedSentence({ kind: "note", title: "", reason: "kind mismatch: entity is task", fields: { a: 1, b: 2, c: 3, d: 4, e: 5 } }, "Nov 14 9:41 AM");
    expect(many).toBe("Note (Nov 14 9:41 AM): your change to a, b, c and 2 more was not kept, because the hub has it as another kind of item.");
  });
});

describe("refusedValues", () => {
  it("lists what was changed in words so it can be typed again, long text cut, empty values left out", () => {
    expect(refusedValues({ title: "Call the vet about Rex", remind_at: "2026-11-16T14:00:00.000Z", done: false, notes: "", tags: ["pets", "calls"] })).toEqual([
      "title: Call the vet about Rex",
      "remind at: 2026-11-16T14:00:00.000Z",
      "done: false",
      'tags: ["pets","calls"]',
    ]);
    const long = refusedValues({ body: "x".repeat(500) })[0];
    expect(long.length).toBe("body: ".length + 200);
    expect(long.endsWith("...")).toBe(true);
  });
});
