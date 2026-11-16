import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouteChooser, TIMES, firstOk, mayRetry, parseRoutes, planFor, race, routeName, type Choice, type RouteIO, type RoutePlan } from "./route";

const PIN = "ab".repeat(32);
const HOME = "https://192.168.1.20:8788";
const HOME2 = "https://10.0.0.5:8788";

/** Stand-ins for the network. Each probe answers yes or no after its own time; `calls` records what was asked. */
interface Net {
  home: Record<string, { ok: boolean; ms: number }>;
  remote: { ok: boolean; ms: number };
  found: string[];
  calls: string[];
}

function net(over: Partial<Net> = {}): Net {
  return { home: {}, remote: { ok: true, ms: 100 }, found: [], calls: [], ...over };
}

const after = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));

function io(n: Net): RouteIO {
  return {
    probeHome: (url, pin) => {
      n.calls.push(`home ${url}${pin === PIN ? "" : " (another pin)"}`);
      const a = n.home[url] ?? { ok: false, ms: 5 };
      return after(a.ms, a.ok);
    },
    probeRemote: () => {
      n.calls.push("remote");
      return after(n.remote.ms, n.remote.ok);
    },
    browse: (pin) => {
      n.calls.push(`browse${pin === PIN ? "" : " (another pin)"}`);
      return after(50, n.found);
    },
  };
}

const plan = (over: Partial<NonNullable<RoutePlan["home"]>> = {}, remote = true): RoutePlan => ({ remote, home: { urls: [HOME], pin: PIN, announce: true, ...over } });

