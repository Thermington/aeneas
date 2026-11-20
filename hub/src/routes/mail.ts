import { Hono } from "hono";
import type { Hub } from "../hub.js";
import { StoreError } from "../store.js";
import { listMail, mailboxStates, mailLogos, mailMessage, markDone, MOVE_MAX, refreshMail, setPinned, SNOOZE_MAX_DAYS, snoozeMail, undoDone, unsnoozeMail, wakeSnoozed } from "../mail-inbox.js";
import { readJsonObject } from "../http.js";
import { bundleContext } from "../mail-bundles.js";

/**
 * The Mail screen (module `mail_inbox`, CONTRACT.md Mail): the iCloud Inbox, sorted into bundles.
 * The whole `/mail` prefix is closed to the assistant's tools (ai/api-guard.ts): mail is the owner's to read.
 */
export function mailRoutes() {
  const r = new Hono<{ Variables: { hub: Hub } }>();

  r.get("/mail", (c) => {
    const hub = c.get("hub");
    wakeSnoozed(hub);
    return c.json({ messages: listMail(hub.mailDb, bundleContext(hub)), logos: mailLogos(hub.mailDb), mailboxes: mailboxStates(hub) });
  });

  r.get("/mail/messages/:id", (c) => {
    const m = mailMessage(c.get("hub").mailDb, c.req.param("id"));
    if (!m) throw new StoreError(404, "that message is not kept (it left the Inbox)");
    return c.json(m);
  });

  // Pin: on the hub only; nothing changes in iCloud.
  r.post("/mail/messages/:id/pin", async (c) => {
    const body = await readJsonObject(c);
    if (typeof body.pinned !== "boolean") throw new StoreError(422, "pinned is true or false");
    if (!setPinned(c.get("hub").mailDb, c.req.param("id"), body.pinned)) throw new StoreError(404, "that message is not kept (it left the Inbox)");
    return c.json({ ok: true, pinned: body.pinned });
  });

  // Done (a Sweep is many at once) and Undo: the only routes that change the mailbox, a MOVE between Inbox and Archive.
  const ids = async (c: Parameters<typeof readJsonObject>[0]) => {
    const body = await readJsonObject(c);
    if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > MOVE_MAX || !body.ids.every((x) => typeof x === "string" && x.length <= 64)) {
      throw new StoreError(422, `ids is a list of 1 to ${MOVE_MAX} message ids`);
    }
    return body.ids as string[];
  };
  r.post("/mail/done", async (c) => c.json(await markDone(c.get("hub"), await ids(c))));
  r.post("/mail/undo", async (c) => c.json(await undoDone(c.get("hub"), await ids(c))));

  // Snooze: on the hub only (the mail stays in iCloud's Inbox); a task titled with its subject reminds at `until`.
  r.post("/mail/messages/:id/snooze", async (c) => {
    const body = await readJsonObject(c);
    const until = typeof body.until === "string" ? new Date(body.until) : new Date(NaN);
    const now = Date.now();
    if (Number.isNaN(until.getTime()) || until.getTime() < now + 30_000 || until.getTime() > now + SNOOZE_MAX_DAYS * 86_400_000) {
      throw new StoreError(422, `until is a time from now to ${SNOOZE_MAX_DAYS} days ahead`);
    }
    if (!snoozeMail(c.get("hub"), c.req.param("id"), until)) throw new StoreError(404, "that message is not in the Inbox");
    return c.json({ ok: true, until: until.toISOString() });
  });
  r.post("/mail/messages/:id/unsnooze", (c) => {
    if (!unsnoozeMail(c.get("hub"), c.req.param("id"))) throw new StoreError(404, "that message is not snoozed");
    return c.json({ ok: true });
  });

  r.post("/mail/refresh", async (c) => c.json(await refreshMail(c.get("hub"), { owner: true })));

  return r;
}
