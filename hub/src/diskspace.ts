import fs from "node:fs";
import type { Hub } from "./hub.js";

/**
 * Room left on the disk that holds the hub's data folder. When it is full, SQLite cannot save an edit and no backup
 * can be written, and nothing said so: host sensors watch disks only on hubs with Homelab and the machine's sensors on.
 */
export interface DiskSpace { free_bytes: number; total_bytes: number; used_pct: number; low: boolean }

const GB = 1024 ** 3;

/** Tests: what diskSpace answers instead of the real disk. */
let override: ((dir: string) => DiskSpace | null) | null = null;
export function setDiskSpaceOverride(f: ((dir: string) => DiskSpace | null) | null): void { override = f; }

/** Low: 95% used, or less than 2 GB free, whichever comes first. Null when the folder cannot be read. */
export function diskSpace(dir: string): DiskSpace | null {
  if (override) return override(dir);
  try {
    const s = fs.statfsSync(dir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    if (!total) return null;
    const used = Math.round(1000 * (1 - free / total)) / 10;
    return { free_bytes: free, total_bytes: total, used_pct: used, low: used >= 95 || free < 2 * GB };
  } catch { return null; }
}

/** "1.8 GB" or "640 MB". */
export function spaceLeft(bytes: number): string {
  return bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/**
 * Every 10 minutes (the first look a minute after start): when the data disk is low, a `notify` of kind `disk` says
 * how much is left, once when it gets low and then once a day while it stays low. Every hub has it, whatever modules
 * are on, since a full disk stops the hub itself.
 */
export function startDiskWatch(hub: Pick<Hub, "bus" | "cfg">, everyMs = 10 * 60_000, read: () => DiskSpace | null = () => diskSpace(hub.cfg.dataDir), firstMs = 60_000): () => void {
  let warnedAt = 0;
  const look = () => {
    const d = read();
    if (!d) return;
    if (!d.low) { warnedAt = 0; return; }
    if (warnedAt && Date.now() - warnedAt < 24 * 3_600_000) return;
    warnedAt = Date.now();
    const at = new Date(warnedAt).toISOString();
    const left = spaceLeft(d.free_bytes);
    hub.bus.emit("notify", { id: `disk:${at}`, kind: "disk", title: `The hub's disk is almost full: ${left} left. When it is full, the hub cannot save edits or make backups.`, at });
    console.warn(`[disk] the data disk is ${d.used_pct}% used, ${left} left`);
  };
  const first = setTimeout(look, firstMs);
  first.unref();
  const timer = setInterval(look, everyMs);
  timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}
