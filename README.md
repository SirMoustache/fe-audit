# fe-audit

Classifies `npm audit` findings and generates `overrides` that are safe to apply.

```bash
npx fe-audit analyze .
```

## The problem

A vulnerability report names packages you do not depend on. `flatted` is a
dependency of `flat-cache`, of `file-entry-cache`, of `eslint`. You cannot
upgrade it directly, and `npm audit fix` leaves most of them alone.

Almost every finding is one of two things, and the difference decides what you do:

- **A stale lockfile entry** — a patched version already satisfies every declared
  range. Safe to force with `overrides`.
- **A genuine major upgrade** — the parent would reject the patched version.
  Overriding it makes the audit green and breaks the build.

`fe-audit` tells them apart by reading the lockfile, so you do not find out at
build time.

Measured on a real Next.js project: **83 findings (10 critical) → 9 (0 critical)**,
with no regressions.

## Usage

```bash
npx fe-audit survey ./packages        # inventory projects, flag blockers
npx fe-audit analyze ./app            # classify findings, propose overrides
npx fe-audit analyze ./app --write    # apply the safe ones
npx fe-audit verify ./app             # confirm they took effect
npx fe-audit explain tmp ./app        # why one package is classified as it is
npx fe-audit unused ./app             # declared but unreferenced dependencies
npx fe-audit prune ./app              # overrides that no longer earn their place
```

| Option               | Meaning                                                     |
| -------------------- | ----------------------------------------------------------- |
| `--write`             | `analyze`: apply overrides. `prune`: remove the removable ones |
| `--include-tight`    | Also write overrides that cross an exact pin                |
| `--omit-dev`         | Only consider production dependencies                       |
| `--json`             | Emit raw JSON instead of a report                           |
| `--skip-audit`       | `explain`/`unused` only: use the lockfile, skip `npm audit` |
| `--concurrency <n>`  | Parallel registry lookups (default 12)                      |
| `--no-cache`         | Ignore the on-disk version cache                            |
| `--cache-ttl <mins>` | How long cached versions stay fresh (default 60)            |

`verify` exits `1` when an override failed to remove a vulnerability, so it is
safe to gate CI on.

## Understanding a verdict

When `analyze` refuses to override something, `explain` shows why:

```
$ npx fe-audit explain tmp ./app

tmp   in /path/to/app

INSTALLED (1 copy)

  node_modules/tmp   0.2.7
  @sitecore-jss/sitecore-jss-cli@18.0.2         ^0.1.0          REJECTS this version
  external-editor@3.1.0                         ^0.0.33         REJECTS this version

OVERRIDE
  "tmp": "^0.2.4"

ADVISORY
  not currently listed by npm audit

GUIDANCE
  An override is forcing a version that a consumer declared against.
  A passing `npm run build` is not evidence this is safe unless the build
  actually executes that consumer. Confirm the API surface it uses, or
  upgrade the consumer instead.
  Not reachable from production - build or tooling only, so the practical risk is lower.
```

It answers the questions that decide what to do: which copies exist, who asked
for each one, whether an override is forcing a version against a declared range,
and whether the package can reach shipped code at all.

That last point matters more than it looks. A hand-written override can force a
breaking version and still pass `npm run build` — not because it is safe, but
because the build never executes the code that would fail. `explain` tells you
which situation you are in.

## Speed

Resolving published versions is the only slow part of a run, so it is done
concurrently, over HTTP rather than by spawning `npm view`, with gzip and an
on-disk cache. Measured on a project with 127 findings across 61 packages:

|                               | Wall clock |
| ----------------------------- | ---------- |
| Serial `npm view` per package | 96.0s      |
| Concurrent + cached + HTTP    | 27.7s      |
| ...with gzip                  | **10.6s**  |
| ...warm cache                 | **9.6s**   |

`npm audit` itself accounts for 8.3s of that, so resolution now costs a little
over a second. Results are byte-identical across all four.

The HTTP fast path is only used where the answer is unambiguous — an unscoped
package on the public registry. A scope may be mapped to a private registry this
process cannot see, and answering from npmjs could return a different package's
versions entirely. Scoped packages go through `npm view`, which already knows the
project's registry and credentials. No auth token is ever read.

## How findings are classified

