import type { Entity } from "@everythingapp/shared";
import { engine } from "./engine";
import { HubError, type HubClient } from "./api";
import { createEntity, now, updateEntity } from "./edits";
import { instantiateFields, locateItem, toggleItem, type ChecklistF } from "../lib/admin";

/**
 * Calls the hub and absorbs the entity it returns. Returns undefined when there is no hub, it is unreachable, or it answers 404
 * (a hub without the route), so the caller can take the offline path. Any other hub answer is an error for the caller.
 */
export async function viaHub<T>(call: (c: HubClient) => Promise<T>): Promise<T | undefined> {
  const c = engine.client;
  if (!c) return undefined;
  try {
    return await call(c);
  } catch (e) {
    if (e instanceof HubError && e.status !== 404) throw e;
    return undefined;
  }
}

/**
 * Ticks the item a row showed (`e` as the screen drew it, the row's index) as an edit of the whole list, read from the
 * list as it is now: the same queued edit that adding an item makes. It used to go to POST /checklists/:id/toggle,
 * which ticked the hub's own copy and stamped the items newer than an add still waiting to send, so this device dropped
 * the add and the hub ignored it when it came. Every change to the items now goes through the outbox, in the order made.
 */
export async function toggleChecklist(e: Entity, index: number): Promise<void> {
  const cur = await engine.db.entities.get(e.id);
  if (!cur || cur.deleted_at) throw new Error("List not found.");
  const f = cur.fields as ChecklistF;
  if (f.template) throw new Error("Templates are copied, never ticked. Start a list from it first.");
  const items = f.items ?? [];
  const shown = ((e.fields as ChecklistF).items ?? [])[index];
  const i = shown ? locateItem(items, index, shown.text) : null;
  if (i === null) throw new Error("That item is no longer on the list.");
  await updateEntity(cur, { items: toggleItem(items, i, now()) });
}

/** POST /checklists/:id/instantiate, else the same copy created locally. Returns the copy. */
export async function instantiateChecklist(template: Entity, title?: string): Promise<Entity> {
  const out = await viaHub((c) => c.checklistInstantiate(template.id, title));
  if (out) {
    await engine.absorb([out]);
    return out;
  }
  return createEntity("checklist", instantiateFields(template, title));
}
