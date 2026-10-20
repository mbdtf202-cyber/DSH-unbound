# DSH-unbound

Type-safe DeepSeek Harness host patching engine. TypeScript rewrite of
[`dsh-qilin`](https://github.com/YuJunZhiXue/dsh-qilin)'s patch layer.

**Version 0.0.1** — this is a rewrite of the *patch engine*, not a port of every
feature. See [scope](#scope-what-this-is-and-is-not) before installing.

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

**Is:** the patch engine — load typed patch definitions, resolve host target
files, apply/revert atomically with backups, detect upstream drift, and a CLI
over all of it.

**Is not (yet):** the Cordis plugin surface, prompt-injection file management,
red-team console, desktop asar unpacking, update channel. Those live in
`dsh-qilin` and are not reimplemented here. If you need a working end-user
plugin today, use `dsh-qilin`; this repo is the engine that should eventually
replace its patch layer.

---

## Install

```bash
npm install
npm run build        # -> dist/
npm test             # 131 tests
```

Requires Node ≥ 20.11 (the shipped `dist/` imports only stable `node:` builtins).

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
  patches/     typed model, validation, loader (folds both legacy schemas)
  engine/      text transforms, apply/revert, drift detection
  host/        host discovery, target path resolution
  fs/          atomic writes, backups
  cli/         command line
patches/
  patches.json 86 patches, extracted programmatically from dsh-qilin
  targets.json 65 target keys resolved on a real 0.2.1-rc.2 host
test/          131 tests across 6 files
```

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

### 3. `engines.node: ">=18"` while the code needs `node:sqlite` (≥ 22.5)

`npm install` succeeds on Node 20; it fails at runtime in the red-team store.
This rewrite uses no `node:sqlite`, so its floor is honest: `>=20.11`.

Regression tests in `test/regressions.test.ts` fail the build if any of these
patterns reappear.

---

## Verification

```bash
npm run typecheck      # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
npm run verify:patches # patch table integrity
npm test               # 131 tests
npm run test:cov       # coverage
```

### Mutation-tested

Tests were validated by injecting the original bugs:

| Mutation | Result |
|---|---|
| Remove `import fs` from a src file | typecheck: 13 errors, tests: 28 failures |
| Remove the real `skipIfMarked` guard | 1 test fails |
| Point `desktop-shell` at a wrong file | caught by target-resolution tests |

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
