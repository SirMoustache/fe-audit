import type { OverrideAssessment, PruneVerdict } from '../../domain/pruning';
import { blank, column, indent, listing } from '../../presentation/layout';
import type { PruneResult } from './index';

const NAME_WIDTH = 42;
const MOVE_WIDTH = 22;

const LABEL: Readonly<Record<PruneVerdict, string>> = {
  needed: 'KEEP',
  redundant: 'REDUNDANT',
  harmful: 'HARMFUL',
  ineffective: 'INEFFECTIVE',
  inert: 'INERT',
  unknown: 'UNKNOWN',
};

const label = (assessment: OverrideAssessment): string =>
  assessment.scopeKey ? `${assessment.scopeKey} > ${assessment.name}` : assessment.name;

const movement = (assessment: OverrideAssessment): string =>
  assessment.installed === null
    ? ''
    : assessment.natural === null || assessment.natural === assessment.installed
      ? assessment.installed
      : `${assessment.installed} vs ${assessment.natural}`;

const line = (assessment: OverrideAssessment): readonly string[] => [
  indent(
    column(label(assessment), NAME_WIDTH) +
      column(movement(assessment), MOVE_WIDTH) +
      assessment.reason
  ),
  ...(assessment.verdict === 'harmful' && assessment.breaking
    ? [indent('this also crosses a major boundary, so it may be breaking too', 3)]
    : []),
];

const of = (assessments: readonly OverrideAssessment[], verdict: PruneVerdict) =>
  assessments.filter((assessment) => assessment.verdict === verdict);

export const renderPruning = (
  result: PruneResult,
  { write }: { write: boolean }
): readonly string[] => {
  const { assessments } = result;

  return [
    blank(),
    result.projectDir,
    `${result.declaredCount} override declaration(s)`,

    ...listing(`${LABEL.harmful} - pins a lower version than npm would pick`, of(assessments, 'harmful'), line),
    ...listing(`${LABEL.ineffective} - the forced version is itself vulnerable`, of(assessments, 'ineffective'), line),
    ...listing(`${LABEL.redundant} - npm would resolve to something safe anyway`, of(assessments, 'redundant'), line),
    ...listing(`${LABEL.inert} - nothing in the tree to apply to`, of(assessments, 'inert'), line),
    ...(of(assessments, 'unknown').length > 0
      ? listing(`${LABEL.unknown} - not enough information`, of(assessments, 'unknown'), line)
      : []),
    ...listing(`${LABEL.needed} - still doing real work`, of(assessments, 'needed'), line),

    blank(),
    ...(result.removable.length === 0
      ? ['Nothing to prune - every override is still earning its place.']
      : write
        ? [
            `Removed ${result.removable.length} override(s).`,
            blank(),
            'Rebuild and confirm nothing regressed:',
            indent('rm -rf node_modules package-lock.json'),
            indent('npm install'),
            indent('npx fe-audit verify .'),
            indent('npm run build && npm test'),
          ]
        : [
            `${result.removable.length} override(s) can be removed. Re-run with --write to apply.`,
            blank(),
            'An INEFFECTIVE override is never removed automatically: the package is',
            'still vulnerable, so it needs a decision rather than a deletion.',
          ]),
    blank(),
  ];
};