| Tier          | Meaning                                                                                 |
| ------------- | --------------------------------------------------------------------------------------- |
| **SAFE**      | Every consumer's range accepts the patched version. Written by default.                 |
| **SCOPED**    | A nested copy needs its own version. Emitted as a scoped override.                      |
| **TIGHT**     | A consumer pinned exactly, but the bump is non-breaking. Opt in with `--include-tight`. |
| **RISKY**     | Would force a breaking change on an unwilling consumer. **Refused.**                    |
| **DIRECT**    | A direct dependency. Upgrade `package.json`; npm rejects overriding it.                 |
| **WITHHELD**  | Two copies of one parent need different targets; npm cannot express both.               |
| **INHERITED** | No flaw of its own. Clears for free once its parent is fixed.                           |

Risky, direct and withheld findings are never written — they need a human.

`TIGHT` is opt-in because an exact pin is sometimes deliberate: maintainers pin
precisely when the next patch broke them. On one project it is the difference
between 52 overrides (127 → 94 findings) and 69 (127 → 76), so it is usually
worth taking — with a build afterwards.

## Verify verdicts

The audit is the arbiter, consulted whether or not the resolved version matches
the declared text. An override can be honoured to the letter and still leave a
package vulnerable if the advisory widened after the version was chosen.

| Verdict            | Meaning                                                                         |
| ------------------ | ------------------------------------------------------------------------------- |
| `PINNED` / `RANGE` | Honoured, and the audit agrees.                                                 |
| `AHEAD`            | Resolved copy is newer than the override. Benign; drop the override.            |
| `DIVERGED`         | Differs from the declared version but is absent from the audit. Benign.         |
| `STILL LISTED`     | Still in the audit, but several copies exist so the audit is ambiguous. Warned. |
| `STILL VULNERABLE` | Still in the audit and only one copy exists. **Fails.**                         |
| `INERT`            | Nothing in the tree for the override to act on.                                 |

## Four behaviours that will otherwise cost you a day

**Stale state silently under-applies overrides — the lockfile _and_ `node_modules`.**
Running `npm install` over an existing lockfile leaves some copies at their old
versions. Deleting the lockfile alone is not enough either: npm reads the
existing `node_modules` when building the ideal tree and will preserve a nested
copy an override should have removed, even under `--package-lock-only`. Rebuild
both:

```bash
rm -rf node_modules package-lock.json
npm install
npx fe-audit verify .
```

**npm rejects a top-level override for a direct dependency.** Writing
`{"axios": "1.20.1"}` while `package.json` declares `"axios": "^1.3.5"` fails
the whole install with `EOVERRIDE`, `npm audit` included. Scoping the same
package under a parent is allowed, so a vulnerable _nested_ copy can still be
patched. Direct dependencies are always routed to `DIRECT`, and a backstop
withholds any top-level placement that names one.

**`0.x` minor bumps are breaking.** `axios 0.21 → 0.33` is as breaking as
`css-select 2 → 4`, and `^0.0.1` pins a single patch so `0.0.z` bumps are too.
A naive major-number comparison waves all three through.

**A nested copy with no attributable declarer cannot be overridden.** A bare
override is global, so it would land on the hoisted copy and force a version on
consumers that were never examined. Those are reported for review, not guessed at.

## Finding dependencies you no longer need

The cheapest way to fix a vulnerability is to delete whatever pulled it in.

```
$ npx fe-audit unused ./app

UNREFERENCED - declared but no reference found (3)
  ngrok                       devDependencies    1 vulnerable, 40 packages
      carries: request
  caniuse-lite                dependencies       no transitive packages
  react-apollo                dependencies       7 packages

Removing the unreferenced dependencies above would drop 2 vulnerable package(s)
that nothing else needs.

PHANTOM - imported but not declared (4)
  webpack                     NOT INSTALLED          scripts/build.js
  prop-types                  resolves by hoisting   src/components/dynamicList/index.jsx
```

Three things it reports:

- **UNREFERENCED** — declared, but no import, script or config reference found.
  Each shows how many packages, and how many _vulnerable_ packages, would leave
  the tree with it. Only packages nothing else needs are counted.
- **PHANTOM** — imported but never declared. `resolves by hoisting` means it
  works today only because something else installs it; `NOT INSTALLED` means
  that code path is already broken.
- **DEAD OVERRIDES** — overrides for packages no longer in the tree.

### On trusting it

Usage detection is textual: imports, `package.json` scripts, and root config
files. That is not proof, so the output is evidence rather than a verdict, and
nothing is ever removed automatically.

