// Tests for Lead gen station v2 (netlify/functions/lib/leads.mts): the Owlbridge activity log, the
// writes that append to it, bulk and field edits, and the figures the Leads home, list, board
// and record read (funnel, staleness, timeline grouping, sequence position).
// Run with: npm test
//
// The live checks read the real notes from a local clone of the vault (VAULT_DIR, default
// ../vault beside this repo) and are skipped when there is none.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as leadgen from "../netlify/functions/lib/leads.mts";

const here = dirname(fileURLToPath(import.meta.url));
const VAULT = process.env.VAULT_DIR || join(here, "..", "..", "vault");
const liveAct = join(VAULT, leadgen.ACTIVITY_PATH);
const livePipe = join(VAULT, leadgen.PIPELINE_PATH);

const HEAD = "| id | company | segment | tier | score | contact | email | status | last touch | next step | next date | source |\n|---|---|---|---|---|---|---|---|---|---|---|---|";
const pipe = (rows) => `---\ntitle: Owlbridge pipeline\n---\n\n# Owlbridge pipeline\n\n## Leads\n\n${HEAD}\n${rows.join("\n")}\n\n## Related\n\n[[Leads area]]\n`;
const A = "| L-a | Alpha Bakery | Pubs | A | 90 | Owner, MD | ann\u0040alpha.example | drafted |  | Send email 1 | 2026-09-28 | batch 1 |";
const B = "| L-b | Beta Group | Nurseries | B |  | Director |  | researched |  | Find a contact | 2026-09-20 | batch 1 |";
const C = "| L-c | Gamma Dental | Dental | C | 62 | Manager |  | sent | 2026-09-10 | Chase | 2026-09-24 | seed list |";

const ACT_HEAD = "| at | lead | type | summary | by |\n|---|---|---|---|---|";
const act = (rows) => `---\ntitle: Owlbridge activity log\ntype: log\nupdated: 2026-09-26\n---\n\n# Owlbridge activity log\n\nIntro.\n\n## Activity\n\n${ACT_HEAD}\n${rows.join("\n")}\n\n## Related\n\n[[Owlbridge pipeline]]\n`;
const line = (at, lead, type, summary, by = "Cowork") => `| ${at} | ${lead} | ${type} | ${summary} | ${by} |`;
const E = (lead, type, summary, at = "2026-09-26 10:15", by = "Operator") => ({ at, lead, type, summary, by });

// ---------- the parser ----------

test("activity parser: an empty or missing note, and a note with no table", () => {
  for (const md of ["", "   \n", null, undefined, "# Owlbridge activity log\n\nNo table yet.\n"]) {
    const p = leadgen.parseActivity(md);
    assert.equal(p.found, false);
    assert.deepEqual(p.rows, []);
  }
  const headerOnly = leadgen.parseActivity(act([]));
  assert.equal(headerOnly.found, true);
  assert.deepEqual(headerOnly.rows, []);
});

test("activity parser: one line", () => {
  const p = leadgen.parseActivity(act([line("2026-09-26 01:00", "L-a", "System", "Added to the pipeline")]));
  assert.equal(p.rows.length, 1);
  assert.deepEqual({ ...p.rows[0], line: undefined }, { at: "2026-09-26 01:00", lead: "L-a", type: "system", summary: "Added to the pipeline", by: "Cowork", line: undefined });
});

test("activity parser: 200 lines, in file order, blank cells tolerated", () => {
  const rows = Array.from({ length: 200 }, (_, i) => line(`2026-09-${String(1 + (i % 28)).padStart(2, "0")} 09:00`, `L-${i % 7}`, i % 2 ? "call" : "note", `Line ${i}`, i % 3 ? "Director" : ""));
  const p = leadgen.parseActivity(act(rows));
  assert.equal(p.rows.length, 200);
  assert.equal(p.rows[0].summary, "Line 0");
  assert.equal(p.rows[199].summary, "Line 199");
  assert.equal(p.rows[0].by, "", "a blank by cell reads as blank");
  const short = leadgen.parseActivity(act(["| 2026-09-26 11:00 | L-a | note |"]));
  assert.equal(short.rows.length, 1, "a row missing its last cells still reads");
  assert.deepEqual([short.rows[0].summary, short.rows[0].by], ["", ""]);
  const noLead = leadgen.parseActivity(act(["|  |  | note | Something | Operator |"]));
  assert.equal(noLead.rows.length, 1);
  assert.equal(noLead.rows[0].lead, "");
});

