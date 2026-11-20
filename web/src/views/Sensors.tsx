import { plainError } from "../lib/errors";
import { useEffect, useState } from "react";
import { engine } from "../sync/engine";
import type { SensorRow } from "../sync/api";
import { META } from "../sync/db";
import { useMeta } from "../sync/hooks";
import { Chart } from "../components/Chart";
import { dayPoints, shortDay, timePoints, type Series } from "../lib/dashboard";
import { readingLabel, readingValue } from "../lib/tech";
import { usePoll } from "../lib/usePoll";
import { csvFilename, sensorState, sensorTone } from "../lib/body";
import { relative } from "../lib/time";
import { go } from "../lib/router";

type Settings = { min: string; max: string; alert: boolean; stale_minutes: string; location: string };

function settingsOf(s: SensorRow): Settings {
  return { min: s.min != null ? String(s.min) : "", max: s.max != null ? String(s.max) : "", alert: s.alert !== false, stale_minutes: String(s.stale_minutes ?? 180), location: s.location ?? "" };
}

function num(v: string): number | null {
  const n = Number(v);
  return v.trim() === "" || !Number.isFinite(n) ? null : n;
}

type Span = "24h" | 7 | 30 | 90;
const SPANS: Span[] = ["24h", 7, 30, 90];
const DAY = 86400_000;

