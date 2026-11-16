import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { Bus, type NotifyEvent } from "../src/bus.js";
import { diskSpace, setDiskSpaceOverride, spaceLeft, startDiskWatch, type DiskSpace } from "../src/diskspace.js";
import { todayView } from "../src/planner.js";
import { makeHub } from "./helpers.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GB = 1024 ** 3;

test("disk: the data folder's disk is measured, and low means 95% used or under 2 GB free", () => {
  const d = diskSpace(os.tmpdir())!;
  assert.ok(d.total_bytes > 0 && d.free_bytes >= 0 && d.used_pct >= 0 && d.used_pct <= 100);
  assert.equal(diskSpace("/no/such/folder/at/all"), null);
  assert.equal(spaceLeft(1.84 * GB), "1.8 GB");
  assert.equal(spaceLeft(640 * 1024 ** 2), "640 MB");
});

test("disk: one alert when the disk gets low, none again the same day, and again after it recovered and got low", async () => {
  const bus = new Bus();
  const seen: NotifyEvent[] = [];
  bus.on("notify", (n) => { seen.push(n); });
  let now: DiskSpace = { free_bytes: 50 * GB, total_bytes: 500 * GB, used_pct: 90, low: false };
  const stop = startDiskWatch({ bus, cfg: { dataDir: "/" } as never }, 10, () => now, 1);
  try {
    await wait(30);
    assert.equal(seen.length, 0);
    now = { free_bytes: 1.5 * GB, total_bytes: 500 * GB, used_pct: 99.7, low: true };
    await wait(40);
    assert.equal(seen.length, 1, "once, not every 10 minutes");
    assert.equal(seen[0].kind, "disk");
    assert.match(seen[0].title, /^The hub's disk is almost full: 1\.5 GB left\./);
    now = { ...now, free_bytes: 80 * GB, used_pct: 84, low: false };
    await wait(30);
    now = { ...now, free_bytes: 1 * GB, used_pct: 99.8, low: true };
    await wait(30);
    assert.equal(seen.length, 2, "low again after it had recovered");
  } finally { stop(); }
});

test("disk: Status shows the data disk", async () => {
  const t = makeHub();
  try {
    const s = await (await t.api("/status")).json() as { disk: DiskSpace | null };
    assert.ok(s.disk && typeof s.disk.free_bytes === "number" && typeof s.disk.low === "boolean");
  } finally { t.cleanup(); }
});

test("disk: the morning digest and Today say so while the data disk is low", () => {
  const t = makeHub();
  try {
    setDiskSpaceOverride(() => ({ free_bytes: 1.5 * GB, total_bytes: 500 * GB, used_pct: 99.7, low: true }));
    assert.match(todayView(t.hub).digest, /^Hub disk: 1\.5 GB left; when it is full the hub cannot save edits or make backups$/m);
    setDiskSpaceOverride(() => ({ free_bytes: 80 * GB, total_bytes: 500 * GB, used_pct: 84, low: false }));
    assert.doesNotMatch(todayView(t.hub).digest, /Hub disk/);
  } finally { setDiskSpaceOverride(null); t.cleanup(); }
});
