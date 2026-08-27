import type { DependencyGraph, OverrideTree, PackageInstance } from './dependency-graph';
import { SELF } from './override-set';
import type { PackageName, RangeSpec, Version } from './semver-policy';
import { accepts, isAheadOf, isExactVersion } from './semver-policy';

/**
 * Whether a declared override actually took effect.
 *
 * Divergence from the declared text is not automatically a failure: with mixed
 * flat and scoped overrides npm can legitimately settle on a different but
 * still-patched version. The question that matters is whether the package is
 * still vulnerable, so the audit is the arbiter and the declared text is only a
 * hint.
 */
export type Verdict =
  /** Exact override, honoured, audit clean. */
  | 'pinned'
  /** Range override, honoured, audit clean. */
  | 'range'
  /** Resolved newer than asked — benign. */
  | 'ahead'
  /** Differs, but absent from the audit — benign. */
  | 'diverged'
  /** Still in the audit, and unambiguously this copy. */
  | 'still-vulnerable'
  /** Still in the audit, but several copies exist. */
  | 'still-listed'
  /** Nothing in the tree for it to act on. */
  | 'inert';

export interface Declaration {
  readonly name: PackageName;
  readonly scopeKey: PackageName | null;
  readonly range: RangeSpec;
}

export interface Assessment {
  readonly name: PackageName;
  readonly scopeKey: PackageName | null;
  readonly declared: RangeSpec;
  readonly resolved?: Version;
  readonly instancePath?: string;
  readonly verdict: Verdict;
}

export interface AssessmentInput {
  readonly graph: DependencyGraph;
  readonly overrides: OverrideTree;
  /** `null` when the audit could not be read; the declared text is then all we have. */
  readonly vulnerableNames?: ReadonlySet<PackageName> | null;
}

const isTree = (value: unknown): value is OverrideTree =>
  typeof value === 'object' && value !== null;

/** npm's nested grammar, flattened into one declaration per constraint. */
export const readDeclarations = (overrides: OverrideTree): readonly Declaration[] =>
  Object.entries(overrides ?? {}).flatMap(([key, value]) =>
    isTree(value)
      ? Object.entries(value).map(([child, range]) =>
          child === SELF
            ? { name: key, scopeKey: null, range: range as RangeSpec }
            : { name: child, scopeKey: key, range: range as RangeSpec }
        )
      : [{ name: key, scopeKey: null, range: value }]
  );

const governedKey = (name: PackageName, instancePath: string): string => `${name}@${instancePath}`;

const governedByAnyScope = (
  graph: DependencyGraph,
  declarations: readonly Declaration[]
): ReadonlySet<string> =>
  new Set(
    declarations
      .filter((declaration) => declaration.scopeKey !== null)
      .flatMap((declaration) =>
        [...graph.instancesGovernedBy(declaration.scopeKey as PackageName, declaration.name)].map(
          (instancePath) => governedKey(declaration.name, instancePath)
        )
      )
  );

const instancesUnder = (
  graph: DependencyGraph,
  declaration: Declaration,
  governed: ReadonlySet<string>
): readonly PackageInstance[] => {
  const instances = graph.instancesOf(declaration.name);
  if (declaration.scopeKey === null) {
    return instances.filter(
      (instance) => !governed.has(governedKey(declaration.name, instance.path))
    );
  }
  const scoped = graph.instancesGovernedBy(declaration.scopeKey, declaration.name);
  return instances.filter((instance) => scoped.has(instance.path));
};

/**
 * The audit is consulted whether or not the resolved copy matches the declared
 * text. An override can be honoured to the letter and still leave the package
 * vulnerable — the advisory may have widened since the version was chosen.
 *
 * With several copies present the audit cannot say which one it means, so that
 * case is surfaced loudly rather than failing the build on a guess.
 */
const verdictFor = (
  declaration: Declaration,
  instance: PackageInstance,
  vulnerableNames: ReadonlySet<PackageName> | null,
  copyCount: number
): Verdict => {
  const stillListed = vulnerableNames === null || vulnerableNames.has(declaration.name);
  const honoured = accepts(declaration.range, instance.version);

  if (honoured && !stillListed) return isExactVersion(declaration.range) ? 'pinned' : 'range';
  if (honoured) return copyCount === 1 ? 'still-vulnerable' : 'still-listed';
  if (isAheadOf(instance.version, declaration.range)) return 'ahead';
  return stillListed ? 'still-vulnerable' : 'diverged';
};

export const assessOverrides = ({
  graph,
  overrides,
  vulnerableNames = null,
}: AssessmentInput): readonly Assessment[] => {
  const declarations = readDeclarations(overrides);
  const governed = governedByAnyScope(graph, declarations);

  return declarations.flatMap((declaration): readonly Assessment[] => {
    const instances = instancesUnder(graph, declaration, governed);
    if (instances.length === 0) {
      return [
        Object.freeze({
          name: declaration.name,
          scopeKey: declaration.scopeKey,
          declared: declaration.range,
          verdict: 'inert' as const,
        }),
      ];
    }

    const copyCount = graph.instancesOf(declaration.name).length;
    return instances.map((instance) =>
      Object.freeze({
        name: declaration.name,
        scopeKey: declaration.scopeKey,
        declared: declaration.range,
        resolved: instance.version,
        instancePath: instance.path,
        verdict: verdictFor(declaration, instance, vulnerableNames, copyCount),
      })
    );
  });
};

export const isFailure = (assessment: Assessment): boolean =>
  assessment.verdict === 'still-vulnerable';
