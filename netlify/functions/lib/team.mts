// The Team area: every figure the agent command centre shows, derived from the vault only.
//
// Spec: System/Setup/Agent command centre.md in the vault (a-2026-09-24-agent-command-centre).
// Sources, and nothing else:
//   - System/Approvals.md Queue rows (10, 11 or 12 cells; the 12th is the department) and the
//     settled rows in System/Archive/Approvals YYYY-MM.md, so weekly figures survive the archive;
//   - System/Setup/Watcher lock.md, the claim ledger (utc | key | run | action);
//   - System/Run log.md (Latest) and System/Archive/Run log YYYY-MM.md, with the tag DIRECTOR
//     lines open their note with: [dept=...; agents=...; rows=...; done=; moved=; blocked=];
//   - System/Departments.md for the lanes, their colours and the thresholds the rules use;
//   - System/Agents/*.md frontmatter (role, colour, model, jobs) for the roster;
//   - System/Tools.md for the routine cap ("allows up to N routine runs a day").
// A figure with no source is null, which the page shows as "No data yet", never as a zero.
//
// Pure (text in, data out), so tests/team.test.mjs runs it without GitHub. Times in the run log
// and the queue are Europe/London wall-clock; the ledger is UTC. Wall-clock values are compared
// with a London wall-clock "now" read as if it were UTC, so no time zone maths is needed for them.

// ---------- queue rows ----------

export type QueueRow = {
  id: string; status: string; title: string; detail: string; cost: string; reversible: string; source: string;
  requested: string; decided: string; note: string; priority: string; department: string;
};

// One Queue row from its cells. 10 cells is the original shape, 11 adds priority, 12 adds the
// department. Anything shorter reads as blank in the missing cells; the department is lower-cased
// so "Owlbridge" and "owlbridge" are one lane.
export function queueRow(r: string[]): QueueRow {
  const c = (i: number) => (r[i] || "").trim();
  return {
    id: c(0), status: c(1), title: c(2), detail: c(3), cost: c(4), reversible: c(5), source: c(6),
    requested: c(7), decided: c(8), note: c(9), priority: c(10), department: c(11).toLowerCase(),
  };
}

const splitCells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((s) => s.trim());

// Every a- row in a text, any table: the archive files have no Queue heading.
export function rowsIn(text: string): QueueRow[] {
  const out: QueueRow[] = [];
  for (const line of String(text || "").split("\n")) {
    if (!/^\|\s*a-\d{4}-\d{2}-\d{2}-/.test(line)) continue;
    const cells = splitCells(line);
    if (cells.length < 10) continue;
    out.push(queueRow(cells));
  }
  return out;
}

function sectionOf(text: string, heading: string): string {
  const lines = String(text || "").split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start < 0) return "";
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) { if (/^## /.test(lines[i])) break; out.push(lines[i]); }
  return out.join("\n");
}

// ---------- the department registry and its rules ----------

export type Department = { id: string; name: string; colour: string; covers: string; repositories: string };
export type Rules = {
  accessBound: { share: number; text: string } | null;
  shortOfRuns: { ageDays: number; days: number; of: number; text: string } | null;
  briefQuality: { rate: number; label: string; windowDays: number; text: string } | null;
  nearCap: { runs: number; days: number; of: number; text: string } | null;
};

const HEX = /^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{3}$/;
const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const num = (s: string) => (s in WORD_NUM ? WORD_NUM[s] : Number(s));

function tableAfter(md: string, firstHeader: string): string[][] {
  const lines = md.split("\n");
  const at = lines.findIndex((l) => /^\s*\|/.test(l) && splitCells(l)[0].toLowerCase() === firstHeader);
  if (at < 0) return [];
  const rows: string[][] = [];
  for (let i = at + 1; i < lines.length && /^\s*\|/.test(lines[i]); i++) {
    const cells = splitCells(lines[i]);
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) continue;
    rows.push(cells);
  }
  return rows;
}

