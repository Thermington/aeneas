import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type { HelpView, HubRequest, HubsList, PersonHub } from "../../sync/api";
import { invitationMessage, until } from "../../lib/invitation";
import { useHubIdentity } from "../../lib/hubIdentity";
import { engine } from "../../sync/engine";
import { SubPage, errorText } from "./common";
import { useHubReady } from "../../sync/hooks";

/**
 * Settings, People on this machine: give someone a hub of their own on the machine this hub runs on, in one step.
 * The hub asks deploy/people.sh's root service (hub/src/hubs.ts); this page follows it and then invites the person:
 * a QR code in person, or a message or a printed page for someone who lives elsewhere (docs/helpers.md). Beside each
 * person, Help with devices offers to help them (helping.ts on this hub, helpers.ts on theirs).
 */

const TAILSCALE_MACHINES = "https://login.tailscale.com/admin/machines";

/** The Settings row's summary, or null to leave the row out (another person's hub, a Mac hub). */
export function usePeopleSummary(): string | null {
  const [s, setS] = useState<string | null>(null);
  const ready = useHubReady();
  useEffect(() => {
    engine.client?.hubs().then(
      (h) => setS(h.reason === "not_owner" || h.reason === "linux_only" ? null : !h.available ? "Give someone their own hub here" : others(h.hubs) ? `${others(h.hubs)} more besides you` : "Only you so far"),
      () => setS(null),
    );
  }, [ready]);
  return s;
}
const others = (list: PersonHub[]) => list.filter((h) => !h.owner).length;

function Dot({ color }: { color: string }) {
  return <span className="hub-chip-dot" style={{ background: color || "var(--muted)", display: "inline-block" }} aria-hidden="true" />;
}

/** Follows one request until it is done or failed. */
function useRequest(id: string | null): HubRequest | null {
  const [r, setR] = useState<HubRequest | null>(null);
  useEffect(() => {
    setR(null);
    if (!id) return;
    let stop = false;
    const tick = async () => {
      while (!stop) {
        try {
          const now = await engine.client!.hubRequest(id);
          if (stop) return;
          setR(now);
          if (now.state === "done" || now.state === "failed") return;
        } catch (e) {
          if (!stop) setR({ state: "failed", error: errorText(e) });
          return;
        }
        await new Promise((res) => setTimeout(res, 2000));
      }
    };
    void tick();
    return () => { stop = true; };
  }, [id]);
  return r;
}

/** After a hub is made or a new invitation: how the person gets their phone onto it, in person, by message or on paper. */
function NextSteps({ result, note }: { result: HubRequest; note: string }) {
  const [qr, setQr] = useState("");
  const [how, setHow] = useState<"here" | "away" | null>(null);
  const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");
  const me = useHubIdentity()?.name ?? "";
  const app = result.pairing?.app;
  useEffect(() => { if (app) void QRCode.toDataURL(app, { margin: 2, width: 320, errorCorrectionLevel: "M" }).then(setQr); }, [app]);
  const name = result.name ?? "them";
  const expires = result.pairing?.expires_at;
  const message = app ? invitationMessage(name, me, app, expires) : "";
  const steps = (
    <ol className="col" style={{ paddingLeft: "1.3em", margin: 0, gap: 6 }}>
      <li>Install the Aeneas app: from the App Store on an iPhone or iPad, or from the release page on an Android phone.</li>
      <li>Open the phone&rsquo;s Camera and point it at this square.</li>
      <li>Tap the Aeneas link that appears. The phone connects by itself.</li>
    </ol>
  );
  return (
    <div className="card col simple">
      <h2>{result.address ? `${name}\u2019s hub is ready. Now invite ${name}` : `A new invitation for ${name}`}</h2>
      <p>The invitation works once, until {until(expires)}. It works from anywhere: {name} needs nothing else on the phone.</p>
      <div className="choices no-print">
        <button type="button" className={how === "here" ? "primary" : ""} onClick={() => setHow("here")}>{name} is here with me</button>
        <button type="button" className={how === "away" ? "primary" : ""} onClick={() => setHow("away")}>{name} lives somewhere else</button>
      </div>
      {how === "here" && (
        <div className="col" style={{ gap: 12 }}>
          {steps}
          {qr && <img className="qr" src={qr} width={320} height={320} alt={`Invitation for ${name}'s phone`} />}
        </div>
      )}
      {how === "away" && (
        <div className="col no-print" style={{ gap: 12 }}>
          <p>Send {name} a message with the invitation in it (a text or an email). It says what to do in three steps.</p>
          <div className="choices">
            <button type="button" className="primary" disabled={!message} onClick={() => void navigator.clipboard.writeText(message).then(() => setCopied("yes"), () => setCopied("failed"))}>{copied === "yes" ? "Copied. Paste it into a message" : `Copy a message for ${name}`}</button>
            <button type="button" disabled={!qr} onClick={() => window.print()}>Print it instead</button>
          </div>
          {copied === "failed" && (
            <label className="col">This app could not copy it. Select all of it here and copy it yourself:
              <textarea readOnly value={message} rows={9} onFocus={(e) => e.currentTarget.select()} style={{ fontSize: 15 }} />
            </label>
          )}
          <p className="muted">On paper, {name} scans the square with the phone&rsquo;s camera, the same as in person.</p>
        </div>
      )}
      {qr && (
        <div className="print-only print-sheet">
          <h1>Aeneas for {name}</h1>
          <p>{me ? `From ${me}. ` : ""}This works once, until {until(expires)}.</p>
          {steps}
          <img src={qr} width={360} height={360} alt="" />
        </div>
      )}
      {result.address && (
        <p className="muted small no-print">
          If {name} uses Tailscale, you can share this machine with {name} in the <a href={TAILSCALE_MACHINES} target="_blank" rel="noreferrer">Tailscale admin console</a> (Machines, this machine, Share), and {name} can use <code>{result.address}</code> instead.
        </p>
      )}
      <div className="muted small no-print">{note}</div>
    </div>
  );
}

