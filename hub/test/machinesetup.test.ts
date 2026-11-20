import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ssh2 from "ssh2";
import { deviceKey, makeHub } from "./helpers.js";
import { adoptComputer, hostKeysOf, hubPublicKey, knownHostsLine, parseInstall, posixInstall, setupMachineAccess, windowsInstall } from "../src/machinesetup.js";
import { techThings } from "../src/tech.js";
import { readMachines } from "../src/ai/hosts.js";

const { Server, utils } = ssh2;

test("the install steps and their answers", () => {
  const pub = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample aeneas-hub@server";
  assert.match(posixInstall(pub), /grep -qxF 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample aeneas-hub@server' "\$HOME\/\.ssh\/authorized_keys"/);
  const ps = Buffer.from(windowsInstall(pub).split(" ").at(-1)!, "base64").toString("utf16le");
  assert.match(ps, /administrators_authorized_keys/);
  assert.match(ps, /icacls \$f \/inheritance:r/);
  assert.deepEqual(parseInstall("ok=1\nkernel=Linux\nhost=NAS01\n"), { ok: true, os: "linux", host: "nas01" });
  assert.deepEqual(parseInstall("ok=1\r\nkernel=Windows\r\nhost=DESK-PC\r\n"), { ok: true, os: "windows", host: "desk-pc" });
  assert.deepEqual(parseInstall("kernel=Darwin\nhost=laptop"), { ok: false, os: "macos", host: "laptop" });
  const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 1, 7])]);
  assert.equal(knownHostsLine("10.0.0.5", blob), `10.0.0.5 ssh-ed25519 ${blob.toString("base64")}`);
  assert.equal(knownHostsLine("10.0.0.5", blob, 2222), `[10.0.0.5]:2222 ssh-ed25519 ${blob.toString("base64")}`);
});

/** An SSH server that takes one password, then only the keys put in its authorized list, and acts as a Linux shell. */
function fakeMachine(dir: string, opts: { keysOnly?: boolean; keyboard?: boolean } = {}) {
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(dir, "hostkey")]);
  const authorized: string[] = [];
  const seen = { password: 0, key: 0 };
  const server = new Server({ hostKeys: [fs.readFileSync(path.join(dir, "hostkey"))] }, (client) => {
    // A client that drops the connection (a host key it does not trust) is not the fake machine's failure.
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      const methods: ssh2.AuthenticationType[] = opts.keysOnly ? ["publickey"] : opts.keyboard ? ["publickey", "keyboard-interactive"] : ["password", "publickey"];
      if (ctx.method === "password" && !opts.keysOnly && !opts.keyboard && ctx.username === "me" && ctx.password === "right") { seen.password++; return ctx.accept(); }
      if (ctx.method === "keyboard-interactive" && opts.keyboard && ctx.username === "me") {
        return ctx.prompt([{ prompt: "Password: ", echo: false }], (answers) => { if (answers[0] === "right") { seen.password++; ctx.accept(); } else ctx.reject(methods); });
      }
      if (ctx.method === "publickey" && ctx.username === "me") {
        const match = authorized.map((k) => utils.parseKey(k)).find((k) => !(k instanceof Error) && (k as ssh2.ParsedKey).getPublicSSH().equals(ctx.key.data)) as ssh2.ParsedKey | undefined;
        if (match && (!ctx.signature || match.verify(ctx.blob!, ctx.signature, ctx.hashAlgo))) { if (ctx.signature) seen.key++; return ctx.accept(); }
      }
      ctx.reject(methods);
    });
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("exec", (ok, _no, info) => {
        const stream = ok();
        const cmd = info.command;
        if (cmd === "echo %OS%") stream.write("%OS%\n");
        else if (cmd.includes("authorized_keys")) {
          const key = /grep -qxF '([^']+)'/.exec(cmd)?.[1];
          if (key && !authorized.includes(key)) authorized.push(key);
          stream.write("ok=1\nkernel=Linux\nhost=testbox\n");
        } else if (cmd === "echo ok") stream.write("ok\n");
        stream.exit(0);
        stream.end();
      });
    }));
  });
  return new Promise<{ port: number; authorized: string[]; seen: typeof seen; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as { port: number }).port, authorized, seen, close: () => server.close() }));
  });
}