/** Runs a race to its end on fake time, with every choice it made along the way. */
async function run(p: RoutePlan, n: Net, ms = 60_000) {
  const decided: Choice[] = [];
  const done = race(p, io(n), (c) => decided.push(c));
  await vi.advanceTimersByTimeAsync(ms);
  return { decided, won: await done };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("a race between home and the remote route", () => {
  it("tries the home addresses and the remote route at the same time", () => {
    const n = net({ home: { [HOME]: { ok: true, ms: 200 } } });
    void race(plan(), io(n), () => undefined);
    expect(n.calls).toEqual(["remote", `home ${HOME}`]);
  });

  it("uses home when it answers within 1.5 s with the pinned certificate", async () => {
    const n = net({ home: { [HOME]: { ok: true, ms: 1400 } }, remote: { ok: true, ms: 50 } });
    const decided: Choice[] = [];
    const done = race(plan(), io(n), (c) => decided.push(c));
    await vi.advanceTimersByTimeAsync(1399);
    expect(decided).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(decided).toEqual([{ route: "home", url: HOME }]);
    expect(await done).toEqual({ route: "home", url: HOME });
  });

  it("uses the remote route when home answers too late", async () => {
    const n = net({ home: { [HOME]: { ok: true, ms: 1600 } }, remote: { ok: true, ms: 50 } });
    const decided: Choice[] = [];
    const done = race(plan(), io(n), (c) => decided.push(c));
    await vi.advanceTimersByTimeAsync(1499);
    expect(decided).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(decided).toEqual([{ route: "remote" }]);
    expect(await done).toEqual({ route: "remote" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(decided).toEqual([{ route: "remote" }]);
  });

  it("does not wait out the 1.5 s when every home address said no", async () => {
    const n = net({ home: { [HOME]: { ok: false, ms: 20 } }, remote: { ok: true, ms: 800 } });
    const decided: Choice[] = [];
    void race(plan(), io(n), (c) => decided.push(c));
    await vi.advanceTimersByTimeAsync(20);
    expect(decided).toEqual([{ route: "remote" }]);
  });

  it("takes the home address that answers", async () => {
    const n = net({ home: { [HOME]: { ok: false, ms: 10 }, [HOME2]: { ok: true, ms: 300 } } });
    const { decided, won } = await run(plan({ urls: [HOME, HOME2] }), n);
    expect(decided).toEqual([{ route: "home", url: HOME2 }]);
    expect(won).toEqual({ route: "home", url: HOME2 });
  });

  it("asks Bonjour only when both fail, and still needs the pin at the address found", async () => {
    const n = net({ remote: { ok: false, ms: 100 }, found: [HOME2], home: { [HOME2]: { ok: true, ms: 30 } } });
    const { decided, won } = await run(plan(), n);
    expect(n.calls).toEqual(["remote", `home ${HOME}`, "browse", `home ${HOME2}`]);
    expect(decided).toEqual([{ route: "remote" }, { route: "home", url: HOME2 }]);
    expect(won).toEqual({ route: "home", url: HOME2 });
  });

  it("never asks Bonjour while either route works", async () => {
    const home = net({ home: { [HOME]: { ok: true, ms: 10 } }, remote: { ok: false, ms: 100 } });
    await run(plan(), home);
    const remote = net({ home: { [HOME]: { ok: false, ms: 10 } }, remote: { ok: true, ms: 5000 } });
    await run(plan(), remote);
    expect([...home.calls, ...remote.calls].filter((c) => c.startsWith("browse"))).toEqual([]);
  });

  it("does not take an address found by Bonjour that fails the pin", async () => {
    const n = net({ remote: { ok: false, ms: 100 }, found: [HOME2], home: { [HOME2]: { ok: false, ms: 30 } } });
    const { decided, won } = await run(plan(), n);
    expect(decided).toEqual([{ route: "remote" }]);
    expect(won).toBeNull();
  });

  it("does not ask Bonjour for a hub that does not announce itself", async () => {
    const n = net({ remote: { ok: false, ms: 100 } });
    const { won } = await run(plan({ announce: false }), n);
    expect(n.calls).not.toContain("browse");
    expect(won).toBeNull();
  });

  it("goes nowhere near home without a pin", async () => {
    const n = net({ remote: { ok: false, ms: 100 } });
    const { decided, won } = await run({ remote: true, home: null }, n);
    expect(n.calls).toEqual(["remote"]);
    expect(decided).toEqual([{ route: "remote" }]);
    expect(won).toBeNull();
  });

  it("a hub reached only at home races home alone", async () => {
    const n = net({ home: { [HOME]: { ok: true, ms: 10 } } });
    const { won } = await run(plan({}, false), n);
    expect(n.calls).toEqual([`home ${HOME}`]);
    expect(won).toEqual({ route: "home", url: HOME });
  });

  it("firstOk ends at the deadline, or when every address said no", async () => {
    const no = firstOk([HOME, HOME2], () => after(10, false), 1500);
    await vi.advanceTimersByTimeAsync(10);
    expect(await no).toBeNull();
    const late = firstOk([HOME], () => after(5000, true), 1500);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await late).toBeNull();
    expect(await firstOk([], () => after(1, true), 1500)).toBeNull();
  });
});

describe("the hub's answer about its routes", () => {
  const answer = { hub_id: "01arz3ndektsv4rrffq69g5fav", method: "tailscale", remote: "https://hub.example.ts.net", home: { on: true, urls: [HOME, `${HOME}/`, "http://192.168.1.20:8787", "nonsense"], fp: PIN.toUpperCase(), announce: true } };

  it("is checked, with the pin and the id written one way", () => {
    expect(parseRoutes(answer)).toEqual({ hub_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", method: "tailscale", remote: "https://hub.example.ts.net", home: { on: true, urls: [HOME], fp: PIN, announce: true } });
    expect(parseRoutes(null)).toBeNull();
    expect(parseRoutes({ hub_id: "short", home: { fp: "xyz" } })?.home).toEqual({ on: false, urls: [], fp: null, announce: true });
  });

  it("never sends anything home without a pin, or with the home route off", () => {
    const r = parseRoutes(answer)!;
    expect(planFor(r).home).toEqual({ urls: [HOME], pin: PIN, announce: true });
    expect(planFor({ ...r, home: { ...r.home, fp: null } }).home).toBeNull();
    expect(planFor({ ...r, home: { ...r.home, on: false } }).home).toBeNull();
    expect(planFor(null)).toEqual({ remote: true, home: null });
  });

  it("keeps the address the device was set up with as the remote route, except for a hub reached only at home", () => {
    const r = parseRoutes(answer)!;
    expect(planFor({ ...r, remote: null, method: null }).remote).toBe(true);
    expect(planFor({ ...r, remote: null, method: "home" }).remote).toBe(false);
    expect(planFor({ ...r, remote: null, method: "home", home: { ...r.home, fp: null } }).remote).toBe(true);
  });
});

describe("the route chooser", () => {
  const chooser = (n: Net, now = () => Date.now()) => new RouteChooser(io(n), TIMES, now);

  it("never races without a pin, and never offers home as the other route", async () => {
    const n = net();
    const c = chooser(n);
    c.setPlan({ remote: true, home: null });
    await c.trigger("start");
    expect(n.calls).toEqual([]);
    expect(c.current).toEqual({ route: "remote" });
    expect(c.other({ route: "remote" })).toBeNull();
  });

  it("lets requests wait for the choice, not for the whole race", async () => {
    const n = net({ home: { [HOME]: { ok: false, ms: 5000 } }, remote: { ok: true, ms: 9000 } });
    const c = chooser(n);
    c.setPlan(plan());
    void c.trigger("start");
    let ready = false;
    void c.ready().then(() => { ready = true; });
    await vi.advanceTimersByTimeAsync(1499);
    expect(ready).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(ready).toBe(true);
    expect(c.current).toEqual({ route: "remote" });
  });

  it("races once more after a trigger that came during a race; a failed request does not add one", async () => {
    const n = net({ home: { [HOME]: { ok: true, ms: 100 } } });
    const c = chooser(n);
    c.setPlan(plan());
    void c.trigger("start");
    void c.trigger("network");
    void c.trigger("foreground");
    void c.trigger("failure");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(c.races).toBe(2);
    expect(c.current).toEqual({ route: "home", url: HOME });
  });

  it("races again after a failed request, once for a burst of them", async () => {
    const n = net({ home: { [HOME]: { ok: true, ms: 10 } } });
    const c = chooser(n);
    c.setPlan(plan());
    const first = c.trigger("start");
    await vi.advanceTimersByTimeAsync(200);
    await first;
    expect(c.races).toBe(1);
    // Just after a race: that race already answers them.
    void c.trigger("failure");
    void c.trigger("failure");
    expect(c.races).toBe(1);
    await vi.advanceTimersByTimeAsync(TIMES.failureGap);
    void c.trigger("failure");
    void c.trigger("failure");
    await vi.advanceTimersByTimeAsync(200);
    expect(c.races).toBe(2);
  });

  it("says when the route changes, and goes back to remote at once when the pin is gone", async () => {
    const n = net({ home: { [HOME]: { ok: true, ms: 10 } } });
    const c = chooser(n);
    const seen: Choice[] = [];
    c.subscribe((x) => seen.push(x));
    c.setPlan(plan());
    void c.trigger("start");
    await vi.advanceTimersByTimeAsync(100);
    expect(seen).toEqual([{ route: "home", url: HOME }]);
    expect(c.other({ route: "home", url: HOME })).toEqual({ route: "remote" });
    expect(c.other({ route: "remote" })).toEqual({ route: "home", url: HOME });
    expect(c.setPlan({ remote: true, home: null })).toBe(true);
    expect(c.current).toEqual({ route: "remote" });
    expect(seen).toEqual([{ route: "home", url: HOME }, { route: "remote" }]);
    expect(c.setPlan({ remote: true, home: null })).toBe(false);
  });
});

describe("sending a request again on the other route", () => {
  it("is done when it never reached the hub, or when doing it twice changes nothing", () => {
    expect(mayRetry("POST", "/capture", true)).toBe(true);
    expect(mayRetry("GET", "/sync/changes?since=4", false)).toBe(true);
    expect(mayRetry("PUT", "/prefs/feel", false)).toBe(true);
    expect(mayRetry("DELETE", "/devices/x", false)).toBe(true);
    expect(mayRetry("POST", "/sync/push", false)).toBe(true);
  });

  it("is not done for a request that may have happened already", () => {
    expect(mayRetry("POST", "/capture", false)).toBe(false);
    expect(mayRetry("POST", "/ai/chat", false)).toBe(false);
    expect(mayRetry("POST", "/devices/exchange", false)).toBe(false);
  });
});

describe("the route's name", () => {
  it("says home network, Direct link or Tailscale", () => {
    expect(routeName({ route: "home", url: HOME }, "https://hub.example.ts.net")).toBe("home");
    expect(routeName({ route: "remote" }, `iroh://${"ab".repeat(32)}?relay=${encodeURIComponent("https://relay.example")}`)).toBe("direct");
    expect(routeName({ route: "remote" }, "https://hub.example.ts.net")).toBe("tailscale");
    expect(routeName({ route: "remote" }, "https://100.101.102.103:8787")).toBe("tailscale");
    expect(routeName({ route: "remote" }, "https://hub.example.org", "tailscale")).toBe("tailscale");
    expect(routeName({ route: "remote" }, "https://hub.example.org")).toBe("address");
  });
});
