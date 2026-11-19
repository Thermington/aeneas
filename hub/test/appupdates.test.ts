import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { makeHub } from "./helpers.js";
import { AppReleases, assetName, appUpdateKey, setReleaseFetch, signatureOk, signedMessage } from "../src/appreleases.js";
import { parseApp } from "../src/devices.js";
import { VERSION } from "../src/hub.js";
import { appUpdateAsked, runTool, TOOLS, type ApiCall, type ToolContext } from "../src/ai/tools.js";

// A stand-in release key: the hub checks against EA_APP_UPDATE_KEY in tests.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUB = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
process.env.EA_APP_UPDATE_KEY = PUB;
after(() => { delete process.env.EA_APP_UPDATE_KEY; setReleaseFetch(null); });

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const signFor = (platform: "windows" | "android", version: string, file: Buffer, key = privateKey) =>
  sign(null, Buffer.from(signedMessage(platform, version, sha(file))), key).toString("base64");

/** GitHub as the hub sees it: the release page redirects to the file host, which answers the bytes. */
function fakeGitHub(files: Record<string, Buffer | string>, opts: { redirectTo?: string } = {}) {
  const seen: string[] = [];
  setReleaseFetch(async (url) => {
    seen.push(url);
    const u = new URL(url);
    if (u.hostname === "github.com") {
      const name = u.pathname.split("/").pop()!;
      if (!(name in files)) return new Response("Not Found", { status: 404 });
      return new Response(null, { status: 302, headers: { location: `https://${opts.redirectTo ?? "release-assets.githubusercontent.com"}/x/${name}` } });
    }
    const name = u.pathname.split("/").pop()!;
    const body = files[name];
    return body === undefined ? new Response("gone", { status: 404 }) : new Response(typeof body === "string" ? body : new Uint8Array(body), { status: 200 });
  });
  return seen;
}

test("the release key's signature fits one platform, version and file", () => {
  const file = Buffer.from("installer bytes");
  const sig = signFor("windows", "1.0.5", file);
  assert.equal(signatureOk("windows", "1.0.5", sha(file), sig), true);
  assert.equal(signatureOk("windows", "1.0.6", sha(file), sig), false, "another version");
  assert.equal(signatureOk("android", "1.0.5", sha(file), sig), false, "another platform");
  assert.equal(signatureOk("windows", "1.0.5", sha(Buffer.from("changed")), sig), false, "another file");
  const other = generateKeyPairSync("ed25519").privateKey;
  assert.equal(signatureOk("windows", "1.0.5", sha(file), signFor("windows", "1.0.5", file, other)), false, "another key");
  assert.equal(signatureOk("windows", "1.0.5", sha(file), "not base64 at all"), false);
});

test("the shipped release key is a 32-byte Ed25519 key", () => {
  const saved = process.env.EA_APP_UPDATE_KEY;
  delete process.env.EA_APP_UPDATE_KEY;
  try { assert.equal(Buffer.from(appUpdateKey(), "base64").length, 32); } finally { process.env.EA_APP_UPDATE_KEY = saved; }
});

test("an app reports its kind, its version and the Apple build", () => {
  assert.deepEqual(parseApp({ kind: "windows", version: "1.0.5" }), { kind: "windows", version: "1.0.5" });
  assert.deepEqual(parseApp({ kind: "ios", version: "1.0.5", build: "202611181809" }), { kind: "ios", version: "1.0.5", build: "202611181809" });
  assert.equal(parseApp({ kind: "windows", version: "1.0" }), null);
  assert.equal(parseApp({ kind: "toaster", version: "1.0.5" }), null);
  assert.equal(parseApp(undefined), null);
});

test("the hub fetches its release's installer once, checks the signature, and serves it", async () => {
  const t = makeHub();
  try {
    const file = Buffer.alloc(300_000, 7);
    const name = assetName("windows", VERSION);
    const seen = fakeGitHub({ [name]: file, [`${name}.sig`]: signFor("windows", VERSION, file) });
    const prep = await (await t.api("/app-updates/windows/prepare", { method: "POST" })).json() as { state: string; sha256: string };
    assert.equal(prep.state, "ready");
    assert.equal(prep.sha256, sha(file));
    assert.ok(seen.every((u) => u.startsWith("https://")) && seen.some((u) => u.includes(`/releases/download/v${VERSION}/${name}`)));
    const got = await t.api("/app-updates/windows/file");
    assert.equal(got.status, 200);
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), file);
    // A second ask fetches nothing: it is kept in the data folder, also for a new hub process.
    const before = seen.length;
    assert.equal((await new AppReleases(t.hub.cfg.dataDir).prepare("windows")).state, "ready");
    assert.equal(seen.length, before);
    const view = await (await t.api("/app-updates")).json() as { apps: Record<string, { state: string; signature?: string }> };
    assert.equal(view.apps.windows.state, "ready");
    assert.ok(view.apps.windows.signature, "the app gets the signature to check");
    assert.equal(view.apps.android.state, "missing");
  } finally { t.cleanup(); }
});