test("activity parser: a table without the Activity heading is still found by its header", () => {
  const md = "# Log\n\n| other | table |\n|---|---|\n| x | y |\n\n| at | lead | type | summary | by |\n|---|---|---|---|---|\n| 2026-09-26 09:00 | L-a | call | Spoke to the owner | Operator |\n";
  const p = leadgen.parseActivity(md);
  assert.equal(p.found, true);
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0].summary, "Spoke to the owner");
});

test("activity parser: the live log", { skip: !existsSync(liveAct) && "no vault clone at " + VAULT }, () => {
  const p = leadgen.parseActivity(readFileSync(liveAct, "utf8"));
  assert.equal(p.found, true);
  assert.ok(p.rows.length >= 36, "at least the 36 seed lines");
  for (const a of p.rows) {
    assert.match(a.at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, "at is YYYY-MM-DD HH:MM");
    assert.ok(leadgen.ACTIVITY_TYPES.includes(a.type), `${a.type} is a known type`);
  }
  if (existsSync(livePipe)) {
    const ids = new Set(leadgen.parseLeads(readFileSync(livePipe, "utf8")).leads.map((l) => l.id));
    assert.ok(p.rows.every((a) => ids.has(a.lead)), "every line names a lead in the pipeline");
  }
});

// ---------- appending ----------

test("append: lines go at the foot of the table, above Related, nothing else changes", () => {
  const md = act([line("2026-09-26 01:00", "L-a", "system", "Seed")]);
  const r = leadgen.applyAppendActivity(md, [E("L-a", "call", "Spoke to the owner | left a message\nwill chase"), E("L-b", "note", "Checked filed accounts")]);
  assert.equal(r.ok, true);
  const p = leadgen.parseActivity(r.text);
  assert.deepEqual(p.rows.map((a) => a.summary), ["Seed", "Spoke to the owner / left a message will chase", "Checked filed accounts"]);
  assert.ok(r.text.includes("| Checked filed accounts | Operator |\n\n## Related"), "above Related, blank line kept");
  assert.ok(r.text.startsWith("---\ntitle: Owlbridge activity log\ntype: log\nupdated: 2026-09-26\n---"), "frontmatter untouched, so a union merge never doubles it");
  assert.equal(r.text.split("\n").length, md.split("\n").length + 2, "only the two lines were added");
});

test("append: an empty note is created with the table; a note without one gets the section", () => {
  const r = leadgen.applyAppendActivity("", [E("L-a", "note", "First line")]);
  assert.equal(r.ok, true);
  assert.match(r.text, /^---\ntitle: Owlbridge activity log\n/);
  assert.match(r.text, /updated: 2026-09-26/);
  assert.equal(leadgen.parseActivity(r.text).rows.length, 1);
  const r2 = leadgen.applyAppendActivity("# Owlbridge activity log\n\nIntro.\n\n## Related\n\n[[x]]\n", [E("L-a", "note", "First line")]);
  assert.equal(r2.ok, true);
  assert.ok(r2.text.indexOf("## Activity") < r2.text.indexOf("## Related"));
  assert.equal(leadgen.parseActivity(r2.text).rows[0].summary, "First line");
});

test("append: refuses an unknown type or an empty summary", () => {
  assert.equal(leadgen.applyAppendActivity(act([]), [E("L-a", "tweet", "x")]).ok, false);
  assert.equal(leadgen.applyAppendActivity(act([]), [E("L-a", "note", "   ")]).ok, false);
});

// A stand-in for GitHub's Contents API over several files: a write with a stale sha is refused
// with 409, as GitHub does, and a missing file is created only without a sha.
function fakeVault(files) {
  const store = new Map(Object.entries(files).map(([p, c]) => [p, { content: c, sha: 1 }]));
  let writes = 0;
  const v = {
    text: (p) => store.get(p)?.content,
    get writes() { return writes; },
    external(p, fn) { const f = store.get(p); store.set(p, { content: fn(f ? f.content : ""), sha: (f ? f.sha : 0) + 1 }); },
    io(beforeWrite) {
      return {
        read: async (p) => { const f = store.get(p); return f ? { content: f.content, sha: String(f.sha) } : null; },
        write: async (p, c, _m, s) => {
          if (beforeWrite) { const fn = beforeWrite; beforeWrite = null; fn(p); }
          const f = store.get(p);
          if ((f ? String(f.sha) : undefined) !== s) { const e = new Error("409"); e.status = 409; throw e; }
          store.set(p, { content: c, sha: (f ? f.sha : 0) + 1 }); writes++;
          return { commit: "c" + writes };
        },
      };
    },
  };
  return v;
}

