import fs from 'node:fs';
import path from 'node:path';
import type { Lockfile, Manifest, OverrideTree } from '../domain/dependency-graph';
import type { ProjectSnapshot } from '../domain/project-health';

const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.next',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
]);

const MANIFEST = 'package.json';
const NPM_LOCK = 'package-lock.json';
const YARN_LOCK = 'yarn.lock';

const readJson = <T>(file: string): T =>
  JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as T;

const writeJson = (file: string, value: unknown): void =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' });

const readJsonIfPresent = <T>(file: string): T | null =>
  fs.existsSync(file) ? readJson<T>(file) : null;

export const manifestPath = (projectDir: string): string => path.join(projectDir, MANIFEST);
export const lockPath = (projectDir: string): string => path.join(projectDir, NPM_LOCK);

export const readManifest = (projectDir: string): Manifest =>
  readJson<Manifest>(manifestPath(projectDir));

export const readLockfile = (projectDir: string): Lockfile =>
  readJson<Lockfile>(lockPath(projectDir));

export const isProject = (dir: string): boolean => fs.existsSync(path.join(dir, MANIFEST));

const listDirectories = (dir: string): readonly string[] => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
};

export const findProjects = (rootDir: string, maxDepth = 4): readonly string[] => {
  const descend = (dir: string, depth: number): readonly string[] =>
    depth > maxDepth
      ? []
      : [
          ...(isProject(dir) ? [dir] : []),
          ...listDirectories(dir).flatMap((child) => descend(child, depth + 1)),
        ];
  return descend(rootDir, 0);
};

export const describeProject = (projectDir: string): ProjectSnapshot => {
  const manifest = readJsonIfPresent<Manifest>(manifestPath(projectDir)) ?? {};
  const lockfile = readJsonIfPresent<Lockfile>(lockPath(projectDir));
  return {
    dir: projectDir,
    name: manifest.name,
    packageManager: manifest.packageManager ?? null,
    hasOverrides: manifest.overrides !== undefined,
    hasResolutions: manifest.resolutions !== undefined,
    hasNpmLock: lockfile !== null,
    hasYarnLock: fs.existsSync(path.join(projectDir, YARN_LOCK)),
    lockfileVersion: lockfile?.lockfileVersion ?? null,
  };
};

export const saveOverrides = (projectDir: string, overrides: OverrideTree): string => {
  const file = manifestPath(projectDir);
  const manifest = readJson<Manifest>(file);
  writeJson(file, { ...manifest, overrides });
  return file;
};
