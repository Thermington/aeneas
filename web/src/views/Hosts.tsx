import { plainError } from "../lib/errors";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Entity } from "@everythingapp/shared";
import { useEntities, useEntity } from "../sync/hooks";
import { createEntity, softDelete, updateEntity } from "../sync/edits";
import { engine } from "../sync/engine";
import { copyText } from "../sync/memory";
import { type RunbookCommand, type RunbookF, type SnippetF } from "../lib/memory";
import { Markdown } from "../components/Markdown";
import { replace } from "../lib/router";
import { usePoll } from "../lib/usePoll";
import { identityLine, kindName, targetHost, thingStatus, type Thing } from "../lib/tech";
import type { OpsMonitor } from "../lib/ops";
import { HubBackupCard, MonitorCard, MonitorEditor } from "./Ops";
import { ReadingCard } from "./Sensors";
import { useDraftSave } from "../lib/useDraftSave";
import { fmtDateTime } from "../lib/time";
import { HistoryList, NoteChange, PlannedSteps } from "./History";
import { historyItems, plannedSteps } from "../lib/history";

export function Hosts({ host, runbookId, focus }: { host?: string; runbookId?: string | null; focus?: string | null }) {
  // A link to fix notes names only the notes (search, linked items): open them on their machine's page.
  const rb = useEntity(!host && runbookId ? runbookId : undefined);
  const name = host ? decodeURIComponent(host) : typeof rb?.fields.host === "string" && rb.fields.host.trim() ? rb.fields.host : null;
  if (name) return <HostPage host={name} runbookId={runbookId ?? undefined} focus={focus ?? undefined} />;
  return <ToOverview />;
}

/** Every machine has a card on the Overview since 2026-11-19: the old list sends there. */
function ToOverview() {
  useEffect(() => replace("/ops"), []);
  return null;
}

/** Machine names compare without case ("NAS" and "nas" are one machine, as the Machines list counts them). */
const sameHost = (a: unknown, b: string) => typeof a === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();

