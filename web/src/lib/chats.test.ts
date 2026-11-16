import { describe, expect, it } from "vitest";
import type { ChatMsg } from "../sync/db";
import { chatsGone } from "./chats";

const msg: ChatMsg = { role: "user", content: "Why is the NAS fan loud?", at: "2026-11-16T10:00:00.000Z" };
const chat = (id: string, on_hub: boolean | undefined, messages: ChatMsg[] = [msg]) => ({ id, messages, ...(on_hub === undefined ? {} : { on_hub }) });

describe("chats the hub no longer lists", () => {
  it("keeps a chat whose first message never reached the hub, with what was typed in it", () => {
    // Sent while the hub was out of reach, then the window was switched: the hub's list does not have it.
    expect(chatsGone([chat("new", false)], new Set(["other"]), new Set())).toEqual([]);
  });

  it("removes a chat the hub had and no longer lists, deleted on another device", () => {
    expect(chatsGone([chat("old", true), chat("kept", true)], new Set(["kept"]), new Set())).toEqual(["old"]);
  });

  it("keeps a chat waiting on a reply and an empty new one", () => {
    expect(chatsGone([chat("waiting", true), chat("blank", false, [])], new Set(), new Set(["waiting"]))).toEqual([]);
  });

  it("goes by the old rule for a chat kept from before: with messages and not listed, it is gone", () => {
    expect(chatsGone([chat("before", undefined), chat("draft", undefined, [])], new Set(), new Set())).toEqual(["before"]);
  });
});
