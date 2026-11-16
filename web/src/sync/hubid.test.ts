import { describe, expect, it } from "vitest";
import { afterLink, normalizeHubId, sameHub } from "./hubid";
import { directAddress } from "./direct";
import { pastedLink } from "../views/Setup";

const A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const B = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
const TS = "https://hub.example.ts.net";
const DIRECT = directAddress("ab".repeat(32), "https://relay.example");
const HOME = "https://192.168.1.20:8788";

describe("hub ids", () => {
  it("are read as the hub writes them, and anything else is no id", () => {
    expect(normalizeHubId(A.toLowerCase())).toBe(A);
    expect(normalizeHubId(` ${A} `)).toBe(A);
    expect(normalizeHubId("01ARZ3NDEKTSV4RRFFQ69G5FA")).toBeNull();
    // Crockford base32 has no I, L, O or U.
    expect(normalizeHubId("01ARZ3NDEKTSV4RRFFQ69G5FAU")).toBeNull();
    expect(normalizeHubId(null)).toBeNull();
    expect(normalizeHubId(42)).toBeNull();
  });

  it("make the same hub at another address the same hub", () => {
    expect(sameHub({ url: TS, id: A }, { url: DIRECT, id: A })).toBe(true);
    expect(sameHub({ url: TS, id: A }, { url: HOME, id: A.toLowerCase() })).toBe(true);
  });

  it("make another id another hub, even at the same address", () => {
    expect(sameHub({ url: TS, id: A }, { url: TS, id: B })).toBe(false);
    expect(sameHub({ url: TS, id: A }, { url: `${TS}/`, id: B })).toBe(false);
  });

  it("fall back to the address when either side has none", () => {
    expect(sameHub({ url: TS }, { url: "hub.example.ts.net/", id: A })).toBe(true);
    expect(sameHub({ url: TS, id: A }, { url: DIRECT })).toBe(false);
    expect(sameHub({ url: TS, id: null }, { url: TS, id: "not an id" })).toBe(true);
  });
});

describe("pairing through a link", () => {
  it("keeps the copy for the same hub reached another way, and takes the link's id", () => {
    expect(afterLink({ url: TS, id: A }, { url: DIRECT, id: A })).toEqual({ same: true, id: A });
  });

  it("starts over for another hub, with its id or none", () => {
    expect(afterLink({ url: TS, id: A }, { url: TS, id: B })).toEqual({ same: false, id: B });
    expect(afterLink({ url: TS, id: A }, { url: DIRECT })).toEqual({ same: false, id: null });
  });

  it("keeps the id it had for the same hub when the link has none (an older hub)", () => {
    expect(afterLink({ url: TS, id: A }, { url: TS })).toEqual({ same: true, id: A });
  });

  it("is a first pairing on a device that had no hub", () => {
    expect(afterLink(null, { url: TS, id: A })).toEqual({ same: false, id: A });
    expect(afterLink(null, { url: TS })).toEqual({ same: false, id: null });
  });

  it("finds the id in an app link and in a web link", () => {
    expect(normalizeHubId(pastedLink(`everythingapp://setup?hub=${encodeURIComponent(TS)}&code=ABCD-EFGH&hid=${A}`)?.get("hid"))).toBe(A);
    const direct = pastedLink(`everythingapp://setup?code=ABCD-EFGH&link=direct&node=${"ab".repeat(32)}&relay=${encodeURIComponent("https://relay.example")}&hid=${A}`);
    expect(direct?.get("hub")).toBe(DIRECT);
    expect(direct?.get("hid")).toBe(A);
    expect(pastedLink(`${TS}/app/#/setup?hub=${encodeURIComponent(TS)}&code=ABCD-EFGH&name=Laptop&hid=${A}`)?.get("hid")).toBe(A);
  });
});
