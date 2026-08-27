# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versioning applies to the CLI contract — flags, exit codes, report structure and
classification tiers — not just to exported types.

## [Unreleased]

Nothing has been released yet. Everything below ships in the first version.

### Added

- `survey`, `analyze`, `verify`, `explain`, `unused` and `prune` commands.
- Classification of every audit finding as `SAFE`, `SCOPED`, `TIGHT`, `RISKY`,
  `DIRECT`, `WITHHELD` or `INHERITED`, based on whether the patched version
  satisfies every consumer's declared range in the lockfile.
- `--write` to merge safe overrides into `package.json`, with `--include-tight`
  to opt into overrides that cross an exact pin.
- `verify`, which cross-references the live audit and exits non-zero only when an
  override demonstrably failed to remove a vulnerability.
- `explain <package>` — every installed copy, who declares each one, whether an
  override is forcing a version against a declared range, and whether the package
  can reach production code.
- `unused` — declared dependencies with no import, script or config reference;
  imports that were never declared; and overrides that no longer apply. Each
  unreferenced dependency reports the packages, and the vulnerable packages, that
  would leave the tree with it.
- `prune` — overrides that no longer earn their place: redundant ones npm would
  resolve safely anyway, *harmful* ones pinning below what every consumer
  accepts, inert ones with nothing to apply to, and ineffective ones whose forced
  version is itself vulnerable. Advisory ranges come from npm's advisory API,
  because a working override removes the package from `npm audit` entirely.
- Concurrent version resolution over HTTP with gzip and an on-disk cache:
  96.0s to 10.6s cold, 9.6s warm, on a project with 127 findings.
- `--concurrency`, `--no-cache`, `--cache-ttl` and `--skip-audit`.
- Programmatic API exporting the pure domain.

### Safeguards

These exist because each one was a real failure, found by testing the tool
against production repositories:

- Never forces a breaking version on a consumer that declared otherwise — the
  failure that makes `npm audit` green while breaking the build.
- Treats `0.x` minor and `0.0.z` patch bumps as breaking, since `^0.21.0` and
  `^0.0.1` pin narrowly.
- Never writes a top-level override for a direct dependency, which npm rejects
  outright with `EOVERRIDE`; scoping the same package under a parent is still
  allowed.
- Reads direct dependencies from `package.json` rather than the lockfile's copy,
  because that is what npm validates against.
- Refuses to override a nested copy with no attributable declarer, since a bare
  override would land on the hoisted copy instead.
- Withholds a target when two copies of one parent need different versions,
  rather than silently keeping whichever came last.
- Judges override necessity against the version npm would actually install, not
  the most favourable one a consumer could accept.
- Surfaces a registry outage, an advisory-service failure or an `npm audit` error
  rather than reading any of them as "nothing to worry about".

[Unreleased]: https://github.com/SirMoustache/fe-audit/commits/master
