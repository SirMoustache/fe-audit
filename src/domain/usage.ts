import type { DependencyGraph, OverrideTree, PackageInstance } from './dependency-graph';
import type { Finding } from './finding';
import { hasOwnAdvisory } from './finding';
import { readDeclarations } from './override-set';
import type { PackageName, RangeSpec } from './semver-policy';

/** Why a package is considered used, strongest evidence first. */
export type EvidenceKind =
  /** Appears in an import or require in source. */
  | 'imported'
  /** Named in a package.json script, directly or by its bin. */
  | 'script'
  /** Named in a config file, directly or by its tool shorthand. */
  | 'config'
  /** Types for a package that is itself used, loaded by the compiler. */
  | 'types-for'
  /** Required as a peer dependency by a package that is used. */
  | 'peer-of';

export interface Evidence {
  readonly kind: EvidenceKind;
  readonly where: readonly string[];
}

export interface DeclaredDependency {
  readonly name: PackageName;
  readonly field: string;
  readonly range: RangeSpec;
}

export interface UsedDependency extends DeclaredDependency {
  readonly evidence: readonly Evidence[];
}

export interface UnreferencedDependency extends DeclaredDependency {
  /** Vulnerable packages reachable only through this dependency. */
  readonly carriesVulnerable: readonly PackageName[];
  /** Total packages that would leave the tree with it. */
  readonly subtreeSize: number;
}

export interface PhantomDependency {
  readonly name: PackageName;
  readonly importedIn: readonly string[];
  /** True when it is present in the tree, so it works only by hoisting. */
  readonly resolvable: boolean;
}

export interface DeadOverride {
  readonly name: PackageName;
  readonly scopeKey: PackageName | null;
  readonly declared: RangeSpec;
}

export interface UsageReport {
  readonly used: readonly UsedDependency[];
  readonly unreferenced: readonly UnreferencedDependency[];
  readonly phantom: readonly PhantomDependency[];
  readonly deadOverrides: readonly DeadOverride[];
}

export interface UsageInput {
  readonly graph: DependencyGraph;
  readonly declared: readonly DeclaredDependency[];
  readonly imports: ReadonlyMap<PackageName, readonly string[]>;
  readonly configText: ReadonlyMap<string, string>;
  readonly scripts: Readonly<Record<string, string>>;
  readonly overrides?: OverrideTree;
  readonly findings?: readonly Finding[];
  readonly binNames?: ReadonlyMap<PackageName, readonly string[]>;
}

const TYPES_PREFIX = '@types/';

/** `@types/node` covers `node`; `@types/react-dom` covers `react-dom`. */
const typedPackageOf = (name: PackageName): PackageName | null =>
  name.startsWith(TYPES_PREFIX)
    ? name.slice(TYPES_PREFIX.length).replace(/^([^_]+)__(.+)$/, '@$1/$2')
    : null;

/**
 * Tools name their plugins in shorthand: `.eslintrc` says `"react"` for
 * `eslint-plugin-react`, `.babelrc` says `"styled-components"` for
 * `babel-plugin-styled-components`, and jest says `"jsdom"` for
 * `jest-environment-jsdom`. Searching only for the full package name misses all
 * of these and reports a used plugin as dead.
 */
const shorthandsFor = (name: PackageName): readonly string[] => {
  const patterns: readonly [RegExp, string][] = [
    [/^eslint-plugin-(.+)$/, '$1'],
    [/^eslint-config-(.+)$/, '$1'],
    [/^@([^/]+)\/eslint-plugin$/, '@$1'],
    [/^@([^/]+)\/eslint-plugin-(.+)$/, '@$1/$2'],
    [/^@([^/]+)\/eslint-config$/, '@$1'],
    [/^babel-plugin-(.+)$/, '$1'],
    [/^babel-preset-(.+)$/, '$1'],
    [/^@babel\/plugin-transform-(.+)$/, '$1'],
    [/^jest-environment-(.+)$/, '$1'],
    [/^jest-preset-(.+)$/, '$1'],
    [/^postcss-(.+)$/, '$1'],
    [/^@graphql-codegen\/(.+)$/, '$1'],
    [/^@([^/]+)\/preset-(.+)$/, '$2'],
  ];

  return patterns
    .filter(([pattern]) => pattern.test(name))
    .map(([pattern, replacement]) => name.replace(pattern, replacement));
};

const wordBoundaryHit = (haystack: string, needle: string): boolean => {
  const index = haystack.indexOf(needle);
  if (index === -1) return false;
  const after = haystack[index + needle.length] ?? '';
  return !/[\w-]/.test(after);
};

const scriptEvidence = (
  name: PackageName,
  scripts: Readonly<Record<string, string>>,
  bins: readonly string[]
): readonly string[] =>
  Object.entries(scripts)
    .filter(([, body]) => [name, ...bins].some((token) => wordBoundaryHit(body, token)))
    .map(([scriptName]) => scriptName);

const configEvidence = (
  name: PackageName,
  configText: ReadonlyMap<string, string>
): readonly string[] => {
  const tokens = [name, ...shorthandsFor(name)];
  return [...configText.entries()]
    .filter(([, text]) => tokens.some((token) => wordBoundaryHit(text, token)))
    .map(([file]) => file);
};