test("Add machine signs in once with the password, puts the hub's key there, checks it and adds the machine", { skip: process.platform === "win32" }, async () => {
  const t = makeHub();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-setup-"));
  const before = process.env.EA_SSH_DIR;
  process.env.EA_SSH_DIR = path.join(dir, "ssh");
  const m = await fakeMachine(dir);
  try {
    await assert.rejects(setupMachineAccess(t.hub, { address: "127.0.0.1", port: m.port, user: "me", password: "wrong" }), /did not accept that user name and password/);
    assert.equal(m.authorized.length, 0);

    const out = await setupMachineAccess(t.hub, { address: "127.0.0.1", port: m.port, user: "me", password: "right" });
    assert.deepEqual(out, { machine: { name: "testbox", ssh: "me@127.0.0.1", os: "linux" }, created: true });
    assert.equal(m.authorized.length, 1, "the hub's key is on the machine");
    assert.match(m.authorized[0], /^ssh-ed25519 \S+ aeneas-hub@/, "a key the hub made for itself");
    assert.ok(m.seen.key >= 1, "and signing in with it worked before the machine was added");
    assert.match(fs.readFileSync(path.join(dir, "ssh", "known_hosts"), "utf8"), new RegExp(`^\\[127\\.0\\.0\\.1\\]:${m.port} ssh-ed25519 `, "m"), "the host key as seen at that sign-in");
    assert.deepEqual(readMachines(t.hub.cfg)?.find((x) => x.name === "testbox"), { name: "testbox", ssh: "me@127.0.0.1", os: "linux" });

    const again = await setupMachineAccess(t.hub, { address: "127.0.0.1", port: m.port, user: "me", password: "right", name: "Other Name" });
    assert.equal(again.created, false, "the same account again updates it, no second machine");
    assert.equal(m.authorized.length, 1, "and the key is not added twice");
    assert.ok(!JSON.stringify(readMachines(t.hub.cfg)).includes("right"), "the password is not kept");
  } finally {
    m.close();
    if (before === undefined) delete process.env.EA_SSH_DIR; else process.env.EA_SSH_DIR = before;
    fs.rmSync(dir, { recursive: true, force: true });
    t.cleanup();
  }
});

