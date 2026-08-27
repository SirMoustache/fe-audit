import type { PackageName, RangeSpec } from './semver-policy';
import { accepts } from './semver-policy';

/**
 * A published security advisory.
 *
 * Owned by the domain rather than by the client that fetches it, so a change to
 * npm's wire format cannot silently reshape what the rules reason about.
 */
export interface Advisory {
  readonly title: string;
  readonly severity: string;
  readonly vulnerableRange: RangeSpec;
}

export type AdvisoryIndex = ReadonlyMap<PackageName, readonly Advisory[]>;

/**
 * What is known about a set of packages.
 *
 * `queried` is not decoration: a package the service never answered for is not
 * the same as a package with no advisories, and treating the two alike would
 * turn a network failure into "safe to delete".
 */
export interface AdvisoryKnowledge {
  readonly advisories: AdvisoryIndex;
  readonly queried: ReadonlySet<PackageName>;
}

export const advisoriesFor = (
  knowledge: AdvisoryKnowledge,
  name: PackageName
): readonly Advisory[] => knowledge.advisories.get(name) ?? [];

export const wasQueried = (knowledge: AdvisoryKnowledge, name: PackageName): boolean =>
  knowledge.queried.has(name);

export const isVulnerable = (
  version: string | null,
  advisories: readonly Advisory[]
): boolean =>
  version !== null && advisories.some((advisory) => accepts(advisory.vulnerableRange, version));

export const emptyKnowledge = (): AdvisoryKnowledge => ({
  advisories: new Map(),
  queried: new Set(),
});
