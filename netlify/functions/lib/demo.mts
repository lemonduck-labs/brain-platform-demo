// Demo mode: the platform running against a bundled copy of a vault, with no GitHub token.
//
// When GITHUB_TOKEN is unset, or BRAIN_MODE is "demo", api.mts reads the vault from
// lib/vault-bundle.json (written by scripts/bundle-vault.mjs at build time) instead of the
// GitHub API. Nothing is ever written back to that bundle. A write goes into an overlay held in
// memory for one visitor only, keyed by a hash of their session token, so one visitor never sees
// another's edits and nothing outlives the function instance. A visit holds at most
// DEMO_WRITE_CAP writes and DEMO_BYTE_CAP bytes, and is dropped DEMO_VISIT_MS after it began.
//
// The same visit also holds the state the live site keeps in Netlify Blobs (snoozes, review
// state): see memoryStore below and lib/store.mts. The clock is pinned too: "today" is
// DEMO_TODAY (default 2026-10-22, the demo vault's last day), and the time is real London time.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

const env = (k: string): string => {
  try { return (globalThis as any).Netlify?.env?.get(k) || ""; } catch { return ""; }
};

// ---------- mode ----------

export function isDemo(): boolean {
  const mode = env("BRAIN_MODE").toLowerCase();
  if (mode === "demo") return true;
  if (mode === "live") return false;
  return !env("GITHUB_TOKEN");
}

export const DEMO_NOTICE = "Demo: a fictional vault. Your changes stay in this visit only.";
export const DEMO_WRITE_CAP = 200;
export const DEMO_BYTE_CAP = 3_000_000;
export const DEMO_VISIT_MS = 2 * 60 * 60 * 1000;
const MAX_VISITS = 2000;

// ---------- clock ----------

const YMD = /^\d{4}-\d{2}-\d{2}$/;
export function demoToday(): string {
  const v = env("DEMO_TODAY").trim();
  return YMD.test(v) ? v : "2026-10-22";
}

function realLondonYmd(d: Date): string {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(d)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}

// Whole days between the real London date and the pinned one, so "now" in demo mode is the
// same time of day on DEMO_TODAY.
export function demoOffsetMs(at = new Date()): number {
  if (!isDemo()) return 0;
  const days = Date.parse(demoToday() + "T00:00:00Z") - Date.parse(realLondonYmd(at) + "T00:00:00Z");
  // keep London's wall-clock time when the pinned day and today sit either side of a clock change
  return days + londonOffsetMs(at) - londonOffsetMs(new Date(at.getTime() + days));
}

// London's offset from UTC at an instant, in milliseconds (0 in winter, an hour in summer).
function londonOffsetMs(d: Date): number {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(d)) p[part.type] = part.value;
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return wall - (d.getTime() - d.getMilliseconds());
}

export const nowMs = () => Date.now() + demoOffsetMs();

// ---------- the visitor behind the current request ----------

const ctx = new AsyncLocalStorage<{ visitor: string }>();
export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
export const sha1 = (s: string) => createHash("sha1").update(s, "utf8").digest("hex");

// api.mts wraps each request in this, with the session token the request carries.
export function withVisitor<T>(token: string, fn: () => Promise<T>): Promise<T> {
  return ctx.run({ visitor: token ? sha256("visit:" + token) : "" }, fn);
}

type OverlayFile = { content: string; sha: string; size: number };
type Visit = { startedAt: number; writes: number; bytes: number; files: Map<string, OverlayFile>; stores: Map<string, Map<string, unknown>> };
const visits: Map<string, Visit> = new Map();

function prune() {
  const now = Date.now();
  for (const [k, v] of visits) if (now - v.startedAt > DEMO_VISIT_MS) visits.delete(k);
  while (visits.size > MAX_VISITS) { const first = visits.keys().next().value; if (first === undefined) break; visits.delete(first); }
}

function visit(create = true): Visit | null {
  const id = ctx.getStore()?.visitor || "";
  if (!id) return null;
  prune();
  let v = visits.get(id) || null;
  if (!v && create) { v = { startedAt: Date.now(), writes: 0, bytes: 0, files: new Map(), stores: new Map() }; visits.set(id, v); }
  return v;
}

export function endVisit(token: string) {
  if (token) visits.delete(sha256("visit:" + token));
}

export function visitInfo() {
  const v = visit(false);
  return { notice: DEMO_NOTICE, writes: v ? v.writes : 0, writeCap: DEMO_WRITE_CAP, today: demoToday(), expiresAt: v ? new Date(v.startedAt + DEMO_VISIT_MS).toISOString() : "" };
}

// ---------- the bundled vault ----------

type BundleFile = { path: string; content: string; sha: string; size: number };
type Bundle = { generatedAt: string; source: string; commit: string; files: BundleFile[] };
let bundle: Bundle | null = null;
let byPath: Map<string, BundleFile> = new Map();

// Tests hand in a small bundle of their own instead of the built one.
export function setBundle(b: Bundle) {
  bundle = b;
  byPath = new Map(b.files.map((f) => [f.path, f]));
  visits.clear();
}

