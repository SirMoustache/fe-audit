import type { OverrideTree } from '../../domain/dependency-graph';
import type { OverrideConflict } from '../../domain/override-set';
import type {
  DirectUpgradeRemedy,
  OverrideRemedy,
  Remediation,
  RiskyRemedy,
} from '../../domain/remediation';
import { blank, column, indent, listing } from '../../presentation/layout';
import type { RemediationResult } from './index';

const NAME_WIDTH = 42;
const MOVE_WIDTH = 24;

type Upgradeable = OverrideRemedy | RiskyRemedy | DirectUpgradeRemedy;

const move = (remedy: Upgradeable): string => `${remedy.from} -> ${remedy.to}`;

const scopeLabel = (remedy: OverrideRemedy): string =>
  remedy.scopeKeys.length > 0 ? `${remedy.scopeKeys.join(', ')} > ${remedy.name}` : remedy.name;

const row = (label: string, remedy: Upgradeable, note: string): string =>
  indent(column(label, NAME_WIDTH) + column(move(remedy), MOVE_WIDTH) + note);

const safeLines = (remedy: OverrideRemedy): readonly string[] => [
  row(remedy.name, remedy, `${remedy.consumerCount} consumer(s), all ranges satisfied`),
];

const scopedLines = (remedy: OverrideRemedy): readonly string[] => [
  row(scopeLabel(remedy), remedy, 'nested copy'),
];

const tightLines = (remedy: OverrideRemedy): readonly string[] => [
  row(scopeLabel(remedy), remedy, 'available; opt in with --include-tight'),
  ...remedy.rejectedBy
    .slice(0, 2)
    .map((consumer) => indent(`${consumer.name}@${consumer.version} pinned ${consumer.range}`, 3)),
];

const riskyLines = (remedy: RiskyRemedy): readonly string[] => [
  row(remedy.name, remedy, 'DO NOT OVERRIDE'),
  ...remedy.rejectedBy.map((consumer) =>
    indent(`blocked by ${consumer.name}@${consumer.version} which wants ${consumer.range}`, 3)
  ),
  ...(remedy.inexpressibleCount > 0
    ? [
        indent(
          `${remedy.inexpressibleCount} consumer(s) use non-registry ranges ` +
            '(file:/git:/workspace:), counted as constraints',
          3
        ),
      ]
    : []),
  indent('-> upgrade the parent instead', 3),
];

const directLines = (remedy: DirectUpgradeRemedy): readonly string[] => [
  row(remedy.name, remedy, `declared ${remedy.declared}${remedy.breaking ? '  [BREAKING]' : ''}`),
];

const conflictLines = (conflict: OverrideConflict): readonly string[] => [
  indent(
    column(`${conflict.key} > ${conflict.child ?? conflict.key}`, NAME_WIDTH) +
      `withheld: ${conflict.candidates.join(' vs ')}`
  ),
  indent(conflict.reason, 3),
];

const reviewLines = (remedy: Remediation): readonly string[] => [
  indent(column(remedy.name, NAME_WIDTH) + ('reason' in remedy ? remedy.reason : '')),
];

const NEXT_STEPS = [
  'IMPORTANT: stale state silently under-applies overrides - the lockfile AND',
  'node_modules, which npm consults when building the tree. Rebuild both:',
  '  rm -rf node_modules package-lock.json   (Windows: rd /s /q node_modules)',
  '  npm install --legacy-peer-deps',
  '  npx fe-audit verify .',
  '  npm run build && npm test',
];

const renderOutcome = (
  overrides: OverrideTree,
  write: boolean,
  withheldTight: number
): readonly string[] => {
  const proposed = Object.keys(overrides).length;
  const tightHint =
    withheldTight > 0
      ? [
          `${withheldTight} further override(s) available with --include-tight ` +
            '(each crosses an exact pin, so build afterwards).',
        ]
      : [];

  if (proposed === 0) return [blank(), 'No overrides to propose.', ...tightHint];

  if (!write) {
    return [
      blank(),
      'Proposed overrides (re-run with --write to apply):',
      blank(),
      JSON.stringify({ overrides }, null, 2),
      ...(tightHint.length > 0 ? [blank(), ...tightHint] : []),
    ];
  }

  return [
    blank(),
    `Wrote ${proposed} override(s).`,
    ...(tightHint.length > 0 ? [blank(), ...tightHint] : []),
    blank(),
    ...NEXT_STEPS,
  ];
};

export const renderRemediation = (
  { projectDir, totals, groups, overrides, conflicts, includeTight }: RemediationResult,
  { write }: { write: boolean }
): readonly string[] => {
  const tightTitle = includeTight
    ? 'TIGHT - consumer pinned exactly, bump is non-breaking (included)'
    : 'TIGHT - consumer pinned exactly, bump is non-breaking (NOT written)';

  return [
    blank(),
    projectDir,
    `audit totals: ${JSON.stringify(totals)}`,
    ...listing('SAFE OVERRIDES', groups.safe, safeLines),
    ...(groups.scoped.length > 0 ? listing('SCOPED OVERRIDES', groups.scoped, scopedLines) : []),
    ...(groups.tight.length > 0 ? listing(tightTitle, groups.tight, tightLines) : []),
    ...listing(
      'RISKY - would force a breaking change on unwilling consumers',
      groups.risky,
      riskyLines
    ),
    ...listing('DIRECT DEPENDENCY UPGRADES', groups.direct, directLines),
    ...(conflicts.length > 0
      ? listing('WITHHELD - npm cannot express both targets', conflicts, conflictLines)
      : []),
    ...(groups.unresolved.length > 0
      ? listing('NEEDS MANUAL REVIEW', groups.unresolved, reviewLines)
      : []),
    blank(),
    'inherited-only findings (clear automatically once parents are fixed): ' +
      `${groups.inherited.length}`,
    ...renderOutcome(overrides, write, includeTight ? 0 : groups.tight.length),
  ];
};
