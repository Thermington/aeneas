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

test("what a machine says it runs is kept from its readings", async () => {
  const { parseHostOs, hostSensorTick } = await import("../src/hostsensors.js");
  assert.equal(parseHostOs("cpu 3\nos Ubuntu 26.04 LTS\ndisk / 40"), "Ubuntu 26.04 LTS");
  assert.equal(parseHostOs("os UniFi Express 7, firmware 5.2.15\r\n"), "UniFi Express 7, firmware 5.2.15");
  assert.equal(parseHostOs("os QNAP TS-231K, firmware 5.2.10"), "QNAP TS-231K, firmware 5.2.10");
  assert.equal(parseHostOs("os Windows 11 Pro\r\nmem 33"), "Windows 11 Pro");
  assert.equal(parseHostOs("os UniFi Express 7, firmware "), "UniFi Express 7", "a firmware the device did not give is left off");
  assert.equal(parseHostOs("os \nos macOS "), null, "an empty answer is no OS");
  const t = makeHub();
  try {
    fs.writeFileSync(path.join(t.dir, "hosts.json"), JSON.stringify([{ name: "server", local: true }, { name: "gw", ssh: "root@10.0.0.1" }]));
    const run = async () => ({ code: 0, stdout: "cpu 5\nmem 40\ndisk / 30\nos UniFi Express 7, firmware 5.2.15\n", stderr: "" });
    await hostSensorTick(t.hub, run as never);
    const gw = ((await (await t.api("/ops")).json()) as { things: { name: string; os_name?: string }[] }).things.find((x) => x.name === "gw")!;
    assert.equal(gw.os_name, "UniFi Express 7, firmware 5.2.15");
  } finally { t.cleanup(); }
});

test("a Proxmox host's virtual machines and containers get readings of their own, as the guests report them", async () => {
  const { parseGuests, hostSensorTick } = await import("../src/hostsensors.js");
  const vm = (id: number, name: string, status: string, extra: Record<string, unknown> = {}) => `pvevm ${JSON.stringify({ vmid: id, name, status, cpu: 0.042, cpus: 4, ...extra })}`;
  const out = [
    "mem 33.2", "disk / 55", "os Proxmox VE 8.0.3",
    vm(102, "DC1", "running", { ballooninfo: { total_mem: 8_000_000_000, free_mem: 5_200_000_000 }, agent: 1 }),
    `pvefs 102 ${JSON.stringify([{ mountpoint: "C:\\", type: "NTFS", "total-bytes": 100, "used-bytes": 41 }, { mountpoint: "System Reserved", type: "NTFS", "total-bytes": 0, "used-bytes": 0 }])}`,
    `pveos 102 ${JSON.stringify({ "pretty-name": "Microsoft Windows Server 2022 Standard", name: "Microsoft Windows" })}`,
    vm(104, "DC2", "stopped"),
    vm(101, "dev", "running"),
    `pvelxc ${JSON.stringify([{ vmid: 200, name: "pihole", status: "running", cpu: 0.01, mem: 50, maxmem: 200, disk: 3, maxdisk: 10 }])}`,
  ].join("\n");
  const { guests, values } = parseGuests(out);
  assert.deepEqual(guests.map((g) => [g.name, g.state, g.container, g.os ?? null]), [["dc1", "running", false, "Windows Server 2022 Standard"], ["dc2", "stopped", false, null], ["dev", "running", false, null], ["pihole", "running", true, null]]);
  assert.deepEqual(values.map((v) => [v.name, v.value, v.location]), [
    ["dc1.cpu.used", 4.2, "dc1"], ["dc1.memory.used", 35, "dc1"], ["dc1.disk.c.used", 41, "dc1"],
    ["dev.cpu.used", 4.2, "dev"],
    ["pihole.cpu.used", 1, "pihole"], ["pihole.memory.used", 25, "pihole"], ["pihole.disk.root.used", 30, "pihole"],
  ], "memory only where the guest reports it; disks only from the guest agent or a container");
  const t = makeHub();
  try {
    fs.writeFileSync(path.join(t.dir, "hosts.json"), JSON.stringify([{ name: "server", local: true }, { name: "pve", ssh: "root@10.0.0.9" }, { name: "dev", ssh: "me@10.0.0.20" }]));
    const run = async (dest: string) => ({ code: 0, stdout: dest === "root@10.0.0.9" ? out : "cpu 1\nmem 2\n", stderr: "" });
    await hostSensorTick(t.hub, run as never);
    const things = ((await (await t.api("/ops")).json()) as { things: { name: string; sensors: string[]; vm_of?: string; vm_state?: string; os_name?: string }[] }).things;
    const dc1 = things.find((x) => x.name === "dc1")!;
    assert.deepEqual([dc1.vm_of, dc1.vm_state, dc1.os_name], ["pve", "running", "Windows Server 2022 Standard"]);
    assert.deepEqual(dc1.sensors.sort(), ["dc1.cpu.used", "dc1.disk.c.used", "dc1.memory.used"]);
    assert.ok(!t.hub.store.list({ kind: "sensor", limit: 1000 }).some((s) => String(s.fields.name).startsWith("dev.") && s.fields.location === "dev" && String(s.fields.name) === "dev.cpu.used" && s.fields.last_value === 4.2), "a guest the hub reads directly keeps its own readings");
  } finally { t.cleanup(); }
});

