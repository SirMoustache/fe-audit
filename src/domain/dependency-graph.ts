import type { PackageName, RangeSpec, Version } from './semver-policy';

const ROOT = '';
const NODE_MODULES = 'node_modules/';
const NESTED = '/node_modules/';

/** The subset of `package-lock.json` this tool reads. */
export interface LockfileEntry {
  readonly name?: string;
  readonly version?: Version;
  readonly dependencies?: Readonly<Record<string, RangeSpec>>;
  readonly devDependencies?: Readonly<Record<string, RangeSpec>>;
  readonly optionalDependencies?: Readonly<Record<string, RangeSpec>>;
  readonly peerDependencies?: Readonly<Record<string, RangeSpec>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
}

export interface Lockfile {
  readonly lockfileVersion?: number;
  readonly packages?: Readonly<Record<string, LockfileEntry>>;
}

export interface Manifest {
  readonly name?: string;
  readonly dependencies?: Readonly<Record<string, RangeSpec>>;
  readonly devDependencies?: Readonly<Record<string, RangeSpec>>;
  readonly optionalDependencies?: Readonly<Record<string, RangeSpec>>;
  readonly overrides?: OverrideTree;
  readonly resolutions?: unknown;
  readonly packageManager?: string;
}

/** npm's override grammar: a version, or a nested map scoping a package's children. */
export type OverrideTree = { readonly [key: string]: RangeSpec | OverrideTree };

/** One physical copy of a package in the installed tree. */
export interface PackageInstance {
  /** The directory name under `node_modules`, which npm keys overrides by. */
  readonly treeName: PackageName;
  /** The real package name, which differs from `treeName` for aliased installs. */
  readonly name: PackageName;
  readonly path: string;
  readonly version: Version;
}

/** A declaration of a dependency by some package in the tree. */
export interface Consumer {
  readonly declarerPath: string;
  /** `null` when the root project is the declarer. */
  readonly declarerName: PackageName | null;
  readonly declarerVersion: Version | undefined;
  readonly field: string;
  readonly name: PackageName;
  readonly range: RangeSpec;
  readonly resolvedPath: string | null;
}

export interface DirectDependency {
  readonly field: string;
  readonly range: RangeSpec;
}

export interface DependencyGraph {
  readonly lockfileVersion: number | undefined;
  instancesOf(name: PackageName): readonly PackageInstance[];
  consumersOf(name: PackageName): readonly Consumer[];
  consumersOfInstance(instance: PackageInstance): readonly Consumer[];
  /** What this copy itself declares, with each declaration already resolved. */
  dependenciesOf(instance: PackageInstance): readonly Consumer[];
  /** Names reachable from the root's non-dev dependencies, i.e. shipped code. */
  productionNames(): ReadonlySet<PackageName>;
  isHoisted(instance: PackageInstance): boolean;
  scopeKeysFor(instance: PackageInstance): readonly PackageName[];
  instancesGovernedBy(scopeKey: PackageName, name: PackageName): ReadonlySet<string>;
  directDependency(name: PackageName): DirectDependency | null;
  resolve(fromPath: string, name: PackageName): string | null;
}

const DECLARATION_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;

// devDependencies of a dependency are never installed, so they constrain
// nothing. The root's devDependencies ARE installed, so the root is a genuine
// consumer of them and its declared range has to be honoured like any other.
const ROOT_DECLARATION_FIELDS = [...DECLARATION_FIELDS, 'devDependencies'] as const;

type DeclarationField = (typeof ROOT_DECLARATION_FIELDS)[number];

const fieldsFor = (declarerPath: string): readonly DeclarationField[] =>
  declarerPath === ROOT ? ROOT_DECLARATION_FIELDS : DECLARATION_FIELDS;

export const packageNameFrom = (installPath: string): PackageName | null => {
  const match = /node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(installPath);
  return match?.[1] ?? null;
};

export const hoistedPathFor = (name: PackageName): string => NODE_MODULES + name;

/** Every directory node resolution would consult, walking from the dependent outwards. */
export const lookupChain = (fromPath: string): readonly string[] => {
  const chain: string[] = [];
  let current = fromPath;
  for (;;) {
    chain.push(current);
    const boundary = current.lastIndexOf(NESTED);
    if (boundary === -1) break;
    current = current.slice(0, boundary);
  }
  if (chain[chain.length - 1] !== ROOT) chain.push(ROOT);
  return chain;
};

const isOptionalPeer = (entry: LockfileEntry, name: string): boolean =>
  entry.peerDependenciesMeta?.[name]?.optional === true;

const declarationsIn = (
  declarerPath: string,
  entry: LockfileEntry
): readonly Omit<Consumer, 'resolvedPath'>[] =>
  fieldsFor(declarerPath).flatMap((field) =>
    Object.entries(entry[field] ?? {})
      .filter(([name]) => !(field === 'peerDependencies' && isOptionalPeer(entry, name)))
      .map(([name, range]) => ({
        declarerPath,
        declarerName: declarerPath === ROOT ? null : packageNameFrom(declarerPath),
        declarerVersion: entry.version,
        field,
        name,
        range,
      }))
  );

const groupBy = <T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> =>
  items.reduce((map, item) => {
    const k = key(item);
    return map.set(k, [...(map.get(k) ?? []), item]);
  }, new Map<string, T[]>());

/**
 * A read model of the installed tree.
 *
 * It owns one rule the rest of the tool depends on being consistent: npm keys a
 * scoped override by the package that DECLARES the dependency, not by the
 * directory the copy happens to sit in. Those differ whenever npm hoists, and
 * having two implementations of it is how they drift apart.
 */
