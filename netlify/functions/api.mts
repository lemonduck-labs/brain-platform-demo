// The Brain platform API. One function, routed under /api/*.
// Reads and writes the vault repo on GitHub through the Contents and Git Data APIs, or, in demo
// mode (no GITHUB_TOKEN, or BRAIN_MODE=demo), a bundled copy of a vault with every write kept in
// memory for the one visitor who made it (lib/demo.mts). Both sit behind the Vault interface below.
// Auth: POST /api/auth/passphrase takes X-Brain-Key = SHA-256(passphrase), rate
// limited, and returns a session token (or a passkey challenge if one is
// registered). Every other route takes that session token as X-Brain-Key.
// See netlify/functions/lib/auth.mts. The GitHub token never leaves this function.

import * as auth from "./lib/auth.mts";
import { blobStore } from "./lib/store.mts";
import * as demo from "./lib/demo.mts";
import { BUILD_REF as BUILD_ID } from "./lib/build-info.mts";
import * as leadgen from "./lib/leads.mts";
import * as team from "./lib/team.mts";
import * as settle from "./lib/settle.mts";
import { dismissLines } from "./lib/dismiss.mts";

declare const Netlify: any;

const REPO = () => Netlify.env.get("GITHUB_REPO") || "owner/brain-vault";
const BRANCH = () => Netlify.env.get("GITHUB_BRANCH") || "main";
const TOKEN = () => Netlify.env.get("GITHUB_TOKEN") || "";
const PASS = () => Netlify.env.get("BRAIN_PASSPHRASE") || "";
// The running deploy's commit reference, baked into build-info.mts by scripts/build.mjs at
// build time, the same way it stamps index.html: Netlify.env.get("COMMIT_REF") is a build-time
// variable, not a runtime one, so a running function cannot read it back (it always answered
// "dev" here, every deploy, which is what sent the site into a reload loop on 23 Sep). Netlify
// bundles this function with esbuild after the build command has written build-info.mts, so
// the value imported here is the one that ships with this deploy. The page compares it to its
// own stamped value and reloads itself once, and only once, when they differ (see checkBuild
// in app.js), so a merge reaches every open browser without a hard refresh.
const BUILD_REF = () => BUILD_ID || "dev";
const API = "https://api.github.com";

// In-memory caches survive while the function instance is warm. Keyed by blob sha,
// so a changed file is refetched and an unchanged one never is.
const blobCache: Map<string, string> = new Map();
let treeCache: { at: number; sha: string; entries: TreeEntry[] } | null = null;

type TreeEntry = { path: string; sha: string; size: number };

// ---------- helpers ----------

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const sessionToken = (req: Request) => req.headers.get("x-brain-key") || "";
const authorised = (req: Request) => auth.sessionValid(sessionToken(req));

const DEMO = () => demo.isDemo();

async function gh(path: string, init: RequestInit = {}, raw = false): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN()}`,
      accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "the-brain-platform",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    const err: any = new Error(`GitHub ${res.status} on ${path}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return raw ? res.text() : res.json();
}

// ---------- the vault: one small interface, two implementations ----------
// github: the private repo through the GitHub API (the live site). demo: the bundle plus a
// per-visitor overlay in memory (lib/demo.mts). Everything below this block only ever calls
// getTree, blob, readFile, writeFile and commitInfo, so neither side knows which one it has.
type Vault = {
  getTree(force: boolean): Promise<{ sha: string; entries: TreeEntry[] }>;
  blob(entry: TreeEntry): Promise<string>;
  readFile(path: string): Promise<{ content: string; sha: string } | null>;
  writeFile(path: string, content: string, message: string, sha?: string, base64?: boolean): Promise<{ sha: string; commit: string }>;
  commitInfo(sha: string): Promise<{ date: string; message: string }>;
};

const githubVault: Vault = {
  async getTree(force = false) {
    treeCache = await settle.treeFor(treeCache,
      async () => (await gh(`/repos/${REPO()}/git/ref/heads/${BRANCH()}`)).object.sha,
      async (commitSha) => {
        const tree = await gh(`/repos/${REPO()}/git/trees/${commitSha}?recursive=1`);
        const entries: TreeEntry[] = tree.tree
          .filter((e: any) => e.type === "blob" && e.path.endsWith(".md") && !e.path.startsWith(".obsidian/") && !e.path.startsWith("_review/"))
          .map((e: any) => ({ path: e.path, sha: e.sha, size: e.size }));
        return { at: Date.now(), sha: commitSha, entries };
      }, force);
    return treeCache;
  },
  async blob(entry) {
    const hit = blobCache.get(entry.sha);
    if (hit !== undefined) return hit;
    const text = await gh(`/repos/${REPO()}/git/blobs/${entry.sha}`, {}, true);
    blobCache.set(entry.sha, text);
    if (blobCache.size > 600) {
      const first = blobCache.keys().next().value;
      if (first) blobCache.delete(first);
    }
    return text;
  },
  async readFile(path) {
    try {
      const data = await gh(`/repos/${REPO()}/contents/${encodePath(path)}?ref=${BRANCH()}`);
      const content = Buffer.from(data.content, "base64").toString("utf8");
      return { content, sha: data.sha };
    } catch (e: any) {
      if (e.status === 404) return null;
      throw e;
    }
  },
  // No committer is named: GitHub attributes the commit to the token's own account.
  async writeFile(path, content, message, sha, base64 = false) {
    const body: any = {
      message,
      content: base64 ? content : Buffer.from(content, "utf8").toString("base64"),
      branch: BRANCH(),
    };
    if (sha) body.sha = sha;
    const res = await gh(`/repos/${REPO()}/contents/${encodePath(path)}`, { method: "PUT", body: JSON.stringify(body) });
    treeCache = null;
    return { sha: res.content.sha, commit: res.commit.sha };
  },
  async commitInfo(sha) {
    const c = await gh(`/repos/${REPO()}/commits/${sha}`);
    return { date: c?.commit?.committer?.date || "", message: c?.commit?.message || "" };
  },
};

const demoVault: Vault = {
  async getTree() {
    const [sha, entries] = await Promise.all([demo.demoVault.head(), demo.demoVault.tree()]);
    return { sha, entries };
  },
  blob: (entry) => demo.demoVault.blob(entry),
  readFile: (path) => demo.demoVault.read(path),
  writeFile: (path, content, message, sha, base64 = false) => demo.demoVault.write(path, content, message, sha, base64),
  commitInfo: (sha) => demo.demoVault.commitInfo(sha),
};

const vault = (): Vault => (DEMO() ? demoVault : githubVault);
const getTree = (force = false) => vault().getTree(force);
const blob = (entry: TreeEntry) => vault().blob(entry);
const readFile = (path: string) => vault().readFile(path);
const writeFile = (path: string, content: string, message: string, sha?: string, base64 = false) => vault().writeFile(path, content, message, sha, base64);

const settleIO: settle.FileIO = { read: readFile, write: (p, c, m, sha) => writeFile(p, c, m, sha) };

const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

// ---------- dates (Europe/London) ----------

// In demo mode the date is pinned to DEMO_TODAY (the demo vault's last day) while the time stays
// the real London time, so the vault reads as current whenever it is opened (lib/demo.mts).
function londonParts(d = new Date()) {
  if (DEMO()) {
    const real = londonPartsAt(d);
    const ymd = demo.demoToday();
    const [year, month, day] = ymd.split("-");
    const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(ymd + "T00:00:00Z").getUTCDay()];
    return { ymd, hm: real.hm, weekday, year, month, day };
  }
  return londonPartsAt(d);
}

function londonPartsAt(d: Date) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "long", hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(d)) p[part.type] = part.value;
  const ymd = `${p.year}-${p.month}-${p.day}`;
  return { ymd, hm: `${p.hour}:${p.minute}`, weekday: p.weekday, year: p.year, month: p.month, day: p.day };
}

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function isoWeek(ymd: string): { year: number; week: number } {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return { year: date.getUTCFullYear(), week };
}

function fillTemplate(tpl: string, ymd: string): string {
  const [y, m, d] = ymd.split("-");
  const dt = new Date(Date.UTC(+y, +m - 1, +d));
  const weekday = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][dt.getUTCDay()];
  const iw = isoWeek(ymd);
  const fmt = (token: string) => {
    let out = "";
    let i = 0;
    while (i < token.length) {
      if (token[i] === "[") { const j = token.indexOf("]", i); out += token.slice(i + 1, j); i = j + 1; continue; }
      const rest = token.slice(i);
      const rules: [string, string][] = [
        ["YYYY", y], ["MMMM", MONTHS[+m - 1]], ["dddd", weekday], ["MM", m], ["DD", d], ["WW", String(iw.week).padStart(2, "0")], ["D", String(+d)],
      ];
      const hit = rules.find(([k]) => rest.startsWith(k));
      if (hit) { out += hit[1]; i += hit[0].length; } else { out += token[i]; i++; }
    }
    return out;
  };
  return tpl.replace(/\{\{date:([^}]+)\}\}/g, (_, t) => fmt(t)).replace(/\{\{date\}\}/g, ymd).replace(/\{\{title\}\}/g, ymd);
}

// ---------- markdown parsing ----------

type Frontmatter = Record<string, string>;