function HostPage({ host, runbookId, focus }: { host: string; runbookId?: string; focus?: string }) {
  const runbooks = useEntities("runbook", (e) => sameHost(e.fields.host, host), [host]);
  const snippets = useEntities("snippet", (e) => sameHost(e.fields.host, host), [host]);
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    if (runbookId) document.getElementById(`runbook-${runbookId}`)?.scrollIntoView({ block: "start" });
  }, [runbookId, runbooks.length]);

  const newRunbook = async () => {
    const e = await createEntity("runbook", { host, title: `Fix notes: ${host}`, body: `# ${host}\n`, commands: [] });
    setEditing(e.id);
  };

  return (
    <div className="host-page">
      <div className="row between">
        <h1 style={{ margin: 0, fontFamily: "var(--mono)" }}>{host}</h1>
        <a href="#/ops" className="small">
          Overview
        </a>
      </div>
      <ThingStatus host={host} focus={focus} />

      <section style={{ marginTop: 16 }}>
        <div className="row between">
          <h2 style={{ margin: 0 }}>Fix notes</h2>
          {!runbooks.length && (
            <button className="small primary" onClick={() => void newRunbook()}>
              Start fix notes
            </button>
          )}
        </div>
        {!runbooks.length && <div className="muted small" style={{ marginTop: 6 }}>No fix notes for {host} yet. They are what broke on this machine and how it was fixed. The assistant writes them when you finish a troubleshooting chat about {host}, or start them yourself.</div>}
        {runbooks
          .slice()
          .sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1))
          .map((rb) =>
            editing === rb.id ? <RunbookEditor key={rb.id} id={rb.id} onClose={() => setEditing(null)} /> : <RunbookView key={rb.id} rb={rb} onEdit={() => setEditing(rb.id)} focus={rb.id === runbookId} />,
          )}
      </section>

      <section style={{ marginTop: 20 }}>
        <div className="row between">
          <h2 style={{ margin: 0 }}>Snippets</h2>
          <a href={`#/snippets/new?host=${encodeURIComponent(host)}`} className="small">
            new snippet
          </a>
        </div>
        {!snippets.length && <div className="muted small" style={{ marginTop: 6 }}>No snippets tied to {host}.</div>}
        <div className="list" style={{ marginTop: 8 }}>
          {snippets.map((s) => {
            const f = s.fields as SnippetF;
            return (
              <a key={s.id} href={`#/snippets/${s.id}`} className="item" style={{ color: "inherit" }}>
                <div className="body">
                  <div className="t">{f.title}</div>
                  <div className="meta">
                    <span>{f.os}</span>
                    <span>{f.language}</span>
                    {(f.tags ?? []).map((t) => (
                      <span key={t}>#{t}</span>
                    ))}
                  </div>
                </div>
              </a>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export function CommandsTable({ commands }: { commands: RunbookCommand[] }) {
  const [copied, setCopied] = useState<number | null>(null);
  if (!commands.length) return null;
  return (
    <div className="table-wrap" style={{ marginTop: 8 }}>
      <table className="cmds">
        <thead>
          <tr>
            <th scope="col">Label</th>
            <th scope="col">User</th>
            <th scope="col">Command</th>
            <th scope="col">
              <span className="sr-only">Copy</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {commands.map((c, i) => (
            <tr key={i}>
              <td>{c.label}</td>
              <td className="mono">
                {c.user}
                {c.host ? `@${c.host}` : ""}
              </td>
              <td className="mono cmd">{c.command}</td>
              <td>
                <button
                  className="small ghost"
                  onClick={() =>
                    copyText(c.command).then((ok) => {
                      setCopied(ok ? i : null);
                      setTimeout(() => setCopied(null), 1500);
                    })
                  }
                  aria-label={`Copy ${c.label}`}
                >
                  {copied === i ? "copied" : "Copy"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunbookView({ rb, onEdit, focus }: { rb: Entity; onEdit: () => void; focus?: boolean }) {
  const f = rb.fields as RunbookF;
  return (
    <div id={`runbook-${rb.id}`} className={`card runbook ${focus ? "focus" : ""}`} style={{ marginTop: 8 }}>
      <div className="row between">
        <strong>{f.title}</strong>
        <div className="row">
          {f.last_verified && <span className="muted small">verified {fmtDateTime(f.last_verified)}</span>}
          <button className="small" onClick={onEdit} aria-label={`Edit ${f.title}`}>
            Edit
          </button>
        </div>
      </div>
      {f.body?.trim() ? <Markdown text={f.body} images="link" /> : <div className="muted small">Empty. Edit to write it.</div>}
      <CommandsTable commands={f.commands ?? []} />
    </div>
  );
}

type RunbookDraft = { title: string; body: string; commands: RunbookCommand[] };

const runbookDraft = (raw: Record<string, unknown>): RunbookDraft => {
  const f = raw as RunbookF;
  return { title: f.title, body: f.body ?? "", commands: f.commands ?? [] };
};

/**
 * The same plain textarea editor as Notes: edits save together a second after the last keystroke, and at once on Done,
 * on closing the editor (another machine, another screen) or when the app is hidden.
 */
function RunbookEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const rb = useEntity(id);
  const { draft, edit, flush, saved } = useDraftSave(rb, { toDraft: runbookDraft });

  const setCmd = (i: number, patch: Partial<RunbookCommand>) => {
    if (!draft) return;
    edit({ commands: draft.commands.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  };

  if (!rb || !draft) return <div className="empty">Fix notes not found.</div>;
  const host = String(rb.fields.host);
  return (
    <div className="card col" style={{ marginTop: 8 }}>
      <input value={draft.title} onChange={(e) => edit({ title: e.target.value })} aria-label="Fix notes title" style={{ fontWeight: 600 }} />
      <textarea value={draft.body} onChange={(e) => edit({ body: e.target.value })} rows={14} className="mono" aria-label="Fix notes" placeholder="One section per problem: ## YYYY-MM-DD: what broke, then what fixed it" spellCheck={false} />
      <div>
        <div className="row between">
          <strong className="small">Commands</strong>
          <button className="small" onClick={() => edit({ commands: [...draft.commands, { label: "", host, user: "root", command: "" }] })}>
            Add command
          </button>
        </div>
        {draft.commands.map((c, i) => (
          <div key={i} className="cmd-row" style={{ marginTop: 6 }}>
            <input value={c.label} onChange={(e) => setCmd(i, { label: e.target.value })} placeholder="Label" aria-label={`Command ${i + 1} label`} />
            <input value={c.user} onChange={(e) => setCmd(i, { user: e.target.value })} placeholder="user" aria-label={`Command ${i + 1} user`} className="mono" autoCapitalize="off" />
            <input value={c.command} onChange={(e) => setCmd(i, { command: e.target.value })} placeholder="command" aria-label={`Command ${i + 1}`} className="mono" autoCapitalize="off" spellCheck={false} />
            <button className="small ghost danger" onClick={() => edit({ commands: draft.commands.filter((_, j) => j !== i) })} aria-label={`Remove command ${i + 1}`}>
              x
            </button>
          </div>
        ))}
      </div>
      <div className="row between small muted">
        <span>{saved ? `saved ${fmtDateTime(rb.updated_at)}` : "editing"}</span>
        <div className="row">
          <button className="small" onClick={() => void flush().then(onClose)}>
            Done
          </button>
          <button className="small ghost danger" onClick={() => confirm("Delete these fix notes") && softDelete(rb).then(onClose)}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The top of a machine's, service's or place's page: its checks (with history, Check now, Propose a fix while down,
 * Edit and Add check), its readings with graphs, alert bounds and Propose a fix while one alerts, and its History:
 * planned steps to mark done, a line for a change made by hand, and everything that happened, newest first. Checks and incidents come from the synced
 * entities, so the page still shows them when the hub cannot be reached; the grouping and readings come from the hub.
 */
function ThingStatus({ host, focus }: { host: string; focus?: string }) {
  const p = usePoll((c) => c.ops(), 30_000);
  const sp = usePoll((c) => c.sensors(), 60_000);
  const key = host.trim().toLowerCase();
  const allMonitors = useEntities("monitor");
  const incidents = useEntities("incident");
  const [open, setOpen] = useState<string | null>(focus ?? null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const reload = useCallback(async () => { await Promise.all([p.reload(), sp.reload()]); }, [p.reload, sp.reload]);
  useEffect(() => engine.onNotify((n) => (n.kind === "monitor" || n.kind === "sensor") && void reload()), [reload]);

  const thing = p.data?.things?.find((t) => t.name === key) ?? null;
  const fromHub = new Map((p.data?.monitors ?? []).map((m) => [m.id, m]));
  const openIncidents = incidents.filter((i) => !i.fields.closed_at);
  // The hub's monitors carry their open incident; offline, the synced ones get it here.
  const monitors: OpsMonitor[] = allMonitors
    .filter((m) => (thing ? thing.monitors.includes(m.id) : sameHost(m.fields.host || targetHost(String(m.fields.type ?? ""), String(m.fields.target ?? "")), key)))
    .map((m) => fromHub.get(m.id) ?? { ...m, incident_open: openIncidents.find((i) => i.fields.monitor_id === m.id || i.id === m.fields.joined_incident) ?? null })
    .sort((a, b) => String(a.fields.name).localeCompare(String(b.fields.name)));
  const readings = (sp.data ?? []).filter((s) => (thing ? thing.sensors.includes(s.name) : sameHost(s.location, key))).sort((a, b) => readingOrder(a.name) - readingOrder(b.name) || a.name.localeCompare(b.name));
  const self: Thing = thing ?? { name: key, label: host, kind: "machine", monitors: monitors.map((m) => m.id), sensors: readings.map((s) => s.name), reachable: false };
  const ids = new Set(monitors.map((m) => m.id));
  const hubBackup = self.hub ? p.data?.hub_backup ?? [] : [];
  const uptime = new Map((p.data?.uptime_24h ?? []).map((u) => [u.name, u.pct]));
  const st = thingStatus(self, new Map(monitors.map((m) => [m.id, m])), new Map(readings.map((s) => [s.name, s])), hubBackup);
  const journal = useEntities("journal");
  const runbooks = useEntities("runbook");
  const history = useMemo(() => historyItems({ journal, incidents, runbooks, hostOf: (id) => (ids.has(id) ? key : undefined) }, key), [journal, incidents, runbooks, monitors.length, key]);
  const planned = plannedSteps(journal, key);

  useEffect(() => {
    if (focus) document.getElementById(`mon-${focus}`)?.scrollIntoView({ block: "start" });
  }, [focus, monitors.length]);

  return (
    <>
      {self.kind === "machine" && thing && (
        <div style={{ marginTop: 2, overflowWrap: "anywhere" }}>
          <strong>{kindName(self)}</strong>
          {identityLine(self) && <span className="muted"> · {identityLine(self)}</span>}
        </div>
      )}
      <div className="row" style={{ gap: 8, marginTop: 4 }}>
        <span className={`chip static tone-${st.tone}`}>{st.label}</span>
        <span className="muted small">
          {[self.hub ? "the machine the hub runs on" : "", self.kind === "service" ? "a service on the internet" : self.kind === "place" ? "sensor boards here" : "", self.reachable ? "the hub reads it and the assistant can run commands on it" : self.reports_itself ? "its Aeneas app sends its readings" : self.kind === "machine" && !self.hub ? "checked from the hub" : ""].filter(Boolean).join("; ")}
        </span>
      </div>


      {self.kind === "machine" && <Purpose name={key} />}

      {(monitors.length > 0 || hubBackup.length > 0 || self.kind !== "place") && (
        <section style={{ marginTop: 16 }}>
          <div className="row between">
            <h2 style={{ margin: 0 }}>Checks</h2>
            <button className="small" onClick={() => setEditing((e) => (e === "new" ? null : "new"))}>Add check</button>
          </div>
          {editing === "new" && <MonitorEditor key="new" monitor={null} host={key} hosts={[key]} onDone={() => { setEditing(null); void reload(); }} />}
          {!monitors.length && !hubBackup.length && <div className="muted small" style={{ marginTop: 6 }}>No checks on {self.label}. A ping says whether it is on; a port or web address says whether a service on it answers.</div>}
          <div className="ops-grid" style={{ marginTop: 8 }}>
            {hubBackup.length > 0 && <HubBackupCard lines={hubBackup} />}
            {monitors.map((m) =>
              editing === m.id ? (
                <MonitorEditor key={m.id} monitor={m} hosts={[key]} onDone={() => { setEditing(null); void reload(); }} />
              ) : (
                <MonitorCard key={m.id} m={m} pct={uptime.get(String(m.fields.name)) ?? null} open={open === m.id} onToggle={() => setOpen((o) => (o === m.id ? null : m.id))} onEdit={() => setEditing(m.id)} onChanged={reload} />
              ),
            )}
          </div>
        </section>
      )}

      {(readings.length > 0 || self.reachable) && (
        <section style={{ marginTop: 20 }}>
          <h2 style={{ margin: 0 }}>Now</h2>
          {!readings.length && <div className="muted small" style={{ marginTop: 6 }}>No readings yet. With Sensors on, the hub reads its CPU, memory, disks and temperatures every 10 minutes.</div>}
          <div className="grid2" style={{ marginTop: 8 }}>
            {readings.map((s) => <ReadingCard key={s.id} s={s} thing={self.kind === "place" ? undefined : key} onSaved={sp.reload} />)}
          </div>
        </section>
      )}

      <section style={{ marginTop: 20 }}>
        <h2 style={{ margin: 0 }}>History</h2>
        <PlannedSteps steps={planned} />
        <NoteChange host={key} />
        <HistoryList items={history} />
      </section>
    </>
  );
}

/**
 * What this machine is for, in the owner's words: its fact `host:<name>` in Memory, which the assistant reads whenever
 * the machine comes up, and which it writes itself when told ("pve1 runs the domain controllers"). Saving empty removes it.
 */
function Purpose({ name }: { name: string }) {
  const facts = useEntities("fact", (e) => String(e.fields.key ?? "").trim().toLowerCase() === `host:${name}`, [name]);
  const fact = facts[0];
  const value = typeof fact?.fields.value === "string" ? fact.fields.value : "";
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const [err, setErr] = useState("");
  useEffect(() => { if (!editing) setText(value); }, [value, editing]);
  const save = async () => {
    setErr("");
    const next = text.trim();
    try {
      if (fact && !next) await softDelete(fact);
      else if (fact) await updateEntity(fact, { value: next });
      else if (next) await createEntity("fact", { category: "host", key: `host:${name}`, value: next, source: "user", confidence: 1 });
      setEditing(false);
    } catch (e) {
      setErr(plainError(e));
    }
  };
  return (
    <section style={{ marginTop: 12 }}>
      <div className="row between">
        <h2 style={{ margin: 0 }}>Purpose</h2>
        {!editing && <button className="small ghost" onClick={() => setEditing(true)}>{value ? "Edit" : "Add"}</button>}
      </div>
      {!editing && (value ? <div style={{ marginTop: 4, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{value}</div> : <div className="muted small" style={{ marginTop: 4 }}>What it is for and how it is set up. The assistant reads this whenever {name} comes up.</div>)}
      {editing && (
        <form className="col" style={{ marginTop: 6 }} onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={2000} aria-label={`What ${name} is for`} placeholder="Proxmox host for the domain controllers; backups go to the NAS at night" autoFocus />
          <div className="row">
            <button type="submit" className="small primary">Save</button>
            <button type="button" className="small ghost" onClick={() => setEditing(false)}>Cancel</button>
          </div>
          {err && <div className="error">{err}</div>}
        </form>
      )}
    </section>
  );
}

/** CPU, memory and disks first on a machine's page, then temperatures and the rest. */
function readingOrder(name: string): number {
  if (/\.cpu\.used$/.test(name)) return 0;
  if (/\.memory\.used$/.test(name)) return 1;
  if (/\.(disk\..+\.used|zfs\..+)$/.test(name)) return 2;
  if (/\.gpu\d+\.vram$/.test(name)) return 3;
  return 4;
}
