import type { OverrideTree } from '../../domain/dependency-graph';
import type { AuditTotals, Finding } from '../../domain/finding';
import { hasOwnAdvisory, readFindings, readTotals } from '../../domain/finding';
import type { OverrideConflict } from '../../domain/override-set';
import { mergeOverrides, planOverrides } from '../../domain/override-set';
import type {
  DirectUpgradeRemedy,
  InheritedRemedy,
  OverrideRemedy,
  Remediation,
  RiskyRemedy,
  VersionLookup,
} from '../../domain/remediation';
import {
  classifyAll,
  isDirectUpgrade,
  isInherited,
  isRisky,
  isScoped,
  isTier,
  needsReview,
} from '../../domain/remediation';
import type { PackageName } from '../../domain/semver-policy';
import { audit } from '../../infrastructure/npm-client';
import type { Registry, RegistryOptions } from '../../infrastructure/registry';
import { createRegistry } from '../../infrastructure/registry';
import { saveOverrides } from '../../infrastructure/workspace';
import { loadProject } from '../project-context';

export interface RemediationGroups {
  readonly safe: readonly OverrideRemedy[];
  readonly scoped: readonly OverrideRemedy[];
  readonly tight: readonly OverrideRemedy[];
  readonly risky: readonly RiskyRemedy[];
  readonly direct: readonly DirectUpgradeRemedy[];
  readonly inherited: readonly InheritedRemedy[];
  readonly unresolved: readonly Remediation[];
}

export interface RemediationResult {
  readonly projectDir: string;
  readonly totals: AuditTotals;
  readonly includeTight: boolean;
  readonly remediations: readonly Remediation[];
  readonly groups: RemediationGroups;
  readonly overrides: OverrideTree;
  readonly conflicts: readonly OverrideConflict[];
}

export interface RemediateOptions {
  readonly omitDev?: boolean;
  readonly includeTight?: boolean;
  readonly registry?: Registry;
  readonly registryOptions?: RegistryOptions;
}

/**
 * Fetching every candidate's published versions up front keeps the classifier
 * pure: it receives a lookup table, never a network call. It is also the only
 * slow part of a run, so it is the part worth doing concurrently.
 */
export const collectVersions = async (
  findings: readonly Finding[],
  registry: Registry
): Promise<ReadonlyMap<PackageName, VersionLookup>> =>
  registry.fetchAll([...new Set(findings.filter(hasOwnAdvisory).map((finding) => finding.name))]);

export const groupRemediations = (
  remediations: readonly Remediation[]
): RemediationGroups => {
  const safeTier = remediations.filter(isTier('safe'));
  return {
    safe: safeTier.filter((remedy) => !isScoped(remedy)),
    scoped: safeTier.filter(isScoped),
    tight: remediations.filter(isTier('tight')),
    risky: remediations.filter(isRisky),
    direct: remediations.filter(isDirectUpgrade),
    inherited: remediations.filter(isInherited),
    unresolved: remediations.filter(needsReview),
  };
};

export const remediateProject = async (
  projectDir: string,
  { omitDev = false, includeTight = false, registry, registryOptions }: RemediateOptions = {}
): Promise<RemediationResult> => {
  const report = audit(projectDir, { omitDev });
  const project = loadProject(projectDir);
  const findings = readFindings(report);

  const versions = await collectVersions(
    findings,
    registry ?? createRegistry(projectDir, registryOptions)
  );

  const remediations = classifyAll(
    findings,
    project.graph,
    (name) => versions.get(name) ?? { ok: false, reason: `no registry data for ${name}` }
  );

  const plan = planOverrides(remediations, {
    includeTight,
    isDirectDependency: (name) => project.graph.directDependency(name) !== null,
  });

  return {
    projectDir,
    totals: readTotals(report),
    includeTight,
    remediations,
    groups: groupRemediations(remediations),
    overrides: plan.overrides,
    conflicts: plan.conflicts,
  };
};

export const applyOverrides = (projectDir: string, overrides: OverrideTree): string =>
  saveOverrides(projectDir, mergeOverrides(loadProject(projectDir).overrides, overrides));
