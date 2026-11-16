import { describe, expect, it } from "vitest";
import { kindLabel, platformLabel } from "./links";

describe("plain names for Status and Devices", () => {
  it("kinds as people say them", () => {
    expect(kindLabel("music_idea")).toBe("music idea");
    expect(kindLabel("runbook")).toBe("fix notes");
    expect(kindLabel("watch")).toBe("renewal");
    expect(kindLabel("something_new")).toBe("something_new");
  });
  it("platforms as people say them", () => {
    expect(platformLabel("iphone")).toBe("iPhone");
    expect(platformLabel("windows")).toBe("Windows");
    expect(platformLabel("web")).toBe("Web");
    expect(platformLabel("plan9")).toBe("plan9");
  });
});
