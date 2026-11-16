import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/hub.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("one version: the hub, the iPhone, Mac and Watch apps, the Windows and Android apps and the lock files say the same", () => {
  // tools/version.mjs fails, naming each place, when they differ (the release workflow runs it on every tag too).
  const out = execFileSync(process.execPath, [path.join(ROOT, "tools/version.mjs")], { encoding: "utf8" });
  const m = /one version: (\d+\.\d+\.\d+)/.exec(out);
  assert.ok(m, out);
  assert.equal(VERSION, m[1], "the hub reports it in /health, so a hub from GitHub and an app from the App Store of one release match");
});
