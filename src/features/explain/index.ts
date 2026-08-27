import { buildDependencyGraph } from '../../domain/dependency-graph';
import type { Explanation } from '../../domain/explanation';
import { explainPackage } from '../../domain/explanation';
import { readFindings } from '../../domain/finding';
import type { PackageName } from '../../domain/semver-policy';
import { audit } from '../../io/npm-client';
import { readLockfile, readManifest } from '../../io/workspace';

export interface ExplainResult extends Explanation {
  readonly projectDir: string;
  /** How advisory context was obtained, so the view never implies a failure. */
  readonly auditStatus: 'ok' | 'skipped' | 'unavailable';
}

export interface ExplainOptions {
  readonly skipAudit?: boolean;
}

export const explainInProject = (
  projectDir: string,
  name: PackageName,
  { skipAudit = false }: ExplainOptions = {}
): ExplainResult => {
  const manifest = readManifest(projectDir);
  const graph = buildDependencyGraph(readLockfile(projectDir), { manifest });

  // Advisory context is useful but not essential; a project that cannot be
  // audited can still be explained from its lockfile alone.
  const findings = skipAudit
    ? null
    : (() => {
        try {
          return readFindings(audit(projectDir));
        } catch {
          return null;
        }
      })();

  return {
    projectDir,
    auditStatus: skipAudit ? 'skipped' : findings === null ? 'unavailable' : 'ok',
    ...explainPackage({
      graph,
      name,
      overrides: manifest.overrides ?? {},
      findings: findings ?? [],
    }),
  };
};
