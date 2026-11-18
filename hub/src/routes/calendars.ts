import { Hono } from "hono";
import type { Hub } from "../hub.js";
import { readJsonObject } from "../http.js";
import { calendarView, chooseCalendars, linkCalendarAccount, syncCalendarsNow, unlinkCalendarAccount } from "../calendar-sync.js";

/**
 * Calendar sync (calendar-sync.ts, `calendars` module): link an iCloud address (the app-specific password is checked
 * with iCloud once and kept sealed, never returned), choose its calendars and the one new events go to, sync now, stop.
 */
export function calendarRoutes() {
  const r = new Hono<{ Variables: { hub: Hub } }>();
  r.get("/calendars", (c) => c.json(calendarView(c.get("hub"))));
  r.put("/calendars/icloud", async (c) => {
    const hub = c.get("hub");
    const v = await linkCalendarAccount(hub, await readJsonObject(c));
    return c.json(v);
  });
  r.put("/calendars/icloud/:email", async (c) => {
    const hub = c.get("hub");
    const v = chooseCalendars(hub, decodeURIComponent(c.req.param("email")).toLowerCase(), await readJsonObject(c));
    void syncCalendarsNow(hub).catch(() => undefined);
    return c.json(v);
  });
  r.post("/calendars/sync", async (c) => {
    const hub = c.get("hub");
    const results = await syncCalendarsNow(hub, { owner: true });
    return c.json({ ...calendarView(hub), results });
  });
  r.delete("/calendars/icloud/:email", (c) => c.json(unlinkCalendarAccount(c.get("hub"), decodeURIComponent(c.req.param("email")).toLowerCase())));
  return r;
}
