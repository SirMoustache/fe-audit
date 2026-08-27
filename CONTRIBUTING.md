# Contributing

## Getting started

Requires Node 18 or newer.

```bash
git clone <repo-url>
cd fe-audit
npm install
npm test
```

There is no watch mode by design — the suite runs in about a second.

## Scripts

| Script              | What it does                                    |
| ------------------- | ----------------------------------------------- |
| `npm test`          | Type-checks `src` + `test`, then runs the suite |
| `npm run typecheck` | Types only, no emit — what CI gates on          |
| `npm run build`     | Compiles `src` to `dist` with declarations      |
| `npm run clean`     | Removes `dist` and build info                   |
| `npm run changeset` | Records a change and its version bump           |

Two TypeScript configs, deliberately:

- **`tsconfig.json`** covers `src` _and_ `test`. This is the one your editor
  picks up. If tests were left out, opening a test file would give you
  `Cannot find name 'process'` — an editor finds no config for the file and
  silently falls back to defaults with no `@types`.
- **`tsconfig.build.json`** narrows to `src` and emits `dist`, so tests never
  reach the published package.

## How the code is organised

```
src/
  domain/         pure decisions - no fs, no network, no console
  io/             the only code that touches a process, a socket or a disk
  features/       one slice per capability: survey, remediate, verify
  presentation/   shared text layout
```

Three rules keep this honest:

**`domain/` may not import from `io/`.** It receives data, returns decisions.
That is what makes the classifier testable without a network, and why the suite
runs offline in a second.

**Version lookups are a table, not a call.** `classifyAll` takes a `versionsFor`
function that reads from a pre-fetched `Map`. The feature layer does the
fetching. Do not be tempted to make the domain async to "simplify" this — the
purity is the point.

**Wording lives in views, not in the domain.** The domain returns a verdict such
as `still-listed`; `features/*/view.ts` decides what English that becomes.

### Where to put a change

| Change                             | Goes in                                       |
| ---------------------------------- | --------------------------------------------- |
| A new classification rule          | `domain/remediation.ts`                       |
| Version or range arithmetic        | `domain/semver-policy.ts`                     |
| Anything about the installed tree  | `domain/dependency-graph.ts`                  |
| Reading npm, the registry, or disk | `io/`                                         |
| A new command                      | a new folder under `features/`, plus `cli.ts` |
| Changing report wording            | the relevant `features/*/view.ts`             |

One rule earns its own home in `domain/dependency-graph.ts`: **npm keys a scoped
override by the package that declares the dependency, not by the directory the
copy sits in.** Those differ whenever npm hoists. It was implemented twice
originally, the two copies disagreed, and the bug survived until `verify`
contradicted `analyze`. If you need that logic, call the graph.

## Testing

`test/fe-audit.test.ts` uses a hand-rolled harness — no framework, no network,
no fixtures on disk. One synthetic lockfile covers every shape the classifier
has to tell apart.

A test is worth adding when it encodes a claim that could silently become false:

```ts
it("refuses a breaking upgrade its consumer would reject (css-select/svgo)", () => {
  const result = only("css-select", "<3.1.0");
  assert.strictEqual(result.kind, "risky");
});
```

Every bug found so far has a test named after the failure, not the function.
Prefer that. `flatted` must classify SAFE and `css-select` must classify RISKY;
if either flips, the tool's whole reason to exist is broken.

To exercise a new tree shape, add packages to the `LOCKFILE` fixture and a
matching entry to `REGISTRY`. Registry data is injected, so no network is used.

## Trying it against a real project

```bash
npm run build
node dist/cli.js analyze /path/to/some/project
```

`analyze` without `--write` changes nothing, so it is safe to point at anything.
For a repeatable experiment, copy a project's `package.json` and
`package-lock.json` into a temp directory and work there — `analyze` only reads
those two files.

Useful while iterating:

```bash
node dist/cli.js analyze <dir> --json | jq '.groups.risky'
node dist/cli.js analyze <dir> --no-cache      # bypass the version cache
FE_AUDIT_CACHE_DIR=/tmp/fe-cache node dist/cli.js analyze <dir>
```

## Releasing

Releases are automated with changesets. The contributor-facing walkthrough —
what `npm run changeset` asks, what it writes, and how the **Version Packages**
pull request turns that into a release — is in
[the README](README.md#contributing-a-change).

`CHANGELOG.md` is generated. Editing it by hand will be overwritten.

The package sits at `0.0.0` until the first release; the initial changeset is a
`major`, which makes it `1.0.0`.

### One-time publishing setup

The release workflow needs an npm **automation** token with publish rights,
stored as the repository secret `NPM_TOKEN`
(_Settings → Secrets and variables → Actions_).

It also needs _Allow GitHub Actions to create and approve pull requests_ enabled
under _Settings → Actions → General_, or the Version Packages pull request cannot
be opened. This is the most common first-time failure, and the error message does
not make the cause obvious.

Publishing sets `NPM_CONFIG_PROVENANCE`, which links the published tarball to the
commit and workflow that built it. That requires the `id-token: write` permission
the workflow already declares and the `repository` field in `package.json`.

### Publishing by hand

Only if CI is unavailable:

```bash
npx changeset version     # applies bumps, rewrites the changelog
npm run release           # builds and publishes
```

`prepublishOnly` re-runs clean, build and test, so a broken build cannot ship
even by this route. Check `npm pack --dry-run` first: the `files` field limits
the tarball to `dist` and `README.md`, and a stray addition there ships source
or tests to every consumer.

## Troubleshooting

**`Cannot find name 'process'` in the editor** — the TypeScript server is using
stale or missing project config. Restart it (in VS Code: _TypeScript: Restart TS
Server_), and make sure the editor's workspace root is this repository rather
than a parent folder.

**`npm.ps1 cannot be loaded` on Windows** — PowerShell execution policy. Use
`npm.cmd`, or run from `cmd.exe`.

**A run seems to ignore a published version** — the version cache is stale.
Pass `--no-cache`, or delete `os.tmpdir()/fe-audit-cache`. Deleting it is always
safe.

**`npm audit` dominates the runtime** — it does, and that is expected. On a
127-finding project it accounts for roughly 8 of the 10 seconds. Version
resolution is already about a second; optimise elsewhere.
