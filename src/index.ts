/**
 * Programmatic entry point. The domain is pure and dependency-free, so it can be
 * driven from a custom pipeline without going through the CLI.
 */
export * from './domain/semver-policy';
export * from './domain/dependency-graph';
export * from './domain/finding';
export * from './domain/remediation';
export * from './domain/override-set';
export * from './domain/verification';
export * from './domain/project-health';

export { surveyWorkspace } from './features/survey';
export { remediateProject, applyOverrides, groupRemediations } from './features/remediate';
export { verifyProject } from './features/verify';
