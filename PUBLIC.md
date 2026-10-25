# This public copy

The working repository is private. This copy holds the platform's code, its tests and a demo mode that
runs it on a bundled fictional vault (`brain-vault-demo`) with no GitHub token, no passphrase and
nothing saved. It leaves out, on purpose:

- **The private repository's history.** This copy is one commit.
- **The owner's names, brands and sites.** The areas that were built for a real employer and a real
  consultancy are renamed for the demo vault's fictional business (the Fernmoor area, the Owlbridge
  leads area), and the default repository is a placeholder. The behaviour is unchanged.
- **The two third-party browser libraries.** marked 4.3.0 and three 0.147.0 are pinned npm
  dependencies, copied into `public/vendor/` at build time (`scripts/vendor.mjs`) rather than committed.

Demo mode is the one addition: `netlify/functions/lib/demo.mts`, `lib/store.mts`,
`scripts/bundle-vault.mjs` and `scripts/dev-server.mjs`. With a `GITHUB_TOKEN` set, the platform reads
and writes a real vault repository exactly as before.

## How this copy was checked

- A scan of every file and the commit for anything that identifies the publisher: names, initials,
  employers, brands, sites, repositories and account names from the private repository and vault.
- fd-core's guardrails screen over every tracked file and the commit message, with the private deny
  list of the people, firms and places named in the private vault (the list itself is never
  published): no findings, with no check switched off for any path.
- `npm test`: every test passes, including the demo mode's own.
- The demo run locally against `brain-vault-demo` and every area checked in a browser.
