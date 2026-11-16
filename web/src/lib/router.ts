import { useEffect, useState } from "react";

export interface Route {
  path: string;
  parts: string[];
  params: URLSearchParams;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#/, "") || "/now";
  const [p, q = ""] = raw.split("?");
  const path = p.startsWith("/") ? p : "/" + p;
  return { path, parts: path.split("/").filter(Boolean), params: new URLSearchParams(q) };
}

export function useRoute(): Route {
  const [r, setR] = useState<Route>(() => parse());
  useEffect(() => {
    const on = () => setR(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return r;
}

export function go(path: string): void {
  window.location.hash = path;
}

/**
 * Go to a screen in place of the current one, for a redirect: with `go` the page that redirects stays in the history,
 * and Back lands on it and is sent forward again (Android's Back could not leave the Assistant).
 */
export function replace(path: string): void {
  window.location.replace(`#${path}`);
}

/** A pairing link's route (`/setup?hub=&code=`), or the setup screen itself. */
const isSetup = (path: string) => path === "/setup" || path.startsWith("/setup?");

/**
 * The screen to show once this device is paired, or once the person keeps the hub it has: where they were. Setup shows
 * in place of any screen on a device with no hub, so that screen stays; a pairing link that opened in the middle of
 * something (a QR code scanned while the app was open, a link pasted into the address bar) goes back to the screen
 * before it; a link that started the app goes to the start screen. Never the link itself, which holds the code.
 */
export function afterPairing(current: string, before: string | null): string {
  if (!isSetup(current)) return current || "/now";
  return before && !isSetup(before) ? before : "/now";
}

/** The screen before the latest pairing link, from the hash change that brought the link in. */
let beforeLink: string | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("hashchange", (e) => {
    const hash = (url: string) => { try { return new URL(url).hash.replace(/^#/, ""); } catch { return ""; } };
    const to = hash(e.newURL);
    const from = hash(e.oldURL);
    if (isSetup(to) && !isSetup(from)) beforeLink = from || null;
  });
}

/** Leave the setup screen for `afterPairing`'s screen, replacing the link in the history. */
export function leaveSetup(): void {
  replace(afterPairing(window.location.hash.replace(/^#/, ""), beforeLink));
}