test("a changed installer, a missing release, and a redirect elsewhere are never served", async () => {
  const t = makeHub();
  try {
    const file = Buffer.from("real installer");
    const apk = assetName("android", VERSION);
    fakeGitHub({ [apk]: Buffer.from("something else"), [`${apk}.sig`]: signFor("android", VERSION, file) });
    const bad = await (await t.api("/app-updates/android/prepare", { method: "POST" })).json() as { state: string; error: string };
    assert.equal(bad.state, "failed");
    assert.match(bad.error, /signature/);
    assert.equal((await t.api("/app-updates/android/file")).status, 409);

    fakeGitHub({});
    const none = await (await t.api("/app-updates/windows/prepare", { method: "POST" })).json() as { state: string };
    assert.equal(none.state, "unpublished");

    const t2 = makeHub();
    try {
      const exe = assetName("windows", VERSION);
      fakeGitHub({ [exe]: file, [`${exe}.sig`]: signFor("windows", VERSION, file) }, { redirectTo: "evil.example.com" });
      const evil = await (await t2.api("/app-updates/windows/prepare", { method: "POST" })).json() as { state: string };
      assert.equal(evil.state, "failed");
    } finally { t2.cleanup(); }
    assert.equal((await t.api("/app-updates/linux/prepare", { method: "POST" })).status, 404);
  } finally { t.cleanup(); }
});

test("devices say which app they run; an update asked for reaches the Windows app and ends when it runs the new version", async () => {
  const t = makeHub();
  try {
    const pair = async (name: string, platform: string) => {
      const links = await (await t.api("/devices/pairing", { method: "POST", json: { name } })).json() as { code: string };
      const r = await t.app.request("/devices/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: links.code, name, platform }) });
      return await r.json() as { device_id: string; key: string };
    };
    const as = async (key: string, app: string, p: string, init: RequestInit = {}) => {
      const [kind, version, build] = app.replace(/[()]/g, "").split(" ");
      const report = await t.app.request("/devices/me/app", { method: "PUT", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ kind, version, ...(build ? { build } : {}) }) });
      assert.equal(report.status, 200);
      return p === "/status" ? report : t.app.request(p, { ...init, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) } });
    };
    const win = await pair("Gaming PC", "windows");
    const phone = await pair("iPhone", "iphone");
    const old = await pair("Old laptop", "windows");
    await as(win.key, "windows 1.0.0", "/status");
    await as(phone.key, "ios 1.0.0 (202611181809)", "/status");
    await t.app.request("/status", { headers: { authorization: `Bearer ${old.key}` } });

    type View = { devices: { id: string; outlook: string; app: { version: string } | null; app_update: { version: string; by?: string; declined_at?: string } | null }[]; you: { request: { version: string } | null } | null };
    const view = await (await t.api("/app-updates")).json() as View;
    const by = (id: string) => view.devices.find((d) => d.id === id)!;
    assert.equal(by(win.device_id).outlook, "self");
    assert.equal(by(phone.device_id).outlook, "store");
    assert.equal(by(old.device_id).outlook, "unknown");

    fakeGitHub({});
    const asked = await (await as(phone.key, "ios 1.0.0 (202611181809)", "/app-updates/request", { method: "POST", body: JSON.stringify({}) })).json() as { devices: { id: string; result: string }[] };
    const result = (id: string) => asked.devices.find((d) => d.id === id)!.result;
    assert.equal(result(win.device_id), "requested");
    assert.equal(result(phone.device_id), "store");
    assert.equal(result(old.device_id), "unknown");

    // The Windows app learns of it from its own view, with who asked.
    const mine = await (await as(win.key, "windows 1.0.0", "/app-updates")).json() as View;
    assert.equal(mine.you?.request?.version, VERSION);
    assert.equal((t.hub.store.get(win.device_id)!.fields.app_update as { by: string }).by, "iPhone");

    // Back on the hub's version, the ask is done.
    await as(win.key, `windows ${VERSION}`, "/status");
    assert.equal(t.hub.store.get(win.device_id)!.fields.app_update ?? null, null);
    assert.equal((t.hub.store.get(win.device_id)!.fields.app as { version: string }).version, VERSION);

    // Not now on the device keeps the ask as declined, and the app no longer sees it as asked.
    await as(win.key, "windows 1.0.0", "/status");
    await t.api("/app-updates/request", { method: "POST", json: { devices: [win.device_id] } });
    assert.equal((await (await as(win.key, "windows 1.0.0", "/app-updates/request/decline", { method: "POST" })).json() as { declined: boolean }).declined, true);
    const later = await (await as(win.key, "windows 1.0.0", "/app-updates")).json() as View;
    assert.equal(later.you?.request, null);
    assert.ok((t.hub.store.get(win.device_id)!.fields.app_update as { declined_at?: string }).declined_at);
    assert.equal((await t.api("/app-updates/request", { method: "POST", json: { devices: ["nope"] } })).status, 404);
    // The owner's key is no device: it reports no app.
    assert.equal((await t.api("/devices/me/app", { method: "PUT", json: { kind: "windows", version: "1.0.0" } })).status, 400);
  } finally { t.cleanup(); }
});

