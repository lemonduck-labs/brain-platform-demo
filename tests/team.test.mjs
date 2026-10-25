// Tests for the Team area's derivations (netlify/functions/lib/team.mts) and the Approvals
// Queue parser (10, 11 and 12 cell rows). Run with: npm test
//
// Mocked vault text covers four departments and every state the spec lists: a live claim, a
// stale claim, each block type, an empty department, an archive-only week, and a vault with no
// DIRECTOR lines yet. The live-vault test reads a local clone (VAULT_DIR, default ../vault)
// and is skipped without one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as team from "../netlify/functions/lib/team.mts";

const here = dirname(fileURLToPath(import.meta.url));
const VAULT = process.env.VAULT_DIR || join(here, "..", "..", "vault");

// ---------- fixtures ----------

const DEPARTMENTS = `# Departments

| id | name | colour | covers | repositories |
|---|---|---|---|---|
| owlbridge | Owlbridge | #49E2EA | The consultancy | brain-vault |
| fernmoor | Fernmoor | #F59E0B | Warmstead, Ridgeby | brain-vault |
| brain | The Brain | #A78BFA | The platform | brain-vault |
| ventures | Ventures | #34D399 | Gaugewell, Paperwren | brain-vault |

## Rules the platform reads

| rule | threshold |
|---|---|
| access-bound | access blocks are more than half of a department's open rows |
| short of runs | average open-row age above 3 days and runs used at the daily budget on 3 of the last 5 weekdays |
| brief quality | Redo rate above 1 in 4 over 14 days, per specialist |
| near the cap | routine runs above 13 a day on 3 of the last 5 weekdays |
`;
const TOOLS = "Routines draw on plan usage, and Max allows up to 15 routine runs a day (Pro 5).";
const HEAD = "| id | status | title | detail | cost | reversible | source | requested | decided | note |\n|---|---|---|---|---|---|---|---|---|---|";
const approvals = (rows) => `# Approvals\n\nRules.\n\n## Queue\n\n${HEAD}\n${rows.join("\n")}\n\n## Notes\n\n| id | status | task | note | file | line | added | done | outcome |\n|---|---|---|---|---|---|---|---|---|\n`;
const runLog = (rows) => `# Run log\n\n## Latest\n\n| When | Job | Surface | Result | Note |\n|---|---|---|---|---|\n${rows.join("\n")}\n\n## Expected schedule\n\n| Job | Expected | Status |\n|---|---|---|\n| MORNING | 07:00 | x |\n`;
const ledger = (rows) => `# Watcher lock\n\n| utc | key | run | action |\n|---|---|---|---|\n${rows.join("\n")}\n`;
const AGENTS = [
  { name: "Director", role: "Director", colour: "#F8FAFC", model: "Opus 5.5", path: "System/Agents/Director.md", jobs: ["MANAGE", "APPROVALS WATCHER"] },
  { name: "Researcher", role: "Researcher", colour: "#60A5FA", model: "Opus 5.5", path: "System/Agents/Researcher.md", jobs: ["SCOUT"] },
  { name: "Editor", role: "Copywriter", colour: "#F472B6", model: "Opus 5.5", path: "System/Agents/Editor.md", jobs: [] },
  { name: "Reviewer", role: "Reviewer", colour: "#94A3B8", model: "Opus 5.5", path: "System/Agents/Reviewer.md", jobs: [] },
];

// Friday 25 Sep 2026, 14:30 London (13:30 UTC in BST)
const TODAY = { ymd: "2026-09-25", hm: "14:30" };
const NOW = Date.parse("2026-09-25T13:30:00Z");

