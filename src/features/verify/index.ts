import { vulnerablePackageNames } from '../../domain/finding';
import type { PackageName } from '../../domain/semver-policy';
import type { Assessment } from '../../domain/verification';
import { assessOverrides, isFailure } from '../../domain/verification';
import { audit } from '../../infrastructure/npm-client';
import { loadProject } from '../project-context';

export interface VerificationResult {
  readonly projectDir: string;
  readonly assessments: readonly Assessment[];
  readonly failures: readonly Assessment[];
  readonly listed: readonly Assessment[];
  readonly diverged: readonly Assessment[];
}

/** The audit is the arbiter; without it we can only compare declared text. */
const readVulnerableNames = (projectDir: string): ReadonlySet<PackageName> | null => {
  try {
    return vulnerablePackageNames(audit(projectDir));
  } catch {
    return null;
  }
};

export interface VerifyOptions {
  readonly vulnerableNames?: ReadonlySet<PackageName> | null;
}

export const verifyProject = (
  projectDir: string,
  { vulnerableNames }: VerifyOptions = {}
): VerificationResult => {
  const project = loadProject(projectDir);

  const assessments = assessOverrides({
    graph: project.graph,
    overrides: project.overrides,
    vulnerableNames:
      vulnerableNames === undefined ? readVulnerableNames(projectDir) : vulnerableNames,
  });

  return {
    projectDir,
    assessments,
    failures: assessments.filter(isFailure),
    listed: assessments.filter((assessment) => assessment.verdict === 'still-listed'),
    diverged: assessments.filter((assessment) => assessment.verdict === 'diverged'),
  };
};