test("merge: two appends from different writers both land, nothing lost", async () => {
  const v = fakeVault({ [leadgen.ACTIVITY_PATH]: act([line("2026-09-26 01:00", "L-a", "system", "Seed")]) });
  // A Director run appends its line between our read and our write.
  const io = v.io(() => v.external(leadgen.ACTIVITY_PATH, (t) => leadgen.applyAppendActivity(t, [E("L-b", "research", "Director checked filed accounts", "2026-09-26 10:14", "Director")]).text));
  const r = await leadgen.appendActivity(io, [E("L-a", "call", "Spoke to the owner")], "platform: activity L-a call");
  assert.equal(r.ok, true);
  const rows = leadgen.parseActivity(v.text(leadgen.ACTIVITY_PATH)).rows;
  assert.deepEqual(rows.map((a) => a.summary), ["Seed", "Director checked filed accounts", "Spoke to the owner"]);
  assert.equal(rows.filter((a) => a.summary === "Spoke to the owner").length, 1, "the retry wrote one line, not two");
});

test("append: a missing log is created on the first write", async () => {
  const v = fakeVault({});
  const r = await leadgen.appendActivity(v.io(), [E("L-a", "note", "First")], "m");
  assert.equal(r.ok, true);
  assert.equal(leadgen.parseActivity(v.text(leadgen.ACTIVITY_PATH)).rows.length, 1);
});

// ---------- a pipeline edit and its activity line ----------

test("status change: writes the pipeline row and exactly one activity line", async () => {
  const v = fakeVault({ [leadgen.PIPELINE_PATH]: pipe([A, B]), [leadgen.ACTIVITY_PATH]: act([line("2026-09-26 01:00", "L-a", "system", "Seed")]) });
  const r = await leadgen.writeWithActivity(v.io(), (t) => leadgen.applyStatus(t, "L-a", "sent", "2026-09-26"), "platform: lead L-a sent",
    (a) => [E("L-a", "status", `Status ${a.before.status} to sent`)], "platform: activity L-a status");
  assert.equal(r.ok, true);
  assert.equal(r.logged, 1);
  const lead = leadgen.parseLeads(v.text(leadgen.PIPELINE_PATH)).leads.find((l) => l.id === "L-a");
  assert.equal(lead.status, "sent");
  assert.equal(lead.lastTouch, "2026-09-26");
  const rows = leadgen.parseActivity(v.text(leadgen.ACTIVITY_PATH)).rows;
  assert.equal(rows.length, 2);
  assert.deepEqual({ ...rows[1], line: 0 }, { at: "2026-09-26 10:15", lead: "L-a", type: "status", summary: "Status drafted to sent", by: "Operator", line: 0 });
  assert.equal(v.writes, 2);
});

test("status change: no change, no line", async () => {
  const v = fakeVault({ [leadgen.PIPELINE_PATH]: pipe([A]), [leadgen.ACTIVITY_PATH]: act([]) });
  const lastTouched = pipe([A.replace("| drafted |  |", "| drafted | 2026-09-26 |")]);
  v.external(leadgen.PIPELINE_PATH, () => lastTouched);
  const r = await leadgen.writeWithActivity(v.io(), (t) => leadgen.applyStatus(t, "L-a", "drafted", "2026-09-26"), "m", () => [E("L-a", "status", "x")], "m");
  assert.equal(r.unchanged, true);
  assert.equal(leadgen.parseActivity(v.text(leadgen.ACTIVITY_PATH)).rows.length, 0);
});

