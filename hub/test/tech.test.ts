import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHub } from "./helpers.js";
import { targetHost, techThings, type Thing } from "../src/tech.js";

test("a check's host comes from its target when it names none", () => {
  assert.equal(targetHost("tcp", "pve2:8006"), "pve2");
  assert.equal(targetHost("http", "http://127.0.0.1:8787/health"), "127.0.0.1");
  assert.equal(targetHost("tls", "https://Blog.Example.com"), "blog.example.com");
  assert.equal(targetHost("backup", "linux:me@nas#verify"), "nas");
  assert.equal(targetHost("backup", "mac:laptop"), "laptop");
  assert.equal(targetHost("tcp", "[fd7a::1]:22"), "fd7a::1");
  assert.equal(targetHost("dns", "core.example.ts.net"), "core.example.ts.net");
});

test("every check and reading lands on one machine, service or place", async () => {
  const t = makeHub();
  try {
    fs.writeFileSync(path.join(t.dir, "hosts.json"), JSON.stringify([{ name: "core", local: true }, { name: "desk-pc", os: "windows", aliases: ["desk-pc-lan"] }]));
    const mon = (name: string, f: Record<string, unknown>) => t.hub.store.create("monitor", { name, interval_s: 60, ...f }).id;
    const deskPcPing = mon("desk-pc ping", { type: "ping", target: "10.0.0.5", host: "desk-pc" });
    const ollama = mon("Ollama", { type: "http", target: "http://desk-pc-lan:11434" });
    const proxmox = mon("pve2 Proxmox", { type: "tcp", target: "pve2:8006" });
    const blog = mon("Blog certificate", { type: "tls", target: "https://blog.example.com" });
    const coreTls = mon("Core certificate", { type: "tls", target: "https://core.example.ts.net:8787" });
    const laptop = mon("Studio backup", { type: "backup", target: "mac:laptop" });
    for (const [name, location] of [["core.cpu.used", "core"], ["garage_freezer", "Garage"], ["planter", ""], ["desk-pc.disk.c.used", "desk-pc"]]) {
      t.hub.store.create("sensor", { name, unit: "%", location: location || undefined, alert: true });
    }
    t.hub.store.create("runbook", { host: "Nas", title: "Fix notes: nas", body: "# nas\n", commands: [] });

    const things = techThings(t.hub);
    const by = (n: string): Thing => things.find((x) => x.name === n)!;
    assert.deepEqual(by("desk-pc").monitors.sort(), [deskPcPing, ollama].sort(), "a service on a machine is a check of that machine, by alias too");
    assert.deepEqual(by("desk-pc").sensors, ["desk-pc.disk.c.used"]);
    assert.equal(by("desk-pc").reachable, true);
    assert.equal(by("desk-pc").os, "windows");
    assert.deepEqual(by("core").monitors, [coreTls], "a machine's full name is that machine");
    assert.equal(by("core").hub, true);
    assert.deepEqual(by("core").sensors, ["core.cpu.used"]);
    assert.deepEqual([by("pve2").kind, by("pve2").monitors, by("pve2").reachable], ["machine", [proxmox], false], "a name with no dot is a machine, even one the hub cannot reach");
    assert.deepEqual([by("laptop").kind, by("laptop").monitors], ["machine", [laptop]]);
    assert.deepEqual([by("blog.example.com").kind, by("blog.example.com").monitors], ["service", [blog]], "a web address with no machine behind it is a service");
    assert.deepEqual([by("garage").kind, by("garage").label, by("garage").sensors], ["place", "Garage", ["garage_freezer"]]);
    assert.deepEqual([by("home").kind, by("home").label, by("home").sensors], ["place", "Home", ["planter"]], "a board with no place is at Home");
    assert.equal(by("nas").kind, "machine", "a machine with only fix notes still has a page");
    // Machines first, then services, then places; nothing counted twice.
    const kinds = things.map((x) => x.kind);
    assert.deepEqual(kinds, [...kinds].sort((a, b) => ["machine", "service", "place"].indexOf(a) - ["machine", "service", "place"].indexOf(b)));
    assert.equal(things.flatMap((x) => x.monitors).length, 6);
    assert.equal(things.flatMap((x) => x.sensors).length, 4);

    const ops = (await (await t.api("/ops")).json()) as { things: Thing[] };
    assert.deepEqual(ops.things.map((x) => x.name), things.map((x) => x.name), "GET /ops carries them");
  } finally { t.cleanup(); }
});

test("a check that is down: one chat where the assistant finds the cause and proposes a fix to approve", async () => {
  const t = makeHub();
  try {
    fs.writeFileSync(path.join(t.dir, "hosts.json"), JSON.stringify([{ name: "core", local: true }]));
    const m = t.hub.store.create("monitor", { name: "pve2 Proxmox", type: "tcp", target: "pve2:8006", host: "pve2", interval_s: 60, state: "up" });
    assert.equal((await t.api(`/monitors/${m.id}/propose`, { method: "POST" })).status, 409, "nothing to fix while it is up");
    t.hub.store.patch(m.id, { state: "down", last_error: "no connection within 5 s" });
    t.hub.store.create("incident", { monitor_id: m.id, name: "pve2 Proxmox", opened_at: "2026-11-19T20:00:00.000Z", last_error: "no connection within 5 s", checks_failed: 3, ack_note: "power cut at the rack" });
    const res = await t.api(`/monitors/${m.id}/propose`, { method: "POST" });
    assert.equal(res.status, 200);
    const { session_id, started } = (await res.json()) as { session_id: string; started: boolean };
    assert.equal(started, true);
    assert.match(session_id, /^alert-[0-9a-f]{8}-down-\d{8}$/);
    const s = (await (await t.api(`/ai/sessions/${session_id}`)).json()) as { title: string };
    assert.equal(s.title, "Alert: pve2 Proxmox down");
    for (let i = 0; i < 100 && t.hub.ai.working.has(session_id); i++) await new Promise((r) => setTimeout(r, 20));
    const done = t.hub.ai.sessions.get(session_id)!;
    assert.equal(done.messages[0].content, "pve2 Proxmox on pve2 is down: no connection within 5 s. Find the cause and propose a fix for me to approve.");
    assert.equal(done.messages.at(-1)!.role, "assistant");
    const again = (await (await t.api(`/monitors/${m.id}/propose`, { method: "POST" })).json()) as { session_id: string; started: boolean };
    assert.deepEqual(again, { session_id, started: false }, "tapping again the same day opens the same chat");
    assert.equal((await t.api("/monitors/nope/propose", { method: "POST" })).status, 404);
  } finally { t.cleanup(); }
});
