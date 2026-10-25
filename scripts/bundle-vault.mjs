// Bundles a vault into netlify/functions/lib/vault-bundle.json, the file demo mode reads
// (see netlify/functions/lib/demo.mts). Every .md file goes in with its path, content, a sha1
// of the content in git's blob form (so it is stable and matches what git would call it) and
// its size. Skipped: .obsidian, .git, .claude, _review and node_modules, and the repo's own
// README.md, NOTICE.md and PUBLIC.md at the vault root.
//
// Where the vault comes from, first match wins:
//   VAULT_REPO  a public git URL, shallow cloned into a temp folder (needs git on the path)
//   VAULT_DIR   a folder on disk; default ../vault beside this platform folder
// If VAULT_REPO is set but the clone does not work (for example the repo is still private),
// it falls back to VAULT_DIR, and says so. With neither, it stops with an error.
//
// Usage: node scripts/bundle-vault.mjs            (npm run bundle)

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "netlify", "functions", "lib", "vault-bundle.json");
const SKIP = new Set([".obsidian", ".git", ".claude", "_review", "node_modules", ".trash"]);
// The repository's own files at the vault root describe the repo, not the vault: not notes.
const ROOT_SKIP = new Set(["README.md", "NOTICE.md", "PUBLIC.md"]);

function walk(dir, base, files) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, base, files);
    else if (st.isFile() && name.endsWith(".md") && !(dir === base && ROOT_SKIP.has(name))) files.push(relative(base, full).split(sep).join("/"));
  }
  return files;
}

function cloneRepo(url) {
  const dir = mkdtempSync(join(tmpdir(), "brain-vault-"));
  try {
    execFileSync("git", ["clone", "--depth", "1", "--quiet", url, dir], { stdio: ["ignore", "ignore", "pipe"], timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return dir;
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    console.warn(`bundle-vault: could not clone ${url} (${String(e.stderr || e.message).trim().split("\n")[0]}); falling back to VAULT_DIR`);
    return null;
  }
}

let source = "";
let vaultDir = "";
let cleanup = null;
if (process.env.VAULT_REPO) {
  const cloned = cloneRepo(process.env.VAULT_REPO);
  if (cloned) { vaultDir = cloned; source = process.env.VAULT_REPO; cleanup = cloned; }
}
if (!vaultDir) {
  vaultDir = resolve(root, process.env.VAULT_DIR || "../vault");
  source = `folder ${basename(vaultDir)}`;
  if (!existsSync(vaultDir)) {
    console.error(`bundle-vault: no vault at ${vaultDir}. Set VAULT_DIR to a vault folder, or VAULT_REPO to a public git URL.`);
    process.exit(1);
  }
}

const paths = walk(vaultDir, vaultDir, []).sort();
const files = paths.map((path) => {
  const buf = readFileSync(join(vaultDir, path));
  const content = buf.toString("utf8");
  const sha = createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
  return { path, content, sha, size: buf.length };
});
const commit = createHash("sha1").update(files.map((f) => `${f.path}:${f.sha}`).join("\n")).digest("hex");
// The bundle's date is the demo's pinned day, so "last vault change" reads as that day.
const today = /^\d{4}-\d{2}-\d{2}$/.test(process.env.DEMO_TODAY || "") ? process.env.DEMO_TODAY : "2026-10-22";
const generatedAt = `${today}T17:00:00.000Z`;

writeFileSync(out, JSON.stringify({ generatedAt, source, commit, files }));
if (cleanup) rmSync(cleanup, { recursive: true, force: true });

const kb = Math.round(files.reduce((n, f) => n + f.size, 0) / 1024);
console.log(`bundle-vault: ${files.length} notes (${kb} KB) from ${source} into ${relative(root, out)}`);
