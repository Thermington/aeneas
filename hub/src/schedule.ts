import type { DB } from "./db.js";
import { errCode } from "./logsafe.js";

/** When each daily job last ran (the `jobs` table), so a job whose time passed while the hub was off or asleep runs later. */
export interface JobClock { last(label: string): number | null; ran(label: string, at: number): void }

export function dbJobClock(db: DB): JobClock {
  const get = db.prepare("SELECT last_run FROM jobs WHERE label = ?");
  const set = db.prepare("INSERT INTO jobs (label, last_run) VALUES (?, ?) ON CONFLICT(label) DO UPDATE SET last_run = excluded.last_run");
  return {
    last: (label) => {
      const r = get.get(label) as { last_run: string } | undefined;
      const t = r ? Date.parse(r.last_run) : NaN;
      return Number.isFinite(t) ? t : null;
    },
    ran: (label, at) => { set.run(label, new Date(at).toISOString()); },
  };
}

const HOUR = 3_600_000;
/**
 * A job not run for this long runs at the next look: a day and an hour, so a job that ran at its time is not run
 * again by a look made just before its next time.
 */
export const MISSED_AFTER_MS = 25 * HOUR;
/** How often a missed run is looked for. The first look is a few minutes after start, once the hub has settled. */
const LOOK_EVERY_MS = HOUR;
const FIRST_LOOK_MS = 3 * 60_000;

export interface DailyOptions {
  /**
   * Keep each run here and make up a run that did not happen at its time (the hub was off, or the machine slept
   * through it). Only for jobs that use no model (the GPU is for gaming) and that harm nothing when they run late.
   */
  clock?: JobClock;
  /** Tests: when the first look for a missed run happens, and the clock. */
  firstLookMs?: number;
  now?: () => number;
}

/**
 * Run `fn` once a day at hour:minute local time. Errors are logged, never thrown; the next run is always scheduled.
 * With `clock`, a run missed while the hub was off or asleep is made up within an hour of the hub running again.
 */
export function scheduleDaily(label: string, hour: number, minute: number, fn: () => void, opts: DailyOptions = {}): () => void {
  let timer: NodeJS.Timeout | null = null;
  let look: NodeJS.Timeout | null = null;
  let stopped = false;
  const now = opts.now ?? Date.now;
  const run = () => {
    try { fn(); } catch (e) { console.error(`[${label}] failed: ${errCode(e)}`); }
    try { opts.clock?.ran(label, now()); } catch (e) { console.error(`[${label}] could not note the run: ${errCode(e)}`); }
  };
  const schedule = () => {
    if (stopped) return;
    const at = new Date(now());
    const next = new Date(at);
    next.setHours(hour, minute, 0, 0);
    // A timer can fire a millisecond early (08:59:59.999 for 09:00): today's run is then the one just made, so the
    // next is tomorrow's, not another in 1 ms.
    if (next.getTime() - at.getTime() < 1000) next.setDate(next.getDate() + 1);
    timer = setTimeout(() => {
      // A run made up less than an hour ago (the hub started just before this time) stands for this one.
      const last = opts.clock?.last(label) ?? null;
      if (last === null || now() - last >= HOUR) run();
      schedule();
    }, next.getTime() - at.getTime());
    timer.unref();
  };
  const lookForMissed = () => {
    if (stopped || !opts.clock) return;
    let last: number | null = null;
    try { last = opts.clock.last(label); } catch (e) { console.error(`[${label}] could not read the last run: ${errCode(e)}`); }
    if (last === null || now() - last > MISSED_AFTER_MS) {
      console.log(`[${label}] running the daily run that did not happen at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
      run();
    }
    look = setTimeout(lookForMissed, LOOK_EVERY_MS);
    look.unref();
  };
  schedule();
  if (opts.clock) {
    look = setTimeout(lookForMissed, opts.firstLookMs ?? FIRST_LOOK_MS);
    look.unref();
  }
  return () => { stopped = true; if (timer) clearTimeout(timer); if (look) clearTimeout(look); };
}
