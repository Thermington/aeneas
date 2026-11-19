import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeHub, deviceKey, TOKEN, type TestHub } from "./helpers.js";
import { DeviceKeys } from "../src/devicekeys.js";
import { helpedHosts, helpingView, offerHelp, stopHelping } from "../src/helping.js";

/** A machine with two hubs: the owner's (the helper) and Mom's, as People on this machine sets them up. */
async function family() {
  const helper = makeHub();
  const mom = makeHub();
  helper.hub.profile.set({ name: "Robin" });
  mom.hub.profile.set({ name: "Mom" });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ea-people-"));
  fs.mkdirSync(path.join(root, "etc/aeneas"), { recursive: true });
  fs.mkdirSync(path.join(root, "var/lib/aeneas/requests"), { recursive: true });
  fs.mkdirSync(path.join(root, "var/lib/aeneas/results"), { recursive: true });
  fs.writeFileSync(path.join(root, "etc/aeneas/owner"), os.userInfo().username);
  fs.writeFileSync(path.join(root, "etc/aeneas/people.json"), JSON.stringify([
    { name: "Robin", user: os.userInfo().username, port: 8787, owner: true },
    { name: "Mom", user: "aeneas-mom", port: 8790 },
  ]));
  const before = process.env.EA_PEOPLE_ROOT;
  process.env.EA_PEOPLE_ROOT = root;
  // The helper's hub reaches Mom's on 127.0.0.1:8790: here, her app in the same process.
  helper.hub.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    assert.equal(u.host, "127.0.0.1:8790");
    return mom.app.request(u.pathname + u.search, init);
  }) as typeof fetch;
  // What people.sh ward does with a request: the offer, with Mom's main key.
  const serveRequests = async () => {
    const dir = path.join(root, "var/lib/aeneas/requests");
    for (const f of fs.readdirSync(dir)) {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      fs.rmSync(path.join(dir, f));
      assert.equal(r.op, "ward");
      assert.ok(!JSON.stringify(r).includes("eah1_"), "no key in the request, only its hash");
      const res = await mom.api("/helpers/offer", { method: "POST", json: { name: r.helper, key_hash: r.hash } });
      assert.equal(res.status, 200);
    }
  };
  const momPhone = await deviceKey(mom, "Mom's iPhone", "iphone");
  const momPc = await deviceKey(mom, "Mom's PC", "windows");
  const as = (key: string) => (p: string, init: RequestInit & { json?: unknown } = {}) =>
    mom.app.request(p, { ...init, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...((init.headers as Record<string, string>) ?? {}) }, ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}) });
  return {
    helper, mom, serveRequests, phone: as(momPhone), pc: as(momPc),
    done: () => { helper.cleanup(); mom.cleanup(); fs.rmSync(root, { recursive: true, force: true }); if (before === undefined) delete process.env.EA_PEOPLE_ROOT; else process.env.EA_PEOPLE_ROOT = before; },
  };
}

/** Mom's computer as its Aeneas app is: it asks for work and answers each job with `answer`. */
function fakeAgent(pc: (p: string, init?: RequestInit & { json?: unknown }) => Response | Promise<Response>, answer: (command: string) => { exit_code: number; output: string }) {
  let stop = false;
  const seen: string[] = [];
  const loop = (async () => {
    while (!stop) {
      const r = await (await pc("/agent/jobs?wait=1")).json() as { jobs: { id: string; command: string }[] };
      for (const j of r.jobs) {
        seen.push(j.command);
        await pc(`/agent/jobs/${j.id}`, { method: "POST", json: answer(j.command) });
      }
      if (!r.jobs.length) await new Promise((res) => setTimeout(res, 20));
    }
  })();
  return { seen, stop: async () => { stop = true; await loop; } };
}

