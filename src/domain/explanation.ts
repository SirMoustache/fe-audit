import type { DependencyGraph, OverrideTree, PackageInstance } from './dependency-graph';
import type { Finding, Severity } from './finding';
import { readDeclarations } from './override-set';
import type { PackageName, RangeSpec, Version } from './semver-policy';
import { accepts, isBreakingUpgrade, isExpressible, rangeFloor } from './semver-policy';

export interface ConsumerVerdict {
  readonly name: PackageName | '<root project>';
  readonly version: Version | undefined;
  readonly range: RangeSpec;
  readonly field: string;
  readonly accepts: boolean;
  /** A `file:`/`git:`/`workspace:` range carries no comparable constraint. */
  readonly expressible: boolean;
}

export interface InstanceExplanation {
  readonly path: string;
  readonly version: Version;
  readonly hoisted: boolean;
  readonly consumers: readonly ConsumerVerdict[];
  readonly rejecting: readonly ConsumerVerdict[];
  /** Set when an override forced a version some consumer had declared against. */
  readonly forcedBreaking: boolean;
}

export interface OverrideExplanation {
  readonly declared: RangeSpec;
  readonly scopeKey: PackageName | null;
}

export interface AdvisoryExplanation {
  readonly severity: Severity;
  readonly range: RangeSpec;
  readonly titles: readonly string[];
  readonly ownFlaw: boolean;
}

export interface Explanation {
  readonly name: PackageName;
  readonly present: boolean;
  readonly direct: { readonly field: string; readonly range: RangeSpec } | null;
  readonly production: boolean;
  readonly instances: readonly InstanceExplanation[];
  readonly overrides: readonly OverrideExplanation[];
  readonly advisory: AdvisoryExplanation | null;
}

export interface ExplainInput {
  readonly graph: DependencyGraph;
  readonly name: PackageName;
  readonly overrides?: OverrideTree;
  readonly findings?: readonly Finding[];
}

const toConsumerVerdict = (
  consumer: { declarerName: PackageName | null; declarerVersion?: Version; range: RangeSpec; field: string },
  version: Version
): ConsumerVerdict => ({
  name: consumer.declarerName ?? '<root project>',
  version: consumer.declarerVersion,
  range: consumer.range,
  field: consumer.field,
  accepts: accepts(consumer.range, version),
  expressible: isExpressible(consumer.range),
});

const overridesFor = (overrides: OverrideTree, name: PackageName): readonly OverrideExplanation[] =>
  readDeclarations(overrides)
    .filter((declaration) => declaration.name === name)
    .map((declaration) => ({ declared: declaration.range, scopeKey: declaration.scopeKey }));

const explainInstance = (
  graph: DependencyGraph,
  instance: PackageInstance,
  overridden: boolean
): InstanceExplanation => {
  const consumers = graph
    .consumersOfInstance(instance)
    .map((consumer) => toConsumerVerdict(consumer, instance.version));
  const rejecting = consumers.filter((consumer) => !consumer.accepts);

  // An override is the only way a copy ends up at a version its own consumers
  // declared against, so a rejection here is evidence of a forced upgrade.
  const forcedBreaking =
    overridden &&
    rejecting.some((consumer) => {
      const floor = rangeFloor(consumer.range);
      return floor !== null && isBreakingUpgrade(floor, instance.version);
    });

  return {
    path: instance.path,
    version: instance.version,
    hoisted: graph.isHoisted(instance),
    consumers,
    rejecting,
    forcedBreaking,
  };
};

/**
 * Everything known about one package: which copies exist, who asked for them,
 * whether any declared range is being overridden, and whether it can reach
 * shipped code.
 *
 * This exists because working that out by hand takes half a dozen queries
 * against the lockfile, and the answer decides whether a RISKY verdict is worth
 * overriding or worth living with.
 */
export const explainPackage = ({
  graph,
  name,
  overrides = {},
  findings = [],
}: ExplainInput): Explanation => {
  const instances = graph.instancesOf(name);
  const declared = overridesFor(overrides, name);
  const finding = findings.find((candidate) => candidate.name === name);

  return {
    name,
    present: instances.length > 0,
    direct: graph.directDependency(name),
    production: graph.productionNames().has(name),
    instances: instances.map((instance) => explainInstance(graph, instance, declared.length > 0)),
    overrides: declared,
    advisory: finding
      ? {
          severity: finding.severity,
          range: finding.advisoryRange,
          titles: finding.advisories,
          ownFlaw: finding.advisories.length > 0,
        }
      : null,
  };
};

export const hasForcedBreaking = (explanation: Explanation): boolean =>
  explanation.instances.some((instance) => instance.forcedBreaking);
