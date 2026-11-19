import { engine } from "../sync/engine";
import { HubError, type HubClient } from "../sync/api";
import { getMeta, META } from "../sync/db";
import { isAndroid, isWindowsApp, runHelperCommand, sshHelperCommand, windowLabel } from "../tauri/bridge";

/**
 * The Windows app on a helped person's computer (docs/helpers.md): while they let someone help them and this computer
 * is switched on for it (People who help you, Let ... use this computer), it asks their hub for work and runs each
 * command (src-tauri/src/helper.rs), sending the output back. The person is not asked each time: they chose to trust
 * their helper, and their hub writes everything in the log they can read. Only the main window runs it.
 */

const PREF = "ea.helperComputer";

/** Whether this computer lets a helper use it: on unless the person turned it off here. */
export function helperComputerOn(): boolean {
  try { return localStorage.getItem(PREF) !== "off"; } catch { return true; }
}

let wake: (() => void) | null = null;

export async function setHelperComputer(on: boolean): Promise<void> {
  try { localStorage.setItem(PREF, on ? "on" : "off"); } catch { /* private window */ }
  told = null;
  if (engine.client) await tell(engine.client).catch(() => {});
  wake?.();
}

/** Whether this app can be a helper's computer at all: the Windows app (not Android, not a browser). */
export const canBeHelperComputer = isWindowsApp && !isAndroid && typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

let told: unknown = null;
async function tell(c: HubClient): Promise<void> {
  if (told === c) return;
  const name = (await getMeta<string>(META.deviceName)) || "This computer";
  await c.setAgent({ on: helperComputerOn(), os: "windows", name });
  told = c;
}

const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r(); }; });

let started = false;

/** Starts the loop once, in the main window of the Windows app. */
export async function startHelperAgent(): Promise<void> {
  if (started || !canBeHelperComputer) return;
  if ((await windowLabel()) !== "main") return;
  started = true;
  for (;;) {
    const c = engine.client;
    if (!c) { await sleep(30_000); continue; }
    try {
      await tell(c);
      if (!helperComputerOn()) { await sleep(5 * 60_000); continue; }
      const r = await c.agentJobs(25);
      for (const job of r.jobs) {
        let out: { exit_code: number; output: string; host_key?: string };
        try {
          out = job.ssh ? await sshHelperCommand(job.ssh, job.command, job.timeout_s) : await runHelperCommand(job.command, job.timeout_s);
        } catch (e) { out = { exit_code: 1, output: String(e instanceof Error ? e.message : e) }; }
        await c.finishAgentJob(job.id, out).catch(() => {});
      }
      // Nobody helps now: ask again in two minutes, so saying yes on the phone reaches this computer soon.
      if (!r.helping) await sleep(2 * 60_000);
    } catch (e) {
      // A hub before 1.0.6 has no such route: nothing to do there, ever.
      if (e instanceof HubError && e.status === 404) return;
      told = null;
      await sleep(30_000);
    }
  }
}
