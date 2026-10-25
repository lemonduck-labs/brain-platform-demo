// Approvals that stick (a-2026-09-27-approvals-that-stick): the small pure pieces behind a
// settled Approve, Accept or Snooze, kept here so tests can drive them without Netlify or GitHub.
//
// 1. RowStore: review and snooze state, one Blobs key per row ("row/<id>") instead of one shared
//    "map" key, so two actions close together can never overwrite each other. The old "map" key
//    is still read and folded in underneath, so nothing settled before this build comes back.
// 2. writeWithRetry: read, apply, write against the sha that was read; on a GitHub 409 or 422
//    (the file moved in between) read again and reapply, up to three attempts in all, the same
//    way addChatMessage does.

// ---------- per-row Blobs state ----------

// The part of a Netlify Blobs store this needs: api.mts passes the real one, tests a fake.
export type BlobStore = {
  get(key: string, opts: { type: "json" }): Promise<any>;
  setJSON(key: string, value: unknown): Promise<unknown>;
  list(opts: { prefix: string }): Promise<{ blobs: { key: string }[] }>;
};

export const ROW_PREFIX = "row/";
export const LEGACY_KEY = "map";

// Ids can hold slashes and colons (a needs row's id is "file::line"), so the id is encoded into
// the key and decoded back on the way out.
export const rowKey = (id: string) => ROW_PREFIX + encodeURIComponent(id);
export const idFromKey = (key: string) => {
  try { return decodeURIComponent(key.slice(ROW_PREFIX.length)); } catch { return key.slice(ROW_PREFIX.length); }
};

// What one per-row key holds: the value, or a marker that the row was cleared. The marker is
// kept (not the key deleted) so a row cleared after this build stays cleared even when the old
// shared map still names it.
type RowRecord<T> = { value: T } | { cleared: true };

// Every row's current value: the legacy map first, then each per-row key on top (per-row wins).
export async function readRows<T>(store: BlobStore): Promise<Record<string, T>> {
  const [legacy, listed] = await Promise.all([
    store.get(LEGACY_KEY, { type: "json" }).catch(() => null),
    store.list({ prefix: ROW_PREFIX }),
  ]);
  const out: Record<string, T> = {};
  if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
    for (const [id, v] of Object.entries(legacy)) if (v !== null && v !== undefined) out[id] = v as T;
  }
  const keys = (listed && listed.blobs ? listed.blobs : []).map((b) => b.key).filter((k) => k.startsWith(ROW_PREFIX));
  const records = await Promise.all(keys.map((k) => store.get(k, { type: "json" })));
  keys.forEach((k, i) => {
    const id = idFromKey(k);
    const rec = records[i] as RowRecord<T> | null;
    // A key listed but gone by the time it is read, or a cleared marker: the row has no value.
    if (!rec || typeof rec !== "object" || !("value" in rec)) delete out[id];
    else out[id] = rec.value;
  });
  return out;
}

// Set or clear one row, touching only that row's key. Never rewrites the legacy map.
export async function writeRowState<T>(store: BlobStore, id: string, value: T | null): Promise<void> {
  const rec: RowRecord<T> = value === null || value === undefined ? { cleared: true } : { value };
  await store.setJSON(rowKey(id), rec);
}

// ---------- vault writes with a retry on conflict ----------

export type FileIO = {
  read(path: string): Promise<{ content: string; sha: string } | null>;
  write(path: string, content: string, message: string, sha?: string): Promise<{ commit: string }>;
};

export type Apply = { ok: true; content: string } | { ok: false; status: number; error: string };
export type WriteResult = { ok: true; commit: string } | { ok: false; status: number; error: string };

export async function writeWithRetry(io: FileIO, path: string, apply: (text: string) => Apply, message: string, attempts = 3): Promise<WriteResult> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const f = await io.read(path);
    if (!f) return { ok: false, status: 404, error: `${path} not found` };
    const a = apply(f.content);
    if (a.ok === false) return a;
    try {
      const r = await io.write(path, a.content, message, f.sha);
      return { ok: true, commit: r.commit };
    } catch (e: any) {
      if (e && (e.status === 409 || e.status === 422)) continue;
      throw e;
    }
  }
  return { ok: false, status: 409, error: `${path.split("/").pop()} kept changing while saving. Try again.` };
}

// Set one table row's status (and, when asked, its decided stamp and a note cell), found by the
// id in its first cell. Returns the new text, or null when no row has that id.
export function applyRowStatus(content: string, id: string, status: string, opts: { stamp?: string; decidedCol?: number; noteCol?: { index: number; value: string } } = {}): string | null {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!/^\s*\|/.test(l)) continue;
    const cells = l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (cells[0] !== id) continue;
    cells[1] = status;
    if (opts.decidedCol !== undefined) cells[opts.decidedCol] = opts.stamp || "";
    if (opts.noteCol) cells[opts.noteCol.index] = opts.noteCol.value;
    lines[i] = `| ${cells.join(" | ")} |`;
    return lines.join("\n");
  }
  return null;
}

// ---------- the vault tree: reused only while the branch has not moved ----------
// Each function instance keeps its own tree cache, and a write clears it only in the instance
// that made it, so a time-based cache let another instance serve the old tree (and the old
// status) for up to 20 seconds. Now the branch ref is read on every call, one cheap GitHub call,
// and the cached tree is reused only when the ref still points at the same commit.
export async function treeFor<T extends { sha: string }>(cache: T | null, headSha: () => Promise<string>, build: (sha: string) => Promise<T>, force = false): Promise<T> {
  // A momentary GitHub error on the ref read: a warm instance keeps serving what it has, as it
  // did before the ref check; with nothing cached (or when forced) the error goes up.
  let sha: string;
  try { sha = await headSha(); } catch (e) { if (cache && !force) return cache; throw e; }
  if (!force && cache && cache.sha === sha) return cache;
  return build(sha);
}
