import type { Consumer, DependencyGraph, PackageInstance } from './dependency-graph';
import type { Finding, Severity } from './finding';
import { hasOwnAdvisory } from './finding';
import type { PackageName, RangeSpec, Version } from './semver-policy';
import { accepts, findEscapeVersion, isBreakingUpgrade, isExpressible, testRange } from './semver-policy';

/** How much trust an override deserves once it is known to be non-breaking. */
export type Tier =
  /** Every consumer's declared range accepts the target. */
  | 'safe'
  /** A consumer pinned exactly, but the bump cannot break it. */
  | 'tight';

export interface ConsumerRef {
  readonly name: PackageName | '<root project>';
  readonly version: Version | undefined;
  readonly range: RangeSpec;
}

interface RemedyBase {
  readonly name: PackageName;
  readonly severity: Severity;
}

/** Facts shared by every remedy that identified a concrete upgrade target. */
interface UpgradeFacts {
  readonly from: Version;
  readonly to: Version;
  /** npm keys overrides by the tree name, which differs for aliased installs. */
  readonly overrideName: PackageName;
  readonly instancePath: string;
  readonly consumerCount: number;
  readonly rejectedBy: readonly ConsumerRef[];
  readonly inexpressibleCount: number;
}

/** No flaw of its own; clears once its parent is fixed. */
export interface InheritedRemedy extends RemedyBase {
  readonly kind: 'inherited';
  readonly inheritedFrom: readonly PackageName[];
}

/** Reported by the audit but absent from the lockfile. */
export interface AbsentRemedy extends RemedyBase {
  readonly kind: 'absent';
  readonly reason: string;
}

/** No safe action can be derived; needs a human. */
export interface UnresolvableRemedy extends RemedyBase {
  readonly kind: 'unresolvable';
  readonly reason: string;
  readonly instancePath?: string;
  readonly from?: Version;
}

/** A root dependency: upgrade `package.json`, never override. */
export interface DirectUpgradeRemedy extends RemedyBase, UpgradeFacts {
  readonly kind: 'direct-upgrade';
  readonly declared: RangeSpec;
  readonly field: string;
  readonly breaking: boolean;
}

/** Would force a breaking change on a consumer that declared otherwise. */
export interface RiskyRemedy extends RemedyBase, UpgradeFacts {
  readonly kind: 'risky';
  readonly breaking: true;
}

/** Safe to express as an npm override. */
export interface OverrideRemedy extends RemedyBase, UpgradeFacts {
  readonly kind: 'override';
  readonly tier: Tier;
  /** Empty means a flat override; otherwise the packages to scope it under. */
  readonly scopeKeys: readonly PackageName[];
}

/**
 * What to do about a finding. Every finding resolves to exactly one of these, so
 * the tiers are data rather than a matter of which array something was pushed
 * into — and the compiler enforces that each kind carries the fields it needs.
 */
export type Remediation =
  | InheritedRemedy
  | AbsentRemedy
  | UnresolvableRemedy
  | DirectUpgradeRemedy
  | RiskyRemedy
  | OverrideRemedy;

export type VersionLookup =
  | { readonly ok: true; readonly versions: readonly Version[] }
  | { readonly ok: false; readonly reason: string };

/** Pure: this is a lookup into pre-fetched data, never a network call. */
export type VersionsFor = (name: PackageName) => VersionLookup;

export const isOverride = (remedy: Remediation): remedy is OverrideRemedy =>
  remedy.kind === 'override';

export const isRisky = (remedy: Remediation): remedy is RiskyRemedy => remedy.kind === 'risky';

export const isDirectUpgrade = (remedy: Remediation): remedy is DirectUpgradeRemedy =>
  remedy.kind === 'direct-upgrade';

export const isInherited = (remedy: Remediation): remedy is InheritedRemedy =>
  remedy.kind === 'inherited';

export const needsReview = (remedy: Remediation): remedy is UnresolvableRemedy | AbsentRemedy =>
  remedy.kind === 'unresolvable' || remedy.kind === 'absent';

export const isTier =
  (tier: Tier) =>
  (remedy: Remediation): remedy is OverrideRemedy =>
    isOverride(remedy) && remedy.tier === tier;

export const isScoped = (remedy: Remediation): boolean =>
  isOverride(remedy) && remedy.scopeKeys.length > 0;

const toConsumerRef = (consumer: Consumer): ConsumerRef =>
  Object.freeze({
    name: consumer.declarerName ?? '<root project>',
    version: consumer.declarerVersion,
    range: consumer.range,
  });

