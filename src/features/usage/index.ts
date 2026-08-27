import type { Lockfile, Manifest } from '../../domain/dependency-graph';
import type { PackageName } from '../../domain/semver-policy';
import type { DeclaredDependency, UsageReport } from '../../domain/usage';
import { analyseUsage } from '../../domain/usage';
import { scanProject } from '../../infrastructure/source-scanner';
import type { AuditStatus } from '../project-context';
import { loadAudit, loadProject } from '../project-context';

const DECLARATION_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

const declaredIn = (manifest: Manifest): readonly DeclaredDependency[] =>
  DECLARATION_FIELDS.flatMap((field) =>
    Object.entries(manifest[field] ?? {}).map(([name, range]) => ({ name, field, range }))
  );

/**
 * A script usually invokes a package by its binary rather than its name, so
 * `"lint": "eslint ."` is only recognisable if we know eslint ships `eslint`.
 */
const binNamesFrom = (lockfile: Lockfile): ReadonlyMap<PackageName, readonly string[]> => {
  const bins = new Map<PackageName, readonly string[]>();
  for (const [installPath, entry] of Object.entries(lockfile.packages ?? {})) {
    const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(installPath);
    if (!match || !entry.bin) continue;
    const names = typeof entry.bin === 'string' ? [match[1] as string] : Object.keys(entry.bin);
    bins.set(match[1] as PackageName, names);
  }
  return bins;
};

export interface UsageResult extends UsageReport {
  readonly projectDir: string;
  readonly sourceFileCount: number;
  readonly auditStatus: AuditStatus;
}

export interface UsageOptions {
  readonly skipAudit?: boolean;
}

export const analyseProjectUsage = (
  projectDir: string,
  { skipAudit = false }: UsageOptions = {}
): UsageResult => {
  const project = loadProject(projectDir);
  const scanned = scanProject(projectDir);
  const { findings, status } = loadAudit(projectDir, { skip: skipAudit });

  const report = analyseUsage({
    graph: project.graph,
    declared: declaredIn(project.manifest),
    imports: scanned.imports,
    configText: scanned.configText,
    scripts: project.manifest.scripts ?? {},
    overrides: project.overrides,
    findings,
    binNames: binNamesFrom(project.lockfile),
  });

  return {
    ...report,
    projectDir,
    sourceFileCount: scanned.sourceFileCount,
    auditStatus: status,
  };
};
