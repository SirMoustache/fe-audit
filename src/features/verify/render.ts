import type { Assessment, Verdict } from '../../domain/verification';
import { blank, column, heading, rule } from '../../presentation/layout';
import type { VerificationResult } from './index';

const COLUMNS = [17, 44, 14] as const;

interface VerdictLabel {
  readonly text: string;
  readonly explain: (assessment: Assessment) => string;
}

/** Presentation owns the wording; the domain only decides the verdict. */
const LABELS: Readonly<Record<Verdict, VerdictLabel>> = {
  pinned: { text: 'PINNED', explain: () => '' },
  range: {
    text: 'RANGE',
    explain: (a) => `confirm ${a.resolved} is above the advisory range`,
  },
  ahead: {
    text: 'AHEAD',
    explain: () => 'newer than the override - benign, consider dropping it',
  },
  diverged: {
    text: 'DIVERGED',
    explain: () => 'differs from the override but is not in the audit - benign',
  },
  'still-vulnerable': {
    text: 'STILL VULNERABLE',
    explain: (a) => `still in the audit, at ${a.instancePath}`,
  },
  'still-listed': {
    text: 'STILL LISTED',
    explain: (a) => `audit still lists ${a.name}, but several copies exist - check which`,
  },
  inert: { text: 'INERT', explain: () => 'not present in tree' },
};

const label = (assessment: Assessment): string =>
  (assessment.scopeKey ? `${assessment.scopeKey} > ` : '') + assessment.name;

const assessmentLine = (assessment: Assessment): string => {
  const { text, explain } = LABELS[assessment.verdict];
  const note = explain(assessment);
  return (
    column(text, COLUMNS[0]) +
    column(label(assessment), COLUMNS[1]) +
    column(assessment.declared, COLUMNS[2]) +
    (assessment.resolved ?? '') +
    (note ? `   ${note}` : '')
  );
};

const summary = ({ failures, diverged, listed }: VerificationResult): string =>
  `${failures.length} override(s) failed to remove a vulnerability.` +
  (listed.length > 0 ? `  (${listed.length} still listed, ambiguous)` : '') +
  (diverged.length > 0 ? `  (${diverged.length} diverged but benign)` : '');

export const renderVerification = (result: VerificationResult): readonly string[] =>
  result.assessments.length === 0
    ? [`No overrides declared in ${result.projectDir}`]
    : [
        blank(),
        heading(['status', 'package', 'declared', 'resolved'], COLUMNS),
        rule(),
        ...result.assessments.map(assessmentLine),
        blank(),
        summary(result),
      ];
