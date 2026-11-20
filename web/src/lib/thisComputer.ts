import { HOST_SCRIPTS } from "@everythingapp/shared";
import { engine } from "../sync/engine";
import { HubError } from "../sync/api";
import { isAndroid, isWindowsApp, runHelperCommand, windowLabel } from "../tauri/bridge";

/**
 * The Windows app's own computer in Tech (since 2026-11-20), both optional and off until the person ticks them:
 * - Show this computer in Tech: every 10 minutes while the app runs, it runs the same read-only script the hub runs
 *   on Windows machines (HOST_SCRIPTS.windows) and sends the output (PUT /devices/me/computer).
 * - Let the hub sign in to this computer: one administrator prompt turns on Windows' OpenSSH Server and adds the
 *   hub's key (GET /machines/hub-key); the app sends the computer's SSH host keys, read here, and the hub adds the
 *   computer once signing in with its key works (POST /devices/me/computer/access).
 */

const PREF = "ea.reportComputer";
const EVERY_MS = 10 * 60_000;

/** The Windows app (not Android, not a browser). In development, `ea.previewThisComputer` shows it for screenshots. */
export const canUseThisComputer = (isWindowsApp && !isAndroid && typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent))
  || (import.meta.env.DEV && (() => { try { return localStorage.getItem("ea.previewThisComputer") === "1"; } catch { return false; } })());

export function reportsThisComputer(): boolean {
  try { return localStorage.getItem(PREF) === "on"; } catch { return false; }
}

export interface ReportState { at: string; name: string; read_by_hub: boolean; error?: string }
let last: ReportState | null = null;
const listeners = new Set<() => void>();
export const lastReport = (): ReportState | null => last;
export function onReport(f: () => void): () => void { listeners.add(f); return () => { listeners.delete(f); }; }
const told = () => listeners.forEach((f) => f());

/** The lines `name=` and the like from a script's output. */
export function keyValues(out: string): Record<string, string[]> {
  const v: Record<string, string[]> = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^([a-z_]+)=(.*)$/.exec(line.trim());
    if (m) (v[m[1]] ??= []).push(m[2].trim());
  }
  return v;
}

/** Read this computer and send it; returns what the hub said. */
export async function reportThisComputer(): Promise<ReportState> {
  const c = engine.client;
  if (!c) throw new Error("Not connected to a hub");
  const r = await runHelperCommand(`'name=' + $env:COMPUTERNAME\n${HOST_SCRIPTS.windows}`, 90);
  const name = (keyValues(r.output).name?.[0] ?? "").toLowerCase();
  if (!name) throw new Error("this computer's name could not be read");
  try {
    const sent = await c.reportComputer({ name, output: r.output });
    last = { at: new Date().toISOString(), name: sent.name, read_by_hub: sent.read_by_hub };
  } catch (e) {
    last = { at: new Date().toISOString(), name, read_by_hub: false, error: e instanceof Error ? e.message : String(e) };
  }
  told();
  return last;
}

let wake: (() => void) | null = null;
const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r(); }; });

export async function setReportsThisComputer(on: boolean): Promise<void> {
  try { localStorage.setItem(PREF, on ? "on" : "off"); } catch { /* private window */ }
  if (!on) { last = null; told(); }
  wake?.();
}

let started = false;
/** Starts the loop once, in the main window of the Windows app; it sends nothing until the person ticks it. */
export async function startComputerReports(): Promise<void> {
  if (started || !canUseThisComputer) return;
  if ((await windowLabel()) !== "main") return;
  started = true;
  for (;;) {
    if (!engine.client || !reportsThisComputer()) { await sleep(60_000); continue; }
    try {
      const r = await reportThisComputer();
      // The hub signs in to this computer itself: nothing for the app to send.
      if (r.read_by_hub) { await sleep(6 * EVERY_MS); continue; }
    } catch (e) {
      // A hub before 1.0.8 has no such route: nothing to send there, ever.
      if (e instanceof HubError && e.status === 404) return;
    }
    await sleep(EVERY_MS);
  }
}

