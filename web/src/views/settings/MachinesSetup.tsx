import { useEffect, useState } from "react";
import { engine } from "../../sync/engine";
import type { HubMachine } from "../../sync/api";
import { relativePast } from "../../lib/time";
import { canUseThisComputer, lastReport, letHubSignIn, onReport, reportThisComputer, reportsThisComputer, setReportsThisComputer } from "../../lib/thisComputer";
import { Toggle, errorText } from "./common";
import { useModules } from "../../lib/modules";

const OS_NAME: Record<string, string> = { linux: "Linux", macos: "macOS", windows: "Windows" };

/**
 * Add machine (since 2026-11-20): an address, a user and the password once (or a password manager item). The hub signs
 * in with it, adds its own key there, checks that signing in with the key works, and keeps nothing but the key.
 */
export function AddMachineForm({ onAdded }: { onAdded?: (m: HubMachine) => void }) {
  const [address, setAddress] = useState("");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [item, setItem] = useState("");
  const [useItem, setUseItem] = useState(false);
  const [pm, setPm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState("");
  useEffect(() => { engine.client?.setup().then((v) => setPm(v.password_manager), () => {}); }, []);
  const secret = useItem ? item.trim() : password;
  const submit = async () => {
    const c = engine.client;
    if (!c || busy) return;
    setBusy(true);
    setErr("");
    setDone("");
    try {
      const r = await c.setupMachine({ address: address.trim(), user: user.trim(), ...(useItem ? { secret } : { password: secret }) });
      setPassword("");
      setDone(`${r.created ? "Added" : "Set up again:"} ${r.machine.name}${r.machine.os ? ` (${OS_NAME[r.machine.os] ?? r.machine.os})` : ""}. The hub signs in with its own key now.`);
      setAddress("");
      onAdded?.(r.machine);
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <form className="col add-machine" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="row">
        <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Address, like nas.local or 192.168.1.20" aria-label="Address" autoCapitalize="off" spellCheck={false} style={{ flex: 2 }} />
        <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="User" aria-label="User name" autoCapitalize="off" spellCheck={false} autoComplete="off" style={{ flex: 1 }} />
      </div>
      <div className="row">
        {useItem
          ? <input value={item} onChange={(e) => setItem(e.target.value)} placeholder="Password manager item, like Tech/NAS" aria-label="Password manager item" autoCapitalize="off" spellCheck={false} style={{ flex: 1 }} />
          : <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" aria-label="Password" autoComplete="off" style={{ flex: 1 }} />}
        <button type="submit" className="primary" disabled={busy || !address.trim() || !user.trim() || !secret}>{busy ? "Adding…" : "Add"}</button>
      </div>
      {pm && (
        <button type="button" className="link small" onClick={() => setUseItem(!useItem)}>
          {useItem ? "Type the password instead" : "Use a password manager item instead"}
        </button>
      )}
      <div className="muted small">
        The password is used once, to put the hub's key there, and is not kept. The computer needs SSH on: on a Mac, System Settings, General, Sharing, Remote Login; on Windows, Settings, System, Optional features, OpenSSH Server; on Linux, the openssh-server package.
      </div>
      {busy && <div className="muted small">Signing in and adding the hub's key. This takes a few seconds.</div>}
      {done && <div className="ok small" role="status">{done}</div>}
      {err && <div className="error small" role="alert">{err}</div>}
    </form>
  );
}

/**
 * The hub's public SSH key, for a machine that takes only keys: added by hand to the account's authorized keys
 * (~/.ssh/authorized_keys; on Windows, an administrator's goes in C:\ProgramData\ssh\administrators_authorized_keys).
 */
export function HubKey() {
  const [key, setKey] = useState("");
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");
  const show = () => { engine.client?.hubKey().then((r) => setKey(r.public_key), (e) => setErr(errorText(e))); };
  if (!key) return (
    <div className="col">
      <button type="button" className="link small" onClick={show}>Show the hub's key, to add by hand</button>
      {err && <div className="error small">{err}</div>}
    </div>
  );
  return (
    <div className="col">
      <code className="small" style={{ wordBreak: "break-all", userSelect: "all" }}>{key}</code>
      <div className="row">
        <button type="button" className="small" onClick={() => { void navigator.clipboard?.writeText(key).then(() => setCopied(true), () => {}); }}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <div className="muted small">One line in that account's ~/.ssh/authorized_keys. On Windows, an administrator's goes in C:\ProgramData\ssh\administrators_authorized_keys.</div>
    </div>
  );
}

/**
 * The Windows app's own computer: Show this computer in Tech (its readings every 10 minutes while the app runs) and
 * Let the hub sign in to this computer (one administrator prompt). Both off until ticked or pressed.
 */
export function ThisComputer() {
  const [on, setOn] = useState(reportsThisComputer());
  const [report, setReport] = useState(lastReport());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState("");
  useEffect(() => onReport(() => setReport(lastReport())), []);
  const modules = useModules();
  if (!canUseThisComputer) return null;
  const flip = async (v: boolean) => {
    setOn(v);
    await setReportsThisComputer(v);
    if (v) reportThisComputer().catch((e) => setErr(errorText(e)));
  };
  const signIn = async () => {
    setBusy(true);
    setErr("");
    setDone("");
    try {
      const r = await letHubSignIn();
      setDone(`Done: the hub signs in to ${r.name} as ${r.user} with its own key. The assistant can run commands here now; anything that changes this computer waits for your yes.`);
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  const hubReads = report?.read_by_hub;
  return (
    <div className="col">
      <Toggle checked={on} onChange={(v) => void flip(v)} label="Show this computer in Tech"
        note={hubReads
          ? `The hub already signs in to ${report!.name} and reads it itself, so this app sends nothing.`
          : report?.error
            ? `Not sent: ${report.error}`
            : report
              ? `Its CPU, memory and disks go to the hub every 10 minutes while this app runs. Last sent ${relativePast(report.at)}.`
              : "Its CPU, memory and disks go to the hub every 10 minutes while this app runs, read the same way the hub reads its machines."} />
      {on && !hubReads && !modules.on("sensors") && <div className="muted small">Its readings show once Sensors is on too (Settings, Modules, Tech); until then Tech shows only what it runs.</div>}
      {!hubReads && (
        <div className="col">
          <div className="row">
            <button type="button" onClick={() => void signIn()} disabled={busy}>{busy ? "Waiting for Windows…" : "Let the hub sign in to this computer"}</button>
          </div>
          <div className="muted small">
            Windows asks an administrator once. It turns on Windows' SSH server, starts it with Windows and adds the hub's key, so the hub reads this computer itself and the assistant can run commands here. The first time, Windows may take a few minutes to install the server.
          </div>
        </div>
      )}
      {done && <div className="ok small" role="status">{done}</div>}
      {err && <div className="error small" role="alert">{err}</div>}
    </div>
  );
}

/**
 * What Machines offers right after it is switched on (Settings, Modules and Welcome): add a computer or device, this
 * computer's own choices on the Windows app, and how the assistant can add one.
 */
export function MachinesStart({ onDone, onAdded }: { onDone: () => void; onAdded?: () => void }) {
  const [pm, setPm] = useState<boolean | null>(null);
  useEffect(() => { engine.client?.setup().then((v) => setPm(v.password_manager), () => setPm(null)); }, []);
  return (
    <div className="card col machines-start" role="region" aria-label="Set up Machines">
      <div className="row between">
        <strong>Set up Machines</strong>
        <button type="button" className="small ghost" onClick={onDone}>Done</button>
      </div>
      <div className="muted small">All of these are optional, and you can come back to them in Tech, Add machine.</div>
      <h3 className="small-heading">Add a computer or device</h3>
      <AddMachineForm onAdded={onAdded} />
      {canUseThisComputer && (
        <>
          <h3 className="small-heading">This computer</h3>
          <ThisComputer />
        </>
      )}
      <h3 className="small-heading">With the assistant</h3>
      <div className="small">
        Tell it to add one whose password is in your password manager, like "add the NAS at 192.168.1.20 as admin, the password is the NAS item". It asks before it signs in. {pm === false && <>Link a password manager first in <a href="#/settings/connections">Settings, Connections</a>.</>}
      </div>
    </div>
  );
}
