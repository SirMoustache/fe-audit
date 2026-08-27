import { buildDependencyGraph } from '../domain/dependency-graph';
import type { DependencyGraph, Lockfile, Manifest, OverrideTree } from '../domain/dependency-graph';
import type { Finding } from '../domain/finding';
import { readFindings } from '../domain/finding';
import { audit } from '../io/npm-client';
import { readLockfile, readManifest } from '../io/workspace';

/**
 * How advisory context was obtained. Named as three states rather than a
 * boolean so a report can distinguish "you asked me not to look" from
 * "I looked and could not tell".
 */
export type AuditStatus = 'ok' | 'skipped' | 'unavailable';

/**
 * Everything a command needs to read about a project, loaded once.
 *
 * Every feature previously repeated this: read the manifest, read the lockfile,
 * build the graph, and — for three of them — attempt an audit while treating
 * failure as merely missing context. Repeating it invited the parts to drift,
 * particularly the rule that the graph must be built with the manifest so
 * direct dependencies are read from what npm validates against.
 */
export interface ProjectContext {
  readonly projectDir: string;
  readonly manifest: Manifest;
  readonly lockfile: Lockfile;
  readonly graph: DependencyGraph;
  readonly overrides: OverrideTree;
}

export const loadProject = (projectDir: string): ProjectContext => {
  const manifest = readManifest(projectDir);
  const lockfile = readLockfile(projectDir);
  return {
    projectDir,
    manifest,
    lockfile,
    graph: buildDependencyGraph(lockfile, { manifest }),
    overrides: manifest.overrides ?? {},
  };
};

export interface AuditContext {
  readonly findings: readonly Finding[];
  readonly status: AuditStatus;
}

/**
 * Advisory context is useful but not essential: a project that cannot be
 * audited can still be reported on from its lockfile alone.
 */
export const loadAudit = (
  projectDir: string,
  { skip = false }: { skip?: boolean } = {}
): AuditContext => {
  if (skip) return { findings: [], status: 'skipped' };
  try {
    return { findings: readFindings(audit(projectDir)), status: 'ok' };
  } catch {
    return { findings: [], status: 'unavailable' };
  }
};
