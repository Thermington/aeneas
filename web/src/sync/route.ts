import type { LinkMethod } from "./api";
import { normalizeHubId } from "./hubid";
import { parseDirect } from "./direct";

/**
 * Which way to the hub (contract, Devices, "Home route"). Besides the address a device was set up with (its Direct
 * link or Tailscale address, "remote"), the hub answers on the home network over HTTPS with a certificate of its own,
 * which devices pin by the SHA-256 that `GET /link/routes` names. The Windows and Android apps try both at once on
 * start, on coming back to the foreground, on a network change and after a failed request, and use home when it
 * answers within 1.5 seconds with the pinned certificate, else remote. Bonjour is asked only when both fail.
 *
 * This file only decides; the requests themselves are in home.ts, so the deciding can be tested without a network. A
 * web browser does none of this: it keeps the one address it was opened at.
 */

/** `GET /link/routes`. */
export interface HubRoutes {
  hub_id: string | null;
  method: LinkMethod | null;
  /** The address devices use away from home: Direct link (`iroh://...`) or Tailscale (https). Null for a hub reached only at home. */
  remote: string | null;
  home: { on: boolean; urls: string[]; fp: string | null; announce: boolean };
}

/** A certificate pin as the hub writes it: the SHA-256 of the DER bytes, 64 lowercase hex characters. */
export function normalizePin(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const pin = v.trim().replace(/:/g, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(pin) ? pin : null;
}

/** An https address with a host and nothing else in front of its path, without a trailing slash; else null. */
function homeAddress(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return null;
    return `https://${u.host}`;
  } catch {
    return null;
  }
}

/** The hub's answer, checked: anything unexpected is dropped rather than trusted. Null when it is not an answer at all. */
export function parseRoutes(v: unknown): HubRoutes | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const h = (r.home && typeof r.home === "object" ? r.home : {}) as Record<string, unknown>;
  const urls = Array.isArray(h.urls) ? [...new Set(h.urls.map(homeAddress).filter((u): u is string => !!u))] : [];
  const method = r.method === "direct" || r.method === "tailscale" || r.method === "home" ? r.method : null;
  return {
    hub_id: normalizeHubId(r.hub_id),
    method,
    remote: typeof r.remote === "string" && r.remote.trim() ? r.remote.trim() : null,
    home: { on: h.on === true, urls, fp: normalizePin(h.fp), announce: h.announce !== false },
  };
}

/** What a race tries. */
export interface RoutePlan {
  /** The address the device was set up with is raced too (false for a hub reached only at home). */
  remote: boolean;
  /** The home addresses and the pin they must present. Null: never home (no pin, or the home route is off). */
  home: { urls: string[]; pin: string; announce: boolean } | null;
}

/**
 * The remote route is the address this device was set up with, whatever `remote` in the answer says (a hub that
 * changes how it is reached has its devices pair again). Only a Home Wi-Fi only hub has none: its address is a home one.
 */
export function planFor(routes: HubRoutes | null): RoutePlan {
  const pin = routes?.home.on ? routes.home.fp : null;
  const home = routes && pin && (routes.home.urls.length || routes.home.announce) ? { urls: routes.home.urls, pin, announce: routes.home.announce } : null;
  return { remote: !home || routes?.method !== "home", home };
}

export type Choice = { route: "home"; url: string } | { route: "remote" };

/** The network side of a race (home.ts in the app, stand-ins in tests). */
export interface RouteIO {
  /** `GET /health` at a home address over the pinned connection: true when it answered with the pinned certificate. */
  probeHome(url: string, pin: string, ms: number): Promise<boolean>;
  /** `GET /health` over the remote route. */
  probeRemote(ms: number): Promise<boolean>;
  /** Bonjour: the home addresses announced with this pin. */
  browse(pin: string, ms: number): Promise<string[]>;
}

export interface RaceTimes {
  /** Home wins when it answers within this. */
  home: number;
  /** The remote route may take longer: a Direct link connects through its relay first. */
  remote: number;
  browse: number;
  /** After a race, a failed request starts another only after this long, so a burst of failures races once. */
  failureGap: number;
}

export const TIMES: RaceTimes = { home: 1500, remote: 20_000, browse: 3000, failureGap: 2000 };

/** `p`, or `fallback` once `ms` passed: a race always ends, whatever the network does. */
export function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(fallback); });
  });
}

/** The first address whose probe says yes within `ms`, or null. */
export function firstOk(urls: string[], probe: (url: string) => Promise<boolean>, ms: number): Promise<string | null> {
  return new Promise((resolve) => {
    if (!urls.length) { resolve(null); return; }
    let left = urls.length;
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), ms);
    const no = () => { if (--left === 0) finish(null); };
    for (const u of urls) probe(u).then((ok) => (ok ? finish(u) : no()), no);
  });
}

/**
 * One race: the home addresses and the remote route at once. `decide` hears the route as soon as it is settled (home
 * when it answers within `times.home`, else remote), so requests need not wait for the rest. When both fail, and only
 * then, Bonjour looks for the hub; an address it finds must still present the pinned certificate. Ends with the route
 * that answered, or null when none did.
 */
