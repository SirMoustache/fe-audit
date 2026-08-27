#!/usr/bin/env node
import path from 'node:path';
import { remediateProject, applyOverrides } from './features/remediate';
import { renderRemediation } from './features/remediate/view';
import { surveyWorkspace } from './features/survey';
import { renderSurvey } from './features/survey/view';
import { verifyProject } from './features/verify';
import { renderVerification } from './features/verify/view';
import type { RegistryOptions } from './io/registry';
import { isProject } from './io/workspace';

const USAGE = `
fe-audit - classify npm audit findings and generate safe overrides

  npx fe-audit survey [rootDir]              Inventory projects and flag blockers
  npx fe-audit analyze <projectDir> [opts]   Classify findings, propose overrides
  npx fe-audit verify <projectDir>           Check declared overrides took effect

Options:
  --write               analyze: merge the proposed overrides into package.json
  --include-tight       analyze: also write overrides that cross an exact pin
  --omit-dev            analyze: only consider production dependencies
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
  readonly json: boolean;
  readonly cache: boolean;
  readonly concurrency?: number;
  readonly cacheTtlMs?: number;
}

interface Request {
  readonly command: string | undefined;
  readonly target: string | undefined;
  readonly options: Options;
}

const numericFlag = (args: readonly string[], flag: string): number | undefined => {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} expects a positive number`);
  return value;
};

/** A bare word is the target unless it is the value of a preceding value flag. */
const findTarget = (args: readonly string[]): string | undefined =>
  args.find(
    (arg, index) => index > 0 && !arg.startsWith('--') && !VALUE_FLAGS.has(args[index - 1] ?? '')
  );

const parseRequest = (argv: readonly string[]): Request => {
  const args = argv.slice(2);
  const ttlMinutes = numericFlag(args, '--cache-ttl');
  const concurrency = numericFlag(args, '--concurrency');
  return {
    command: args[0],
    target: findTarget(args),
    options: {
      write: args.includes('--write'),
      includeTight: args.includes('--include-tight'),
      omitDev: args.includes('--omit-dev'),
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

const survey = async ({ target, options }: Request): Promise<readonly string[]> => {
  const result = surveyWorkspace(path.resolve(target ?? process.cwd()));
  return options.json ? asJson(result) : renderSurvey(result);
};

const analyze = async ({ target, options }: Request): Promise<readonly string[]> => {
  const projectDir = resolveProject(target);
  const result = await remediateProject(projectDir, {
    omitDev: options.omitDev,
    includeTight: options.includeTight,
    registryOptions: registryOptionsFrom(options),
  });
  if (options.write) applyOverrides(projectDir, result.overrides);
  return options.json ? asJson(result) : renderRemediation(result, { write: options.write });
};

const verify = async ({ target, options }: Request): Promise<readonly string[]> => {
  const result = verifyProject(resolveProject(target));
  if (result.failures.length > 0) process.exitCode = 1;
  return options.json ? asJson(result) : renderVerification(result);
};

const COMMANDS: Readonly<Record<string, (request: Request) => Promise<readonly string[]>>> = {
  survey,
  analyze,
  verify,
};

const HELP = new Set<string | undefined>(['--help', '-h', 'help', undefined]);

const main = async (argv: readonly string[]): Promise<readonly string[]> => {
  const request = parseRequest(argv);
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
