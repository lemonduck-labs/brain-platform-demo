// Tests for Approvals that stick (netlify/functions/lib/settle.mts): the per-row review and
// snooze store, with the legacy "map" fallback, and the setRowStatus retry on a 409 or 422.
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import * as settle from "../netlify/functions/lib/settle.mts";

// ---------- a fake Blobs store: an in-memory map of key to stored JSON text ----------

function fakeStore(initial = {}) {
  const data = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  const calls = { set: [] };
  return {
    data, calls,
    async get(key, opts) { assert.equal(opts.type, "json"); return data.has(key) ? JSON.parse(data.get(key)) : null; },
    async setJSON(key, value) { calls.set.push(key); data.set(key, JSON.stringify(value)); return {}; },
    async list({ prefix }) { return { blobs: [...data.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, etag: "x" })) }; },
  };
}

test("review store: per-row keys, read back as one map", async () => {
  const s = fakeStore();
  await settle.writeRowState(s, "a-2026-09-27-one", { status: "settled", at: "2026-09-27 10:00" });
  await settle.writeRowState(s, "a-2026-09-27-two", { status: "later", at: "2026-09-27 10:01" });
  assert.deepEqual([...s.data.keys()].sort(), ["row/a-2026-09-27-one", "row/a-2026-09-27-two"]);
  assert.ok(!s.data.has("map"), "the shared map is never written");
  assert.deepEqual(await settle.readRows(s), {
    "a-2026-09-27-one": { status: "settled", at: "2026-09-27 10:00" },
    "a-2026-09-27-two": { status: "later", at: "2026-09-27 10:01" },
  });
});

test("review store: two accepts close together both survive", async () => {
  const s = fakeStore();
  // Both start before either finishes, which is what lost one under the shared map.
  await Promise.all([
    settle.writeRowState(s, "a-1", { status: "settled", at: "t1" }),
    settle.writeRowState(s, "a-2", { status: "settled", at: "t2" }),
    settle.writeRowState(s, "a-3", { status: "settled", at: "t3" }),
  ]);
  const rows = await settle.readRows(s);
  assert.deepEqual(Object.keys(rows).sort(), ["a-1", "a-2", "a-3"]);
});

test("review store: the legacy map is folded in, and per-row keys win", async () => {
  const s = fakeStore({
    map: { "a-old": { status: "settled", at: "2026-09-20 09:00" }, "a-both": { status: "later", at: "2026-09-21 09:00" } },
  });
  assert.deepEqual(await settle.readRows(s), {
    "a-old": { status: "settled", at: "2026-09-20 09:00" },
    "a-both": { status: "later", at: "2026-09-21 09:00" },
  });
  await settle.writeRowState(s, "a-both", { status: "settled", at: "2026-09-27 11:00" });
  const rows = await settle.readRows(s);
  assert.deepEqual(rows["a-both"], { status: "settled", at: "2026-09-27 11:00" }, "per-row beats the map");
  assert.deepEqual(rows["a-old"], { status: "settled", at: "2026-09-20 09:00" }, "settled before this build stays settled");
  assert.deepEqual(JSON.parse(s.data.get("map"))["a-both"], { status: "later", at: "2026-09-21 09:00" }, "the map itself is left untouched");
});

test("review store: clearing a row hides it even when the legacy map still names it", async () => {
  const s = fakeStore({ map: { "a-redo": { status: "later", at: "t" } } });
  await settle.writeRowState(s, "a-redo", null);
  assert.deepEqual(await settle.readRows(s), {});
  await settle.writeRowState(s, "a-redo", { status: "settled", at: "t2" });
  assert.deepEqual(await settle.readRows(s), { "a-redo": { status: "settled", at: "t2" } });
});

test("review store: no data at all reads as an empty map", async () => {
  assert.deepEqual(await settle.readRows(fakeStore()), {});
});

test("snooze store: ids with slashes and colons round-trip, strings as values", async () => {
  const s = fakeStore({ map: { "a-legacy": "2026-10-01T08:00:00.000Z" } });
  const needId = "Wiki/Gaugewell/Gaugewell.md::42";
  await settle.writeRowState(s, needId, "2026-09-28T08:00:00.000Z");
  const key = settle.rowKey(needId);
  assert.ok(key.startsWith("row/") && !key.slice(4).includes("/"), "one flat key per row");
  assert.equal(settle.idFromKey(key), needId);
  assert.deepEqual(await settle.readRows(s), { "a-legacy": "2026-10-01T08:00:00.000Z", [needId]: "2026-09-28T08:00:00.000Z" });
  await settle.writeRowState(s, "a-legacy", null);
  assert.deepEqual(await settle.readRows(s), { [needId]: "2026-09-28T08:00:00.000Z" });
});

// ---------- setRowStatus: applyRowStatus inside writeWithRetry ----------

const QUEUE = `# Approvals

## Queue

| id | status | title | detail | cost | reversible | source | requested | decided | note |
|---|---|---|---|---|---|---|---|---|---|
| a-1 | pending | One | d |  | yes | chat | 2026-09-26 |  | n1 |
| a-2 | pending | Two | d |  | yes | chat | 2026-09-26 |  | n2 |
`;