const ROWS = [
  // owlbridge: two open, one live-claimed, blocks on Mac and Companies House credentials
  "| a-2026-09-20-owlbridge-station | in progress | Lead gen station | d |  | yes | chat | 2026-09-20 | | Est: 2 hours; Needs: Mac session | P1 | owlbridge |",
  "| a-2026-09-22-owlbridge-copy | in progress | Owlbridge copy | d |  | yes | chat | 2026-09-22 09:00 | | Est: 1 hour; Needs: the contractor's credentials |  | owlbridge |",
  "| a-2026-09-23-owlbridge-done | done | Owlbridge done row | d |  | yes | chat | 2026-09-23 10:00 | 2026-09-24 10:00 | Est: 2 hours; 24 Sep, DIRECTOR: finished |  | owlbridge |",
  // fernmoor: pending (decision), Cowork block, repo block, other block
  "| a-2026-09-21-bm-pending | pending | BM decision | d |  | yes | chat | 2026-09-21 | | Waiting on their yes |  | fernmoor |",
  "| a-2026-09-21-bm-cowork | in progress | BM cowork | d |  | yes | chat | 2026-09-21 | | Est: 1 hour; Needs: Cowork session |  | fernmoor |",
  "| a-2026-09-21-bm-repo | in progress | BM repo | d |  | yes | chat | 2026-09-21 | | Est: 30 minutes; Needs: repo access to ridgeby-theme |  | fernmoor |",
  "| a-2026-09-21-bm-other | in progress | BM other | d |  | yes | chat | 2026-09-21 | | Est: next run; Needs: a reply from the printer |  | fernmoor |",
  // brain: done this week, with a redo this week
  "| a-2026-09-22-brain-redo | done | Brain redo | d |  | yes | chat | 2026-09-22 09:00 | 2026-09-25 11:00 | Est: 1 hour; 23 Sep 10:00: Redo requested. Fix the header |  | brain |",
  // ventures: nothing (empty department)
  // unassigned: an older 10-cell row and an 11-cell row
  "| a-2026-09-24-plain | requested | Ten cell row | d |  |  | Platform, the operator | 2026-09-24 08:00 |  |  |",
  "| a-2026-09-24-ranked | approved | Eleven cell row | d |  |  | chat | 2026-09-24 | 2026-09-24 |  | P2 |",
];
const ARCHIVE = `# Approvals archive\n\n${HEAD}\n| a-2026-09-10-archived | done | Archived last week | d |  | yes | chat | 2026-09-10 | 2026-09-12 | done |\n| a-2026-09-21-archive-week | done | Archived this week | d |  | yes | chat | 2026-09-21 09:00 | 2026-09-22 09:00 | Est: 4 hours; done |  | ventures |\n`;

const DIRECTOR_RUNS = [
  "| 2026-09-25 12:10 | DIRECTOR | Cloud | OK | [dept=owlbridge,brain; agents=Researcher,Copywriter/Reviewer; rows=a-2026-09-23-owlbridge-done,a-2026-09-22-brain-redo; done=2; moved=0; blocked=0] Two rows done. |",
  "| 2026-09-24 09:05 | DIRECTOR | Cloud | FAIL | [dept=fernmoor; agents=Researcher; rows=a-2026-09-21-bm-pending; done=0; moved=0; blocked=1] Passed to the operator. |",
];
const OTHER_RUNS = [
  "| 2026-09-25 07:06 | MORNING | Cloud | OK | Plan written |",
  "| 2026-09-25 01:20 | APPROVALS WATCHER | Cloud | OK | Old style line without a tag |",
  "| 2026-09-24 18:48 | EVENING | Cloud | OK | Review |",
  "| 2026-09-22 14:25 | A Cowork session | Cowork, from chat | OK | not a routine run |",
];
const LEDGER = [
  "| 2026-09-25T12:50:00Z | a-2026-09-20-owlbridge-station | owlbridge-20260925-1350-Researcher | claim |",   // live, 40 min
  "| 2026-09-25T09:00:00Z | a-2026-09-22-owlbridge-copy | owlbridge-20260925-1000 | claim |",               // stale, no release
  "| 2026-09-25T08:00:00Z | a-2026-09-21-bm-cowork | fernmoor-20260925-0900 | claim |",
  "| 2026-09-25T08:30:00Z | a-2026-09-21-bm-cowork | fernmoor-20260925-0900 | release |",      // released
  "| 2026-09-25T13:00:00Z | watcher | brain-20260925-1400 | claim |",                              // run lock, not a row
];

const input = (over = {}) => ({
  approvalsMd: approvals(ROWS), archiveApprovals: [ARCHIVE],
  runLogMd: runLog(DIRECTOR_RUNS.concat(OTHER_RUNS)), archiveRunLogs: [],
  ledgerMd: ledger(LEDGER), departmentsMd: DEPARTMENTS, toolsMd: TOOLS,
  agents: AGENTS, today: TODAY, nowUtc: NOW, ...over,
});

