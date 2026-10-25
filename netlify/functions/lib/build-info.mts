// The running deploy's commit reference, baked in at build time.
//
// Netlify.env.get("COMMIT_REF") is a build-time variable, not a runtime one: a running
// function cannot see it, only the build step can. This file exists so the function has
// something it CAN see. scripts/build.mjs writes the real value here (in place, the same way
// it stamps public/index.html), and Netlify bundles this function with esbuild only after the
// build command has finished, so the value shipped is always the one for this exact deploy.
// See netlify/functions/api.mts (BUILD_REF) for where it is read, and app.js's checkBuild for
// what it drives: a quiet, one-time reload of any open tab once a newer build has landed.
//
// "dev" is the default checked into git. It is what a local run keeps (`netlify dev`, or this
// file opened without ever running scripts/build.mjs), and it can never collide with a real
// deploy's id, so it can never cause a reload on its own.
export const BUILD_REF = "dev";
