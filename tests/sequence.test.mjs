// Tests for Lead gen station v2, run 2 (netlify/functions/lib/leads.mts): the sequence page, the
// reports page, and the Reviewer's run 1 fixes (bulk status keeps an opted-out lead opted out;
// the home feed is newest first by its timestamps, not by file order).
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
const liveDrafts = join(VAULT, leadgen.OUTREACH_PATH);
const livePipe = join(VAULT, leadgen.PIPELINE_PATH);
const liveAct = join(VAULT, leadgen.ACTIVITY_PATH);

const HEAD = "| id | company | segment | tier | score | contact | email | status | last touch | next step | next date | source |\n|---|---|---|---|---|---|---|---|---|---|---|---|";
const pipe = (rows) => `---\ntitle: Owlbridge pipeline\n---\n\n# Owlbridge pipeline\n\n## Leads\n\n${HEAD}\n${rows.join("\n")}\n`;
const row = (id, status, tier = "A", segment = "Pubs", source = "batch 1") => `| ${id} | Co ${id} | ${segment} | ${tier} | 80 | Someone |  | ${status} |  | Next | 2026-09-30 | ${source} |`;
const ACT_HEAD = "| at | lead | type | summary | by |\n|---|---|---|---|---|";
const act = (rows) => `# Owlbridge activity log\n\n## Activity\n\n${ACT_HEAD}\n${rows.join("\n")}\n`;
const line = (at, lead, type, summary, by = "Operator") => `| ${at} | ${lead} | ${type} | ${summary} | ${by} |`;

const DRAFTS = `---
title: Owlbridge outreach drafts
---

# Owlbridge outreach drafts

Intro.

## Email 1, day 1 (about 80 words)

**Subject:** {{company}}, one view of every site

Hi {{first_name}},

{{personal_line}}

As a group adds sites, the numbers split.

The operator

## Email 2, day 4 (in the same thread)

Hi {{first_name}},

A quick example of what it answers.

The operator

## Email 3, day 10 (in the same thread)

Hi {{first_name}},

I'll leave it here.

The operator

## Footer on every email

Not a step.
`;

// ---------- Reviewer fixes from run 1 ----------

test("bulk status: an opted-out lead stays opted out and is named, the others move", () => {
  const text = pipe([row("L-a", "drafted"), row("L-o", "opted out"), row("L-c", "researched")]);
  const r = leadgen.applyBulk(text, ["L-a", "L-o", "L-c"], "status", "sent", "2026-09-27");
  assert.equal(r.ok, true);
  assert.deepEqual(r.changes.map((c) => c.id), ["L-a", "L-c"]);
  assert.deepEqual(r.kept, ["L-o"]);
  const after = Object.fromEntries(leadgen.parseLeads(r.text).leads.map((l) => [l.id, l.status]));
  assert.deepEqual(after, { "L-a": "sent", "L-o": "opted out", "L-c": "sent" });
  const only = leadgen.applyBulk(pipe([row("L-o", "opted out")]), ["L-o"], "status", "researched", "2026-09-27");
  assert.equal(only.ok, true);
  assert.equal(only.unchanged, true, "nothing to write when every ticked lead is opted out");
  assert.deepEqual(only.kept, ["L-o"]);
  // the next date and next step are still editable in bulk on an opted-out row
  const d = leadgen.applyBulk(pipe([row("L-o", "opted out")]), ["L-o"], "nextStep", "Leave alone", "2026-09-27");
  assert.deepEqual(d.changes.map((c) => c.id), ["L-o"]);
  assert.deepEqual(d.kept, []);
});

test("home feed: newest first by timestamp, whatever order the lines sit in the file", () => {
  const acts = [
    line("2026-09-26 09:00", "L-a", "note", "Morning"),
    line("2026-09-27 08:00", "L-a", "note", "Next day"),
    line("2026-09-26 18:00", "L-a", "note", "Evening, appended late by a run"),
    line("2026-09-27 08:00", "L-a", "call", "Same minute, later in the file"),
  ];
  const s = leadgen.leadsState(new Map([[leadgen.PIPELINE_PATH, pipe([row("L-a", "drafted")])], [leadgen.ACTIVITY_PATH, act(acts)]]), "2026-09-27");
  assert.deepEqual(s.activity.latest.map((a) => a.summary), ["Same minute, later in the file", "Next day", "Evening, appended late by a run", "Morning"]);
  const many = Array.from({ length: 30 }, (_, i) => line(`2026-09-${String(30 - i).padStart(2, "0")} 10:00`, "L-a", "note", `Day ${30 - i}`));
  const m = leadgen.leadsState(new Map([[leadgen.PIPELINE_PATH, pipe([row("L-a", "drafted")])], [leadgen.ACTIVITY_PATH, act(many)]]), "2026-09-30");
  assert.equal(m.activity.latest.length, 20);
  assert.equal(m.activity.latest[0].summary, "Day 30", "the newest line, even though it is first in the file");
  assert.equal(m.activity.latest[19].summary, "Day 11");
});

