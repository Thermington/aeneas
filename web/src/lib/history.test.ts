import { describe, expect, it } from "vitest";
import type { Entity } from "@everythingapp/shared";
import { historyItems, plannedSteps } from "./history";

const ent = (id: string, kind: string, fields: Record<string, unknown>, updated_at = ""): Entity =>
  ({ id, kind, space: "personal", created_at: "", updated_at, deleted_at: null, fields, field_ts: {} }) as unknown as Entity;

const journal = [
  ent("j1", "journal", { host: "desk-pc", at: "2026-11-19T10:00:00Z", what: "Replaced the case fan", risk: "low", outcome: "done" }),
  ent("j2", "journal", { host: "desk-pc", at: "2026-11-19T11:00:00Z", what: "Restart ollama", command: "Restart-Service ollama", rollback: "none needed", risk: "medium", outcome: "done", session_id: "s1" }),
  ent("j3", "journal", { host: "desk-pc", at: "2026-11-19T12:00:00Z", what: "Count words in the notes", command: "wc -w", risk: "low", outcome: "done", session_id: "s2", lookup: true }),
  ent("j4", "journal", { host: "desk-pc", at: "2026-11-19T13:00:00Z", what: "Disk P: went above 90%: 91.2%", risk: "low", outcome: "done", source: "hub" }),
  ent("j5", "journal", { host: "desk-pc", at: "2026-11-03T18:00:00Z", what: "rm -rf /mnt/b/old", command: "rm -rf /mnt/b/old", risk: "high", outcome: "planned" }),
  ent("j6", "journal", { host: "server", at: "2026-11-19T14:00:00Z", what: "Upgrade packages", command: "apt-get -y upgrade", risk: "medium", outcome: "failed", session_id: "s3" }),
];
const incidents = [
  ent("i1", "incident", { monitor_id: "m1", name: "Ollama", opened_at: "2026-11-19T09:00:00Z", closed_at: "2026-11-19T09:37:00Z", last_error: "refused the connection on port 11434" }),
  ent("i2", "incident", { monitor_id: "m1", name: "Ollama", opened_at: "2026-11-18T09:00:00Z", closed_at: "2026-11-18T09:01:00Z", merged_into: "i9" }),
];
const runbooks = [ent("r1", "runbook", { host: "desk-pc", title: "Fix notes: desk-pc" }, "2026-11-19T15:00:00Z")];
const hostOf = (id: string) => (id === "m1" ? "desk-pc" : undefined);

describe("History", () => {
  it("puts a machine's changes, alerts, outages and fix notes together, newest first, without lookups or planned steps", () => {
    const items = historyItems({ journal, incidents, runbooks, hostOf }, "desk-pc");
    expect(items.map((i) => [i.kind, i.text, i.by ?? null])).toEqual([
      ["notes", "Fix notes updated", null],
      ["event", "Disk P: went above 90%: 91.2%", "hub"],
      ["change", "Restart ollama", "assistant"],
      ["change", "Replaced the case fan", "you"],
      ["back", "Ollama came back after 37m 0s", "hub"],
      ["down", "Ollama went down", "hub"],
    ]);
    expect(items.find((i) => i.text === "Restart ollama")).toMatchObject({ command: "Restart-Service ollama", rollback: "none needed", session_id: "s1" });
  });

  it("lists every machine together for the Overview, and a failed change says so", () => {
    const all = historyItems({ journal, incidents, runbooks, hostOf });
    expect([...new Set(all.map((i) => i.host))].sort()).toEqual(["desk-pc", "server"]);
    const failed = all.find((i) => i.host === "server")!;
    expect([failed.kind, failed.detail]).toEqual(["failed", "it failed"]);
  });

  it("keeps steps only planned apart, for Done or Didn't do it", () => {
    expect(plannedSteps(journal, "DESK-PC").map((e) => e.id)).toEqual(["j5"]);
    expect(plannedSteps(journal, "server")).toEqual([]);
  });
});
