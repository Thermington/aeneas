import type { CSSProperties } from "react";
import { calendarColor, eventCalendarKey, type CalendarColor } from "@everythingapp/shared";

/**
 * An event's calendar color as a CSS variable (`--cal`) for its block, bar or chip: the owner's choice in Theme,
 * Calendar colors, else the color its calendar has in Apple Calendar or iCloud. None: the styles use the accent.
 */
export function eventColorStyle(fields: Record<string, unknown>, calendars: CalendarColor[] | undefined): CSSProperties | undefined {
  const c = calendarColor(eventCalendarKey(fields), calendars);
  return c ? ({ "--cal": c } as CSSProperties) : undefined;
}