// ---------- the Queue parser ----------

test("queue parser: 10, 11 and 12 cell rows", () => {
  const rows = team.rowsIn(approvals(ROWS));
  const ten = rows.find((r) => r.id === "a-2026-09-24-plain");
  assert.equal(ten.status, "requested");
  assert.equal(ten.note, "");
  assert.equal(ten.priority, "");
  assert.equal(ten.department, "");
  const eleven = rows.find((r) => r.id === "a-2026-09-24-ranked");
  assert.equal(eleven.priority, "P2");
  assert.equal(eleven.department, "");
  const twelve = rows.find((r) => r.id === "a-2026-09-20-owlbridge-station");
  assert.equal(twelve.priority, "P1");
  assert.equal(twelve.department, "owlbridge");
  assert.equal(twelve.note, "Est: 2 hours; Needs: Mac session");
  const blankPriority = rows.find((r) => r.id === "a-2026-09-22-owlbridge-copy");
  assert.equal(blankPriority.priority, "");
  assert.equal(blankPriority.department, "owlbridge", "a blank 11th cell does not shift the 12th");
});

test("queue parser: queueRow on raw cells, department lower-cased", () => {
  const r = team.queueRow(["a-x", "done", "T", "D", "", "yes", "chat", "2026-09-01", "2026-09-02", "note", "", "Owlbridge"]);
  assert.equal(r.department, "owlbridge");
  assert.equal(team.queueRow(["a-y", "pending"]).note, "");
});

test("queue parser: the live Approvals file parses every row", { skip: !existsSync(join(VAULT, "System/Approvals.md")) && "no vault clone" }, () => {
  const md = readFileSync(join(VAULT, "System/Approvals.md"), "utf8");
  const queue = md.split("## Queue")[1].split("\n## ")[0];
  const rows = team.rowsIn(queue);
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.match(r.id, /^a-\d{4}-\d{2}-\d{2}-/);
    assert.ok(["requested", "pending", "approved", "in progress", "done", "declined"].includes(r.status.toLowerCase()), `${r.id} status ${r.status}`);
    assert.ok(r.department === "" || ["owlbridge", "fernmoor", "brain", "ventures"].includes(r.department), `${r.id} department`);
  }
});

// ---------- registry, ledger, tags ----------

test("departments: the registry and its rules", () => {
  const p = team.parseDepartments(DEPARTMENTS);
  assert.deepEqual(p.departments.map((d) => d.id), ["owlbridge", "fernmoor", "brain", "ventures"]);
  assert.equal(p.departments[0].colour, "#49E2EA");
  assert.equal(p.rules.accessBound.share, 0.5);
  assert.deepEqual([p.rules.shortOfRuns.ageDays, p.rules.shortOfRuns.days, p.rules.shortOfRuns.of], [3, 3, 5]);
  assert.equal(p.rules.briefQuality.rate, 0.25);
  assert.equal(p.rules.briefQuality.windowDays, 14);
  assert.deepEqual([p.rules.nearCap.runs, p.rules.nearCap.days, p.rules.nearCap.of], [13, 3, 5]);
  assert.equal(team.parseCap(TOOLS), 15);
  assert.equal(team.parseCap("nothing here"), null);
});

test("departments: the live registry parses", { skip: !existsSync(join(VAULT, "System/Departments.md")) && "no vault clone" }, () => {
  const p = team.parseDepartments(readFileSync(join(VAULT, "System/Departments.md"), "utf8"));
  assert.equal(p.departments.length, 4);
  for (const k of ["accessBound", "shortOfRuns", "briefQuality", "nearCap"]) assert.ok(p.rules[k], k);
  const tools = join(VAULT, "System/Tools.md");
  if (existsSync(tools)) assert.equal(team.parseCap(readFileSync(tools, "utf8")), 15);
});

