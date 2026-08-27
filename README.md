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
```

| Option            | Meaning                                          |
| ----------------- | ------------------------------------------------ |
| `--write`         | Merge the proposed overrides into `package.json` |
| `--include-tight` | Also write overrides that cross an exact pin     |
| `--omit-dev`      | Only consider production dependencies            |
| `--json`          | Emit raw JSON instead of a report                |

`verify` exits `1` when an override failed to remove a vulnerability, so it is
safe to gate CI on.

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
it can be driven from cached or synthetic data.

## Architecture

```
src/
  domain/         pure decisions - no fs, no network, no console
  io/             the only code that touches a process or a disk
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
npm test        # 58 assertions, no network required
npm run build
```

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
