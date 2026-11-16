import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeHub } from "./helpers.js";
import { BEFORE_YOU_INSTALL } from "../src/disclosure.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");
/** Paragraphs with their line breaks and runs of spaces made single spaces. */
const paragraphs = (s: string) => s.trim().split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim());

test("how Aeneas was made is said first, word for word, wherever it is offered", async () => {
  const doc = paragraphs(read("docs/before-you-install.md"));
  assert.equal(doc.length, 3);
  assert.match(doc[0], /^Before you install: almost all of Aeneas's code was written by an AI coding assistant/);
  assert.deepEqual([...BEFORE_YOU_INSTALL], doc, "the hub's install page");
  // The README and the Android store text (F-Droid reads it) start with it.
  const readme = read("README.md");
  assert.ok(readme.startsWith("# Aeneas\n\n"));
  assert.deepEqual(paragraphs(readme.slice("# Aeneas\n\n".length)).slice(0, 3), doc, "README.md");
  assert.deepEqual(paragraphs(read("fastlane/metadata/android/en-US/full_description.txt")).slice(0, 3), doc, "the Android store text");
  // Every GitHub release page starts with the file itself.
  assert.match(read(".github/workflows/release.yml"), /cat docs\/before-you-install\.md;[^\n]*> release-notes\.md\n\s*gh release create [^\n]*--notes-file release-notes\.md/);
  // The hub's page for installing an iPhone build shows it before anything else.
  const t = makeHub();
  try {
    const page = await (await t.app.request("/install")).text();
    const at = page.indexOf("Before you install: almost all of Aeneas");
    assert.ok(at > 0 && at < page.indexOf("No build has been published"), "first on the install page");
  } finally { t.cleanup(); }
});
