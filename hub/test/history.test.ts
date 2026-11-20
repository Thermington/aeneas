import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHub } from "./helpers.js";
import { readingEvent } from "../src/history.js";
import { recordReading } from "../src/sensors.js";
import { hostsSummary } from "../src/memory.js";
import { opsView } from "../src/monitors.js";
import type { Host, RunResult } from "../src/ai/hosts.js";

test("a reading's new state reads as a line of history", () => {
  assert.equal(readingEvent("desk-pc.disk.p.used", "desk-pc", "high", 91.24, "%", { max: 90 }), "Disk P: went above 90%: 91.2%");
  assert.equal(readingEvent("garage_freezer", "Garage", "high", 14, "°F", { max: 10 }), "Garage freezer went above 10 °F: 14 °F");
  assert.equal(readingEvent("planter", "", "low", 12, "%", { min: 20 }), "Planter went below 20%: 12%");
  assert.equal(readingEvent("server.cpu.temp", "server", "stale", null, "°C", {}), "CPU temperature stopped reporting");
  assert.equal(readingEvent("desk-pc.disk.p.used", "desk-pc", "ok", 84, "%", { max: 90 }), "Disk P: back to normal: 84%");
  assert.equal(readingEvent("nas01.zfs.tank.healthy", "nas01", "low", 0, "", { min: 1 }), "Pool tank health: degraded");
});

test("a reading going out of bounds and back is written in its machine's history, one line while it flaps, and is not a change", () => {
  const t = makeHub();
  try {
    t.hub.store.create("sensor", { name: "desk-pc.disk.p.used", unit: "%", location: "desk-pc", max: 90, alert: true });
    t.hub.store.create("sensor", { name: "quiet", unit: "%", location: "desk-pc", max: 90, alert: false });
    const at = (min: number) => new Date(Date.UTC(2026, 10, 19, 20, min)).toISOString();
    const lines = () => t.hub.store.list({ kind: "journal" }).sort((a, b) => String(a.fields.at).localeCompare(String(b.fields.at))).map((j) => [j.fields.host, j.fields.what, j.fields.source, j.fields.at]);
    recordReading(t.hub, "desk-pc.disk.p.used", { value: 85, at: at(0) });
    recordReading(t.hub, "desk-pc.disk.p.used", { value: 91.2, at: at(1) });
    assert.deepEqual(lines(), [["desk-pc", "Disk P: went above 90%: 91.2%", "hub", at(1)]]);
    recordReading(t.hub, "desk-pc.disk.p.used", { value: 89, at: at(2) });
    recordReading(t.hub, "desk-pc.disk.p.used", { value: 92, at: at(3) });
    recordReading(t.hub, "quiet", { value: 99, at: at(4) });
    assert.deepEqual(lines(), [["desk-pc", "Disk P: went above 90%: 92% (it went back and forth)", "hub", at(3)]], "one line while it flaps, ending on how it is now; alerts off writes nothing");
    recordReading(t.hub, "desk-pc.disk.p.used", { value: 80, at: at(70 + 3) });
    assert.equal(lines().length, 2, "an hour later it is a line of its own");
    assert.equal(hostsSummary(t.hub.store).find((h) => h.host === "desk-pc")?.journal_entries ?? 0, 0, "not counted as a change");
    assert.equal((opsView(t.hub).journal_recent as unknown[]).length, 0, "not a recent change");
  } finally { t.cleanup(); }
});

test("an approved command the assistant marks as a lookup is journaled as one, unless it matches a destructive rule", async () => {
  const t = makeHub();
  try {
    fs.writeFileSync(path.join(t.dir, "hosts.json"), JSON.stringify([{ name: "laptop", ssh: "laptop", os: "macos" }]));
    t.hub.ai.hosts.forget();
    t.hub.ai.hosts.runner = async (_h: Host, _cmd: string): Promise<RunResult> => ({ exit_code: 0, output: "42", timed_out: false, ms: 1 });
    const host = t.hub.ai.hosts.host("laptop")!;
    const count = t.hub.ai.hosts.propose("s1", host, "find ~/Notes -name '*.md' | xargs cat | wc -w", "count words in the notes", null, true);
    const out = await t.hub.ai.hosts.approve(count.id);
    assert.equal(out.journal.fields.lookup, true);
    assert.equal(out.journal.fields.risk, "low");
    const rm = t.hub.ai.hosts.propose("s2", host, "rm -rf ~/Notes/old", "remove old notes", null, true);
    const out2 = await t.hub.ai.hosts.approve(rm.id);
    assert.equal(out2.journal.fields.lookup, undefined, "a delete is a change whatever the model says");
    assert.equal(out2.journal.fields.risk, "high");
    const change = t.hub.ai.hosts.propose("s3", host, "brew upgrade", "upgrade packages", null);
    assert.equal((await t.hub.ai.hosts.approve(change.id)).journal.fields.lookup, undefined);
  } finally { t.cleanup(); }
});

test("capture filing may write a line in a machine's History, and nothing else of Machines", async () => {
  const { availableTools, filingCheck } = await import("../src/ai/tools.js");
  const { filingPrompt } = await import("../src/capture-filer.js");
  const names = (on: (id: string) => boolean) => availableTools(null, undefined, filingCheck(on as never)).map((t) => t.name);
  const on = names(() => true);
  assert.ok(on.includes("journal_entry"));
  for (const t of ["run_command", "approve_command", "ops_status", "ops_action", "runbook_note", "list_hosts", "web_search", "reference_search"]) assert.ok(!on.includes(t), t);
  assert.ok(!names((m) => m !== "homelab").includes("journal_entry"), "not while Machines is off");
  assert.match(filingPrompt("replaced the fan on the nas", new Date()), /goes in that machine's History with journal_entry/);
  assert.doesNotMatch(filingPrompt("replaced the fan on the nas", new Date(), undefined, [], [], [], undefined, (m) => m !== "homelab"), /journal_entry/);
});