// ---------- the sequence ----------

test("drafts parser: three steps with day, subject, a meaningful excerpt and the words", () => {
  const d = leadgen.parseDrafts(DRAFTS);
  assert.equal(d.found, true);
  assert.deepEqual(d.steps.map((s) => [s.step, s.day]), [[1, 1], [2, 4], [3, 10]]);
  assert.equal(d.steps[0].subject, "{{company}}, one view of every site");
  assert.equal(d.steps[0].excerpt, "As a group adds sites, the numbers split.", "not the greeting, not the placeholder line");
  assert.equal(d.steps[1].subject, "");
  assert.equal(d.steps[2].excerpt, "I'll leave it here.");
  assert.ok(!d.steps[0].words.includes("**Subject:**"), "the subject is lifted out of the words");
  assert.ok(!d.steps[2].words.includes("Not a step"), "the footer heading ends the last step");
  assert.deepEqual(leadgen.parseDrafts("").steps, []);
  assert.equal(leadgen.parseDrafts("# Nothing here\n").found, false);
});

test("sequence: per-step sent, replied and opted out counts, waiting leads and wait chips", () => {
  const leads = leadgen.parseLeads(pipe([
    row("L-d1", "drafted"), row("L-d2", "drafted"),
    row("L-s1", "sent"),        // email 1 sent, waiting on email 2
    row("L-s2", "sent"),        // emails 1 and 2 sent, waiting on email 3
    row("L-r1", "replied"),     // replied after email 1
    row("L-r2", "call booked"), // replied after email 2
    row("L-o2", "opted out"),   // opted out after email 2
    row("L-s3", "sent"),        // all three sent, the sequence is complete
    row("L-nl", "sent"),        // at sent with no email line
    row("L-re", "researched"),
  ])).leads;
  const rows = leadgen.parseActivity(act([
    line("2026-09-20 09:00", "L-s1", "email", "Email 1 sent"),
    line("2026-09-18 09:00", "L-s2", "email", "Email 1 sent"),
    line("2026-09-21 09:00", "L-s2", "email", "Email 2 sent in the same thread"),
    line("2026-09-19 09:00", "L-r1", "email", "Email 1 sent"),
    line("2026-09-15 09:00", "L-r2", "email", "Email 1 sent"),
    line("2026-09-18 09:00", "L-r2", "email", "email 2 sent"),
    line("2026-09-15 09:00", "L-o2", "email", "Email 1 sent"),
    line("2026-09-18 09:00", "L-o2", "email", "Email 2 sent"),
    line("2026-09-10 09:00", "L-s3", "email", "Email 1 sent"),
    line("2026-09-13 09:00", "L-s3", "email", "Email 2 sent"),
    line("2026-09-19 09:00", "L-s3", "email", "Email 3 sent"),
    line("2026-09-19 09:00", "L-d1", "note", "Email 1 looks good"), // a note, not an email line
  ])).rows;
  const v = leadgen.sequenceView(leads, rows, DRAFTS);
  const [e1, e2, e3] = v.steps;
  assert.deepEqual([e1.waitDays, e2.waitDays, e3.waitDays], [0, 3, 6]);
  assert.deepEqual(e1.sent.sort(), ["L-o2", "L-r1", "L-r2", "L-s1", "L-s2", "L-s3"]);
  assert.deepEqual(e2.sent.sort(), ["L-o2", "L-r2", "L-s2", "L-s3"]);
  assert.deepEqual(e3.sent, ["L-s3"]);
  assert.deepEqual(e1.replied, ["L-r1"]);
  assert.deepEqual(e2.replied, ["L-r2"]);
  assert.deepEqual(e3.replied, []);
  assert.deepEqual([e1.optedOut, e2.optedOut, e3.optedOut], [[], ["L-o2"], []]);
  assert.deepEqual(e1.waiting.map((w) => w.id), ["L-d1", "L-d2"]);
  assert.deepEqual(e2.waiting, [{ id: "L-s1", company: "Co L-s1", due: "2026-09-23" }]);
  assert.deepEqual(e3.waiting, [{ id: "L-s2", company: "Co L-s2", due: "2026-09-27" }]);
  assert.deepEqual(v.unlogged, ["L-nl"]);
  assert.equal(v.found, true);
});

