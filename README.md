# DSH-unbound

Type-safe DeepSeek Harness host patching engine, plus the TypeScript rewrite of
[`dsh-qilin`](https://github.com/YuJunZhiXue/dsh-qilin)'s plugin, platform, and
red-team layers.

**Version 0.1.0** (`package.json`) — a near-complete rewrite of `dsh-qilin`:
**49,786 lines across 115 source files, 4,007 tests green**. The host now loads
both halves: the patch engine + plugin shell (Cordis half) **and** the red-team
console (browser half via `dsh.client`, server half via `./service`). See
[scope](#scope-what-this-is-and-is-not) before installing.

---

## Why this exists

`dsh-qilin` works, but it carries structural debt that made every upstream
release painful:

| Problem in the original | Consequence |
|---|---|
| 85 patches as hand-written JS object literals, 5,608 of `lib/core.js`'s 8,533 lines | Editing a patch means editing code; a typo silently no-ops |
| `file:` sometimes `string`, sometimes `string[]` | Every consumer re-implements `Array.isArray` |
| Two patch schemas (`replacements[]` and `patterns[]+replace`) | Engine has to fold them at runtime |
| Zero tests, zero type checking | `node --check` catches syntax, nothing else |
| No drift detection | Upstream renames a string → patch silently stops working; users believe they are patched |
| `catch {}` × 302 | Undefined identifiers swallowed silently |

This rewrite keeps the *behavior* byte-identical (proven by test) and fixes the
structure.

---

## Scope: what this is (and is not)

Two things used to be worth separating here — **what source exists** and **what
the host loads** — because they disagreed. As of 0.1.0 they agree: the plugin
manifest, the Cordis bundle patch, the service module, and the browser bundle
are all wired.

### Rewritten and tested — 49,786 lines across 115 source files

| Layer | Source | Files | Lines | Test files | Tests |
|---|---|---:|---:|---:|---:|
| Patch engine + host + fs | `src/patches`, `src/engine`, `src/fs`, `src/host` | 10 | 2,036 | 7 | 135 |
| CLI | `src/cli` | 1 | 456 | — | — |
| Plugin shell (Cordis half) | `src/plugin` | 9 | 4,720 | 7 | 480 |
| Platform | `src/platform` | 11 | 3,564 | 10 | 477 |
| Features (pure decisions) | `src/features` | 3 | 767 | 3 | 100 |
| Red-team store (SQLite fact DB) | `src/redteam/store` | 15 | 10,636 | 4 | 131 |
| Red-team tools (56 host tools) | `src/redteam/tools` | 11 | 4,238 | 9 | 286 |
| Red-team client (browser renderer) | `src/redteam/client` | 36 | 16,213 | 34 | 2,228 |
| Red-team ui (bridge/gateway/tabs/console) | `src/redteam/ui` | 14 | 5,450 | — | — |
| Red-team service (server half) | `src/redteam/service.ts` | 1 | 1,307 | 1 | 56 |
| Package index | `src/index.ts` | 1 | 105 | — | — |
| Contract types (no logic) | `src/host-api`, `src/shared` | 3 | 294 | — | — |
| — end-to-end (no new src) | `test/integration` | — | — | 7 | 114 |
| **Total** | `src/` | **115** | **49,786** | **82** | **4,007** |

The 135 "patch engine" tests are the seven top-level files (`test/*.test.ts`).
`test/ui` (34 files, 2,228 cases) covers both the browser renderer and the HTTP
bridge layer, so it is counted on the client row; `test/redteam` (1 file, 56
cases) covers the service module.

```text
135 + 480 + 477 + 100 + 131 + 286 + 56 + 2,228 + 114 = 4,007
```

Totals: **4,007 tests / 681 suites / 0 failures / 0 skipped**, measured on
Node 22.22.1, cross-checked by `npm run verify:tests`.

### What the host actually loads

Two manifest fields decide whether this package is a DSH plugin at all —
**miss either and the console never appears**, no matter how correct the code is:

| Field | Points at | Loads |
|---|---|---|
| `dsh.bundle.patch` | `./cordis.patch.yml` | the Cordis plugin tree: `dsh-unbound` (host half) + `dsh-unbound-service` (server half) |
| `dsh.client` | `./client.js`, via `exports["./client"]` | the browser half — the red-team console |

**Mounted now, three halves:**

- **Cordis half** (`dist/index.js` → `src/plugin/index.ts`): `apply()` calls
  `installIdentityOverride` / `registerPromptSections` / `registerTools` /
  `registerCommands`, then a settle timer. Gives 3 `qilin_*` tools, the
  `/qilin` `/rules` `/skills` commands, prompt sections, drift settle.
- **Server half** (`./service` → `src/redteam/service.ts`): constructs
  `RedteamStore`, publishes `provide("redteam", store)`, registers
  `POST /redteam/api`, and disposes both on unload.
- **Browser half** (`./client` → `client.js`): the dock, mounted to the
  `shell.overlay` slot at `order: 50`.

Note `src/plugin/**` still does not import `src/redteam/**` — that is by
design. The Cordis half and the server half are two separate entries in
`cordis.patch.yml`, so the headless half never pulls in `node:sqlite` at load.

### Is not present at all

- **Desktop asar unpacking.** `src/platform/desktop-paths.ts` *detects* asar
  paths (194 lines, tested), and `src/plugin/settle-policy.ts` refuses to patch
  a sealed asar in place — but there is no extract/repack code. `grep -rn
  'extractAsar' src/` returns nothing.
- **Update channel apply.** The `updateCheck` / `updateApply` ops are
  implemented behind `GatewayPorts` (9 gateway ops, tested), but the actual
  downloader / swapper / restart is not in this repo.
- **Skill catalog vendoring.** `src/platform/skill-availability.ts` looks for
  bundled skills at `<pkg>/skills/redteam`, but no `skills/` directory exists in
  this repo and `package.json` `files` lists only
  `["dist", "patches", "client.js", "cordis.patch.yml", "README.md", "LICENSE"]`.

---

## Install

```bash
npm install          # also runs `prepare` -> `npm run build`
npm run build        # -> dist/ (tsc only, no bundler)
npm test             # 4,007 tests
```

Requires **Node ≥ 22.15.0** (`package.json` `engines`). This floor is not
cosmetic: `src/redteam/store/schema.ts` and `src/redteam/store/sqlite.ts`
import `DatabaseSync` from `node:sqlite`, which does not exist before Node
22.15 (`22.5` / `22.9` / `22.12` all throw `ERR_UNKNOWN_BUILTIN_MODULE`).
FTS5 inside `node:sqlite` is *also* build-dependent — Node 22.15 has SQLite
without FTS5, 22.18+ has both — so `src/redteam/store/schema.ts` probes for it
at load time and falls back to `LIKE` search (`REDTEAM_NO_FTS5=1` forces the
fallback). CI runs a dedicated job on exactly `22.15` to keep that honest.

> If you only use the CLI (`dist/cli/index.js`) you never touch
> `node:sqlite` — that entry point imports nothing but `node:process`. The
> floor still applies package-wide because `node:sqlite` is in the same build
> graph once you import `dsh-unbound`'s index.

### Build order

`npm run build` is a single `tsc -p tsconfig.build.json` + `chmod +x` on the
CLI. There is **no bundler** — `devDependencies` is just `@types/node` and
`typescript`. What you get after a build:

```
dist/                  compiled JS + .d.ts + .d.ts.map + .js.map
  cli/
  engine/  patches/  host/  host-api/  fs/  shared/
  plugin/  platform/  features/  redteam/{store,tools,ui,client}/
```

That is everything `dist/` needs to *be importable*. Being *loadable by the
host* is a separate question: `package.json` `exports` declares `.`, `./client`,
`./engine`, `./patches`, `./package.json`. The console bundle is therefore
addressable by package specifier, but `./plugin` is not — it throws
`ERR_PACKAGE_PATH_NOT_EXPORTED`. Mounting the plugin today requires either
adding an `exports` entry or having the host load `dist/plugin/index.js` by
absolute path. Both are wiring decisions, not build steps.

---

## CLI

```bash
# discover hosts
dsh-unbound hosts

# read-only: what still matches upstream?
dsh-unbound drift --verbose

# what would apply do?
dsh-unbound apply --dry-run --verbose

# apply (backs up first)
dsh-unbound apply

# restore from backup
dsh-unbound revert
```

Exit codes: `0` success / no drift · `1` drift or failure needing attention · `2` usage error.

### `drift` is the headline feature

It answers a question the original could not: *which of the 86 patches still
match the installed host?*

```text
aiBase: /Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai
patches 86 | healthy 0 | applied 73 | partial 0 | dead 0 | absent 12 | reverted 0 | pending-upgrade 1
broken: 0  ✓
```

That block is one host's state right after a clean apply. It is **not** a
constant — the same command on the same machine later reports
`applied 31 | dead 39` if the host's source files have since been replaced or
reverted. `drift` describes what the host looks like *now*; only
`broken: 0` is the healthy signal, and the per-state counts move with the host.

Seven states, each meaning something different:

| State | Meaning | Wants attention? |
|---|---|---|
| `healthy` | every pattern still matches; patch would apply | no |
| `applied` | host already carries the applied marker | no |
| `partial` | **some** patterns match, some are gone | **yes** — looks like it works |
| `dead` | zero patterns match; upstream rewrote the target | **yes** |
| `absent` | target file not on this host (e.g. desktop-only patch on web) | no |
| `reverted` | carries a `forbid` marker; was applied then rolled back | no |
| `pending-upgrade` | upgrade-chain patch whose pattern matches *its own earlier output* | no |

That last one matters: patch `#21` only matches
`timeoutMs: 600000 # [dsh-qilin] bash timeout raised` — text that exists **only
after** a previous apply. On a clean host it can never match. Classifying it as
`dead` would make `drift` exit `1` forever on healthy hosts, which would train
everyone to ignore the signal.

---

## API

```ts
import { loadBundledPatches, applyPatches, diagnoseAll, discoverHosts } from "dsh-unbound";

const patches = loadBundledPatches();          // validated, normalized, frozen
const [host] = discoverHosts();

const report = applyPatches(patches, host.aiBase, { dryRun: true });
console.log(report.summary.filesChanged);      // 0 in dry-run

const drift = diagnoseAll(patches, host.aiBase);
if (drift.summary.broken > 0) { /* upstream moved */ }
```

Patch definitions are a **closed, validated** type:

```ts
type PatchPattern =
  | { kind: "literal"; text: string }
  | { kind: "regex";   source: string; flags: string };
```

The original used `instanceof RegExp` at runtime with `string | RegExp` in one
field; here the compiler forces every consumer to handle both cases.

---

## Behavior preserved (on purpose)

These are non-obvious semantics that were reverse-engineered from the original
and locked down by tests. Changing any of them changes what gets written to
users' hosts.

1. **CRLF round-trip** — normalize to LF, patch, convert back. Without this, `\n`
   patterns never match CRLF files and the patch silently no-ops.
2. **`$1` expansion in regex replacements** — must use `String.replace(re, str)`,
   *not* a callback; a callback writes a literal `$1` into the host file.
3. **`lastIndex` isolation** — `/g` regexes are cloned per use. A shared regex
   keeps `lastIndex` and starts matching mid-string on the second call.
4. **Forced global** — replacement is "change every occurrence", even if the
   pattern was declared without `g`.
5. **YAML comment rewriting** — `//` → `#` on line ends when writing `.yml`, but
   not inside quotes, not after `#`, and never on `!!js` lines.
6. **Bare identity needles skipped in YAML** — an unindented statement written
   into a block scalar corrupts indentation, so it is skipped there.
7. **`skipIfMarked`** — insert-style patches must not run twice. The original
   measured +841 chars per repeated apply; unbounded growth.

Test file `test/equivalence.test.ts` re-proves (1)–(7) by running the **original
engine** and this engine over the same real host sources and asserting
byte-identical output. It currently compares 100 (patch, file) pairs: 100
identical, 0 differing.

---

## Structure

```
src/
  patches/       typed model, validation, loader (folds both legacy schemas)
  engine/        text transforms, apply/revert, drift detection
  host/          host discovery, target path resolution
  fs/            atomic writes, backups
  cli/           command line
  plugin/        Cordis entry: prompt sections, 3 tools, 3 commands, settle
  platform/      host-specific paths, net scope, config, skill availability
  features/      pure decision modules (continue-retry, rewind, uninstall)
  redteam/
    store/       SQLite fact DB — 23 tables, 80 ops, FTS5-optional
    tools/       56 host tools (asset/finding/tunnel/score/session/knowledge)
    ui/          HTTP bridge, 80-op table, gateway ports, tabs-a/b, console
    service.ts   Cordis server half: store + provide('redteam') + /redteam/api
    client/      browser-side renderer — 10-tab dock, 12 tab renderers
patches/
  patches.json    86 patches, extracted programmatically from dsh-qilin
  targets.json    65 target keys resolved on a real 0.2.1-rc.2 host
cordis.patch.yml the Cordis plugin tree: 2 rows (host half + server half)
client.js        generated browser bundle (732,637 bytes) — do not edit
test/             82 .test.ts files, 4,007 tests
```

Note `src/redteam/client` has **12 tab renderers** but the tab bar shows
**10**: `testing` and `attackfiles` are legacy route aliases kept for
persisted state and deep links, and `prompts` is addressable but not in
`TABS`. `ConsoleTabId` is the 13-value union; `TABS` in
`src/redteam/client/state.ts` is the 10-entry bar.

### Red-team console: the plugin manifest

This is the trap most worth knowing about. The console needs **three** things
declared, and each one is silent when missing:

```jsonc
// package.json
"exports": { "./client": "./client.js", "./service": "./dist/redteam/service.js" },
"files":   ["dist", "patches", "client.js", "cordis.patch.yml", ...],
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },   // → Cordis half + server half
  "client": {                                     // → browser half
    "platform": "web",
    "inject": [
      "@deepseek-ai/dsh-client-connection",
      "@deepseek-ai/dsh-client-runtime",
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-slots"
    ]
  }
}
```

The host validates `dsh.client` with a dedicated parser (`parseDshClient()` in
`dsh-client-modules`): `platform` must be a string, `inject` / `external` must
be string arrays. **With no `dsh` field at all, the host does not consider this
a DSH plugin** — `client.js` is never loaded, and the console never appears,
however correct `console.ts` is.

Two deliberate divergences from `dsh-qilin`, so you don't read them as
omissions:

1. **`dsh.client.inject` has 4 entries, upstream has 5** — `dsh-client-ui-settings`
   is omitted because this plugin registers no settings page. Injecting it would
   mean waiting on a service we never use.
2. **`cordis.patch.yml` `insert` has 2 rows, upstream has 4** — this repo
   merges store + ui into one service module (`src/redteam/service.ts`) because
   they are libraries in one process here, not separate Cordis plugins.
   Upstream splits them because its `lib/redteam/*` are real `{name, inject,
   apply}` modules.

One more non-obvious constraint: **`service.ts` declares `inject: []` on
purpose.** This package also installs into headless surfaces where `webServer`
does not exist; putting `webServer` in `inject` would make Cordis wait forever,
timing out host startup (exit code 1). Instead it lazily waits via
`ctx.inject(["webServer"], cb)`.

#### When the console does not appear

Check in this order — each step is silent when it fails:

1. **Host log** for one of `console.ts`'s four early-exit warnings:
   `[dsh-unbound] 控制台未挂载：` + no `window` / no `fetch` / no `ctx.slots` /
   `require('react')` failed.
2. **Browser devtools** — is `POST /redteam/api` returning non-200? A 404 here
   means the server half never registered (see below).
3. **`npm run check:client`** — is `client.js` stale relative to
   `src/redteam/**`? A stale bundle silently serves old tab code.

#### The "console appears but every tab is empty" trap

`src/redteam/client/api.ts` deliberately **never rejects** — every failure
becomes `{ ok: false, code }`. That is good for UI state and *bad* for
diagnosis: a 404 on `/redteam/api` makes every tab quietly render its empty
state ("还没有资产数据（先跑信息收集）") rather than showing an error.

The panel showing up is therefore **not** evidence that the backend is wired.
This trap cost real time here: `src/redteam/ui/server.ts:39` carries a comment
"this is the `webServer.register({ path: '/redteam/api', handler })` handler
body" — the handler existed for a long while with **no caller anywhere**. A
comment describing an integration is not the integration.

### Kept in sync with `dsh-qilin`

The patch table here is not a fork — it is a copy of `dsh-qilin`'s table,
checked mechanically:

```bash
npm run verify:sync    # compares local table against dsh-qilin's export
npm run sync:patches   # pulls the latest and rewrites patches/patches.json
```

`dsh-qilin` exposes `scripts/export-patches.mjs` as its stable data contract,
so this repo never has to import its internals. The verifier fails with exit 1
on any divergence, naming the offending patch.

That contract also made a 3,564-line refactor on the `dsh-qilin` side safe:
its `lib/core.js` went from 8,599 to 4,916 lines (patch data moved to
`lib/patches-data.js`), with all 86 patches verified byte-identical before and
after, and real-host `patchStatus` matching exactly (applied 69 / na 17).

### Patch data is extracted, not retyped

`patches/patches.json` is produced by `scripts/extract-patches.mjs`, which
imports the original `ALL_PATCHES` and serializes it. Patterns contain tabs,
newlines and CRLF; hand-transcribing them would guarantee drift. `RegExp`
values are encoded as `{"$regex": ..., "flags": ...}` rather than silently
becoming `{}`.

### Target resolution is data, not 238 lines of branching

The original resolved 65 target keys with hand-written `firstExisting([...])`
chains. That is untestable and needs a code edit whenever upstream moves a
file. Here each key is a declarative template, plus `targets.json` (the actual
resolution captured on a real host) as the highest-priority hint.

It also closed a real gap: `pi-ai` lives under **`@earendil-works`**, not
`@deepseek-ai`. The original never looked there, so patches `#47`, `#49`, `#57`,
`#90`, `#91` could never apply. This resolver checks sibling npm scopes.

---

## Bugs found in the original (fixed here)

Found by running `tsc --checkJs` over the original: 117 errors, of which 3 were
live defects.

### 1. `lib/skills.js` never imported `fs` — symlink guard silently dead

```js
import { promises as fsp } from "node:fs";   // no `fs`
// ...
try { return fs.realpathSync.native ? fs.realpathSync.native(abs) : fs.realpathSync(abs); }
catch { return abs; }                        // swallows the ReferenceError
```

`fs` is undefined → `ReferenceError` → caught → falls back to `path.resolve` →
**symlinks are never resolved**. The `#54` guard ("importing from inside
`$DSH_HOME/skills` would delete skills through a symlink") was doing nothing.

Verified with a real ES module (not `node -e`, which injects a global `fs`):

```text
$ node prove.mjs
realpath resolved? => /tmp/symtest/real/skills/link    # not resolved
```

`lib/uninstall.js` and `lib/update.js` import `fs` correctly — this was an
isolated regression.

### 2. `lib/redteam/schema.js` references two undefined identifiers

`LEGACY_STAGE_MAP` and `SCOPE_SQL` are used in `migrate()` but never defined or
imported. Both call sites sit inside `try/catch`:

```js
try { for (const [legacy, code] of Object.entries(LEGACY_STAGE_MAP)) stmt.run(code, legacy) } catch {}
try { db.exec(`UPDATE asset SET scope = (${SCOPE_SQL}) WHERE ...`) } catch {}
```

Both legacy migrations have never run and never reported an error.

### 3. `engines.node: ">=18"` while the code needs `node:sqlite` (≥ 22.15)

`npm install` succeeds on Node 20; it fails at runtime in the red-team store.

This rewrite initially repeated the same mistake — for a while `engines` and
this README both claimed `>=20.11` on the basis that "the rewrite uses no
`node:sqlite`". **That was wrong**: `src/redteam/store/schema.ts` and
`src/redteam/store/sqlite.ts` both `import { DatabaseSync } from "node:sqlite"`
once the store layer landed. The lie was caught by the very regression test
added for the original bug (`test/regressions.test.ts`), corrected to `22.5`,
and then corrected again to **`22.15`** after a CI matrix measured where
`node:sqlite` actually starts existing:

```text
22.5 / 22.9 / 22.12 -> ERR_UNKNOWN_BUILTIN_MODULE
22.15               -> node:sqlite present, no FTS5   (store falls back to LIKE)
22.18+              -> node:sqlite with FTS5
```

Regression tests in `test/regressions.test.ts` fail the build if any of these
patterns reappear, and CI keeps a dedicated `22.15` job so the floor cannot
silently drift.

---

## What this rewrite found (and fixed)

These are defects found while migrating, not features added.

### Security: localhost-only is not CSRF protection

`/redteam/api` listens on `127.0.0.1` only, so the original guard waved through
**any** request whose socket came from a loopback address:

```js
// origin.ts, before
if (isLoopbackAddress(socket.remoteAddress)) return { ok: true };   // ① loopback: allow
```

The reasoning was "a browser's cross-origin fetch always attaches `Origin`, so
a missing `Origin` can only mean a local process". Half right: *absent* `Origin`
does come from local clients — but **a request with an `Origin` can also arrive
over a loopback socket**. Any page the user visits could then

```js
fetch("http://127.0.0.1:<port>/redteam/api", {
  method: "POST",
  body: JSON.stringify({ op: "openEngagement", ... })   // a write
});
```

and the target is the fact database holding engagements, credentials, and
shell records. Localhost binding does not stop this; only an `Origin` check
does.

What makes this worth writing down is **how the bug survived**: the test suite
asserted the broken behaviour *as the specification*:

```ts
it("① 回环 socket 无条件放行，即使是外部 Origin", () => { ... })   // old
```

A test that pins a wrong assumption turns a security gap into a "requirement".
`tsc` cannot see it, coverage cannot see it, and the next person is actively
discouraged from fixing it.

Now judged on three states — absent `Origin` or same-origin host → allow;
external host over loopback → **reject** with a new reason `"cross-origin"`
(distinct from `"host-mismatch"`, which stays for non-loopback sockets). Both
tests were rewritten to assert the fixed behaviour, and one of them now carries
a comment saying that reverting to "unconditional allow" turns it red.

### Build: `tsc --noEmit` green does not mean the bundle builds

`scripts/build-client.mjs` compiles `src/redteam/client/**` with
`lib: ["ES2020"]` and `types: []` — deliberately **no DOM lib and no Node
globals**. So browser globals like `setTimeout`, `window`, `document` do not
exist for that compile, and using one bare is a hard `TS2304`. Meanwhile
`tsc -p tsconfig.json` (which pulls in `@types/node`) reports green.

This bit for real during this rewrite: `tabs-a.ts` used `setTimeout`; `npm run
typecheck` passed; the client bundle failed; four `artifact.test.js` cases went
red.

Detection is already in place — `node scripts/build-client.mjs` (or
`npm run check:client`), which `test/ui/artifact.test.ts` exercises on every
run. The rule for authors: **anything under `src/redteam/client/**` and
`src/redteam/ui/tabs-*.ts` must touch browser globals only through the minimal
declarations in `client/dom.ts`**, never bare.

### Security: a guard that never worked

`assertPathWithin` compared lexically-resolved prefixes:

```js
const abs = resolve(target);
const ok = roots.some(root => abs === root || abs.startsWith(root + sep));
```

Attack (reproduced):

```
<target-dir>/link.txt -> /tmp/outside/secret.txt
guard: PASSES          # string starts with root
readFileSync(guard's return) -> "SECRET"
```

The function's own comment says its only reason to exist is to stop untrusted
`path` column values from being read into the browser panel. Lexical comparison
never stops symlinks, so **the guard had never taken effect**. Fixed with real
path resolution plus handling for two harder shapes: symlinked directory with a
not-yet-created leaf, and a home directory that is itself a symlink.

### Correctness: `engines` vs. actual capability

The original declared `engines.node: ">=18"` while requiring `node:sqlite`
(≥ 22.15). Install succeeds on Node 20, then fails at runtime.

After migrating the store layer, this repo fell into the same trap — and the
regression test added for the original bug caught it. `engines` is now
`>=22.15.0`, and CI runs a dedicated job on exactly 22.15.

### Process: a gate that ran a fraction of the tests

```bash
npm test            -> no output, exit 0
full glob           -> 1850 tests
```

At the time this was measured the suite was ~1,850 cases; it is 4,007 today.
The failure mode is what mattered, not the number.

`package.json` used `node --test dist-test/test/*.test.js`, matching only the
top-level files. At the time, 37 of 44 test files lived in subdirectories; today
it is **63 of 70**. CI showed green while running a fraction of the suite.

Fixed, and `npm run verify:tests` now asserts three things the test run itself
cannot: source/test file counts match, discovered test count is **greater than
zero** (not merely matching `[0-9]+`, which `# tests 0` also satisfies), and
discovered count ≥ files × 3. Current output:

```text
源码测试文件: 70
产物测试文件: 70
发现用例: 3758（pass 3758 / fail 0）
ok: 测试发现逻辑正常（来自 75 个测试文件）
```

### Silent regressions caught by differential testing

Migrating by "looks equivalent" produced two live regressions that only
sample-by-sample comparison against the original expression found:

- `formatTimestamp(0)` — the original used a bare truthiness check (`s ? ... : '—'`).
  A "cleaner" three-way check made `0` render as `1970-01-01` instead of `—`.
  Epoch zero is a plausible-looking timestamp, so nothing errors.
- `optionEntries` — a `table[key] ?? key` fallback invented UI options the
  backend does not recognise; selecting one silently sent an unknown state.

Both now have tests whose comments state the *intent* ("lock the original
bare-truthiness semantics"), not just the observation ("0 shows —").

## Verification

```bash
npm run typecheck      # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
npm run verify:patches # patch table integrity
npm run verify:tests   # source/test file counts match + discovered count > 0
npm test               # 4,007 tests / 681 suites
npm run check:client   # is client.js current with src/redteam/**?
npm run test:cov       # coverage
```

Measured on Node 22.22.1 (2026-10-21, final state):

```text
# tests 4007
# suites 681
# pass 4007
# fail 0
# skipped 0
```

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run verify:patches` | `patches: 86` — 210 literal / 5 regex / 79 with markers / 38 `skipIfMarked` / 48 optional |
| `npm run check:client` | `up to date：7673d34a1f87413c` (732,637 bytes) |
| `dsh-unbound drift` | `healthy 1 / applied 72 / absent 12 / dead 0` → `broken: 0` |
| `client.js` | 732,637 bytes · 14,170 lines · sha256 `7673d34a…ead5f4d` |

Three notes on what these numbers do *not* claim:

- **The behavioural-equivalence test can skip itself.** `test/equivalence.test.ts`
  is guarded by `{ skip: !canRun }`, where `canRun` requires both the
  `dsh-qilin` checkout and the real host `@deepseek-ai` tree. On a machine with
  neither, those 2 cases pass silently as "skipped" instead of failing. It did
  run here — independently re-counted as **100 (patch,file) pairs, 0
  differences** — but a CI run without `QILIN_PATH` proves less than it looks.
- **The drift counts are one host's state, not a constant.** The same command on
  the same machine reports `applied 31 / dead 39` if the host's source files
  have since been replaced or reverted. Only `broken: 0` is the healthy signal.
- **Coverage is not a gate.** The CI `coverage` job runs `test:cov` but asserts
  no threshold.

### Mutation-tested

Tests were validated by injecting the original bugs — done by hand, recorded
here, not automated in CI:

| Mutation | Result |
|---|---|
| Remove `import fs` from a src file | typecheck: 13 errors, tests: 28 failures |
| Remove the real `skipIfMarked` guard | 1 test fails |
| Point `desktop-shell` at a wrong file | caught by target-resolution tests |

---

## What you see after installing

A **`⛨ RedTeam` button** in the sidebar and in the session header
(`src/redteam/client/entry.ts` → `SidebarButton` / `HeaderButton`). Clicking it
opens a floating dock mounted to the `shell.overlay` slot at `order: 50`, plus a
`⛶ 全面浏览` button that opens the same console in a separate window
(`#redteam-full`).

The dock has **10 tabs**:

| # | Tab | id |
|---:|---|---|
| 1 | 资产测绘 | `assets` |
| 2 | 环境适配 | `env` |
| 3 | 智能体 | `agents` |
| 4 | 会话隧道 | `sessions` |
| 5 | 漏洞战果 | `findings` |
| 6 | 攻击链 | `chain` |
| 7 | 得分目标 | `scores` |
| 8 | 报告 | `report` |
| 9 | 知识库 | `knowledge` |
| 10 | 技能库 | `skills` |

Three counts are easy to confuse, so be precise: `TABS` in
`src/redteam/client/state.ts` has **10** entries (the bar); `ConsoleTabId` is a
**13**-value union (`testing` / `attackfiles` are legacy route aliases kept for
persisted state and deep links, `prompts` is addressable but not on the bar);
and there are **12** `renderXxxTab` functions.

Tab 3 (`agents`) renders a placeholder, `"智能体概览未接入"` — see
[Known limitations](#known-limitations-honest-list) #4.

Data comes from `POST /redteam/api` via `src/redteam/ui/tab-data.ts`, which
combines `tabs-a.ts` (6 tabs) and `tabs-b.ts` (6 tabs).

### Plugin surfaces

From `src/plugin/index.ts::apply()` (the Cordis half):

| Surface | Name | What it does |
|---|---|---|
| Tool | `qilin_status` | drift report for the installed host |
| Tool | `qilin_apply` | apply patches + shim + override; may request restart |
| Tool | `qilin_revert` | restore from backups (keeps `prompt-inject.md`) |
| Command | `/qilin` | `status` / `apply` / `revert` |
| Command | `/rules` | `list` / `use <id>` / `reset` / `help` — writes `AGENTS.md`/`CLAUDE.md` |
| Command | `/skills` | `list` / `help` — user skills under `$DSH_HOME/skills` |
| Prompt | inject + capability sections | registered per assembly, read lazily from `$DSH_HOME/prompt-inject.md` |
| Background | settle timer | after a surface-dependent delay, applies patches and self-checks rules |

Plugin name stays `dsh-qilin` on purpose: the host filters prompt sections with
`startsWith("dsh-qilin")`, and section names are an external contract.

## Known limitations (honest list)

1. **`platformConfigGet` and two siblings wrap their payload one level deeper
   than the client expects.** The server returns `{ok, platform:{config, tools,
   adapt}}`; `env-model.ts` reads flat. The failure mode is entirely silent:
   config drafts render empty, every toolkit shows as "not found", and save
   messages degrade to `$DSH_HOME` without an error. There is a shim,
   `flattenPlatform()` in `src/redteam/ui/tabs-a.ts`, together with a
   `KNOWN_SHAPE_GAPS` constant that states this is a mitigation rather than the
   design — if the dispatch side is changed to spread directly, the shim should
   become identity and be deleted.
2. **`agents` has no render slot.** `TabRegistryProps` has no `agents` field,
   `tab-registry.ts` returns `empty()` from `case "agents"` unconditionally, and
   there is no `client/agents-tab.ts`. The backend `agentsStatus` op *is*
   implemented — this is purely a front-end gap, recorded in
   `AGENTS_NOT_WIRED_REASON` (`src/redteam/ui/tabs-b.ts`).
3. **Node ≥ 22.15 is a real floor**, driven by `node:sqlite` in the store. The
   CLI alone would run lower, but the package declares the higher number.
4. **FTS5 is optional at runtime.** Node 22.15 ships `node:sqlite` without FTS5;
   the store probes for it and falls back to `LIKE`. Both paths are tested;
   search ranking differs.
5. **`src/features/*` and four `src/platform/*` modules are unreferenced** by
   any production code (`desktop-paths`, `net-scope`, `net-tables`, `version`).
   They are migrated, typed, and tested pure logic; nothing calls them yet.
6. **Two `absent`-patch groups are guesses-avoided, not fixed.** See
   [Known gaps](#known-gaps-deliberately-not-guessed).
7. **No desktop asar unpack/repack.** Path detection and a "refuse to patch
   sealed asar" policy exist; extraction does not.
8. **Update channel is ports only.** `updateCheck` / `updateApply` are typed
   gateway ops with tests; the downloader / swapper is elsewhere.
9. **The server half needs `webServer` at apply time.** It declares
   `inject: []` and waits lazily; on a surface without `webServer` the route
   simply is not registered (the Cordis half still works).

---

## Known gaps (deliberately not guessed)

Twelve patches report `absent` on 0.2.1-rc.2. Verified, not assumed:

- `desktop-shell` (5 patches) — searched every `.js` under the host for all 7 of
  those patches' patterns: **0 matches**. The code was removed upstream. Pointing
  the resolver at `dsh-desktop-host` would have produced 5 fake drift alarms.
- `hooks-claude-code` / `hooks-codex` (4 patches) — no such packages exist.
- `preset-liangshen` / `liangshen-tool-bootstrap` (2 patches) — third-party
  plugin, not installed.
- `preset-unrestricted` (1 patch) — preset not shipped in this build.

These stay `absent` (not `dead`) so the drift signal stays trustworthy.

---

## License

MIT.
