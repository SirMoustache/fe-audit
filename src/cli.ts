#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { remediateProject, applyOverrides } from './features/remediate';
import { renderRemediation } from './features/remediate/render';
import { surveyWorkspace } from './features/survey';
import { renderSurvey } from './features/survey/render';
import { verifyProject } from './features/verify';
import { renderVerification } from './features/verify/render';
import { explainInProject } from './features/explain';
import { renderExplanation } from './features/explain/render';
import { analyseProjectUsage } from './features/usage';
import { renderUsage } from './features/usage/render';
import { prunableOverrides, applyPruning } from './features/prune';
import { renderPruning } from './features/prune/render';
import type { RegistryOptions } from './infrastructure/registry';
import { isProject } from './infrastructure/workspace';

const USAGE = `
fe-audit - classify npm audit findings and generate safe overrides

  npx fe-audit survey [rootDir]              Inventory projects and flag blockers
  npx fe-audit analyze <projectDir> [opts]   Classify findings, propose overrides
  npx fe-audit verify <projectDir>           Check declared overrides took effect
  npx fe-audit explain <pkg> [projectDir]    Why one package is classified as it is
  npx fe-audit unused [projectDir]           Declared but unreferenced dependencies
  npx fe-audit prune [projectDir]            Overrides that are no longer earning their place

  --help, -h                                 Show this message
  --version, -v                              Print the installed version

Options:
  --write               analyze: merge the proposed overrides into package.json
                        prune: remove the overrides it finds removable
  --include-tight       analyze: also write overrides that cross an exact pin
  --omit-dev            analyze: only consider production dependencies
  --skip-audit          explain/unused: skip npm audit, use the lockfile alone
  --json                emit raw JSON instead of a report
  --concurrency <n>     parallel registry lookups (default 12)
  --no-cache            ignore the on-disk version cache
  --cache-ttl <minutes> how long cached versions stay fresh (default 60)

Exit codes:
  0  success
  1  verify found an override that failed to remove a vulnerability, or an error

After --write, rebuild node_modules AND package-lock.json before reinstalling:
stale state silently under-applies newly added overrides.
`;

const VALUE_FLAGS = new Set(['--concurrency', '--cache-ttl']);

interface Options {
  readonly write: boolean;
  readonly includeTight: boolean;
  readonly omitDev: boolean;
  readonly skipAudit: boolean;
  readonly json: boolean;
  readonly cache: boolean;
  readonly concurrency?: number;
  readonly cacheTtlMs?: number;
}

interface Request {
  readonly command: string | undefined;
  /** Bare arguments after the command, in order. */
  readonly positionals: readonly string[];
  readonly options: Options;
}