test("invitations: up to 3 days, kept on disk through a restart, used once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-invite-"));
  try {
    const file = path.join(dir, "device-keys.json");
    const t0 = Date.parse("2026-11-19T12:00:00Z");
    const a = new DeviceKeys(file);
    const inv = a.newCode("Mom's phone", t0, undefined, 3 * 24 * 3_600_000);
    assert.equal(inv.expires_at, "2026-11-22T12:00:00.000Z");
    assert.ok(!fs.readFileSync(file, "utf8").includes(inv.code), "only the code's hash is stored");
    const later = new DeviceKeys(file); // the hub restarted
    assert.equal(later.invitesWaiting(t0 + 3_600_000).length, 1);
    assert.deepEqual(later.claim(inv.code, t0 + 2 * 24 * 3_600_000), { name: "Mom's phone" });
    assert.equal(later.claim(inv.code, t0 + 2 * 24 * 3_600_000), null, "once");
    const old = later.newCode("x", t0, undefined, 30 * 24 * 3_600_000);
    assert.equal(old.expires_at, "2026-11-22T12:00:00.000Z", "never more than 3 days");
    assert.equal(later.claim(old.code, t0 + 4 * 24 * 3_600_000), null, "expired");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("invitations: a long one only with the main key; a device's code stays 10 minutes", async () => {
  const t = makeHub();
  try {
    const owner = await (await t.api("/devices/pairing", { method: "POST", json: { name: "Mom's phone", days: 3 } })).json() as { expires_at: string };
    assert.ok(Date.parse(owner.expires_at) - Date.now() > 2.9 * 24 * 3_600_000);
    const key = await deviceKey(t);
    const dev = await (await t.app.request("/devices/pairing", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ name: "x", days: 3 }) })).json() as { expires_at: string };
    assert.ok(Date.parse(dev.expires_at) - Date.now() <= 10 * 60_000);
  } finally { t.cleanup(); }
});

test("helping: an offer waits for Mom's yes, then her computer is a machine for the helper's assistant, logged for her", async () => {
  const f = await family();
  try {
    offerHelp(f.helper.hub, "aeneas-mom");
    await f.serveRequests();
    assert.equal((await helpingView(f.helper.hub))[0].state, "waiting");
    // Mom sees the offer, and her app lets the helper use her computer.
    const offers = await (await f.phone("/helpers")).json() as { helpers: { id: string; name: string; state: string }[] };
    assert.deepEqual(offers.helpers.map((h) => [h.name, h.state]), [["Robin", "offered"]]);
    assert.equal((await f.pc("/agent/me", { method: "PUT", json: { on: true, os: "windows", name: "PC" } })).status, 200);
    // Before her yes the computer gives the helper nothing.
    assert.equal((await f.pc("/agent/jobs")).status, 200);
    assert.equal(helpedHosts().length, 0);
    await f.phone(`/helpers/${offers.helpers[0].id}/accept`, { method: "POST" });
    const agent = fakeAgent(f.pc, (cmd) => ({ exit_code: 0, output: cmd.startsWith("Get-Process") ? "chrome 3100 MB" : `ran ${cmd}` }));
    try {
      const view = await helpingView(f.helper.hub);
      assert.equal(view[0].state, "helping");
      const host = helpedHosts()[0];
      assert.equal(host.name, "Mom's computer");
      assert.equal(f.helper.hub.ai.hosts.host("mom's computer")?.name, "Mom's computer");
      // A read runs at once through her hub and her app.
      const read = await f.helper.hub.ai.hosts.runRead("s1", host, "Get-Process | Sort-Object WS -Descending | Select-Object -First 5", "Looked at why your computer is slow");
      assert.equal(read.exit_code, 0);
      assert.match(read.output, /chrome 3100 MB/);
      // A change waits for the helper's own yes, and its secret is filled in on Mom's hub, never on the helper's.
      await f.phone("/helpers/passwords", { method: "PUT", json: { title: "My computer", username: "mom", password: "Hunter-22!" } });
      const pending = f.helper.hub.ai.hosts.propose("s1", host, "Set-Thing -Password {{secret:My computer}}", "Fixed the slow start", null);
      const done = await f.helper.hub.ai.hosts.approve(pending.id);
      assert.equal(done.result.exit_code, 0);
      assert.ok(agent.seen.some((c) => c.includes("'Hunter-22!'")), "her app got the password, quoted for PowerShell");
      assert.ok(!done.result.output.includes("Hunter-22!"), done.result.output);
      assert.match(done.result.output, /\[secret\]/);
      // Mom reads it all in plain words.
      const log = (await (await f.phone("/helpers")).json() as { log: { kind: string; text: string; device: string | null }[] }).log;
      assert.ok(log.some((l) => l.kind === "check" && l.text === "Looked at why your computer is slow" && l.device === "PC"));
      assert.ok(log.some((l) => l.kind === "change" && l.text === "Fixed the slow start"));
      assert.ok(!JSON.stringify(log).includes("Hunter-22!"));
    } finally { await agent.stop(); }
  } finally { f.done(); }
});