test("fields: one save, the changed cells only, one line naming them", () => {
  const r = leadgen.applyFields(pipe([A, B]), "L-b", { contact: "Managing director", email: "director\u0040beta.example", nextStep: "Call the director", nextDate: "2026-10-01", segment: "Nurseries" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.changed, ["contact", "email", "next step", "next date"]);
  const b = leadgen.parseLeads(r.text).leads.find((l) => l.id === "L-b");
  assert.equal(b.contact, "Managing director");
  assert.equal(b.status, "researched", "status is not a field here");
  const after = { ...r.before, contact: b.contact, email: b.email, "next step": b.nextStep, "next date": b.nextDate };
  assert.equal(leadgen.describeEdit(r.before, after, r.changed), "Next step: Call the director by 2026-10-01; Changed contact and email");
  assert.equal(leadgen.applyFields(pipe([A]), "L-a", { score: "101" }).ok, false);
  assert.equal(leadgen.applyFields(pipe([A]), "L-a", { score: "high" }).ok, false);
  assert.equal(leadgen.applyFields(pipe([A]), "L-a", { nextDate: "1 Oct" }).ok, false);
  assert.equal(leadgen.applyFields(pipe([A]), "L-a", {}).ok, false);
  assert.equal(leadgen.applyFields(pipe([A]), "L-a", { company: "Renamed" }).ok, false, "company is not editable");
});

test("done: sets last touch, replaces the next step and date", () => {
  const r = leadgen.applyDone(pipe([A]), "L-a", "Chase on Thursday", "2026-10-01", "2026-09-26");
  assert.equal(r.ok, true);
  assert.equal(r.before["next step"], "Send email 1");
  const a = leadgen.parseLeads(r.text).leads[0];
  assert.deepEqual([a.lastTouch, a.nextStep, a.nextDate], ["2026-09-26", "Chase on Thursday", "2026-10-01"]);
});

test("bulk: one write for every ticked row, a change record per lead, missing rows reported", () => {
  const r = leadgen.applyBulk(pipe([A, B, C]), ["L-a", "L-b", "L-gone", "L-a"], "nextDate", "2026-10-05", "2026-09-26");
  assert.equal(r.ok, true);
  assert.deepEqual(r.changes.map((c) => c.id), ["L-a", "L-b"]);
  assert.deepEqual(r.missing, ["L-gone"]);
  const leads = leadgen.parseLeads(r.text).leads;
  assert.deepEqual(leads.map((l) => l.nextDate), ["2026-10-05", "2026-10-05", "2026-09-24"]);
  const s = leadgen.applyBulk(pipe([A, B]), ["L-a", "L-b"], "status", "drafted", "2026-09-26");
  assert.deepEqual(s.changes.map((c) => c.id), ["L-a", "L-b"], "L-a was already drafted, but its last touch moved");
  assert.deepEqual(s.changes[0].changed, ["last touch"]);
  assert.equal(leadgen.describeEdit(s.changes[0].before, { ...s.changes[0].before, status: "drafted", "last touch": "2026-09-26" }, s.changes[0].changed), "", "a touch alone writes no line");
  assert.equal(leadgen.applyBulk(pipe([A]), ["L-a"], "status", "opted out", "2026-09-26").ok, false, "opt-outs are one at a time");
  assert.equal(leadgen.applyBulk(pipe([A]), ["L-a"], "status", "nonsense", "2026-09-26").ok, false);
  assert.equal(leadgen.applyBulk(pipe([A]), [], "nextStep", "x", "2026-09-26").ok, false);
  assert.equal(leadgen.applyBulk(pipe([A]), ["L-a"], "delete", "x", "2026-09-26").ok, false);
});

// ---------- what the pages read ----------

test("timeline: newest first, by day, same-minute status and system lines grouped", () => {
  const days = leadgen.groupTimeline([
    { at: "2026-09-25 09:00", type: "draft", summary: "Email 1 drafted", by: "Cowork" },
    { at: "2026-09-26 10:15", type: "status", summary: "Status drafted to sent", by: "Operator" },
    { at: "2026-09-26 10:15", type: "system", summary: "Next step: Chase by 2026-09-29", by: "Operator" },
    { at: "2026-09-26 11:40", type: "call", summary: "Spoke to the owner", by: "Operator" },
  ]);
  assert.deepEqual(days.map((d) => d.day), ["2026-09-26", "2026-09-25"]);
  assert.equal(days[0].items.length, 2);
  assert.equal(days[0].items[0].summary, "Spoke to the owner");
  assert.equal(days[0].items[1].summary, "Status drafted to sent; Next step: Chase by 2026-09-29");
  assert.equal(days[0].items[1].count, 2);
  assert.equal(days[0].items[1].type, "status");
  assert.equal(days[0].items[1].time, "10:15");
  assert.deepEqual(leadgen.groupTimeline([]), []);
});

test("funnel: counts by stage match a hand count, conversion only from 10", () => {
  const mk = (status, n) => Array.from({ length: n }, () => ({ status }));
  const leads = [...mk("researched", 8), ...mk("drafted", 3), ...mk("sent", 2), ...mk("replied", 1), ...mk("disqualified", 5)];
  const f = leadgen.funnel(leads);
  assert.deepEqual(f.map((s) => s.stage), ["researched", "drafted", "sent", "replied", "call booked", "proposal", "won"]);
  assert.deepEqual(f.map((s) => s.count), [8, 3, 2, 1, 0, 0, 0]);
  assert.deepEqual(f.map((s) => s.reached), [14, 6, 3, 1, 0, 0, 0], "closed rows are left out");
  assert.equal(f[0].conversion, 43, "6 of 14 reached drafted");
  assert.equal(f[1].conversion, null, "6 is under 10, so no rate");
  assert.equal(f[6].conversion, null);
});

test("funnel: the live pipeline", { skip: !existsSync(livePipe) && "no vault clone at " + VAULT }, () => {
  const leads = leadgen.parseLeads(readFileSync(livePipe, "utf8")).leads;
  const f = leadgen.funnel(leads);
  const byHand = leadgen.STAGES.map((s) => leads.filter((l) => l.status === s).length);
  assert.deepEqual(f.map((s) => s.count), byHand);
  assert.equal(f.reduce((n, s) => n + s.count, 0), leads.filter((l) => !leadgen.CLOSED_STATUSES.includes(l.status)).length);
});

test("staleness: amber after 7 days, red after 14, never for closed or won", () => {
  assert.equal(leadgen.touchDays("", "2026-09-26"), null);
  assert.equal(leadgen.touchDays("2026-09-18", "2026-09-26"), 8);
  assert.equal(leadgen.staleLevel(7, "sent"), "");
  assert.equal(leadgen.staleLevel(8, "sent"), "amber");
  assert.equal(leadgen.staleLevel(14, "sent"), "amber");
  assert.equal(leadgen.staleLevel(15, "sent"), "red");
  assert.equal(leadgen.staleLevel(30, "lost"), "");
  assert.equal(leadgen.staleLevel(30, "won"), "");
  assert.equal(leadgen.staleLevel(null, "sent"), "");
});

test("sequence position: from email lines, then from the status", () => {
  const rows = [
    { at: "2026-09-28 09:00", type: "email", summary: "Email 1 sent from contact@" },
    { at: "2026-09-28 09:05", type: "note", summary: "Email 2 idea" },
  ];
  const p = leadgen.sequencePosition({ status: "sent" }, rows);
  assert.deepEqual([p.step, p.next, p.due], [1, 2, "2026-10-01"], "email 2 is day 4, three days after day 1");
  const p2 = leadgen.sequencePosition({ status: "sent" }, [...rows, { at: "2026-10-01 09:00", type: "email", summary: "email 2 sent" }]);
  assert.deepEqual([p2.step, p2.next, p2.due], [2, 3, "2026-10-07"]);
  const p3 = leadgen.sequencePosition({ status: "replied" }, [{ at: "2026-10-07 09:00", type: "email", summary: "Email 3 sent" }]);
  assert.equal(p3.next, 0);
  assert.match(leadgen.sequencePosition({ status: "drafted" }, []).words, /waiting to send/);
  assert.match(leadgen.sequencePosition({ status: "sent" }, []).words, /no email line/);
  assert.match(leadgen.sequencePosition({ status: "researched" }, []).words, /Not in the sequence/);
});

test("leadsState: activity joined to leads, the latest 20 for the feed, the funnel", () => {
  const acts = Array.from({ length: 25 }, (_, i) => line(`2026-09-26 ${String(9 + Math.floor(i / 6)).padStart(2, "0")}:${String((i % 6) * 10).padStart(2, "0")}`, i % 2 ? "L-a" : "L-c", "note", `Line ${i}`, "Director"));
  const texts = new Map([[leadgen.PIPELINE_PATH, pipe([A, B, C])], [leadgen.ACTIVITY_PATH, act(acts)]]);
  const s = leadgen.leadsState(texts, "2026-09-26");
  assert.equal(s.activity.exists, true);
  assert.equal(s.activity.total, 25);
  assert.equal(s.activity.latest.length, 20);
  assert.equal(s.activity.latest[0].summary, "Line 24", "newest first");
  assert.equal(s.activity.latest[0].company, "Gamma Dental");
  const a = s.leads.find((l) => l.id === "L-a"), c = s.leads.find((l) => l.id === "L-c");
  assert.equal(a.activityCount, 12);
  assert.equal(c.touchDays, 16);
  assert.equal(c.stale, "red");
  assert.equal(a.stale, "", "no last touch, no stale flag");
  assert.deepEqual(s.funnel.map((f) => f.count).slice(0, 3), [1, 1, 1]);
  const none = leadgen.leadsState(new Map([[leadgen.PIPELINE_PATH, pipe([A])]]), "2026-09-26");
  assert.equal(none.activity.exists, false);
  assert.deepEqual(none.leads[0].history, []);
});