export function parseDepartments(md: string): { departments: Department[]; rules: Rules; found: boolean } {
  const departments = tableAfter(md || "", "id")
    .filter((r) => r[0])
    .map((r) => ({ id: r[0].toLowerCase(), name: r[1] || r[0], colour: HEX.test(r[2] || "") ? r[2] : "", covers: r[3] || "", repositories: r[4] || "" }));
  const ruleRows = tableAfter(md || "", "rule");
  const find = (name: string) => (ruleRows.find((r) => r[0].toLowerCase() === name) || [])[1] || "";
  const rules: Rules = { accessBound: null, shortOfRuns: null, briefQuality: null, nearCap: null };

  const ab = find("access-bound");
  const abm = ab.match(/more than (half|a third|a quarter|(\d+)\s*%)/i);
  if (abm) rules.accessBound = { share: abm[2] ? Number(abm[2]) / 100 : ({ half: 0.5, "a third": 1 / 3, "a quarter": 0.25 } as any)[abm[1].toLowerCase()], text: ab };

  const sr = find("short of runs");
  const srAge = sr.match(/above (\w+) days?/i), srDays = sr.match(/on (\w+) of the last (\w+) weekdays/i);
  if (srAge && srDays) rules.shortOfRuns = { ageDays: num(srAge[1]), days: num(srDays[1]), of: num(srDays[2]), text: sr };

  const bq = find("brief quality");
  const bqm = bq.match(/above (\w+) in (\w+) over (\w+) days/i);
  if (bqm) rules.briefQuality = { rate: num(bqm[1]) / num(bqm[2]), label: `1 in ${num(bqm[2]) / num(bqm[1])}`, windowDays: num(bqm[3]), text: bq };

  const nc = find("near the cap");
  const ncm = nc.match(/above (\w+) a day on (\w+) of the last (\w+) weekdays/i);
  if (ncm) rules.nearCap = { runs: num(ncm[1]), days: num(ncm[2]), of: num(ncm[3]), text: nc };

  return { departments, rules, found: departments.length > 0 };
}

// "Max allows up to 15 routine runs a day" in System/Tools.md.
export function parseCap(toolsMd: string): number | null {
  const m = String(toolsMd || "").match(/allows up to (\d+) routine runs a day/i);
  return m ? Number(m[1]) : null;
}

// ---------- the lock ledger ----------

export type LedgerRow = { at: number; key: string; run: string; action: "claim" | "release" };

// The same rule as watcher-lock.py parse(): four cells, a UTC stamp, claim or release.
export function parseLedger(md: string): LedgerRow[] {
  const out: LedgerRow[] = [];
  for (const line of String(md || "").split("\n")) {
    if (!/^\s*\|/.test(line)) continue;
    const c = splitCells(line);
    if (c.length !== 4 || (c[3] !== "claim" && c[3] !== "release")) continue;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(c[0])) continue;
    out.push({ at: Date.parse(c[0]), key: c[1], run: c[2], action: c[3] as "claim" | "release" });
  }
  return out;
}

// A run id is <department>-<YYYYMMDD-HHMM> (spec, Data 2). A trailing -<Role> names the agent,
// when the claim carries one; without it the card says the claim does not name one.
export function parseRunId(run: string): { dept: string; stamp: string; agent: string } {
  const m = String(run || "").match(/^([a-z]+)-(\d{8}-\d{4})(?:-(.+))?$/i);
  return m ? { dept: m[1].toLowerCase(), stamp: m[2], agent: m[3] || "" } : { dept: "", stamp: "", agent: "" };
}

export type Claim = { key: string; run: string; dept: string; agent: string; at: string; ageMin: number; live: boolean; stale: boolean; released: boolean; isRow: boolean };

export function claimsFrom(rows: LedgerRow[], nowUtc: number, ttlMin = 90): Claim[] {
  const released = new Set(rows.filter((r) => r.action === "release").map((r) => r.key + "\u0000" + r.run));
  const seen = new Map<string, LedgerRow>();
  for (const r of rows) if (r.action === "claim") { const k = r.key + "\u0000" + r.run; if (!seen.has(k) || seen.get(k)!.at > r.at) seen.set(k, r); }
  return Array.from(seen.entries()).map(([k, r]) => {
    const rel = released.has(k);
    const ageMin = Math.max(0, Math.round((nowUtc - r.at) / 60000));
    const id = parseRunId(r.run);
    return {
      key: r.key, run: r.run, dept: id.dept, agent: id.agent, at: new Date(r.at).toISOString(), ageMin,
      released: rel, live: !rel && ageMin < ttlMin, stale: !rel && ageMin >= ttlMin, isRow: /^a-\d{4}-/.test(r.key),
    };
  }).sort((a, b) => (a.at < b.at ? 1 : -1));
}

// ---------- the run log ----------

export type Tag = { dept: string[]; agents: string[]; rows: string[]; agentsByRow: Record<string, string[]>; done: number | null; moved: number | null; blocked: number | null; extra: Record<string, string> };
export type Run = { when: string; ymd: string; job: string; surface: string; result: string; note: string; cloud: boolean; director: boolean; tag: Tag | null };

