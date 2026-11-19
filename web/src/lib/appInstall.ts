import type { AppKind, AppPlatform, HubClient } from "../sync/api";
import { appUpdateFile, isAndroid, isTauri, isWindowsApp } from "../tauri/bridge";
import { APP_VERSION, compareVersions } from "./appUpdate";

/**
 * Updating the Windows and Android apps from the hub. The hub keeps its own release's installers (CONTRACT, App
 * updates); the app downloads one the way it reaches the hub, and src-tauri/src/appupdate.rs checks the release key's
 * signature before it runs anything.
 */

/** Which app this is, as the hub is told: null in a desktop build other than Windows (a developer's Mac). */
export function appKind(): AppKind | null {
  if (!isTauri) return "web";
  if (isAndroid) return "android";
  if (isWindowsApp && typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)) return "windows";
  return null;
}

/** The platform whose installer this app takes from the hub, when it is one that does. */
export function selfPlatform(): AppPlatform | null {
  const k = appKind();
  return k === "windows" || k === "android" ? k : null;
}

/** Tells the hub which app and version this is, once for each hub client (start, pairing, another hub). */
const reported = new WeakSet<object>();
export function reportAppVersion(client: HubClient): void {
  const kind = appKind();
  if (!kind || reported.has(client) || !/^\d+\.\d+\.\d+$/.test(APP_VERSION)) return;
  reported.add(client);
  void client.reportApp({ kind, version: APP_VERSION }).catch(() => { reported.delete(client); });
}

export type InstallState = "preparing" | "downloading" | "installing" | "prompted" | "permission" | "current" | "unavailable" | "failed";
export interface InstallStep { state: InstallState; text: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mb = (n: number) => `${(n / 1_048_576).toFixed(1)} MB`;

/**
 * Brings this app up to the hub's version: the hub fetches the installer when it does not have it yet, the app
 * downloads it and hands it on. Reports each step; resolves with the last one.
 */
export async function installFromHub(client: HubClient, onStep: (s: InstallStep) => void): Promise<InstallStep> {
  const step = (s: InstallStep) => { onStep(s); return s; };
  const platform = selfPlatform();
  if (!platform) return step({ state: "unavailable", text: "Only the Windows and Android apps update from the hub." });
  try {
    let view = await client.appUpdates();
    if ((compareVersions(view.version, APP_VERSION) ?? 0) <= 0) return step({ state: "current", text: `This app is ${APP_VERSION}, the same as your hub.` });
    let f = view.apps[platform];
    const deadline = Date.now() + 10 * 60_000;
    while (f.state !== "ready") {
      if (f.state === "unpublished") return step({ state: "unavailable", text: f.error ?? `The ${view.version} release has no app for this device yet.` });
      if (Date.now() > deadline) return step({ state: "failed", text: "The hub is still fetching the new app. Try again in a few minutes." });
      step({ state: "preparing", text: `Your hub is fetching Aeneas ${view.version} from its release.` });
      if (f.state === "missing" || f.state === "failed") {
        const tried = f.state === "failed";
        f = await client.prepareApp(platform);
        if (f.state === "failed" && tried) return step({ state: "failed", text: f.error ?? "The hub could not fetch the new app." });
        if (f.state === "ready" || f.state === "unpublished" || f.state === "failed") continue;
      }
      await sleep(2_000);
      view = await client.appUpdates();
      f = view.apps[platform];
    }
    if (!f.signature) return step({ state: "failed", text: "The hub's copy of the new app has no signature." });
    const total = f.size ?? 0;
    step({ state: "downloading", text: `Downloading Aeneas ${f.version}${total ? ` (${mb(total)})` : ""}.` });
    await appUpdateFile.begin(platform, f.version);
    let got = 0;
    await client.appFile(platform, async (piece) => {
      await appUpdateFile.piece(piece);
      got += piece.byteLength;
      onStep({ state: "downloading", text: `Downloading Aeneas ${f.version}: ${mb(got)}${total ? ` of ${mb(total)}` : ""}.` });
    });
    step({ state: "downloading", text: `Checking Aeneas ${f.version} against the release key.` });
    const out = await appUpdateFile.finish(f.signature);
    if (out === "installing") return step({ state: "installing", text: `Installing Aeneas ${f.version}. The app closes and opens again in about a minute.` });
    if (out === "permission") return step({ state: "permission", text: "Allow Aeneas to install apps in the screen Android opened, then come back and press Update app again." });
    return step({ state: "prompted", text: `Android is asking whether to update Aeneas to ${f.version}: tap Update.` });
  } catch (e) {
    return step({ state: "failed", text: e instanceof Error ? e.message : String(e) });
  }
}