test("applyRowStatus: sets status and the decided stamp on the named row only", () => {
  const out = settle.applyRowStatus(QUEUE, "a-2", "approved", { stamp: "2026-09-27 12:00", decidedCol: 8 });
  assert.ok(out.includes("| a-2 | approved | Two | d |  | yes | chat | 2026-09-26 | 2026-09-27 12:00 | n2 |"));
  assert.ok(out.includes("| a-1 | pending | One |"));
  assert.equal(settle.applyRowStatus(QUEUE, "a-9", "approved"), null);
});

// A fake vault: read returns the current text and a sha; write fails with the given statuses
// first (as if the file moved underneath), then succeeds.
function fakeVault(text, failures = []) {
  let content = text, sha = 1, reads = 0, writes = 0;
  return {
    get content() { return content; }, get reads() { return reads; }, get writes() { return writes; },
    async read() { reads++; return { content, sha: String(sha) }; },
    async write(_p, c, _m, s) {
      writes++;
      const f = failures.shift();
      if (f) {
        // Someone else changed the file between our read and write: a different row moved.
        content = content.replace("| a-1 | pending |", "| a-1 | declined |"); sha++;
        const e = new Error("GitHub " + f); e.status = f; throw e;
      }
      assert.equal(s, String(sha), "writes against the sha it read");
      content = c; sha++;
      return { commit: "c" + sha };
    },
  };
}
const approve = (id) => (text) => {
  const next = settle.applyRowStatus(text, id, "approved", { stamp: "2026-09-27 12:00", decidedCol: 8 });
  return next === null ? { ok: false, status: 404, error: "row " + id + " not found" } : { ok: true, content: next };
};

test("writeWithRetry: a 409 is retried against a fresh read, and the other change is kept", async () => {
  const v = fakeVault(QUEUE, [409]);
  const r = await settle.writeWithRetry(v, "System/Approvals.md", approve("a-2"), "platform: queue a-2 approved");
  assert.equal(r.ok, true);
  assert.ok(r.commit);
  assert.equal(v.reads, 2);
  assert.ok(v.content.includes("| a-2 | approved |"), "our change landed");
  assert.ok(v.content.includes("| a-1 | declined |"), "the change made in between was not overwritten");
});

test("writeWithRetry: a 422 is retried too, and succeeds on the third attempt", async () => {
  const v = fakeVault(QUEUE, [422, 409]);
  const r = await settle.writeWithRetry(v, "System/Approvals.md", approve("a-2"), "m");
  assert.equal(r.ok, true);
  assert.equal(v.reads, 3);
  assert.equal(v.writes, 3);
});

test("writeWithRetry: gives up after three attempts with a 409, never a fourth", async () => {
  const v = fakeVault(QUEUE, [409, 409, 409, 409]);
  const r = await settle.writeWithRetry(v, "System/Approvals.md", approve("a-2"), "m");
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(v.writes, 3);
});

test("writeWithRetry: any other GitHub error is thrown at once, not retried", async () => {
  const v = fakeVault(QUEUE, [500]);
  await assert.rejects(settle.writeWithRetry(v, "System/Approvals.md", approve("a-2"), "m"), /GitHub 500/);
  assert.equal(v.writes, 1);
});

test("writeWithRetry: a missing row or file is reported without writing", async () => {
  const v = fakeVault(QUEUE);
  const r = await settle.writeWithRetry(v, "System/Approvals.md", approve("a-9"), "m");
  assert.deepEqual(r, { ok: false, status: 404, error: "row a-9 not found" });
  assert.equal(v.writes, 0);
  const none = await settle.writeWithRetry({ read: async () => null, write: async () => { throw new Error("no"); } }, "System/Approvals.md", approve("a-2"), "m");
  assert.equal(none.ok, false);
  assert.equal(none.status, 404);
});

// ---------- getTree: the cached tree is reused only while the branch ref has not moved ----------

test("treeFor: reuses the cache for the same commit, rebuilds when the ref moves or on force", async () => {
  let head = "c1", builds = 0, refReads = 0;
  const ref = async () => { refReads++; return head; };
  const build = async (sha) => { builds++; return { sha, entries: ["built for " + sha] }; };
  let cache = await settle.treeFor(null, ref, build);
  assert.equal(cache.sha, "c1");
  assert.equal(builds, 1);
  const again = await settle.treeFor(cache, ref, build);
  assert.equal(again, cache, "same commit: the cached tree itself");
  assert.equal(builds, 1);
  // Another instance wrote to the vault: this instance's cache is stale and must not be served.
  head = "c2";
  cache = await settle.treeFor(cache, ref, build);
  assert.equal(cache.sha, "c2");
  assert.equal(builds, 2);
  await settle.treeFor(cache, ref, build, true);
  assert.equal(builds, 3, "force always rebuilds");
  assert.equal(refReads, 4, "the ref is read on every call");
});

test("treeFor: a failed ref read serves the cache, and throws with no cache or on force", async () => {
  const cache = { sha: "c1", entries: [] };
  let builds = 0;
  const down = async () => { const e = new Error("GitHub 502"); e.status = 502; throw e; };
  const build = async (sha) => { builds++; return { sha, entries: [] }; };
  assert.equal(await settle.treeFor(cache, down, build), cache);
  await assert.rejects(settle.treeFor(null, down, build), /GitHub 502/);
  await assert.rejects(settle.treeFor(cache, down, build, true), /GitHub 502/);
  assert.equal(builds, 0);
});
