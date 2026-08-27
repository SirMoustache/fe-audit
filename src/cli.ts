#!/usr/bin/env node
import path from 'node:path';
import { remediateProject, applyOverrides } from './features/remediate';
import { renderRemediation } from './features/remediate/view';
import { surveyWorkspace } from './features/survey';
import { renderSurvey } from './features/survey/view';
import { verifyProject } from './features/verify';
import { renderVerification } from './features/verify/view';
import { isProject } from './io/workspace';

const USAGE = `
fe-audit - classify npm audit findings and generate safe overrides

  npx fe-audit survey [rootDir]              Inventory projects and flag blockers
  npx fe-audit analyze <projectDir> [opts]   Classify findings, propose overrides
  npx fe-audit verify <projectDir>           Check declared overrides took effect

Options:
  --write           analyze: merge the proposed overrides into package.json
  --include-tight   analyze: also write overrides that cross an exact pin
  --omit-dev        analyze: only consider production dependencies
  --json            emit raw JSON instead of a report

Exit codes:
  0  success
  1  verify found an override that failed to remove a vulnerability, or an error

After --write, rebuild node_modules AND package-lock.json before reinstalling:
stale state silently under-applies newly added overrides.
`;

interface Options {
  readonly write: boolean;
  readonly includeTight: boolean;
  readonly omitDev: boolean;
  readonly json: boolean;
}

interface Request {
  readonly command: string | undefined;
  readonly target: string | undefined;
  readonly options: Options;
}

const parseRequest = (argv: readonly string[]): Request => {
  const args = argv.slice(2);
  return {
    command: args[0],
    target: args.slice(1).find((arg) => !arg.startsWith('--')),
    options: {
      write: args.includes('--write'),
      includeTight: args.includes('--include-tight'),
      omitDev: args.includes('--omit-dev'),
      json: args.includes('--json'),
    },
  };
};

const resolveProject = (target: string | undefined): string => {
  const projectDir = path.resolve(target ?? process.cwd());
  if (!isProject(projectDir)) throw new Error(`No package.json in ${projectDir}`);
  return projectDir;
};

const asJson = (value: unknown): readonly string[] => [JSON.stringify(value, null, 2)];

const survey = ({ target, options }: Request): readonly string[] => {
  const result = surveyWorkspace(path.resolve(target ?? process.cwd()));
  return options.json ? asJson(result) : renderSurvey(result);
};

const analyze = ({ target, options }: Request): readonly string[] => {
  const projectDir = resolveProject(target);
  const result = remediateProject(projectDir, {
    omitDev: options.omitDev,
    includeTight: options.includeTight,
  });
  if (options.write) applyOverrides(projectDir, result.overrides);
  return options.json ? asJson(result) : renderRemediation(result, { write: options.write });
};

const verify = ({ target, options }: Request): readonly string[] => {
  const result = verifyProject(resolveProject(target));
  if (result.failures.length > 0) process.exitCode = 1;
  return options.json ? asJson(result) : renderVerification(result);
};

const COMMANDS: Readonly<Record<string, (request: Request) => readonly string[]>> = {
  survey,
  analyze,
  verify,
};

const HELP = new Set(['--help', '-h', 'help', undefined]);

const main = (argv: readonly string[]): readonly string[] => {
  const request = parseRequest(argv);
  if (HELP.has(request.command)) return [USAGE];

  const handler = COMMANDS[request.command as string];
  if (!handler) {
    process.exitCode = 1;
    return [`Unknown command: ${request.command}`, USAGE];
  }
  return handler(request);
};

try {
  console.log(main(process.argv).join('\n'));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