test("helping: the helper key opens the helper's routes and nothing else; Stop helping ends it at once", async () => {
  const f = await family();
  try {
    offerHelp(f.helper.hub, "aeneas-mom");
    // Before the machine's root service delivers it, the offer is not there: offer again, not stopped.
    assert.equal((await helpingView(f.helper.hub))[0].state, "not_sent");
    await f.serveRequests();
    const key = f.helper.hub.connections.get().helping![0].key;
    const asHelper = (p: string, method = "GET") => f.mom.app.request(p, { method, headers: { authorization: `Bearer ${key}` } });
    assert.equal((await asHelper("/warden/me")).status, 403, "not before her yes");
    const offers = await (await f.phone("/helpers")).json() as { helpers: { id: string }[] };
    await f.phone(`/helpers/${offers.helpers[0].id}/accept`, { method: "POST" });
    assert.equal((await asHelper("/warden/me")).status, 200);
    for (const p of ["/entities?kind=note", "/helpers", "/sync/changes?since=0", "/chats"]) assert.equal((await asHelper(p)).status, 401, p);
    assert.equal((await f.pc("/helpers/offer", { method: "POST", json: { name: "Evil", key_hash: "a".repeat(64) } })).status, 403, "only the main key offers");
    // Mom stops it.
    await f.phone(`/helpers/${offers.helpers[0].id}/stop`, { method: "POST" });
    assert.equal((await asHelper("/warden/me")).status, 401);
    assert.equal((await helpingView(f.helper.hub))[0].state, "stopped");
    // The helper forgets it too.
    await stopHelping(f.helper.hub, "aeneas-mom");
    assert.equal((f.helper.hub.connections.get().helping ?? []).length, 0);
  } finally { f.done(); }
});

test("helping: a computer whose app is closed says so instead of hanging; the scan reaches the helper", async () => {
  const f = await family();
  try {
    offerHelp(f.helper.hub, "aeneas-mom");
    await f.serveRequests();
    const id = (await (await f.phone("/helpers")).json() as { helpers: { id: string }[] }).helpers[0].id;
    await f.phone(`/helpers/${id}/accept`, { method: "POST" });
    await f.pc("/agent/me", { method: "PUT", json: { on: true, os: "windows", name: "PC" } });
    await f.phone("/helpers/scan", { method: "POST", json: { network: "192.168.1.0/24", devices: [{ name: "HP printer", ip: "192.168.1.40", open: [80, 9100] }, { name: "bad", ip: "not an ip" }] } });
    const view = (await helpingView(f.helper.hub))[0];
    assert.deepEqual(view.scan?.devices.map((d) => d.name), ["HP printer"]);
    const r = await f.mom.hub.helpers.run(f.mom.hub.helpers.get(id)!, { device: (await (await f.phone("/helpers")).json() as { computers: { device_id: string }[] }).computers[0].device_id, command: "Get-Date", timeout_s: 5 });
    assert.equal(r.exit_code, -1);
    assert.match(r.output, /not reachable now|did not finish/);
  } finally { f.done(); }
});

