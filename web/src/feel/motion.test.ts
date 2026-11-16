import { describe, expect, it } from "vitest";
import { motionOn } from "./FeelLayer";

describe("tap shapes and reduced motion", () => {
  it("stay off when the system asks for less motion", () => {
    expect(motionOn({ motion: true }, true, false)).toBe(false);
    expect(motionOn({ motion: true }, false, false)).toBe(true);
  });
  it("follow the Shapes switch alone in the Windows app, whose web view reports reduced motion with animations on", () => {
    expect(motionOn({ motion: true }, true, true)).toBe(true);
    expect(motionOn({ motion: false }, false, true)).toBe(false);
  });
  it("never show with the Shapes switch off", () => {
    expect(motionOn({ motion: false }, false, false)).toBe(false);
  });
});
