# Changesets

Every change that users would notice needs a changeset — a short note saying
what changed and how the version should move.

```bash
npm run changeset
```

That writes a markdown file here. Commit it alongside your change.

Releases are cut by merging the **Version Packages** pull request that CI opens
once changesets are pending. That PR applies the bumps, rewrites
`../CHANGELOG.md` and publishes to npm.

## Choosing a bump

Version numbers here describe the **CLI contract** — flags, exit codes, report
structure and the classification tiers — not just exported types.

| Bump | Use for |
| --- | --- |
| `patch` | A fix that leaves the contract unchanged |
| `minor` | A new command, flag or report section |
| `major` | A renamed tier, a changed exit code, a removed or renamed flag |

Renaming a classification tier is a breaking change even though no TypeScript
type moved, because scripts read those names.

## Writing the note

The note becomes the changelog entry, so write it for someone deciding whether
to upgrade. Prefer the consequence over the mechanism:

```md
---
'fe-audit': minor
---

`prune` now judges an override against the version npm would actually install
rather than the most favourable one any consumer could accept. Overrides that
were reported as redundant but were in fact holding back a vulnerable
transitive version are now correctly kept.
```
