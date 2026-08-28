---
'fe-audit': patch
---

`analyze` no longer reports a copy that is already patched as needing work.

npm reports one finding per package and lists only the vulnerable paths, but
every installed copy of the name was being classified. For a copy already above
the advisory range the search for a safe version looks *above* that copy, which
finds the next major — so a patched copy was reported either as `DO NOT
OVERRIDE, upgrade the parent instead` or, when no higher release existed, as
`no published release escapes`.

Both readings pointed at packages that were already fixed. On a real project
this removed one spurious `RISKY` entry and five of six `NEEDS MANUAL REVIEW`
entries, leaving the one whose advisory genuinely covers every published
version.

A copy is now classified only when the advisory range actually contains it. An
unreadable range still classifies, since treating "cannot tell" as "not
affected" would drop a real finding.
