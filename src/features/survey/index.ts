import type { AssessedProject } from '../../domain/project-health';
import { assessProject, isBlocked } from '../../domain/project-health';
import { describeProject, findProjects } from '../../io/workspace';

export interface SurveyResult {
  readonly rootDir: string;
  readonly projects: readonly AssessedProject[];
  readonly blockedCount: number;
}

export const surveyWorkspace = (rootDir: string): SurveyResult => {
  const projects = findProjects(rootDir).map(describeProject).map(assessProject);
  return { rootDir, projects, blockedCount: projects.filter(isBlocked).length };
};
