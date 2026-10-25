// The Leads area: reading and writing the Owlbridge pipeline table in the vault.
//
// Two writers share that table: The operator's clicks here, and the runs (the Director). So every
// write follows the same per-row pattern the Approvals queue uses in api.mts (reviewAction,
// setApprovalPriority): read the file fresh, find the one row by its id, change only the cells
// this action owns, and write it back with the sha that was read. If the file moved in between,
// GitHub refuses the write (409 or 422) and the whole thing is re-read and re-applied, so a run
// that edited another row in the meantime keeps its edit, and a run that edited the same row
// is overwritten only in the cells this click set (the later write wins those). Every other
// cell is written back exactly as it was read, escaped pipes and all.
//
// Everything here is pure (text in, text out) apart from writeRow, which takes the read and
// write functions it needs, so tests/leads.test.mjs can run it without GitHub.

export const LEADS_DIR = "Wiki/Ventures/Owlbridge/Owlbridge growth/";
export const PIPELINE_PATH = LEADS_DIR + "Owlbridge pipeline.md";
export const STATION_PATH = LEADS_DIR + "Owlbridge lead gen station.md";
export const ACTIVITY_PATH = LEADS_DIR + "Owlbridge activity log.md";
export const RESEARCH_PREFIX = "Owlbridge lead list";

// In order, as the pipeline note lists them.
export const LEAD_STATUSES = ["researched", "drafted", "sent", "replied", "call booked", "proposal", "won", "lost", "opted out", "disqualified"];
// Out of play: not counted as in play, and never shown as due.
export const CLOSED_STATUSES = ["lost", "opted out", "disqualified"];

// header name in the vault -> field name on the wire
const FIELDS: Record<string, string> = {
  "id": "id", "company": "company", "segment": "segment", "tier": "tier", "score": "score",
  "contact": "contact", "email": "email", "status": "status", "last touch": "lastTouch",
  "next step": "nextStep", "next date": "nextDate", "source": "source",
};
// the order a new row's cells take when a column is missing from the header
const DEFAULT_HEADER = ["id", "company", "segment", "tier", "score", "contact", "email", "status", "last touch", "next step", "next date", "source"];

export type Lead = {
  id: string; company: string; segment: string; tier: string; score: string; contact: string;
  email: string; status: string; lastTouch: string; nextStep: string; nextDate: string; source: string;
  line: number; extra: Record<string, string>;
};
export type Applied = { ok: true; text: string; unchanged?: boolean; id?: string; before?: Record<string, string>; changed?: string[] } | { ok: false; status: number; error: string };

const YMD = /^\d{4}-\d{2}-\d{2}$/;
export const validDate = (d: string) => d === "" || (YMD.test(d) && !Number.isNaN(Date.parse(d + "T00:00:00Z")));

// ---------- cells ----------

// Split a table line into its raw cells. A pipe escaped as \| stays inside its cell (Obsidian
// renders it as a pipe), so a row with one is not read as having an extra column.
export function splitRow(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  const cells: string[] = [];
  let cur = "";
  for (let i = 1; i < t.length; i++) {
    const c = t[i];
    if (c === "\\" && t[i + 1] === "|") { cur += "\\|"; i++; continue; }
    if (c === "|") { cells.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) cells.push(cur.trim()); // a row missing its closing pipe
  return cells;
}
export const cellText = (raw: string) => String(raw || "").replace(/\\\|/g, "|");
// A value written into a cell: one line, and a pipe escaped rather than breaking the row.
export const cellValue = (t: string) => String(t || "").replace(/\s*[\r\n]+\s*/g, " ").replace(/\s{2,}/g, " ").trim().replace(/\\?\|/g, "\\|");
const isRule = (cells: string[]) => cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "");
const joinRow = (cells: string[]) => `| ${cells.join(" | ")} |`;

// ---------- the pipeline table ----------

type Table = { header: string[]; headerAt: number; lastAt: number; rows: { at: number; cells: string[] }[] };