async function loadBundle(): Promise<Bundle> {
  if (bundle) return bundle;
  try {
    const mod: any = await import("./vault-bundle.json", { with: { type: "json" } });
    bundle = (mod.default || mod) as Bundle;
  } catch (e: any) {
    const err: any = new Error("Demo mode has no vault bundle. Run `node scripts/bundle-vault.mjs` (npm run bundle) first.");
    err.status = 503;
    err.demo = true;
    throw err;
  }
  byPath = new Map(bundle.files.map((f) => [f.path, f]));
  return bundle;
}

const overlayError = (status: number, message: string) => { const e: any = new Error(message); e.status = status; e.demo = true; return e; };

export type TreeEntry = { path: string; sha: string; size: number };

export const demoVault = {
  async head(): Promise<string> {
    const b = await loadBundle();
    const v = visit(false);
    if (!v || !v.writes) return b.commit;
    return sha1(`${b.commit}:${v.startedAt}:${v.writes}`);
  },

  async tree(): Promise<TreeEntry[]> {
    const b = await loadBundle();
    const v = visit(false);
    const out = new Map<string, TreeEntry>();
    for (const f of b.files) out.set(f.path, { path: f.path, sha: f.sha, size: f.size });
    if (v) for (const [p, f] of v.files) if (p.endsWith(".md")) out.set(p, { path: p, sha: f.sha, size: f.size });
    return Array.from(out.values()).sort((a, c) => a.path.localeCompare(c.path));
  },

  async read(path: string): Promise<{ content: string; sha: string } | null> {
    await loadBundle();
    const o = visit(false)?.files.get(path);
    if (o) return { content: o.content, sha: o.sha };
    const f = byPath.get(path);
    return f ? { content: f.content, sha: f.sha } : null;
  },

  async blob(entry: TreeEntry): Promise<string> {
    const f = await demoVault.read(entry.path);
    return f ? f.content : "";
  },

  // Behaves like the GitHub Contents API: a stale sha is a 409, and writing over an existing
  // file without its sha is a 422, so the platform's retry paths run the same way in the demo.
  async write(path: string, content: string, message: string, sha?: string, base64 = false): Promise<{ sha: string; commit: string }> {
    await loadBundle();
    const v = visit(true);
    if (!v) throw overlayError(401, "unauthorised");
    if (v.writes >= DEMO_WRITE_CAP) throw overlayError(429, `This demo visit has reached its ${DEMO_WRITE_CAP} changes. Sign out and enter the demo again to start fresh.`);
    const current = await demoVault.read(path);
    if (current && !sha) throw overlayError(422, `${path} already exists`);
    if (current && sha && current.sha !== sha) throw overlayError(409, `${path} changed since it was read`);
    const text = base64 ? Buffer.from(content, "base64").toString("utf8") : content;
    const size = Buffer.byteLength(text, "utf8");
    if (v.bytes + size > DEMO_BYTE_CAP) throw overlayError(413, "This demo visit is holding as much as it can. Sign out and enter the demo again to start fresh.");
    const newSha = sha1(`blob ${size}\0${text}`);
    v.files.set(path, { content: text, sha: newSha, size });
    v.writes++;
    v.bytes += size;
    return { sha: newSha, commit: sha1(`${message}:${newSha}:${v.writes}`) };
  },

  async commitInfo(_sha: string): Promise<{ date: string; message: string }> {
    const b = await loadBundle();
    const v = visit(false);
    if (v && v.writes) return { date: new Date(nowMs()).toISOString(), message: `demo: ${v.writes} change${v.writes === 1 ? "" : "s"} in this visit only` };
    return { date: b.generatedAt, message: `demo vault bundle (${b.source})` };
  },
};

// ---------- the stand-in for Netlify Blobs ----------
// Global stores (auth) live for the function instance; per-visitor stores (snoozes, review
// state) live in the visit and go with it.

const globalStores: Map<string, Map<string, unknown>> = new Map();
const GLOBAL_KEY_CAP = 10000;

export function memoryStore(name: string, perVisitor: boolean) {
  const map = (): Map<string, unknown> => {
    if (perVisitor) {
      const v = visit(true);
      if (!v) return new Map();
      let m = v.stores.get(name);
      if (!m) { m = new Map(); v.stores.set(name, m); }
      return m;
    }
    let m = globalStores.get(name);
    if (!m) { m = new Map(); globalStores.set(name, m); }
    return m;
  };
  const clone = (x: unknown) => (x === undefined ? null : JSON.parse(JSON.stringify(x)));
  return {
    async get(key: string, _opts?: { type: "json" }): Promise<any> { return clone(map().get(key)); },
    async setJSON(key: string, value: unknown): Promise<void> {
      const m = map();
      m.delete(key);
      m.set(key, clone(value));
      while (m.size > GLOBAL_KEY_CAP) { const first = m.keys().next().value; if (first === undefined) break; m.delete(first); }
    },
    async delete(key: string): Promise<void> { map().delete(key); },
    async list(opts: { prefix?: string } = {}): Promise<{ blobs: { key: string }[] }> {
      const p = opts.prefix || "";
      return { blobs: Array.from(map().keys()).filter((k) => k.startsWith(p)).map((key) => ({ key })) };
    },
  };
}