It does understand the conventions that make naive scanners cry wolf — tool
shorthand (`.eslintrc` says `"react"` for `eslint-plugin-react`, jest says
`"jsdom"` for `jest-environment-jsdom`), binaries invoked from scripts,
`@types/*` packages the compiler loads implicitly, peer dependencies of packages
you do use, and `tsconfig` path aliases. On a real 1,182-file project those
conventions took the candidate list from 21 to 6.

Remove one at a time, with a build and test run between each.

## Removing overrides that no longer help

Overrides are pins, and pins go stale. Once the upstream fix lands, an override
stops protecting anything — and can start holding a package *below* what npm
would otherwise install.

```
$ npx fe-audit prune ./app

HARMFUL - pins a lower version than npm would pick (1)
  jws          3.2.3 vs 4.0.1    every consumer accepts 4.0.1, which is safe;
                                 this pins the older 3.2.3

REDUNDANT - npm would resolve to something safe anyway (19)
  flatted      3.4.4             every consumer accepts 3.4.4, which is already safe

KEEP - still doing real work (9)
  lodash       4.18.1 vs 4.17.21 without it npm would resolve 4.17.21, which is vulnerable

30 override(s) can be removed. Re-run with --write to apply.
```

The `jws` case is the one worth understanding: `jsonwebtoken@9` asks for
`jws@^4.0.1`, the advisory only covers `<3.2.3`, so the override was pinning a
*lower* major than the project would otherwise get — protecting nothing.

`prune` answers a question `npm audit` cannot. Once an override works, the
package disappears from the audit entirely, so there is no way to tell from the
audit whether it is still needed. The advisory ranges come from npm's advisory
API directly, for every published version of each overridden package.

Measured on a real project: **45 override declarations down to 15, with the
audit unchanged at 9 findings and nothing newly vulnerable.**

An `INEFFECTIVE` override — one whose forced version is *itself* vulnerable — is
never removed automatically. That needs a decision, not a deletion.

## Why `overrides` rather than `npm audit fix`

Measured on the same project:

| Approach        | Total | Critical |
| --------------- | ----- | -------- |
| Baseline        | 83    | 10       |
| `npm audit fix` | 60    | 9        |
| `overrides`     | 14    | 0        |

`npm audit fix` also writes nothing to `package.json`, so its work is lost when
the lockfile is regenerated — it went **60 → 72** in that test, while the
overrides result reproduced exactly from scratch.

## Programmatic use

The domain is pure and dependency-free apart from `semver`:

```ts
import {
  buildDependencyGraph,
  classifyAll,
  planOverrides,
  readFindings,
} from "fe-audit";

const graph = buildDependencyGraph(lockfile, { manifest });
const remediations = classifyAll(readFindings(auditReport), graph, versionsFor);
const { overrides, conflicts } = planOverrides(remediations);
```

`classifyAll` takes a `versionsFor` lookup rather than calling the registry, so
it can be driven from cached or synthetic data. `remediateProject` is async
because it resolves versions concurrently first; everything under `domain/`
stays synchronous and pure.

## Architecture

```
src/
  domain/         pure decisions - no fs, no network, no console
  io/             the only code that touches a process, a socket or a disk
  features/       one slice per capability: survey, remediate, verify
  presentation/   shared text layout
```

One rule earns its own home in `domain/dependency-graph.ts`: **npm keys a scoped
override by the package that declares the dependency, not by the directory the
copy sits in.** Those differ whenever npm hoists. It was implemented twice
originally, the two copies disagreed, and the resulting bug survived until
`verify` contradicted `analyze`.

## Development

```bash
npm install
npm test        # 91 assertions, no network required
npm run build
node dist/cli.js analyze /path/to/project
```

The cache lives in `os.tmpdir()/fe-audit-cache` unless `FE_AUDIT_CACHE_DIR` says
otherwise. Deleting it is always safe.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the architecture rules, how to add a
test, and the release process. Changes are recorded in
[CHANGELOG.md](CHANGELOG.md).

## Limitations

- Only reads `package-lock.json`. Yarn projects need `resolutions` instead.
- Version-qualified scope keys (`{"glob@7.1.0": {...}}`) are not generated, and
  `verify` reports hand-written ones as `INERT` — scopes are matched by name only.
- Calls the registry once per vulnerable package, so a first run on a large
  project takes a few minutes.
- It proposes; it does not validate. A green audit means nothing until
  `npm run build` and the test suite pass.

## License

MIT
