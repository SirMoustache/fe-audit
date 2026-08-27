import type { OverrideTree } from './dependency-graph';
import type { Severity } from './finding';
import type { OverrideRemedy, Remediation } from './remediation';
import { isOverride } from './remediation';
import type { PackageName, RangeSpec, Version } from './semver-policy';

export const SELF = '.';

const TARGET_SEPARATOR = '\u0000';

type MutableOverrideTree = { [key: string]: RangeSpec | MutableOverrideTree };

interface Placement {
  readonly key: PackageName;
  /** `null` means a top-level override; otherwise the child being scoped. */
  readonly child: PackageName | null;
  readonly version: Version;
  readonly remedy: OverrideRemedy;
}

export interface OverrideConflict {
  readonly key: PackageName;
  readonly child: PackageName | null;
  readonly name: PackageName;
  readonly severity: Severity;
  readonly candidates: readonly Version[];
  readonly reason: string;
}

export interface OverridePlan {
  readonly overrides: OverrideTree;
  readonly conflicts: readonly OverrideConflict[];
}

export interface PlanOptions {
  /**
   * Tight overrides are opt-in. A consumer that pins an exact version sometimes
   * did so because the next patch broke it, so forcing one is the same category
   * of move the tool exists to refuse — just a smaller one.
   */
  readonly includeTight?: boolean;
  readonly isDirectDependency?: (name: PackageName) => boolean;
}

const isTree = (value: RangeSpec | OverrideTree | undefined): value is OverrideTree =>
  typeof value === 'object' && value !== null;

const applicable =
  (includeTight: boolean) =>
  (remedy: Remediation): remedy is OverrideRemedy =>
    isOverride(remedy) && (includeTight || remedy.tier === 'safe');

/**
 * npm's override grammar has two shapes: a bare version applies everywhere, and
 * a nested object scopes children of a named package.
 */
const placementsOf = (remedy: OverrideRemedy): readonly Placement[] =>
  remedy.scopeKeys.length === 0
    ? [{ key: remedy.overrideName, child: null, version: remedy.to, remedy }]
    : remedy.scopeKeys.map((key) => ({
        key,
        child: remedy.overrideName,
        version: remedy.to,
        remedy,
      }));

const targetOf = (placement: Placement): string =>
  placement.key + TARGET_SEPARATOR + (placement.child ?? SELF);

/**
 * A package needing both a version of its own and a scope for its children
 * expresses the former under the "." key, so the shapes must merge rather than
 * one clobbering the other.
 */
const place = (draft: MutableOverrideTree, placement: Placement): MutableOverrideTree => {
  const { key, child, version } = placement;
  const existing = draft[key];

  if (child === null) {
    return { ...draft, [key]: isTree(existing) ? { ...existing, [SELF]: version } : version };
  }

  const nested: MutableOverrideTree = isTree(existing)
    ? { ...(existing as MutableOverrideTree) }
    : existing === undefined
      ? {}
      : { [SELF]: existing };

  return { ...draft, [key]: { ...nested, [child]: version } };
};

const groupByTarget = (placements: readonly Placement[]): Map<string, Placement[]> =>
  placements.reduce((map, placement) => {
    const target = targetOf(placement);
    return map.set(target, [...(map.get(target) ?? []), placement]);
  }, new Map<string, Placement[]>());

const describeContested = (group: readonly Placement[]): OverrideConflict => {
  const [first] = group as [Placement, ...Placement[]];
  return Object.freeze({
    key: first.key,
    child: first.child,
    name: first.remedy.name,
    severity: first.remedy.severity,
    candidates: [...new Set(group.map((placement) => placement.version))].sort(),
    reason:
      `two copies of "${first.key}" need different versions of ` +
      `"${first.child ?? first.key}"; npm cannot express both`,
  });
};

const describeDirectClash = (placement: Placement): OverrideConflict =>
  Object.freeze({
    key: placement.key,
    child: null,
    name: placement.remedy.name,
    severity: placement.remedy.severity,
    candidates: [placement.version],
    reason:
      `npm rejects a top-level override for the direct dependency "${placement.key}" ` +
      '(EOVERRIDE); upgrade it in package.json instead',
  });

/**
 * npm scopes an override by parent NAME, so `{ glob: { minimatch } }` governs
 * every minimatch under every glob. When two copies of that parent need
 * different targets the grammar cannot express both, and quietly keeping one
 * would force a version onto the other copy's consumers.
 *
 * A top-level override naming a direct dependency is withheld for a different
 * reason: npm refuses the whole install with EOVERRIDE. Classification already
 * routes those to `direct-upgrade`, so this is a backstop that keeps the rule
 * true no matter how classification changes.
 */
export const planOverrides = (
  remediations: readonly Remediation[],
  { includeTight = false, isDirectDependency = () => false }: PlanOptions = {}
): OverridePlan => {
  const placements = remediations.filter(applicable(includeTight)).flatMap(placementsOf);

  const directClashes = placements.filter(
    (placement) => placement.child === null && isDirectDependency(placement.key)
  );
  const contested = [...groupByTarget(placements).values()].filter(
    (group) => new Set(group.map((placement) => placement.version)).size > 1
  );

  const withheld = new Set([
    ...contested.map((group) => targetOf(group[0] as Placement)),
    ...directClashes.map(targetOf),
  ]);

  return {
    overrides: placements
      .filter((placement) => !withheld.has(targetOf(placement)))
      .reduce<MutableOverrideTree>(place, {}),
    conflicts: [...contested.map(describeContested), ...directClashes.map(describeDirectClash)],
  };
};

const sortTree = (tree: OverrideTree): OverrideTree =>
  Object.keys(tree)
    .sort()
    .reduce<MutableOverrideTree>((sorted, key) => {
      const value = tree[key];
      sorted[key] = isTree(value) ? sortTree(value) : (value as RangeSpec);
      return sorted;
    }, {});

const mergeEntry = (
  existing: RangeSpec | OverrideTree | undefined,
  addition: RangeSpec | OverrideTree
): RangeSpec | OverrideTree => {
  if (isTree(existing) && isTree(addition)) return { ...existing, ...addition };
  if (isTree(existing)) return { ...existing, [SELF]: addition as RangeSpec };
  if (isTree(addition) && existing !== undefined) return { [SELF]: existing, ...addition };
  return addition;
};

/** Re-runs are the norm, so merging must never discard a hand-authored scope. */
export const mergeOverrides = (
  existing: OverrideTree | undefined,
  addition: OverrideTree
): OverrideTree => {
  const base: MutableOverrideTree = { ...(existing ?? {}) };
  for (const key of Object.keys(addition)) {
    base[key] = mergeEntry(base[key], addition[key] as RangeSpec | OverrideTree);
  }
  return sortTree(base);
};