test("ledger: live claim, stale claim, released claim, run lock", () => {
  const claims = team.claimsFrom(team.parseLedger(ledger(LEDGER)), NOW);
  const live = claims.find((c) => c.key === "a-2026-09-20-owlbridge-station");
  assert.equal(live.live, true); assert.equal(live.stale, false);
  assert.equal(live.ageMin, 40); assert.equal(live.dept, "owlbridge"); assert.equal(live.agent, "Researcher");
  const stale = claims.find((c) => c.key === "a-2026-09-22-owlbridge-copy");
  assert.equal(stale.live, false); assert.equal(stale.stale, true); assert.equal(stale.agent, "");
  const released = claims.find((c) => c.key === "a-2026-09-21-bm-cowork");
  assert.equal(released.live, false); assert.equal(released.stale, false); assert.equal(released.released, true);
  const lock = claims.find((c) => c.key === "watcher");
  assert.equal(lock.isRow, false);
});

test("tag: DIRECTOR tag parsing, grouped and flat agents", () => {
  const t = team.parseTag("[dept=owlbridge,brain; agents=Researcher,Copywriter/Reviewer; rows=a-1,a-2; done=2; moved=0; blocked=0] words");
  assert.deepEqual(t.dept, ["owlbridge", "brain"]);
  assert.deepEqual(t.agents, ["Researcher", "Copywriter", "Reviewer"]);
  assert.deepEqual(t.agentsByRow["a-1"], ["Researcher", "Copywriter"]);
  assert.deepEqual(t.agentsByRow["a-2"], ["Reviewer"]);
  assert.equal(t.done, 2); assert.equal(t.blocked, 0);
  const flat = team.parseTag("[dept=owlbridge; agents=Scout,Qualifier; rows=a-1,a-2; done=1]");
  assert.deepEqual(flat.agentsByRow["a-2"], ["Scout", "Qualifier"]);
  assert.equal(flat.moved, null, "a missing count is null, not zero");
  assert.equal(team.parseTag("Nothing waiting."), null);
});

test("notes: Est, Needs and block types", () => {
  assert.equal(team.estimateMinutes("Est: 40 minutes; left"), 40);
  assert.equal(team.estimateMinutes("Est: 2 to 3 hours; x"), 150);
  assert.equal(team.estimateMinutes("Est: half a day"), 720);
  assert.equal(team.estimateMinutes("Est: next run; x"), null);
  const b = (status, note) => team.blockOf(team.queueRow(["a-x", status, "", "", "", "", "", "2026-09-01", "", note]));
  assert.equal(b("pending", "").type, "decision");
  assert.equal(b("in progress", "Est: 1 hour; Needs: Mac session").type, "mac");
  assert.equal(b("in progress", "Est: 1 hour; Needs: Cowork session, since the cloud cannot reach ridgeby-theme").type, "cowork");
  assert.equal(b("in progress", "Needs: repo access to ridgeby-theme").type, "repo");
  assert.equal(b("in progress", "Needs: the contractor's credentials").type, "credentials");
  assert.equal(b("in progress", "Needs: a reply from the printer").type, "other");
  assert.equal(b("in progress", "Est: 1 hour"), null);
  assert.equal(b("done", "Needs: Mac session"), null, "a settled row is not blocked");
  assert.equal(b("in progress", "Needs: Mac session; later: Needs: Cowork session").type, "cowork", "the latest label wins");
  assert.deepEqual(team.redoDates("x; 23 Sep 10:00: Redo requested. Fix it; 1 Oct 09:15: Redo requested. Again", "2026"), ["2026-09-23", "2026-10-01"]);
});

// ---------- the model ----------

test("team: lanes, live and stale claims, blocks by type, empty department", () => {
  const t = team.buildTeam(input());
  const lane = (id) => t.lanes.find((l) => l.id === id);
  assert.deepEqual(t.lanes.map((l) => l.id), ["owlbridge", "fernmoor", "brain", "ventures", "unassigned"]);

  const owlbridge = lane("owlbridge");
  assert.equal(owlbridge.live.length, 1);
  assert.equal(owlbridge.live[0].title, "Lead gen station");
  assert.equal(owlbridge.stale.length, 1);
  assert.equal(owlbridge.open.length, 2);
  assert.equal(owlbridge.oldest.id, "a-2026-09-20-owlbridge-station");
  assert.equal(owlbridge.blocks.mac.length, 1);
  assert.equal(owlbridge.blocks.credentials.length, 1);
  assert.equal(owlbridge.doneWeek.length, 1);

  const bm = lane("fernmoor");
  assert.equal(bm.blocks.decision.length, 1);
  assert.equal(bm.blocks.cowork.length, 1);
  assert.equal(bm.blocks.repo.length, 1);
  assert.equal(bm.blocks.other.length, 1);
  assert.equal(bm.live.length, 0, "a released claim is not live");
  assert.equal(bm.statusCounts.pending, 1);
  assert.equal(bm.statusCounts["in progress"], 3);

  const v = lane("ventures");
  assert.equal(v.open.length, 0);
  assert.equal(v.oldest, null);
  assert.equal(v.doneWeek.length, 1, "an archive-only row still counts this week");

  const un = lane("unassigned");
  assert.equal(un.open.length, 2, "10 and 11 cell rows land in Unassigned");
});

