import type { ChatSession } from "../sync/db";

/**
 * The chats to remove from this device once the hub has listed its own: one the hub had and no longer lists was
 * deleted on another device. A chat the hub never had stays, even with a message in it: sent while the hub was out
 * of reach, that message is the only copy of what was typed. A chat waiting on a reply stays too. A chat kept from
 * before the hub's having it was recorded goes by the old rule: with messages and not listed, it is gone.
 */
export function chatsGone(local: Pick<ChatSession, "id" | "messages" | "on_hub">[], listed: Set<string>, waiting: Set<string>): string[] {
  return local.filter((c) => !listed.has(c.id) && !waiting.has(c.id) && (c.on_hub ?? c.messages.length > 0)).map((c) => c.id);
}
