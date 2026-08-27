/** A manifest snapshot, in the shape the health rules reason about. */
export interface ProjectSnapshot {
  readonly dir: string;
  readonly name?: string;
  readonly packageManager: string | null;
  readonly hasOverrides: boolean;
  readonly hasResolutions: boolean;
  readonly hasNpmLock: boolean;
  readonly hasYarnLock: boolean;
  readonly lockfileVersion: number | null;
}

export interface AssessedProject extends ProjectSnapshot {
  readonly blockers: readonly string[];
}

interface HealthRule {
  readonly id: string;
  readonly applies: (project: ProjectSnapshot) => boolean;
  readonly message: string;
}

/**
 * What stops a project from being remediated at all. Pure rules over a manifest
 * snapshot, so they can be listed, reordered and tested without a filesystem.
 */
export const RULES: readonly HealthRule[] = Object.freeze([
  {
    id: 'no-lockfile',
    applies: (p) => !p.hasNpmLock && !p.hasYarnLock,
    message: 'no lockfile',
  },
  {
    id: 'ambiguous-package-manager',
    applies: (p) => p.hasYarnLock && p.hasNpmLock,
    message: 'both yarn.lock and package-lock.json present - decide which is authoritative',
  },
  {
    id: 'lockfile-v1',
    applies: (p) => p.lockfileVersion === 1,
    message: 'lockfileVersion 1 - `overrides` is silently ignored, migrate first',
  },
  {
    id: 'yarn-with-overrides',
    applies: (p) => p.hasYarnLock && !p.hasNpmLock && p.hasOverrides,
    message: 'yarn project using `overrides` - yarn needs `resolutions`',
  },
]);

export const blockersFor = (project: ProjectSnapshot): readonly string[] =>
  RULES.filter((rule) => rule.applies(project)).map((rule) => rule.message);

export const assessProject = (project: ProjectSnapshot): AssessedProject =>
  Object.freeze({ ...project, blockers: blockersFor(project) });

export const isBlocked = (project: AssessedProject): boolean => project.blockers.length > 0;