test("team: top strip, all and filtered", () => {
  const t = team.buildTeam(input());
  const s = t.views.all.strip;
  assert.equal(s.working.value, 1, "one live row claim; the watcher run lock is not a row");
  assert.equal(s.waiting.value, 8);
  assert.equal(s.runsToday.value, 3, "cloud lines today, the Cowork line is not a routine run");
  assert.equal(s.runsToday.cap, 15);
  assert.equal(s.doneWeek.value, 3, "owlbridge, brain and the archived ventures row");
  assert.equal(t.views.owlbridge.strip.waiting.value, 2);
  assert.equal(t.views.ventures.strip.working.value, 0);
  assert.equal(t.views.owlbridge.strip.runsToday.deptValue, 1);
});

test("team: Director panel, roster, throughput, usage", () => {
  const t = team.buildTeam(input());
  const d = t.views.all.director;
  assert.equal(d.last.when, "2026-09-25 12:10");
  assert.deepEqual(d.tree.map((r) => r.id), ["a-2026-09-23-owlbridge-done", "a-2026-09-22-brain-redo"]);
  assert.deepEqual(d.tree[0].agents, ["Researcher", "Copywriter"]);
  assert.equal(d.back, null, "nothing in the tag says what went back");
  assert.equal(t.views.fernmoor.director.passed[0].id, "a-2026-09-21-bm-pending");

  const researcher = t.views.all.roster.find((r) => r.role === "Researcher");
  assert.equal(researcher.weekRuns, 2);
  assert.equal(researcher.live, true);
  assert.equal(researcher.now[0].id, "a-2026-09-20-owlbridge-station");
  const copy = t.views.all.roster.find((r) => r.role === "Copywriter");
  assert.deepEqual(copy.rowsTouched.map((r) => r.id), ["a-2026-09-23-owlbridge-done"]);
  const director = t.views.all.roster.find((r) => r.role === "Director");
  assert.equal(director.lastRun.job, "APPROVALS WATCHER", "from its jobs frontmatter");

  const brain = t.views.all.throughput.byDept.find((x) => x.dept === "brain");
  assert.equal(brain.done, 1); assert.equal(brain.redos, 1); assert.equal(brain.redoRate, 100);
  const owlbridge = t.views.all.throughput.byDept.find((x) => x.dept === "owlbridge");
  assert.equal(owlbridge.estRatio, 12, "24 hours taken against a 2 hour estimate");
  const bm = t.views.all.throughput.byDept.find((x) => x.dept === "fernmoor");
  assert.equal(bm.failed, 1);
  const ventures = t.views.all.throughput.byDept.find((x) => x.dept === "ventures");
  assert.equal(ventures.redoRate, 100 * 0, "a done row with no redo is a zero rate, it has a source");

  const days = t.views.all.usage.days;
  assert.equal(days.length, 14);
  assert.equal(days[13].ymd, "2026-09-25");
  assert.equal(days[13].total, 3);
  assert.equal(days[13].segments.shared, 1);
  assert.equal(days[0].total, null, "a day before the first logged run has no data");
  assert.equal(t.views.all.usage.headroom, 12);

  const demand = t.views.all.demand.find((x) => x.dept === "fernmoor");
  assert.equal(demand.waiting, 4);
  assert.equal(demand.runsWeek, 1);
  assert.equal(demand.medianWaitDays, 4.1, "21 Sep at midday (no time given) to 25 Sep 14:30");
});