// The first table under "## Leads".
function leadTable(lines: string[]): Table | null {
  const h = lines.findIndex((l) => l.trim().toLowerCase() === "## leads");
  if (h < 0) return null;
  let header: string[] | null = null, headerAt = -1, lastAt = -1;
  const rows: { at: number; cells: string[] }[] = [];
  for (let i = h + 1; i < lines.length; i++) {
    if (/^#{1,2} /.test(lines[i])) break;
    const cells = splitRow(lines[i]);
    if (!cells) { if (header) break; continue; }
    if (!header) { header = cells.map((c) => cellText(c).toLowerCase()); headerAt = lastAt = i; continue; }
    lastAt = i;
    if (isRule(cells)) continue;
    rows.push({ at: i, cells });
  }
  return header ? { header, headerAt, lastAt, rows } : null;
}

function toLead(header: string[], cells: string[], at: number): Lead {
  const lead: any = { id: "", company: "", segment: "", tier: "", score: "", contact: "", email: "", status: "", lastTouch: "", nextStep: "", nextDate: "", source: "", line: at, extra: {} };
  header.forEach((name, i) => {
    const v = cellText(cells[i] || "");
    if (FIELDS[name]) lead[FIELDS[name]] = v;
    else if (name) lead.extra[name] = v;
  });
  lead.status = lead.status.toLowerCase();
  return lead as Lead;
}

export function parseLeads(md: string): { found: boolean; header: string[]; leads: Lead[] } {
  const t = leadTable(md.split("\n"));
  if (!t) return { found: false, header: [], leads: [] };
  return { found: true, header: t.header, leads: t.rows.map((r) => toLead(t.header, r.cells, r.at)).filter((l) => l.id) };
}

export const inPlay = (l: { status: string }) => !CLOSED_STATUSES.includes(l.status);
export const isDue = (l: { status: string; nextDate: string }, today: string) => inPlay(l) && YMD.test(l.nextDate) && l.nextDate <= today;

// Change named cells of one row, found by id, leaving every other cell exactly as read.
function editRow(text: string, id: string, set: Record<string, string>): Applied {
  const lines = text.split("\n");
  const t = leadTable(lines);
  if (!t) return { ok: false, status: 400, error: "The Leads table is missing from Owlbridge pipeline." };
  const row = t.rows.find((r) => cellText(r.cells[t.header.indexOf("id")] || "") === id);
  if (!row) return { ok: false, status: 404, error: `Lead ${id} is no longer in Owlbridge pipeline. Refresh and try again.` };
  const cells = row.cells.slice();
  while (cells.length < t.header.length) cells.push("");
  const before: Record<string, string> = {};
  t.header.forEach((name, i) => { before[name] = cellText(cells[i] || ""); });
  const changed: string[] = [];
  for (const [name, value] of Object.entries(set)) {
    const i = t.header.indexOf(name);
    if (i < 0) return { ok: false, status: 400, error: `The Leads table has no "${name}" column.` };
    const v = cellValue(value);
    if (cells[i] !== v) { cells[i] = v; changed.push(name); }
  }
  if (!changed.length) return { ok: true, text, unchanged: true, id, before, changed };
  lines[row.at] = joinRow(cells);
  return { ok: true, text: lines.join("\n"), id, before, changed };
}

// A status move: the status, and today's date as the last touch.
export function applyStatus(text: string, id: string, status: string, today: string): Applied {
  const s = String(status || "").toLowerCase();
  if (!LEAD_STATUSES.includes(s)) return { ok: false, status: 400, error: "That is not a pipeline status." };
  return editRow(text, id, { "status": s, "last touch": today });
}

export function applyNext(text: string, id: string, nextStep: string, nextDate: string): Applied {
  if (!validDate(nextDate)) return { ok: false, status: 400, error: "The next date must be YYYY-MM-DD, or blank." };
  return editRow(text, id, { "next step": nextStep, "next date": nextDate });
}

// The record page's Fields card: every editable cell in one save. Company and id are the row's
// identity (research is matched on the company name), so they are not editable here; status has
// its own path. Only the keys sent are touched.
const EDITABLE: Record<string, string> = {
  segment: "segment", tier: "tier", score: "score", contact: "contact", email: "email",
  source: "source", nextStep: "next step", nextDate: "next date",
};
export function applyFields(text: string, id: string, input: Record<string, unknown>): Applied {
  const set: Record<string, string> = {};
  for (const [k, name] of Object.entries(EDITABLE)) {
    if (input[k] === undefined || input[k] === null) continue;
    set[name] = String(input[k]).trim();
  }
  if (!Object.keys(set).length) return { ok: false, status: 400, error: "Nothing to save." };
  if (set["score"] && !/^\d{1,3}$/.test(set["score"])) return { ok: false, status: 400, error: "The score is a whole number out of 100, or blank." };
  if (set["score"] && +set["score"] > 100) return { ok: false, status: 400, error: "The score is out of 100." };
  if (set["next date"] !== undefined && !validDate(set["next date"])) return { ok: false, status: 400, error: "The next date must be YYYY-MM-DD, or blank." };
  return editRow(text, id, set);
}

// A logged touch (call, email, meeting, note): today becomes the last touch.
export function applyTouch(text: string, id: string, today: string): Applied {
  return editRow(text, id, { "last touch": today });
}

// Done on a Today row: the step is finished, so today is the last touch and the next step and
// date are replaced in the same save.
export function applyDone(text: string, id: string, nextStep: string, nextDate: string, today: string): Applied {
  if (!validDate(nextDate)) return { ok: false, status: 400, error: "The next date must be YYYY-MM-DD, or blank." };
  return editRow(text, id, { "last touch": today, "next step": nextStep, "next date": nextDate });
}

export const BULK_OPS = ["status", "nextDate", "nextStep"];
export type BulkChange = { id: string; before: Record<string, string>; changed: string[] };

// One edit applied to several rows in one write. Opted out is refused here: it adds a company to
// the suppression list, which is done one lead at a time with its own confirmation.
export function applyBulk(text: string, ids: string[], op: string, value: string, today: string): Applied & { changes?: BulkChange[]; missing?: string[]; kept?: string[] } {
  if (!BULK_OPS.includes(op)) return { ok: false, status: 400, error: "That is not a bulk action." };
  const list = Array.from(new Set(ids.map((i) => String(i || "").trim()).filter(Boolean)));
  if (!list.length) return { ok: false, status: 400, error: "No leads selected." };
  const v = String(value || "").trim();
  if (op === "status") {
    if (!LEAD_STATUSES.includes(v.toLowerCase())) return { ok: false, status: 400, error: "That is not a pipeline status." };
    if (v.toLowerCase() === "opted out") return { ok: false, status: 400, error: "Opt leads out one at a time, from the record, so each one is confirmed and suppressed." };
  }
  if (op === "nextDate" && !validDate(v)) return { ok: false, status: 400, error: "The next date must be YYYY-MM-DD, or blank." };
  let cur = text;
  const changes: BulkChange[] = [], missing: string[] = [], kept: string[] = [];
  const optedOut = new Set(op === "status" ? (parseLeads(text).leads.filter((l) => l.status === "opted out").map((l) => l.id)) : []);
  for (const id of list) {
    // A lead that has opted out stays opted out: a bulk status move skips it (and names it), so a
    // suppressed company is never put back into play by a tick in the list.
    if (optedOut.has(id)) { kept.push(id); continue; }
    const set: Record<string, string> = op === "status" ? { "status": v.toLowerCase(), "last touch": today } : op === "nextDate" ? { "next date": v } : { "next step": v };
    const r = editRow(cur, id, set);
    if (r.ok === false) { if (r.status === 404) { missing.push(id); continue; } return r; }
    if (r.unchanged) continue;
    cur = r.text;
    changes.push({ id, before: r.before || {}, changed: r.changed || [] });
  }
  if (!changes.length) return { ok: true, text, unchanged: true, changes, missing, kept };
  return { ok: true, text: cur, changes, missing, kept };
}

export const normName = (t: string) => String(t || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
export const sameCompany = (a: string, b: string) => {
  const x = normName(a), y = normName(b);
  return Boolean(x && y) && (x === y || x.startsWith(y + " ") || y.startsWith(x + " "));
};

export function leadId(company: string, taken: Set<string>): string {
  const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28).replace(/-+$/, "") || "lead";
  const base = `L-${slug}`;
  let id = base, k = 2;
  while (taken.has(id)) id = `${base}-${k++}`;
  return id;
}

export type NewLead = { company: string; segment?: string; tier?: string; score?: string; contact?: string; email?: string; source?: string; nextStep?: string; nextDate?: string };

// A new row at the foot of the Leads table, status researched.
export function applyAdd(text: string, input: NewLead, suppressed: string[] = []): Applied {
  const company = cellValue(input.company || "");
  if (!company) return { ok: false, status: 400, error: "A lead needs a company." };
  const score = String(input.score || "").trim();
  if (score && !/^\d{1,3}$/.test(score)) return { ok: false, status: 400, error: "The score is a whole number out of 100, or blank." };
  const nextDate = String(input.nextDate || "").trim();
  if (!validDate(nextDate)) return { ok: false, status: 400, error: "The next date must be YYYY-MM-DD, or blank." };
  if (suppressed.some((s) => sameCompany(s, input.company))) return { ok: false, status: 409, error: `${input.company} is on the suppression list and is never contacted again.` };
  const lines = text.split("\n");
  const t = leadTable(lines);
  if (!t) return { ok: false, status: 400, error: "The Leads table is missing from Owlbridge pipeline." };
  const idAt = t.header.indexOf("id"), coAt = t.header.indexOf("company");
  if (idAt < 0 || coAt < 0) return { ok: false, status: 400, error: "The Leads table has no id or company column." };
  const dup = t.rows.find((r) => normName(cellText(r.cells[coAt] || "")) === normName(input.company));
  if (dup) return { ok: false, status: 409, error: `${cellText(dup.cells[coAt])} is already in the pipeline as ${cellText(dup.cells[idAt])}.` };
  const id = leadId(input.company, new Set(t.rows.map((r) => cellText(r.cells[idAt] || ""))));
  const values: Record<string, string> = {
    "id": id, "company": company, "segment": input.segment || "", "tier": input.tier || "", "score": score,
    "contact": input.contact || "", "email": input.email || "", "status": "researched", "last touch": "",
    "next step": input.nextStep || "", "next date": nextDate, "source": input.source || "platform",
  };
  const cells = t.header.map((name) => cellValue(values[name] || ""));
  lines.splice(t.lastAt + 1, 0, joinRow(cells));
  return { ok: true, text: lines.join("\n"), id };
}

// ---------- the suppression list, in the lead gen station note ----------
// The station note says: "kept as a table in this note once the first opt-out arrives, company
// and address only, never deleted". So the section and its table are created on the first
// opt-out, and a row is only ever added.

const SUPP_HEAD = "## Suppression list";

export function parseSuppression(md: string): { company: string; address: string }[] {
  const lines = md.split("\n");
  const h = lines.findIndex((l) => l.trim().toLowerCase() === SUPP_HEAD.toLowerCase());
  if (h < 0) return [];
  const out: { company: string; address: string }[] = [];
  let header = false;
  for (let i = h + 1; i < lines.length; i++) {
    if (/^#{1,2} /.test(lines[i])) break;
    const cells = splitRow(lines[i]);
    if (!cells) { if (header) break; continue; }
    if (!header) { header = true; continue; }
    if (isRule(cells)) continue;
    out.push({ company: cellText(cells[0] || ""), address: cellText(cells[1] || "") });
  }
  return out;
}

export const looksLikeEmail = (e: string) => /^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/.test(String(e || "").trim());

export function applySuppress(text: string, company: string, address: string): Applied & { added?: boolean } {
  if (!cellValue(company)) return { ok: false, status: 400, error: "No company to add to the suppression list." };
  if (parseSuppression(text).some((s) => sameCompany(s.company, company) && (!s.address || !address || s.address.toLowerCase() === address.toLowerCase()))) {
    return { ok: true, text, unchanged: true, added: false };
  }
  const row = joinRow([cellValue(company), cellValue(looksLikeEmail(address) ? address : "")]);
  const lines = text.split("\n");
  const h = lines.findIndex((l) => l.trim().toLowerCase() === SUPP_HEAD.toLowerCase());
  if (h >= 0) {
    let headerAt = -1, lastAt = -1;
    for (let i = h + 1; i < lines.length; i++) {
      if (/^#{1,2} /.test(lines[i])) break;
      if (splitRow(lines[i])) { if (headerAt < 0) headerAt = i; lastAt = i; }
      else if (headerAt >= 0) break;
    }
    if (lastAt >= 0) lines.splice(lastAt + 1, 0, row);
    else lines.splice(h + 1, 0, "", "| company | address |", "|---|---|", row);
    return { ok: true, text: lines.join("\n"), added: true };
  }
  // First opt-out: a new section above Open, else above Related, else at the end.
  let at = lines.findIndex((l) => l.trim().toLowerCase() === "## open");
  if (at < 0) at = lines.findIndex((l) => l.trim().toLowerCase() === "## related");
  const block = [SUPP_HEAD, "", "Company and address only, never deleted. A company on this list is never contacted again. Added by the platform's Leads area when a lead is opted out.", "", "| company | address |", "|---|---|", row, ""];
  if (at < 0) {
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", ...block);
  } else {
    lines.splice(at, 0, ...block);
  }
  return { ok: true, text: lines.join("\n"), added: true };
}

// ---------- research rows, from the lead list notes ----------

type ResearchRow = { path: string; heading: string; fields: [string, string][] };

// Every table row in a lead list note (or the station note) whose Company cell names this company, with the heading
// it sits under (the tier table, the outreach log).
export function researchRows(company: string, notes: { path: string; text: string }[]): ResearchRow[] {
  const out: ResearchRow[] = [];
  for (const n of notes) {
    const lines = n.text.split("\n");
    let heading = "", header: string[] | null = null;
    for (const l of lines) {
      const hm = l.match(/^#{1,4} (.+)$/);
      if (hm) { heading = hm[1].trim(); header = null; continue; }
      const cells = splitRow(l);
      if (!cells) { header = null; continue; }
      if (!header) { header = cells.map(cellText); continue; }
      if (isRule(cells)) continue;
      const co = header.findIndex((h) => h.toLowerCase() === "company");
      if (co < 0 || !sameCompany(cellText(cells[co] || ""), company)) continue;
      out.push({ path: n.path, heading, fields: header.map((h, i) => [h, cellText(cells[i] || "")] as [string, string]).filter(([h, v]) => h && v) });
    }
  }
  return out;
}

// ---------- the activity log: Owlbridge activity log.md, append-only ----------
// One table under "## Activity": at (YYYY-MM-DD HH:MM, London), lead (L- id), type, summary, by.
// The platform and the runs only ever add a line at the foot of it, and the vault gives the file a
// union merge, so two writers appending between syncs both keep their lines. For the same reason
// nothing here touches the note's frontmatter: two different "updated" values under a union merge
// would leave the note with two updated lines.

export const ACTIVITY_TYPES = ["note", "call", "email", "meeting", "status", "research", "draft", "system"];
// what the record page's composer offers
export const LOG_TYPES = ["note", "call", "email", "meeting"];
export type Activity = { at: string; lead: string; type: string; summary: string; by: string; line: number };
export type ActivityEntry = { at: string; lead: string; type: string; summary: string; by: string };

const ACT_HEAD = "## Activity";
const ACT_HEADER = "| at | lead | type | summary | by |";

// The table under "## Activity", or if there is none, the first table whose header has at and lead.
function activityTable(lines: string[]): Table | null {
  const scan = (from: number, stopAtHeading: boolean): Table | null => {
    let header: string[] | null = null, headerAt = -1, lastAt = -1;
    const rows: { at: number; cells: string[] }[] = [];
    for (let i = from; i < lines.length; i++) {
      if (stopAtHeading && /^#{1,2} /.test(lines[i])) break;
      const cells = splitRow(lines[i]);
      if (!cells) { if (header) break; continue; }
      if (!header) { header = cells.map((c) => cellText(c).toLowerCase()); headerAt = lastAt = i; continue; }
      lastAt = i;
      if (isRule(cells)) continue;
      rows.push({ at: i, cells });
    }
    return header ? { header, headerAt, lastAt, rows } : null;
  };
  const h = lines.findIndex((l) => l.trim().toLowerCase() === ACT_HEAD.toLowerCase());
  if (h >= 0) return scan(h + 1, true);
  for (let i = 0; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    if (!cells) continue;
    const hd = cells.map((c) => cellText(c).toLowerCase());
    if (hd.includes("at") && hd.includes("lead")) return scan(i, false);
    // skip the rest of a table that is not this one
    while (i + 1 < lines.length && splitRow(lines[i + 1])) i++;
  }
  return null;
}

// Tolerant: an empty or missing file, blank cells and a row with fewer cells all read cleanly.
export function parseActivity(md: string | undefined | null): { found: boolean; rows: Activity[] } {
  if (!md || !md.trim()) return { found: false, rows: [] };
  const t = activityTable(md.split("\n"));
  if (!t) return { found: false, rows: [] };
  const col = (n: string) => t.header.indexOf(n);
  const [ia, il, it, is, ib] = [col("at"), col("lead"), col("type"), col("summary"), col("by")];
  const get = (cells: string[], i: number) => (i < 0 ? "" : cellText(cells[i] || "").trim());
  const rows = t.rows.map((r) => ({
    at: get(r.cells, ia), lead: get(r.cells, il), type: get(r.cells, it).toLowerCase(),
    summary: get(r.cells, is), by: get(r.cells, ib), line: r.at,
  })).filter((a) => a.lead || a.summary);
  return { found: true, rows };
}

// A summary is one line with no pipes, as the note asks, rather than an escaped pipe.
export const activityText = (t: string, max = 300) => String(t || "").replace(/\s*[\r\n]+\s*/g, " ").replace(/\\?\|/g, "/").replace(/\s{2,}/g, " ").trim().slice(0, max);
export const activityRow = (e: ActivityEntry) =>
  joinRow([activityText(e.at, 16), activityText(e.lead, 80), activityText(e.type, 20).toLowerCase(), activityText(e.summary), activityText(e.by, 40)]);

function activitySkeleton(day: string): string[] {
  return [
    "---", "title: Owlbridge activity log", "aliases: [Owlbridge activity, Lead activity, Lead timeline]", "type: log",
    "parent: \"[[Owlbridge pipeline]]\"", "owner: the operator", ...(YMD.test(day) ? ["updated: " + day] : []), "tags:", "  - venture/owlbridge", "  - domain/lead-gen", "---", "",
    "# Owlbridge activity log", "",
    "Every touch on every Owlbridge lead, one line each, newest at the bottom. Created by the platform's Leads area on its first write. Nothing is ever edited or removed.", "",
    ACT_HEAD, "", ACT_HEADER, "|---|---|---|---|---|",
  ];
}

// New lines at the foot of the Activity table. On an empty or missing note the note is created;
// on a note with no Activity table, the section goes above Related, or at the end.
export function applyAppendActivity(text: string | null | undefined, entries: ActivityEntry[]): Applied {
  const good = entries.filter((e) => e && activityText(e.lead) && activityText(e.summary));
  if (!good.length) return { ok: false, status: 400, error: "An activity line needs a lead and a summary." };
  const bad = good.find((e) => !ACTIVITY_TYPES.includes(String(e.type || "").toLowerCase()));
  if (bad) return { ok: false, status: 400, error: `"${bad.type}" is not an activity type.` };
  const rows = good.map(activityRow);
  if (!text || !text.trim()) return { ok: true, text: [...activitySkeleton(activityText(good[0].at).slice(0, 10)), ...rows, ""].join("\n") };
  const lines = text.split("\n");
  const t = activityTable(lines);
  if (t) {
    lines.splice(t.lastAt + 1, 0, ...rows);
    return { ok: true, text: lines.join("\n") };
  }
  const block = [ACT_HEAD, "", ACT_HEADER, "|---|---|---|---|---|", ...rows, ""];
  const at = lines.findIndex((l) => l.trim().toLowerCase() === "## related");
  if (at < 0) {
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", ...block);
  } else lines.splice(at, 0, ...block);
  return { ok: true, text: lines.join("\n") };
}

// What a pipeline edit says in the log, one line per save.
const LABEL: Record<string, string> = { "next step": "next step", "next date": "next date", "last touch": "last touch" };
export function describeEdit(before: Record<string, string>, after: Record<string, string>, changed: string[]): string {
  const shown = changed.filter((c) => c !== "last touch");
  if (!shown.length) return "";
  const parts: string[] = [];
  if (shown.includes("status")) parts.push(`Status ${before["status"] || "blank"} to ${after["status"]}`);
  const next = shown.includes("next step") || shown.includes("next date");
  if (next) {
    const step = after["next step"] ?? before["next step"] ?? "", date = after["next date"] ?? before["next date"] ?? "";
    parts.push(step || date ? `Next step: ${step || "none written"}${date ? " by " + date : ", no date"}` : "Next step cleared");
  }
  const rest = shown.filter((c) => c !== "status" && c !== "next step" && c !== "next date").map((c) => LABEL[c] || c);
  if (rest.length) parts.push("Changed " + (rest.length === 1 ? rest[0] : rest.slice(0, -1).join(", ") + " and " + rest[rest.length - 1]));
  return parts.join("; ");
}

// A record's history, newest first, grouped by day. A run of status and system lines written
// in the same minute by the same hand is one event, the way Attio and Twenty group field changes.
export type TimelineItem = { at: string; time: string; type: string; summary: string; by: string; count: number };
export function groupTimeline(rows: { at: string; type: string; summary: string; by: string }[]): { day: string; items: TimelineItem[] }[] {
  const items: TimelineItem[] = [];
  const merges = (t: string) => t === "status" || t === "system";
  for (const r of rows) {
    const prev = items[items.length - 1];
    if (prev && merges(prev.type) && merges(r.type) && prev.at === r.at && prev.by === r.by) {
      prev.summary += "; " + r.summary; prev.count++; if (r.type === "status") prev.type = "status";
      continue;
    }
    items.push({ at: r.at, time: /\d{2}:\d{2}$/.test(r.at) ? r.at.slice(-5) : "", type: r.type, summary: r.summary, by: r.by, count: 1 });
  }
  // newest first: by timestamp, and file order (which is time order) for a tie
  const ordered = items.map((it, i) => ({ it, i })).sort((a, b) => (a.it.at < b.it.at ? 1 : a.it.at > b.it.at ? -1 : b.i - a.i)).map((x) => x.it);
  const days: { day: string; items: TimelineItem[] }[] = [];
  for (const it of ordered) {
    const day = /^\d{4}-\d{2}-\d{2}/.test(it.at) ? it.at.slice(0, 10) : "";
    const last = days[days.length - 1];
    if (last && last.day === day) last.items.push(it); else days.push({ day, items: [it] });
  }
  return days;
}

// ---------- derived figures ----------

export const STAGES = LEAD_STATUSES.slice(0, LEAD_STATUSES.indexOf("won") + 1);
export const CONVERSION_FROM = 10;

// Researched to won. "Reached" counts a lead at that stage or further along; closed rows are left
// out because the table does not say how far they got. Conversion to the next stage shows only
// once the stage has reached CONVERSION_FROM leads, so a rate is never read off a handful.
export function funnel(leads: { status: string }[]) {
  const idx = (s: string) => STAGES.indexOf(s);
  const open = leads.filter((l) => idx(l.status) >= 0);
  return STAGES.map((stage, i) => {
    const reached = open.filter((l) => idx(l.status) >= i).length;
    const nextReached = i + 1 < STAGES.length ? open.filter((l) => idx(l.status) >= i + 1).length : null;
    return {
      stage, count: open.filter((l) => l.status === stage).length, reached,
      conversion: nextReached !== null && reached >= CONVERSION_FROM ? Math.round((nextReached / reached) * 100) : null,
    };
  });
}

// Whole days from the last touch to today, or null with no last touch.
export function touchDays(lastTouch: string, today: string): number | null {
  if (!YMD.test(lastTouch || "") || !YMD.test(today)) return null;
  return Math.round((Date.parse(today + "T00:00:00Z") - Date.parse(lastTouch + "T00:00:00Z")) / 86400000);
}
// Amber after 7 days, red after 14, and only for a lead still being worked.
export function staleLevel(days: number | null, status: string): "" | "amber" | "red" {
  if (days === null || CLOSED_STATUSES.includes(status) || status === "won") return "";
  return days > 14 ? "red" : days > 7 ? "amber" : "";
}

// The three Owlbridge emails and their day offsets. An email line counts towards a step when its
// summary starts "Email 1", "Email 2" or "Email 3", as the activity log note says.
export const SEQUENCE_DAYS = [1, 4, 10];
export const emailStep = (a: { type: string; summary: string }) => {
  if (a.type !== "email") return 0;
  const m = String(a.summary || "").match(/^email\s*([123])\b/i);
  return m ? +m[1] : 0;
};
const addDays = (ymd: string, n: number) => { const d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export function sequencePosition(lead: { status: string }, rows: { at: string; type: string; summary: string }[]) {
  let step = 0, on = "";
  for (const r of rows) { const n = emailStep(r); if (n && n >= step) { step = n; on = r.at.slice(0, 10); } }
  if (step) {
    if (step >= SEQUENCE_DAYS.length) return { step, sentOn: on, next: 0, due: "", words: `Email ${step} sent on ${on}. The sequence is complete.` };
    const due = YMD.test(on) ? addDays(on, SEQUENCE_DAYS[step] - SEQUENCE_DAYS[step - 1]) : "";
    return { step, sentOn: on, next: step + 1, due, words: `Email ${step} sent on ${on}. Email ${step + 1} is due ${due || "once a send date is logged"}.` };
  }
  if (lead.status === "drafted") return { step: 0, sentOn: "", next: 1, due: "", words: "Email 1 is drafted and waiting to send. Nothing is sent from here." };
  if (STAGES.indexOf(lead.status) >= STAGES.indexOf("sent")) return { step: 0, sentOn: "", next: 0, due: "", words: `Status is ${lead.status}, but no email line is logged yet, so the step is unknown.` };
  return { step: 0, sentOn: "", next: 0, due: "", words: "Not in the sequence yet." };
}

// ---------- the sequence page ----------
// The three emails as the drafts note words them (read only: the words are edited in the vault),
// and per step: how many leads have that email logged as sent, how many of those whose last email
// was this one have replied or opted out, and who is waiting on it now.

export const OUTREACH_PATH = LEADS_DIR + "Owlbridge outreach drafts.md";
// At or past replied: the same set the top strip counts as replies.
export const REPLIED_STATUSES = ["replied", "call booked", "proposal", "won"];
export const SENT_STATUSES = ["sent", ...REPLIED_STATUSES];

export type DraftStep = { step: number; day: number; heading: string; subject: string; excerpt: string; words: string };

// "## Email 2, day 4 (in the same thread)" and the lines under it, up to the next heading.
export function parseDrafts(md: string | undefined | null): { found: boolean; steps: DraftStep[] } {
  const steps: DraftStep[] = [];
  if (!md) return { found: false, steps };
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+Email\s+([123])\b(.*)$/i);
    if (!m) continue;
    const step = +m[1], dm = m[2].match(/day\s+(\d{1,3})/i);
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && !/^#{1,2} /.test(lines[j]); j++) body.push(lines[j]);
    let subject = "";
    const kept = body.filter((l) => { const sm = l.match(/^\*\*Subject:\*\*\s*(.*)$/i); if (sm) { subject = sm[1].trim(); return false; } return true; });
    const words = kept.join("\n").replace(/^\s+|\s+$/g, "");
    const paras = words.split(/\n\s*\n/).map((x) => x.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
    // The first paragraph that says something: not the greeting, not a lone placeholder, not the sign-off.
    const excerpt = paras.find((x) => !/^hi\b/i.test(x) && !/^\{\{[^}]+\}\}$/.test(x) && !/^(the )?operator\b/i.test(x)) || "";
    steps.push({ step, day: dm ? +dm[1] : SEQUENCE_DAYS[step - 1], heading: lines[i].replace(/^##\s+/, "").trim(), subject, excerpt, words });
  }
  steps.sort((a, b) => a.step - b.step);
  return { found: steps.length > 0, steps };
}

type SeqLead = { id: string; company: string; status: string };
type SeqRow = { at: string; lead: string; type: string; summary: string };

// The furthest email logged for a lead (0 for none), and the date it went.
function lastEmail(rows: SeqRow[]): { step: number; on: string } {
  let step = 0, on = "";
  for (const r of rows) { const n = emailStep(r); if (n && n >= step) { step = n; on = r.at.slice(0, 10); } }
  return { step, on };
}

export function sequenceView(leads: SeqLead[], rows: SeqRow[], draftsMd: string | undefined | null) {
  const drafts = parseDrafts(draftsMd);
  const byLead = new Map<string, SeqRow[]>();
  for (const r of rows) { if (!byLead.has(r.lead)) byLead.set(r.lead, []); byLead.get(r.lead)!.push(r); }
  const info = leads.map((l) => {
    const mine = byLead.get(l.id) || [];
    const sentSteps = new Set(mine.map(emailStep).filter(Boolean));
    return { l, mine, sentSteps, last: lastEmail(mine) };
  });
  const steps = [1, 2, 3].map((n) => {
    const d = drafts.steps.find((x) => x.step === n);
    const day = d ? d.day : SEQUENCE_DAYS[n - 1];
    const sent = info.filter((x) => x.sentSteps.has(n));
    const endedHere = info.filter((x) => x.last.step === n);
    const replied = endedHere.filter((x) => REPLIED_STATUSES.includes(x.l.status));
    const optedOut = endedHere.filter((x) => x.l.status === "opted out");
    // Waiting: email 1 waits on a drafted lead with no email logged; a later email waits on a lead
    // still at sent whose last logged email is the one before it.
    const waiting = n === 1
      ? info.filter((x) => x.last.step === 0 && x.l.status === "drafted")
      : info.filter((x) => x.last.step === n - 1 && x.l.status === "sent");
    const prevDay = n > 1 ? (drafts.steps.find((x) => x.step === n - 1)?.day ?? SEQUENCE_DAYS[n - 2]) : 0;
    return {
      step: n, day, waitDays: n > 1 ? day - prevDay : 0,
      heading: d ? d.heading : `Email ${n}, day ${day}`, subject: d ? d.subject : "", excerpt: d ? d.excerpt : "", words: d ? d.words : "",
      sent: sent.map((x) => x.l.id), replied: replied.map((x) => x.l.id), optedOut: optedOut.map((x) => x.l.id),
      waiting: waiting.map((x) => {
        const due = n > 1 && YMD.test(x.last.on) ? addDays(x.last.on, day - prevDay) : "";
        return { id: x.l.id, company: x.l.company, due };
      }),
    };
  });
  // At sent or further, but with no email line, so no step can be credited with it.
  const unlogged = info.filter((x) => x.last.step === 0 && SENT_STATUSES.includes(x.l.status)).map((x) => x.l.id);
  return { path: OUTREACH_PATH, found: drafts.found, steps, unlogged };
}

// ---------- the reports page ----------
// Counts by stage, tier, segment and source; the reply rate once REPLY_RATE_FROM are sent; the
// median days from sent to reply once MEDIAN_FROM have replied; leads touched per week. Every
// figure carries the ids it counts, so the page can open the rows. No pound values anywhere.

export const REPLY_RATE_FROM = 10;
export const MEDIAN_FROM = 5;
export const TOUCH_WEEKS = 8;
const dayOf = (at: string) => (/^\d{4}-\d{2}-\d{2}/.test(at || "") ? at.slice(0, 10) : "");
const mondayOf = (ymd: string) => { const d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
const dayGap = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);

export function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = nums.slice().sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

type ReportLead = { id: string; status: string; tier: string; segment: string; source: string };
function groupBy(leads: ReportLead[], key: (l: ReportLead) => string) {
  const m = new Map<string, string[]>();
  for (const l of leads) { const k = key(l) || "(blank)"; if (!m.has(k)) m.set(k, []); m.get(k)!.push(l.id); }
  return Array.from(m.entries()).map(([k, ids]) => ({ key: k, count: ids.length, ids })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

// When a lead was sent to and when it replied, from the activity log only: sent is its first email
// line or first status line moving it to sent; replied is the first status line after that moving
// it to replied, call booked, proposal or won. A lead missing either is not in the median.
export function replyTimes(rows: SeqRow[]): { sentOn: string; repliedOn: string } {
  let sentOn = "", repliedOn = "";
  const ordered = rows.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const r of ordered) {
    const d = dayOf(r.at);
    if (!d) continue;
    if (!sentOn && (emailStep(r) || (r.type === "status" && /\bto sent\b/i.test(r.summary)))) sentOn = d;
    else if (sentOn && !repliedOn && r.type === "status" && /\bto (replied|call booked|proposal|won)\b/i.test(r.summary)) repliedOn = d;
  }
  return { sentOn, repliedOn };
}

export function reportsView(leads: ReportLead[], rows: SeqRow[], today: string) {
  const ids = new Set(leads.map((l) => l.id));
  const byStage = LEAD_STATUSES.map((s) => { const m = leads.filter((l) => l.status === s).map((l) => l.id); return { key: s, count: m.length, ids: m }; });
  const other = leads.filter((l) => !LEAD_STATUSES.includes(l.status)).map((l) => l.id);
  if (other.length) byStage.push({ key: "(other status)", count: other.length, ids: other });
  const sent = leads.filter((l) => SENT_STATUSES.includes(l.status)).map((l) => l.id);
  const replied = leads.filter((l) => REPLIED_STATUSES.includes(l.status)).map((l) => l.id);
  const byLead = new Map<string, SeqRow[]>();
  for (const r of rows) { if (!ids.has(r.lead)) continue; if (!byLead.has(r.lead)) byLead.set(r.lead, []); byLead.get(r.lead)!.push(r); }
  const pairs: { id: string; days: number }[] = [];
  for (const [id, mine] of byLead) {
    const t = replyTimes(mine);
    if (t.sentOn && t.repliedOn) pairs.push({ id, days: dayGap(t.sentOn, t.repliedOn) });
  }
  // Touched: any line but a system one (a system line is a note being added or an edit to the
  // row, not contact with the lead). Weeks run Monday to Sunday, the newest last.
  const thisMonday = YMD.test(today) ? mondayOf(today) : "";
  const weeks = thisMonday ? Array.from({ length: TOUCH_WEEKS }, (_, i) => addDays(thisMonday, -7 * (TOUCH_WEEKS - 1 - i))) : [];
  const touched = weeks.map((w) => {
    const end = addDays(w, 6);
    const who = new Set<string>();
    for (const r of rows) { const d = dayOf(r.at); if (d && d >= w && d <= end && r.type !== "system" && ids.has(r.lead)) who.add(r.lead); }
    return { week: w, count: who.size, ids: Array.from(who) };
  });
  return {
    total: leads.length,
    byStage, byTier: groupBy(leads, (l) => l.tier), bySegment: groupBy(leads, (l) => l.segment), bySource: groupBy(leads, (l) => l.source),
    replyRate: {
      from: REPLY_RATE_FROM, sent, replied,
      rate: sent.length >= REPLY_RATE_FROM ? Math.round((replied.length / sent.length) * 100) : null,
    },
    medianReply: {
      from: MEDIAN_FROM, ids: pairs.map((p) => p.id),
      days: pairs.length >= MEDIAN_FROM ? median(pairs.map((p) => p.days)) : null,
    },
    touched,
  };
}

// Newest first by the at stamp, file order breaking a tie (a later line in the file is later).
export function newestFirst<T extends { at: string }>(rows: T[]): T[] {
  return rows.map((r, i) => ({ r, i })).sort((a, b) => (a.r.at < b.r.at ? 1 : a.r.at > b.r.at ? -1 : b.i - a.i)).map((x) => x.r);
}

// ---------- the state the Leads area reads ----------

export function leadsState(texts: Map<string, string>, today: string) {
  const pipeline = texts.get(PIPELINE_PATH);
  const station = texts.get(STATION_PATH) || "";
  const researchNotes = Array.from(texts.keys())
    .filter((p) => p.startsWith(LEADS_DIR) && p.slice(LEADS_DIR.length).startsWith(RESEARCH_PREFIX) && !p.slice(LEADS_DIR.length).includes("/"))
    .sort()
    .map((p) => ({ path: p, text: texts.get(p) || "" }));
  // The ten seeds' research sits in the station note's Candidates table, not in a lead list.
  if (station) researchNotes.push({ path: STATION_PATH, text: station });
  const parsed = pipeline === undefined ? { found: false, header: [], leads: [] as Lead[] } : parseLeads(pipeline);
  const actText = texts.get(ACTIVITY_PATH);
  const activity = parseActivity(actText);
  const byLead = new Map<string, Activity[]>();
  for (const a of activity.rows) { if (!byLead.has(a.lead)) byLead.set(a.lead, []); byLead.get(a.lead)!.push(a); }
  const leads = parsed.leads.map((l) => {
    const mine = byLead.get(l.id) || [];
    const days = touchDays(l.lastTouch, today);
    return {
      ...l, due: isDue(l, today), research: researchRows(l.company, researchNotes),
      touchDays: days, stale: staleLevel(days, l.status),
      history: groupTimeline(mine), activityCount: mine.length, sequence: sequencePosition(l, mine),
    };
  });
  const names = new Map(parsed.leads.map((l) => [l.id, l.company]));
  return {
    activity: {
      path: ACTIVITY_PATH, exists: actText !== undefined, found: activity.found, total: activity.rows.length,
      // the home feed: the last 20 lines across all leads, newest first
      latest: newestFirst(activity.rows).slice(0, 20).map((a) => ({ at: a.at, lead: a.lead, company: names.get(a.lead) || "", type: a.type, summary: a.summary, by: a.by })),
    },
    funnel: funnel(parsed.leads),
    sequence: sequenceView(parsed.leads, activity.rows, texts.get(OUTREACH_PATH)),
    reports: reportsView(parsed.leads, activity.rows, today),
    stages: STAGES,
    logTypes: LOG_TYPES,
    conversionFrom: CONVERSION_FROM,
    path: PIPELINE_PATH,
    exists: pipeline !== undefined,
    tableFound: parsed.found,
    stationPath: STATION_PATH,
    researchPaths: researchNotes.map((n) => n.path),
    statuses: LEAD_STATUSES,
    closed: CLOSED_STATUSES,
    leads,
    suppressed: parseSuppression(station),
    due: leads.filter((l) => l.due).length,
  };
}

// ---------- the write, with the re-read and retry ----------

export type VaultIO = {
  read(path: string): Promise<{ content: string; sha: string } | null>;
  write(path: string, content: string, message: string, sha?: string): Promise<{ commit: string }>;
};

// Read fresh, apply, write with the sha that was read; on a 409 or 422 (the file moved since
// the read) go round again, up to three times, exactly as the Approvals writes do.
// The message may be worked out from the applied result (a new lead's id is only known then).
export async function writeRow(io: VaultIO, path: string, apply: (text: string) => Applied, message: string | ((r: Applied) => string)): Promise<Applied & { commit?: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const f = await io.read(path);
    if (!f) return { ok: false, status: 404, error: `${path.split("/").pop()} is missing from the vault.` };
    const r = apply(f.content);
    if (r.ok === false) return r;
    if (r.unchanged) return r;
    try {
      const w = await io.write(path, r.text, typeof message === "function" ? message(r) : message, f.sha);
      return { ...r, commit: w.commit };
    } catch (e: any) {
      if (e.status !== 409 && e.status !== 422) throw e;
    }
  }
  return { ok: false, status: 409, error: `${path.split("/").pop()!.replace(/\.md$/, "")} was busy. Try again.` };
}

// Add lines to the activity log: read fresh, append, write with the sha read, and go round again on
// a clash, like writeRow. A missing note is created (no sha), so the first write needs nothing set up.
export async function appendActivity(io: VaultIO, entries: ActivityEntry[], message: string): Promise<Applied & { commit?: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const f = await io.read(ACTIVITY_PATH);
    const r = applyAppendActivity(f ? f.content : "", entries);
    if (r.ok === false) return r;
    try {
      const w = await io.write(ACTIVITY_PATH, r.text, message, f ? f.sha : undefined);
      return { ...r, commit: w.commit };
    } catch (e: any) {
      if (e.status !== 409 && e.status !== 422) throw e;
    }
  }
  return { ok: false, status: 409, error: "Owlbridge activity log was busy. Try again." };
}

// A pipeline edit and its activity line(s). The row is written first: if the log write then
// fails, the change itself has landed and the response says the line is missing, rather than the
// log claiming a change that never happened.
export async function writeWithActivity(
  io: VaultIO, apply: (text: string) => Applied, message: string | ((r: Applied) => string),
  entriesFor: (r: Applied) => ActivityEntry[], activityMessage: string,
): Promise<Applied & { commit?: string; activityCommit?: string; activityError?: string; logged?: number }> {
  const r = await writeRow(io, PIPELINE_PATH, apply, message);
  if (r.ok === false || r.unchanged) return r;
  const entries = entriesFor(r);
  if (!entries.length) return r;
  try {
    const a = await appendActivity(io, entries, activityMessage);
    if (a.ok === false) return { ...r, activityError: a.error };
    return { ...r, activityCommit: a.commit, logged: entries.length };
  } catch (e: any) {
    return { ...r, activityError: e.message || String(e) };
  }
}