test("sequence: no drafts note still counts from the log, with the default days", () => {
  const leads = leadgen.parseLeads(pipe([row("L-s1", "sent")])).leads;
  const rows = leadgen.parseActivity(act([line("2026-09-20 09:00", "L-s1", "email", "Email 1 sent")])).rows;
  const v = leadgen.sequenceView(leads, rows, undefined);
  assert.equal(v.found, false);
  assert.deepEqual(v.steps.map((s) => s.day), [1, 4, 10]);
  assert.deepEqual(v.steps[0].sent, ["L-s1"]);
  assert.equal(v.steps[1].waiting[0].due, "2026-09-23");
});

test("sequence: the live drafts note has the three emails at days 1, 4 and 10", { skip: !existsSync(liveDrafts) && "no vault clone at " + VAULT }, () => {
  const d = leadgen.parseDrafts(readFileSync(liveDrafts, "utf8"));
  assert.deepEqual(d.steps.map((s) => [s.step, s.day]), [[1, 1], [2, 4], [3, 10]]);
  assert.ok(d.steps[0].subject.length > 0);
  for (const s of d.steps) assert.ok(s.excerpt.length > 0, `email ${s.step} has an excerpt`);
});

// ---------- reports ----------

// A fixture counted by hand:
//   L-1 researched A Pubs batch 1   L-2 drafted A Pubs batch 1     L-3 sent B Dental batch 1
//   L-4 replied B Dental seed list  L-5 won A Pubs seed list        L-6 lost C Vets batch 1
//   L-7 opted out B Pubs batch 1    L-8 proposal (blank tier) Vets seed list
const FIX = [
  row("L-1", "researched", "A", "Pubs", "batch 1"), row("L-2", "drafted", "A", "Pubs", "batch 1"),
  row("L-3", "sent", "B", "Dental", "batch 1"), row("L-4", "replied", "B", "Dental", "seed list"),
  row("L-5", "won", "A", "Pubs", "seed list"), row("L-6", "lost", "C", "Vets", "batch 1"),
  row("L-7", "opted out", "B", "Pubs", "batch 1"), row("L-8", "proposal", "", "Vets", "seed list"),
];

test("reports: counts by stage, tier, segment and source match a hand count, with the ids", () => {
  const leads = leadgen.parseLeads(pipe(FIX)).leads;
  const r = leadgen.reportsView(leads, [], "2026-09-27");
  assert.equal(r.total, 8);
  const byStage = Object.fromEntries(r.byStage.map((g) => [g.key, g.count]));
  assert.deepEqual(byStage, { researched: 1, drafted: 1, sent: 1, replied: 1, "call booked": 0, proposal: 1, won: 1, lost: 1, "opted out": 1, disqualified: 0 });
  assert.deepEqual(r.byStage.find((g) => g.key === "won").ids, ["L-5"]);
  assert.deepEqual(r.byTier.map((g) => [g.key, g.count]), [["A", 3], ["B", 3], ["(blank)", 1], ["C", 1]]);
  assert.deepEqual(r.bySegment.map((g) => [g.key, g.count]), [["Pubs", 4], ["Dental", 2], ["Vets", 2]]);
  assert.deepEqual(r.bySource.map((g) => [g.key, g.count]), [["batch 1", 5], ["seed list", 3]]);
  assert.deepEqual(r.bySegment[0].ids, ["L-1", "L-2", "L-5", "L-7"]);
  // every lead is counted exactly once in each breakdown
  for (const k of ["byStage", "byTier", "bySegment", "bySource"]) assert.equal(r[k].reduce((n, g) => n + g.count, 0), 8, k);
});

