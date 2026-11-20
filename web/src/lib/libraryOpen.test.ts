import { describe, expect, it } from "vitest";
import { parseOpen, toggled } from "./libraryOpen";

describe("Library areas open on this device", () => {
  it("opens and closes one area at a time", () => {
    expect(toggled([], "Plan")).toEqual(["Plan"]);
    expect(toggled(["Plan", "Notes"], "Plan")).toEqual(["Notes"]);
  });

  it("starts with every area closed, and survives a damaged stored list", () => {
    expect(parseOpen(null)).toEqual([]);
    expect(parseOpen("not json")).toEqual([]);
    expect(parseOpen('{"Plan":true}')).toEqual([]);
    expect(parseOpen('["Plan", 3, "Making"]')).toEqual(["Plan", "Making"]);
  });

  it("keeps an area opened as Homelab open after its rename to Tech", () => {
    expect(parseOpen('["Homelab", "Plan"]')).toEqual(["Tech", "Plan"]);
    expect(parseOpen('["Tech", "Homelab"]')).toEqual(["Tech"]);
  });
});