test("a device is a kind only with decent confidence from what it says about itself, else not identified", async () => {
  const { classify } = await import("../src/identify.js");
  const c = (s: Parameters<typeof classify>[0]) => { const r = classify(s); return [r.category ?? null, r.model ?? null]; };
  assert.deepEqual(c({ os: "Ubuntu 26.04 LTS" }), ["computer", null]);
  assert.deepEqual(c({ os: "UniFi Express 7, firmware 5.2.15" }), ["network", null]);
  assert.deepEqual(c({ vmOf: "pve" }), ["computer", null]);
  assert.deepEqual(c({ addedAs: "windows" }), ["computer", null]);
  assert.deepEqual(c({ open: [80, 443, 631, 9100], ipp: "HP LaserJet Pro M404" }), ["printer", "HP LaserJet Pro M404"], "a printer that names itself shows its model");
  assert.deepEqual(c({ open: [80, 9100] }), ["printer", null]);
  assert.deepEqual(c({ open: [80, 554], rtsp: "Hikvision RTSP Server", http: "Hikvision web" }), ["camera", null]);
  assert.deepEqual(c({ open: [22, 80], snmp: "UniFi Switch Lite 16 PoE, 7.1.26" }), ["network", null]);
  assert.deepEqual(c({ open: [53, 88, 389, 445, 3389] }), ["computer", null], "a domain controller");
  assert.deepEqual(c({ open: [22, 53, 80, 443, 8080, 8443], ssh: "SSH-2.0-OpenSSH_8.4p1 Debian-5+deb11u7", http: "UniFi OS" }), ["network", null], "a gateway: its title and DNS outweigh a Debian SSH server");
  assert.deepEqual(c({ open: [22, 443, 445, 8080], ssh: "SSH-2.0-OpenSSH_10.3" }), ["computer", null], "a NAS offers file sharing");
  assert.deepEqual(c({ open: [22, 8006], ssh: "SSH-2.0-OpenSSH_9.2p1 Debian-2+deb12u7" }), ["computer", null], "a Proxmox host");
  // Not sure enough, or two kinds close together: not identified.
  assert.deepEqual(c({ open: [443], http: "Login" }), [null, null]);
  assert.deepEqual(c({ open: [53, 80] }), [null, null], "DNS alone is not enough");
  assert.deepEqual(c({ open: [22], ssh: "SSH-2.0-OpenSSH_9.2p1 Debian-2" }), [null, null], "a Debian SSH server alone is not enough");
  assert.deepEqual(c({ open: [22, 631], ssh: "SSH-2.0-OpenSSH_9.6 Ubuntu-3" }), [null, null], "a computer sharing a printer is neither");
  assert.deepEqual(c({ open: [443], http: "UniFi Network" }), [null, null], "one web title alone is not sure enough");
  assert.deepEqual(c({}), [null, null]);
  const r = classify({ open: [53, 88, 389, 445, 3389] });
  assert.ok(r.confidence > 0.95 && r.facts.length >= 3, "the facts are kept, for the assistant");
});