export const buildDependencyGraph = (
  lockfile: Lockfile,
  { manifest }: { manifest?: Manifest } = {}
): DependencyGraph => {
  const packages = lockfile.packages;
  if (!packages) {
    throw new Error(
      `lockfileVersion ${lockfile.lockfileVersion} has no "packages" map. ` +
        'Run `npm install --package-lock-only` to migrate to lockfileVersion 3 first.'
    );
  }

  const entries = Object.entries(packages);
  const root = packages[ROOT] ?? {};

  // An aliased install (`"x-cjs": "npm:x@^4"`) sits at node_modules/x-cjs while
  // being the package `x`. Advisories name the real package; npm keys overrides
  // and resolution by the alias. Both names have to be carried.
  const allInstances: readonly PackageInstance[] = entries.flatMap(([installPath, entry]) => {
    const treeName = packageNameFrom(installPath);
    if (treeName === null) return [];
    return [
      {
        treeName,
        name: entry.name ?? treeName,
        path: installPath,
        version: entry.version ?? '',
      },
    ];
  });

  const instancesByName = allInstances.reduce((map, instance) => {
    for (const key of new Set([instance.name, instance.treeName])) {
      map.set(key, [...(map.get(key) ?? []), instance]);
    }
    return map;
  }, new Map<PackageName, PackageInstance[]>());

  const resolve = (fromPath: string, name: PackageName): string | null =>
    lookupChain(fromPath)
      .map((prefix) => (prefix === ROOT ? '' : `${prefix}/`) + NODE_MODULES + name)
      .find((candidate) => packages[candidate] !== undefined) ?? null;

  const consumersByName = groupBy(
    entries
      .flatMap(([declarerPath, entry]) => declarationsIn(declarerPath, entry))
      .map((declaration) => ({
        ...declaration,
        resolvedPath: resolve(declaration.declarerPath, declaration.name),
      })),
    (declaration) => declaration.name
  );

  const declarationsByDeclarer = groupBy(
    [...consumersByName.values()].flat(),
    (declaration) => declaration.declarerPath
  );

  const instancesOf = (name: PackageName): readonly PackageInstance[] =>
    instancesByName.get(name) ?? [];

  const consumersOf = (name: PackageName): readonly Consumer[] => consumersByName.get(name) ?? [];

  const dependenciesOf = (instance: PackageInstance): readonly Consumer[] =>
    declarationsByDeclarer.get(instance.path) ?? [];

  const instanceAt = (installPath: string): PackageInstance | undefined =>
    allInstances.find((candidate) => candidate.path === installPath);

  /**
   * Whether a package can reach shipped code. A ReDoS in a lint cache that runs
   * on a build agent is not the same risk as one in the application bundle, and
   * the distinction changes how urgently a finding needs fixing.
   */
  let production: Set<PackageName> | null = null;
  const productionNames = (): ReadonlySet<PackageName> => {
    if (production) return production;

    const seen = new Set<PackageName>();
    const queue = (declarationsByDeclarer.get(ROOT) ?? []).filter(
      (declaration) => declaration.field !== 'devDependencies'
    );

    while (queue.length > 0) {
      const declaration = queue.pop() as Consumer;
      if (!declaration.resolvedPath) continue;
      const instance = instanceAt(declaration.resolvedPath);
      if (!instance || seen.has(instance.treeName)) continue;
      seen.add(instance.treeName);
      seen.add(instance.name);
      queue.push(...dependenciesOf(instance));
    }

    production = seen;
    return production;
  };

  /** Consumers are matched by the name they declare, which is the tree name. */
  const consumersOfInstance = (instance: PackageInstance): readonly Consumer[] =>
    consumersOf(instance.treeName).filter((consumer) => consumer.resolvedPath === instance.path);

  const isHoisted = (instance: PackageInstance): boolean =>
    instance.path === hoistedPathFor(instance.treeName);

  const scopeKeysFor = (instance: PackageInstance): readonly PackageName[] =>
    isHoisted(instance)
      ? []
      : [
          ...new Set(
            consumersOfInstance(instance)
              .map((consumer) => consumer.declarerName)
              .filter((name): name is PackageName => name !== null)
          ),
        ];

  const instancesGovernedBy = (
    scopeKey: PackageName,
    name: PackageName
  ): ReadonlySet<string> =>
    new Set(
      consumersOf(name)
        .filter((consumer) => consumer.declarerName === scopeKey && consumer.resolvedPath !== null)
        .map((consumer) => consumer.resolvedPath as string)
    );

  // npm validates overrides against package.json, not against the lockfile's
  // copy of it. A lockfile that has drifted would otherwise let a top-level
  // override be written for a direct dependency, which npm rejects outright
  // with EOVERRIDE.
  const declaredBy: Manifest | LockfileEntry = manifest ?? root;

  const directDependency = (name: PackageName): DirectDependency | null => {
    const fields = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
    for (const field of fields) {
      const range = declaredBy[field]?.[name];
      if (range !== undefined) return { field, range };
    }
    return null;
  };

  return Object.freeze({
    lockfileVersion: lockfile.lockfileVersion,
    instancesOf,
    consumersOf,
    consumersOfInstance,
    dependenciesOf,
    productionNames,
    isHoisted,
    scopeKeysFor,
    instancesGovernedBy,
    directDependency,
    resolve,
  });
};
