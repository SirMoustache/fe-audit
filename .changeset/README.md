# Changesets

Every change that users would notice needs a changeset — a short note saying
what changed and how the version should move.

```bash
npm run changeset
```

That writes a randomly-named markdown file here. Commit it with your change.

## Before the first release

Until `1.0.0` ships there is nothing to describe a change *against*. A note
saying an internal seam was tidied would land in the `1.0.0` changelog and tell
first-time readers about a state they never had. Until then, fold anything
user-visible into `initial-release.md` and skip the changeset entirely for
refactors.

The full walkthrough, including what the release pull request looks like, is in
[the README](../README.md#contributing-a-change).

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

Not this:

```md
---
'fe-audit': minor
---

Changed assessInstance to use consensus instead of optimistic.
```