test("the printer and SNMP questions are well formed and their answers are read", async () => {
  const { ippRequest, ippMakeAndModel, snmpRequest, snmpSysDescr } = await import("../src/identify.js");
  const req = ippRequest("10.0.0.30");
  assert.deepEqual([...req.subarray(0, 4)], [0x02, 0x00, 0x00, 0x0b], "IPP 2.0 Get-Printer-Attributes");
  assert.ok(req.includes(Buffer.from("printer-make-and-model")));
  const attr = (tag: number, name: string, value: string) => Buffer.concat([Buffer.from([tag]), Buffer.from([0, name.length]), Buffer.from(name), Buffer.from([0, value.length]), Buffer.from(value)]);
  const reply = Buffer.concat([Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01]), attr(0x47, "attributes-charset", "utf-8"), Buffer.from([0x04]), attr(0x41, "printer-make-and-model", "HP LaserJet Pro M404"), Buffer.from([0x03])]);
  assert.equal(ippMakeAndModel(reply), "HP LaserJet Pro M404");
  assert.equal(ippMakeAndModel(Buffer.from([0x02, 0x00])), undefined);
  const get = snmpRequest();
  assert.equal(get[0], 0x30);
  assert.ok(get.includes(Buffer.from("public")));
  const descr = Buffer.from("Brother HL-L2350DW series");
  const oid = Buffer.from([0x06, 0x08, 0x2b, 0x06, 0x01, 0x02, 0x01, 0x01, 0x01, 0x00]);
  const response = Buffer.concat([Buffer.from([0x30, 0x40, 0x02, 0x01, 0x01, 0x04, 0x06]), Buffer.from("public"), Buffer.from([0xa2, 0x30]), oid, Buffer.from([0x04, descr.length]), descr]);
  assert.equal(snmpSysDescr(response), "Brother HL-L2350DW series");
  assert.equal(snmpSysDescr(Buffer.from([0x30, 0x00])), undefined);
});

test("the daily pass asks only devices in Tech that the hub does not sign in to, once a day", async () => {
  const { identifyTick } = await import("../src/identify.js");
  const t = makeHub();
  try {
    fs.writeFileSync(path.join(t.dir, "hosts.json"), JSON.stringify([{ name: "server", local: true }, { name: "desk-pc", ssh: "me@desk-pc", os: "windows" }]));
    t.hub.store.create("monitor", { name: "office printer", type: "tcp", target: "10.0.0.30:9100", host: "office-printer", interval_s: 60 });
    t.hub.store.create("monitor", { name: "desk-pc ping", type: "ping", target: "10.0.0.5", host: "desk-pc", interval_s: 60 });
    t.hub.store.create("monitor", { name: "Blog", type: "tls", target: "https://blog.example.com", interval_s: 300 });
    const asked: string[] = [];
    const ask = async (h: string) => { asked.push(h); return { open: [80, 631, 9100], ipp: "HP LaserJet Pro M404" }; };
    const now = new Date("2026-11-20T12:00:00Z");
    assert.equal(await identifyTick(t.hub, now, ask), 1);
    assert.deepEqual(asked, ["10.0.0.30"], "a machine the hub signs in to and a web address are never asked");
    const things = ((await (await t.api("/ops")).json()) as { things: { name: string; category?: string; model?: string; evidence?: string }[] }).things;
    const printer = things.find((x) => x.name === "office-printer")!;
    assert.deepEqual([printer.category, printer.model, printer.evidence], ["printer", "HP LaserJet Pro M404", undefined], "the kind and model, never the facts");
    assert.equal(things.find((x) => x.name === "desk-pc")?.category, "computer");
    assert.equal(await identifyTick(t.hub, new Date(now.getTime() + 3600_000), ask), 0, "not again within the day");
    assert.equal(await identifyTick(t.hub, new Date(now.getTime() + 25 * 3600_000), ask), 1, "again the next day");
  } finally { t.cleanup(); }
});

test("a machine's purpose is its fact in Memory", async () => {
  const t = makeHub();
  try {
    t.hub.store.create("fact", { category: "host", key: "host:nas01", value: "TrueNAS box, backups and media", source: "user", confidence: 1 });
    t.hub.store.create("monitor", { name: "nas01 ping", type: "ping", target: "10.0.0.20", host: "nas01", interval_s: 60 });
    const things = ((await (await t.api("/ops")).json()) as { things: { name: string; purpose?: string }[] }).things;
    assert.equal(things.find((x) => x.name === "nas01")?.purpose, "TrueNAS box, backups and media");
  } finally { t.cleanup(); }
});