/** Beside each person: whether you help them with their devices, and the button that changes it. */
function HelpRow({ person, onChange }: { person: PersonHub & { help: HelpView | null }; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const h = person.help;
  const n = person.name;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setMsg("");
    try { await fn(); setTimeout(onChange, 2500); } catch (e) { setMsg(errorText(e)); } finally { setBusy(false); }
  };
  const offer = () => act(() => engine.client!.offerHelp(person.account));
  const stop = () => {
    if (!window.confirm(`Stop helping ${n}? Your assistant can no longer check or fix ${n}'s devices, and ${n}'s passwords for you stay on ${n}'s hub.`)) return;
    void act(() => engine.client!.stopHelping(person.account));
  };
  const computers = h?.computers ?? [];
  return (
    <div className="col" style={{ gap: 4, paddingLeft: 22 }}>
      {!h && <div className="row" style={{ alignItems: "center", gap: 8 }}>
        <span className="muted small">Help {n} with a computer and phone: {n} says yes once in the app, and your assistant can then check and fix them.</span>
        <button type="button" className="small" disabled={busy || !person.up} onClick={() => void offer()}>Help {n} with devices</button>
      </div>}
      {h?.state === "waiting" && <span className="small">Waiting for {n} to say yes in the Aeneas app.</span>}
      {h?.state === "stopped" && <div className="row" style={{ alignItems: "center", gap: 8 }}><span className="small">{n} stopped your help.</span><button type="button" className="small" disabled={busy} onClick={() => void offer()}>Offer again</button></div>}
      {h?.state === "unreachable" && <span className="error small">{n}&rsquo;s hub does not answer.</span>}
      {h?.state === "helping" && (
        <div className="col" style={{ gap: 2 }}>
          <span className="ok small">You help {n}. Ask your assistant, for example: why is {n}&rsquo;s computer slow?</span>
          <span className="muted small">
            {[
              computers.length ? computers.map((c) => `${c.name} (${c.listening ? "on now" : "not answering now"})`).join(", ") : `No computer of ${n}'s lets you in yet: that needs the Aeneas app on it (Windows or Mac)`,
              h.scan ? `${h.scan.devices.length} devices found at home` : "",
              h.passwords.length ? `passwords saved for you: ${h.passwords.map((p) => p.title).join(", ")}` : "",
            ].filter(Boolean).join("; ")}.
          </span>
          <button type="button" className="ghost small" style={{ alignSelf: "flex-start" }} disabled={busy} onClick={stop}>Stop helping {n}</button>
        </div>
      )}
      {msg && <span className="error small">{msg}</span>}
    </div>
  );
}

