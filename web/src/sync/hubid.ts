import { normalizeHubUrl } from "./api";

/**
 * A hub's own id (contract, Devices, pairing): 26 characters of Crockford base32, made once by the hub and kept. Pairing
 * links carry it as `hid=` since 2026-11-16, and `GET /link/routes` answers with it. Apps tell one hub from another by
 * this id, so reaching the same hub another way (home network, Direct link, Tailscale) is never moving to another hub.
 */
const HUB_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** The id written the one way the hub writes it, or null when it is missing or not an id. */
export function normalizeHubId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const id = v.trim().toUpperCase();
  return HUB_ID_RE.test(id) ? id : null;
}

export interface HubRef { url: string; id?: string | null }

/** Whether two hubs are one: by their ids when both are known, else by address (an older hub sends no id). */
export function sameHub(a: HubRef, b: HubRef): boolean {
  const ia = normalizeHubId(a.id);
  const ib = normalizeHubId(b.id);
  if (ia && ib) return ia === ib;
  return normalizeHubUrl(a.url) === normalizeHubUrl(b.url);
}

/**
 * Pairing through a link, with the hub this device used before (if any): whether it is the same hub, so the local copy
 * stays, and the id to keep afterwards. A link without an id keeps the id this device has for the same hub, and none
 * for another hub (it is learned on the next connect).
 */
export function afterLink(before: HubRef | null, link: HubRef): { same: boolean; id: string | null } {
  const same = !!before?.url && sameHub(before, link);
  return { same, id: normalizeHubId(link.id) ?? (same ? normalizeHubId(before?.id) : null) };
}