const intOrNull = (s: string | undefined) => (s != null && /^\d+$/.test(s.trim()) ? Number(s.trim()) : null);
const list = (s: string | undefined) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

// [dept=owlbridge; agents=Researcher,Copywriter; rows=a-...,a-...; done=1; moved=2; blocked=1]
// agents may be grouped per row with "/", in the order of rows=: agents=Researcher,Reviewer/Developer
// Without groups, every agent is read as having worked every row in the run.
export function parseTag(note: string): Tag | null {
  const m = String(note || "").match(/^\s*\[([^\]]*=[^\]]*)\]/);
  if (!m) return null;
  const kv: Record<string, string> = {};
  for (const part of m[1].split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    kv[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  const rows = list(kv.rows);
  const groups = String(kv.agents || "").split("/").map(list);
  const agents: string[] = [];
  for (const g of groups) for (const a of g) if (agents.indexOf(a) < 0) agents.push(a);
  const agentsByRow: Record<string, string[]> = {};
  rows.forEach((r, i) => { agentsByRow[r] = groups.length > 1 && groups.length === rows.length ? groups[i] : agents.slice(); });
  const extra: Record<string, string> = {};
  for (const k of Object.keys(kv)) if (["dept", "agents", "rows", "done", "moved", "blocked"].indexOf(k) < 0) extra[k] = kv[k];
  return { dept: list(kv.dept).map((d) => d.toLowerCase()), agents, rows, agentsByRow, done: intOrNull(kv.done), moved: intOrNull(kv.moved), blocked: intOrNull(kv.blocked), extra };
}

export function runsIn(md: string, headingOrAll: string | null): Run[] {
  const text = headingOrAll ? sectionOf(md, headingOrAll) : String(md || "");
  const out: Run[] = [];
  for (const line of text.split("\n")) {
    if (!/^\|\s*\d{4}-\d{2}-\d{2}/.test(line)) continue;
    const c = splitCells(line);
    if (c.length < 5) continue;
    const note = c.slice(4).join(" | ");
    const job = c[1];
    const director = job.trim().toUpperCase() === "DIRECTOR";
    out.push({
      when: c[0], ymd: c[0].slice(0, 10), job, surface: c[2], result: c[3], note,
      cloud: /cloud/i.test(c[2]), director, tag: director ? parseTag(note) : null,
    });
  }
  return out;
}

// ---------- row notes: Est, Needs, Redo ----------

const UNIT_MIN: Record<string, number> = { minute: 1, min: 1, hour: 60, hr: 60, h: 60, day: 1440, week: 10080 };
// The leading Est: figure of a note, in minutes. "Est: 2 to 3 hours" reads as the midpoint;
// "Est: next run" and other words-only estimates read as null (no figure).
export function estimateMinutes(note: string): number | null {
  const m = String(note || "").match(/Est:\s*(?:about\s+|around\s+|roughly\s+)?(half an?|an?|\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s*(?:to|-)\s*(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten))?\s*(minutes?|mins?|hours?|hrs?|h|days?|weeks?)\b/i);
  if (!m) return null;
  const word = m[1].toLowerCase();
  const lo = word.startsWith("half") ? 0.5 : word === "a" || word === "an" ? 1 : num(word);
  const hi = m[2] ? num(m[2].toLowerCase()) : lo;
  const unit = m[3].toLowerCase().replace(/s$/, "");
  const per = UNIT_MIN[unit] || UNIT_MIN[unit.replace(/s$/, "")];
  if (!per || !isFinite(lo) || !isFinite(hi)) return null;
  return Math.round(((lo + hi) / 2) * per);
}

export type BlockType = "decision" | "mac" | "cowork" | "repo" | "credentials" | "other";
export const BLOCK_LABELS: Record<BlockType, string> = {
  decision: "Your decision", mac: "Mac session", cowork: "Cowork session", repo: "Repo access", credentials: "Someone else's credentials", other: "Other",
};
export const ACCESS_BLOCKS: BlockType[] = ["mac", "cowork", "repo", "credentials"];

// The latest Needs: label in a note (the note is append-only, so the last one is current).
export function needsLabel(note: string): string {
  const all = String(note || "").match(/Needs:\s*[^;|]+/gi);
  return all ? all[all.length - 1].replace(/^Needs:\s*/i, "").replace(/[.\s]+$/, "").trim() : "";
}
export function classifyNeeds(label: string): BlockType {
  const l = label.toLowerCase();
  if (/cowork/.test(l)) return "cowork";
  if (/\bmac\b/.test(l)) return "mac";
  if (/repo|repository|github access/.test(l)) return "repo";
  if (/credential|password|login|api key|token/.test(l)) return "credentials";
  return "other";
}
// An open row's block: pending is their decision; otherwise its Needs: label, if it has one.
export function blockOf(row: QueueRow): { type: BlockType; label: string } | null {
  const s = row.status.toLowerCase();
  if (s === "pending") return { type: "decision", label: "Waiting for your yes" };
  if (!OPEN.includes(s)) return null;
  const label = needsLabel(row.note);
  return label ? { type: classifyNeeds(label), label } : null;
}

const MON3 = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
// The platform's Redo writes "<D> <Mon> <HH:MM>: Redo requested." into the row note (reviewAction
// in api.mts) and commits "platform: redo <id>", so every press leaves a dated trace in the row.
export function redoDates(note: string, yearHint: string): string[] {
  const out: string[] = [];
  const re = /(\d{1,2}) ([A-Z][a-z]{2}) \d{1,2}:\d{2}: Redo requested/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(note || "")))) {
    const mi = MON3.indexOf(m[2].toLowerCase());
    if (mi < 0 || !/^\d{4}$/.test(yearHint)) continue;
    out.push(`${yearHint}-${String(mi + 1).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`);
  }
  return out;
}

