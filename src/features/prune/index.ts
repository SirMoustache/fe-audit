import { buildDependencyGraph } from '../../domain/dependency-graph';
import type { OverrideTree } from '../../domain/dependency-graph';
import type { OverrideAssessment } from '../../domain/pruning';
import { assessOverridesForPruning, isRemovable, pruneOverrides } from '../../domain/pruning';
import { readDeclarations } from '../../domain/verification';
import type { PackageName, Version } from '../../domain/semver-policy';
import { fetchAdvisories } from '../../io/advisories';
import type { RegistryOptions } from '../../io/registry';
import { createRegistry } from '../../io/registry';
import { readManifest, readLockfile, saveOverrides } from '../../io/workspace';

export interface PruneResult {
  readonly projectDir: string;
  readonly assessments: readonly OverrideAssessment[];
  readonly removable: readonly OverrideAssessment[];
  readonly remaining: OverrideTree;
  readonly declaredCount: number;
}

export interface PruneOptions {
  readonly registryOptions?: RegistryOptions;
}

export const prunableOverrides = async (
  projectDir: string,
  { registryOptions }: PruneOptions = {}
): Promise<PruneResult> => {
  const manifest = readManifest(projectDir);
  const overrides = manifest.overrides ?? {};
  const graph = buildDependencyGraph(readLockfile(projectDir), { manifest });

  const names = [...new Set(readDeclarations(overrides).map((entry) => entry.name))];

  const registry = createRegistry(projectDir, registryOptions);
  const lookups = await registry.fetchAll(names);

  const versions = new Map<PackageName, readonly Version[]>(
    [...lookups.entries()].flatMap(([name, lookup]) =>
      lookup.ok ? [[name, lookup.versions] as const] : []
    )
  );

  // Advisories are keyed by the versions submitted, so every published version
  // has to be offered to see the ranges that matter.
  const { advisories, queried } = await fetchAdvisories(versions);

  const assessments = assessOverridesForPruning({
    graph,
    overrides,
    versions,
    advisories,
    queried,
  });

  return {
    projectDir,
    assessments,
    removable: assessments.filter(isRemovable),
    remaining: pruneOverrides(overrides, assessments),
    declaredCount: readDeclarations(overrides).length,
  };
};

export const applyPruning = (projectDir: string, remaining: OverrideTree): string =>
  saveOverrides(projectDir, remaining);
