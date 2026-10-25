// Tests for the Leads area's pipeline logic (netlify/functions/lib/leads.mts).
// Run with: npm test   (node --experimental-strip-types --test tests/)
//
// The live-table test reads the real Owlbridge pipeline note from a local clone of the vault
// (VAULT_DIR, default ../vault beside this repo) and is skipped when there is none, so no
// lead data is copied into this repository.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as leadgen from "../netlify/functions/lib/leads.mts";

const here = dirname(fileURLToPath(import.meta.url));
const VAULT = process.env.VAULT_DIR || join(here, "..", "..", "vault");
const livePath = join(VAULT, leadgen.PIPELINE_PATH);

const HEAD = "| id | company | segment | tier | score | contact | email | status | last touch | next step | next date | source |\n|---|---|---|---|---|---|---|---|---|---|---|---|";
const note = (rows) => `---\ntitle: Owlbridge pipeline\n---\n\n# Owlbridge pipeline\n\nIntro.\n\n## Leads\n\n${HEAD}\n${rows.join("\n")}\n\n## Related\n\n[[Leads area]]\n`;
const A = "| L-a | Alpha Bakery | Pubs | A | 90 | Owner, MD | ann\u0040alpha.example | drafted |  | Send email 1 | 2026-09-28 | batch 1 |";
const B = "| L-b | Beta Group | Nurseries | B |  | Director |  | researched |  | Find a contact | 2026-09-20 | batch 1 |";
const C = "| L-c | Gamma \\| Delta | Dental | C | 62 | Manager |  | sent | 2026-09-21 | Chase \\| call | 2026-09-24 | seed list |";

test("parser: the current live table", { skip: !existsSync(livePath) && "no vault clone at " + VAULT }, () => {
  const md = readFileSync(livePath, "utf8");
  const p = leadgen.parseLeads(md);
  assert.equal(p.found, true);
  assert.ok(p.leads.length > 0, "the live table has leads");
  assert.equal(new Set(p.leads.map((l) => l.id)).size, p.leads.length, "ids are unique");
  for (const l of p.leads) {
    assert.match(l.id, /^L-/);
    assert.ok(leadgen.LEAD_STATUSES.includes(l.status), `${l.id} has a known status (${l.status})`);
    assert.ok(leadgen.validDate(l.nextDate), `${l.id} next date`);
  }
  // a seed lead (one not yet researched) carries no score
  assert.ok(p.leads.filter((l) => l.tier === "seed").every((l) => l.score === ""), "seeds have an empty score");
});

test("parser: an empty score, and a pipe escaped out", () => {
  const p = leadgen.parseLeads(note([A, B, C]));
  assert.equal(p.leads.length, 3);
  const b = p.leads.find((l) => l.id === "L-b");
  assert.equal(b.score, "");
  assert.equal(b.email, "");
  assert.equal(b.status, "researched");
  const c = p.leads.find((l) => l.id === "L-c");
  assert.equal(c.company, "Gamma | Delta");
  assert.equal(c.nextStep, "Chase | call");
  assert.equal(c.nextDate, "2026-09-24", "the escaped pipe did not shift the columns");
  assert.equal(c.source, "seed list");
});

test("parser: no Leads table", () => {
  assert.deepEqual(leadgen.parseLeads("# Nothing here\n").leads, []);
  assert.equal(leadgen.parseLeads("# Nothing here\n").found, false);
});

test("due: next date today or past, out-of-play rows never due", () => {
  assert.equal(leadgen.isDue({ status: "drafted", nextDate: "2026-09-26" }, "2026-09-26"), true);
  assert.equal(leadgen.isDue({ status: "drafted", nextDate: "2026-09-20" }, "2026-09-26"), true);
  assert.equal(leadgen.isDue({ status: "drafted", nextDate: "2026-09-27" }, "2026-09-26"), false);
  assert.equal(leadgen.isDue({ status: "drafted", nextDate: "" }, "2026-09-26"), false);
  assert.equal(leadgen.isDue({ status: "opted out", nextDate: "2026-09-20" }, "2026-09-26"), false);
});