test("Add machine says plainly when sign-in is off on that machine, and checks what it is given", async () => {
  const t = makeHub();
  try {
    const free = await new Promise<number>((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
    await assert.rejects(setupMachineAccess(t.hub, { address: "127.0.0.1", port: free, user: "me", password: "x" }), /Remote Login.*OpenSSH Server.*openssh-server/s);
    await assert.rejects(setupMachineAccess(t.hub, { address: "nas; rm -rf /", user: "me", password: "x" }), /the address is a name or an IP address/);
    await assert.rejects(setupMachineAccess(t.hub, { address: "nas", user: "me$(id)", password: "x" }), /the user name/);
    const res = await t.api("/machines/setup", { method: "POST", json: { address: "nas", user: "me" } });
    assert.equal(res.status, 422);
  } finally { t.cleanup(); }
});

test("the assistant adds a machine only with a password manager item, and only after the owner approves", async () => {
  const { runTool } = await import("../src/ai/tools.js");
  const { ctxFor } = await import("./ai-helpers.js");
  const t = makeHub();
  try {
    const api = async (method: string, p: string, body?: unknown) => {
      const res = await t.api(p, { method, ...(body !== undefined ? { json: body } : {}) });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const calls: unknown[] = [];
    t.hub.ai.hosts.setupMachine = async (req) => { calls.push(req); return { machine: { name: "nas01", ssh: `${req.user}@${req.address}`, os: "linux" } }; };
    const result = async (args: Record<string, unknown>, session: string) => JSON.parse(((await runTool(api as never, { name: "add_machine", arguments: args }, ctxFor(t, session))) as { text: string }).text) as { error?: string; status?: string };
    const none = await result({ address: "10.0.0.20", user: "admin" }, "a1");
    assert.match(String(none.error), /password manager item/, "no password in chat: a password manager item or Add machine");
    const asked = await result({ address: "10.0.0.20", user: "admin", password_item: "Tech/NAS admin" }, "a2");
    assert.equal(asked.status, "waiting_for_approval");
    assert.equal(calls.length, 0, "nothing happens before the owner's yes");
    const pending = t.hub.ai.hosts.pendingFor("a2")!;
    assert.equal(pending.kind, "setup");
    assert.match(pending.command, /admin@10\.0\.0\.20.*\{\{secret:Tech\/NAS admin\}\}/);
    const out = await t.hub.ai.hosts.approve(pending.id);
    assert.deepEqual(calls, [{ address: "10.0.0.20", user: "admin", secret: "Tech/NAS admin" }]);
    assert.equal(out.result.exit_code, 0);
    assert.deepEqual([out.journal.fields.host, out.journal.fields.outcome], ["nas01", "done"], "its History says it was set up");
    t.hub.ai.hosts.setupMachine = async () => { throw new Error("10.0.0.21 did not accept that user name and password"); };
    await runTool(api as never, { name: "add_machine", arguments: { address: "10.0.0.21", user: "admin", password_item: "Tech/Other" } }, ctxFor(t, "a3"));
    await assert.rejects(t.hub.ai.hosts.approve(t.hub.ai.hosts.pendingFor("a3")!.id), /did not accept/);
  } finally { t.cleanup(); }
});

test("a computer whose app put the hub's key there is added only when it shows the host key the app read", { skip: process.platform === "win32" }, async () => {
  const t = makeHub();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-adopt-"));
  const before = process.env.EA_SSH_DIR;
  process.env.EA_SSH_DIR = path.join(dir, "ssh");
  const m = await fakeMachine(dir);
  try {
    m.authorized.push(await hubPublicKey());
    const own = fs.readFileSync(path.join(dir, "hostkey.pub"), "utf8").trim();
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(dir, "otherkey")]);
    const other = fs.readFileSync(path.join(dir, "otherkey.pub"), "utf8").trim();
    assert.deepEqual(hostKeysOf([own, "not a key", own]), [own.split(" ").slice(0, 2).join(" ")], "keys are checked and kept once, without their comment");

    await assert.rejects(adoptComputer(t.hub, { name: "desk-pc", user: "me", os: "linux", host_keys: [other], addresses: ["127.0.0.1"], port: m.port }), /could not sign in to desk-pc at 127\.0\.0\.1/, "another computer's host key: not this one");
    assert.equal(readMachines(t.hub.cfg)?.length ?? 0, 0);

    fs.mkdirSync(path.join(dir, "ssh"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ssh", "known_hosts"), `[127.0.0.1]:${m.port} ${other}\nelsewhere ${other}\n`);
    const out = await adoptComputer(t.hub, { name: "Desk-PC", user: "me", os: "linux", host_keys: [own], addresses: ["nothing-here.invalid", "127.0.0.1"], port: m.port });
    assert.deepEqual(out, { machine: { name: "desk-pc", ssh: "me@127.0.0.1", os: "linux" }, created: true });
    const known = fs.readFileSync(path.join(dir, "ssh", "known_hosts"), "utf8");
    assert.ok(known.includes(`[127.0.0.1]:${m.port} ${own.split(" ").slice(0, 2).join(" ")}`), "the key the computer gave is kept for that address");
    assert.ok(!known.includes(`[127.0.0.1]:${m.port} ${other}`), "and the stale one for that address goes");
    assert.ok(known.includes(`elsewhere ${other}`), "other machines' lines stay");
    await assert.rejects(adoptComputer(t.hub, { name: "desk-pc", user: "me", os: "linux", host_keys: [own], addresses: ["10.9.9.9"], port: m.port }), /already one of the hub's machines/);
    await assert.rejects(adoptComputer(t.hub, { name: "x", user: "me", os: "linux", host_keys: [], addresses: ["127.0.0.1"] }), /host keys are needed/);
  } finally {
    m.close();
    if (before === undefined) delete process.env.EA_SSH_DIR; else process.env.EA_SSH_DIR = before;
    fs.rmSync(dir, { recursive: true, force: true });
    t.cleanup();
  }
});

test("a computer's app reports it: readings and OS under its name, never over the hub's own or another device's", async () => {
  const t = makeHub();
  try {
    t.hub.modules.set({ homelab: true, sensors: true });
    const key = await deviceKey(t, "Desk PC", "windows");
    const put = (k: string, body: unknown) => t.app.request("/devices/me/computer", { method: "PUT", headers: { authorization: `Bearer ${k}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const output = "cpu 12.5\r\nos Windows 11 Pro\r\nmem 41.2\r\ndisk C 63.1\r\ndisk D 91.4\r\ngpu 0, 55, 2048, 8192\r\n";
    const res = await put(key, { name: "DESK-PC", output });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { name: "desk-pc", read_by_hub: false, kept: 6 });
    const thing = techThings(t.hub).find((x) => x.name === "desk-pc")!;
    assert.equal(thing.kind, "machine");
    assert.equal(thing.reports_itself, true);
    assert.equal(thing.os_name, "Windows 11 Pro");
    assert.deepEqual(thing.sensors.sort(), ["desk-pc.cpu.used", "desk-pc.disk.c.used", "desk-pc.disk.d.used", "desk-pc.gpu0.temp", "desk-pc.gpu0.vram", "desk-pc.memory.used"]);
    const d = t.hub.store.list({ kind: "sensor", limit: 100 }).find((s) => s.fields.name === "desk-pc.disk.d.used")!;
    assert.equal(d.fields.state, "high", "a full disk alerts as on any machine");

    const other = await deviceKey(t, "Laptop", "windows");
    assert.equal((await put(other, { name: "desk-pc", output })).status, 409, "another device does not report under that name");
    assert.equal((await t.api("/devices/me/computer", { method: "PUT", json: { name: "desk-pc", output } })).status, 400, "only a device's own key");
    assert.equal((await put(key, { name: "bad name!", output })).status, 422);

    fs.writeFileSync(path.join(t.hub.cfg.dataDir, "hosts.json"), JSON.stringify([{ name: "nas01", ssh: "admin@10.0.0.5", os: "linux" }]));
    t.hub.ai.hosts.forget();
    assert.deepEqual(await (await put(other, { name: "nas01", output })).json(), { name: "nas01", read_by_hub: true, kept: 0 }, "the hub's own readings win");
    assert.equal(t.hub.store.list({ kind: "sensor", limit: 100 }).filter((s) => String(s.fields.name).startsWith("nas01.")).length, 0);
  } finally { t.cleanup(); }
});

test("Add machine tells a machine that takes only keys from a wrong password, and types the password into a prompt", { skip: process.platform === "win32" }, async () => {
  const t = makeHub();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-keys-"));
  const before = process.env.EA_SSH_DIR;
  process.env.EA_SSH_DIR = path.join(dir, "ssh");
  try {
    fs.mkdirSync(path.join(dir, "a"));
    fs.mkdirSync(path.join(dir, "b"));
    const k = await fakeMachine(path.join(dir, "a"), { keysOnly: true });
    await assert.rejects(setupMachineAccess(t.hub, { address: "127.0.0.1", port: k.port, user: "me", password: "right" }), /takes no passwords for SSH sign-in, only keys/);
    k.close();
    const kb = await fakeMachine(path.join(dir, "b"), { keyboard: true });
    await assert.rejects(setupMachineAccess(t.hub, { address: "127.0.0.1", port: kb.port, user: "me", password: "wrong" }), /did not accept that user name and password/);
    const out = await setupMachineAccess(t.hub, { address: "127.0.0.1", port: kb.port, user: "me", password: "right" });
    assert.equal(out.machine.name, "testbox");
    assert.equal(kb.seen.password, 1, "the password went into the machine's prompt");
    kb.close();
  } finally {
    if (before === undefined) delete process.env.EA_SSH_DIR; else process.env.EA_SSH_DIR = before;
    fs.rmSync(dir, { recursive: true, force: true });
    t.cleanup();
  }
});
