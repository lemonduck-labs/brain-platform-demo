# The Brain platform

A web front end over an Obsidian vault that runs as an AI operating system. A static site
(`public/`) plus one Netlify function (`netlify/functions/api.mts`) that reads and writes the
vault. On a live site the vault is a private GitHub repo, read and written through the GitHub
API. In demo mode it is a bundled copy of a fictional vault, and every change a visitor makes
stays in memory for that visit only.

This repo runs in demo mode out of the box: no token, no passphrase, no Netlify account.

```bash
git clone https://github.com/lemonduck-labs/brain-vault-demo.git ../vault
npm install
npm run demo            # http://localhost:8660, the demo vault from ../vault
npm test
```

The vault is its own repository, `brain-vault-demo`. Cloned beside this one as `vault`, the demo
bundles it from there; `VAULT_REPO` or `VAULT_DIR` point it anywhere else (below).

## What is where

| Path | What it is |
|---|---|
| `public/index.html` | The shell: the gate, the sidebar and the areas (Brain, Tasks, Fernmoor, Approvals, Leads, Notes, Journal, Scout, Chat, Team, Runs) |
| `public/app.js` | The front end: one `/api/state` load, rendering, every action. Plain JavaScript, hash routes, no build step |
| `public/styles.css` | Design tokens at the top (colours, type), then components |
| `public/brain.js`, `veins.js`, `team.js` | The 3D brain on the home page, the background veins, the Team view's node drawing |
| `public/vendor/` | three.js 0.147's bloom and orbit extras (`three-extras.js`, committed); three.js 0.147 and marked 4.3 are pinned npm dependencies copied in at build time by `scripts/vendor.mjs` |
| `netlify/functions/api.mts` | The API: routing, the vault interface, markdown parsing, every write |
| `netlify/functions/lib/demo.mts` | Demo mode: the bundled vault, the per-visitor overlay, the in-memory stores, the pinned clock |
| `netlify/functions/lib/store.mts` | Key-value state (sign-in, snoozes, review state): Netlify Blobs live, memory in the demo |
| `netlify/functions/lib/auth.mts` | Sign-in: the passphrase, the guess limit, sessions, passkeys; and the demo's one-button entry |
| `netlify/functions/lib/leads.mts` | The Leads area: the pipeline table, row edits, the suppression list, the activity log, sequence and reports. Pure |
| `netlify/functions/lib/team.mts` | The Team area: the queue row parser, the lock ledger, run tags, blocks, estimates and every figure the command centre shows. Pure |
| `netlify/functions/lib/settle.mts` | Per-row snooze and review state, and the read, apply and write retry used by every table edit. Pure |
| `netlify/functions/lib/dismiss.mts` | Dismissing a task (`- [-]` with a dated note). Pure |
| `scripts/bundle-vault.mjs` | Bundles a vault into `netlify/functions/lib/vault-bundle.json` for demo mode |
| `scripts/dev-server.mjs` | A local run with no Netlify CLI: plain `node:http`, serves `public/` and hands `/api/*` to the function |
| `scripts/build.mjs` | The Netlify build: stamps the build id into the page and the function, copies the browser libraries, then bundles the vault |
| `scripts/vendor.mjs` | Copies marked and three from `node_modules` into `public/vendor/` |
| `tests/` | `npm test`: the pure modules, plus `demo.test.mjs`, which runs the whole function in demo mode against a small bundle |
| `netlify.toml` | Build command, publish folder, function settings, headers, and `VAULT_REPO` for the demo build |

## How demo mode works

Demo mode is on when `GITHUB_TOKEN` is unset, or when `BRAIN_MODE=demo`. `BRAIN_MODE=live`
forces the live mode.

| Part | Live | Demo |
|---|---|---|
| Vault reads | GitHub API: the branch ref, the tree, blobs by sha, the Contents API | `lib/vault-bundle.json`, with the visitor's overlay on top |
| Vault writes | GitHub Contents API, against the sha that was read | Memory, keyed by a hash of the visitor's session token. Same rules: a stale sha is a 409, writing over a file without its sha is a 422 |
| Limits | GitHub's | 200 writes and 3 MB per visit; a visit ends 2 hours after it began, or on sign-out |
| Sign-in | Passphrase, guess limit, optional passkey | One button, "Enter the demo". Passkeys are hidden and their routes closed |
| Snoozes, review state | Netlify Blobs | Memory, per visit |
| Sessions | Netlify Blobs, 60 days rolling | Memory, 2 hours, never extended |
| Today | London date and time | `DEMO_TODAY` (default `2026-10-22`) with the real London time; the page pins its own clock to the same day |
| The approvals watcher | Started through its routine trigger when configured | Off |

One visitor never sees another's edits, and nothing persists past the function instance. Every
page shows a slim banner: "Demo: a fictional vault. Your changes stay in this visit only." Every
successful write returns a `demo` field saying the same, `/api/state` carries `demo` with the
visit's write count, and `/api/health` answers `demo: true`.

All of this sits behind one small interface in `api.mts` (`getTree`, `blob`, `readFile`,
`writeFile`, `commitInfo`) with a GitHub implementation and a demo one, so nothing above it
knows which it has.

## Running it locally

Node 22.6 or later (the TypeScript files run with `--experimental-strip-types`).

| Command | What it does |
|---|---|
| `npm install` | The runtime dependencies: `@netlify/blobs`, `@simplewebauthn/server`, and the two browser libraries, `marked` and `three` |
| `npm run demo` | Copies the browser libraries into `public/vendor/`, bundles the vault, then serves the platform on port 8660 (`PORT` to change it) |
| `npm run bundle` | Bundles the vault only |
| `npm test` | Every test, no network |
| `npm run dev` | `netlify dev`, for the live mode with Netlify Blobs (needs the Netlify CLI) |