function frontmatter(text: string): { fm: Frontmatter; body: string } {
  if (!text.startsWith("---")) return { fm: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { fm: {}, body: text };
  const raw = text.slice(3, end).trim();
  const fm: Frontmatter = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (m) fm[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return { fm, body: text.slice(end + 4) };
}

// A scalar frontmatter field plus the vault's own list shape: a `key:` line on its own,
// followed by indented `- item` lines (the shape Templates already write for tags, see
// Templates/Daily note.md), with an inline `[a, b]` line also read since aliases already
// expects that shape. Kept apart from frontmatter() above, which only ever reads one line
// per key, because System/Agents/*.md is the first place a vault note's frontmatter carries
// a list the platform actually needs (jobs, tools, goals), not just a scalar.
function frontmatterLists(text: string): Record<string, string[]> {
  const lists: Record<string, string[]> = {};
  if (!text.startsWith("---")) return lists;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return lists;
  const lines = text.slice(3, end).split("\n");
  let key = "";
  for (const line of lines) {
    const top = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (top) {
      const v = top[2].trim();
      key = "";
      if (!v) { key = top[1]; continue; }
      if (v.startsWith("[") && v.endsWith("]")) {
        lists[top[1]] = v.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      }
      continue;
    }
    const item = line.match(/^\s+-\s*(.+)$/);
    if (item && key) { (lists[key] = lists[key] || []).push(item[1].trim().replace(/^["']|["']$/g, "")); }
    else if (line.trim() !== "") key = "";
  }
  return lists;
}

// A one-line plain-text taste of a note's body, for the snippet a search hit shows in Notes:
// the first real sentence or so, headings, wikilink and markdown syntax stripped, callouts and
// frontmatter already excluded (this is called on the body frontmatter() returns). Kept short
// deliberately: it travels in the bulk /api/state payload for every note, not fetched per hit.
function excerptOf(body: string): string {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !/^#{1,6}\s/.test(l) && !/^\|/.test(l) && !/^>\s*\[!/.test(l) && !/^```/.test(l));
  if (!line) return "";
  const plain = line
    .replace(/^>\s*/, "")
    .replace(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#]/g, "")
    .trim();
  return plain.length > 160 ? plain.slice(0, 157).replace(/\s+\S*$/, "") + "..." : plain;
}

function section(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start < 0) return "";
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n").trim();
}

function parseTable(md: string): { header: string[]; rows: string[][]; rowLines: number[] } {
  const lines = md.split("\n");
  let header: string[] = [];
  const rows: string[][] = [];
  const rowLines: number[] = [];
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*\|/.test(l)) {
      const cells = l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (!inTable) { header = cells; inTable = true; continue; }
      if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) continue;
      rows.push(cells);
      rowLines.push(i);
    } else if (inTable && l.trim() === "") {
      // keep scanning: there may be several tables; stop this one
      inTable = false;
      if (rows.length) break;
    }
  }
  return { header, rows, rowLines };
}

const TAG_RE = /#(next|blocked|decision)\b/;
const SENT_RE = /^Sent for approval as (a-\d{4}-\d{2}-\d{2}-[a-z0-9-]+)/;

function scanTasks(path: string, text: string, title: string) {
  const out: any[] = [];
  const lines = text.split("\n");
  let heading = "";
  let fence = ""; // inside a fenced code block, checkboxes are examples, not tasks
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const f = l.match(/^\s*(```|~~~)/);
    if (f) { if (!fence) fence = f[1]; else if (f[1] === fence) fence = ""; continue; }
    if (fence) continue;
    const h = l.match(/^#{1,4}\s+(.*)$/);
    if (h) { heading = h[1].trim(); continue; }
    const m = l.match(/^(\s*)- \[( |x|X)\] (.+)$/);
    if (!m) continue;
    const done = m[2] !== " ";
    const tagM = m[3].match(TAG_RE);
    if (!tagM && path !== "Now.md") continue;
    const tag = tagM ? tagM[1] : "next";
    const textOnly = m[3].replace(/#(next|blocked|decision|[a-z0-9-]+)\b/g, "").replace(/\s{2,}/g, " ").trim();
    if (!textOnly) continue; // an empty checkbox is a placeholder, not a task
    // notes: the more-indented lines directly under the task, up to a blank line or a sub-task
    const indent = m[1].replace(/\t/g, "    ").length;
    const notes: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const n = lines[j];
      if (!n.trim()) break;
      if (n.match(/^(\s*)/)![1].replace(/\t/g, "    ").length <= indent) break;
      if (/^\s*- \[( |x|X)\] /.test(n)) break;
      notes.push(n.trim().replace(/^[-*+]\s+/, ""));
    }
    // "Sent for approval as a-YYYY-MM-DD-slug" in a note links the task to its row in Approvals
    let approvalId = "";
    for (const n of notes) { const s = n.match(SENT_RE); if (s) approvalId = s[1]; }
    out.push({ id: `${path}::${i}`, file: path, line: i, done, tag, text: textOnly, raw: m[3], project: title, section: heading, notes, approvalId });
  }
  return out;
}

// ---------- state assembly ----------

// ---------- agents: System/Agents/*.md, one file per member of the team. A new file needs no
// code change here, since it is simply another entry the tree walk below already turns up; the
// route to the Team view in the client reads this list rather than any fixed roster. "jobs"
// names playbooks (MORNING, EVENING, WEEKLY, SCOUT, BOARD REVIEW, TIDY, or the approvals
// watcher), matched against the run log's own job column so the client can show each agent's
// last real run without a second source of truth.
const JOB_ALIASES: Record<string, string> = { "the approvals watcher": "APPROVALS WATCHER", "approvals watcher": "APPROVALS WATCHER" };
const normaliseJob = (j: string) => (JOB_ALIASES[j.trim().toLowerCase()] || j.trim()).toUpperCase();
const HEX_RE = /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/;

function buildAgents(tree: { entries: TreeEntry[] }, texts: Map<string, string>, runs: any[]) {
  return tree.entries
    .filter((e) => e.path.startsWith("System/Agents/") && e.path.endsWith(".md"))
    .map((e) => {
      const text = texts.get(e.path) || "";
      const { fm, body } = frontmatter(text);
      const lists = frontmatterLists(text);
      const name = e.path.split("/").pop()!.replace(/\.md$/, "");
      const jobs = (lists.jobs || []).map(normaliseJob);
      const runsForAgent = runs.filter((r) => jobs.indexOf(normaliseJob(r.job || "")) > -1);
      return {
        id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent",
        name: fm.title || name,
        path: e.path,
        colour: HEX_RE.test(fm.colour || "") ? fm.colour : "",
        jobs,
        tools: lists.tools || [],
        goals: lists.goals || [],
        // the note's own first plain sentence, the same taste excerptOf already gives every
        // other note in the notes index, so an agent's role is not summarised twice over
        role: excerptOf(body),
        // the frontmatter role (Director, Developer...) and model, read by the Team roster
        roleName: fm.role || "",
        model: fm.model || "",
        updated: fm.updated || "",
        lastRun: runsForAgent[0] || null,
        recentRuns: runsForAgent.slice(0, 8),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function buildState() {
  const tree = await getTree();
  const byPath = new Map(tree.entries.map((e) => [e.path, e]));
  const today = londonParts();
  const dailyPath = `Journal/Daily/${today.ymd}.md`;

  // Notes index (frontmatter only needs the file; fetch all md in parallel, cached by sha)
  const texts = new Map<string, string>();
  // Approvals is read fresh through the Contents API, not by the tree's blob sha, so a status
  // written a moment ago is always what the page shows.
  const [freshApprovals] = await Promise.all([
    readFile("System/Approvals.md").catch(() => null),
    ...tree.entries.map(async (e) => { texts.set(e.path, await blob(e)); }),
  ]);
  if (freshApprovals) texts.set("System/Approvals.md", freshApprovals.content);

  const notePaths = tree.entries.map((e) => e.path);
  const notes = tree.entries.map((e) => {
    const { fm, body } = frontmatter(texts.get(e.path) || "");
    const name = e.path.split("/").pop()!.replace(/\.md$/, "");
    const aliases = (fm.aliases || "").replace(/^\[|\]$/g, "").split(",").map((a) => a.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    return { path: e.path, name, title: fm.title || name, aliases, type: fm.type || "", status: fm.status || "", updated: fm.updated || "", size: e.size, excerpt: excerptOf(body) };
  });
  // Outgoing wikilink targets, resolved to vault paths: used by the client to draw "Linked
  // from" under a note (a backlink is simply another note whose own links include this path),
  // without shipping every note's full body to the browser. Reuses targetPath, the same
  // resolver the priority and task linking already use, so a link resolves identically
  // wherever it is read.
  const WIKI_TARGET = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]/g;
  for (const n of notes) {
    const text = texts.get(n.path) || "";
    const found = new Set<string>();
    let wm: RegExpExecArray | null;
    WIKI_TARGET.lastIndex = 0;
    while ((wm = WIKI_TARGET.exec(text))) {
      const p = targetPath(wm[1], notePaths, notes);
      if (p && p !== n.path) found.add(p);
    }
    (n as any).links = Array.from(found);
  }

  const tasks: any[] = [];
  for (const e of tree.entries) {
    // templates hold placeholder checkboxes: the Templates folder, and files named with a leading underscore
    if (e.path.startsWith("Templates/") || e.path.startsWith("Journal/") || e.path.split("/").pop()!.startsWith("_")) continue;
    const t = texts.get(e.path) || "";
    const { fm } = frontmatter(t);
    if ((fm.type || "").toLowerCase() === "template") continue;
    tasks.push(...scanTasks(e.path, t, fm.title || e.path.split("/").pop()!.replace(/\.md$/, "")));
  }

  const now = texts.get("Now.md") || "";
  const { fm: nowFm } = frontmatter(now);
  const week = section(now, "This week");
  const waiting = section(now, "Waiting on the operator");
  const waitingOthers = section(now, "Waiting on other people");
  const ranking = parseTable(section(now, "Active projects, ranked"));

  const daily = texts.get(dailyPath) || "";
  const journal = daily ? {
    path: dailyPath, exists: true,
    plan: section(daily, "Plan"), log: section(daily, "Log"), sessions: section(daily, "Sessions"),
    review: section(daily, "Review"), carry: section(daily, "Carry forward"),
  } : { path: dailyPath, exists: false, plan: "", log: "", sessions: "", review: "", carry: "" };

  const runlog = texts.get("System/Run log.md") || "";
  const runs = parseTable(section(runlog, "Latest")).rows.map((r) => ({ when: r[0], job: r[1], surface: r[2], result: r[3], note: r[4] }));

  const approvalsMd = texts.get("System/Approvals.md") || "";
  // priority (an 11th cell) ranks a row P1, P2... for the order runs work the queue in, and the
  // department (a 12th cell: owlbridge, fernmoor, brain or ventures) puts it in a Team lane. Rows
  // with 10, 11 or 12 cells all parse; a missing cell reads as blank (lib/team.mts, queueRow).
  const approvals = parseTable(section(approvalsMd, "Queue")).rows.map(team.queueRow);

  // Notes the operator writes on tasks: already-approved work, picked up by the watcher and the evening review
  const noteQueue = parseTable(section(approvalsMd, "Notes")).rows.map((r) => ({
    id: r[0], status: r[1], task: r[2], note: r[3], file: r[4], line: r[5], added: r[6], done: r[7], outcome: r[8],
  }));

  const statusById = new Map(approvals.map((a) => [a.id, a.status]));
  for (const t of tasks) if (t.approvalId) t.approval = { id: t.approvalId, status: statusById.get(t.approvalId) || "missing" };

  const scoutMd = texts.get("System/Scout.md") || "";
  const scout = parseTable(section(scoutMd, "Findings")).rows.map((r) => ({
    id: r[0], status: r[1], title: r[2], summary: r[3], url: r[4], sourceDate: r[5], project: r[6], found: r[7],
  }));

  const growth = texts.get("Growth.md") || "";

  const weeklyFiles = tree.entries.filter((e) => e.path.startsWith("Journal/Weekly/")).map((e) => e.path).sort();
  // WEEKLY creates next week's note early for its suggested priorities, so the Direction comes from the latest
  // week note whose Direction has been written, not from one still holding the template's words
  const templateLines = new Set(section(texts.get("Templates/Weekly review.md") || "", "Direction").split("\n").map((l) => l.trim()).filter(Boolean));
  const written = (d: string) => d.split("\n").map((l) => l.trim()).some((l) => l && !templateLines.has(l) && !/^(\d+\.|\*\*Stop:\*\*)$/.test(l));
  // The path the Direction text actually came from, plus that note's own updated date: the
  // client uses both to flag Direction as out of date when the week it names has passed,
  // the same way it flags This week (see the Out of date flag in app.js).
  const directionPath = weeklyFiles.slice().reverse().find((p) => written(section(texts.get(p) || "", "Direction").trim())) || "";
  const direction = directionPath ? section(texts.get(directionPath) || "", "Direction").trim() : "";
  const directionMeta = { path: directionPath, updated: directionPath ? frontmatter(texts.get(directionPath) || "").fm.updated || "" : "" };

  const weekPath = scopeInfo("week").path;
  const priorities = {
    day: periodState("day", daily, Boolean(daily), tasks, notePaths, notes),
    week: periodState("week", texts.get(weekPath) || "", texts.has(weekPath), tasks, notePaths, notes),
  };

  const [commit, snoozes, reviewState] = await Promise.all([vault().commitInfo(tree.sha), getSnoozes(), getReviewState()]);
  const agents = buildAgents(tree, texts, runs);
  const leads = leadgen.leadsState(texts, today.ymd);
  // The Team area (lib/team.mts): every figure from vault files only, archives included.
  const archived = (prefix: string) => tree.entries.filter((e) => e.path.startsWith(prefix) && /\d{4}-\d{2}\.md$/.test(e.path)).map((e) => texts.get(e.path) || "");
  const teamState = team.buildTeam({
    approvalsMd, archiveApprovals: archived("System/Archive/Approvals "),
    runLogMd: runlog, archiveRunLogs: archived("System/Archive/Run log "),
    ledgerMd: texts.has("System/Setup/Watcher lock.md") ? texts.get("System/Setup/Watcher lock.md")! : null,
    departmentsMd: texts.get("System/Departments.md") || "", toolsMd: texts.get("System/Tools.md") || "",
    agents: agents.map((a) => ({ name: a.name, role: a.roleName, colour: a.colour, model: a.model, path: a.path, jobs: a.jobs })),
    today: { ymd: today.ymd, hm: today.hm }, nowUtc: demo.nowMs(),
  });

  return {
    generatedAt: new Date(demo.nowMs()).toISOString(),
    build: BUILD_REF(),
    // Present only in demo mode: the banner text and how much of this visit's write cap is used.
    demo: DEMO() ? demo.visitInfo() : undefined,
    watcher: { configured: Boolean(watcherConfig()) },
    // week: the current ISO week number, so the client can tell a block written for an
    // earlier week apart from one written for this one (the Out of date flag).
    today: { ymd: today.ymd, weekday: today.weekday, hm: today.hm, week: isoWeek(today.ymd).week },
    repo: { name: DEMO() ? "demo vault" : REPO(), branch: DEMO() ? "demo" : BRANCH(), commit: tree.sha.slice(0, 7), committedAt: commit.date, message: commit.message.split("\n")[0] },
    counts: { notes: notes.length, tasksOpen: tasks.filter((t) => !t.done).length, approvalsPending: approvals.filter((a) => a.status === "pending").length, scoutNew: scout.filter((s) => s.status === "new").length, leadsDue: leads.due },
    now: { week, waiting, waitingOthers, ranking: ranking.rows, updated: nowFm.updated || "" },
    journal,
    tasks,
    approvals,
    noteQueue,
    scout,
    runs,
    growth: { suggested: section(growth, "Suggested"), accepted: section(growth, "Accepted") },
    direction,
    directionMeta,
    priorities,
    notes,
    snoozes,
    reviewState,
    agents,
    leads,
    team: teamState,
  };
}

// ---------- mutations ----------

// Done on a "Claude needs from you" item comes in two kinds. Continue is the older behaviour: their part
// is finished and the rest of the work goes back to the queue as "in progress", with a run started now.
// Complete means the whole thing is finished: the line is ticked, a linked row is closed as done, and the
// next scheduled run reviews it; nothing starts now. Anything else keeps the plain tick.
type DoneMode = "complete" | "continue" | "";

async function toggleTask(file: string, line: number, raw: string, done: boolean, mode: DoneMode = "continue") {
  const f = await readFile(file);
  if (!f) return json({ error: "file not found" }, 404);
  const lines = f.content.split("\n");
  const current = lines[line] || "";
  if (!current.includes(raw)) {
    return json({ error: "The note changed since you loaded it. Refresh and try again.", conflict: true }, 409);
  }
  lines[line] = current.replace(/- \[( |x|X)\]/, done ? "- [x]" : "- [ ]");
  const content = lines.join("\n");
  const label = raw.replace(/#[a-z]+/g, "").trim().slice(0, 60);
  const r = await writeFile(file, content, `platform: ${done ? "tick" : "untick"} ${label}`, f.sha);
  // Pressing Done on a request Claude made is not the end of the work, it is the start of the rest of
  // it. The item comes back to the queue as "in progress" so the next run carries on from there.
  let carried: { carried: boolean; id?: string; completed?: boolean } = { carried: false };
  if (done && file === "System/Needs from the operator.md") {
    if (mode === "complete") {
      try { carried = await completeNeed(raw, lines, line); } catch { carried = { carried: false }; }
    } else {
      try { carried = await carryOn(raw, lines, line); } catch { carried = { carried: false }; }
    }
  }
  return json({ ok: true, commit: r.commit, mode, ...carried });
}

// Dismiss: a task that is not needed rather than done. The line stays in its note, marked "- [-]",
// with a dated note under it; see lib/dismiss.mts.
async function dismissTask(file: string, line: number, raw: string) {
  const f = await readFile(file);
  if (!f) return json({ error: "file not found" }, 404);
  const now = londonParts();
  const res = dismissLines(f.content.split("\n"), line, raw, `${now.ymd} ${now.hm}`);
  if (!res.ok) {
    if (res.reason === "not-open") return json({ error: "Only an open task can be dismissed." }, 400);
    return json({ error: "The note changed since you loaded it. Refresh and try again.", conflict: true }, 409);
  }
  const label = raw.replace(/#[a-z]+/g, "").trim().slice(0, 60);
  const r = await writeFile(file, res.lines.join("\n"), `platform: dismiss ${label}`, f.sha);
  return json({ ok: true, commit: r.commit });
}

// Complete: close a linked queue row as done, marked for the next scheduled run to review. An item with
// no linked row needs nothing more: the tick itself is what the watcher reads under Needs from the operator.
async function completeNeed(raw: string, lines: string[], line: number) {
  const notes: string[] = [];
  for (let i = line + 1; i < lines.length && /^\s+\S/.test(lines[i]) && !/^\s*- \[( |x|X)\] /.test(lines[i]); i++) {
    notes.push(lines[i].trim().replace(/^-\s*/, ""));
  }
  const linked = notes.map((n) => n.match(SENT_RE)).find(Boolean);
  if (!linked) return { carried: false, completed: true };
  const id = linked[1];
  const today = londonParts();
  for (let attempt = 0; attempt < 3; attempt++) {
    const f = await readFile("System/Approvals.md");
    if (!f) return { carried: false, completed: true };
    const all = f.content.split("\n");
    const at = all.findIndex((l) => /^\s*\|/.test(l) && l.split("|")[1] && l.split("|")[1].trim() === id);
    if (at < 0) return { carried: false, completed: true };
    const cells = all[at].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (["done", "declined"].includes(cells[1])) return { carried: false, completed: true, id };
    cells[1] = "done";
    cells[8] = today.ymd;
    cells[9] = cellSafe(`The operator pressed Complete at ${today.hm} on ${today.ymd}: finished, for the next scheduled run to review. ${cells[9] || ""}`).slice(0, 400);
    all[at] = `| ${cells.join(" | ")} |`;
    try {
      await writeFile("System/Approvals.md", all.join("\n"), `platform: ${id} complete`, f.sha);
      return { carried: false, completed: true, id };
    } catch (e: any) {
      if (e.status !== 409 && e.status !== 422) throw e;
    }
  }
  return { carried: false, completed: true };
}

// Move a ticked request into the queue as work in progress, or wake the row it already belongs to.
async function carryOn(raw: string, lines: string[], line: number) {
  const notes: string[] = [];
  for (let i = line + 1; i < lines.length && /^\s+\S/.test(lines[i]) && !/^\s*- \[( |x|X)\] /.test(lines[i]); i++) {
    notes.push(lines[i].trim().replace(/^-\s*/, ""));
  }
  const linked = notes.map((n) => n.match(SENT_RE)).find(Boolean);
  const title = cellSafe(raw.replace(/#[a-z0-9-]+/g, "").trim()).slice(0, 110);
  const f = await readFile("System/Approvals.md");
  if (!f) return { carried: false };
  const all = f.content.split("\n");
  const today = londonParts();
  if (linked) {
    const id = linked[1];
    const at = all.findIndex((l) => /^\s*\|/.test(l) && l.split("|")[1] && l.split("|")[1].trim() === id);
    if (at >= 0) {
      const cells = all[at].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (!["done", "declined"].includes(cells[1])) {
        cells[1] = "in progress";
        cells[9] = cellSafe(`The operator pressed Done at ${today.hm} on ${today.ymd}. Est: the next run carries on from here. ${cells[9] || ""}`).slice(0, 400);
        all[at] = `| ${cells.join(" | ")} |`;
        await writeFile("System/Approvals.md", all.join("\n"), `platform: ${id} in progress`, f.sha);
        return { carried: true, id };
      }
    }
    return { carried: false };
  }
  const q = all.findIndex((l) => l.trim() === "## Queue");
  if (q < 0) return { carried: false };
  let last = -1;
  for (let i = q + 1; i < all.length; i++) { if (/^## /.test(all[i])) break; if (/^\s*\|/.test(all[i])) last = i; }
  if (last < 0) return { carried: false };
  const ids = new Set(all.filter((l) => /^\|\s*a-/.test(l)).map((l) => l.split("|")[1].trim()));
  const base = `a-${today.ymd}-${slugify(title)}`;
  let id = base, k = 2;
  while (ids.has(id)) id = `${base}-${k++}`;
  const detail = cellSafe(`The operator pressed Done on this request in System/Needs from the operator.md, so their part is finished and the rest of the work continues here. ${notes.slice(0, 3).join(" ")}`).slice(0, 600);
  all.splice(last + 1, 0, `| ${id} | in progress | ${title} | ${detail} |  | yes | Platform, Done pressed | ${today.ymd} ${today.hm} |  | Est: the next run carries on from here |`);
  await writeFile("System/Approvals.md", all.join("\n"), `platform: carry on ${id}`, f.sha);
  return { carried: true, id };
}

const oneLine = (t: string) => String(t || "").replace(/\s*[\r\n]+\s*/g, " ").replace(/\s{2,}/g, " ").trim();

async function addTask(text: string, tag: string, project?: string) {
  const file = "Now.md";
  const f = await readFile(file);
  if (!f) return json({ error: "Now.md not found" }, 404);
  const clean = oneLine(text.replace(/#(next|blocked|decision)\b/g, ""));
  if (!clean) return json({ error: "A task needs some words." }, 400);
  const proj = project ? oneLine(project) : "";
  const line = `- [ ] ${clean}${proj ? ` (${proj})` : ""} #${tag}`;
  const lines = f.content.split("\n");
  let idx = lines.findIndex((l) => l.trim() === "## Later, parked on purpose");
  if (idx < 0) idx = lines.length;
  // walk back over blank lines so the item joins the list above
  let insertAt = idx;
  while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, line);
  const r = await writeFile(file, lines.join("\n"), `platform: add task ${clean.slice(0, 60)}`, f.sha);
  return json({ ok: true, commit: r.commit });
}

async function editTask(file: string, line: number, raw: string, text: string, tag: string) {
  const f = await readFile(file);
  if (!f) return json({ error: "file not found" }, 404);
  const lines = f.content.split("\n");
  const current = lines[line] || "";
  if (!current.includes(raw)) return json({ error: "The note changed since you loaded it. Refresh and try again.", conflict: true }, 409);
  const m = current.match(/^(\s*- \[( |x|X)\] )/);
  if (!m) return json({ error: "not a task line" }, 400);
  const clean = oneLine(text.replace(/#(next|blocked|decision)\b/g, ""));
  if (!clean) return json({ error: "A task needs some words." }, 400);
  const keep = (current.slice(m[1].length).match(/#[a-z0-9][a-z0-9/-]*\b/gi) || []).filter((h) => !/^#(next|blocked|decision)$/i.test(h) && !clean.includes(h));
  const before = scanTasks(file, f.content, "").find((t) => t.line === line);
  lines[line] = `${m[1]}${clean} #${tag}${keep.length ? " " + keep.join(" ") : ""}`;
  const r = await writeFile(file, lines.join("\n"), `platform: edit task ${clean.slice(0, 60)}`, f.sha);
  if (before) await followTaskEdit(file, before.text, clean);
  return json({ ok: true, commit: r.commit });
}

// Approve, decline and the Scout statuses. Read fresh and write against that sha; if the watcher,
// Obsidian or a second approval moved the file in between (GitHub 409 or 422), read it again and
// reapply, up to three attempts in all (lib/settle.mts writeWithRetry).
async function setRowStatus(file: string, sectionName: string, id: string, status: string, noteCol?: { index: number; value: string }, decidedCol?: number) {
  const r = await settle.writeWithRetry(settleIO, file, (text) => {
    if (!section(text, sectionName)) return { ok: false, status: 400, error: `section ${sectionName} missing` };
    const t = londonParts();
    const next = settle.applyRowStatus(text, id, status, { stamp: `${t.ymd} ${t.hm}`, decidedCol, noteCol });
    return next === null ? { ok: false, status: 404, error: `row ${id} not found` } : { ok: true, content: next };
  }, `platform: ${sectionName.toLowerCase()} ${id} ${status}`);
  if (r.ok === false) return json({ error: r.error, conflict: r.status === 409 || undefined }, r.status);
  return json({ ok: true, id, status, commit: r.commit });
}

const cellSafe = (t: string) => oneLine(t).replace(/\|/g, "/");
const slugify = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").filter(Boolean).slice(0, 5).join("-") || "request";
const safeNotePath = (p: unknown) => typeof p === "string" && p.endsWith(".md") && !p.includes("..") && !p.startsWith(".obsidian/") && !p.startsWith("/");

// A request the operator writes for Claude: a row in the approval queue with status "requested".
// Sessions and the approvals watcher scope it into a "pending" row for their yes; nothing runs before that.
// department: one of the registry ids in System/Departments.md, or blank for Unassigned. A
// blank one writes the original 10-cell row; a set one writes 12 cells, priority left blank.
async function addRequest(title: string, detail: string, source: string, department = "") {
  const t = cellSafe(title), d = cellSafe(detail);
  const dept = /^[a-z][a-z0-9-]{0,30}$/.test(department) ? department : "";
  if (!t) return json({ error: "A request needs a title." }, 400);
  const file = "System/Approvals.md";
  const f = await readFile(file);
  if (!f) return json({ error: `${file} not found` }, 404);
  const today = londonParts();
  const lines = f.content.split("\n");
  const q = lines.findIndex((l) => l.trim() === "## Queue");
  if (q < 0) return json({ error: "The Queue section is missing from Approvals" }, 400);
  let last = -1;
  for (let i = q + 1; i < lines.length; i++) { if (/^## /.test(lines[i])) break; if (/^\s*\|/.test(lines[i])) last = i; }
  if (last < 0) return json({ error: "The Queue table is missing from Approvals" }, 400);
  const ids = new Set(lines.filter((l) => /^\|\s*a-/.test(l)).map((l) => l.split("|")[1].trim()));
  const base = `a-${today.ymd}-${slugify(t)}`;
  let id = base, k = 2;
  while (ids.has(id)) id = `${base}-${k++}`;
  lines.splice(last + 1, 0, `| ${id} | requested | ${t} | ${d} |  |  | ${source} | ${today.ymd} ${today.hm} |  |  |${dept ? `  | ${dept} |` : ""}`);
  const r = await writeFile(file, lines.join("\n"), `platform: request ${id}`, f.sha);
  return json({ ok: true, id, commit: r.commit });
}

// A note under a task: an indented bullet, so Obsidian shows it nested under the checkbox.
function insertNote(lines: string[], line: number, note: string) {
  const m = (lines[line] || "").match(/^(\s*)- \[( |x|X)\] /);
  if (!m) return false;
  const indent = m[1].replace(/\t/g, "    ").length;
  let at = line + 1;
  while (at < lines.length && lines[at].trim() && lines[at].match(/^(\s*)/)![1].replace(/\t/g, "    ").length > indent && !/^\s*- \[( |x|X)\] /.test(lines[at])) at++;
  lines.splice(at, 0, `${" ".repeat(indent + 4)}- ${note}`);
  return true;
}

// A file the operator attaches to a task or to a "Claude needs from you" item. The file lands beside the
// note it belongs to, or in Inbox/ when the note lives under System/, and the task gets a note naming
// it, so the watcher and the evening review pick it up the way they pick up any other note.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,90}\.[A-Za-z0-9]{1,8}$/;
async function addTaskFile(file: string, line: number, raw: string, name: string, dataB64: string) {
  const clean = oneLine(name).replace(/[\\/]/g, "");
  if (!SAFE_NAME.test(clean)) return json({ error: "That file name will not work in the vault. Letters, numbers, spaces, dots, dashes and underscores only." }, 400);
  if (!/^[A-Za-z0-9+/=\s]+$/.test(dataB64) || dataB64.length < 8) return json({ error: "The file did not arrive in one piece. Try again." }, 400);
  const bytes = Math.floor((dataB64.replace(/\s/g, "").length * 3) / 4);
  if (bytes > 4_500_000) return json({ error: `That file is ${(bytes / 1_000_000).toFixed(1)} MB. The limit here is 4.5 MB, so put larger files in the vault's Inbox folder on the Mac instead.` }, 413);
  const f = await readFile(file);
  if (!f) return json({ error: "file not found" }, 404);
  const lines = f.content.split("\n");
  if (!(lines[line] || "").includes(raw)) return json({ error: "The note changed since you loaded it. Refresh and try again.", conflict: true }, 409);
  const dir = file.startsWith("System/") || !file.includes("/") ? "Inbox" : file.slice(0, file.lastIndexOf("/"));
  const existing = await readFile(`${dir}/${clean}`);
  const target = existing ? `${dir}/${clean.replace(/(\.[^.]+)$/, ` ${londonParts().ymd}$1`)}` : `${dir}/${clean}`;
  await writeFile(target, dataB64.replace(/\s/g, ""), `platform: upload ${clean}`, undefined, true);
  const f2 = await readFile(file);
  if (!f2) return json({ ok: true, path: target, noted: false });
  const lines2 = f2.content.split("\n");
  const at = lines2.findIndex((l, i) => i >= Math.max(0, line - 3) && l.includes(raw) && /^\s*- \[( |x|X)\] /.test(l));
  const noteText = `Uploaded ${clean}, saved at ${target}`;
  if (at >= 0 && insertNote(lines2, at, noteText)) {
    await writeFile(file, lines2.join("\n"), `platform: note on ${raw.replace(/#[a-z0-9-]+/g, "").trim().slice(0, 50)}`, f2.sha);
  }
  return json({ ok: true, path: target, noted: at >= 0 });
}

// A note the operator writes on a task is work they have already approved. It goes in the Notes table in
// Approvals, which the watcher and the evening review already open, so it is picked up on their next
// run at no extra cost. Nothing is started here: notes never fire a run.
async function queueNote(task: string, note: string, file: string, line: number) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const f = await readFile("System/Approvals.md");
    if (!f) return { queued: false, why: "Approvals is missing" };
    const lines = f.content.split("\n");
    const head = lines.findIndex((l) => l.trim() === "## Notes");
    if (head < 0) return { queued: false, why: "the Notes section is missing from Approvals" };
    let last = -1;
    for (let i = head + 1; i < lines.length; i++) { if (/^## /.test(lines[i])) break; if (/^\s*\|/.test(lines[i])) last = i; }
    if (last < 0) return { queued: false, why: "the Notes table is missing from Approvals" };
    const today = londonParts();
    const ids = new Set(lines.filter((l) => /^\|\s*n-/.test(l)).map((l) => l.split("|")[1].trim()));
    const base = `n-${today.ymd}-${slugify(note)}`;
    let id = base, k = 2;
    while (ids.has(id)) id = `${base}-${k++}`;
    lines.splice(last + 1, 0, `| ${id} | new | ${cellSafe(task)} | ${cellSafe(note)} | ${file} | ${line + 1} | ${today.ymd} ${today.hm} |  |  |`);
    try {
      await writeFile("System/Approvals.md", lines.join("\n"), `platform: note queued ${id}`, f.sha);
      return { queued: true, noteId: id };
    } catch (e: any) {
      if (e.status !== 409 && e.status !== 422) return { queued: false, why: "it could not be written to Approvals" };
    }
  }
  return { queued: false, why: "Approvals was busy" };
}

async function addTaskNote(file: string, line: number, raw: string, text: string) {
  const note = oneLine(text);
  if (!note) return json({ error: "A note needs some words." }, 400);
  if (SENT_RE.test(note)) return json({ error: "That wording is kept for the Send for approval button. Rephrase the note." }, 400);
  const f = await readFile(file);
  if (!f) return json({ error: "file not found" }, 404);
  const lines = f.content.split("\n");
  if (!(lines[line] || "").includes(raw)) return json({ error: "The note changed since you loaded it. Refresh and try again.", conflict: true }, 409);
  if (!insertNote(lines, line, note)) return json({ error: "not a task line" }, 400);
  const r = await writeFile(file, lines.join("\n"), `platform: note on ${raw.replace(/#[a-z0-9-]+/g, "").trim().slice(0, 50)}`, f.sha);
  let queued: { queued: boolean; noteId?: string; why?: string };
  try { queued = await queueNote(raw.replace(/#[a-z0-9-]+/g, "").trim(), note, file, line); }
  catch { queued = { queued: false, why: "it could not be written to Approvals" }; }
  return json({ ok: true, commit: r.commit, ...queued });
}

// Send a task (with its notes) to the approval queue as a request. The task gets a note naming the
// request id, which links the two both ways: the platform shows the request's status on the task, and
// Claude finds the task from the row by searching for the id.
async function requestFromTask(file: string, line: number, raw: string) {
  const f = await readFile(file);
  if (!f) return json({ error: "file not found" }, 404);
  if (!(f.content.split("\n")[line] || "").includes(raw)) return json({ error: "The note changed since you loaded it. Refresh and try again.", conflict: true }, 409);
  const t = scanTasks(file, f.content, "").find((x) => x.line === line);
  if (!t) return json({ error: "Only tagged tasks can be sent for approval." }, 400);
  if (t.done) return json({ error: "This task is already ticked." }, 400);
  if (t.approvalId) {
    const q = await readFile("System/Approvals.md");
    const row = q ? parseTable(section(q.content, "Queue")).rows.find((r) => r[0] === t.approvalId) : undefined;
    if (row && !["declined", "done"].includes(row[1])) return json({ error: `This task is already in Approvals as ${t.approvalId} (${row[1]}).` }, 409);
  }
  const own = t.notes.filter((n) => !SENT_RE.test(n));
  const detail = [own.length ? `Notes: ${own.join("; ")}.` : "", `From the task in ${file}${t.section ? `, under ${t.section}` : ""}.`].filter(Boolean).join(" ");
  const res = await addRequest(t.text, detail, "Platform, from a task");
  if (res.status !== 200) return res;
  const { id } = await res.json();
  const today = londonParts();
  const stamp = `Sent for approval as ${id} on ${today.ymd} ${today.hm}`;
  // the request is saved; linking the task is best effort and retried once if the file moved on
  for (let attempt = 0; attempt < 2; attempt++) {
    const f2 = await readFile(file);
    if (!f2) break;
    const lines = f2.content.split("\n");
    let at = lines[line] !== undefined && lines[line].includes(raw) ? line : lines.findIndex((l) => /^\s*- \[( |x|X)\] /.test(l) && l.includes(raw));
    if (at < 0 || !insertNote(lines, at, stamp)) break;
    try { await writeFile(file, lines.join("\n"), `platform: sent for approval ${id}`, f2.sha); return json({ ok: true, id, linked: true }); }
    catch (e: any) { if (e.status !== 409 && e.status !== 422) throw e; }
  }
  return json({ ok: true, id, linked: false });
}

// Fernmoor work lives apart from the operator's own ventures: one quick list, a section per brand.
const WORK_NOTE = "Wiki/Fernmoor/Fernmoor tasks.md";
const BRANDS: Record<string, string> = { heating: "Fernmoor Heating", ridgeby: "Ridgeby Roofing", warmstead: "Warmstead", group: "Group" };

async function addWorkTask(text: string, tag: string, brand: string) {
  const heading = BRANDS[brand];
  if (!heading) return json({ error: "Pick a brand." }, 400);
  const clean = oneLine(text.replace(/#(next|blocked|decision)\b/g, ""));
  if (!clean) return json({ error: "A task needs some words." }, 400);
  const today = londonParts();
  const f = await readFile(WORK_NOTE);
  let content = f ? f.content : `---\ntitle: Fernmoor tasks\naliases: [Work tasks, Fernmoor to-do]\ntype: log\nparent: "[[Fernmoor]]"\nowner: the operator\nupdated: ${today.ymd}\ntags:\n  - project/fernmoor\n---\n\n# Fernmoor tasks\n\nThe quick list for Fernmoor and its brands, added from the Fernmoor tab of the platform and kept apart from the operator's own ventures. Each brand's project note keeps the detail.\n\n## Fernmoor Heating\n\n## Ridgeby Roofing\n\n## Warmstead\n\n## Group\n\n## Related\n\n[[Fernmoor]] · [[Ridgeby Roofing]] · [[Warmstead]]\n`;
  content = content.replace(/^updated: .*$/m, `updated: ${today.ymd}`);
  const lines = content.split("\n");
  let h = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (h < 0) {
    const rel = lines.findIndex((l) => l.trim() === "## Related");
    const at = rel < 0 ? lines.length : rel;
    lines.splice(at, 0, `## ${heading}`, "");
    h = at;
  }
  let end = lines.length;
  for (let i = h + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { end = i; break; }
  let insertAt = end;
  while (insertAt > h + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  const taskLine = `- [ ] ${clean} #${tag}`;
  if (insertAt === h + 1) lines.splice(h + 1, 0, "", taskLine);
  else lines.splice(insertAt, 0, taskLine);
  const after = lines.indexOf(taskLine) + 1;
  if (lines[after] !== undefined && lines[after].trim() !== "") lines.splice(after, 0, "");
  const r = await writeFile(WORK_NOTE, lines.join("\n"), `platform: add Fernmoor task ${clean.slice(0, 50)}`, f ? f.sha : undefined);
  return json({ ok: true, commit: r.commit, file: WORK_NOTE });
}

async function appendJournal(text: string) {
  const today = londonParts();
  const path = `Journal/Daily/${today.ymd}.md`;
  let f = await readFile(path);
  let content: string;
  let sha: string | undefined;
  if (!f) {
    const tpl = await readFile("Templates/Daily note.md");
    content = tpl ? fillTemplate(tpl.content, today.ymd) : `---\ntitle: ${today.ymd}\ntype: journal\nowner: the operator\nupdated: ${today.ymd}\ntags:\n  - journal/daily\n---\n\n# ${today.weekday} ${today.day} ${MONTHS[+today.month - 1]} ${today.year}\n\n## Plan\n\n## Log\n\n## Sessions\n\n## Review\n\n## Carry forward\n`;
  } else { content = f.content; sha = f.sha; }
  const lines = content.split("\n");
  const logIdx = lines.findIndex((l) => l.trim() === "## Log");
  if (logIdx < 0) return json({ error: "no Log section" }, 400);
  let end = lines.length;
  for (let i = logIdx + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { end = i; break; }
  // insert before trailing blank lines of the section
  let insertAt = end;
  while (insertAt > logIdx + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  const entry = `- ${today.hm} ${text.trim().replace(/\n+/g, " ")}`;
  lines.splice(insertAt, 0, entry);
  // keep one blank line before the next heading
  if (lines[insertAt + 1] !== undefined && lines[insertAt + 1].trim() !== "") lines.splice(insertAt + 1, 0, "");
  const r = await writeFile(path, lines.join("\n"), `platform: log ${today.hm}`, sha);
  return json({ ok: true, commit: r.commit, path });
}

// ---------- priorities: today's and this week's ----------
// Both live in the journal: Journal/Daily/<date>.md for today and Journal/Weekly/<ISO year>-W<week>.md for the
// week. Each note has "## Priorities" (the operator's list, most important first) and "## Suggested priorities"
// (written by MORNING or WEEKLY and never changed here; adding one copies it into Priorities). A line points at a
// task by its words and the note it lives in, "- Decide on Gmail access · [[Now]]", with an optional indented
// "- Why:" note; when a note holds the same words twice, the link names the heading too ([[Note#Heading]]).
// A checkbox line in Priorities ("- [ ] Call the installer") is a one-off of its own, whatever it ends with.
// Nothing is written to the note a task lives in, so adding a priority can never clash with an edit there.
// A priority that no longer matches exactly one task shows as not found: it is never guessed onto another task.

const PRIO = "Priorities";
const SUGG = "Suggested priorities";
type Scope = "day" | "week";
type PrioItem = { line: number; end: number; raw: string; marker: string; checkbox: boolean; done: boolean; text: string; target: string; heading: string; link: string; notes: string[] };
type NoteRef = { path: string; title: string; aliases: string[] };

function scopeInfo(scope: Scope) {
  const now = londonParts();
  if (scope === "day") {
    return { scope, key: now.ymd, path: `Journal/Daily/${now.ymd}.md`, label: `${now.weekday} ${+now.day} ${MONTHS[+now.month - 1]}`, fillDate: now.ymd, word: "today" };
  }
  const iw = isoWeek(now.ymd);
  const key = `${iw.year}-W${String(iw.week).padStart(2, "0")}`;
  const [y, m, d] = now.ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const monday = new Date(dt.getTime() - ((dt.getUTCDay() || 7) - 1) * 86400000);
  const sunday = new Date(monday.getTime() + 6 * 86400000);
  const thursday = new Date(monday.getTime() + 3 * 86400000); // its calendar year is always the ISO year
  const dm = (x: Date) => `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}`;
  const range = monday.getUTCMonth() === sunday.getUTCMonth() ? `${monday.getUTCDate()} to ${dm(sunday)}` : `${dm(monday)} to ${dm(sunday)}`;
  return { scope, key, path: `Journal/Weekly/${key}.md`, label: `Week ${iw.week}, ${range}`, fillDate: thursday.toISOString().slice(0, 10), word: "this week" };
}

// for matching a priority to its task: wikilinks to their label, tags dropped (as the task list drops them), case and punctuation ignored
const normText = (t: string) => String(t || "")
  .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a)
  .replace(/#[a-z0-9-]+\b/gi, "")
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// the task a line means: the same words (under the named heading when there is one), then a task
// whose words start with the line's words or the other way round (text added at the end), then the
// closest match by shared words when exactly one task is clearly the closest. Anything left
// uncertain (no candidate, or two tied) is no match: a suggestion is never guessed onto the wrong task.
function pickTask(pool: any[], want: string, heading = ""): any | null {
  if (!want) return null;
  const h = normText(heading);
  const scoped = h ? pool.filter((t) => normText(t.section) === h) : pool;
  const exact = (list: any[]) => list.filter((t) => normText(t.text) === want);
  let list = exact(scoped);
  if (!list.length && h) { list = exact(pool); if (list.length > 1) return null; }
  if (list.length) return list.find((t) => !t.done) || list[0];
  // A heading that no longer matches (the task moved section, or was reworded) leaves `scoped`
  // empty or wrong, so both fallback tiers below widen to the whole file rather than only ever
  // reporting "not found" whenever a heading was named. This was the main reason nearly every
  // suggested line with a heading in its link showed as missing even when its task still existed.
  const candidates = scoped.length ? scoped : pool;
  const prefix = candidates.filter((t) => {
    const n = normText(t.text);
    const [s, l] = n.length < want.length ? [n, want] : [want, n];
    return s.length >= 16 && l.startsWith(s);
  });
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) return null;
  return closeMatch(candidates, want);
}

// the words of a normalised text, as a set (for overlap, not order)
const wordsOf = (t: string) => new Set(String(t || "").split(" ").filter(Boolean));

// The third tier the README promises ("the same words, then a task whose words start the same
// way, then a close match") but which was missing from the code entirely: the brain's own wording
// for a suggestion is not always verbatim from the checkbox, so a suggestion that shares most of
// its words with exactly one task, and clearly more than with any other, still resolves. A tie, or
// nothing close enough, is left as no match rather than guessed.
function closeMatch(pool: any[], want: string): any | null {
  const a = wordsOf(want);
  if (a.size < 3) return null; // too short to score safely
  const scored = pool
    .map((t) => {
      const b = wordsOf(normText(t.text));
      if (b.size < 3) return { t, score: 0 };
      let shared = 0;
      a.forEach((w) => { if (b.has(w)) shared++; });
      // Dice coefficient: a suggestion is usually the task's own words plus a little added
      // context ("chase the VAT return" -> "chase up the VAT return with HMRC"), so this scores
      // high whenever one text's words are mostly contained in the other, not only when the two
      // are close to the same length.
      return { t, score: (2 * shared) / (a.size + b.size) };
    })
    .filter((x) => x.score >= 0.6)
    .sort((x, y) => y.score - x.score);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].score === scored[1].score) return null;
  return scored[0].t;
}

const baseName = (p: string) => p.split("/").pop()!.replace(/\.md$/, "");
const aliasList = (v: string) => (v || "").replace(/^\[|\]$/g, "").split(",").map((a) => a.trim().replace(/^["']|["']$/g, "")).filter(Boolean);

// [[Now]], [[Wiki/Fernmoor/Fernmoor tasks]], or a title or alias when the notes index is to hand, to a vault path
function targetPath(target: string, paths: string[], notes?: NoteRef[]): string {
  const t = target.replace(/\.md$/i, "").trim();
  if (!t) return "";
  if (paths.includes(`${t}.md`)) return `${t}.md`;
  const lower = t.toLowerCase();
  const byName = paths.filter((p) => baseName(p).toLowerCase() === lower.split("/").pop());
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return byName.find((p) => p.toLowerCase().endsWith(`${lower}.md`)) || byName[0];
  const n = (notes || []).find((x) => x.title.toLowerCase() === lower || x.aliases.some((a) => a.toLowerCase() === lower));
  return n ? n.path : "";
}

// the link written after a task's words; the heading is added only when the note has the same words more than once
function linkFor(path: string, paths: string[], task: any, fileTasks: any[]) {
  const name = baseName(path);
  const clash = paths.filter((p) => baseName(p).toLowerCase() === name.toLowerCase()).length > 1;
  const twin = task.section && fileTasks.filter((t) => normText(t.text) === normText(task.text)).length > 1;
  const inner = (clash ? path.replace(/\.md$/, "") : name) + (twin ? `#${String(task.section).replace(/[\[\]|#^]/g, " ").replace(/\s{2,}/g, " ").trim()}` : "");
  return clash ? `[[${inner}|${name}]]` : `[[${inner}]]`;
}

const WIKI = String.raw`\[\[[^\]]+\]\]`;
const TRAIL = String.raw`\s*(?:#[\w/-]+\s*)*[.;,]?\s*$`; // tags or a full stop after the link are ignored
const PRIO_LINE = /^((?:[-*+]|\d{1,2}[.)])) (?:\[( |x|X)\] )?(.+)$/;
const PRIO_SOURCE = new RegExp(String.raw`(?:\s+(?:·|-|\u2013|\|)\s+|,\s+in\s+)(${WIKI})${TRAIL}|\s+\((?:(?:in|from|see)\s+)?(${WIKI})\)${TRAIL}`);
const PRIO_SOURCE_FIRST = new RegExp(String.raw`^(${WIKI})\s*(?::|·|-|\u2013)\s+(.+)$`);

function parseLink(link: string) {
  const m = link.match(/^\[\[([^\]|#]*)(?:#([^\]|]*))?(?:\|[^\]]*)?\]\]$/);
  return m ? { target: m[1].trim(), heading: (m[2] || "").trim() } : { target: "", heading: "" };
}

function headingIndex(lines: string[], heading: string) {
  return lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
}

function listSection(lines: string[], heading: string): { start: number; end: number; items: PrioItem[] } | null {
  const start = headingIndex(lines, heading);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^#{1,2} /.test(lines[i])) { end = i; break; }
  const items: PrioItem[] = [];
  for (let i = start + 1; i < end; i++) {
    const m = lines[i].match(PRIO_LINE);
    if (!m) continue;
    const notes: string[] = [];
    let j = i + 1;
    while (j < end && /^\s+\S/.test(lines[j])) { notes.push(lines[j].trim().replace(/^[-*+]\s+/, "")); j++; }
    const checkbox = m[2] !== undefined;
    let text = m[3].trim(), link = "";
    // in the operator's list a checkbox line is a one-off, even when it ends with a link; the brain's lines are read for links
    if (!(checkbox && heading === PRIO)) {
      const s = text.match(PRIO_SOURCE), f = s ? null : text.match(PRIO_SOURCE_FIRST);
      if (s) { link = s[1] || s[2]; text = text.slice(0, s.index).trim(); }
      else if (f) { link = f[1]; text = f[2].trim(); }
    }
    if (!text || /^\[( |x|X)\]$/.test(text)) { i = j - 1; continue; }
    const { target, heading: linkHeading } = link ? parseLink(link) : { target: "", heading: "" };
    items.push({ line: i, end: j, raw: lines[i], marker: m[1], checkbox, done: checkbox && m[2] !== " ", text, target, heading: linkHeading, link, notes });
    i = j - 1;
  }
  return { start, end, items };
}

const whyOf = (notes: string[]) => {
  for (const n of notes) { const m = n.match(/^[*_]*why[*_]*\s*:\s*[*_]*\s*(.*)$/i); if (m) return m[1].replace(/[*_]+$/, "").trim(); }
  return "";
};

// Priorities goes after the Plan in a daily note and above What moved in a weekly one
function ensurePrioSection(lines: string[], scope: Scope) {
  if (headingIndex(lines, PRIO) >= 0) return;
  let at = headingIndex(lines, SUGG);
  if (at < 0 && scope === "day") {
    const plan = headingIndex(lines, "Plan");
    if (plan >= 0) { at = lines.length; for (let i = plan + 1; i < lines.length; i++) if (/^#{1,2} /.test(lines[i])) { at = i; break; } }
    else at = headingIndex(lines, "Log");
  }
  if (at < 0 && scope === "week") {
    at = headingIndex(lines, "What moved");
    if (at < 0) at = lines.findIndex((l) => /^## /.test(l));
  }
  if (at < 0) at = lines.length;
  const block = ["## Priorities", ""];
  if (at > 0 && lines[at - 1].trim() !== "") block.unshift("");
  lines.splice(at, 0, ...block);
}

function insertPrio(lines: string[], lineText: string) {
  const sec = listSection(lines, PRIO)!;
  let at: number;
  if (sec.items.length) at = sec.items[sec.items.length - 1].end;
  else { at = sec.end; while (at > sec.start + 1 && lines[at - 1].trim() === "") at--; }
  const block = [lineText];
  if (!sec.items.length && lines[at - 1] !== undefined && lines[at - 1].trim() !== "") block.unshift("");
  lines.splice(at, 0, ...block);
  const after = at + block.length;
  if (after >= lines.length) lines.push("");
  else if (lines[after].trim() !== "" && !/^\s/.test(lines[after]) && !PRIO_LINE.test(lines[after])) lines.splice(after, 0, "");
}

function tidySection(lines: string[], heading: string) {
  const start = headingIndex(lines, heading);
  if (start < 0) return;
  for (let i = start + 1; i < lines.length - 1; i++) {
    if (/^#{1,2} /.test(lines[i])) break;
    if (lines[i].trim() === "" && lines[i + 1].trim() === "") { lines.splice(i, 1); i--; }
  }
}

async function loadPeriodNote(info: ReturnType<typeof scopeInfo>) {
  const f = await readFile(info.path);
  if (f) return { content: f.content, sha: f.sha as string | undefined };
  const tpl = await readFile(info.scope === "day" ? "Templates/Daily note.md" : "Templates/Weekly review.md");
  const today = londonParts();
  let content: string;
  if (tpl) content = fillTemplate(tpl.content, info.fillDate).replace(/^updated: .*$/m, `updated: ${today.ymd}`);
  else if (info.scope === "day") content = `---\ntitle: ${today.ymd}\ntype: journal\nowner: the operator\nupdated: ${today.ymd}\ntags:\n  - journal/daily\n---\n\n# ${today.weekday} ${+today.day} ${MONTHS[+today.month - 1]} ${today.year}\n\n## Plan\n\n## Priorities\n\n## Log\n\n## Sessions\n\n## Review\n\n## Carry forward\n`;
  else content = `---\ntitle: ${info.key}\ntype: journal\nowner: the operator\nupdated: ${today.ymd}\ntags:\n  - journal/weekly\n---\n\n# Week ${+info.key.split("-W")[1]}, ${info.key.split("-W")[0]}\n\n## Priorities\n`;
  return { content, sha: undefined };
}

type Applied = { ok: true; message?: string; unchanged?: boolean; extra?: Record<string, unknown> } | { ok: false; status: number; error: string; conflict?: boolean };

// read (or create) the day or week note, apply a change, write it back; one retry if a job wrote in between
async function editPeriod(scope: Scope, key: string, apply: (lines: string[]) => Applied) {
  const info = scopeInfo(scope);
  if (key && key !== info.key) {
    return json({ error: scope === "day" ? "It is a new day. Refresh to see today's priorities." : "A new week has started. Refresh to see this week's priorities.", conflict: true, stale: true }, 409);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const note = await loadPeriodNote(info);
    const lines = note.content.split("\n");
    const r = apply(lines);
    if (r.ok === false) { const bad = r as Extract<Applied, { ok: false }>; return json({ error: bad.error, conflict: bad.conflict || undefined }, bad.status); }
    const good = r as Extract<Applied, { ok: true }>;
    if (good.unchanged) return json({ ok: true, unchanged: true, ...(good.extra || {}) });
    try {
      const w = await writeFile(info.path, lines.join("\n"), good.message || `platform: priorities ${info.word}`, note.sha);
      return json({ ok: true, commit: w.commit, path: info.path, ...(good.extra || {}) });
    } catch (e: any) {
      if (e.status !== 409 && e.status !== 422) throw e;
    }
  }
  return json({ error: "The note kept changing while saving. Refresh and try again.", conflict: true }, 409);
}

// titles and aliases for every note, from the blob cache; only fetched when a link does not name a note by its file name
async function notesIndex(tree: { entries: TreeEntry[] }): Promise<NoteRef[]> {
  return Promise.all(tree.entries.map(async (e) => {
    const { fm } = frontmatter(await blob(e));
    return { path: e.path, title: fm.title || baseName(e.path), aliases: aliasList(fm.aliases) };
  }));
}

// the tasks in each note that the given lines name, read fresh, and how to resolve a link
async function tasksForTargets(targets: string[]) {
  const tree = await getTree(true);
  const paths = tree.entries.map((e) => e.path);
  const notes = targets.some((t) => t && !targetPath(t, paths)) ? await notesIndex(tree) : undefined;
  const resolve = (t: string) => targetPath(t, paths, notes);
  const byPath = new Map<string, any[]>();
  const wanted = [...new Set(targets.map(resolve).filter(Boolean))];
  await Promise.all(wanted.map(async (p) => {
    const e = tree.entries.find((x) => x.path === p);
    if (e) byPath.set(p, scanTasks(p, await blob(e), ""));
  }));
  return { paths, byPath, resolve };
}

function sameTask(it: PrioItem, path: string, task: any, resolve: (t: string) => string, byPath: Map<string, any[]>) {
  if (it.checkbox || !it.target || resolve(it.target) !== path) return false;
  const hit = pickTask(byPath.get(path) || [], normText(it.text), it.heading);
  return hit ? hit.line === task.line : normText(it.text) === normText(task.text);
}

async function priorityAdd(scope: Scope, key: string, file: string, text: string, line: number) {
  const clean = oneLine(text);
  if (!clean) return json({ error: "A priority needs some words." }, 400);
  const word = scopeInfo(scope).word;
  if (!file) {
    return editPeriod(scope, key, (lines) => {
      ensurePrioSection(lines, scope);
      const sec = listSection(lines, PRIO)!;
      if (sec.items.some((it) => it.checkbox && normText(it.text) === normText(clean))) return { ok: true, unchanged: true, extra: { already: true } };
      insertPrio(lines, `- [ ] ${clean}`);
      return { ok: true, message: `platform: ${word}, add ${clean.slice(0, 50)}` };
    });
  }
  if (!safeNotePath(file)) return json({ error: "bad path" }, 400);
  const f = await readFile(file);
  if (!f) return json({ error: "That task's note is gone. Refresh and try again.", conflict: true }, 409);
  const fileTasks = scanTasks(file, f.content, "");
  const task = fileTasks.find((t) => t.line === line && t.text === clean) || (fileTasks.filter((t) => t.text === clean).length === 1 ? fileTasks.find((t) => t.text === clean) : null);
  if (!task) return json({ error: "That task changed since you loaded it. Refresh and try again.", conflict: true }, 409);
  const current = await readFile(scopeInfo(scope).path);
  const targets = current ? (listSection(current.content.split("\n"), PRIO)?.items || []).map((it) => it.target).filter(Boolean) : [];
  const { paths, byPath, resolve } = await tasksForTargets(targets);
  byPath.set(file, fileTasks);
  return editPeriod(scope, key, (lines) => {
    ensurePrioSection(lines, scope);
    const sec = listSection(lines, PRIO)!;
    if (sec.items.some((it) => sameTask(it, file, task, resolve, byPath))) return { ok: true, unchanged: true, extra: { already: true } };
    insertPrio(lines, `- ${task.text} · ${linkFor(file, paths, task, fileTasks)}`);
    return { ok: true, message: `platform: ${word}, add ${task.text.slice(0, 50)}` };
  });
}

// add one suggestion (by its line) or all of them; a suggestion whose task cannot be found is skipped and counted
async function priorityFromSuggestions(scope: Scope, key: string, raw: string) {
  const info = scopeInfo(scope);
  const current = await readFile(info.path);
  const lines0 = current ? current.content.split("\n") : [];
  const sugg = listSection(lines0, SUGG);
  if (!sugg || !sugg.items.length) return json({ error: "There are no suggestions to add. Refresh and try again.", conflict: true }, 409);
  const targets = [...sugg.items, ...(listSection(lines0, PRIO)?.items || [])].map((it) => it.target).filter(Boolean);
  const { paths, byPath, resolve } = await tasksForTargets(targets);
  return editPeriod(scope, key, (lines) => {
    ensurePrioSection(lines, scope);
    const s = listSection(lines, SUGG);
    const chosen = s ? (raw ? s.items.filter((it) => it.raw === raw) : s.items) : [];
    if (!chosen.length) return { ok: false, status: 409, error: "The suggestions changed since you loaded them. Refresh and try again.", conflict: true };
    let added = 0, skipped = 0, already = 0;
    for (const it of chosen) {
      const sec = listSection(lines, PRIO)!;
      if (!it.target) {
        if (sec.items.some((x) => x.checkbox && normText(x.text) === normText(it.text))) { already++; continue; }
        insertPrio(lines, `- [ ] ${it.text}`);
        added++;
        continue;
      }
      const path = resolve(it.target);
      const task = path ? pickTask(byPath.get(path) || [], normText(it.text), it.heading) : null;
      if (!task) { skipped++; continue; }
      if (sec.items.some((x) => sameTask(x, path, task, resolve, byPath))) { already++; continue; }
      insertPrio(lines, `- ${task.text} · ${linkFor(path, paths, task, byPath.get(path) || [])}`);
      added++;
    }
    if (!added) {
      if (raw && skipped) return { ok: false, status: 409, error: "The task behind that suggestion is gone or has changed.", conflict: true };
      return { ok: true, unchanged: true, extra: { added, skipped, already } };
    }
    return { ok: true, message: `platform: ${info.word}, ${added === 1 ? "add a suggestion" : `add ${added} suggestions`}`, extra: { added, skipped, already } };
  });
}

async function priorityLine(scope: Scope, key: string, action: "remove" | "move" | "toggle", line: number, raw: string, dir: number, done: boolean) {
  return editPeriod(scope, key, (lines) => {
    const sec = listSection(lines, PRIO);
    const it = sec ? (sec.items.find((x) => x.line === line && x.raw === raw) || (sec.items.filter((x) => x.raw === raw).length === 1 ? sec.items.find((x) => x.raw === raw) : undefined)) : undefined;
    if (!sec || !it) return { ok: false, status: 409, error: "Your priorities changed since you loaded them. Refresh and try again.", conflict: true };
    const label = normText(it.text).slice(0, 50);
    const word = scopeInfo(scope).word;
    if (action === "remove") {
      lines.splice(it.line, it.end - it.line);
      tidySection(lines, PRIO);
      return { ok: true, message: `platform: ${word}, remove ${label}` };
    }
    if (action === "move") {
      const idx = sec.items.indexOf(it), other = sec.items[idx + (dir < 0 ? -1 : 1)];
      if (!other) return { ok: true, unchanged: true };
      const [a, b] = dir < 0 ? [other, it] : [it, other];
      const blockA = lines.slice(a.line, a.end), between = lines.slice(a.end, b.line), blockB = lines.slice(b.line, b.end);
      lines.splice(a.line, b.end - a.line, ...blockB, ...between, ...blockA);
      return { ok: true, message: `platform: ${word}, move ${label} ${dir < 0 ? "up" : "down"}` };
    }
    if (it.target) return { ok: false, status: 400, error: "This one is a task: tick it from its checkbox." };
    lines[it.line] = `${it.marker} [${done ? "x" : " "}] ${it.text}`;
    return { ok: true, message: `platform: ${word}, ${done ? "tick" : "untick"} ${label}` };
  });
}

// when a task is edited on the platform, the operator's lines for today and this week that point at it follow the new words.
// The brain's suggestions are its record and are left as written.
async function followTaskEdit(file: string, oldText: string, newText: string) {
  if (normText(oldText) === normText(newText)) return;
  try {
    for (const scope of ["day", "week"] as Scope[]) {
      const info = scopeInfo(scope);
      const f = await readFile(info.path);
      if (!f) continue;
      const lines = f.content.split("\n");
      const sec = listSection(lines, PRIO);
      const hits = (sec ? sec.items : []).filter((it) => it.target && normText(it.text) === normText(oldText));
      if (!hits.length) continue;
      const { resolve } = await tasksForTargets(hits.map((it) => it.target));
      let changed = false;
      for (const it of hits) {
        if (resolve(it.target) !== file) continue;
        lines[it.line] = `${it.marker} ${newText} · ${it.link}`;
        changed = true;
      }
      if (changed) await writeFile(info.path, lines.join("\n"), `platform: ${info.word}, follow an edited task`, f.sha);
    }
  } catch { /* best effort: a line that no longer matches shows as not found and can be removed */ }
}

// the day's or week's lists for the page, each line matched to its task
function periodState(scope: Scope, text: string, exists: boolean, tasks: any[], paths: string[], notes: NoteRef[]) {
  const info = scopeInfo(scope);
  const lines = text ? text.split("\n") : [];
  const view = (heading: string) => (listSection(lines, heading)?.items || []).map((it) => {
    const why = whyOf(it.notes);
    const base = { line: it.line, raw: it.raw, why, notes: it.notes.filter((n) => !/^[*_]*why[*_]*\s*:/i.test(n)) };
    if (!it.target) return { ...base, kind: "own", text: it.text, done: it.done };
    const path = targetPath(it.target, paths, notes);
    const task = path ? pickTask(tasks.filter((t) => t.file === path), normText(it.text), it.heading) : null;
    if (!task) return { ...base, kind: "missing", text: it.text, source: it.heading ? `${it.target} > ${it.heading}` : it.target, file: path, done: false };
    return { ...base, kind: "task", text: task.text, taskId: task.id, file: task.file, source: task.project + (it.heading ? ` > ${task.section}` : ""), tag: task.tag, done: task.done };
  });
  const items = view(PRIO);
  const suggested = view(SUGG).map((s: any) => ({
    ...s,
    added: items.some((i: any) => (s.kind === "task" && i.kind === "task" && i.taskId === s.taskId) || (s.kind === "own" && i.kind === "own" && normText(i.text) === normText(s.text))),
  }));
  return { key: info.key, label: info.label, path: info.path, exists, items, suggested };
}

// ---------- snooze: approvals and needs rows, hidden until a chosen time ----------
// Later today, tomorrow, Monday or a picked date, worked out in the browser (so it means
// whatever "today" means to the operator, wherever they are) and sent here as a plain ISO timestamp, keyed
// by the row's own id (an approval's a-... id, or a needs task's file::line id). This never
// touches the vault: the row itself, and its status, is exactly what it was before. A row whose
// time has passed is simply no longer snoozed; nothing here needs to notice that on its own, so
// there is nothing to prune on a schedule.
// One key per row ("row/<id>") in a store read with strong consistency, so a refresh straight
// after a snooze sees it and two snoozes close together never overwrite each other. The old
// shared "map" key is still read underneath (lib/settle.mts readRows), never written.
const snoozeStore = () => blobStore("brain-snooze", { consistency: "strong", perVisitor: true });

async function getSnoozes(): Promise<Record<string, string>> {
  return settle.readRows<string>(snoozeStore() as unknown as settle.BlobStore);
}

async function setSnooze(id: string, until: string | null): Promise<Record<string, string>> {
  await settle.writeRowState(snoozeStore() as unknown as settle.BlobStore, id, until);
  return getSnoozes();
}

// ---------- review: settling finished work, platform side only ----------
// "Done for review" (the client shows a done row from the last 7 days until it is settled) has no
// vault state of its own, the same way snooze does not: Accept and Later only ever change this map,
// keyed by the row's id, in its own Blobs store. Only Redo touches the vault, because Redo is the
// one action that actually changes what the row means (see reviewAction below).
type ReviewEntry = { status: "settled" | "later"; at: string };
// Same shape as snooze above: strong consistency, one key per row, the legacy "map" folded in.
const reviewStore = () => blobStore("brain-review", { consistency: "strong", perVisitor: true });

async function getReviewState(): Promise<Record<string, ReviewEntry>> {
  return settle.readRows<ReviewEntry>(reviewStore() as unknown as settle.BlobStore);
}

async function setReview(id: string, entry: ReviewEntry | null): Promise<Record<string, ReviewEntry>> {
  await settle.writeRowState(reviewStore() as unknown as settle.BlobStore, id, entry);
  return getReviewState();
}

// Ensure a row array reaches at least `n` cells, padding with blanks, so an older row with no
// priority cell (or, before this build, no 11th cell at all) can still be written to safely.
function padCells(cells: string[], n: number): string[] {
  while (cells.length < n) cells.push("");
  return cells;
}

function findQueueRow(lines: string[], id: string): { at: number; cells: string[] } | null {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!/^\s*\|/.test(l)) continue;
    const cells = l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (cells[0] === id) return { at: i, cells };
  }
  return null;
}

// Accept and Later never touch the vault: the row in System/Approvals.md, and its status, stay
// exactly as Claude left them. Redo does the opposite: it is the one action that sends the row
// back to work, so it sets status to "approved" and appends the operator's note to the row's own note
// column (never overwriting the trail already there), the same append convention the vault uses
// everywhere else: a new dated clause, separated by "; ", added after what is already written.
async function reviewAction(id: string, action: string, noteText: string) {
  if (!id) return json({ error: "bad request" }, 400);
  if (action === "accept") return json({ ok: true, reviewState: await setReview(id, { status: "settled", at: londonParts().ymd + " " + londonParts().hm }) });
  if (action === "later") return json({ ok: true, reviewState: await setReview(id, { status: "later", at: londonParts().ymd + " " + londonParts().hm }) });
  if (action !== "redo") return json({ error: "bad request" }, 400);
  const note = oneLine(noteText);
  if (!note) return json({ error: "Write a note saying what still needs to change." }, 400);
  if (/\u2014/.test(note)) return json({ error: "No em dashes in the vault." }, 400);
  for (let attempt = 0; attempt < 3; attempt++) {
    const f = await readFile("System/Approvals.md");
    if (!f) return json({ error: "Approvals is missing" }, 404);
    const lines = f.content.split("\n");
    const row = findQueueRow(lines, id);
    if (!row) return json({ error: `row ${id} not found` }, 404);
    if ((row.cells[1] || "").toLowerCase() !== "done") return json({ error: "Only work marked done can be sent back for a redo." }, 400);
    const cells = padCells(row.cells, 10);
    const today = londonParts();
    const clause = `${+today.day} ${MONTHS[+today.month - 1].slice(0, 3)} ${today.hm}: Redo requested. ${note}`;
    const existing = (cells[9] || "").trim();
    cells[9] = cellSafe(existing ? `${existing}; ${clause}` : clause).slice(0, 600);
    cells[1] = "approved";
    if (cells.length > 10) cells[10] = ""; // a fresh redo starts unranked; give it a priority again if it needs one
    lines[row.at] = `| ${cells.join(" | ")} |`;
    try {
      await writeFile("System/Approvals.md", lines.join("\n"), `platform: redo ${id}`, f.sha);
      await setReview(id, null); // no longer "done", so it has nothing to be settled or put off from
      return json({ ok: true, id, redone: true });
    } catch (e: any) {
      if (e.status !== 409 && e.status !== 422) throw e;
    }
  }
  return json({ error: "Approvals was busy. Try again." }, 409);
}

// ---------- approval priority: a ranked P1, P2... on approved and requested rows ----------
// The operator's own order for what a run picks up next, drag or Alt+arrow on the platform. Written as a
// trailing 11th cell on the row, so an older row or a row nothing has ranked yet simply has no
// 11th cell (or a blank one) and reads as unranked. Only approved and requested rows are ever
// ranked, the two statuses a run actually picks work up from; an id for any other row is skipped,
// not an error, since the list on screen and the table in the vault can fall out of step by a
// few seconds while a run is writing.
async function setApprovalPriority(order: string[]) {
  const ids = Array.from(new Set(order.map((s) => String(s || "").trim()).filter(Boolean))).slice(0, 300);
  if (!ids.length) return json({ error: "bad request" }, 400);
  for (let attempt = 0; attempt < 3; attempt++) {
    const f = await readFile("System/Approvals.md");
    if (!f) return json({ error: "Approvals is missing" }, 404);
    const lines = f.content.split("\n");
    let rank = 0, changed = false;
    for (const id of ids) {
      const row = findQueueRow(lines, id);
      if (!row) continue;
      if (!["approved", "requested"].includes((row.cells[1] || "").toLowerCase())) continue;
      rank++;
      const cells = padCells(row.cells, 11);
      const label = `P${rank}`;
      if (cells[10] !== label) { cells[10] = label; changed = true; }
      lines[row.at] = `| ${cells.join(" | ")} |`;
    }
    if (!changed) return json({ ok: true, unchanged: true });
    try {
      const r = await writeFile("System/Approvals.md", lines.join("\n"), "platform: reorder priorities", f.sha);
      return json({ ok: true, commit: r.commit });
    } catch (e: any) {
      if (e.status !== 409 && e.status !== 422) throw e;
    }
  }
  return json({ error: "Approvals was busy. Try again." }, 409);
}

// ---------- leads: the Owlbridge pipeline table, for the Leads area ----------
// The parsing and the row edits live in lib/leads.mts; this is only the wiring to GitHub. Every
// write re-reads the note and changes one row by its id (leadgen.writeRow), the same per-row
// pattern the Approvals writes above use, because the Director writes the same table.
// Opting a lead out also adds the company to the suppression list in the lead gen station note,
// and that is written first: if the status write then fails, the company is still suppressed,
// which is the safe way round. Nothing here sends or contacts anyone; it only edits the vault.
const vaultIO: leadgen.VaultIO = { read: readFile, write: (p, c, m, s) => writeFile(p, c, m, s) };
const leadStr = (v: unknown, max = 300) => String(v == null ? "" : v).slice(0, max);

async function leadAction(body: any) {
  const action = String(body.action || "");
  const id = leadStr(body.id, 80).trim();
  const now = londonParts();
  const today = now.ymd, at = `${now.ymd} ${now.hm}`;
  const fail = (r: { status: number; error: string }) => json({ error: r.error, conflict: r.status === 409 || undefined }, r.status);
  // Every change made here is one of the operator's clicks, so the activity line is theirs.
  const line = (lead: string, type: string, summary: string): leadgen.ActivityEntry => ({ at, lead, type, summary, by: "Operator" });
  const after = (r: leadgen.Applied, set: Record<string, string>) => ({ ...(r.ok ? r.before || {} : {}), ...set });
  const done = (r: any, extra: Record<string, unknown> = {}) => json({
    ok: true, id: r.id || id, commit: r.commit, unchanged: r.unchanged || undefined,
    logged: r.logged || undefined, activityError: r.activityError || undefined, ...extra,
  });

  if (action === "status") {
    const status = leadStr(body.status, 40).toLowerCase();
    if (!id || !leadgen.LEAD_STATUSES.includes(status)) return json({ error: "bad request" }, 400);
    let suppressed: boolean | undefined;
    if (status === "opted out") {
      if (body.confirm !== true) return json({ error: "Opting a lead out needs a confirmation." }, 400);
      const p = await readFile(leadgen.PIPELINE_PATH);
      const lead = p ? leadgen.parseLeads(p.content).leads.find((l) => l.id === id) : undefined;
      if (!lead) return json({ error: `Lead ${id} is no longer in Owlbridge pipeline. Refresh and try again.` }, 404);
      const s: any = await leadgen.writeRow(vaultIO, leadgen.STATION_PATH, (t) => leadgen.applySuppress(t, lead.company, lead.email), `platform: suppress ${id}`);
      if (s.ok === false) return fail(s);
      suppressed = true;
    }
    const r = await leadgen.writeWithActivity(vaultIO, (t) => leadgen.applyStatus(t, id, status, today), `platform: lead ${id} ${status}`,
      (a) => [line(id, "status", `Status ${(a.ok && a.before?.status) || "blank"} to ${status}` + (suppressed ? "; added to the suppression list" : ""))],
      `platform: activity ${id} status`);
    if (r.ok === false) return fail(r);
    return done(r, { status, suppressed });
  }

  if (action === "next") {
    if (!id) return json({ error: "bad request" }, 400);
    const step = leadStr(body.nextStep), date = leadStr(body.nextDate, 10).trim();
    const r = await leadgen.writeWithActivity(vaultIO, (t) => leadgen.applyNext(t, id, step, date), `platform: lead ${id} next step`,
      (a) => { const d = a.ok ? leadgen.describeEdit(a.before || {}, after(a, { "next step": step, "next date": date }), a.changed || []) : ""; return d ? [line(id, "system", d)] : []; },
      `platform: activity ${id} next step`);
    if (r.ok === false) return fail(r);
    return done(r);
  }

  // The record page's Fields card: one save, one activity line naming what changed.
  if (action === "fields") {
    if (!id) return json({ error: "bad request" }, 400);
    const input: Record<string, string> = {};
    for (const k of ["segment", "tier", "score", "contact", "email", "source", "nextStep", "nextDate"]) if (body[k] !== undefined && body[k] !== null) input[k] = leadStr(body[k], k === "nextDate" ? 10 : k === "score" ? 3 : 300);
    const cellOf: Record<string, string> = { nextStep: "next step", nextDate: "next date" };
    const set: Record<string, string> = {};
    for (const [k, v] of Object.entries(input)) set[cellOf[k] || k] = v.trim();
    const r = await leadgen.writeWithActivity(vaultIO, (t) => leadgen.applyFields(t, id, input), `platform: lead ${id} fields`,
      (a) => { const d = a.ok ? leadgen.describeEdit(a.before || {}, after(a, set), a.changed || []) : ""; return d ? [line(id, "system", d)] : []; },
      `platform: activity ${id} fields`);
    if (r.ok === false) return fail(r);
    return done(r);
  }

  // The composer: a note, call, email or meeting. Today becomes the last touch.
  if (action === "log") {
    const type = leadStr(body.type, 20).toLowerCase();
    const summary = leadgen.activityText(leadStr(body.summary, 600));
    if (!id || !leadgen.LOG_TYPES.includes(type)) return json({ error: "bad request" }, 400);
    if (!summary) return json({ error: "Write what happened first." }, 400);
    const r = await leadgen.writeRow(vaultIO, leadgen.PIPELINE_PATH, (t) => leadgen.applyTouch(t, id, today), `platform: lead ${id} touched`);
    if (r.ok === false) return fail(r);
    const a = await leadgen.appendActivity(vaultIO, [line(id, type, summary)], `platform: activity ${id} ${type}`);
    if (a.ok === false) return fail(a);
    return json({ ok: true, id, commit: a.commit, logged: 1 });
  }

  // Done on a Today row: logs the finished step and sets the next one in one save.
  if (action === "done") {
    if (!id) return json({ error: "bad request" }, 400);
    const step = leadStr(body.nextStep), date = leadStr(body.nextDate, 10).trim();
    const r = await leadgen.writeWithActivity(vaultIO, (t) => leadgen.applyDone(t, id, step, date, today), `platform: lead ${id} step done`,
      (a) => {
        const was = (a.ok && a.before?.["next step"]) || "the next step";
        const next = step || date ? `Next: ${step || "none written"}${date ? " by " + date : ", no date"}` : "No next step set";
        return [line(id, "note", `Done: ${was}. ${next}`)];
      }, `platform: activity ${id} step done`);
    if (r.ok === false) return fail(r);
    return done(r);
  }

  // The list's bulk bar: one pipeline write for every ticked row, one activity line per lead.
  if (action === "bulk") {
    const ids = Array.isArray(body.ids) ? body.ids.slice(0, 200).map((x: unknown) => leadStr(x, 80)) : [];
    const op = leadStr(body.op, 20), value = leadStr(body.value, op === "nextDate" ? 10 : 300);
    let changes: leadgen.BulkChange[] = [], missing: string[] = [], kept: string[] = [];
    const r = await leadgen.writeWithActivity(vaultIO,
      (t) => { const b = leadgen.applyBulk(t, ids, op, value, today); if (b.ok) { changes = b.changes || []; missing = b.missing || []; kept = b.kept || []; } return b; },
      (a) => `platform: leads bulk ${op} (${changes.length})`,
      () => changes.map((c) => {
        const set = op === "status" ? { "status": value.toLowerCase(), "last touch": today } : op === "nextDate" ? { "next date": value.trim() } : { "next step": value.trim() };
        return line(c.id, op === "status" ? "status" : "system", leadgen.describeEdit(c.before, { ...c.before, ...set }, c.changed));
      }).filter((e) => e.summary),
      `platform: activity bulk ${op}`);
    if (r.ok === false) return fail(r);
    return done(r, { changed: changes.map((c) => c.id), missing: missing.length ? missing : undefined, kept: kept.length ? kept : undefined });
  }

  if (action === "add") {
    const station = await readFile(leadgen.STATION_PATH);
    const suppressed = station ? leadgen.parseSuppression(station.content).map((s) => s.company) : [];
    const input: leadgen.NewLead = {
      company: leadStr(body.company, 120), segment: leadStr(body.segment, 80), tier: leadStr(body.tier, 20),
      score: leadStr(body.score, 3), contact: leadStr(body.contact, 120), email: leadStr(body.email, 120),
      source: leadStr(body.source, 80), nextStep: leadStr(body.nextStep), nextDate: leadStr(body.nextDate, 10).trim(),
    };
    const r = await leadgen.writeWithActivity(vaultIO, (t) => leadgen.applyAdd(t, input, suppressed), (a) => `platform: lead ${a.ok ? a.id : ""} added`,
      (a) => (a.ok && a.id ? [line(a.id, "system", `Added to the pipeline from the platform, status researched`)] : []),
      `platform: activity lead added`);
    if (r.ok === false) return fail(r);
    return done(r);
  }

  return json({ error: "bad request" }, 400);
}

// ---------- the approvals watcher, started on demand ----------
// Approving a row or sending a request starts the cloud watcher routine through its API trigger, so work
// begins straight away instead of waiting for a schedule. The URL (or the routine id) and the token live only
// in the Netlify environment as WATCHER_FIRE_URL and WATCHER_FIRE_TOKEN; without both, nothing is called.
const FIRE_API = "https://api.anthropic.com/v1/claude_code/routines/";
let lastFire = 0;
function watcherConfig(): { url: string; token: string } | null {
  if (DEMO()) return null; // the demo never starts a cloud run
  const raw = (Netlify.env.get("WATCHER_FIRE_URL") || "").trim();
  const token = (Netlify.env.get("WATCHER_FIRE_TOKEN") || "").trim();
  const url = /^trig_[A-Za-z0-9]+$/.test(raw) ? `${FIRE_API}${raw}/fire` : raw;
  const valid = url.startsWith(FIRE_API) && /\/routines\/trig_[A-Za-z0-9]+\/fire$/.test(url) && token.length >= 20 && !/\s/.test(token);
  return valid ? { url, token } : null;
}
// ---------- chat ----------
// A thread in the vault. The operator writes from the platform, the watcher and the evening job
// read the file and answer in it. No model runs here: the platform only reads and appends.
const CHAT_PATH = "System/Chat.md";
const CHAT_HEAD = [
  "---",
  "title: Chat",
  "type: log",
  "owner: the operator",
  "tags:",
  "  - system",
  "  - log",
  "---",
  "",
  "# Chat",
  "",
  "The operator writes here from the platform. Every run opens this file, answers anything from them that has no answer under it yet, and does the work the message asks for rather than describing it. Reply by appending a block in the same shape, `## YYYY-MM-DD HH:MM \u00b7 Brain`, at the end of the file. Keep replies short and say what was done and where. If a message needs a decision, a send, spend or a delete, raise it as a row in [[Approvals]] and say so in the reply.",
  "",
].join("\n");

type ChatMsg = { at: string; who: string; text: string };

function parseChat(md: string): ChatMsg[] {
  const out: ChatMsg[] = [];
  let cur: ChatMsg | null = null;
  for (const l of md.split("\n")) {
    const m = l.match(/^##\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s*[\u00b7|-]\s*(Operator|You|Brain)\s*$/i);
    if (m) {
      if (cur) out.push(cur);
      cur = { at: `${m[1]} ${m[2]}`, who: /brain/i.test(m[3]) ? "Brain" : "Operator", text: "" };
      continue;
    }
    if (cur) cur.text += l + "\n";
  }
  if (cur) out.push(cur);
  return out.map((m) => ({ ...m, text: m.text.trim() })).filter((m) => m.text);
}

async function getChat() {
  const f = await readFile(CHAT_PATH);
  const messages = f ? parseChat(f.content) : [];
  const unanswered = messages.length && messages[messages.length - 1].who === "Operator";
  return json({ messages, exists: Boolean(f), waiting: Boolean(unanswered) });
}

async function addChatMessage(text: string) {
  // strip anything that could forge a block header or a heading
  const msg = String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*#{1,6}\s+/, ""))
    .join("\n")
    .trim();
  if (!msg) return json({ error: "Write something first." }, 400);
  if (msg.length > 4000) return json({ error: "That is long for one message. Keep it under 4000 characters, or write it as a note on a task." }, 400);
  for (let attempt = 0; attempt < 3; attempt++) {
    const f = await readFile(CHAT_PATH);
    const t = londonParts();
    const body = (f ? f.content.replace(/\s*$/, "") : CHAT_HEAD) + `\n\n## ${t.ymd} ${t.hm} \u00b7 Operator\n${msg}\n`;
    try {
      const r = await writeFile(CHAT_PATH, body, "platform: chat from the operator", f ? f.sha : undefined);
      return json({ ok: true, commit: r.commit, messages: parseChat(body), waiting: true });
    } catch (e: any) {
      if (e.status !== 409 && e.status !== 422) throw e;
    }
  }
  return json({ error: "The chat file was busy. Try that again." }, 409);
}

// The last start, in Blobs so every function instance sees it. lastFire above only covers one instance,
// which is how three Done presses a minute apart started three runs on 23 Sep.
const fireStore = () => blobStore("brain-watcher");
async function sharedLastFire(): Promise<number> {
  try { const v = await fireStore().get("last", { type: "json" }); return Number(v && v.at) || 0; } catch { return 0; }
}
async function setSharedLastFire(at: number) {
  try { await fireStore().setJSON("last", { at }); } catch { /* the in-memory gap still holds */ }
}

async function fireWatcher(reason: string, minGapMs = 90000): Promise<{ fired: boolean; why?: string }> {
  const cfg = watcherConfig();
  if (!cfg) return { fired: false, why: "not set up" };
  // one start covers a burst of taps: the watcher reads the whole queue and checks it again before it finishes
  const last = Math.max(lastFire, await sharedLastFire());
  if (Date.now() - last < minGapMs) return { fired: false, why: "already started moments ago" };
  const before = last;
  lastFire = Date.now();
  await setSharedLastFire(lastFire);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      signal: ctrl.signal,
      headers: { authorization: `Bearer ${cfg.token}`, "anthropic-beta": "experimental-cc-routine-2026-04-01", "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ text: oneLine(reason).slice(0, 300) }),
    });
    if (!res.ok) { lastFire = 0; await setSharedLastFire(before); return { fired: false, why: `the routine API answered ${res.status}` }; }
    return { fired: true };
  } catch {
    lastFire = 0;
    await setSharedLastFire(before);
    return { fired: false, why: "the routine API did not answer" };
  } finally {
    clearTimeout(timer);
  }
}
// The 90 second gap below only holds inside one function instance, and Netlify spreads calls across
// several, which is how four taps started four runs on 18 Sep. The browser knows better: it tracks the
// run it started and sends x-brain-running while it is still going, so a second start is refused here.
const withWatcher = async (res: Response, reason: string, req?: Request, minGapMs?: number) => {
  if (res.status !== 200) return res;
  const body = await res.json();
  if (req && req.headers.get("x-brain-running") === "1") return json({ ...body, watcher: { fired: false, why: "already going" } });
  return json({ ...body, watcher: await fireWatcher(reason, minGapMs) });
};

// ---------- router ----------

// Every request runs inside its visitor's context, so in demo mode the overlay and the
// per-visitor stores it reads and writes are that visitor's own (lib/demo.mts).
export default async (req: Request) => demo.withVisitor(sessionToken(req), () => handle(req));

// In demo mode a successful write says where it went, so a client (or a curl) can never take
// it for a change to the vault itself.
async function demoNote(res: Response): Promise<Response> {
  if (!DEMO() || res.status !== 200) return res;
  const body = await res.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return res;
  return json({ ...body, demo: { notice: demo.DEMO_NOTICE, visitOnly: true, writes: demo.visitInfo().writes, writeCap: demo.DEMO_WRITE_CAP } });
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "");

  if (route === "health") {
    if (DEMO()) return json({ ok: true, configured: true, demo: true, notice: demo.DEMO_NOTICE, today: demo.demoToday() });
    return json({ ok: true, configured: Boolean(TOKEN() && PASS()), demo: false });
  }

  // Demo mode: no passphrase and no passkeys. One call opens a visit and returns its session.
  if (DEMO() && route.startsWith("auth/")) {
    try {
      if (route === "auth/demo" && req.method === "POST") return json(await auth.enterDemo());
      if (route === "auth/logout" && req.method === "POST") { await auth.revokeSession(sessionToken(req)); return json({ ok: true }); }
      if (route === "auth/passkeys" && req.method === "GET") return json({ passkeys: [], demo: true });
    } catch (e: any) {
      return json({ error: e.message || String(e) }, 500);
    }
    return json({ error: "The demo has no passphrase or passkeys. Use POST /api/auth/demo." }, 404);
  }
  if (route === "auth/demo") return json({ error: "unknown route" }, 404);

  // A deploy preview or branch deploy is not the live site: refuse the whole
  // auth surface there so a passkey can never be registered against, or
  // checked against, an address other than the one the operator actually signs
  // in on. See auth.mts, liveOnlyRefusal.
  if (route.startsWith("auth/")) {
    const refusal = auth.liveOnlyRefusal();
    if (refusal) return json(refusal, 403);
  }

  // ---- sign-in: passphrase, rate limited, then a passkey if one is registered ----
  try {
    if (route === "auth/passphrase" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const result = await auth.checkPassphrase(req, String(body.hash || ""));
      if (!result.ok) {
        if (result.locked) return json({ error: "Too many wrong guesses. Locked for 15 minutes.", lockedUntil: result.lockedUntil }, 429);
        return json({ error: "unauthorised" }, 401);
      }
      return json(result);
    }
    if (route === "auth/webauthn/login-verify" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const result = await auth.verifyLogin(req, body.response);
      if (!result.ok) return json({ error: result.error }, result.error === "locked" ? 429 : 401);
      return json(result);
    }
  } catch (e: any) {
    return json({ error: e.message || String(e) }, 500);
  }

  if (!(await authorised(req))) return json({ error: "unauthorised" }, 401);
  if (!DEMO() && !TOKEN()) return json({ error: "GITHUB_TOKEN is not set in the site's environment variables" }, 500);

  try {
    if (req.method !== "GET" && DEMO()) return await demoNote(await routeRequest(req, url, route));
    return await routeRequest(req, url, route);
  } catch (e: any) {
    // A demo overlay refusal (the write cap, a stale sha) keeps its own status.
    if (e && e.demo) return json({ error: e.message, conflict: e.status === 409 || undefined }, e.status);
    return json({ error: e.message || String(e) }, e.status && e.status >= 400 && e.status < 600 ? 502 : 500);
  }
}

async function routeRequest(req: Request, url: URL, route: string): Promise<Response> {
  {
    // ---- passkey management: needs an existing session, same as any other route ----
    if (route === "auth/logout" && req.method === "POST") { await auth.revokeSession(sessionToken(req)); return json({ ok: true }); }
    if (route === "auth/passkeys" && req.method === "GET") return json({ passkeys: await auth.listPasskeys() });
    if (route === "auth/webauthn/register-options" && req.method === "POST") return json(await auth.registrationOptions(req));
    if (route === "auth/webauthn/register-verify" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const result = await auth.verifyRegistration(req, body.response, String(body.label || "Passkey"));
      return result.ok ? json(result) : json(result, 400);
    }
    if (route === "auth/webauthn/remove" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      await auth.removePasskey(String(body.label || ""));
      return json({ ok: true });
    }

    if (req.method === "GET") {
      if (route === "state") return json(await buildState());
      if (route === "chat") return await getChat();
      if (route === "tree") { const t = await getTree(url.searchParams.get("force") === "1"); return json({ commit: t.sha, entries: t.entries }); }
      if (route === "note") {
        const path = url.searchParams.get("path") || "";
        if (!path.endsWith(".md") || path.includes("..")) return json({ error: "bad path" }, 400);
        const f = await readFile(path);
        if (!f) return json({ error: "not found" }, 404);
        return json({ path, ...f });
      }
      return json({ error: "unknown route" }, 404);
    }

    const body = await req.json().catch(() => ({}));

    if (req.method === "PUT" && route === "note") {
      const { path, content, sha, message } = body;
      if (!path || typeof content !== "string" || !path.endsWith(".md") || path.includes("..")) return json({ error: "bad request" }, 400);
      if (/\u2014/.test(content)) return json({ error: "The vault does not allow em dashes. Replace them and save again." }, 400);
      try {
        const r = await writeFile(path, content, message || `platform: edit ${path.split("/").pop()}`, sha);
        return json({ ok: true, sha: r.sha, commit: r.commit });
      } catch (e: any) {
        if (e.status === 409 || e.status === 422) {
          const latest = await readFile(path);
          return json({ error: "Someone (or a job) changed this note since you opened it.", conflict: true, latest }, 409);
        }
        throw e;
      }
    }

    if (req.method === "POST") {
      if (/\u2014/.test([body.text, body.project, body.title, body.detail].map((v) => String(v || "")).join(" "))) return json({ error: "No em dashes in the vault." }, 400);
      if (["task/toggle", "task/edit", "task/note", "task/request", "task/upload", "task/dismiss"].includes(route) && !safeNotePath(body.file)) return json({ error: "bad path" }, 400);
      if (route === "task/dismiss") return await dismissTask(body.file, Number(body.line), String(body.raw || ""));
      if (route === "task/upload") return await addTaskFile(body.file, Number(body.line), String(body.raw || ""), String(body.name || ""), String(body.data || ""));
      if (route === "task/note") return await addTaskNote(body.file, Number(body.line), String(body.raw || ""), String(body.text || ""));
      if (route === "task/request") return await withWatcher(await requestFromTask(body.file, Number(body.line), String(body.raw || "")), "A task was sent for approval from the platform", req);
      if (route === "request") return await withWatcher(await addRequest(String(body.title || ""), String(body.detail || ""), "Platform, the operator", String(body.department || "").trim().toLowerCase()), "A request was written in the platform", req);
      if (route === "watcher") {
        if (req.headers.get("x-brain-running") === "1") return json({ fired: false, why: "already going" });
        return json(await fireWatcher("Started by hand from the platform", 20000));
      }
      if (route === "chat") return await withWatcher(await addChatMessage(String(body.text || "")), `The operator wrote in the platform chat: ${String(body.text || "").slice(0, 200)}`, req);
      if (route === "task/add" && body.area === "fernmoor") return await addWorkTask(String(body.text || ""), ["next", "blocked", "decision"].includes(body.tag) ? body.tag : "next", String(body.brand || ""));
      if (route === "task/toggle") {
        const mode: DoneMode = body.mode === "complete" || body.mode === "continue" ? body.mode : "";
        const res = await toggleTask(body.file, Number(body.line), String(body.raw || ""), Boolean(body.done), mode || "continue");
        // Only an explicit Continue starts a run, and presses within two minutes of each other share one.
        if (mode !== "continue" || !body.done || body.file !== "System/Needs from the operator.md") return res;
        return await withWatcher(res, "The operator pressed Continue on a Claude needs from you item", req, 120000);
      }
      if (route === "task/add") return await addTask(String(body.text || "").trim(), ["next", "blocked", "decision"].includes(body.tag) ? body.tag : "next", body.project ? String(body.project).trim() : undefined);
      if (route === "task/edit") return await editTask(body.file, Number(body.line), String(body.raw || ""), String(body.text || ""), ["next", "blocked", "decision"].includes(body.tag) ? body.tag : "next");
      if (route === "priority") {
        const scope: Scope | null = body.scope === "day" || body.scope === "week" ? body.scope : null;
        const key = String(body.key || "");
        if (!scope) return json({ error: "bad request" }, 400);
        if (body.action === "add") return await priorityAdd(scope, key, body.file ? String(body.file) : "", String(body.text || ""), Number(body.line));
        if (body.action === "suggested") return await priorityFromSuggestions(scope, key, body.raw ? String(body.raw) : "");
        if (["remove", "move", "toggle"].includes(body.action)) return await priorityLine(scope, key, body.action, Number(body.line), String(body.raw || ""), Number(body.dir), Boolean(body.done));
        return json({ error: "bad request" }, 400);
      }
      if (route === "approval") {
        const status = ["approved", "declined", "pending"].includes(body.status) ? body.status : null;
        if (!status || !body.id) return json({ error: "bad request" }, 400);
        const res = await setRowStatus("System/Approvals.md", "Queue", String(body.id), status, undefined, 8);
        // The undo window on the front end can hold several approvals open at once, then commit
        // them in a burst. skipWatcher lets it write each row without starting a run per row; it
        // fires POST /api/watcher itself, once, after the last one in the burst has committed.
        if (status !== "approved" || body.skipWatcher) return res;
        return await withWatcher(res, `Approved in the platform: ${String(body.id).replace(/[^a-z0-9-]/gi, "")}`, req);
      }
      // Done for review: Accept and Later only ever touch the platform's own review state
      // (Blobs), never the vault row. Redo sends the row back to "approved" with the operator's note
      // appended, which is a real change to the queue, so a successful redo starts the watcher
      // the same way approving a row does.
      if (route === "review") {
        const action = ["accept", "later", "redo"].includes(body.action) ? String(body.action) : null;
        if (!action || !body.id) return json({ error: "bad request" }, 400);
        const res = await reviewAction(String(body.id), action, String(body.note || ""));
        if (action !== "redo") return res;
        return await withWatcher(res, `A done row was sent back for redo in the platform: ${String(body.id).replace(/[^a-z0-9-]/gi, "")}`, req);
      }
      if (route === "approval/priority") {
        const order = Array.isArray(body.order) ? body.order : null;
        if (!order) return json({ error: "bad request" }, 400);
        return await setApprovalPriority(order);
      }
      if (route === "scout") {
        const status = ["kept", "dismissed", "new"].includes(body.status) ? body.status : null;
        if (!status || !body.id) return json({ error: "bad request" }, 400);
        return await setRowStatus("System/Scout.md", "Findings", String(body.id), status);
      }
      // Snooze an approval or a needs row until a time worked out in the browser. This never
      // touches the vault, so it needs no sha and no conflict handling: only the id and, to set
      // one, a valid ISO timestamp in the future; an empty or missing "until" clears it.
      if (route === "snooze") {
        const id = String(body.id || "").trim();
        if (!id) return json({ error: "bad request" }, 400);
        let until: string | null = null;
        if (body.until) {
          const t = Date.parse(String(body.until));
          if (Number.isNaN(t)) return json({ error: "That is not a date the platform understands." }, 400);
          until = new Date(t).toISOString();
        }
        const snoozes = await setSnooze(id, until);
        return json({ ok: true, snoozes });
      }
      if (route === "lead") {
        if (/\u2014/.test(Object.values(body || {}).map((v) => String(v ?? "")).join(" "))) return json({ error: "No em dashes in the vault." }, 400);
        return await leadAction(body);
      }
      if (route === "journal") {
        if (!body.text || !String(body.text).trim()) return json({ error: "empty" }, 400);
        if (/\u2014/.test(body.text)) return json({ error: "No em dashes in the vault." }, 400);
        return await appendJournal(String(body.text));
      }
    }
    return json({ error: "unknown route" }, 404);
  }
}

export const config = { path: "/api/*" };
