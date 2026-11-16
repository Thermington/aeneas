/**
 * What kind of device this page runs on, from its user agent, for the few things that differ by device: the link only
 * a Mac can open, and the name a new device pairs with.
 */

/**
 * A browser on a Mac, where the app link opens the Aeneas Mac app. Never the Windows or Android app: there the link
 * opens that same app again, which would take the pairing code meant for the other device.
 */
export function isMacBrowser(ua: string, tauri: boolean): boolean {
  return !tauri && /Macintosh|Mac OS X/.test(ua) && !/iPhone|Android/.test(ua);
}

/** The kinds of device a pairing code can be named for, and how each one's user agent reads (an iPad can read as a Mac). */
const KIND_UA: Record<string, RegExp> = {
  iphone: /iPhone/,
  ipad: /iPad|Macintosh/,
  mac: /Macintosh/,
  windows: /Windows/,
  android: /Android/,
};

/**
 * The name a device takes when it pairs: the one the code was made with, unless that names no device ("New device",
 * the hub's "My device") or a kind of device this one is not (a code made with the suggested "iPhone", opened on an
 * Android phone). Then `own`, this device's own name.
 */
export function pairingName(offered: string | null | undefined, own: string, ua: string): string {
  const name = (offered ?? "").trim();
  const kind = name.toLowerCase();
  if (!name || kind === "new device" || kind === "my device") return own;
  return KIND_UA[kind] && !KIND_UA[kind].test(ua) ? own : name;
}
