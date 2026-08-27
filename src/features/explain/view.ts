import type { ConsumerVerdict, InstanceExplanation } from '../../domain/explanation';
import { hasForcedBreaking } from '../../domain/explanation';
import { blank, column, indent } from '../../presentation/layout';
import type { ExplainResult } from './index';

const NAME_WIDTH = 46;
const RANGE_WIDTH = 16;

const consumerLine = (consumer: ConsumerVerdict): string => {
  const label = `${consumer.name}${consumer.version ? `@${consumer.version}` : ''}`;
  const note = consumer.accepts
    ? 'ok'
    : consumer.expressible
      ? 'REJECTS this version'
      : 'non-registry range, treated as a constraint';
  return indent(column(label, NAME_WIDTH) + column(consumer.range, RANGE_WIDTH) + note);
};

const instanceBlock = (instance: InstanceExplanation): readonly string[] => [
  blank(),
  indent(`${instance.path}   ${instance.version}${instance.hoisted ? '' : '   (nested)'}`),
  ...(instance.consumers.length === 0
    ? [indent('no attributable consumer', 2)]
    : instance.consumers.map(consumerLine)),
];

const overrideBlock = (result: ExplainResult): readonly string[] => {
  if (result.overrides.length === 0) return [];
  return [
    blank(),
    'OVERRIDE',
    ...result.overrides.map((override) =>
      indent(
        override.scopeKey
          ? `"${override.scopeKey}": { "${result.name}": "${override.declared}" }`
          : `"${result.name}": "${override.declared}"`
      )
    ),
  ];
};

const advisoryBlock = (result: ExplainResult): readonly string[] => {
  if (result.auditStatus === 'skipped') {
    return [blank(), 'ADVISORY', indent('skipped (--skip-audit)')];
  }
  if (result.auditStatus === 'unavailable') {
    return [blank(), 'ADVISORY', indent('npm audit could not be read')];
  }
  if (!result.advisory) return [blank(), 'ADVISORY', indent('not currently listed by npm audit')];

  const { severity, range, titles, ownFlaw } = result.advisory;
  return [
    blank(),
    'ADVISORY',
    indent(`${severity}   affects ${range}`),
    ...(ownFlaw
      ? titles.slice(0, 3).map((title) => indent(title, 2))
      : [indent('inherited only - clears when its parent is fixed', 2)]),
  ];
};

/**
 * Guidance is derived from the facts above rather than stored, so it can never
 * disagree with them.
 */
const guidance = (result: ExplainResult): readonly string[] => {
  const lines: string[] = [];
  const forced = hasForcedBreaking(result);
  const rejecting = result.instances.flatMap((instance) => instance.rejecting);

  if (result.direct) {
    lines.push(
      `Declared in ${result.direct.field} as "${result.direct.range}".`,
      'npm rejects a top-level override for a direct dependency (EOVERRIDE);',
      'change the declared range instead.'
    );
  }

  if (forced) {
    lines.push(
      'An override is forcing a version that a consumer declared against.',
      'A passing `npm run build` is not evidence this is safe unless the build',
      'actually executes that consumer. Confirm the API surface it uses, or',
      'upgrade the consumer instead.'
    );
  } else if (rejecting.length > 0) {
    lines.push(
      'Some consumer would reject an upgrade, which is why this is not offered',
      'as a safe override. Upgrade the consumer, or accept the finding.'
    );
  }

  lines.push(
    result.production
      ? 'Reachable from the production dependency tree.'
      : 'Not reachable from production - build or tooling only, so the practical risk is lower.'
  );

  return [blank(), 'GUIDANCE', ...lines.map((line) => indent(line))];
};

export const renderExplanation = (result: ExplainResult): readonly string[] => {
  if (!result.present) {
    return [
      blank(),
      `${result.name} is not present in ${result.projectDir}`,
      indent('nothing installed under that name, including as an alias'),
    ];
  }

  return [
    blank(),
    `${result.name}   in ${result.projectDir}`,
    blank(),
    `INSTALLED (${result.instances.length} cop${result.instances.length === 1 ? 'y' : 'ies'})`,
    ...result.instances.flatMap(instanceBlock),
    ...overrideBlock(result),
    ...advisoryBlock(result),
    ...guidance(result),
    blank(),
  ];
};
