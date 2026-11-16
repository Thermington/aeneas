import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entity, Patch } from "@everythingapp/shared";
import { EADatabase, META, getMeta, setMeta, type RejectedEdit } from "./db";
import { SyncEngine } from "./engine";

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";

interface Call {
  path: string;
  body?: any;
}

function fakeHub(opts: { reject?: string[]; missing?: Set<string>; serverEntity?: (id: string) => Entity | undefined } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (path === "/devices/register") return json(200, { device_id: "dev-1" });
    if (path.startsWith("/sync/changes")) return json(200, { changes: [], seq: 7, more: false });
    if (path === "/sync/push") {
      const patches = body.patches as Patch[];
      // `missing`: ids a restored hub does not have; an edit is refused as the hub does, a create brings the item back.
      const gone = (p: Patch) => !!opts.missing?.has(p.id) && !p.create;
      for (const p of patches) if (p.create) opts.missing?.delete(p.id);
      const rejected = [
        ...patches.filter((p) => opts.reject?.includes(p.id)).map((p) => ({ id: p.id, reason: "test" })),
        ...patches.filter(gone).map((p) => ({ id: p.id, reason: "entity not found; send create: true to create it" })),
      ];
      const applied = patches.filter((p) => !opts.reject?.includes(p.id) && !gone(p)).map((p, i) => ({ id: p.id, seq: 10 + i }));
      return json(200, { applied, rejected, seq: 20 });
    }
    const m = /^\/entities\/(.+)$/.exec(path);
    if (m) {
      const e = opts.serverEntity?.(decodeURIComponent(m[1]));
      return e ? json(200, e) : json(404, { error: "not found" });
    }
    return json(404, { error: "nf" });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

let n = 0;
async function makeDb() {
  const db = new EADatabase(`test-${++n}`);
  await setMeta(META.hubUrl, "http://hub.test", db);
  await setMeta(META.token, "t", db);
  return db;
}

describe("SyncEngine", () => {
  let db: EADatabase;
  beforeEach(async () => {
    db = await makeDb();
  });

  it("a second edit to a field in the same millisecond still wins", async () => {
    const eng = new SyncEngine({ db, fetchImpl: fakeHub().fetchImpl, live: false });
    const ts = "2026-10-21T10:00:00.000Z";
    await eng.enqueue({ id: ID1, kind: "task", ts, fields: { title: "a", status: "inbox", order: 1 }, create: true });
    await eng.enqueue({ id: ID1, kind: "task", ts, fields: { status: "next", order: 5 } });
    const e = await eng.enqueue({ id: ID1, kind: "task", ts, fields: { order: 2 } });
    expect(e.fields).toMatchObject({ status: "next", order: 2 });
    expect(e.field_ts.order).toBe("2026-10-21T10:00:00.002Z");
  });

  it("flushes the outbox in enqueue order across ids", async () => {
    const hub = fakeHub();
    const eng = new SyncEngine({ db, fetchImpl: hub.fetchImpl, live: false });
    await eng.configure();
    await eng.ensureDevice();
    const ts = (s: number) => `2026-10-21T10:00:0${s}.000Z`;
    // Enqueue while the engine is "stopped" so nothing flushes early.
    await eng.enqueue({ id: ID1, kind: "task", ts: ts(1), fields: { title: "a", status: "next", order: 1 }, create: true });
    await eng.enqueue({ id: ID2, kind: "task", ts: ts(2), fields: { title: "b", status: "next", order: 2 }, create: true });
    await eng.enqueue({ id: ID1, kind: "task", ts: ts(3), fields: { title: "a2" } });
    expect(await db.outbox.count()).toBe(3);
    await eng.flush();
    const push = hub.calls.find((c) => c.path === "/sync/push")!;
    expect(push.body.device_id).toBe("dev-1");
    expect(push.body.patches.map((p: Patch) => [p.id, p.fields.title])).toEqual([
      [ID1, "a"],
      [ID2, "b"],
      [ID1, "a2"],
    ]);
    expect(await db.outbox.count()).toBe(0);
    expect(eng.state.outbox).toBe(0);
  });

  it("applies local edits immediately and keeps them over an older hub change", async () => {
    const hub = fakeHub();
    const eng = new SyncEngine({ db, fetchImpl: hub.fetchImpl, live: false });
    await eng.enqueue({ id: ID1, kind: "task", ts: "2026-10-21T10:00:05.000Z", fields: { title: "local" } });
    expect((await db.entities.get(ID1))!.fields.title).toBe("local");
    const incoming: Entity = {
      id: ID1,
      kind: "task",
      space: "personal",
      created_at: "2026-10-21T09:00:00.000Z",
      updated_at: "2026-10-21T10:00:01.000Z",
      deleted_at: null,
      fields: { title: "hub", status: "doing", order: 3 },
      field_ts: { title: "2026-10-21T10:00:01.000Z", status: "2026-10-21T10:00:01.000Z", order: "2026-10-21T10:00:01.000Z" },
    };
    await eng.applyChanges([incoming]);
    const e = (await db.entities.get(ID1))!;
    expect(e.fields.title).toBe("local");
    expect(e.fields.status).toBe("doing");
  });

  it("refetches entities whose patches the hub rejected", async () => {
    const server: Entity = {
      id: ID1,
      kind: "task",
      space: "personal",
      created_at: "2026-10-21T09:00:00.000Z",
      updated_at: "2026-10-21T09:00:00.000Z",
      deleted_at: null,
      fields: { title: "server truth", status: "next", order: 1 },
      field_ts: {},
    };
    const hub = fakeHub({ reject: [ID1], serverEntity: (id) => (id === ID1 ? server : undefined) });
    const eng = new SyncEngine({ db, fetchImpl: hub.fetchImpl, live: false });
    await eng.configure();
    await eng.enqueue({ id: ID1, kind: "task", ts: "2026-10-21T10:00:05.000Z", fields: { title: "mine" } });
    await eng.enqueue({ id: ID2, kind: "task", ts: "2026-10-21T10:00:06.000Z", fields: { title: "other", status: "next", order: 2 }, create: true });
    await eng.flush();
    expect(await db.outbox.count()).toBe(0);
    expect(hub.calls.some((c) => c.path === `/entities/${ID1}`)).toBe(true);
    expect((await db.entities.get(ID1))!.fields.title).toBe("server truth");
    expect((await db.entities.get(ID2))!.fields.title).toBe("other");
  });

  it("an edit of an item a restored hub does not have sends the item again whole instead of deleting it", async () => {
    const missing = new Set([ID1]);
    const hub = fakeHub({ missing });
    const eng = new SyncEngine({ db, fetchImpl: hub.fetchImpl, live: false });
    await eng.configure();
    await db.entities.put({ id: ID1, kind: "task", space: "personal", created_at: "2026-11-15T10:00:00.000Z", updated_at: "2026-11-15T10:00:00.000Z", deleted_at: null, fields: { title: "Call the vet", status: "next", order: 3 }, field_ts: {} } as Entity);
    const editedAt = new Date().toISOString();
    await eng.enqueue({ id: ID1, kind: "task", ts: editedAt, fields: { title: "Call the vet about Rex" } });
    await eng.flush();
    const pushes = hub.calls.filter((c) => c.path === "/sync/push").map((c) => c.body.patches as Patch[]);
    expect(pushes.length).toBe(2);
    // Stamped with when it was made, so the hub keeps its day; then the edit again with its own stamp.
    expect(pushes[1][0]).toMatchObject({ id: ID1, create: true, ts: "2026-11-15T10:00:00.000Z", fields: { title: "Call the vet about Rex", status: "next", order: 3 } });
    expect(pushes[1][1]).toMatchObject({ id: ID1, ts: editedAt, fields: { title: "Call the vet about Rex" } });
    expect((await db.entities.get(ID1))?.fields.title).toBe("Call the vet about Rex");
    expect(await db.outbox.count()).toBe(0);
    expect((await getMeta<RejectedEdit[]>(META.rejected, db)) ?? []).toEqual([]);
  });

  it("keeps a record of a refused edit instead of losing it silently", async () => {
    const hub = fakeHub({ reject: [ID1] });
    const eng = new SyncEngine({ db, fetchImpl: hub.fetchImpl, live: false });
    await eng.configure();
    await eng.enqueue({ id: ID1, kind: "task", ts: "2026-10-21T10:00:05.000Z", fields: { title: "Fix the NAS", status: "next", order: 1 }, create: true });
    await eng.flush();
    const log = (await getMeta<RejectedEdit[]>(META.rejected, db)) ?? [];
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ id: ID1, kind: "task", title: "Fix the NAS", reason: "test", fields: { title: "Fix the NAS" } });
  });

  it("advances the seq cursor on pull", async () => {
    const hub = fakeHub();
    const eng = new SyncEngine({ db, fetchImpl: hub.fetchImpl, live: false });
    await eng.configure();
    await eng.pull();
    expect(eng.state.seq).toBe(7);
    expect(hub.calls[0].path).toBe("/sync/changes?since=0");
  });

  it("starts over when the hub answers from the beginning, dropping what the restored hub does not have", async () => {
    const ent = (id: string, title: string): Entity => ({ id, kind: "task", space: "personal", created_at: "2026-10-21T09:00:00.000Z", updated_at: "2026-10-21T09:00:00.000Z", deleted_at: null, fields: { title, status: "next", order: 1 }, field_ts: { title: "2026-10-21T09:00:00.000Z" } });
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, "");
      calls.push(path);
      // The device is at 500; the restored hub is at 3 and holds ID1 only.
      return new Response(JSON.stringify(path.includes("since=500") ? { changes: [{ seq: 3, entity: ent(ID1, "kept") }], seq: 3, more: false, reset: true } : { changes: [], seq: 3, more: false }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    await setMeta(META.seq, 500, db);
    const work = { ...ent("33333333-3333-4333-8333-333333333333", "a work meeting"), space: "work" as const };
    await db.entities.bulkPut([ent(ID1, "old"), ent(ID2, "gone on the hub"), work]);
    const eng = new SyncEngine({ db, fetchImpl, live: false });
    await eng.configure();
    await eng.pull();
    expect(eng.state.seq).toBe(3);
    expect((await db.entities.get(ID1))!.fields.title).toBe("kept");
    expect(await db.entities.get(ID2)).toBeUndefined();
    expect(await db.entities.get(work.id)).toBeDefined();
    await eng.pull();
    expect(calls.at(-1)).toBe("/sync/changes?since=3");
  });

  it("passes device_id on /sync/changes once registered", async () => {
    const hub = fakeHub();
    const eng = new SyncEngine({ db, fetchImpl: hub.fetchImpl, live: false });
    await eng.start();
    expect(hub.calls.some((c) => c.path === "/sync/changes?since=0&device_id=dev-1")).toBe(true);
    eng.stop();
  });

  it("takes its catch-up on showing the window off when stopped, instead of adding one more on every start", async () => {
    const listening = new Map<string, Set<unknown>>();
    const target = () => ({
      addEventListener: (type: string, fn: unknown) => void (listening.get(type) ?? listening.set(type, new Set()).get(type)!).add(fn),
      removeEventListener: (type: string, fn: unknown) => void listening.get(type)?.delete(fn),
    });
    vi.stubGlobal("window", target());
    vi.stubGlobal("document", { ...target(), visibilityState: "visible" });
    try {
      const eng = new SyncEngine({ db, fetchImpl: fakeHub().fetchImpl, live: false });
      for (let i = 0; i < 3; i++) {
        await eng.start();
        eng.stop();
      }
      expect(listening.get("visibilitychange")?.size ?? 0).toBe(0);
      expect(listening.get("online")?.size ?? 0).toBe(0);
      await eng.start();
      expect(listening.get("visibilitychange")?.size).toBe(1);
      eng.stop();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lets go of the live stream's watchdog when the stream ends by itself, not only when stopped", async () => {
    // The watchdog is the 20 s timer; every other timer passes through untouched.
    const watchdogs = new Set<unknown>();
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const setSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number) => {
      const id = realSet(fn, ms);
      if (ms === 20_000) watchdogs.add(id);
      return id;
    }) as typeof setInterval);
    const clearSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(((id?: Parameters<typeof clearInterval>[0]) => {
      watchdogs.delete(id);
      realClear(id);
    }) as typeof clearInterval);
    let end: (() => void) | undefined;
    const hub = fakeHub();
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("/live")) return hub.fetchImpl(input, init);
      const body = new ReadableStream<Uint8Array>({ start: (c) => void (end = () => c.close()) });
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;
    const eng = new SyncEngine({ db, fetchImpl, live: true });
    try {
      await eng.start();
      await vi.waitFor(() => expect(watchdogs.size).toBe(1));
      // The hub closes the stream (a restart, say); the engine opens a new one later.
      end!();
      await vi.waitFor(() => expect(eng.state.live).toBe(false));
      expect(watchdogs.size).toBe(0);
    } finally {
      eng.stop();
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});
