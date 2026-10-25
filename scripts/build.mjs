// The only build step this static site has: stamp the deploy's commit reference onto the
// versioned static assets (app.js, styles.css, brain.js, veins.js) as a ?v= query param, and
// into a meta tag the page reads at runtime, so a merge reaches every open browser without
// anyone needing a hard refresh (see the sidebar's build check in app.js, checkBuild).
//
// The same value is also written into netlify/functions/lib/build-info.mts, which
// netlify/functions/api.mts imports and returns as /api/state's "build" field. That second
// write matters: Netlify.env.get("COMMIT_REF") is a build-time variable, not a runtime one, so
// a running function cannot read it back, only this build step can. Netlify bundles the
// function with esbuild after this command finishes, so the id baked in here is the one that
// ships with it. Without this, /api/state always answered "dev" and every page load looked
// like a stale build to the client, which is what sent the site into a reload loop on 23 Sep.
//
// There is no bundler here and this does not try to become one: it edits public/index.html
// and netlify/functions/lib/build-info.mts in place, once each, using Netlify's own COMMIT_REF
// build variable. It runs only inside Netlify's build (see netlify.toml, [build] command);
// nothing it does touches the repository, since it runs against Netlify's own checkout for
// that deploy and writes only into the build output.
//
// Locally (no COMMIT_REF, e.g. a plain file open or `netlify dev` without a deploy context)
// it falls back to "dev", which never matches a real deploy's build field, so the client's
// build check never fires a spurious reload.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = join(root, "public", "index.html");
const buildInfoPath = join(root, "netlify", "functions", "lib", "build-info.mts");

const ref = process.env.COMMIT_REF || "";
const version = ref ? ref.slice(0, 8) : "dev";

let html = readFileSync(indexPath, "utf8");

// The meta tag: always exactly one, whatever the previous content said.
html = html.replace(
  /<meta name="brain-build" content="[^"]*">/,
  `<meta name="brain-build" content="${version}">`
);

// The four versioned assets. Matches the exact attribute values used in index.html; any
// existing ?v= (from running this script twice against the same checkout) is replaced, not
// stacked, so it stays idempotent.
const assets = ["styles.css", "app.js", "brain.js", "veins.js", "team.js"];
for (const name of assets) {
  const re = new RegExp(`((?:href|src)=")${name}(?:\\?v=[^"]*)?(")`, "g");
  html = html.replace(re, `$1${name}?v=${version}$2`);
}

writeFileSync(indexPath, html);

// The function's own copy of the build id (see the comment at the top of this file, and
// build-info.mts itself). Replaced in place, not appended, so running this twice against the
// same checkout stays idempotent.
let buildInfo = readFileSync(buildInfoPath, "utf8");
buildInfo = buildInfo.replace(
  /export const BUILD_REF = "[^"]*";/,
  `export const BUILD_REF = "${version}";`
);
writeFileSync(buildInfoPath, buildInfo);

console.log(`build.mjs: stamped index.html and build-info.mts with build ${version}`);

// The two vendored libraries come from their pinned npm packages (scripts/vendor.mjs).
execFileSync(process.execPath, [join(root, "scripts", "vendor.mjs")], { stdio: "inherit", env: process.env });

// Demo mode reads the vault from netlify/functions/lib/vault-bundle.json, so every build makes
// it fresh (scripts/bundle-vault.mjs: VAULT_REPO if set and cloneable, else VAULT_DIR). A site
// with a GITHUB_TOKEN reads the repo live and has no use for it, so there it is skipped.
if (process.env.GITHUB_TOKEN && process.env.BRAIN_MODE !== "demo") {
  console.log("build.mjs: GITHUB_TOKEN is set, so no vault bundle is made");
} else {
  execFileSync(process.execPath, [join(root, "scripts", "bundle-vault.mjs")], { stdio: "inherit", env: process.env });
}
