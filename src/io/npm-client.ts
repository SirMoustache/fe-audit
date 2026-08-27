import { execFile, execFileSync } from 'node:child_process';
import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AuditReport } from '../domain/finding';
import type { PackageName, Version } from '../domain/semver-policy';

const execFileAsync = promisify(execFile);

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

const runAsync = async (args: readonly string[], cwd: string): Promise<string> => {
  const options = { cwd, encoding: 'utf8' as const, maxBuffer: 64 * 1024 * 1024 };
  const { stdout } = NPM_CLI
    ? await execFileAsync(process.execPath, [NPM_CLI, ...args], options)
    : await execFileAsync(NPM_FALLBACK, [...args], { ...options, shell: true });
  return stdout;
};

/** A single npm config value, resolved through npm's own precedence rules. */
export const npmConfigGet = async (key: string, cwd: string): Promise<string> => {
  const value = (await runAsync(['config', 'get', key], cwd)).trim();
  return value === 'undefined' || value.startsWith(';') ? '' : value;
};

/**
 * Published versions via npm itself. Slower than a direct request, but it knows
 * the project's registry mapping and credentials, so it is the correct fallback
 * for anything the fast path cannot answer unambiguously.
 */
export const viewVersions = async (
  name: PackageName,
  cwd: string
): Promise<readonly Version[] | null> => {
  let raw: string;
  try {
    raw = (await runAsync(['view', name, 'versions', '--json'], cwd)).trim();
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = parse<Version | Version[]>(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return null;
  }
};
