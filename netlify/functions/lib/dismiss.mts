// Dismiss a task: for one that is no longer needed, as opposed to one that is done.
//
// The line is kept and marked "- [-]", Obsidian's own cancelled status, with a dated note
// under it. Every reader of open tasks (this platform's scanTasks, the brain's jobs, a grep for
// "- [ ]") matches only a space or an x in the box, so a dismissed task drops out of every list
// and count while the note keeps the record. Undo is editing "[-]" back to "[ ]" in Obsidian.

export type DismissResult =
  | { ok: true; lines: string[] }
  | { ok: false; reason: "changed" | "not-open" };

const OPEN_RE = /^(\s*)- \[ \] /;

export function dismissLines(lines: string[], line: number, raw: string, stamp: string): DismissResult {
  const current = lines[line];
  if (current === undefined || !current.includes(raw)) return { ok: false, reason: "changed" };
  const m = current.match(OPEN_RE);
  if (!m) return { ok: false, reason: "not-open" };
  const indent = m[1].replace(/\t/g, "    ");
  const out = lines.slice();
  out[line] = current.replace("- [ ] ", "- [-] ");
  out.splice(line + 1, 0, `${indent}    - Dismissed on the platform, ${stamp}`);
  return { ok: true, lines: out };
}