test("status: sets the status and last touch, leaves every other cell as it was", () => {
  const md = note([A, B, C]);
  const r = leadgen.applyStatus(md, "L-c", "replied", "2026-09-26");
  assert.equal(r.ok, true);
  const lines = r.text.split("\n");
  assert.equal(lines.find((l) => l.startsWith("| L-c ")), "| L-c | Gamma \\| Delta | Dental | C | 62 | Manager |  | replied | 2026-09-26 | Chase \\| call | 2026-09-24 | seed list |");
  assert.ok(lines.includes(A) && lines.includes(B));
  assert.equal(r.text.replace(/\| L-c .*\|/, ""), md.replace(/\| L-c .*\|/, ""), "nothing outside the row changed");
  assert.equal(leadgen.applyStatus(md, "L-c", "nonsense", "2026-09-26").ok, false);
  assert.equal(leadgen.applyStatus(md, "L-zzz", "sent", "2026-09-26").status, 404);
});

test("next step: escaped pipes and one line", () => {
  const r = leadgen.applyNext(note([A]), "L-a", "Call | then\nemail", "2026-10-01");
  assert.equal(r.ok, true);
  const p = leadgen.parseLeads(r.text).leads[0];
  assert.equal(p.nextStep, "Call | then email");
  assert.equal(p.nextDate, "2026-10-01");
  assert.equal(leadgen.applyNext(note([A]), "L-a", "x", "1 Oct").ok, false);
});

test("add: appends a researched row with a stable id, refuses duplicates and suppressed companies", () => {
  const r = leadgen.applyAdd(note([A, B]), { company: "Lantern Rooms Group (Quay, Mill, Arches)", tier: "A", score: "80", nextDate: "2026-10-02" });
  assert.equal(r.ok, true);
  assert.equal(r.id, "L-lantern-rooms-group-quay-mil");
  const leads = leadgen.parseLeads(r.text).leads;
  assert.equal(leads.length, 3);
  assert.equal(leads[2].status, "researched");
  assert.equal(leads[2].source, "platform");
  assert.ok(r.text.includes("\n\n## Related"), "the row went into the table, not after it");
  assert.equal(leadgen.applyAdd(note([A]), { company: "alpha bakery" }).status, 409);
  assert.equal(leadgen.applyAdd(note([A]), { company: "Zeta", score: "high" }).ok, false);
  assert.equal(leadgen.applyAdd(note([A]), { company: "Zeta Group" }, ["Zeta Group"]).status, 409);
  assert.equal(leadgen.applyAdd(note([A]), { company: "" }).ok, false);
});

test("suppression: created on the first opt-out, added to after, never duplicated", () => {
  const station = "# Station\n\n## Compliance\n\nText.\n\n## Open\n\n- [ ] a task\n\n## Related\n\n[[x]]\n";
  const r1 = leadgen.applySuppress(station, "Alpha Bakery", "ann\u0040alpha.example");
  assert.equal(r1.ok, true);
  assert.equal(r1.added, true);
  assert.ok(r1.text.indexOf("## Suppression list") < r1.text.indexOf("## Open"));
  assert.deepEqual(leadgen.parseSuppression(r1.text), [{ company: "Alpha Bakery", address: "ann\u0040alpha.example" }]);
  const r2 = leadgen.applySuppress(r1.text, "Beta Group", "none published");
  assert.deepEqual(leadgen.parseSuppression(r2.text), [{ company: "Alpha Bakery", address: "ann\u0040alpha.example" }, { company: "Beta Group", address: "" }]);
  const r3 = leadgen.applySuppress(r2.text, "Alpha Bakery", "ann\u0040alpha.example");
  assert.equal(r3.unchanged, true);
  assert.ok(r2.text.includes("- [ ] a task"), "the rest of the note is untouched");
});

test("research: the lead list rows for a company, by name", () => {
  const list = "## Tier A\n\n| Score | Company | Segment |\n|---|---|---|\n| 100 | Harbour Kitchen Group (Saffron Room) | Restaurants |\n\n## Outreach log\n\n| Company | Status |\n|---|---|\n| Harbour Kitchen Group | Drafted |\n| Other | x |\n";
  const rows = leadgen.researchRows("Harbour Kitchen Group (Saffron Room)", [{ path: "x.md", text: list }]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].heading, "Tier A");
  assert.deepEqual(rows[0].fields[0], ["Score", "100"]);
  assert.equal(rows[1].heading, "Outreach log");
});