test("reports: reply rate only once 10 are sent, and from the same definition as the strip", () => {
  const few = leadgen.reportsView(leadgen.parseLeads(pipe(FIX)).leads, [], "2026-09-27");
  assert.deepEqual(few.replyRate.sent.sort(), ["L-3", "L-4", "L-5", "L-8"], "sent or further; lost and opted out left out");
  assert.deepEqual(few.replyRate.replied.sort(), ["L-4", "L-5", "L-8"]);
  assert.equal(few.replyRate.rate, null, "4 sent is under 10");
  const ten = Array.from({ length: 10 }, (_, i) => row(`L-x${i}`, i < 3 ? "replied" : "sent"));
  const r = leadgen.reportsView(leadgen.parseLeads(pipe(ten)).leads, [], "2026-09-27");
  assert.equal(r.replyRate.sent.length, 10);
  assert.equal(r.replyRate.rate, 30);
});

test("reports: median days from sent to reply only once 5 have both dates", () => {
  const ids = ["L-m1", "L-m2", "L-m3", "L-m4", "L-m5"];
  const gaps = [2, 5, 3, 9, 4]; // median 4
  const lines = [];
  ids.forEach((id, i) => {
    lines.push(line("2026-09-01 09:00", id, i % 2 ? "status" : "email", i % 2 ? "Status drafted to sent" : "Email 1 sent"));
    lines.push(line(`2026-09-${String(1 + gaps[i]).padStart(2, "0")} 10:00`, id, "status", "Status sent to replied"));
  });
  // a sixth lead replied with no sent line: not in the median
  lines.push(line("2026-09-03 10:00", "L-m6", "status", "Status drafted to replied"));
  const leads = leadgen.parseLeads(pipe([...ids, "L-m6"].map((id) => row(id, "replied")))).leads;
  const rows = leadgen.parseActivity(act(lines)).rows;
  const r = leadgen.reportsView(leads, rows, "2026-09-27");
  assert.deepEqual(r.medianReply.ids.sort(), ids);
  assert.equal(r.medianReply.days, 4);
  const four = leadgen.reportsView(leads, leadgen.parseActivity(act(lines.slice(2))).rows, "2026-09-27");
  assert.equal(four.medianReply.ids.length, 4);
  assert.equal(four.medianReply.days, null, "4 is under 5");
  assert.equal(leadgen.median([1, 2, 3, 4]), 2.5);
  assert.equal(leadgen.median([]), null);
});

test("reports: leads touched per week, Monday to Sunday, system lines not counted", () => {
  const leads = leadgen.parseLeads(pipe([row("L-1", "sent"), row("L-2", "sent"), row("L-3", "drafted")])).leads;
  const rows = leadgen.parseActivity(act([
    line("2026-09-21 09:00", "L-1", "call", "Rang"),          // Monday of this week
    line("2026-09-27 21:00", "L-1", "note", "Again"),         // Sunday of this week, same lead
    line("2026-09-27 09:00", "L-2", "status", "Status drafted to sent"),
    line("2026-09-20 23:59", "L-3", "email", "Email 1 sent"), // Sunday of last week
    line("2026-09-22 09:00", "L-3", "system", "Next step: chase"),
    line("2026-09-22 09:00", "L-gone", "call", "Not in the pipeline"),
  ])).rows;
  const r = leadgen.reportsView(leads, rows, "2026-09-27");
  assert.equal(r.touched.length, 8);
  const last = r.touched[7], prev = r.touched[6];
  assert.equal(last.week, "2026-09-21");
  assert.deepEqual(last.ids.sort(), ["L-1", "L-2"]);
  assert.equal(last.count, 2);
  assert.equal(prev.week, "2026-09-14");
  assert.deepEqual(prev.ids, ["L-3"]);
  assert.equal(r.touched[0].week, "2026-08-03");
});

test("reports and sequence: the live pipeline and log", { skip: !(existsSync(livePipe) && existsSync(liveAct)) && "no vault clone at " + VAULT }, () => {
  const texts = new Map([[leadgen.PIPELINE_PATH, readFileSync(livePipe, "utf8")], [leadgen.ACTIVITY_PATH, readFileSync(liveAct, "utf8")]]);
  if (existsSync(liveDrafts)) texts.set(leadgen.OUTREACH_PATH, readFileSync(liveDrafts, "utf8"));
  const s = leadgen.leadsState(texts, "2026-09-27");
  const total = s.leads.length;
  assert.equal(s.reports.total, total);
  for (const k of ["byStage", "byTier", "bySegment", "bySource"]) assert.equal(s.reports[k].reduce((n, g) => n + g.count, 0), total, k);
  assert.equal(s.sequence.steps.length, 3);
  // every waiting lead on email 1 is at drafted with no email line
  for (const w of s.sequence.steps[0].waiting) assert.equal(s.leads.find((l) => l.id === w.id).status, "drafted");
});
