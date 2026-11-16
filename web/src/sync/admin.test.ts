import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Entity } from "@everythingapp/shared";
import { HubClient } from "./api";
import { engine } from "./engine";
import { updateEntity } from "./edits";
import { toggleChecklist } from "./admin";
import type { ChecklistF } from "../lib/admin";

const ID = "44444444-4444-4444-8444-444444444444";
// Made a while ago: every stamp this device or the hub gives now is later.
const at = "2026-11-01T10:00:00.000Z";

function list(items: ChecklistF["items"], template = false): Entity {
  return { id: ID, kind: "checklist", space: "personal", created_at: at, updated_at: at, deleted_at: null, fields: { title: "Groceries", kind: "generic", items, template }, field_ts: { title: at, kind: at, items: at, template: at } } as Entity;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * A hub that answers the old tick route as the hub does: it ticks its own copy (`own`, without anything still waiting
 * to send here) and stamps the items with its own, later time. Asked that, this device lost the waiting add.
 */
function hub(own: ChecklistF["items"] = []) {
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (!/\/checklists\/[^/]+\/toggle$/.test(String(url))) return json(404, { error: "nf" });
    const { index } = JSON.parse(String(init?.body)) as { index: number };
    const later = new Date(Date.now() + 60_000).toISOString();
    const ticked = own.map((it, i) => (i === index ? { ...it, done_at: later } : it));
    const e = list(ticked);
    return json(200, { ...e, updated_at: later, field_ts: { ...e.field_ts, items: later } });
  });
  engine.client = new HubClient({ hubUrl: "http://hub.test", token: "t" }, fetchImpl as unknown as typeof fetch);
  return fetchImpl;
}

const items = async () => ((await engine.db.entities.get(ID))!.fields as ChecklistF).items;

describe("ticking a list item", () => {
  beforeEach(async () => {
    await engine.db.entities.clear();
    await engine.db.outbox.clear();
  });
  afterEach(() => {
    engine.client = null;
  });

  it("keeps an added item that has not been sent yet, and ticks through the outbox after it", async () => {
    const fetchImpl = hub([{ text: "Eggs" }, { text: "Bread" }]);
    const shown = list([{ text: "Eggs" }, { text: "Bread" }]);
    await engine.db.entities.put(shown);
    // "Milk" is added and waits to send; then "Eggs" is ticked from the screen as it was drawn before the add.
    await updateEntity(shown, { items: [{ text: "Eggs" }, { text: "Bread" }, { text: "Milk" }] });
    await toggleChecklist(shown, 0);
    const now = await items();
    expect(now.map((i) => i.text)).toEqual(["Eggs", "Bread", "Milk"]);
    expect(now[0].done_at).toBeTruthy();
    expect(now[1].done_at).toBeUndefined();
    // Both edits wait in order; the tick carries the add, so the hub gets Milk either way.
    const queued = (await engine.db.outbox.orderBy("seq").toArray()).map((o) => (o.patch.fields.items as ChecklistF["items"]).map((i) => `${i.text}${i.done_at ? " ticked" : ""}`));
    expect(queued).toEqual([["Eggs", "Bread", "Milk"], ["Eggs ticked", "Bread", "Milk"]]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("ticks the item the row showed after the list moved under it", async () => {
    hub();
    const shown = list([{ text: "Eggs" }, { text: "Bread" }]);
    await engine.db.entities.put(list([{ text: "Milk" }, { text: "Eggs" }, { text: "Bread" }]));
    await toggleChecklist(shown, 1);
    expect((await items()).map((i) => !!i.done_at)).toEqual([false, false, true]);
    // Ticked again, it comes off.
    await toggleChecklist(list(await items()), 2);
    expect((await items()).some((i) => i.done_at)).toBe(false);
  });

  it("refuses a template and an item that is gone, writing nothing", async () => {
    hub();
    await engine.db.entities.put(list([{ text: "Passport" }], true));
    await expect(toggleChecklist(list([{ text: "Passport" }], true), 0)).rejects.toThrow("Templates are copied, never ticked. Start a list from it first.");
    await engine.db.entities.put(list([{ text: "Bread" }]));
    await expect(toggleChecklist(list([{ text: "Eggs" }, { text: "Bread" }]), 0)).rejects.toThrow("That item is no longer on the list.");
    expect(await engine.db.outbox.count()).toBe(0);
  });
});
