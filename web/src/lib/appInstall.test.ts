import { beforeEach, describe, expect, it, vi } from "vitest";

const installed: { platform: string; version: string; signature: string; size: number }[] = [];
let installAnswer: string | Error = "installing";
vi.mock("../tauri/bridge", () => ({
  isTauri: true,
  isAndroid: false,
  isWindowsApp: true,
  appUpdateFile: (() => {
    let cur = { platform: "", version: "", size: 0 };
    return {
      begin: async (platform: string, version: string) => { cur = { platform, version, size: 0 }; },
      piece: async (bytes: Uint8Array) => { cur.size += bytes.byteLength; },
      finish: async (signature: string) => {
        installed.push({ ...cur, signature });
        if (installAnswer instanceof Error) throw installAnswer.message; // Tauri rejects with the command's text
        return installAnswer;
      },
    };
  })(),
}));
vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });

import type { AppUpdatesView, HubAppFile, HubClient } from "../sync/api";
import { APP_VERSION } from "./appUpdate";
import { appKind, installFromHub, type InstallStep } from "./appInstall";

const NEXT = "99.0.0";
function hub(states: HubAppFile["state"][], version = NEXT) {
  let i = 0;
  const file = (state: HubAppFile["state"]): HubAppFile => ({
    platform: "windows", version, state, file: "Aeneas-windows-setup.exe",
    ...(state === "ready" ? { size: 4, sha256: "ab", signature: "c2ln" } : {}),
    ...(state === "unpublished" ? { error: "The release has no signed Windows app yet." } : {}),
  });
  const calls: string[] = [];
  const client = {
    appUpdates: async () => { calls.push("view"); return { version, repo: "x/y", apps: { windows: file(states[Math.min(i, states.length - 1)]), android: file("missing") }, devices: [], you: null } as AppUpdatesView; },
    prepareApp: async () => { calls.push("prepare"); i++; return file(states[Math.min(i, states.length - 1)]); },
    appFile: async (_p: string, onPiece: (b: Uint8Array) => Promise<void>) => { calls.push("file"); await onPiece(new Uint8Array([1, 2])); await onPiece(new Uint8Array([3, 4])); return 4; },
  } as unknown as HubClient;
  return { client, calls };
}

describe("updating the app from the hub", () => {
  beforeEach(() => { installed.length = 0; installAnswer = "installing"; });

  it("is the Windows app here", () => expect(appKind()).toBe("windows"));

  it("says so when the app already runs the hub's version", async () => {
    const { client } = hub(["ready"], APP_VERSION);
    expect((await installFromHub(client, () => {})).state).toBe("current");
    expect(installed).toHaveLength(0);
  });

  it("has the hub fetch the installer, downloads it, and hands it on with the signature", async () => {
    const { client, calls } = hub(["missing", "ready"]);
    const steps: InstallStep[] = [];
    const last = await installFromHub(client, (s) => steps.push(s));
    expect(last.state).toBe("installing");
    expect(calls).toContain("prepare");
    expect(steps.map((s) => s.state)).toContain("downloading");
    expect(installed).toEqual([{ platform: "windows", version: NEXT, size: 4, signature: "c2ln" }]);
  });

  it("stops when the release has no app, and passes on the app's refusal", async () => {
    expect((await installFromHub(hub(["unpublished"]).client, () => {})).text).toMatch(/no signed Windows app/);
    installAnswer = new Error("The update's signature does not match the release key, so it was not installed.");
    const out = await installFromHub(hub(["ready"]).client, () => {});
    expect(out.state).toBe("failed");
    expect(out.text).toMatch(/signature does not match/);
  });
});
