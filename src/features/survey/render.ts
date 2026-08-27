import path from 'node:path';
import type { AssessedProject } from '../../domain/project-health';
import { blank, column, heading, rule } from '../../presentation/layout';
import type { SurveyResult } from './index';

const COLUMNS = [44, 7, 11] as const;
const CONTINUATION_INDENT = COLUMNS.reduce((total, width) => total + width, 0);

const overridesLabel = (project: AssessedProject): string =>
  project.hasOverrides ? 'yes' : project.hasResolutions ? 'resolutions' : 'no';

const projectLines = (project: AssessedProject, rootDir: string): readonly string[] => {
  const [firstBlocker, ...furtherBlockers] = project.blockers;
  const summary =
    column(path.relative(rootDir, project.dir) || '.', COLUMNS[0]) +
    column(project.lockfileVersion ?? '-', COLUMNS[1]) +
    column(overridesLabel(project), COLUMNS[2]) +
    (firstBlocker ?? '');
  return [summary, ...furtherBlockers.map((blocker) => ' '.repeat(CONTINUATION_INDENT) + blocker)];
};

export const renderSurvey = ({
  rootDir,
  projects,
  blockedCount,
}: SurveyResult): readonly string[] => [
  blank(),
  `Found ${projects.length} project(s) under ${rootDir}`,
  blank(),
  heading(['project', 'lockV', 'overrides', 'notes'], COLUMNS),
  rule(),
  ...projects.flatMap((project) => projectLines(project, rootDir)),
  blank(),
  `${blockedCount} project(s) need attention before overrides can be applied.`,
];
