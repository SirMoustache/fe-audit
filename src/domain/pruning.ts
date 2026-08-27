import semver from 'semver';
import type { DependencyGraph, OverrideTree, PackageInstance } from './dependency-graph';
import { readDeclarations } from './verification';
import type { PackageName, RangeSpec, Version } from './semver-policy';
import { accepts, isBreakingUpgrade, isExpressible, isStable } from './semver-policy';

export interface AdvisoryRange {
  readonly title: string;
  readonly severity: string;
  readonly vulnerableRange: RangeSpec;
}

/** Whether an override is still earning its place. */
export type PruneVerdict =
  /** Without it the package would be vulnerable. Keep. */
  | 'needed'
  /** npm would resolve to something safe anyway. Delete. */
  | 'redundant'
  /** It forces a lower version than npm would pick, for no security gain. Delete. */
  | 'harmful'
  /** The version it forces is itself still vulnerable. Fix or remove. */
  | 'ineffective'
  /** Nothing in the tree for it to act on. Delete. */
  | 'inert'
  /** Not enough information to judge. */
  | 'unknown';

export interface OverrideAssessment {
  readonly name: PackageName;
  readonly scopeKey: PackageName | null;
  readonly declared: RangeSpec;
  readonly verdict: PruneVerdict;
  readonly installed: Version | null;
  /** What npm would resolve to if the override were removed. */
  readonly natural: Version | null;
  readonly reason: string;
  readonly breaking: boolean;
}

export interface PruneInput {
  readonly graph: DependencyGraph;
  readonly overrides: OverrideTree;
  readonly versions: ReadonlyMap<PackageName, readonly Version[]>;
  readonly advisories: ReadonlyMap<PackageName, readonly AdvisoryRange[]>;
  /** Packages the advisory service actually answered for. */
  readonly queried: ReadonlySet<PackageName>;
}

const isVulnerable = (
  version: Version | null,
  advisories: readonly AdvisoryRange[]
): boolean =>
  version !== null &&
  advisories.some((advisory) => accepts(advisory.vulnerableRange, version));

/**
 * What npm would settle on without the override, from two angles.
 *
 * `optimistic` is the best any consumer could get. If even that is vulnerable,
 * the override is doing real work.
 *
 * `consensus` is the highest version every consumer accepts. Only that supports
 * a claim that the override is holding the project back, because a version one
 * consumer rejects is not something npm would quietly hand it.
 */
interface NaturalVersions {
  readonly optimistic: Version | null;
  readonly consensus: Version | null;
}

const naturalVersions = (
  graph: DependencyGraph,
  instance: PackageInstance,
  published: readonly Version[]
): NaturalVersions => {
  const ranges = graph
    .consumersOfInstance(instance)
    .map((consumer) => consumer.range)
    .filter(isExpressible);

  // Prereleases are never chosen by a plain range, so offering one as the
  // natural resolution would be wrong.
  const stable = published.filter(isStable);
  if (ranges.length === 0 || stable.length === 0) return { optimistic: null, consensus: null };

  const perConsumer = ranges
    .map((range) => semver.maxSatisfying([...stable], range, { loose: true }))
    .filter((version): version is Version => version !== null);

  const acceptedByAll = stable.filter((version) =>
    ranges.every((range) => accepts(range, version))
  );

  return {
    optimistic: perConsumer.length === 0 ? null : (perConsumer.sort(semver.rcompare)[0] ?? null),
    consensus:
      acceptedByAll.length === 0 ? null : (acceptedByAll.sort(semver.rcompare)[0] ?? null),
  };
};

