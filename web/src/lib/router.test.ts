import { afterEach, describe, expect, it, vi } from "vitest";
import { afterPairing, replace } from "./router";

describe("after pairing", () => {
  it("a device with no hub stays on the screen Setup stood in for", () => {
    expect(afterPairing("/capture", null)).toBe("/capture");
    expect(afterPairing("/tasks?focus=abc", "/now")).toBe("/tasks?focus=abc");
    expect(afterPairing("", null)).toBe("/now");
  });
  it("a pairing link goes back to the screen before it, never to the link or the hub's setup page", () => {
    expect(afterPairing("/setup?hub=https%3A%2F%2Fcore&code=ABCDEFGH", "/assistant/123")).toBe("/assistant/123");
    expect(afterPairing("/setup?hub=https%3A%2F%2Fcore&code=ABCDEFGH", null)).toBe("/now");
    expect(afterPairing("/setup?hub=a&code=B", "/setup?hub=a&code=C")).toBe("/now");
    expect(afterPairing("/setup", "/settings/connection")).toBe("/settings/connection");
  });
});

describe("replace", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("swaps the current history entry instead of adding one", () => {
    const location = { hash: "#/assistant", replace: vi.fn() };
    vi.stubGlobal("window", { location });
    replace("/assistant/abc");
    expect(location.replace).toHaveBeenCalledWith("#/assistant/abc");
    expect(location.hash).toBe("#/assistant");
  });
});
