import type { LinkMethod } from "./api";
import { isTauri } from "../tauri/bridge";
import { b64, channelResponse, rawHubFetch, setHubRouter } from "./direct";
import { RouteChooser, TIMES, mayRetry, planFor, routeName, type Choice, type HubRoutes, type RaceTimes, type RouteName } from "./route";

/**
 * The home network route in the Windows and Android apps (contract, Devices, "Home route"). Requests to the hub's home
 * address go through the app's own HTTPS client (src-tauri/src/home.rs), which accepts only the hub's pinned
 * certificate. The device key is taken out of the request here and handed over on its own: the app adds it, and only
 * on that pinned connection, so it never goes out over a plain or unpinned one. route.ts decides which way to go.
 */

type FetchLike = typeof fetch;

/** A home request that failed. `unsent`: it never reached the hub (no connection), so it may go again another way. */
export class HomeError extends TypeError {
  unsent: boolean;
  constructor(message: string, unsent: boolean) {
    super(message);
    this.unsent = unsent;
  }
}

let nextId = 1;

/** The app's words ("could not connect to the hub on the home network") as a sentence. */
const sentence = (s: string) => {
  const t = s.trim();
  return t ? `${t[0].toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}` : "The home network connection failed.";
};

/** `fetch` of `url`, a home address, over the app's pinned connection, with what `input` and `init` ask for. */
export async function homeFetch(url: string, pin: string, input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  if (!isTauri) throw new HomeError("The home network route works in the Aeneas app only.", true);
  if (!/^https:\/\//i.test(url)) throw new HomeError("The home network route is https only.", true);
  const req = new Request(url, input instanceof Request ? new Request(input, init) : init);
  const { invoke } = await import("@tauri-apps/api/core");
  const body = req.body ? new Uint8Array(await req.arrayBuffer()) : null;
  const headers: [string, string][] = [];
  let key: string | null = null;
  req.headers.forEach((v, k) => {
    if (k.toLowerCase() !== "authorization") headers.push([k, v]);
    else key = /^Bearer\s+(\S+)\s*$/i.exec(v)?.[1] ?? null;
  });
  const id = nextId++;
  return channelResponse(
    req.method,
    init.signal ?? undefined,
    (onEvent) => invoke("home_fetch", { id, url: req.url, fp: pin, key, method: req.method, headers, body: body ? b64(body) : null, timeoutMs: null, onEvent }),
    () => void invoke("home_cancel", { id }),
    (ev) => new HomeError(sentence(ev.message), !!ev.unsent),
    // Refused before anything was sent (an address or pin the app does not take).
    (e) => new HomeError(sentence(String(e)), true),
  );
}

/** Whether the hub answers at a home address with the pinned certificate within `ms`. No key goes with it. */
export async function homeProbe(url: string, pin: string, ms: number): Promise<boolean> {
  if (!isTauri) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("home_probe", { url, fp: pin, timeoutMs: ms }).catch(() => false);
}

/** Bonjour: the home addresses announced with this pin, listening at most `ms`. */
export async function homeBrowse(pin: string, ms: number): Promise<string[]> {
  if (!isTauri) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string[]>("home_browse", { fp: pin, timeoutMs: ms }).catch(() => []);
}

/** What a router sends requests with: the app's own transports, or stand-ins in tests. */
export interface RouterDeps {
  /** A request to a home address over the pinned connection. */
  home(url: string, pin: string, input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** A request to the address as it is (Direct link or https), never routed. */
  raw: FetchLike;
  probeHome(url: string, pin: string, ms: number): Promise<boolean>;
  browse(pin: string, ms: number): Promise<string[]>;
}

const urlOf = (input: RequestInfo | URL) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

/** Stopped by the caller (or its own time limit): not a failure of the route. */
const stopped = (e: unknown, signal?: AbortSignal | null) => !!signal?.aborted || (e instanceof DOMException && (e.name === "AbortError" || e.name === "TimeoutError"));

/**
 * Sends the requests to this app's hub the way chosen, and a request that fails on the route in use once more on the
 * other. Requests to any other address are left alone (pairing with another hub, for one).
 */
export class HubRouter {
  readonly chooser: RouteChooser;
  private base: string | null = null;
  private hubUrl = "";
  private method: LinkMethod | null = null;

  constructor(private deps: RouterDeps, times: RaceTimes = TIMES) {
    this.chooser = new RouteChooser({
      probeHome: (url, pin, ms) => deps.probeHome(url, pin, ms),
      probeRemote: (ms) => this.probeRemote(ms),
      browse: (pin, ms) => deps.browse(pin, ms),
    }, times);
  }

  /**
   * Routes the requests to the hub saved as `hubUrl`, whose requests start with `base` (as the hub client writes
   * them), and races at once. `routes`: the hub's last answer to `GET /link/routes`, kept from before.
   */
  start(hubUrl: string, base: string, routes: HubRoutes | null): void {
    this.hubUrl = hubUrl;
    this.base = base.replace(/\/+$/, "");
    this.method = routes?.method ?? null;
    this.chooser.setPlan(planFor(routes));
    void this.chooser.trigger("start");
  }

  stop(): void {
    this.base = null;
  }

  /** A new answer from `GET /link/routes`: races again when the home addresses or the pin changed. */
  setRoutes(routes: HubRoutes | null): void {
    this.method = routes?.method ?? null;
    if (this.chooser.setPlan(planFor(routes))) void this.chooser.trigger("routes");
  }

  /** The route in use, for Settings. */
  get name(): RouteName {
    return routeName(this.chooser.current, this.hubUrl, this.method);
  }

  /** The request sent the way chosen, or null when it is not one to this app's hub or there is no home route to choose. */
  route(input: RequestInfo | URL, init?: RequestInit): Promise<Response> | null {
    const base = this.base;
    if (!base || !this.chooser.active) return null;
    const url = urlOf(input);
    if (url !== base && !url.startsWith(`${base}/`) && !url.startsWith(`${base}?`)) return null;
    return this.send(input, init ?? {}, url.slice(base.length) || "/");
  }

  private async send(input: RequestInfo | URL, init: RequestInit, path: string): Promise<Response> {
    await this.chooser.ready();
    const first = this.chooser.current;
    try {
      return await this.over(first, input, init, path);
    } catch (e) {
      if (stopped(e, init.signal)) throw e;
      void this.chooser.trigger("failure");
      const next = this.chooser.other(first);
      const method = init.method ?? (input instanceof Request ? input.method : "GET");
      if (!next || !mayRetry(method, path, e instanceof HomeError && e.unsent)) throw e;
      try {
        return await this.over(next, input, init, path);
      } catch (again) {
        // Both failed: what the route in use said is the one to show (away from home, not the home network's).
        throw stopped(again, init.signal) ? again : e;
      }
    }
  }

  private over(c: Choice, input: RequestInfo | URL, init: RequestInit, path: string): Promise<Response> {
    if (c.route === "remote") return this.deps.raw(input, init);
    // Never home without a pin.
    const pin = this.chooser.pin;
    if (!pin) return Promise.reject(new HomeError("The hub's home certificate is not known.", true));
    return this.deps.home(c.url + path, pin, input, init);
  }

  private async probeRemote(ms: number): Promise<boolean> {
    const base = this.base;
    if (!base) return false;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try {
      return (await this.deps.raw(`${base}/health`, { signal: ac.signal })).ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** This window's router. Only the Windows and Android apps route; a browser keeps the one address it was opened at. */
export const router = new HubRouter({ home: homeFetch, raw: rawHubFetch, probeHome: homeProbe, browse: homeBrowse });
if (isTauri) setHubRouter((input, init) => router.route(input, init));
