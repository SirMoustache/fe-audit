import type { OverrideTree } from '../../domain/dependency-graph';
import { readDeclarations } from '../../domain/override-set';
import type { OverrideAssessment } from '../../domain/pruning';
import { assessOverridesForPruning, isRemovable, pruneOverrides } from '../../domain/pruning';
import type { PackageName, Version } from '../../domain/semver-policy';
import { fetchAdvisories } from '../../infrastructure/advisories';
import type { RegistryOptions } from '../../infrastructure/registry';
import { createRegistry } from '../../infrastructure/registry';
import { saveOverrides } from '../../infrastructure/workspace';
import { loadProject } from '../project-context';

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
  const project = loadProject(projectDir);
  const declarations = readDeclarations(project.overrides);
  const names = [...new Set(declarations.map((entry) => entry.name))];

  const lookups = await createRegistry(projectDir, registryOptions).fetchAll(names);
  const versions = new Map<PackageName, readonly Version[]>(
    [...lookups.entries()].flatMap(([name, lookup]) =>
      lookup.ok ? [[name, lookup.versions] as const] : []
    )
  );

  // Advisories are keyed by the versions submitted, so every published version
  // has to be offered to see the ranges that matter.
  const knowledge = await fetchAdvisories(versions);

  const assessments = assessOverridesForPruning({
    graph: project.graph,
    overrides: project.overrides,
    versions,
    knowledge,
  });

  return {
    projectDir,
    assessments,
    removable: assessments.filter(isRemovable),
    remaining: pruneOverrides(project.overrides, assessments),
    declaredCount: declarations.length,
  };
};

export const applyPruning = (projectDir: string, remaining: OverrideTree): string =>
  saveOverrides(projectDir, remaining);
