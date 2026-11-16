import { describe, expect, it } from "vitest";
import { compareVersions, versionNotice } from "./appUpdate";

describe("app version notice", () => {
  it("compares versions part by part, as numbers", () => {
    expect(compareVersions("1.0.3", "1.0.3")).toBe(0);
    expect(compareVersions("1.0.3", "1.0.4")).toBe(-1);
    expect(compareVersions("1.0.10", "1.0.9")).toBe(1);
    expect(compareVersions("1.2.0", "1.10.0")).toBe(-1);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
    for (const bad of ["unknown", "1.0", "1.0.3-beta", "", "v1.0.3"]) expect(compareVersions(bad, "1.0.3")).toBeNull();
  });

  it("tells the Windows and Android apps when a newer app is out, or the hub is behind", () => {
    expect(versionNotice("1.0.3", "1.0.4", true)?.kind).toBe("app-older");
    expect(versionNotice("1.0.3", "1.0.4", true)?.text).toContain("1.0.4");
    expect(versionNotice("1.0.4", "1.0.3", true)?.kind).toBe("hub-older");
    expect(versionNotice("1.0.3", "1.0.3", true)).toBeNull();
  });

  it("says nothing in a browser, without the hub's version, or for a version it cannot read", () => {
    expect(versionNotice("1.0.3", "1.0.4", false)).toBeNull();
    expect(versionNotice("1.0.3", null, true)).toBeNull();
    expect(versionNotice("unknown", "1.0.4", true)).toBeNull();
    expect(versionNotice("1.0.3", "0.1.0-dev", true)).toBeNull();
  });
});
