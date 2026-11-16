import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const css = fs.readFileSync(path.resolve(__dirname, "styles.css"), "utf8");

describe("touch targets", () => {
  it("are at least 44 px on touch screens, set only under (pointer: coarse) so a mouse keeps the compact look", () => {
    const touch = css.split("@media (pointer: coarse) {").slice(1).find((b) => b.includes("button.small")) ?? "";
    expect(touch).toMatch(/button, button\.small,[^{]*\{ min-height: 44px; \}/);
    expect(touch).toMatch(/\.tabs a \{ min-height: 44px;/);
    expect(css).toMatch(/^button\.small \{ min-height: 28px;/m);
  });
  it("a screen's heading that takes the focus shows no ring for a mouse or a tap", () => {
    expect(css).toContain("#main h1:focus:not(:focus-visible) { outline: none; }");
  });
});