/** The last 24 hours reading by reading, or a daily mean over 7 to 90 days. */
function ReadingGraph({ s, label }: { s: SensorRow; label: string }) {
  const [span, setSpan] = useState<Span>("24h");
  const [series, setSeries] = useState<Series | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (span === "24h") return;
    let alive = true;
    setErr("");
    engine.client
      ?.dashboardSeries(`sensor:${s.name}`, span)
      .then((r) => alive && setSeries(r))
      .catch((e) => alive && setErr(plainError(e)));
    return () => {
      alive = false;
    };
  }, [s.name, span, s.last_at]);
  const bounds = [s.min, s.max].filter((v): v is number => v != null);
  const now = Date.now();
  const daily = span !== "24h" && series && series.days === span ? series : null;
  return (
    <>
      {span === "24h" ? (
        <Chart points={timePoints(s.series_24h, now - DAY, now)} kind="line" unit={s.unit} bounds={bounds} height={80} label={`${label}, last 24 hours`} axis={["24 h ago", "now"]} />
      ) : err ? (
        <div className="error">{err}</div>
      ) : daily ? (
        <Chart points={dayPoints(daily.points)} kind="line" unit={s.unit} bounds={bounds} height={80} label={`${label}, daily mean over ${span} days`} axis={[shortDay(daily.from), "today"]} />
      ) : (
        <div className="muted small chart-empty">Loading</div>
      )}
      <div className="seg seg-sm" role="group" aria-label={`Range for ${label}`} style={{ marginTop: 6 }}>
        {SPANS.map((v) => (
          <button key={String(v)} type="button" className={span === v ? "on" : ""} aria-pressed={span === v} onClick={() => setSpan(v)}>
            {v === "24h" ? "24h" : `${v}d`}
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * One reading: its value and state, a graph over 24 hours to 90 days, its alert bounds, Propose a fix while it alerts,
 * and its CSV. On a machine's or place's page (`thing` set) it is named as people say it ("Disk P:").
 */
export function ReadingCard({ s, thing, onSaved }: { s: SensorRow; thing?: string; onSaved: () => Promise<void> }) {
  const label = thing ? readingLabel(s.name, thing) : s.name;
  const [edit, setEdit] = useState<Settings>(() => settingsOf(s));
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) setEdit(settingsOf(s));
    // Only refresh the editor from the hub while it is closed; typing must not be overwritten by a poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.min, s.max, s.alert, s.stale_minutes, s.location, open]);
  const state = sensorState(s);
  const tone = sensorTone(state);
  const bounds = [s.min, s.max].filter((v): v is number => v != null);

  const save = async () => {
    const c = engine.client;
    if (!c) return;
    setBusy("save");
    setErr("");
    try {
      const stale = num(edit.stale_minutes);
      await c.patchEntity(s.id, { min: num(edit.min), max: num(edit.max), alert: edit.alert, stale_minutes: stale && stale > 0 ? Math.round(stale) : 180, location: edit.location.trim() || null });
      setOpen(false);
      await onSaved();
    } catch (e) {
      setErr(plainError(e));
    } finally {
      setBusy(null);
    }
  };

  // An alert opens a chat where the assistant looks into it and proposes one fix, which runs only when approved.
  const alerting = s.alert !== false && (state === "high" || state === "low" || state === "stale");
  const propose = async () => {
    const c = engine.client;
    if (!c) return;
    setBusy("fix");
    setErr("");
    try {
      const r = await c.sensorPropose(s.name);
      go(`/assistant/${r.session_id}`);
    } catch (e) {
      setErr(plainError(e));
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    const c = engine.client;
    if (!c) return;
    setBusy("csv");
    setErr("");
    try {
      const text = await c.sensorCsv(s.name, 30);
      const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = csvFilename(s.name, 30);
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setErr(plainError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card sensor" id={`reading-${s.name}`}>
      <div className="row between" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <strong style={{ overflowWrap: "anywhere" }} title={thing ? s.name : undefined}>{label}</strong> {!thing && s.location && <span className="muted small">{s.location}</span>}
        </div>
        <span className={`chip static tone-${tone}`}>{state}</span>
      </div>
      <div className="big" style={{ marginTop: 4 }}>
        {readingValue(s)}
        {s.last_at && <span className="muted small"> {relative(s.last_at)}</span>}
      </div>
      <ReadingGraph s={s} label={label} />
      <div className="muted small">
        {bounds.length ? `Alerts ${[s.min != null ? `below ${s.min}` : "", s.max != null ? `above ${s.max}` : ""].filter(Boolean).join(" or ")}${s.unit === "%" ? "%" : s.unit ? ` ${s.unit}` : ""}${s.alert === false ? " (alerts off)" : ""}` : "No alert set"}
      </div>
      {err && <div className="error">{err}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        {alerting && (
          <button className="small primary" onClick={() => void propose()} disabled={busy === "fix" || !engine.client} title="The assistant finds the cause and proposes a fix you approve or cancel">
            {busy === "fix" ? "Starting" : "Propose a fix"}
          </button>
        )}
        <button className="small" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "Close" : "Settings"}
        </button>
        <button className="small ghost" onClick={() => void download()} disabled={busy === "csv"}>
          Download CSV
        </button>
      </div>
      {open && (
        <form
          className="col"
          style={{ marginTop: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="row">
            <div style={{ width: 90 }}>
              <label htmlFor={`${s.name}-min`}>Min</label>
              <input id={`${s.name}-min`} type="number" step="any" value={edit.min} onChange={(e) => setEdit({ ...edit, min: e.target.value })} />
            </div>
            <div style={{ width: 90 }}>
              <label htmlFor={`${s.name}-max`}>Max</label>
              <input id={`${s.name}-max`} type="number" step="any" value={edit.max} onChange={(e) => setEdit({ ...edit, max: e.target.value })} />
            </div>
            <div style={{ width: 110 }}>
              <label htmlFor={`${s.name}-stale`}>Stale after, min</label>
              <input id={`${s.name}-stale`} type="number" min={1} value={edit.stale_minutes} onChange={(e) => setEdit({ ...edit, stale_minutes: e.target.value })} />
            </div>
            <div className="grow">
              <label htmlFor={`${s.name}-loc`}>Location</label>
              <input id={`${s.name}-loc`} value={edit.location} onChange={(e) => setEdit({ ...edit, location: e.target.value })} />
            </div>
          </div>
          <label style={{ color: "inherit", fontSize: 15 }}>
            <input type="checkbox" checked={edit.alert} onChange={(e) => setEdit({ ...edit, alert: e.target.checked })} /> Alert when outside the bounds
          </label>
          <div className="row">
            <button type="submit" className="small primary" disabled={busy === "save"}>
              Save
            </button>
            <button type="button" className="small ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Home sensors from GET /sensors, with settings saved through the entity path and a how-to for the Pico rig. */
export function Sensors() {
  const p = usePoll((c) => c.sensors());
  const hubUrl = useMeta<string>(META.hubUrl) ?? "https://hub.example";
  const [howto, setHowto] = useState(false);
  // The sensor key only posts readings, so it can sit on a board (feedkeys.ts); fetched when the how-to opens.
  const [key, setKey] = useState("");
  const [keyErr, setKeyErr] = useState("");
  useEffect(() => { if (howto && !key) void engine.client?.feeds().then((f) => setKey(f.sensors.key)).catch(() => undefined); }, [howto, key]);
  const list = (p.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const example = `import network, urequests, time
# Pico W: join wifi, then post one reading every 5 minutes.
HUB = "${hubUrl}"
KEY = "${key || "<sensor key>"}"   # posts readings only, nothing else
NAME = "planter_moisture"
UNIT = "%"

def post(value):
    r = urequests.post(f"{HUB}/sensors/{NAME}/readings?key={KEY}",
                       json={"value": value, "unit": UNIT})
    r.close()

while True:
    post(read_sensor())
    time.sleep(300)`;

  return (
    <div className="sensors">
      <div className="row between" style={{ marginBottom: 8 }}>
        <h1 style={{ margin: 0 }}>Sensors</h1>
        <span className="muted small">{p.at ? `checked ${relative(p.at.toISOString())}` : ""}</span>
        <button className="small" onClick={() => void p.reload()} disabled={p.busy}>
          Refresh
        </button>
      </div>
      {!p.data && p.error && <div className={p.unavailable ? "muted small" : "error"}>{p.unavailable ? "Sensors are not available on this hub." : p.error}</div>}
      {p.data && !list.length && <div className="empty">No sensors yet. The first reading posted creates one.</div>}
      <div className="grid2">
        {list.map((s) => (
          <ReadingCard key={s.id} s={s} onSaved={p.reload} />
        ))}
      </div>
      <details className="card" style={{ marginTop: 12 }} open={howto} onToggle={(e) => setHowto((e.target as HTMLDetailsElement).open)}>
        <summary>How to post readings</summary>
        <p className="small" style={{ marginTop: 8 }}>
          POST <code>{hubUrl}/sensors/&lt;name&gt;/readings?key=&lt;sensor key&gt;</code> with a JSON body <code>{"{"}"value": 21.5, "unit": "C"{"}"}</code>. The first post creates the sensor. Readings outside the bounds raise one alert per crossing. MicroPython on a Pico W:
        </p>
        <pre className="small">{example}</pre>
        <div className="row wrap small">
          <span className="muted">The sensor key only posts readings. A board using the hub token keeps working, but the key is safer on a board.</span>
          <button
            type="button"
            className="ghost small"
            onClick={() => {
              if (!confirm("Make a new sensor key? Boards using the old key stop posting until they get the new one.")) return;
              setKeyErr("");
              // A key that was not replaced must not look replaced (a leaked one would stay in use).
              void engine.client?.rotateFeed("sensors").then((f) => setKey(f.sensors.key)).catch((e) => setKeyErr(`The key was not replaced: ${plainError(e)}`));
            }}
          >
            New key
          </button>
          {keyErr && <span className="error">{keyErr}</span>}
        </div>
      </details>
    </div>
  );
}
