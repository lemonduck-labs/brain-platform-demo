// A local run of the whole platform with no Netlify CLI: plain node:http, no new dependencies.
// It bundles the vault first (scripts/bundle-vault.mjs), then serves public/ and hands every
// /api/* request to the function's default export, the same handler Netlify runs.
//
//   npm run demo                      demo mode on http://localhost:8660
//   PORT=9000 npm run demo            another port
//   VAULT_DIR=/path/to/vault npm run demo
//
// Runs with `node --experimental-strip-types` (Node 22), which is how package.json starts it.
// This server is for demo mode: it sets BRAIN_MODE=demo unless BRAIN_MODE is already set, since
// the live mode also needs Netlify Blobs, which only exist inside Netlify (use `netlify dev`).

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, normalize, extname, sep } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(root, "public");
const port = Number(process.env.PORT) || 8660;

if (!process.env.BRAIN_MODE) process.env.BRAIN_MODE = "demo";

// What the function expects from the Netlify runtime: Netlify.env.get, and CONTEXT for the
// live-only sign-in check ("dev" counts as live, see lib/auth.mts).
if (!process.env.CONTEXT) process.env.CONTEXT = "dev";
globalThis.Netlify = { env: { get: (k) => process.env[k], has: (k) => k in process.env }, context: null };

execFileSync(process.execPath, [join(root, "scripts", "vendor.mjs")], { stdio: "inherit", env: process.env });

if (process.env.SKIP_BUNDLE !== "1") {
  execFileSync(process.execPath, [join(root, "scripts", "bundle-vault.mjs")], { stdio: "inherit", env: process.env });
}

const { default: handler } = await import(pathToFileURL(join(root, "netlify", "functions", "api.mts")).href);

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
};
const SECURITY = { "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

async function api(req, res) {
  const url = `http://${req.headers.host || "localhost:" + port}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
  let response;
  try {
    response = await handler(new Request(url, { method: req.method, headers, body }));
  } catch (e) {
    response = new Response(JSON.stringify({ error: String(e && e.message || e) }), { status: 500, headers: { "content-type": "application/json" } });
  }
  const out = { ...SECURITY };
  response.headers.forEach((v, k) => { out[k] = v; });
  res.writeHead(response.status, out);
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function file(req, res) {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === "/" || path === "") path = "/index.html";
  const full = normalize(join(publicDir, path));
  if (!full.startsWith(publicDir + sep)) { res.writeHead(403); res.end("forbidden"); return; }
  try {
    const st = await stat(full);
    if (!st.isFile()) throw new Error("not a file");
    const data = await readFile(full);
    const type = TYPES[extname(full).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { ...SECURITY, "content-type": type, "cache-control": path === "/index.html" ? "no-cache" : "public, max-age=0" });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}

createServer((req, res) => {
  const p = (req.url || "/").split("?")[0];
  (p === "/api" || p.startsWith("/api/") ? api(req, res) : file(req, res)).catch((e) => {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(String(e && e.message || e));
  });
}).listen(port, () => {
  console.log(`dev-server: http://localhost:${port} (${process.env.BRAIN_MODE} mode). Ctrl+C stops it.`);
});
