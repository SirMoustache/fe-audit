import { execFileSync } from 'node:child_process';
import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AuditReport } from '../domain/finding';
import type { PackageName, Version } from '../domain/semver-policy';
import type { VersionLookup } from '../domain/remediation';

/**
 * The only place that shells out. Spawning `npm.cmd` needs `shell: true` on
 * Windows, which triggers a Node deprecation warning and concatenates arguments
 * unescaped; running npm's own entry point under the current interpreter avoids
 * the shell altogether.
 */
const NPM_FALLBACK = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const NPM_CLI =
  [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(
      path.dirname(process.execPath),
      '..',
      'lib',
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js'
    ),
  ].find((candidate) => fs.existsSync(candidate)) ?? null;

const execOptions = (cwd: string, shell = false): ExecFileSyncOptionsWithStringEncoding => ({
  cwd,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'ignore'],
  shell,
});

const run = (args: readonly string[], cwd: string): string =>
  NPM_CLI
    ? execFileSync(process.execPath, [NPM_CLI, ...args], execOptions(cwd))
    : execFileSync(NPM_FALLBACK, [...args], execOptions(cwd, true));

const parse = <T>(text: string): T => JSON.parse(text.replace(/^\uFEFF/, '')) as T;

/**
 * `npm audit` writes `{"error":{...}}` to stdout for genuine failures — an
 * unresolvable tree, a registry outage — which parses cleanly and would
 * otherwise read downstream as "no vulnerabilities found".
 */
export const assertUsableReport = (report: AuditReport, cwd: string): AuditReport => {
  if (report.error && !report.vulnerabilities) {
    const detail = report.error.summary ?? report.error.detail ?? JSON.stringify(report.error);
    throw new Error(`npm audit failed in ${cwd}: ${detail}`);
  }
  return report;
};

export interface AuditOptions {
  readonly omitDev?: boolean;
}

/** `npm audit` exits non-zero whenever findings exist, so failure still carries the report. */
export const audit = (cwd: string, { omitDev = false }: AuditOptions = {}): AuditReport => {
  const args = ['audit', '--json', ...(omitDev ? ['--omit=dev'] : [])];
  let output: string | undefined;
  try {
    output = run(args, cwd);
  } catch (error) {
    output = (error as { stdout?: string }).stdout;
  }
  if (!output) throw new Error(`npm audit produced no output in ${cwd}`);
  return assertUsableReport(parse<AuditReport>(output), cwd);
};

export interface Registry {
  versionsFor(name: PackageName): VersionLookup;
}

const lookup = (name: PackageName, cwd: string): VersionLookup => {
  let raw: string;
  try {
    raw = run(['view', name, 'versions', '--json'], cwd).trim();
  } catch {
    return { ok: false, reason: `registry lookup failed for ${name}` };
  }
  if (!raw) return { ok: false, reason: `registry returned no versions for ${name}` };
  try {
    const parsed = parse<Version | Version[]>(raw);
    return { ok: true, versions: Array.isArray(parsed) ? parsed : [parsed] };
  } catch {
    return { ok: false, reason: `registry returned unparseable versions for ${name}` };
  }
};

/**
 * Published versions for a package. A registry failure is reported rather than
 * swallowed: silently returning an empty list reads downstream as "no safe
 * version exists", which is a different and much more alarming claim.
 */
export const createRegistry = (cwd: string): Registry => {
  const cache = new Map<PackageName, VersionLookup>();
  return {
    versionsFor(name) {
      const cached = cache.get(name);
      if (cached) return cached;
      const result = lookup(name, cwd);
      cache.set(name, result);
      return result;
    },
  };
};
