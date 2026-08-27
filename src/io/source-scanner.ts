import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import type { PackageName } from '../domain/semver-policy';

const BUILTINS = new Set([...builtinModules, 'node:test']);

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'out',
  'coverage',
  '.turbo',
  '.cache',
]);

/** Anything at the root that plausibly configures a tool. */
const CONFIG_PATTERN =
  /^(\..+rc(\..+)?|.+\.config\.(js|cjs|mjs|ts|json|yml|yaml)|\..*ignore|codegen\..+|.+\.ya?ml)$/;

const CONFIG_EXTENSIONS = new Set(['.json', '.yml', '.yaml', '.js', '.cjs', '.mjs', '.ts', '']);

const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire(?:\.resolve)?\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
];

/**
 * The package a module specifier belongs to, or `null` for anything that is not
 * an installed dependency: relative paths, node builtins, unresolved template
 * literals, and project path aliases such as `src/...`.
 */
export const specifierToPackage = (
  specifier: string,
  aliasRoots: ReadonlySet<string> = new Set()
): PackageName | null => {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.includes('${') || specifier.includes('*')) return null;
  if (specifier.startsWith('node:') || BUILTINS.has(specifier)) return null;

  const segments = specifier.split('/');
  const name = specifier.startsWith('@')
    ? segments.length >= 2
      ? `${segments[0]}/${segments[1]}`
      : null
    : (segments[0] ?? null);

  if (name === null || BUILTINS.has(name)) return null;
  return aliasRoots.has(name) ? null : name;
};

/**
 * JSON with comments, as tsconfig uses.
 *
 * Stripping comments by regex is wrong here: path patterns such as
 * `"components/*"` and `"**\/*.ts"` contain `/*` and `*\/` sequences, so a naive
 * block-comment match swallows everything between them. String state has to be
 * tracked properly.
 */
export const parseJsonc = <T>(text: string): T => {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;
    const next = text[i + 1] ?? '';

    if (inLine) {
      if (char === '\n') {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next;
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    out += char;
  }

  // Trailing commas are common in hand-edited tsconfigs and JSON rejects them.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as T;
};

/**
 * Import roots that resolve to project files rather than packages, taken from
 * the tsconfig `paths` map and from the top-level directories `baseUrl` exposes.
 */
const aliasRootsFrom = (projectDir: string): ReadonlySet<string> => {
  const roots = new Set<string>();
  for (const file of ['tsconfig.json', 'jsconfig.json']) {
    const full = path.join(projectDir, file);
    if (!fs.existsSync(full)) continue;
    try {
      const config = parseJsonc<{
        compilerOptions?: { baseUrl?: string; paths?: Record<string, unknown> };
      }>(readText(full));

      for (const key of Object.keys(config.compilerOptions?.paths ?? {})) {
        // Alias keys are normalised the same way specifiers are, so a scoped
        // alias such as `@/jaden-ui/*` yields `@/jaden-ui` rather than `@`.
        const root = specifierToPackage(key.replace(/\/\*+$/, ''));
        if (root) roots.add(root);
      }

      const baseUrl = config.compilerOptions?.baseUrl;
      if (baseUrl !== undefined) {
        for (const entry of listEntries(path.resolve(projectDir, baseUrl))) {
          if (entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name)) roots.add(entry.name);
        }
      }
    } catch {
      // A tsconfig we cannot parse simply contributes no aliases.
    }
  }
  return roots;
};

const listEntries = (dir: string): fs.Dirent[] => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

const readText = (file: string): string => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

export interface ScannedProject {
  /** Package name -> source files that import it. */
  readonly imports: ReadonlyMap<PackageName, readonly string[]>;
  /** Raw text of config files, keyed by relative path, for mention scanning. */
  readonly configText: ReadonlyMap<string, string>;
  readonly sourceFileCount: number;
}

const collectSourceFiles = (root: string, maxDepth: number): readonly string[] => {
  const walk = (dir: string, depth: number): readonly string[] => {
    if (depth > maxDepth) return [];
    return listEntries(dir).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return SKIP_DIRECTORIES.has(entry.name) ? [] : walk(full, depth + 1);
      }
      return SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [full] : [];
    });
  };
  return walk(root, 0);
};

const collectConfigFiles = (root: string): readonly string[] =>
  listEntries(root)
    .filter((entry) => entry.isFile())
    .filter(
      (entry) =>
        CONFIG_PATTERN.test(entry.name) && CONFIG_EXTENSIONS.has(path.extname(entry.name))
    )
    .map((entry) => path.join(root, entry.name));

const specifiersIn = (text: string): readonly string[] =>
  SPECIFIER_PATTERNS.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1] ?? ''));

/**
 * Reads the project once and records where each package is referenced.
 *
 * Import extraction is precise; config files are kept as raw text and searched
 * by name later. That asymmetry is deliberate: a missed reference would mark a
 * used package as removable, so config scanning errs towards finding too much.
 */
export const scanProject = (projectDir: string, { maxDepth = 12 } = {}): ScannedProject => {
  const imports = new Map<PackageName, string[]>();
  const aliasRoots = aliasRootsFrom(projectDir);

  const sourceFiles = collectSourceFiles(projectDir, maxDepth);
  for (const file of sourceFiles) {
    const relative = path.relative(projectDir, file);
    for (const specifier of specifiersIn(readText(file))) {
      const name = specifierToPackage(specifier, aliasRoots);
      if (!name) continue;
      const seen = imports.get(name) ?? [];
      if (!seen.includes(relative)) seen.push(relative);
      imports.set(name, seen);
    }
  }

  const configText = new Map<string, string>(
    collectConfigFiles(projectDir).map((file) => [path.basename(file), readText(file)])
  );

  return { imports, configText, sourceFileCount: sourceFiles.length };
};
