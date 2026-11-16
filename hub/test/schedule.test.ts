import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { dbJobClock, scheduleDaily, type JobClock } from "../src/schedule.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function memoryClock(last: number | null): JobClock & { runs: number[] } {
  const runs: number[] = [];
  return { runs, last: () => (runs.length ? runs[runs.length - 1] : last), ran: (_l, at) => { runs.push(at); } };
}

test("schedule: a daily run missed while the hub was off is made up at the first look", async () => {
  const clock = memoryClock(Date.now() - 2 * 24 * 3_600_000);
  let ran = 0;
  const stop = scheduleDaily("test", 3, 10, () => { ran++; }, { clock, firstLookMs: 5 });
  try {
    await wait(60);
    assert.equal(ran, 1, "made up once");
    assert.equal(clock.runs.length, 1, "and noted, so the next look does not run it again");
  } finally { stop(); }
});

test("schedule: a job that ran within the last day is not run again, and one never run runs", async () => {
  const recent = memoryClock(Date.now() - 3_600_000);
  let ranRecent = 0;
  const stopRecent = scheduleDaily("recent", 3, 10, () => { ranRecent++; }, { clock: recent, firstLookMs: 5 });
  const never = memoryClock(null);
  let ranNever = 0;
  const stopNever = scheduleDaily("never", 3, 10, () => { ranNever++; }, { clock: never, firstLookMs: 5 });
  try {
    await wait(60);
    assert.equal(ranRecent, 0);
    assert.equal(ranNever, 1);
  } finally { stopRecent(); stopNever(); }
});

test("schedule: a job that throws is still noted as run, and a job without a clock is never made up", async () => {
  const clock = memoryClock(null);
  const stop = scheduleDaily("throws", 3, 10, () => { throw new Error("boom"); }, { clock, firstLookMs: 5 });
  let plain = 0;
  const stopPlain = scheduleDaily("plain", 3, 10, () => { plain++; });
  try {
    await wait(60);
    assert.equal(clock.runs.length, 1);
    assert.equal(plain, 0);
  } finally { stop(); stopPlain(); }
});

test("schedule: the database clock keeps each job's last run", () => {
  const db = openDb(":memory:");
  try {
    const clock = dbJobClock(db);
    assert.equal(clock.last("sweep"), null);
    clock.ran("sweep", Date.parse("2026-11-16T08:10:00.000Z"));
    clock.ran("sweep", Date.parse("2026-11-17T08:10:00.000Z"));
    assert.equal(clock.last("sweep"), Date.parse("2026-11-17T08:10:00.000Z"));
    assert.equal(clock.last("compact"), null);
  } finally { db.close(); }
});
