// Copies the two third-party browser libraries the page loads from their pinned npm packages
// into public/vendor/: marked 4.3.0 (markdown) and three 0.147.0 (the 3D brain). They are
// byte-identical to the files the private repository commits, but here they come from
// node_modules at build time and are gitignored, so the published repository holds only code
// written for it. three-extras.js (the bloom and orbit extras, bundled by hand) stays committed.
// Run by scripts/build.mjs and scripts/dev-server.mjs; needs `npm install` first.

import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "vendor");
const files = [
  ["node_modules/marked/marked.min.js", "marked.min.js"],
  ["node_modules/three/build/three.min.js", "three.min.js"],
];

mkdirSync(out, { recursive: true });
for (const [from, to] of files) {
  const src = join(root, from);
  if (!existsSync(src)) {
    console.error(`vendor.mjs: ${from} is missing; run npm install first`);
    process.exit(1);
  }
  copyFileSync(src, join(out, to));
}
console.log("vendor.mjs: copied marked 4.3.0 and three 0.147.0 into public/vendor/");
