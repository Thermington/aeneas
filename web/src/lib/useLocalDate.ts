import { useEffect, useState } from "react";
import { localDayAt, msToNextDay } from "./planner";

/**
 * Today's local date ("2026-11-17"), kept current while a screen stays open: it moves on when the next day starts
 * (midnight, or `startHour`), and is read again when the window shows or gets the focus, since a timer can stall while
 * the computer sleeps. A screen that works out what "today" holds from it does so again for the new day.
 */
export function useLocalDate(startHour = 0): string {
  const [day, setDay] = useState(() => localDayAt(new Date(), startHour));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      setDay(localDayAt(new Date(), startHour));
      clearTimeout(timer);
      // A second past the start of the day, so the clock surely reads the new one.
      timer = setTimeout(check, msToNextDay(new Date(), startHour) + 1000);
    };
    const onShow = () => {
      if (document.visibilityState === "visible") check();
    };
    check();
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("focus", check);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener("focus", check);
    };
  }, [startHour]);
  return day;
}
