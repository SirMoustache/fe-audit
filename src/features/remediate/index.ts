import { buildDependencyGraph } from '../../domain/dependency-graph';
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
import type { Registry } from '../../io/npm-client';
import { audit, createRegistry } from '../../io/npm-client';
import { readLockfile, readManifest, saveOverrides } from '../../io/workspace';

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
}

/**
 * Fetching every candidate's published versions up front keeps the classifier
 * pure: it receives a lookup table, never a network call.
 */
export const collectVersions = (
  findings: readonly Finding[],
  registry: Registry
): ReadonlyMap<PackageName, VersionLookup> =>
  new Map(
    [...new Set(findings.filter(hasOwnAdvisory).map((finding) => finding.name))].map((name) => [
      name,
      registry.versionsFor(name),
    ])
  );

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

export const remediateProject = (
  projectDir: string,
  { omitDev = false, includeTight = false, registry }: RemediateOptions = {}
): RemediationResult => {
  const report = audit(projectDir, { omitDev });
  const manifest = readManifest(projectDir);
  const graph = buildDependencyGraph(readLockfile(projectDir), { manifest });
  const findings = readFindings(report);

  const versions = collectVersions(findings, registry ?? createRegistry(projectDir));
  const remediations = classifyAll(
    findings,
    graph,
    (name) => versions.get(name) ?? { ok: false, reason: `no registry data for ${name}` }
  );

  const plan = planOverrides(remediations, {
    includeTight,
    isDirectDependency: (name) => graph.directDependency(name) !== null,
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
  saveOverrides(projectDir, mergeOverrides(readManifest(projectDir).overrides, overrides));
