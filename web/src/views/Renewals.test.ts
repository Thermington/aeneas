import { describe, expect, it } from "vitest";
import { editedFields } from "./Renewals";

type Form = Parameters<typeof editedFields>[0];
const opened: Form = { title: "Domain for Jamie's site", category: "domain", due: "2026-11-20", lead_days: "7", repeat: "every 1 years", probe_url: "", cost: "12", url: "", notes: "", autopay: false };

describe("saving a renewal's editor", () => {
  it("writes only what was changed in it, so Renewed pressed with the editor open is not undone", () => {
    // Renewed moved the due date on; the editor still shows the old one, and only the notes were typed.
    expect(editedFields(opened, { ...opened, notes: "Renew at the registrar" })).toEqual({ notes: "Renew at the registrar" });
    expect(editedFields(opened, { ...opened })).toEqual({});
  });

  it("sends a changed date, a cleared box as null and a ticked box", () => {
    expect(editedFields(opened, { ...opened, due: "2026-12-01", cost: "", autopay: true })).toEqual({ due: "2026-12-01", cost: null, autopay: true });
    // Typed differently but stored the same: nothing to write.
    expect(editedFields(opened, { ...opened, title: " Domain for Jamie's site ", cost: "12.0" })).toEqual({});
  });
});
