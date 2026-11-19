import { randomUUID } from "node:crypto";
import { nowIso, Platform } from "@everythingapp/shared";
import { StoreError, type Store } from "./store.js";

/** Which app a device runs, as each app from 1.0.5 on reports it once a start (PUT /devices/me/app). */
export const APP_KINDS = ["windows", "android", "web", "ios", "ipados", "macos", "watchos"] as const;
export type AppKind = typeof APP_KINDS[number];
export interface DeviceApp { kind: AppKind; version: string; build?: string }
/** An update the owner asked for (the assistant or Settings): the app installs it the next time it reaches the hub. */
export interface AppUpdateAsk { requested_at: string; version: string; by?: string; declined_at?: string }

export function parseApp(body: unknown): DeviceApp | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const kind = typeof b.kind === "string" && (APP_KINDS as readonly string[]).includes(b.kind) ? b.kind as AppKind : null;
  const version = typeof b.version === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(b.version) ? b.version : null;
  const build = typeof b.build === "string" && /^[\w.-]{1,32}$/.test(b.build) ? b.build : undefined;
  return kind && version ? { kind, version, ...(build ? { build } : {}) } : null;
}

export interface DeviceSummary {
  id: string;
  name: string;
  platform: string;
  last_seen: string | null;
  app: DeviceApp | null;
  app_update: AppUpdateAsk | null;
}

/** Device liveness: last_seen writes throttled to once per minute per device, written silently so the change feed stays quiet. */
export class DeviceTracker {
  private lastTouch = new Map<string, number>();
  private lastApp = new Map<string, string>();

  constructor(private store: Store, private throttleMs = 60_000) {}

  /** Record that a device just talked to the hub. Returns true when a write happened. */
  touch(deviceId: string | undefined | null, now: Date = new Date()): boolean {
    if (!deviceId || typeof deviceId !== "string" || deviceId.length > 64) return false;
    const prev = this.lastTouch.get(deviceId);
    if (prev !== undefined && now.getTime() - prev < this.throttleMs) return false;
    this.lastTouch.set(deviceId, now.getTime());
    const at = now.toISOString();
    this.store.db.prepare("UPDATE devices SET last_seen = ? WHERE device_id = ?").run(at, deviceId);
    const e = this.store.get(deviceId);
    if (!e || e.kind !== "device" || e.deleted_at) return false;
    this.store.patchSilent(deviceId, { last_seen: at });
    return true;
  }

  /**
   * What app and version the device runs, written when it changes. An update asked for is done once the device runs
   * that version or a later one, so the ask is cleared then.
   */
  noteApp(deviceId: string, app: DeviceApp): void {
    const key = `${app.kind} ${app.version} ${app.build ?? ""}`;
    if (this.lastApp.get(deviceId) === key) return;
    this.lastApp.set(deviceId, key);
    const e = this.store.get(deviceId);
    if (!e || e.kind !== "device" || e.deleted_at) return;
    const had = e.fields.app as DeviceApp | undefined;
    if (!had || had.kind !== app.kind || had.version !== app.version || had.build !== app.build) this.store.patchSilent(deviceId, { app });
    const ask = e.fields.app_update as AppUpdateAsk | null | undefined;
    if (ask && versionAtLeast(app.version, ask.version)) this.store.patch(deviceId, { app_update: null });
  }

  /** Every registered device entity with its most recent last_seen (entity or devices table, whichever is later). */
  list(): DeviceSummary[] {
    const rows = this.store.db.prepare("SELECT device_id, last_seen FROM devices").all() as { device_id: string; last_seen: string | null }[];
    const tableSeen = new Map(rows.map((r) => [r.device_id, r.last_seen]));
    return this.store.list({ kind: "device", limit: 1000 })
      .map((e) => {
        const a = typeof e.fields.last_seen === "string" ? e.fields.last_seen : null;
        const b = tableSeen.get(e.id) ?? null;
        const last_seen = a && b ? (a > b ? a : b) : a ?? b;
        const app = (e.fields.app as DeviceApp | undefined) ?? null;
        const app_update = (e.fields.app_update as AppUpdateAsk | null | undefined) ?? null;
        return { id: e.id, name: String(e.fields.name ?? ""), platform: String(e.fields.platform ?? ""), last_seen, app, app_update };
      })
      .sort((x, y) => String(y.last_seen ?? "").localeCompare(String(x.last_seen ?? "")));
  }

  /** Test hook: forget throttle state. */
  reset(): void { this.lastTouch.clear(); this.lastApp.clear(); }
}

/** a is b or later (three-number versions); false when either is not one. */
function versionAtLeast(a: string, b: string): boolean {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  if (x.length !== 3 || y.length !== 3 || [...x, ...y].some((n) => !Number.isInteger(n))) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return true;
}

/**
 * Remove a device: its key ends at once, with the key of any Watch it held, and each one's entity is marked deleted
 * so every list drops it. Returns the devices removed.
 */
export function removeDevice(hub: { store: Store; deviceKeys: { revoke(id: string): string[] } }, id: string): string[] {
  const gone = hub.deviceKeys.revoke(id);
  for (const d of new Set([id, ...gone])) {
    const e = hub.store.get(d);
    if (e && e.kind === "device" && !e.deleted_at) hub.store.patch(d, { deleted_at: nowIso() });
  }
  if (gone.length) console.log(`[devices] ${gone.map((d) => d.slice(0, 8)).join(", ")} removed: no key of theirs works now`);
  return gone;
}

/**
 * Add or update a device: the shared part of `/devices/register`, `/devices/claim` and `/devices/exchange`.
 * `fixedId` is the device a key belongs to (a device signed in with its own key registers only itself).
 */
export function registerDevice(store: Store, body: { name?: unknown; platform?: unknown; push_token?: unknown; device_id?: unknown }, fixedId?: string): { device_id: string; name: string; platform: string } {
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
  if (!name || !body.platform) throw new StoreError(422, "name and platform are required");
  const platform = Platform.parse(body.platform);
  const pushToken = typeof body.push_token === "string" && body.push_token ? body.push_token : null;
  let device_id: string;
  if (fixedId) device_id = fixedId;
  else {
    // A device id that names another item (a task, a note) is not taken: registering would write into that item.
    const asked = typeof body.device_id === "string" && /^[0-9a-f-]{36}$/i.test(body.device_id) ? body.device_id : null;
    const taken = asked ? store.get(asked) : null;
    device_id = asked && (!taken || taken.kind === "device") ? asked : randomUUID();
  }
  const now = nowIso();
  store.db.prepare(
    "INSERT INTO devices (device_id, name, platform, push_token, registered_at, last_seen) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET name = excluded.name, platform = excluded.platform, push_token = COALESCE(excluded.push_token, devices.push_token), last_seen = excluded.last_seen",
  ).run(device_id, name, platform, pushToken, now, now);
  const fields: Record<string, unknown> = { name, platform, last_seen: now, ...(pushToken ? { push_token: pushToken } : {}) };
  // A device removed in Settings that registers again is back in the list (it stayed hidden from /status).
  if (store.get(device_id)) store.patch(device_id, { ...fields, deleted_at: null }); else store.create("device", fields, "personal", device_id);
  return { device_id, name, platform };
}