The bundler reads, first match wins:

| Variable | What |
|---|---|
| `VAULT_REPO` | A public git URL, shallow cloned into a temp folder. If the clone does not work, it falls back to `VAULT_DIR` and says so |
| `VAULT_DIR` | A vault folder on disk. Default `../vault`, beside this folder |

It takes every `.md` file with its path, content, a sha1 in git's blob form and its size, and
skips `.obsidian`, `.git`, `.claude`, `_review` and `node_modules`, and the vault repository's own `README.md`, `NOTICE.md` and `PUBLIC.md`.

A quick check from the shell:

```bash
curl -s localhost:8660/api/health
KEY=$(curl -s -X POST localhost:8660/api/auth/demo | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s localhost:8660/api/state -H "x-brain-key: $KEY" | head -c 400
```

## Deploying the demo

A Netlify site with no `GITHUB_TOKEN` runs in demo mode. The build (`node scripts/build.mjs`)
bundles the vault from `VAULT_REPO` in `netlify.toml`, which must be a public repo before the
build can clone it; until then it falls back to `VAULT_DIR`, and stops with an error if neither
gives a vault. The bundle is written at build time and is not committed (see `.gitignore`).

## Pointing it at a real vault

| Variable (Netlify site settings, never in code) | Required | What |
|---|---|---|
| `GITHUB_TOKEN` | yes | A fine-grained token for the one vault repo, Contents: read and write. Its presence switches the site to the live mode |
| `BRAIN_PASSPHRASE` | yes | The passphrase the gate asks for |
| `GITHUB_REPO` | yes | `owner/name` of the vault repo. The default, `owner/brain-vault`, is a placeholder |
| `GITHUB_BRANCH` | no | Default `main` |
| `WATCHER_FIRE_URL`, `WATCHER_FIRE_TOKEN` | no | A Claude Code routine's trigger URL (or `trig_` id) and its token. With both, approving a row or sending a request starts the routine at once |
| `BRAIN_PASSKEY_RESET` | no | Recovery only: while set, the passphrase alone signs in again so a fresh passkey can be registered |
| `BRAIN_MODE` | no | `demo` or `live`, to force a mode |
| `DEMO_TODAY` | no | The demo's pinned date, `YYYY-MM-DD` |

To try a real vault locally without a token, bundle it and run the demo server against it:
`VAULT_DIR=/path/to/vault npm run demo`. Changes still stay in memory.

Commits from the live site are attributed by GitHub to the token's own account; the function
names no committer.

## Sign-in on a live site

| Step | How |
|---|---|
| Passphrase | The browser sends the SHA-256 of the passphrase to `POST /api/auth/passphrase`, compared timing-safe against the hash of `BRAIN_PASSPHRASE` |
| Guess limit | 5 wrong guesses lock sign-in for 15 minutes, counted in Netlify Blobs so it holds across function instances |
| Passkey | Once one is registered, the passphrase alone is not enough: a WebAuthn challenge follows, checked by `@simplewebauthn/server`. Each passkey is tied to the address it was registered on |
| Session | An opaque token, stored only as its hash, extended on use at most once an hour, signed out after 60 days unused or by the lock button |
| Previews | Every `auth/*` route refuses to run on a deploy preview or branch deploy, so a passkey is only ever registered for the live address |

## What the platform reads in the vault

| Note | Used for |
|---|---|
| `Now.md` | This week, the ranked project table, "Waiting on the operator", "Waiting on other people"; new tasks from the platform go here |
| Any note | Open checkboxes tagged `#next`, `#blocked` or `#decision` are tasks, with their indented notes |
| `Journal/Daily/<date>.md`, `Journal/Weekly/<year>-W<week>.md` | Today's plan, log and review; today's and this week's priorities and the brain's suggestions |
| `System/Approvals.md` | The queue (`requested`, `pending`, `approved`, `in progress`, `done`, `declined`) and notes left on tasks |
| `System/Needs from the operator.md` | What Claude needs from the operator, shown at the top of Tasks |
| `System/Run log.md`, `System/Archive/` | Runs, and the Team area's history |
| `System/Scout.md` | Findings to keep or dismiss. The url cell may be a web address or a `[[wikilink]]` to a note |
| `System/Chat.md` | The chat thread: blocks headed `## YYYY-MM-DD HH:MM · Operator` or `· Brain` |
| `System/Agents/*.md`, `System/Departments.md`, `System/Tools.md`, `System/Setup/Watcher lock.md` | The Team area |
| `Wiki/Fernmoor/` | The Fernmoor area: tasks by brand (Fernmoor Heating, Ridgeby Roofing, Warmstead, Group); new ones go in `Wiki/Fernmoor/Fernmoor tasks.md` |
| `Wiki/Ventures/Owlbridge/Owlbridge growth/` | The Leads area: `Owlbridge pipeline.md`, `Owlbridge lead gen station.md`, `Owlbridge activity log.md`, `Owlbridge outreach drafts.md` and `Owlbridge lead list` notes |
| `Growth.md`, `Templates/` | Suggested growth threads; the daily and weekly templates for notes the platform creates |

The vault's own rules hold at the edge: `.md` paths only, no path tricks, no em dashes.
Every write goes against the sha that was read, so a note changed by a job or by Obsidian in
between is refused, or re-read and reapplied for table rows, never overwritten.
