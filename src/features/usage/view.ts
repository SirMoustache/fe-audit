import type {
  DeadOverride,
  PhantomDependency,
  UnreferencedDependency,
  UsedDependency,
} from '../../domain/usage';
import { blank, column, emptyNotice, indent, section } from '../../presentation/layout';
import type { UsageResult } from './index';

const NAME_WIDTH = 44;
const FIELD_WIDTH = 22;

const EVIDENCE_LABEL = {
  imported: 'imported',
  script: 'script',
  config: 'config',
  'types-for': 'types for',
  'peer-of': 'peer of',
} as const;

const usedLine = (dependency: UsedDependency): string => {
  const strongest = dependency.evidence[0];
  const where = strongest?.where.slice(0, 2).join(', ') ?? '';
  const more = (strongest?.where.length ?? 0) > 2 ? ` +${(strongest?.where.length ?? 0) - 2}` : '';
  return indent(
    column(dependency.name, NAME_WIDTH) +
      column(strongest ? EVIDENCE_LABEL[strongest.kind] : '', 12) +
      where +
      more
  );
};

const unreferencedLines = (dependency: UnreferencedDependency): readonly string[] => {
  const payoff =
    dependency.carriesVulnerable.length > 0
      ? `${dependency.carriesVulnerable.length} vulnerable, ${dependency.subtreeSize} packages`
      : dependency.subtreeSize > 0
        ? `${dependency.subtreeSize} packages`
        : 'no transitive packages';

  return [
    indent(column(dependency.name, NAME_WIDTH) + column(dependency.field, FIELD_WIDTH) + payoff),
    ...(dependency.carriesVulnerable.length > 0
      ? [indent(`carries: ${dependency.carriesVulnerable.slice(0, 6).join(', ')}`, 3)]
      : []),
  ];
};

const phantomLines = (dependency: PhantomDependency): readonly string[] => [
  indent(
    column(dependency.name, NAME_WIDTH) +
      column(dependency.resolvable ? 'resolves by hoisting' : 'NOT INSTALLED', FIELD_WIDTH) +
      dependency.importedIn.slice(0, 2).join(', ')
  ),
];

const deadOverrideLine = (override: DeadOverride): string =>
  indent(
    column(
      override.scopeKey ? `${override.scopeKey} > ${override.name}` : override.name,
      NAME_WIDTH
    ) + `"${override.declared}" - nothing in the tree to apply to`
  );

const listing = <T>(
  title: string,
  items: readonly T[],
  toLines: (item: T) => readonly string[]
): readonly string[] => [
  blank(),
  section(title, items.length),
  ...(items.length === 0 ? [emptyNotice()] : items.flatMap(toLines)),
];

const CAVEAT = [
  'Evidence is textual: imports, package.json scripts and root config files.',
  'A package can still be used through generated code, a plugin convention or a',
  'tool that resolves it by name at runtime. Treat the list as candidates and',
  'remove one at a time, with a build and test run between each.',
];

export const renderUsage = (result: UsageResult): readonly string[] => {
  const vulnerableCarried = new Set(
    result.unreferenced.flatMap((dependency) => dependency.carriesVulnerable)
  );

  return [
    blank(),
    `${result.projectDir}`,
    `scanned ${result.sourceFileCount} source file(s)` +
      (result.auditStatus === 'ok' ? '' : `   (audit ${result.auditStatus})`),

    ...listing('UNREFERENCED - declared but no reference found', result.unreferenced, unreferencedLines),

    ...(vulnerableCarried.size > 0
      ? [
          blank(),
          `Removing the unreferenced dependencies above would drop ${vulnerableCarried.size} ` +
            'vulnerable package(s) that nothing else needs.',
        ]
      : []),

    ...listing('PHANTOM - imported but not declared', result.phantom, phantomLines),

    ...(result.phantom.length > 0
      ? [
          indent(
            'These work only while another package happens to install them. Declare them.',
            1
          ),
        ]
      : []),

    ...listing('DEAD OVERRIDES', result.deadOverrides, (override) => [deadOverrideLine(override)]),

    blank(),
    section('USED', result.used.length),
    ...result.used.slice(0, 8).map(usedLine),
    ...(result.used.length > 8 ? [indent(`... and ${result.used.length - 8} more`)] : []),

    blank(),
    'NOTE',
    ...CAVEAT.map((line) => indent(line)),
    blank(),
  ];
};
