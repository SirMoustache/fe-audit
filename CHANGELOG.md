# Changelog

## 1.0.0

### Major Changes

- 368a102: First release.
  
  Classifies `npm audit` findings and generates `overrides` that are safe to
  apply, by checking whether the patched version satisfies every consumer's
  declared range in the lockfile.
  
  **Commands**
  
  - `survey` — inventory projects and flag what blocks remediation
  - `analyze` — classify findings as `SAFE`, `SCOPED`, `TIGHT`, `RISKY`, `DIRECT`,
    `WITHHELD` or `INHERITED`, and write the safe ones with `--write`
  - `verify` — confirm overrides took effect, exiting non-zero only when one
    demonstrably failed to remove a vulnerability
  - `explain` — every installed copy of a package, who declares each one, whether
    an override is forcing a version against a declared range, and whether it can
    reach production code
  - `unused` — declared dependencies with no reference, imports that were never
    declared, and overrides that no longer apply; each unreferenced dependency
    reports the vulnerable packages that would leave the tree with it
  - `prune` — overrides that no longer earn their place, including *harmful* ones
    pinning below what every consumer accepts
  
  Version resolution runs concurrently over HTTP with gzip and an on-disk cache:
  96.0s to 10.6s cold, 9.6s warm, on a project with 127 findings.
  
  **Safeguards.** Each of these exists because it was a real failure found against
  production repositories:
  
  - Never forces a breaking version on a consumer that declared otherwise — the
    failure that makes `npm audit` green while breaking the build
  - Treats `0.x` minor and `0.0.z` patch bumps as breaking, since `^0.21.0` and
    `^0.0.1` pin narrowly
  - Never writes a top-level override for a direct dependency, which npm rejects
    with `EOVERRIDE`; scoping the same package under a parent is still allowed
  - Reads direct dependencies from `package.json` rather than the lockfile's copy,
    because that is what npm validates against
  - Refuses to override a nested copy with no attributable declarer, since a bare
    override would land on the hoisted copy instead
  - Withholds a target when two copies of one parent need different versions,
    rather than keeping whichever came last
  - Judges override necessity against the version npm would actually install, not
    the most favourable one a consumer could accept
  - Surfaces a registry outage, an advisory-service failure or an `npm audit`
    error rather than reading any of them as "nothing to worry about"
