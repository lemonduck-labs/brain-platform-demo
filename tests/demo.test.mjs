// Tests for demo mode (netlify/functions/lib/demo.mts and its wiring in api.mts): the gate with
// no passphrase, the bundled vault, the per-visitor overlay, the write cap and the pinned clock.
// The function runs end to end against a small bundle handed in here, so no build is needed.
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const ENV = { BRAIN_MODE: "demo", DEMO_TODAY: "2026-10-22" };
globalThis.Netlify = { env: { get: (k) => ENV[k] } };

const demo = await import("../netlify/functions/lib/demo.mts");
const { default: handler } = await import("../netlify/functions/api.mts");

const sha = (t) => createHash("sha1").update(`blob ${Buffer.byteLength(t)}\0${t}`).digest("hex");
const file = (path, content) => ({ path, content, sha: sha(content), size: Buffer.byteLength(content) });
const NOW = `---
title: Now
updated: 2026-10-22
---

# Now

## This week

1. Warmstead first.

## Waiting on the operator

- [ ] Read the Warmstead cost per lead #decision

## Later, parked on purpose

- Nothing yet.
`;
const APPROVALS = `---
title: Approvals
---

# Approvals

## Queue

| id | status | title | detail | cost | reversible | source | added | decided | note |
|---|---|---|---|---|---|---|---|---|---|
| a-2026-10-21-budget-step | pending | Warmstead budget step | Move spend to Search |  | yes | WEEKLY | 2026-10-21 09:00 |  |  |

## Notes

| id | status | task | note | file | line | added | done | outcome |
|---|---|---|---|---|---|---|---|---|
`;

function fresh() {
  demo.setBundle({
    generatedAt: "2026-10-22T17:00:00.000Z", source: "test", commit: "c0ffee0000000000000000000000000000000000",
    files: [file("Now.md", NOW), file("System/Approvals.md", APPROVALS), file("System/Chat.md", "# Chat\n\n## 2026-10-21 18:52 · Operator\nHello\n\n## 2026-10-21 18:55 · Brain\nHi.\n")],
  });
}

async function call(path, { method = "GET", key = "", body } = {}) {
  const res = await handler(new Request(`http://localhost/api/${path}`, {
    method, headers: { "x-brain-key": key, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  }));
  return { status: res.status, body: await res.json() };
}
const enter = async () => (await call("auth/demo", { method: "POST" })).body.token;

test("health reports demo mode and the pinned day", async () => {
  fresh();
  const r = await call("health");
  assert.equal(r.body.demo, true);
  assert.equal(r.body.today, "2026-10-22");
  assert.match(r.body.notice, /changes stay in this visit only/);
});

test("the demo gate needs no passphrase, and the passphrase route is closed", async () => {
  fresh();
  assert.equal((await call("state")).status, 401);
  assert.equal((await call("auth/passphrase", { method: "POST", body: { hash: "x" } })).status, 404);
  const key = await enter();
  assert.ok(key && key.length >= 32);
  const s = await call("state", { key });
  assert.equal(s.status, 200);
  assert.equal(s.body.today.ymd, "2026-10-22");
  assert.equal(s.body.today.weekday, "Thursday");
  assert.equal(s.body.today.week, 43);
  assert.equal(s.body.counts.approvalsPending, 1);
  assert.equal(s.body.demo.writes, 0);
  assert.equal(s.body.watcher.configured, false);
});

test("one visitor's writes stay theirs, and are labelled as such", async () => {
  fresh();
  const a = await enter(), b = await enter();
  const w = await call("task/add", { method: "POST", key: a, body: { text: "Only in visit A", tag: "next" } });
  assert.equal(w.status, 200);
  assert.equal(w.body.demo.visitOnly, true);
  const sa = await call("state", { key: a }), sb = await call("state", { key: b });
  assert.ok(sa.body.tasks.some((t) => t.text === "Only in visit A"));
  assert.ok(!sb.body.tasks.some((t) => t.text === "Only in visit A"));
  assert.notEqual(sa.body.repo.commit, sb.body.repo.commit);
  // snoozes are per visitor too
  await call("snooze", { method: "POST", key: a, body: { id: "a-2026-10-21-budget-step", until: "2026-10-23T09:00:00Z" } });
  assert.ok((await call("state", { key: a })).body.snoozes["a-2026-10-21-budget-step"]);
  assert.deepEqual((await call("state", { key: b })).body.snoozes, {});
});

test("chat writes under Operator, and logging out ends the visit", async () => {
  fresh();
  const a = await enter();
  const r = await call("chat", { method: "POST", key: a, body: { text: "A demo message" } });
  assert.equal(r.status, 200);
  const last = r.body.messages[r.body.messages.length - 1];
  assert.deepEqual([last.who, last.text, last.at.slice(0, 10)], ["Operator", "A demo message", "2026-10-22"]);
  assert.equal(r.body.waiting, true);
  await call("auth/logout", { method: "POST", key: a });
  assert.equal((await call("state", { key: a })).status, 401);
});

test("a stale sha is a conflict, and the write cap holds", async () => {
  fresh();
  const a = await enter();
  const note = await call("note?path=Now.md", { key: a });
  const ok = await call("note", { method: "PUT", key: a, body: { path: "Now.md", content: note.body.content + "\nOne.\n", sha: note.body.sha } });
  assert.equal(ok.status, 200);
  const stale = await call("note", { method: "PUT", key: a, body: { path: "Now.md", content: "Two.\n", sha: note.body.sha } });
  assert.equal(stale.status, 409);
  let sha = ok.body.sha, last;
  for (let i = 1; i < demo.DEMO_WRITE_CAP; i++) {
    last = await call("note", { method: "PUT", key: a, body: { path: "Inbox/Scratch.md", content: `line ${i}\n`, sha: i === 1 ? undefined : sha } });
    sha = last.body.sha;
  }
  assert.equal(last.status, 200);
  const over = await call("note", { method: "PUT", key: a, body: { path: "Inbox/Scratch.md", content: "one too many\n", sha } });
  assert.equal(over.status, 429);
  assert.match(over.body.error, /reached its 200 changes/);
});

test("the bundle itself is never changed", async () => {
  fresh();
  const a = await enter();
  await call("journal", { method: "POST", key: a, body: { text: "A line" } });
  const b = await enter();
  const daily = await call("note?path=Journal/Daily/2026-10-22.md", { key: b });
  assert.equal(daily.status, 404);
});