/**
 * The script for the one administrator prompt. Run as the signed-in person, it adds the hub's key to their own
 * authorized keys when they are not an administrator, then starts an elevated PowerShell that turns on OpenSSH
 * Server (installing it when Windows does not have it yet), starts it at boot, opens its firewall rule, adds the
 * key to the administrators' file with its required permissions for an administrator, and reads the host keys.
 * The elevated part writes its answer to a file the first part reads, since an elevated window's output cannot be
 * read directly (and with another administrator's password it may run as that person).
 */
export function accessScript(publicKey: string): string {
  const k = publicKey.replace(/'/g, "").trim();
  const inner = [
    "$ErrorActionPreference = 'Stop'",
    `$k = '${k}'`,
    "$out = '__OUT__'",
    "$admin = __ADMIN__",
    "$lines = @()",
    "try {",
    "  $cap = Get-WindowsCapability -Online | Where-Object { $_.Name -like 'OpenSSH.Server*' } | Select-Object -First 1",
    "  if ($cap -and $cap.State -ne 'Installed') { Add-WindowsCapability -Online -Name $cap.Name | Out-Null }",
    "  Set-Service -Name sshd -StartupType Automatic",
    "  Start-Service sshd",
    "  if (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue) { Enable-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' } else { New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null }",
    "  if ($admin) {",
    "    $f = Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys'",
    "    if (!(Test-Path $f) -or !((Get-Content $f) -contains $k)) { Add-Content -Path $f -Value $k -Encoding ascii }",
    "    icacls $f /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null",
    "  }",
    "  Get-ChildItem (Join-Path $env:ProgramData 'ssh') -Filter 'ssh_host_*_key.pub' | ForEach-Object { $lines += 'hostkey=' + (Get-Content $_.FullName -Raw).Trim() }",
    "  $lines += 'ok=1'",
    "} catch { $lines += 'error=' + $_.Exception.Message }",
    "Set-Content -Path $out -Value $lines -Encoding UTF8",
  ].join("\n");
  return [
    `$k = '${k}'`,
    "$admin = [bool]((whoami /groups) -match 'S-1-5-32-544')",
    "if (-not $admin) {",
    "  $d = Join-Path $env:USERPROFILE '.ssh'; New-Item -ItemType Directory -Force -Path $d | Out-Null",
    "  $f = Join-Path $d 'authorized_keys'",
    "  if (!(Test-Path $f) -or !((Get-Content $f) -contains $k)) { Add-Content -Path $f -Value $k -Encoding ascii }",
    "}",
    "$out = Join-Path $env:TEMP ('aeneas-ssh-' + [guid]::NewGuid().ToString('N') + '.txt')",
    `$inner = @'\n${inner}\n'@`,
    "$inner = $inner.Replace('__OUT__', $out).Replace('__ADMIN__', $(if ($admin) { '$true' } else { '$false' }))",
    "$enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))",
    "try { Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand',$enc } catch { 'error=declined' }",
    "if (Test-Path $out) { Get-Content $out; Remove-Item $out -Force }",
    "'user=' + $env:USERNAME",
    "'name=' + $env:COMPUTERNAME",
  ].join("\n");
}

/** Let the hub sign in to this computer: the administrator prompt, then the hub's check. Errors in plain words. */
export async function letHubSignIn(): Promise<{ name: string; user: string }> {
  const c = engine.client;
  if (!c) throw new Error("Not connected to a hub");
  const { public_key } = await c.hubKey();
  // Installing OpenSSH Server from Windows Update can take several minutes the first time.
  const r = await runHelperCommand(accessScript(public_key), 900);
  const v = keyValues(r.output);
  const error = v.error?.[0];
  if (error === "declined") throw new Error("Windows did not get an administrator's yes, so nothing changed.");
  if (error) throw new Error(`Windows could not turn on its SSH server: ${error}`);
  if (!v.ok) throw new Error("Windows did not say whether its SSH server is on.");
  const name = (v.name?.[0] ?? "").toLowerCase();
  const user = v.user?.[0] ?? "";
  const host_keys = v.hostkey ?? [];
  const out = await c.computerAccess({ name, user, os: "windows", host_keys, addresses: [name] });
  return { name: out.machine.name, user };
}
