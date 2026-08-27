import type { Explanation } from '../../domain/explanation';
import { explainPackage } from '../../domain/explanation';
import type { PackageName } from '../../domain/semver-policy';
import type { AuditStatus } from '../project-context';
import { loadAudit, loadProject } from '../project-context';

export interface ExplainResult extends Explanation {
  readonly projectDir: string;
  readonly auditStatus: AuditStatus;
}

export interface ExplainOptions {
  readonly skipAudit?: boolean;
}

export const explainInProject = (
  projectDir: string,
  name: PackageName,
  { skipAudit = false }: ExplainOptions = {}
): ExplainResult => {
  const project = loadProject(projectDir);
  const { findings, status } = loadAudit(projectDir, { skip: skipAudit });

  return {
    projectDir,
    auditStatus: status,
    ...explainPackage({
      graph: project.graph,
      name,
      overrides: project.overrides,
      findings,
    }),
  };
};
