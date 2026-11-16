import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Entity } from "@everythingapp/shared";
import { db } from "./db";
import { localConflict } from "./planner";

const at = "2026-11-01T10:00:00.000Z";
const event = (id: string, fields: Record<string, unknown>): Entity => ({ id, kind: "event", space: "personal", created_at: at, updated_at: at, deleted_at: null, fields, field_ts: {} });

describe("the offline clash check", () => {
  beforeEach(async () => {
    await db.entities.clear();
  });

  it("compares moments, not text, when an event keeps its offset", async () => {
    // 7 to 9 PM at -05:00 is midnight to 2 AM UTC, the same moments in any zone.
    await db.entities.put(event("e1", { title: "Dinner with Robin", start: "2026-11-16T19:00:00-05:00", end: "2026-11-16T21:00:00-05:00" }));
    // A block from 23:30 UTC runs into the dinner; as text it looked clear.
    expect(await localConflict("t1", { start: "2026-11-16T23:30:00.000Z", end: "2026-11-17T02:30:00.000Z" })).toMatchObject({ kind: "event", title: "Dinner with Robin" });
    // A block from 19:00 to 22:00 UTC ends two hours before it; as text it looked like a clash.
    expect(await localConflict("t1", { start: "2026-11-16T19:00:00.000Z", end: "2026-11-16T22:00:00.000Z" })).toBeNull();
  });
});
