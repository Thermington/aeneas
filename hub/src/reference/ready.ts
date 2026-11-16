/**
 * Whether a hub's offline reference has a book ready to search, asked by the assistant's tools (ai/tools.ts) without
 * importing the reference service: they are offered only while it answers yes. Keyed by the hub's config object.
 */
const readiness = new WeakMap<object, () => boolean>();

export function setReferenceReadiness(cfg: object, ready: () => boolean): void { readiness.set(cfg, ready); }

export function referenceReady(cfg: object | null | undefined): boolean {
  if (!cfg) return false;
  try { return readiness.get(cfg)?.() ?? false; } catch { return false; }
}