const assessInstance = (
  declaration: { name: PackageName; scopeKey: PackageName | null; range: RangeSpec },
  instance: PackageInstance,
  input: PruneInput
): OverrideAssessment => {
  const advisories = input.advisories.get(declaration.name) ?? [];
  const published = input.versions.get(declaration.name) ?? [];
  const { optimistic, consensus } = naturalVersions(input.graph, instance, published);

  const base = {
    name: declaration.name,
    scopeKey: declaration.scopeKey,
    declared: declaration.range,
    installed: instance.version,
    natural: consensus ?? optimistic,
    breaking:
      consensus !== null && semver.valid(consensus) && semver.valid(instance.version)
        ? isBreakingUpgrade(consensus, instance.version)
        : false,
  };

  if (isVulnerable(instance.version, advisories)) {
    return {
      ...base,
      verdict: 'ineffective',
      reason: `${instance.version} is still within an advisory range`,
    };
  }

  // Missing advisory data must never read as "nothing to worry about" — that
  // would turn a network failure into a recommendation to delete every override.
  if (!input.queried.has(declaration.name)) {
    return { ...base, verdict: 'unknown', reason: 'advisory data unavailable for this package' };
  }

  if (advisories.length === 0) {
    return { ...base, verdict: 'redundant', reason: 'no known advisory affects this package' };
  }

  // With a consensus version npm installs exactly that, so it is the version
  // that decides whether the override is still doing anything.
  if (consensus !== null) {
    if (isVulnerable(consensus, advisories)) {
      return {
        ...base,
        verdict: 'needed',
        reason: `without it npm would resolve ${consensus}, which is vulnerable`,
      };
    }
    if (semver.valid(instance.version) && semver.lt(instance.version, consensus)) {
      return {
        ...base,
        verdict: 'harmful',
        reason: `every consumer accepts ${consensus}, which is safe; this pins the older ${instance.version}`,
      };
    }
    return {
      ...base,
      verdict: 'redundant',
      reason: `every consumer accepts ${consensus}, which is already safe`,
    };
  }

  // No consensus: npm would nest copies. If even the most favourable of those
  // is vulnerable the override is certainly needed; otherwise it is too tangled
  // to call.
  if (optimistic === null) {
    return { ...base, verdict: 'unknown', reason: 'cannot determine what npm would resolve to' };
  }
  if (isVulnerable(optimistic, advisories)) {
    return {
      ...base,
      verdict: 'needed',
      reason: `without it npm would resolve ${optimistic}, which is vulnerable`,
    };
  }
  return {
    ...base,
    verdict: 'unknown',
    reason: 'consumers declare incompatible ranges, so npm would nest copies',
  };
};

/**
 * Which overrides can be deleted.
 *
 * Overrides are pins, and pins go stale. Once an upstream fix lands, the
 * override stops protecting anything and starts holding a package back — in the
 * worst case pinning a version below what the project would otherwise get.
 */
export const assessOverridesForPruning = (input: PruneInput): readonly OverrideAssessment[] =>
  readDeclarations(input.overrides).flatMap((declaration): readonly OverrideAssessment[] => {
    const instances =
      declaration.scopeKey === null
        ? input.graph.instancesOf(declaration.name)
        : input.graph
            .instancesOf(declaration.name)
            .filter((instance) =>
              input.graph
                .instancesGovernedBy(declaration.scopeKey as PackageName, declaration.name)
                .has(instance.path)
            );

    if (instances.length === 0) {
      return [
        {
          name: declaration.name,
          scopeKey: declaration.scopeKey,
          declared: declaration.range,
          verdict: 'inert',
          installed: null,
          natural: null,
          breaking: false,
          reason: 'nothing in the tree matches this override',
        },
      ];
    }

    return instances.map((instance) => assessInstance(declaration, instance, input));
  });

const REMOVABLE = new Set<PruneVerdict>(['redundant', 'harmful', 'inert']);

export const isRemovable = (assessment: OverrideAssessment): boolean =>
  REMOVABLE.has(assessment.verdict);

/** Overrides that survive pruning, in the shape npm expects. */
export const pruneOverrides = (
  overrides: OverrideTree,
  assessments: readonly OverrideAssessment[]
): OverrideTree => {
  const removable = new Set(
    assessments
      .filter(isRemovable)
      // A name is only safe to drop when every copy of it agrees.
      .filter((assessment) =>
        assessments
          .filter((other) => other.name === assessment.name && other.scopeKey === assessment.scopeKey)
          .every(isRemovable)
      )
      .map((assessment) => `${assessment.scopeKey ?? ''}\u0000${assessment.name}`)
  );

  const keep = (scopeKey: string | null, name: string): boolean =>
    !removable.has(`${scopeKey ?? ''}\u0000${name}`);

  const result: Record<string, RangeSpec | Record<string, RangeSpec>> = {};

  for (const [key, value] of Object.entries(overrides)) {
    if (value === null || typeof value !== 'object') {
      if (keep(null, key)) result[key] = value as RangeSpec;
      continue;
    }
    const children = Object.entries(value).filter(([child]) =>
      child === '.' ? keep(null, key) : keep(key, child)
    );
    if (children.length > 0) result[key] = Object.fromEntries(children) as Record<string, RangeSpec>;
  }

  return result as OverrideTree;
};
