import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addPerson, hubsState, listHubs, peopleSupported, requestResult, setupCommand, updatedWithOwner, wardPerson } from "../src/hubs.js";

/**
 * People on this machine on a Windows hub (deploy/windows/people.ps1): the same hub code with the Windows layout,
 * %ProgramData%\Aeneas, tried here under a temporary root with EA_PEOPLE_PLATFORM=win32.
 */
function windowsMachine(owner: string | null, people: unknown[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ea-people-win-"));
  const base = path.join(root, "ProgramData", "Aeneas");
  fs.mkdirSync(path.join(base, "requests"), { recursive: true });
  fs.mkdirSync(path.join(base, "results"), { recursive: true });
  if (owner !== null) fs.writeFileSync(path.join(base, "owner"), owner);
  fs.writeFileSync(path.join(base, "people.json"), JSON.stringify(people));
  process.env.EA_PEOPLE_ROOT = root;
  process.env.EA_PEOPLE_PLATFORM = "win32";
  return { root, base };
}
function done(root: string) {
  delete process.env.EA_PEOPLE_ROOT;
  delete process.env.EA_PEOPLE_PLATFORM;
  fs.rmSync(root, { recursive: true, force: true });
}
const me = os.userInfo().username;

test("windows people: Linux and Windows hubs take several people, a Mac hub one", () => {
  assert.equal(peopleSupported("linux"), true);
  assert.equal(peopleSupported("win32"), true);
  assert.equal(peopleSupported("darwin"), false);
});

test("windows people: the setup line asks Windows for permission and names the owner and the script beside the hub", () => {
  const line = setupCommand("win32", "D:\\AeneasHub\\app", "Jane Doe");
  assert.match(line, /^Start-Process powershell\.exe -Verb RunAs /);
  assert.ok(line.includes('-File "D:\\AeneasHub\\app\\deploy\\windows\\people.ps1" setup'), line);
  assert.ok(line.includes('-Owner "Jane Doe"'), line);
  assert.ok(line.includes('-Name "<your name>"'));
  // A quote in an account name cannot end the quoted argument early.
  assert.ok(setupCommand("win32", "C:\\h\\app", `o'ne"il`).includes('-Owner "oneil"'));
  assert.equal(setupCommand("linux", "/x", "sam"), "sudo bash ~/everythingapp/deploy/people.sh setup --name <your name>");
});

test("windows people: the owner file and list live in ProgramData; the owner is matched without regard to case", async () => {
  const { root, base } = windowsMachine(null);
  try {
    assert.deepEqual(hubsState(), { available: false, reason: "not_set_up" });
    // people.ps1 writes the owner file as UTF-8; a byte order mark from an editor does not change who owns it.
    fs.writeFileSync(path.join(base, "owner"), `\uFEFF${me.toUpperCase()}\r\n`);
    fs.writeFileSync(path.join(base, "people.json"), JSON.stringify([
      { name: "Robin", user: me, port: 8787, color: "#2f8f83", owner: true, address: "" },
      { name: "Mom", user: "aeneas-mom", port: 8788, color: "#c27c2c", owner: false, address: "" },
    ]));
    assert.deepEqual(hubsState(), { available: true });
    assert.deepEqual((await listHubs()).map((h) => [h.name, h.account, h.owner, h.address]), [["Robin", me, true, null], ["Mom", "aeneas-mom", false, null]]);
    assert.equal(updatedWithOwner(), null, "the owner's own hub follows nobody");

    const { request_id } = addPerson({ name: "Mary O'Neil" });
    const dropped = JSON.parse(fs.readFileSync(path.join(base, "requests", `${request_id}.json`), "utf8"));
    assert.deepEqual(dropped, { id: request_id, op: "add", name: "Mary O'Neil", color: "" });
    assert.deepEqual(requestResult(request_id), { state: "queued" });
    fs.rmSync(path.join(base, "requests", `${request_id}.json`));
    fs.writeFileSync(path.join(base, "results", `${request_id}.json`), JSON.stringify({ state: "done", name: "Mary O'Neil" }));
    assert.equal(requestResult(request_id).state, "done");

    const ward = wardPerson("aeneas-mom", "Robin", "a".repeat(64));
    const w = JSON.parse(fs.readFileSync(path.join(base, "requests", `${ward.request_id}.json`), "utf8"));
    assert.deepEqual([w.op, w.name, w.helper, w.hash], ["ward", "Mom", "Robin", "a".repeat(64)]);
  } finally { done(root); }
});

test("windows people: a person's hub follows the owner's updates; a folder the owner may not write to says to run setup", () => {
  const { root, base } = windowsMachine("someone-else", [
    { name: "Robin", user: "someone-else", port: 8787, owner: true },
    { name: "Me", user: me.toUpperCase(), port: 8790 },
  ]);
  try {
    assert.equal(updatedWithOwner(), "Robin");
    assert.equal(hubsState().reason, "not_owner");
  } finally { done(root); }
  const second = windowsMachine(me, [{ name: "Robin", user: me, port: 8787, owner: true }]);
  try {
    // On Windows a folder's permissions decide; here the folder is simply not there.
    fs.rmSync(path.join(second.base, "requests"), { recursive: true });
    assert.throws(() => addPerson({ name: "Alex" }), (e: { status?: number; message?: string }) => e.status === 409 && /people\.(sh|ps1)|setup/.test(String(e.message)));
  } finally { done(second.root); }
});