export async function race(plan: RoutePlan, io: RouteIO, decide: (c: Choice) => void, times: RaceTimes = TIMES): Promise<Choice | null> {
  // Each probe has its own time limit; these are the race's own, a little later.
  const remote = plan.remote ? within(io.probeRemote(times.remote), times.remote + 1000, false) : Promise.resolve(false);
  const home = plan.home;
  const atHome = async (urls: string[]): Promise<Choice | null> => {
    const url = home ? await firstOk(urls, (u) => io.probeHome(u, home.pin, times.home).catch(() => false), times.home) : null;
    if (!url) return null;
    const c: Choice = { route: "home", url };
    decide(c);
    return c;
  };
  const first = home ? await atHome(home.urls) : null;
  if (first) return first;
  if (plan.remote) {
    decide({ route: "remote" });
    if (await remote) return { route: "remote" };
  }
  if (!home?.announce) return null;
  const found = await within(io.browse(home.pin, times.browse), times.browse + 2000, [] as string[]);
  return atHome(found);
}

/**
 * Whether a request that failed with no answer may go again on the other route: one that never reached the hub, one
 * that changes nothing or the same thing twice, or a sync push (its edits carry their own ids and times, and the
 * engine sends them again anyway). Anything else could happen twice, so it is not sent again.
 */
export function mayRetry(method: string, path: string, unsent: boolean): boolean {
  if (unsent) return true;
  const m = method.toUpperCase();
  return ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"].includes(m) || (m === "POST" && path.split("?")[0] === "/sync/push");
}

export type Trigger = "start" | "foreground" | "network" | "failure" | "routes";

/**
 * The route in use and when to race again. Races never overlap: a trigger during one runs one more race after it
 * (what it raced may be out of date), except a failed request, which the running race already answers.
 */
export class RouteChooser {
  private plan: RoutePlan = { remote: true, home: null };
  private choice: Choice = { route: "remote" };
  /** The home address that answered last: where a request goes when the remote route fails. */
  private lastHome: string | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private endedAt = Number.NEGATIVE_INFINITY;
  private decided = true;
  private waiting: Array<() => void> = [];
  private listeners = new Set<(c: Choice) => void>();
  /** How many races ran (for tests and the record). */
  races = 0;

  constructor(private io: RouteIO, private times: RaceTimes = TIMES, private now: () => number = Date.now) {}

  get current(): Choice { return this.choice; }
  get pin(): string | null { return this.plan.home?.pin ?? null; }
  /** Whether there is a home route to race for at all. */
  get active(): boolean { return !!this.plan.home; }

  /** New addresses or pin. Returns whether what is raced changed. Without a pin nothing goes home from now on. */
  setPlan(plan: RoutePlan): boolean {
    const changed = JSON.stringify(plan) !== JSON.stringify(this.plan);
    this.plan = plan;
    if (!plan.home) {
      this.lastHome = null;
      this.switchTo({ route: "remote" });
    } else if (this.lastHome && !plan.home.urls.includes(this.lastHome) && this.choice.route !== "home") {
      this.lastHome = null;
    }
    return changed;
  }

  subscribe(fn: (c: Choice) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Resolves once the running race has chosen (home within 1.5 s, else remote); at once when none runs. */
  ready(): Promise<void> {
    if (this.decided) return Promise.resolve();
    return new Promise((r) => this.waiting.push(r));
  }

  /** Where a request that failed on `c` goes once more: the other route, or null when there is none. */
  other(c: Choice): Choice | null {
    if (c.route === "home") return this.plan.remote ? { route: "remote" } : null;
    const url = this.lastHome ?? this.plan.home?.urls[0];
    return this.plan.home && url ? { route: "home", url } : null;
  }

  trigger(why: Trigger): Promise<void> {
    if (!this.plan.home) return Promise.resolve();
    if (this.running) {
      if (why !== "failure") this.again = true;
      return this.running;
    }
    if (why === "failure" && this.now() - this.endedAt < this.times.failureGap) return Promise.resolve();
    this.decided = false;
    this.running = (async () => {
      try {
        do {
          this.again = false;
          this.races++;
          const won = await race(this.plan, this.io, (c) => this.decide(c), this.times);
          if (won?.route === "home") this.lastHome = won.url;
        } while (this.again && this.plan.home);
      } finally {
        this.running = null;
        this.endedAt = this.now();
        // A race that found nothing keeps the route it had; requests waiting for it go on.
        this.decided = true;
        this.release();
      }
    })();
    return this.running;
  }

  private decide(c: Choice) {
    // The home route went away (no pin any more) while this race ran.
    if (c.route === "home" && !this.plan.home) return;
    this.switchTo(c);
    if (!this.decided) {
      this.decided = true;
      this.release();
    }
  }

  private switchTo(c: Choice) {
    const same = c.route === this.choice.route && (c.route === "remote" || (this.choice.route === "home" && this.choice.url === c.url));
    this.choice = c;
    if (c.route === "home") this.lastHome = c.url;
    if (!same) for (const l of this.listeners) l(c);
  }

  private release() {
    const w = this.waiting;
    this.waiting = [];
    for (const r of w) r();
  }
}

/** How the app is reaching its hub right now, said in Settings. */
export type RouteName = "home" | "direct" | "tailscale" | "address";

export const ROUTE_LABEL: Record<RouteName, string> = {
  home: "Home network",
  direct: "Direct link",
  tailscale: "Tailscale",
  address: "The hub's address",
};

export function routeName(c: Choice, hubUrl: string, method: LinkMethod | null = null): RouteName {
  if (c.route === "home") return "home";
  if (parseDirect(hubUrl)) return "direct";
  let host = "";
  try { host = new URL(hubUrl).hostname; } catch { /* not an address */ }
  const cgnat = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host);
  return method === "tailscale" || /\.ts\.net\.?$/i.test(host) || cgnat ? "tailscale" : "address";
}
