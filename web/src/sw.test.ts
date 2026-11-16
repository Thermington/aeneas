import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const web = path.resolve(__dirname, "..");
// The worker as the build writes it, with its placeholders filled in.
const source = fs.readFileSync(path.join(web, "sw/sw.js"), "utf8").replaceAll("__VERSION__", "test").replaceAll("__PRECACHE__", "[]");

type Handler = (ev: unknown) => void;

/** The service worker run with a stand-in cache, and `net` in place of the network. */
function worker(net: () => Promise<Response>) {
  const on: Record<string, Handler> = {};
  const saved = new Map<string, Response>();
  const key = (r: string | { url: string }) => (typeof r === "string" ? r : r.url);
  const cache = {
    match: async (r: string | { url: string }) => saved.get(key(r))?.clone(),
    put: async (r: string | { url: string }, res: Response) => void saved.set(key(r), res),
  };
  const self = {
    location: new URL("https://hub.test/app/sw.js"),
    addEventListener: (type: string, fn: Handler) => (on[type] = fn),
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
  };
  const caches = { open: async () => cache, keys: async () => [], delete: async () => true };
  new Function("self", "caches", "fetch", source)(self, caches, net);
  /** Opens the app, as the home screen icon does. */
  const open = (): Promise<Response> => {
    let answer: Promise<Response> | undefined;
    on.fetch({ request: { method: "GET", url: "https://hub.test/app/", mode: "navigate" }, respondWith: (p: Promise<Response>) => (answer = p) });
    return answer!;
  };
  return { open };
}

const page = (body: string, status = 200) => new Response(body, { status, headers: { "Content-Type": "text/html" } });

describe("the installed web app's page", () => {
  it("opens from the saved copy while the hub restarts and Tailscale Serve answers 502", async () => {
    let next = async () => page("<p>app</p>");
    const w = worker(() => next());
    expect(await (await w.open()).text()).toBe("<p>app</p>");
    next = async () => page("Bad gateway", 502);
    const res = await w.open();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<p>app</p>");
    next = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await (await w.open()).text()).toBe("<p>app</p>");
  });

  it("shows the network's answer when nothing is saved yet, and any answer that is not a server error", async () => {
    let next = async () => page("Bad gateway", 502);
    const w = worker(() => next());
    expect((await w.open()).status).toBe(502);
    next = async () => page("<p>app</p>");
    await w.open();
    next = async () => page("Not found", 404);
    expect((await w.open()).status).toBe(404);
  });
});