const numericFlag = (args: readonly string[], flag: string): number | undefined => {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} expects a positive number`);
  return value;
};

/** A bare word is positional unless it is the value of a preceding value flag. */
const positionalsIn = (args: readonly string[]): readonly string[] =>
  args.filter(
    (arg, index) => index > 0 && !arg.startsWith('--') && !VALUE_FLAGS.has(args[index - 1] ?? '')
  );

const parseRequest = (argv: readonly string[]): Request => {
  const args = argv.slice(2);
  const ttlMinutes = numericFlag(args, '--cache-ttl');
  const concurrency = numericFlag(args, '--concurrency');
  return {
    command: args[0],
    positionals: positionalsIn(args),
    options: {
      write: args.includes('--write'),
      includeTight: args.includes('--include-tight'),
      omitDev: args.includes('--omit-dev'),
      skipAudit: args.includes('--skip-audit'),
      json: args.includes('--json'),
      cache: !args.includes('--no-cache'),
      ...(concurrency === undefined ? {} : { concurrency }),
      ...(ttlMinutes === undefined ? {} : { cacheTtlMs: ttlMinutes * 60_000 }),
    },
  };
};

const resolveProject = (target: string | undefined): string => {
  const projectDir = path.resolve(target ?? process.cwd());
  if (!isProject(projectDir)) throw new Error(`No package.json in ${projectDir}`);
  return projectDir;
};

const asJson = (value: unknown): readonly string[] => [JSON.stringify(value, null, 2)];

/** Progress goes to stderr so it never contaminates piped or JSON output. */
const registryOptionsFrom = (options: Options): RegistryOptions => ({
  cache: options.cache,
  ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
  ...(options.cacheTtlMs === undefined ? {} : { cacheTtlMs: options.cacheTtlMs }),
  ...(options.json || !process.stderr.isTTY
    ? {}
    : {
        onProgress: (done: number, total: number) => {
          process.stderr.write(`\rresolving versions ${done}/${total}`);
          if (done === total) process.stderr.write('\n');
        },
      }),
});

const survey = async ({ positionals, options }: Request): Promise<readonly string[]> => {
  const result = surveyWorkspace(path.resolve(positionals[0] ?? process.cwd()));
  return options.json ? asJson(result) : renderSurvey(result);
};

const analyze = async ({ positionals, options }: Request): Promise<readonly string[]> => {
  const projectDir = resolveProject(positionals[0]);
  const result = await remediateProject(projectDir, {
    omitDev: options.omitDev,
    includeTight: options.includeTight,
    registryOptions: registryOptionsFrom(options),
  });
  if (options.write) applyOverrides(projectDir, result.overrides);
  return options.json ? asJson(result) : renderRemediation(result, { write: options.write });
};

const verify = async ({ positionals, options }: Request): Promise<readonly string[]> => {
  const result = verifyProject(resolveProject(positionals[0]));
  if (result.failures.length > 0) process.exitCode = 1;
  return options.json ? asJson(result) : renderVerification(result);
};

const explain = async ({ positionals, options }: Request): Promise<readonly string[]> => {
  const [name, target] = positionals;
  if (!name) throw new Error('explain expects a package name: fe-audit explain <pkg> [projectDir]');
  const result = explainInProject(resolveProject(target), name, { skipAudit: options.skipAudit });
  return options.json ? asJson(result) : renderExplanation(result);
};

const unused = async ({ positionals, options }: Request): Promise<readonly string[]> => {
  const result = analyseProjectUsage(resolveProject(positionals[0]), {
    skipAudit: options.skipAudit,
  });
  return options.json ? asJson(result) : renderUsage(result);
};

const prune = async ({ positionals, options }: Request): Promise<readonly string[]> => {
  const projectDir = resolveProject(positionals[0]);
  const result = await prunableOverrides(projectDir, {
    registryOptions: registryOptionsFrom(options),
  });
  if (options.write && result.removable.length > 0) applyPruning(projectDir, result.remaining);
  return options.json ? asJson(result) : renderPruning(result, { write: options.write });
};

const COMMANDS: Readonly<Record<string, (request: Request) => Promise<readonly string[]>>> = {
  survey,
  analyze,
  verify,
  explain,
  unused,
  prune,
};

const HELP = new Set<string | undefined>(['--help', '-h', 'help', undefined]);
const VERSION = new Set<string | undefined>(['--version', '-v', 'version']);

/**
 * Read from the manifest rather than a baked-in constant, so a release can
 * never report a version it was not published as. `dist/cli.js` sits one
 * directory below the package root.
 */
const readVersion = (): string => {
  try {
    const manifest = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
    return (JSON.parse(manifest) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
};

const main = async (argv: readonly string[]): Promise<readonly string[]> => {
  const request = parseRequest(argv);
  if (VERSION.has(request.command)) return [readVersion()];
  if (HELP.has(request.command)) return [USAGE];

  const handler = COMMANDS[request.command as string];
  if (!handler) {
    process.exitCode = 1;
    return [`Unknown command: ${request.command}`, USAGE];
  }
  return handler(request);
};

main(process.argv)
  .then((lines) => {
    console.log(lines.join('\n'));
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