void TOKEN;

test("helping: a storage box in Mom's home is signed in to over SSH from her computer, with the password she saved for it", async () => {
  const f = await family();
  try {
    offerHelp(f.helper.hub, "aeneas-mom");
    await f.serveRequests();
    const id = (await (await f.phone("/helpers")).json() as { helpers: { id: string }[] }).helpers[0].id;
    await f.phone(`/helpers/${id}/accept`, { method: "POST" });
    await f.pc("/agent/me", { method: "PUT", json: { on: true, os: "windows", name: "PC" } });
    await f.phone("/helpers/scan", { method: "POST", json: { devices: [{ name: "attic", ip: "192.168.1.6", open: [22, 445, 8080], kind: "storage box (NAS) or file server" }, { name: "This computer", ip: "192.168.1.20", open: [22, 445] }] } });
    await f.phone("/helpers/passwords", { method: "PUT", json: { title: "The storage box", username: "admin", password: "Nas-Pass-9", device: "192.168.1.6" } });
    const jobs: { command: string; ssh?: { ip: string; username: string; password: string; host_key?: string } }[] = [];
    let key = "SHA256:AAAAbbbbCCCCddddEEEEffffGGGGhhhhIIIIjjjjKKKK";
    let stop = false;
    const loop = (async () => {
      while (!stop) {
        const r = await (await f.pc("/agent/jobs?wait=1")).json() as { jobs: (typeof jobs[number] & { id: string })[] };
        for (const j of r.jobs) {
          jobs.push(j);
          await f.pc(`/agent/jobs/${j.id}`, { method: "POST", json: { exit_code: 0, output: `df on the box; password ${j.ssh?.password}`, host_key: key } });
        }
        if (!r.jobs.length) await new Promise((res) => setTimeout(res, 20));
      }
    })();
    try {
      await helpingView(f.helper.hub);
      const box = helpedHosts().find((h) => h.helper?.ip === "192.168.1.6");
      assert.ok(box, JSON.stringify(helpedHosts().map((h) => h.name)));
      assert.equal(box!.name, "Mom's attic (192.168.1.6)");
      assert.ok(!helpedHosts().some((h) => h.helper?.ip === "192.168.1.20"), "her own computer is not a second machine");
      const r = await f.helper.hub.ai.hosts.runRead("s2", box!, "df -h", "Checked the storage box's space");
      assert.equal(r.exit_code, 0);
      assert.equal(jobs[0].ssh?.ip, "192.168.1.6");
      assert.equal(jobs[0].ssh?.username, "admin");
      assert.equal(jobs[0].ssh?.password, "Nas-Pass-9");
      assert.equal(jobs[0].ssh?.host_key, undefined, "the first sign-in learns the key");
      assert.ok(!r.output.includes("Nas-Pass-9"), r.output);
      // The key it answered with is kept, and sent with every later sign-in.
      await f.helper.hub.ai.hosts.runRead("s2", box!, "uptime", "Checked how long the storage box has been on");
      assert.equal(jobs[1].ssh?.host_key, key);
      const log = (await (await f.phone("/helpers")).json() as { log: { device: string | null; text: string }[] }).log;
      assert.ok(log.some((l) => l.device === "attic (192.168.1.6), through PC" && l.text === "Checked the storage box's space"));
      // Not a home address: refused.
      const pcId = (await (await f.phone("/helpers")).json() as { computers: { device_id: string }[] }).computers[0].device_id;
      await assert.rejects(f.mom.hub.helpers.run(f.mom.hub.helpers.get(id)!, { device: pcId, command: "id", target: { ip: "8.8.8.8" } }), /home network/);
      key = "unused";
    } finally { stop = true; await loop; }
  } finally { f.done(); }
});
