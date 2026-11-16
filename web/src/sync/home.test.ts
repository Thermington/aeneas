import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeError, HubRouter, type RouterDeps } from "./home";
import { hubFetch, setHubRouter } from "./direct";
import { TIMES, parseRoutes, type HubRoutes } from "./route";

const PIN = "cd".repeat(32);
const HOME = "https://192.168.1.20:8788";
const HUB = "https://hub.example.ts.net";
const ROUTES: HubRoutes = parseRoutes({ hub_id: null, method: "tailscale", remote: HUB, home: { on: true, urls: [HOME], fp: PIN, announce: true } })!;

/**
 * A router over stand-in transports: `home` and `remote` say how each answers. `sent` records every request tried;
 * the races' own checks of the remote route (`GET /health`) are only counted.
 */
function setup(opts: { homeUp?: boolean; home?: "ok" | "unsent" | "maybe-sent"; remote?: "ok" | "down"; routes?: HubRoutes | null } = {}) {
  const sent: string[] = [];
  const probes = { remote: 0 };
  const deps: RouterDeps = {
    home: async (url, pin, _input, init) => {
      const auth = new Headers(init?.headers).get("authorization");
      sent.push(`home ${init?.method ?? "GET"} ${url}${pin === PIN ? "" : " (another pin)"}${auth ? " with key" : ""}`);
      if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (opts.home === "unsent") throw new HomeError("could not connect", true);
      if (opts.home === "maybe-sent") throw new HomeError("broke off", false);
      return new Response("home");
    },
    raw: async (input, init) => {
      const probe = String(input) === `${HUB}/health`;
      if (probe) probes.remote++;
      else sent.push(`remote ${init?.method ?? "GET"} ${String(input)}`);
      if (opts.remote === "down") throw new TypeError("Failed to fetch");
      return new Response(probe ? "{}" : "remote");
    },
    probeHome: async () => opts.homeUp ?? true,
    browse: async () => [],
  };
  const r = new HubRouter(deps, { ...TIMES, failureGap: 0 });
  r.start(HUB, HUB, opts.routes === undefined ? ROUTES : opts.routes);
  return { r, sent, probes };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Lets the start race finish (the stand-ins answer at once; the remote probe is not waited for). */
const settle = () => vi.advanceTimersByTimeAsync(2000);

describe("routing the app's requests to its hub", () => {
  it("sends them home when home answered, to the same path, with the pin", async () => {
    const { r, sent } = setup();
    await settle();
    const res = await r.route(`${HUB}/sync/changes?since=3`, { headers: { Authorization: "Bearer ead1_k" } });
    expect(await res!.text()).toBe("home");
    expect(sent).toEqual([`home GET ${HOME}/sync/changes?since=3 with key`]);
    expect(r.name).toBe("home");
  });

  it("uses the remote route when home did not answer", async () => {
    const { r, sent, probes } = setup({ homeUp: false });
    await settle();
    expect(probes.remote).toBe(1);
    expect(await (await r.route(`${HUB}/today`))!.text()).toBe("remote");
    expect(sent).toEqual([`remote GET ${HUB}/today`]);
    expect(r.name).toBe("tailscale");
  });

  it("leaves requests to any other address alone", async () => {
    const { r } = setup();
    await settle();
    expect(r.route("https://other.example/devices/claim")).toBeNull();
    expect(r.route(`${HUB}.evil.example/health`)).toBeNull();
    r.stop();
    expect(r.route(`${HUB}/health`)).toBeNull();
  });

  it("never sends anything home without a pin", async () => {
    const { r, sent } = setup({ routes: { ...ROUTES, home: { ...ROUTES.home, fp: null } } });
    await settle();
    expect(r.route(`${HUB}/health`)).toBeNull();
    expect(sent).toEqual([]);
    const off = setup({ routes: null });
    await settle();
    expect(off.r.route(`${HUB}/health`)).toBeNull();
  });

  it("tries a request that failed at home once on the remote route", async () => {
    const { r, sent } = setup({ home: "unsent" });
    await settle();
    const res = await r.route(`${HUB}/capture`, { method: "POST", body: "{}" });
    expect(await res!.text()).toBe("remote");
    expect(sent).toEqual([`home POST ${HOME}/capture`, `remote POST ${HUB}/capture`]);
  });

  it("tries a request that failed on the remote route once at home", async () => {
    const { r, sent } = setup({ homeUp: false, remote: "down" });
    await settle();
    const res = await r.route(`${HUB}/sync/changes?since=0`);
    expect(await res!.text()).toBe("home");
    expect(sent).toEqual([`remote GET ${HUB}/sync/changes?since=0`, `home GET ${HOME}/sync/changes?since=0`]);
  });

  it("gives up after one try on each route, with what the route in use said", async () => {
    const { r, sent } = setup({ home: "unsent", remote: "down" });
    await settle();
    await expect(r.route(`${HUB}/sync/push`, { method: "POST", body: "{}" })!).rejects.toThrow("could not connect");
    expect(sent).toEqual([`home POST ${HOME}/sync/push`, `remote POST ${HUB}/sync/push`]);
  });

  it("does not send twice a request that may have reached the hub, except a sync push", async () => {
    const { r, sent } = setup({ home: "maybe-sent" });
    await settle();
    await expect(r.route(`${HUB}/capture`, { method: "POST", body: "{}" })!).rejects.toThrow("broke off");
    expect(sent).toEqual([`home POST ${HOME}/capture`]);
    sent.length = 0;
    expect(await (await r.route(`${HUB}/sync/push`, { method: "POST", body: "{}" }))!.text()).toBe("remote");
    expect(sent).toEqual([`home POST ${HOME}/sync/push`, `remote POST ${HUB}/sync/push`]);
  });

  it("does not send again a request its caller stopped", async () => {
    const { r, sent } = setup();
    await settle();
    const ac = new AbortController();
    ac.abort();
    await expect(r.route(`${HUB}/live`, { signal: ac.signal })!).rejects.toThrow("Aborted");
    expect(sent).toEqual([`home GET ${HOME}/live`]);
  });

  it("races again after a failed request", async () => {
    const { r } = setup({ home: "unsent" });
    await settle();
    const races = r.chooser.races;
    await r.route(`${HUB}/today`);
    expect(r.chooser.races).toBe(races + 1);
  });

  it("races again when the hub names other home addresses or another pin, not for the same answer", async () => {
    const { r } = setup();
    await settle();
    const trigger = vi.spyOn(r.chooser, "trigger");
    r.setRoutes(ROUTES);
    expect(trigger).not.toHaveBeenCalled();
    r.setRoutes({ ...ROUTES, home: { ...ROUTES.home, urls: ["https://192.168.1.31:8788"] } });
    expect(trigger).toHaveBeenCalledWith("routes");
  });

  it("waits for the start race before sending, so nothing goes the old way", async () => {
    const { r, sent } = setup();
    const res = r.route(`${HUB}/today`)!;
    expect(sent).toEqual([]);
    await settle();
    expect(await (await res).text()).toBe("home");
    expect(sent).toEqual([`home GET ${HOME}/today`]);
  });
});

describe("every request to a hub", () => {
  afterEach(() => {
    setHubRouter(null);
    vi.unstubAllGlobals();
  });

  it("goes through the router when the app has one, and as it is when the router leaves it", async () => {
    const plain: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      plain.push(String(input));
      return new Response("plain");
    });
    setHubRouter((input) => (String(input).startsWith(HUB) ? Promise.resolve(new Response("routed")) : null));
    expect(await (await hubFetch(`${HUB}/today`)).text()).toBe("routed");
    expect(await (await hubFetch("https://other.example/health")).text()).toBe("plain");
    setHubRouter(null);
    expect(await (await hubFetch(`${HUB}/today`)).text()).toBe("plain");
    expect(plain).toEqual(["https://other.example/health", `${HUB}/today`]);
  });
});
