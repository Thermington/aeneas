import { Hono } from "hono";
import type { Hub } from "../hub.js";
import { readJsonObject } from "../http.js";
import { StoreError } from "../store.js";
import { originalICloud } from "../imports/icloud.js";
import { conversation, KEEP_CHOICES, keepDays, listConversations, mailboxStates, messageByKey, refreshMail, setKeepDays } from "../mail-chat.js";

/**
 * The Mail screen (module `mail_chat`, CONTRACT.md Mail conversations): iCloud mail as conversations, read-only.
 * The whole `/mail` prefix is closed to the assistant's tools (ai/api-guard.ts): mail is the owner's to read.
 */
export function mailRoutes() {
  const r = new Hono<{ Variables: { hub: Hub } }>();

  r.get("/mail/conversations", (c) => {
    const hub = c.get("hub");
    return c.json({
      conversations: listConversations(hub.mailDb, { q: c.req.query("q"), limit: Number(c.req.query("limit")) || undefined }),
      keep_days: keepDays(hub.mailDb),
      choices: KEEP_CHOICES,
      mailboxes: mailboxStates(hub),
    });
  });

  r.get("/mail/conversations/:id", (c) => {
    const conv = conversation(c.get("hub").mailDb, c.req.param("id"));
    if (!conv) throw new StoreError(404, "that conversation is not kept (it may be older than the kept time)");
    return c.json(conv);
  });

  // Show original: fetched from iCloud now, answered, and never kept.
  r.get("/mail/messages/:id/original", async (c) => {
    const hub = c.get("hub");
    const id = c.req.param("id");
    const ref = messageByKey(hub.mailDb, id);
    if (!ref) throw new StoreError(404, "that message is not kept");
    const o = await originalICloud(hub, ref.account, ref.id);
    if (!o) throw new StoreError(404, "that message is no longer in the mailbox");
    return c.json({ id, at: o.at.toISOString(), from: o.from, reply_to: o.reply_to, subject: o.subject, text: o.text });
  });

  r.post("/mail/refresh", async (c) => c.json(await refreshMail(c.get("hub"), { owner: true })));

  r.put("/mail/settings", async (c) => {
    const body = await readJsonObject(c);
    const days = setKeepDays(c.get("hub").mailDb, body.keep_days);
    if (days === null) throw new StoreError(422, `keep_days is one of ${KEEP_CHOICES.join(", ")}: mail text is never kept forever`);
    return c.json({ keep_days: days, choices: KEEP_CHOICES });
  });

  return r;
}
