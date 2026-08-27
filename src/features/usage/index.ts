import { buildDependencyGraph } from '../../domain/dependency-graph';
import type { Lockfile, Manifest } from '../../domain/dependency-graph';
import { readFindings } from '../../domain/finding';
import type { PackageName } from '../../domain/semver-policy';
import type { DeclaredDependency, UsageReport } from '../../domain/usage';
import { analyseUsage } from '../../domain/usage';
import { audit } from '../../io/npm-client';
import { scanProject } from '../../io/source-scanner';
import { readLockfile, readManifest } from '../../io/workspace';

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
    const names =
      typeof entry.bin === 'string' ? [match[1] as string] : Object.keys(entry.bin);
    bins.set(match[1] as PackageName, names);
  }
  return bins;
};

export interface UsageResult extends UsageReport {
  readonly projectDir: string;
  readonly auditStatus: 'ok' | 'skipped' | 'unavailable';
}

export interface UsageOptions {
  readonly skipAudit?: boolean;
}

export const analyseProjectUsage = (
  projectDir: string,
  { skipAudit = false }: UsageOptions = {}
): UsageResult => {
  const manifest = readManifest(projectDir);
  const lockfile = readLockfile(projectDir);
  const graph = buildDependencyGraph(lockfile, { manifest });
  const scanned = scanProject(projectDir);

  const findings = skipAudit
    ? null
    : (() => {
        try {
          return readFindings(audit(projectDir));
        } catch {
          return null;
        }
      })();

  const report = analyseUsage({
    graph,
    declared: declaredIn(manifest),
    imports: scanned.imports,
    configText: scanned.configText,
    scripts: manifest.scripts ?? {},
    overrides: manifest.overrides ?? {},
    findings: findings ?? [],
    binNames: binNamesFrom(lockfile),
  });

  return {
    ...report,
    sourceFileCount: scanned.sourceFileCount,
    projectDir,
    auditStatus: skipAudit ? 'skipped' : findings === null ? 'unavailable' : 'ok',
  };
};