test("update_apps: lists what each device runs, and asks devices to update only when told to", async () => {
  const t = makeHub();
  try {
    const links = await (await t.api("/devices/pairing", { method: "POST", json: { name: "Gaming PC" } })).json() as { code: string };
    const win = await (await t.app.request("/devices/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: links.code, name: "Gaming PC", platform: "windows" }) })).json() as { device_id: string; key: string };
    await t.app.request("/devices/me/app", { method: "PUT", headers: { authorization: `Bearer ${win.key}`, "content-type": "application/json" }, body: JSON.stringify({ kind: "windows", version: "1.0.0" }) });
    fakeGitHub({});
    const tool = TOOLS.find((x) => x.name === "update_apps")!;
    assert.ok(tool && tool.writes);
    const ctxFor = (lastUser: string) => {
      const api: ApiCall = async (method, p, body) => {
        const r = await t.api(p, { method, ...(body !== undefined ? { json: body } : {}) });
        return { status: r.status, data: await r.json() };
      };
      return { api, ctx: { sessionId: "s", lastUser, topic: "", store: t.hub.store, cfg: t.hub.cfg, hosts: null } as ToolContext };
    };
    let { api, ctx } = ctxFor("is my windows app up to date?");
    const list = JSON.parse((await runTool(api, { name: "update_apps", arguments: { action: "list" } }, ctx, [tool])).text);
    assert.equal(list.devices[0].runs, "windows 1.0.0");
    assert.match(list.devices[0].update, /can update from the hub/);
    const refused = JSON.parse((await runTool(api, { name: "update_apps", arguments: { action: "install", device: "windows" } }, ctx, [tool])).text);
    assert.match(refused.error, /does not ask to update/);
    assert.equal(t.hub.store.get(win.device_id)!.fields.app_update ?? null, null);
    ({ api, ctx } = ctxFor("Can you update my desktop Windows app to the new version?"));
    const done = JSON.parse((await runTool(api, { name: "update_apps", arguments: { action: "install", device: "Gaming PC" } }, ctx, [tool])).text);
    assert.match(done.devices[0].result, /installs it by itself/);
    assert.equal((t.hub.store.get(win.device_id)!.fields.app_update as { version: string }).version, VERSION);
    const none = JSON.parse((await runTool(api, { name: "update_apps", arguments: { action: "install", device: "toaster" } }, ctx, [tool])).text);
    assert.match(none.error, /no device matches/);
  } finally { t.cleanup(); }
});

test("an app update is asked for in words, not by a question about it", () => {
  assert.equal(appUpdateAsked("update my windows app"), true);
  assert.equal(appUpdateAsked("Can you update the apps?"), true);
  assert.equal(appUpdateAsked("yes"), true);
  assert.equal(appUpdateAsked("is the android app out of date?"), false);
  assert.equal(appUpdateAsked("update my dentist task to Friday"), false);
});
