import { describe, expect, it } from "vitest";
import { screenOf } from "../components/Shell";
import { windowTitle } from "./hubIdentity";

describe("screens", () => {
  it("name themselves for the window title", () => {
    expect(screenOf("/tasks").title).toBe("Tasks");
    expect(screenOf("/now").title).toBe("Now");
    expect(screenOf("/inbox").title).toBe("Unsorted Info");
    expect(screenOf("/notes/map").title).toBe("Notes map");
    expect(screenOf("/lists/jobs/123").title).toBe("Job applications");
    expect(screenOf("/settings/connection").title).toBe("Connection");
    expect(screenOf("/settings/theme/colors/abc").title).toBe("App colors");
    expect(screenOf("/settings").title).toBe("Settings");
    expect(screenOf("/nowhere").title).toBe("Now");
  });
  it("count as a new screen only when the screen changes, not a note or chat picked in it", () => {
    expect(screenOf("/notes/a").key).toBe(screenOf("/notes/b").key);
    expect(screenOf("/assistant/1").key).toBe(screenOf("/assistant").key);
    expect(screenOf("/notes/a").key).not.toBe(screenOf("/notes/map").key);
    expect(screenOf("/item/a").key).not.toBe(screenOf("/item/b").key);
    expect(screenOf("/settings/data").key).not.toBe(screenOf("/settings").key);
  });
  it("title: screen, a plain hyphen, then the app, with the hub's name on one of several hubs", () => {
    expect(windowTitle("Tasks", null)).toBe("Tasks - Aeneas");
    expect(windowTitle("", null)).toBe("Aeneas");
    expect(windowTitle("Tasks", { name: "Alex", color: "#3a7" })).toBe("Tasks - Aeneas · Alex");
    expect(windowTitle("Tasks", { name: "Alex", color: null })).toBe("Tasks - Aeneas");
    expect(windowTitle("Tasks", null)).not.toMatch(/[\u2013\u2014]/);
  });
});