export function PeoplePage() {
  const [data, setData] = useState<HubsList | null>(null);
  const [msg, setMsg] = useState<string>("");
  const [name, setName] = useState("");
  const [reqId, setReqId] = useState<string | null>(null);
  const [busyAccount, setBusyAccount] = useState("");
  const [op, setOp] = useState<"add" | "pair" | "stop" | null>(null);
  const req = useRequest(reqId);
  const ready = useHubReady();
  const [help, setHelp] = useState<Record<string, HelpView | null>>({});
  const load = () => {
    void engine.client?.hubs().then(setData, (e) => setMsg(errorText(e)));
    // Hubs before 1.0.6 have no helping: the rows then show no help line.
    void engine.client?.helpingPeople().then((r) => setHelp(Object.fromEntries(r.people.map((p) => [p.account, p.help]))), () => setHelp({}));
  };
  useEffect(load, [ready]);
  const finished = useRef<string | null>(null);
  useEffect(() => {
    if (req && (req.state === "done" || req.state === "failed") && finished.current !== reqId) { finished.current = reqId; setBusyAccount(""); load(); }
  }, [req?.state, reqId]);

  const add = async () => {
    setMsg("");
    try { setOp("add"); setReqId((await engine.client!.addHub(name.trim())).request_id); setName(""); } catch (e) { setMsg(errorText(e)); }
  };
  const newCode = async (h: PersonHub) => {
    setMsg("");
    setBusyAccount(h.account);
    try { setOp("pair"); setReqId((await engine.client!.pairHub(h.account)).request_id); } catch (e) { setMsg(errorText(e)); setBusyAccount(""); }
  };
  const stop = async (h: PersonHub) => {
    if (!window.confirm(`Stop ${h.name}’s hub? Their devices stop syncing and its address goes off. Their data stays on this machine, in their own account.`)) return;
    setMsg("");
    setBusyAccount(h.account);
    try { setOp("stop"); setReqId((await engine.client!.stopHub(h.account)).request_id); } catch (e) { setMsg(errorText(e)); setBusyAccount(""); }
  };

  const working = req && (req.state === "queued" || req.state === "working");

  return (
    <SubPage path="/settings/people">
      <p className="muted">
        Give someone a hub of their own on this machine: their own notes, chats, settings and devices, apart from yours.
        They use the model this machine runs; when you both ask at once, the hubs take turns.
      </p>
      {data && <div className="card small">{data.admin_note}</div>}
      {!data && !msg && <div className="muted small">Asking the hub.</div>}

      {data && !data.available && data.reason === "not_set_up" && (
        <div className="card col">
          <h2>One step first</h2>
          <div className="small">Run this once on the hub&rsquo;s machine, in a terminal (it asks for your password there). Then come back here.</div>
          <pre className="small" style={{ whiteSpace: "pre-wrap" }}><code>{data.setup_command}</code></pre>
        </div>
      )}
      {data && !data.available && data.reason === "not_owner" && <div className="muted">Only the machine owner&rsquo;s hub adds people.</div>}

      {data?.available && (
        <>
          <div className="card col">
            <h2>Hubs here</h2>
            {data.hubs.map((h) => (
              <div key={h.account} className="row wrap" style={{ alignItems: "center", gap: 8 }}>
                <Dot color={h.color} />
                <strong>{h.name}{h.owner ? " (you)" : ""}</strong>
                <span className="muted small">{h.address ?? `port ${h.port}`}</span>
                <span className={h.up ? "ok small" : "error small"}>{h.up ? "running" : "not answering"}</span>
                {!h.owner && (
                  <span className="row" style={{ marginLeft: "auto", gap: 6 }}>
                    <button type="button" className="small" disabled={!!working} onClick={() => void newCode(h)}>{busyAccount === h.account && working ? "Working" : "New invitation"}</button>
                    <button type="button" className="ghost small" disabled={!!working} onClick={() => void stop(h)}>Stop</button>
                  </span>
                )}
                {!h.owner && h.account in help && <div style={{ flexBasis: "100%" }}><HelpRow person={{ ...h, help: help[h.account] }} onChange={load} /></div>}
              </div>
            ))}
          </div>

          <form className="card col" onSubmit={(e) => { e.preventDefault(); void add(); }}>
            <h2>Add a person</h2>
            <div className="row">
              <input className="grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="Their first name" aria-label="Their name" maxLength={30} disabled={!!working} />
              <button type="submit" className="primary" disabled={!name.trim() || !!working}>Add</button>
            </div>
            <div className="muted small">It takes a minute or two. Their hub gets its own address and color on this machine.</div>
          </form>
        </>
      )}

      {working && <div className="card small" role="status">{req?.step ?? "Waiting for the machine to start on it"}</div>}
      {req?.state === "failed" && <div className="error">{req.error ?? "That did not work."}</div>}
      {req?.state === "done" && op !== "stop" && req.pairing && <NextSteps result={req} note={data?.admin_note ?? req.note ?? ""} />}
      {req?.state === "done" && op === "stop" && <div className="ok small">{req.name}&rsquo;s hub is stopped. Their data stays on this machine.</div>}
      {msg && <div className="error small">{msg}</div>}
    </SubPage>
  );
}