const classifyInstance = (
  finding: Finding,
  instance: PackageInstance,
  graph: DependencyGraph,
  versions: readonly Version[]
): Remediation => {
  const base = { name: finding.name, severity: finding.severity };

  const escape = findEscapeVersion(versions, finding.advisoryRange, instance.version);
  if (!escape.found) {
    return Object.freeze({
      ...base,
      kind: 'unresolvable',
      instancePath: instance.path,
      from: instance.version,
      reason: escape.reason,
    });
  }

  const target = escape.version;
  const consumers = graph.consumersOfInstance(instance);
  const rejecting = consumers.filter((consumer) => !accepts(consumer.range, target));

  const facts: UpgradeFacts = {
    from: instance.version,
    to: target,
    overrideName: instance.treeName,
    instancePath: instance.path,
    consumerCount: consumers.length,
    rejectedBy: rejecting.map(toConsumerRef),
    inexpressibleCount: consumers.filter((consumer) => !isExpressible(consumer.range)).length,
  };

  // A direct dependency is upgraded in package.json. Overriding one hides the
  // real state of the project, and npm rejects a top-level override for a direct
  // dependency outright (EOVERRIDE). Aliased installs are declared under their
  // tree name, so both names have to be consulted.
  const direct =
    graph.directDependency(finding.name) ?? graph.directDependency(instance.treeName);
  if (direct && graph.isHoisted(instance)) {
    return Object.freeze({
      ...base,
      ...facts,
      kind: 'direct-upgrade',
      declared: direct.range,
      field: direct.field,
      breaking: isBreakingUpgrade(instance.version, target),
    });
  }

  // Forcing a breaking version on a consumer that declared otherwise is what
  // turns a green audit into a broken build.
  if (rejecting.length > 0 && isBreakingUpgrade(instance.version, target)) {
    return Object.freeze({ ...base, ...facts, kind: 'risky', breaking: true });
  }

  const scopeKeys = graph.scopeKeysFor(instance);

  // A nested copy with no attributable declarer cannot be scoped, and a bare
  // override is global — it would land on the hoisted copy instead, forcing a
  // version on consumers this remediation never examined.
  if (!graph.isHoisted(instance) && scopeKeys.length === 0) {
    return Object.freeze({
      ...base,
      kind: 'unresolvable',
      instancePath: instance.path,
      from: instance.version,
      reason:
        `nested copy at ${instance.path} has no attributable declarer; ` +
        'a flat override would hit the hoisted copy instead',
    });
  }

  return Object.freeze({
    ...base,
    ...facts,
    kind: 'override',
    tier: rejecting.length > 0 ? 'tight' : 'safe',
    scopeKeys,
  });
};

export const classifyFinding = (
  finding: Finding,
  graph: DependencyGraph,
  versionsFor: VersionsFor
): readonly Remediation[] => {
  const base = { name: finding.name, severity: finding.severity };

  if (!hasOwnAdvisory(finding)) {
    return [Object.freeze({ ...base, kind: 'inherited', inheritedFrom: finding.inheritedFrom })];
  }

  const instances = graph.instancesOf(finding.name);
  if (instances.length === 0) {
    return [Object.freeze({ ...base, kind: 'absent', reason: 'not present in the lockfile' })];
  }

  // npm reports one finding per package, but only some copies are inside the
  // advisory range. Classifying a copy that is already patched asks for the
  // next escape *above* it, which is the following major, and that gets
  // reported as a breaking upgrade nobody needs.
  //
  // `null` means the range could not be read. Excluding on that would silently
  // drop a real finding, so only a definite `false` is treated as safe.
  const affected = instances.filter(
    (instance) => testRange(instance.version, finding.advisoryRange) !== false
  );
  if (affected.length === 0) {
    return [
      Object.freeze({
        ...base,
        kind: 'absent',
        reason: `no installed copy is within ${String(finding.advisoryRange)}`,
      }),
    ];
  }

  const lookup = versionsFor(finding.name);
  if (!lookup.ok) {
    return [Object.freeze({ ...base, kind: 'unresolvable', reason: lookup.reason })];
  }

  return affected.map((instance) => classifyInstance(finding, instance, graph, lookup.versions));
};

export const classifyAll = (
  findings: readonly Finding[],
  graph: DependencyGraph,
  versionsFor: VersionsFor
): readonly Remediation[] =>
  findings.flatMap((finding) => classifyFinding(finding, graph, versionsFor));
