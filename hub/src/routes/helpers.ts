import { Hono } from "hono";
import type { Hub } from "../hub.js";
import { readJsonObject } from "../http.js";
import { StoreError } from "../store.js";
import { helpingView, offerHelp, stopHelping, peopleWithHelp } from "../helping.js";

type Vars = { Variables: { hub: Hub; device_id?: string; auth?: "owner" | "device" | "helper"; helper_id?: string } };

/**
 * Helping someone with their devices (helpers.ts, helping.ts, docs/helpers.md):
 * - `/helpers/*`, `/agent/*`: the helped person's own hub, for their app (their device keys) and, for the offer only,
 *   people.sh with the main key;
 * - `/warden/*`: the same hub for the helper's hub, with the helper key and nothing else;
 * - `/helping/*`: the helper's (the machine owner's) hub, for its owner.
 */
export function helperRoutes() {
  const r = new Hono<Vars>();
  const notHelper = (c: { get(k: "auth"): string | undefined }) => {
    if (c.get("auth") === "helper") throw new StoreError(403, "not for a helper");
  };
  const deviceOnly = (c: { get(k: "auth"): string | undefined; get(k: "device_id"): string | undefined }): string => {
    const id = c.get("device_id");
    if (c.get("auth") !== "device" || !id) throw new StoreError(403, "only an app signed in with its own key");
    return id;
  };

  // ---------- the helped person's hub, for them ----------

  r.get("/helpers", async (c) => {
    notHelper(c);
    const h = c.get("hub").helpers;
    const me = c.get("device_id");
    return c.json({
      helpers: h.list().filter((x) => x.state !== "stopped" || Date.now() - Date.parse(x.stopped_at ?? "") < 30 * 86_400_000)
        .map(({ key_hash: _k, ...x }) => x),
      log: h.logList(200),
      passwords: await h.passwords(),
      computers: h.agents().filter((a) => paired(c.get("hub"), a.device_id)),
      scan: h.scan(),
      this_device: me ? { device_id: me, agent: h.agents().find((a) => a.device_id === me) ?? null } : null,
    });
  });
  r.post("/helpers/:id/accept", (c) => { notHelper(c); return c.json(strip(c.get("hub").helpers.accept(c.req.param("id")))); });
  r.post("/helpers/:id/stop", (c) => { notHelper(c); return c.json(strip(c.get("hub").helpers.stop(c.req.param("id"), "person"))); });
  r.put("/helpers/passwords", async (c) => { notHelper(c); return c.json(await c.get("hub").helpers.putPassword(await readJsonObject(c))); });
  r.delete("/helpers/passwords/:title", async (c) => {
    notHelper(c);
    const title = decodeURIComponent(c.req.param("title"));
    if (!(await c.get("hub").helpers.removePassword(title))) throw new StoreError(404, "no saved password by that name");
    return c.json({ removed: title });
  });
  // What the person's app found on their home network.
  r.post("/helpers/scan", async (c) => {
    const id = deviceOnly(c);
    const hub = c.get("hub");
    const by = String(hub.store.get(id)?.fields.name ?? "app");
    return c.json(hub.helpers.setScan(by, await readJsonObject(c)));
  });
  // people.sh ward: the main key on this machine only.
  r.post("/helpers/offer", async (c) => {
    if (c.get("auth") !== "owner") throw new StoreError(403, "offers come from this machine's owner (people.sh ward)");
    const b = await readJsonObject<{ name?: unknown; key_hash?: unknown }>(c);
    const h = c.get("hub").helpers.offer(String(b.name ?? ""), String(b.key_hash ?? ""));
    return c.json({ id: h.id, name: h.name, state: h.state });
  });

  // ---------- the person's computer runs commands for the helper (the Aeneas app there) ----------

  r.put("/agent/me", async (c) => { const id = deviceOnly(c); return c.json(c.get("hub").helpers.setAgent(id, await readJsonObject(c))); });
  r.get("/agent/jobs", async (c) => {
    const id = deviceOnly(c);
    const h = c.get("hub").helpers;
    const agent = h.agents().find((a) => a.device_id === id);
    if (!agent?.on || !h.active().length) return c.json({ jobs: [], helping: false });
    const wait = Math.min(Math.max(Number(c.req.query("wait")) || 0, 0), 25) * 1000;
    return c.json({ jobs: await h.nextJobs(id, wait), helping: true });
  });
  r.post("/agent/jobs/:id", async (c) => {
    const id = deviceOnly(c);
    if (!c.get("hub").helpers.finishJob(id, c.req.param("id"), await readJsonObject(c))) throw new StoreError(404, "no such job");
    return c.json({ ok: true });
  });

  // ---------- the same hub, for the helper's hub ----------

  const helper = (c: { get(k: "auth"): string | undefined; get(k: "helper_id"): string | undefined; get(k: "hub"): Hub }) => {
    const h = c.get("auth") === "helper" ? c.get("hub").helpers.get(c.get("helper_id") ?? "") : null;
    if (!h || h.state !== "active") throw new StoreError(403, "only for a helper");
    return h;
  };
  r.get("/warden/me", async (c) => {
    const h = helper(c);
    const hub = c.get("hub");
    const view = await hub.helpers.wardenView();
    return c.json({ helper: h.name, person: hub.profile.get().name || null, ...view, computers: view.computers.filter((a) => paired(hub, a.device_id)) });
  });
  r.post("/warden/run", async (c) => {
    const h = helper(c);
    const body = await readJsonObject<{ device?: unknown }>(c);
    if (!paired(c.get("hub"), String(body.device ?? ""))) throw new StoreError(404, "that computer is no longer paired with their hub");
    return c.json(await c.get("hub").helpers.run(h, body));
  });
  // A device in their home was reset or replaced: its old key is forgotten, so the next sign-in takes the new one.
  r.delete("/warden/known-hosts/:ip", (c) => {
    helper(c);
    return c.json({ forgotten: c.get("hub").helpers.forgetHostKey(c.req.param("ip")) });
  });
  r.delete("/warden/me", (c) => {
    const h = helper(c);
    c.get("hub").helpers.stop(h.id, "helper");
    return c.json({ stopped: true });
  });

  // ---------- the helper's own hub, for its owner ----------

  r.get("/helping", async (c) => { notHelper(c); return c.json({ people: await helpingView(c.get("hub")) }); });
  r.get("/helping/people", async (c) => { notHelper(c); return c.json({ people: await peopleWithHelp(c.get("hub")) }); });
  r.post("/helping/:account", (c) => { notHelper(c); return c.json(offerHelp(c.get("hub"), c.req.param("account"))); });
  r.delete("/helping/:account", async (c) => { notHelper(c); return c.json(await stopHelping(c.get("hub"), c.req.param("account"))); });

  return r;
}

const strip = <T extends { key_hash?: string }>(h: T) => { const { key_hash: _k, ...rest } = h; return rest; };

/** A computer still paired with this hub: a removed device's app never runs anything for a helper again. */
const paired = (hub: Hub, deviceId: string) => { const e = hub.store.get(deviceId); return !!e && e.kind === "device" && !e.deleted_at; };