// ---------- dates ----------

const OPEN = ["requested", "pending", "approved", "in progress"];
const localMs = (s: string): { ms: number; hasTime: boolean } | null => {
  const m = String(s || "").match(/(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const hasTime = m[2] != null;
  return { ms: Date.parse(`${m[1]}T${hasTime ? m[2].padStart(2, "0") + ":" + m[3] : "12:00"}:00Z`), hasTime };
};
export function addDays(ymd: string, n: number): string {
  const d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
export function mondayOf(ymd: string): string {
  const d = new Date(ymd + "T00:00:00Z"); return addDays(ymd, -((d.getUTCDay() + 6) % 7));
}
const isWeekday = (ymd: string) => { const d = new Date(ymd + "T00:00:00Z").getUTCDay(); return d !== 0 && d !== 6; };
function lastWeekdays(ymd: string, n: number): string[] {
  const out: string[] = []; let d = ymd;
  while (out.length < n) { if (isWeekday(d)) out.push(d); d = addDays(d, -1); }
  return out;
}
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b), mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const round1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);

// ---------- the model ----------

export type Agent = { name: string; role: string; colour: string; model: string; path: string; jobs: string[] };
export type TeamInput = {
  approvalsMd: string;               // System/Approvals.md
  archiveApprovals: string[];        // System/Archive/Approvals YYYY-MM.md texts
  runLogMd: string;                  // System/Run log.md
  archiveRunLogs: string[];          // System/Archive/Run log YYYY-MM.md texts
  ledgerMd: string | null;           // System/Setup/Watcher lock.md, null when missing
  departmentsMd: string;             // System/Departments.md
  toolsMd: string;                   // System/Tools.md
  agents: Agent[];                   // from System/Agents/*.md frontmatter
  today: { ymd: string; hm: string };// Europe/London
  nowUtc: number;                    // Date.now()
};

type RowRef = { id: string; title: string };
type Row = QueueRow & { dept: string; live: boolean; est: number | null; block: { type: BlockType; label: string } | null; redos: string[]; ageDays: number | null; actualMin: number | null };

const UNASSIGNED = "unassigned";

export function buildTeam(input: TeamInput) {
  const { departments, rules, found: registryFound } = parseDepartments(input.departmentsMd);
  const deptIds = departments.map((d) => d.id);
  const cap = parseCap(input.toolsMd);
  const today = input.today.ymd;
  const nowLocal = Date.parse(`${today}T${input.today.hm || "12:00"}:00Z`);
  const monday = mondayOf(today);

  // rows: the live queue wins over an archived copy of the same id
  const byId = new Map<string, Row>();
  const addRow = (q: QueueRow, live: boolean) => {
    if (!q.id || (byId.has(q.id) && byId.get(q.id)!.live)) return;
    const dept = deptIds.indexOf(q.department) > -1 ? q.department : UNASSIGNED;
    const s = q.status.toLowerCase();
    const req = localMs(q.requested), dec = localMs(q.decided);
    let actualMin: number | null = null;
    if (s === "done" && req && dec && (req.hasTime && dec.hasTime || q.requested.slice(0, 10) !== q.decided.slice(0, 10))) actualMin = Math.max(0, Math.round((dec.ms - req.ms) / 60000));
    byId.set(q.id, {
      ...q, dept, live, est: estimateMinutes(q.note), block: blockOf(q), redos: redoDates(q.note, (q.requested || q.id.slice(2)).slice(0, 4)),
      ageDays: OPEN.includes(s) && req ? Math.max(0, (nowLocal - req.ms) / 86400000) : null, actualMin,
    });
  };
  rowsIn(sectionOf(input.approvalsMd, "Queue")).forEach((q) => addRow(q, true));
  input.archiveApprovals.forEach((t) => rowsIn(t).forEach((q) => addRow(q, false)));
  const rows = Array.from(byId.values());
  const titleOf = (id: string) => (byId.get(id) || { title: "" }).title;
  const ref = (r: Row): RowRef => ({ id: r.id, title: r.title });

  // runs: Latest plus the archives, deduplicated
  const seenRun = new Set<string>();
  const runs: Run[] = [];
  const addRuns = (list: Run[]) => list.forEach((r) => { const k = r.when + "|" + r.job + "|" + r.note.slice(0, 60); if (!seenRun.has(k)) { seenRun.add(k); runs.push(r); } });
  addRuns(runsIn(input.runLogMd, "Latest"));
  input.archiveRunLogs.forEach((t) => addRuns(runsIn(t, null)));
  runs.sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : 0));
  const directorRuns = runs.filter((r) => r.director);
  const earliestRunDay = runs.length ? runs[runs.length - 1].ymd : null;

  const ledgerRows = input.ledgerMd == null ? [] : parseLedger(input.ledgerMd);
  const claims = claimsFrom(ledgerRows, input.nowUtc);
  // a claim's department: its run id's prefix, else the row's own department
  claims.forEach((c) => { if (deptIds.indexOf(c.dept) < 0) c.dept = c.isRow && byId.has(c.key) ? byId.get(c.key)!.dept : UNASSIGNED; });
  const ledgerHasData = ledgerRows.length > 0;

  // a role name in a tag matches the agent file's role or its title, case ignored
  const roleKey = (a: Agent) => [a.role.toLowerCase(), a.name.toLowerCase()];
  const agentFor = (name: string) => input.agents.find((a) => roleKey(a).indexOf(name.trim().toLowerCase()) > -1) || null;

  const cloudRunsOn = (ymd: string) => runs.filter((r) => r.cloud && r.ymd === ymd).length;
  const hasRunData = (ymd: string) => earliestRunDay != null && ymd >= earliestRunDay;

  // ---------- lanes: always all departments, plus Unassigned ----------
  const laneFor = (id: string, name: string, colour: string) => {
    const mine = rows.filter((r) => r.dept === id);
    const open = mine.filter((r) => r.live && OPEN.includes(r.status.toLowerCase()));
    const statusCounts: Record<string, number> = {};
    OPEN.forEach((s) => { statusCounts[s] = open.filter((r) => r.status.toLowerCase() === s).length; });
    const oldest = open.filter((r) => r.ageDays != null).sort((a, b) => b.ageDays! - a.ageDays!)[0] || null;
    const blocks: Record<string, RowRef[]> = {};
    (Object.keys(BLOCK_LABELS) as BlockType[]).forEach((b) => { blocks[b] = open.filter((r) => r.block && r.block.type === b).map(ref); });
    const doneWeek = mine.filter((r) => r.status.toLowerCase() === "done" && r.decided.slice(0, 10) >= monday && r.decided.slice(0, 10) <= today);
    return {
      id, name, colour,
      live: claims.filter((c) => c.live && c.isRow && c.dept === id).map((c) => ({ ...c, title: titleOf(c.key) })),
      stale: claims.filter((c) => c.stale && c.isRow && c.dept === id).map((c) => ({ ...c, title: titleOf(c.key) })),
      rowsTotal: mine.length, open: open.map(ref), statusCounts,
      oldest: oldest ? { id: oldest.id, title: oldest.title, ageDays: round1(oldest.ageDays) } : null,
      blocks, doneWeek: doneWeek.map(ref),
    };
  };
  const lanes = departments.map((d) => laneFor(d.id, d.name, d.colour)).concat([laneFor(UNASSIGNED, "Unassigned", "")]);

  // ---------- one view per filter ----------
  const inDept = (f: string, d: string) => f === "all" || f === d;
  const runTouches = (r: Run, f: string) => f === "all" || !!(r.tag && (r.tag.dept.indexOf(f) > -1 || r.tag.rows.some((id) => byId.has(id) && byId.get(id)!.dept === f)));

  const view = (f: string) => {
    const vRows = rows.filter((r) => inDept(f, r.dept));
    const open = vRows.filter((r) => r.live && OPEN.includes(r.status.toLowerCase()));
    const doneWeek = vRows.filter((r) => r.status.toLowerCase() === "done" && r.decided.slice(0, 10) >= monday && r.decided.slice(0, 10) <= today);
    const liveClaims = claims.filter((c) => c.live && c.isRow && inDept(f, c.dept));
    const vDirector = directorRuns.filter((r) => runTouches(r, f));

    const strip = {
      working: ledgerHasData ? { value: liveClaims.length, rows: liveClaims.map((c) => ({ id: c.key, title: titleOf(c.key) })) } : { value: null, why: "The lock ledger has no claims yet: the Director is not live." },
      waiting: { value: open.length, rows: open.map(ref) },
      runsToday: runs.length ? { value: cloudRunsOn(today), cap, deptValue: f === "all" ? null : vDirector.filter((r) => r.ymd === today).length } : { value: null, cap, why: "The run log has no lines yet." },
      doneWeek: { value: doneWeek.length, rows: doneWeek.map(ref) },
    };

    // Director panel
    const last = vDirector[0] || null;
    const director = last ? {
      last: { when: last.when, result: last.result, note: last.note.replace(/^\s*\[[^\]]*\]\s*/, ""), tagged: !!last.tag },
      tree: last.tag ? last.tag.rows.filter((id) => f === "all" || (byId.has(id) ? byId.get(id)!.dept === f : last.tag!.dept.indexOf(f) > -1))
        .map((id) => ({ id, title: titleOf(id), status: byId.has(id) ? byId.get(id)!.status : "", agents: last.tag!.agentsByRow[id] || [] })) : [],
      counts: last.tag ? { done: last.tag.done, moved: last.tag.moved, blocked: last.tag.blocked } : null,
      back: last.tag && last.tag.extra.back ? list(last.tag.extra.back) : null,
      passed: last.tag ? last.tag.rows.filter((id) => byId.has(id) && byId.get(id)!.status.toLowerCase() === "pending").map((id) => ({ id, title: titleOf(id) })) : [],
      runsLogged: vDirector.length,
    } : null;

    // roster: every agent file, by role
    const weekDirector = vDirector.filter((r) => r.ymd >= monday);
    const roster = input.agents.map((a) => {
      const keys = roleKey(a);
      const named = (r: Run) => !!(r.tag && r.tag.agents.some((x) => keys.indexOf(x.toLowerCase()) > -1));
      const wk = weekDirector.filter(named);
      const depts: Record<string, number> = {};
      const touched = new Set<string>();
      wk.forEach((r) => {
        r.tag!.dept.forEach((d) => { depts[d] = (depts[d] || 0) + 1; });
        r.tag!.rows.forEach((id) => { if ((r.tag!.agentsByRow[id] || []).some((x) => keys.indexOf(x.toLowerCase()) > -1)) touched.add(id); });
      });
      const jobs = a.jobs.map((j) => j.toUpperCase());
      const lastRun = runs.find((r) => (r.director && named(r)) || jobs.some((j) => r.job.toUpperCase().indexOf(j) === 0)) || null;
      const now = claims.filter((c) => c.live && c.agent && keys.indexOf(c.agent.toLowerCase()) > -1 && inDept(f, c.dept)).map((c) => ({ id: c.key, title: titleOf(c.key), ageMin: c.ageMin }));
      return {
        role: a.role || a.name, name: a.name, colour: a.colour, model: a.model, path: a.path,
        weekRuns: directorRuns.length ? wk.length : null, depts, rowsTouched: directorRuns.length ? Array.from(touched).map((id) => ({ id, title: titleOf(id) })) : null,
        lastRun: lastRun ? { when: lastRun.when, job: lastRun.job, result: lastRun.result } : null,
        now, live: now.length > 0,
      };
    });

    // demand against capacity, per department in the filter
    const dlist = f === "all" ? departments.map((d) => d.id).concat([UNASSIGNED]) : [f];
    const demand = dlist.map((d) => {
      const o = rows.filter((r) => r.dept === d && r.live && OPEN.includes(r.status.toLowerCase()));
      const ages = o.map((r) => r.ageDays).filter((x): x is number => x != null);
      return {
        dept: d, waiting: o.length, rows: o.map(ref),
        runsWeek: directorRuns.length ? directorRuns.filter((r) => r.ymd >= monday && r.tag && r.tag.dept.indexOf(d) > -1).length : null,
        medianWaitDays: round1(median(ages)),
      };
    });

    // throughput and quality, this week
    const redoRows = (list: Row[], since: string) => list.filter((r) => r.redos.some((d) => d >= since && d <= today));
    // the rate is rows sent back over rows delivered or sent back, counting a row once
    const rate = (done: Row[], redone: Row[]) => { const all = new Set(done.map((r) => r.id).concat(redone.map((r) => r.id))); return all.size ? round1((redone.length / all.size) * 100) : null; };
    const estPairs = (list: Row[]) => list.filter((r) => r.est && r.actualMin != null).map((r) => ({ id: r.id, title: r.title, ratio: r.actualMin! / r.est! }));
    const throughputDept = dlist.map((d) => {
      const done = rows.filter((r) => r.dept === d && r.status.toLowerCase() === "done" && r.decided.slice(0, 10) >= monday && r.decided.slice(0, 10) <= today);
      const redone = redoRows(rows.filter((r) => r.dept === d), monday);
      const pairs = estPairs(done);
      const failed = directorRuns.filter((r) => r.ymd >= monday && r.tag && r.tag.dept.indexOf(d) > -1 && r.result.toUpperCase() !== "OK");
      return {
        dept: d, done: done.length, doneRows: done.map(ref),
        redos: redone.length, redoRows: redone.map(ref), redoRate: rate(done, redone),
        failed: directorRuns.length ? failed.length : null, failedRuns: failed.map((r) => r.when),
        estRatio: round1(median(pairs.map((p) => p.ratio))), estRows: pairs.map((p) => ({ id: p.id, title: p.title, ratio: round1(p.ratio) })),
      };
    });
    const rowsForAgent = (keys: string[], since: string) => {
      const ids = new Set<string>();
      vDirector.filter((r) => r.ymd >= since && r.tag).forEach((r) => r.tag!.rows.forEach((id) => { if ((r.tag!.agentsByRow[id] || []).some((x) => keys.indexOf(x.toLowerCase()) > -1)) ids.add(id); }));
      return Array.from(ids).map((id) => byId.get(id)).filter((r): r is Row => !!r);
    };
    const throughputAgent = directorRuns.length ? input.agents.map((a) => {
      const worked = rowsForAgent(roleKey(a), monday);
      const done = worked.filter((r) => r.status.toLowerCase() === "done" && r.decided.slice(0, 10) >= monday);
      const redone = redoRows(worked, monday);
      const failed = vDirector.filter((r) => r.ymd >= monday && r.tag && r.tag.agents.some((x) => roleKey(a).indexOf(x.toLowerCase()) > -1) && r.result.toUpperCase() !== "OK");
      const pairs = estPairs(done);
      return {
        role: a.role || a.name, colour: a.colour, done: done.length, doneRows: done.map(ref), redos: redone.length, redoRows: redone.map(ref),
        redoRate: rate(done, redone),
        failed: failed.length, estRatio: round1(median(pairs.map((p) => p.ratio))),
      };
    }) : null;

    // usage: routine runs a day for the last 14 days, split by department
    const days: any[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = addDays(today, -i);
      if (!hasRunData(d)) { days.push({ ymd: d, total: null, segments: null }); continue; }
      const dayRuns = runs.filter((r) => r.cloud && r.ymd === d);
      const seg: Record<string, number> = {};
      dayRuns.forEach((r) => {
        const k = r.tag && r.tag.dept.length === 1 ? (deptIds.indexOf(r.tag.dept[0]) > -1 ? r.tag.dept[0] : UNASSIGNED) : r.tag && r.tag.dept.length > 1 ? "shared" : "untagged";
        seg[k] = (seg[k] || 0) + 1;
      });
      const shown = f === "all" ? dayRuns.length : (seg[f] || 0);
      days.push({ ymd: d, total: dayRuns.length, shown, segments: seg });
    }
    const usage = { days, cap, headroom: cap != null && runs.length ? Math.max(0, cap - cloudRunsOn(today)) : null };

    // what we need more of: the registry's rules, each line with the numbers behind it
    const lines: { rule: string; text: string; numbers: string }[] = [];
    const notChecked: { rule: string; why: string }[] = [];
    const weekdays5 = (n: number) => lastWeekdays(today, n);
    const capDays = (n: number, over: (x: number) => boolean) => weekdays5(n).filter((d) => hasRunData(d) && over(cloudRunsOn(d))).length;
    const deptName = (d: string) => (departments.find((x) => x.id === d) || { name: d === UNASSIGNED ? "Unassigned" : d }).name;

    if (!rules.accessBound) notChecked.push({ rule: "access-bound", why: "No threshold found in Departments." });
    else dlist.forEach((d) => {
      const o = rows.filter((r) => r.dept === d && r.live && OPEN.includes(r.status.toLowerCase()));
      const acc = o.filter((r) => r.block && ACCESS_BLOCKS.indexOf(r.block.type) > -1);
      if (o.length && acc.length / o.length > rules.accessBound!.share) {
        const labels = Array.from(new Set(acc.map((r) => r.block!.label))).slice(0, 3).join("; ");
        lines.push({ rule: "access-bound", text: `${deptName(d)} needs access, not runs: ${acc.length} of ${o.length} open rows wait on ${labels}.`, numbers: `${acc.length} of ${o.length} open rows blocked on access; threshold: ${rules.accessBound!.text}` });
      }
    });
    if (!rules.shortOfRuns) notChecked.push({ rule: "short of runs", why: "No threshold found in Departments." });
    else if (cap == null) notChecked.push({ rule: "short of runs", why: "No routine cap found in Tools." });
    else if (!runs.length) notChecked.push({ rule: "short of runs", why: "The run log has no lines yet." });
    else dlist.forEach((d) => {
      const o = rows.filter((r) => r.dept === d && r.live && OPEN.includes(r.status.toLowerCase()) && r.ageDays != null);
      if (!o.length) return;
      const avg = o.reduce((s, r) => s + r.ageDays!, 0) / o.length;
      const atCap = capDays(rules.shortOfRuns!.of, (x) => x >= cap);
      if (avg > rules.shortOfRuns!.ageDays && atCap >= rules.shortOfRuns!.days) {
        lines.push({ rule: "short of runs", text: `${deptName(d)} needs more runs: its open rows average ${round1(avg)} days old and runs hit the cap on ${atCap} of the last ${rules.shortOfRuns!.of} weekdays.`, numbers: `average age ${round1(avg)} days over ${o.length} rows; cap ${cap} reached on ${atCap} days` });
      }
    });
    if (!rules.briefQuality) notChecked.push({ rule: "brief quality", why: "No threshold found in Departments." });
    else if (!directorRuns.length) notChecked.push({ rule: "brief quality", why: "No DIRECTOR lines in the run log yet, so no row is tied to a specialist." });
    else input.agents.forEach((a) => {
      const since = addDays(today, -rules.briefQuality!.windowDays + 1);
      const worked = rowsForAgent(roleKey(a), since);
      const done = worked.filter((r) => r.status.toLowerCase() === "done" && r.decided.slice(0, 10) >= since);
      const redone = redoRows(worked, since);
      const denom = new Set(done.map((r) => r.id).concat(redone.map((r) => r.id))).size;
      if (denom && redone.length / denom > rules.briefQuality!.rate) {
        lines.push({ rule: "brief quality", text: `${a.role || a.name} briefs need work: ${redone.length} of ${denom} rows sent back for a redo in ${rules.briefQuality!.windowDays} days.`, numbers: `redo rate ${Math.round((redone.length / denom) * 100)}% against ${rules.briefQuality!.label}` });
      }
    });
    if (!rules.nearCap) notChecked.push({ rule: "near the cap", why: "No threshold found in Departments." });
    else if (!runs.length) notChecked.push({ rule: "near the cap", why: "The run log has no lines yet." });
    else {
      const over = capDays(rules.nearCap.of, (x) => x > rules.nearCap!.runs);
      if (over >= rules.nearCap.days) lines.push({ rule: "near the cap", text: `Near the cap: move one department to once a day or turn on extra usage.`, numbers: `above ${rules.nearCap.runs} routine runs on ${over} of the last ${rules.nearCap.of} weekdays` });
    }

    return { strip, director, roster, demand, throughput: { byDept: throughputDept, byAgent: throughputAgent }, usage, needs: { lines, notChecked } };
  };

  const filters = ["all"].concat(deptIds, [UNASSIGNED]);
  const views: Record<string, ReturnType<typeof view>> = {};
  filters.forEach((f) => { views[f] = view(f); });

  return {
    registryFound, departments, rules, cap, monday,
    sources: {
      ledger: input.ledgerMd != null, ledgerRows: ledgerRows.length, runLines: runs.length, directorLines: directorRuns.length,
      archiveApprovals: input.archiveApprovals.length, archiveRunLogs: input.archiveRunLogs.length, rows: rows.length,
    },
    claims: claims.filter((c) => c.live || c.stale).map((c) => ({ ...c, title: titleOf(c.key) })),
    lanes, views,
  };
}