/** Packages that a used package lists as a required peer are themselves used. */
const peerEvidence = (
  name: PackageName,
  graph: DependencyGraph,
  used: ReadonlySet<PackageName>
): readonly string[] =>
  [
    ...new Set(
      graph
        .consumersOf(name)
        .filter(
          (consumer) =>
            consumer.field === 'peerDependencies' &&
            consumer.declarerName !== null &&
            used.has(consumer.declarerName)
        )
        .map((consumer) => consumer.declarerName as PackageName)
    ),
  ];

const evidenceFor = (
  dependency: DeclaredDependency,
  input: UsageInput,
  usedNames: ReadonlySet<PackageName>
): readonly Evidence[] => {
  const { name } = dependency;
  const evidence: Evidence[] = [];

  const imported = input.imports.get(name) ?? [];
  if (imported.length > 0) evidence.push({ kind: 'imported', where: imported });

  const bins = input.binNames?.get(name) ?? [];
  const scripts = scriptEvidence(name, input.scripts, bins);
  if (scripts.length > 0) evidence.push({ kind: 'script', where: scripts });

  const configs = configEvidence(name, input.configText);
  if (configs.length > 0) evidence.push({ kind: 'config', where: configs });

  // Type packages are consumed by the compiler, never imported by name.
  const typed = typedPackageOf(name);
  if (typed && (usedNames.has(typed) || typed === 'node')) {
    evidence.push({ kind: 'types-for', where: [typed] });
  }

  const peers = peerEvidence(name, input.graph, usedNames);
  if (peers.length > 0) evidence.push({ kind: 'peer-of', where: peers });

  return evidence;
};

const subtreeNames = (graph: DependencyGraph, name: PackageName): ReadonlySet<PackageName> => {
  const seen = new Set<PackageName>();
  const roots = graph.instancesOf(name).filter((instance) => graph.isHoisted(instance));
  const queue: PackageInstance[] = [...roots];

  while (queue.length > 0) {
    const instance = queue.pop() as PackageInstance;
    if (seen.has(instance.treeName)) continue;
    seen.add(instance.treeName);
    for (const declaration of graph.dependenciesOf(instance)) {
      if (!declaration.resolvedPath) continue;
      const next = graph
        .instancesOf(declaration.name)
        .find((candidate) => candidate.path === declaration.resolvedPath);
      if (next) queue.push(next);
    }
  }

  return seen;
};

/**
 * Removing a dependency only helps if nothing else needs what it dragged in, so
 * the payoff is the vulnerable packages reachable through it and nowhere else.
 */
const uniquelyCarried = (
  graph: DependencyGraph,
  name: PackageName,
  siblings: readonly PackageName[],
  vulnerable: ReadonlySet<PackageName>
): { readonly carriesVulnerable: readonly PackageName[]; readonly subtreeSize: number } => {
  const subtree = subtreeNames(graph, name);
  const elsewhere = new Set(siblings.flatMap((sibling) => [...subtreeNames(graph, sibling)]));

  const unique = [...subtree].filter((candidate) => candidate !== name && !elsewhere.has(candidate));

  return {
    carriesVulnerable: unique.filter((candidate) => vulnerable.has(candidate)).sort(),
    subtreeSize: unique.length,
  };
};

/**
 * Which declared dependencies are actually referenced, which are imported
 * without being declared, and which overrides no longer apply to anything.
 *
 * Evidence is reported rather than acted on. A package with no evidence is a
 * candidate for removal, not a verdict — reflection, generated code and tool
 * conventions can all reference a package in ways no scanner will see.
 */
export const analyseUsage = (input: UsageInput): UsageReport => {
  const { graph, declared } = input;

  const declaredNames = new Set(declared.map((dependency) => dependency.name));
  const vulnerable = new Set(
    (input.findings ?? []).filter(hasOwnAdvisory).map((finding) => finding.name)
  );

  // Resolved in two passes so `@types/x` can see whether `x` itself is used.
  const directlyUsed = new Set(
    declared
      .filter((dependency) => {
        const bins = input.binNames?.get(dependency.name) ?? [];
        return (
          (input.imports.get(dependency.name) ?? []).length > 0 ||
          scriptEvidence(dependency.name, input.scripts, bins).length > 0 ||
          configEvidence(dependency.name, input.configText).length > 0
        );
      })
      .map((dependency) => dependency.name)
  );

  const assessed = declared.map((dependency) => ({
    dependency,
    evidence: evidenceFor(dependency, input, directlyUsed),
  }));

  const unreferencedNames = assessed
    .filter((entry) => entry.evidence.length === 0)
    .map((entry) => entry.dependency.name);

  const unreferenced = assessed
    .filter((entry) => entry.evidence.length === 0)
    .map((entry) => ({
      ...entry.dependency,
      ...uniquelyCarried(
        graph,
        entry.dependency.name,
        [...declaredNames].filter((name) => !unreferencedNames.includes(name)),
        vulnerable
      ),
    }));

  const phantom = [...input.imports.entries()]
    .filter(([name]) => !declaredNames.has(name))
    .map(([name, importedIn]) => ({
      name,
      importedIn,
      resolvable: graph.instancesOf(name).length > 0,
    }));

  const deadOverrides = readDeclarations(input.overrides ?? {})
    .filter((declaration) => graph.instancesOf(declaration.name).length === 0)
    .map((declaration) => ({
      name: declaration.name,
      scopeKey: declaration.scopeKey,
      declared: declaration.range,
    }));

  return {
    used: assessed
      .filter((entry) => entry.evidence.length > 0)
      .map((entry) => ({ ...entry.dependency, evidence: entry.evidence })),
    unreferenced,
    phantom,
    deadOverrides,
  };
};
