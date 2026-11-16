import { describe, expect, it } from "vitest";
import { currentLedger } from "./ledger";

describe("currentLedger", () => {
  const l = (id: string, open: boolean, updated_at: string) => ({ id, fields: { open }, updated_at });
  it("shows the open ledger, else the newest closed one", () => {
    expect(currentLedger([l("a", false, "2026-11-15T10:00:00.000Z"), l("b", true, "2026-11-15T09:00:00.000Z")])?.id).toBe("b");
    expect(currentLedger([l("a", false, "2026-11-15T10:00:00.000Z"), l("b", false, "2026-11-15T11:00:00.000Z")])?.id).toBe("b");
    expect(currentLedger([])).toBeUndefined();
  });
});
