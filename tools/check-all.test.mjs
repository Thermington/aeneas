import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { workflowSteps } from "./check-all.mjs";

const workflow = (file) => readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");

test("the check before a push reads every command CI runs, from the workflows themselves", () => {
  const ci = workflowSteps(workflow("ci.yml")).map((s) => s.run);
  for (const run of ["npm ci", "npm --workspace hub test", "npm --workspace web test", "npm --workspace web run build", "npm run license-check", "node --test tools/check-all.test.mjs"]) {
    assert.ok(ci.includes(run), run);
  }
  assert.ok(!ci.some((r) => r.startsWith("actions/")), "uses: steps are left out");
  const apple = workflowSteps(workflow("apple.yml"));
  assert.deepEqual(apple.at(-1), { name: "swift test (EACore)", run: "swift test", cwd: "apple/Packages/EACore" });
});

test("a workflow it cannot follow is refused, not half read", () => {
  assert.throws(() => workflowSteps("jobs:\n  a:\n    steps:\n      - run: |\n          echo one\n          echo two\n"), /several lines/);
  assert.throws(() => workflowSteps("jobs:\n  a:\n    steps:\n      - run: a\n  b:\n    steps:\n      - run: b\n"), /more than one job/);
  assert.throws(() => workflowSteps("on: push\n"), /no steps/);
});

test("values nested under a step (with:, env:) are not taken for the step's own", () => {
  const steps = workflowSteps("jobs:\n  a:\n    steps:\n      - uses: x@v1\n        with:\n          run: not-a-step\n      - name: Real\n        run: echo real\n        working-directory: sub\n");
  assert.deepEqual(steps, [{ name: "Real", run: "echo real", cwd: "sub" }]);
});