test("team: What we need more of fires access-bound and brief quality", () => {
  const t = team.buildTeam(input());
  const texts = t.views.all.needs.lines.map((l) => l.text);
  assert.ok(texts.some((x) => /^Owlbridge needs access, not runs: 2 of 2 open rows/.test(x)), texts.join("\n"));
  assert.ok(!texts.some((x) => /^Fernmoor needs access/.test(x)), "2 of 4 is not more than half");
  assert.ok(texts.some((x) => /^Copywriter briefs need work/.test(x)) || texts.some((x) => /^Reviewer briefs need work/.test(x)), texts.join("\n"));
  assert.ok(!texts.some((x) => /Near the cap/.test(x)));
  for (const l of t.views.all.needs.lines) assert.ok(l.numbers, "every line shows its numbers");
});

test("team: near the cap fires on three busy weekdays", () => {
  const busy = [];
  for (const day of ["2026-09-23", "2026-09-24", "2026-09-25"]) for (let i = 0; i < 14; i++) busy.push(`| ${day} ${String(8 + (i % 10)).padStart(2, "0")}:${String(i).padStart(2, "0")} | APPROVALS WATCHER | Cloud | OK | run ${i} |`);
  const t = team.buildTeam(input({ runLogMd: runLog(busy) }));
  assert.ok(t.views.all.needs.lines.some((l) => l.rule === "near the cap"));
});

test("team: no DIRECTOR lines yet and an empty ledger show no data, not zeros", () => {
  const t = team.buildTeam(input({ runLogMd: runLog(OTHER_RUNS), ledgerMd: ledger([]) }));
  const v = t.views.all;
  assert.equal(v.strip.working.value, null);
  assert.ok(v.strip.working.why);
  assert.equal(v.director, null);
  assert.equal(v.throughput.byAgent, null);
  assert.ok(v.roster.every((r) => r.weekRuns === null && r.rowsTouched === null));
  assert.ok(v.demand.every((d) => d.runsWeek === null));
  assert.ok(v.throughput.byDept.every((d) => d.failed === null));
  assert.ok(v.needs.notChecked.some((n) => n.rule === "brief quality"));
  assert.equal(v.strip.runsToday.value, 2, "the run log still counts routine runs");
});

test("team: no run log and no Tools cap", () => {
  const t = team.buildTeam(input({ runLogMd: "", toolsMd: "", ledgerMd: null }));
  const v = t.views.all;
  assert.equal(v.strip.runsToday.value, null);
  assert.equal(v.strip.runsToday.cap, null);
  assert.equal(v.usage.headroom, null);
  assert.ok(v.usage.days.every((d) => d.total === null));
  assert.equal(t.sources.ledger, false);
});

test("team: the live vault builds without throwing", { skip: !existsSync(join(VAULT, "System/Approvals.md")) && "no vault clone" }, () => {
  const read = (p) => (existsSync(join(VAULT, p)) ? readFileSync(join(VAULT, p), "utf8") : "");
  const arch = existsSync(join(VAULT, "System/Archive")) ? readdirSync(join(VAULT, "System/Archive")) : [];
  const t = team.buildTeam({
    approvalsMd: read("System/Approvals.md"),
    archiveApprovals: arch.filter((f) => /^Approvals \d{4}-\d{2}\.md$/.test(f)).map((f) => read("System/Archive/" + f)),
    runLogMd: read("System/Run log.md"),
    archiveRunLogs: arch.filter((f) => /^Run log \d{4}-\d{2}\.md$/.test(f)).map((f) => read("System/Archive/" + f)),
    ledgerMd: read("System/Setup/Watcher lock.md"), departmentsMd: read("System/Departments.md"), toolsMd: read("System/Tools.md"),
    agents: AGENTS, today: TODAY, nowUtc: NOW,
  });
  if (existsSync(join(VAULT, "System/Departments.md"))) assert.equal(t.departments.length, 4);
  assert.ok(t.views.all.strip.waiting.value >= 0);
  // The vault gained its first DIRECTOR line on 26 Sep, so this checks the shape, not a snapshot.
  const d = t.views.all.director;
  assert.ok(d === null || (d.last && typeof d.last.when === "string"), "the Director panel is empty or names its last run");
});
