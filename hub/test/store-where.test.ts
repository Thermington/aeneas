import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { reminderTick } from "../src/reminders.js";
import { openActivities } from "../src/focus.js";
import type { FieldTest } from "../src/store.js";

test("store: listWhere gives exactly what list() and a JavaScript filter give, work rows included", () => {
  const t = makeHub();
  try {
    const s = t.hub.store;
    const at = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    s.create("task", { title: "open with a reminder", status: "next", order: 1, remind_at: at(1) });
    s.create("task", { title: "done with a reminder", status: "done", order: 2, remind_at: at(2) });
    s.create("task", { title: "open, no reminder", status: "next", order: 3 });
    const bare = s.create("task", { title: "no status, reminder", status: "next", order: 4, remind_at: at(3) });
    s.patch(bare.id, { status: null });
    s.create("task", { title: "work, reminder", status: "next", order: 5, remind_at: at(1) }, "work");
    s.create("task", { title: "work, done", status: "done", order: 6, remind_at: at(1) }, "work");
    const gone = s.create("task", { title: "deleted", status: "next", order: 7, remind_at: at(1) });
    s.patch(gone.id, { deleted_at: new Date().toISOString() });
    s.create("capture", { text: "filed", source: "web", processed: true } as never);
    s.create("capture", { text: "waiting", source: "web", processed: false } as never);
    s.create("capture", { text: "processed defaults to false", source: "web" } as never);
    s.create("log", { type: "activity", value: "piano", at: at(1) } as never);
    s.create("log", { type: "weight", value: 70, at: at(30 * 24) } as never);
    s.create("log", { type: "mood", value: "ok", at: at(2) } as never);

    const same = (kind: string, tests: FieldTest[], js: (f: Record<string, unknown>) => boolean) => {
      const want = s.list({ kind }).filter((e) => js(e.fields)).map((e) => e.id).sort();
      assert.deepEqual(s.listWhere(kind, tests).map((e) => e.id).sort(), want, JSON.stringify(tests));
      return want.length;
    };
    assert.equal(same("task", [{ key: "remind_at", set: true }, { key: "status", isNot: "done" }], (f) => f.remind_at != null && f.status !== "done"), 3);
    assert.equal(same("capture", [{ key: "processed", isNot: true }], (f) => f.processed !== true), 2);
    assert.equal(same("capture", [{ key: "processed", is: false }], (f) => f.processed === false), 2);
    assert.equal(same("log", [{ key: "type", is: "activity" }], (f) => f.type === "activity"), 1);
    assert.equal(same("log", [{ key: "type", oneOf: ["mood", "weight"] }], (f) => f.type === "mood" || f.type === "weight"), 2);
    const week = at(7 * 24);
    assert.equal(same("log", [{ key: "at", from: week }], (f) => typeof f.at === "string" && f.at >= week), 2);
    assert.throws(() => s.listWhere("task", [{ key: "x') OR 1=1 --", set: true }]), /not a field name/);
    // Counting gives the same numbers without parsing, work kinds included.
    assert.equal(s.countWhere("log", [{ key: "type", oneOf: ["mood", "weight"] }]), 2);
    assert.equal(s.countWhere("capture", [{ key: "processed", isNot: true }]), 2);
    assert.equal(s.countWhere("task", [{ key: "remind_at", set: true }, { key: "status", isNot: "done" }]), 3);
    assert.equal(s.countWhere("log", [{ key: "at", from: week }]), 2);
  } finally { t.cleanup(); }
});

test("store: list stops at its limit, newest change first; the timers still find what they need", () => {
  const t = makeHub();
  try {
    const s = t.hub.store;
    for (let i = 0; i < 30; i++) s.create("task", { title: `t${i}`, status: "next", order: i });
    const all = s.list({ kind: "task" });
    assert.equal(all.length, 30);
    assert.deepEqual(s.list({ kind: "task", limit: 5 }).map((e) => e.id), all.slice(0, 5).map((e) => e.id));
    assert.deepEqual(s.list({ kind: "task", limit: 3, where: { status: "next" } }).length, 3);

    const due = s.create("task", { title: "due now", status: "next", order: 99, remind_at: new Date(Date.now() - 60_000).toISOString() });
    assert.deepEqual(reminderTick(s, t.hub.bus), [due.id]);
    assert.deepEqual(reminderTick(s, t.hub.bus), [], "fires once");
    const walk = s.create("log", { type: "activity", value: "walk", at: new Date(Date.now() - 600_000).toISOString() } as never);
    assert.deepEqual(openActivities(t.hub).map((e) => e.id), [walk.id]);
    assert.deepEqual(s.createdTimes("task").length, 31);
  } finally { t.cleanup(); }
});

test("store: the capture queries the timers and Today make use the capture indexes", () => {
  const t = makeHub();
  try {
    const s = t.hub.store;
    assert.match(s.planOf("capture", [{ key: "filing", is: "pending" }]).join(" "), /USING INDEX capture_filing/);
    assert.match(s.planOf("capture", [{ key: "sort", is: true }]).join(" "), /USING INDEX capture_sort/);
    assert.match(s.planOf("capture", [{ key: "processed", is: false }]).join(" "), /USING INDEX capture_processed/);
    // Captures always hold processed (the schema's default), so "is false" counts the unsorted ones.
    s.create("capture", { text: "a", source: "web" } as never);
    s.create("capture", { text: "b", source: "web", processed: true } as never);
    assert.equal(s.countWhere("capture", [{ key: "processed", is: false }]), s.list({ kind: "capture" }).filter((c) => c.fields.processed !== true).length);
  } finally { t.cleanup(); }
});
