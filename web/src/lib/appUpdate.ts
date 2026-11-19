/**
 * The Windows and Android apps carry their own copy of the screens, so they update by installing the new app, which
 * the hub keeps for them (appInstall.ts; the hub's Check for updates updates the hub alone). Since the hub and every app
 * share one version (CONTRACT, Health), the version the hub reports says when a newer app is out, with no call to
 * anyone but the hub.
 * A browser loads the hub's own copy of the app, and the App Store updates the Apple apps, so neither needs this.
 */

/** This app's version (tauri.conf.json, through vite.config.ts). */
export const APP_VERSION: string = import.meta.env.VITE_APP_VERSION ?? "unknown";

/** Where the newest Windows and Android apps are: GitHub's page for the latest release. */
export const RELEASES_URL = "https://github.com/gnomecannon/aeneas/releases/latest";

/** -1, 0 or 1 for two versions like 1.0.3, part by part; null when either is not three numbers. */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => (/^\d+\.\d+\.\d+$/.test(v.trim()) ? v.trim().split(".").map(Number) : null);
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

export interface VersionNotice { kind: "app-older" | "hub-older"; text: string }

/**
 * What this app says about its version against the hub's: a newer app is out (the hub runs a later release), or the hub
 * is behind this app, or nothing. Only in the Windows and Android apps (`app` is true there).
 */
export function versionNotice(appVersion: string, hubVersion: string | null, app: boolean): VersionNotice | null {
  if (!app || !hubVersion) return null;
  const c = compareVersions(appVersion, hubVersion);
  if (c === -1) return { kind: "app-older", text: `A newer Aeneas app is out. This app is ${appVersion} and your hub runs ${hubVersion}; Update app installs the new one from your hub.` };
  if (c === 1) return { kind: "hub-older", text: `Your hub runs ${hubVersion}, older than this app (${appVersion}). Update the hub in Hub software, above, so everything this app shows works.` };
  return null;
}
