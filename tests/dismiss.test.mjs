// Tests for Dismiss (netlify/functions/lib/dismiss.mts): a task that is not needed is kept in its
// note, marked "- [-]", with a dated note under it, and drops out of every open-task reader.
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { dismissLines } from "../netlify/functions/lib/dismiss.mts";

// The same pattern scanTasks in api.mts uses to find a task line.
const TASK_RE = /^(\s*)- \[( |x|X)\] (.+)$/;

test("an open task is marked [-] with a dated note, and no reader sees it as a task", () => {
  const lines = ["## Open", "- [ ] Check the Trustpilot rating #next", "- [ ] Keep me #next"];
  const r = dismissLines(lines, 1, "Check the Trustpilot rating #next", "2026-10-20 10:45");
  assert.equal(r.ok, true);
  assert.deepEqual(r.lines, [
    "## Open",
    "- [-] Check the Trustpilot rating #next",
    "    - Dismissed on the platform, 2026-10-20 10:45",
    "- [ ] Keep me #next",
  ]);
  assert.equal(r.lines.filter((l) => TASK_RE.test(l)).length, 1, "only the untouched task is still a task");
  assert.equal(r.lines.filter((l) => /^\s*- \[ \]/.test(l)).length, 1, "a grep for open boxes no longer finds it");
});

test("an indented task keeps its indent and its note sits under it", () => {
  const r = dismissLines(["- [ ] Parent #next", "    - [ ] Child #next"], 1, "Child #next", "2026-10-20 10:45");
  assert.equal(r.ok, true);
  assert.deepEqual(r.lines.slice(1), ["    - [-] Child #next", "        - Dismissed on the platform, 2026-10-20 10:45"]);
});

test("existing notes under the task are kept", () => {
  const r = dismissLines(["- [ ] Task #next", "    - an old note"], 0, "Task #next", "2026-10-20 10:45");
  assert.deepEqual(r.lines, ["- [-] Task #next", "    - Dismissed on the platform, 2026-10-20 10:45", "    - an old note"]);
});

test("a line that changed since load is refused, and nothing is written", () => {
  const lines = ["- [ ] Something else #next"];
  assert.deepEqual(dismissLines(lines, 0, "Task #next", "x"), { ok: false, reason: "changed" });
  assert.deepEqual(dismissLines(lines, 5, "Task #next", "x"), { ok: false, reason: "changed" });
  assert.deepEqual(lines, ["- [ ] Something else #next"]);
});

test("a done task, or one already dismissed, is not dismissed", () => {
  assert.deepEqual(dismissLines(["- [x] Task #next"], 0, "Task #next", "x"), { ok: false, reason: "not-open" });
  assert.deepEqual(dismissLines(["- [-] Task #next"], 0, "Task #next", "x"), { ok: false, reason: "not-open" });
});