// A tiny stand-in for GitHub's Contents API: a write with a stale sha is refused with 409.
function fakeVault(initial) {
  let content = initial, sha = 1, writes = 0;
  return {
    get content() { return content; },
    get writes() { return writes; },
    // what a Director run does: its own edit, committed between our read and our write
    external(fn) { content = fn(content); sha++; },
    io(beforeWrite) {
      return {
        read: async () => ({ content, sha: String(sha) }),
        write: async (_p, c, _m, s) => {
          if (beforeWrite) { const f = beforeWrite; beforeWrite = null; f(); }
          if (s !== String(sha)) { const e = new Error("409"); e.status = 409; throw e; }
          content = c; sha++; writes++;
          return { commit: "c" + sha };
        },
      };
    },
  };
}

test("merge: a status change and a Director run editing different rows both land", async () => {
  const v = fakeVault(note([A, B, C]));
  // The Director moves L-b to drafted while our write of L-a is in flight.
  const io = v.io(() => v.external((t) => leadgen.applyStatus(t, "L-b", "drafted", "2026-09-26").text));
  const r = await leadgen.writeRow(io, leadgen.PIPELINE_PATH, (t) => leadgen.applyStatus(t, "L-a", "sent", "2026-09-26"), "platform: lead L-a sent");
  assert.equal(r.ok, true);
  const leads = Object.fromEntries(leadgen.parseLeads(v.content).leads.map((l) => [l.id, l]));
  assert.equal(leads["L-a"].status, "sent");
  assert.equal(leads["L-b"].status, "drafted", "the Director's edit survived");
  assert.equal(leads["L-c"].company, "Gamma | Delta");
  assert.equal(v.writes, 1);
});

test("merge: the same row, the later status wins", async () => {
  const v = fakeVault(note([A, B]));
  const io = v.io(() => v.external((t) => leadgen.applyStatus(t, "L-a", "sent", "2026-09-25").text));
  const r = await leadgen.writeRow(io, leadgen.PIPELINE_PATH, (t) => leadgen.applyStatus(t, "L-a", "replied", "2026-09-26"), "platform: lead L-a replied");
  assert.equal(r.ok, true);
  const a = leadgen.parseLeads(v.content).leads.find((l) => l.id === "L-a");
  assert.equal(a.status, "replied");
  assert.equal(a.lastTouch, "2026-09-26");
});

test("merge: gives up after three refusals with a clear message", async () => {
  const v = fakeVault(note([A]));
  const io = { read: v.io().read, write: async () => { const e = new Error("409"); e.status = 409; throw e; } };
  const r = await leadgen.writeRow(io, leadgen.PIPELINE_PATH, (t) => leadgen.applyStatus(t, "L-a", "sent", "2026-09-26"), "m");
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.match(r.error, /Owlbridge pipeline was busy/);
});

test("leadsState: due count, research joined, suppression read", () => {
  const texts = new Map([
    [leadgen.PIPELINE_PATH, note([A, B, C])],
    [leadgen.STATION_PATH, "## Suppression list\n\n| company | address |\n|---|---|\n| Old Kitchens | x\u0040old.example |\n"],
    [leadgen.LEADS_DIR + "Owlbridge lead list 2026-09-25.md", "| Score | Company |\n|---|---|\n| 90 | Alpha Bakery |\n"],
  ]);
  const s = leadgen.leadsState(texts, "2026-09-26");
  assert.equal(s.exists, true);
  assert.equal(s.leads.length, 3);
  assert.equal(s.due, 2, "L-b (20 Sep) and L-c (24 Sep)");
  assert.equal(s.leads[0].research.length, 1);
  assert.deepEqual(s.suppressed, [{ company: "Old Kitchens", address: "x\u0040old.example" }]);
  const missing = leadgen.leadsState(new Map(), "2026-09-26");
  assert.equal(missing.exists, false);
  assert.equal(missing.due, 0);
});
