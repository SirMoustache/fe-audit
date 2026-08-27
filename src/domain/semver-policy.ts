import semver from 'semver';

/** A package name as it appears in a dependency graph, e.g. `flatted` or `@scope/pkg`. */
export type PackageName = string;

/** A concrete published version, e.g. `3.4.4`. */
export type Version = string;

/** A dependency range as declared in a manifest, e.g. `^3.2.9` or `npm:foo@^1`. */
export type RangeSpec = string;

/**
 * Range membership as three states. An unparseable range is not the same as
 * "does not match", and collapsing the two is how a tool ends up silently
 * recommending an upgrade it never actually checked.
 */
export type RangeVerdict = boolean | null;

const MATCH = { includePrerelease: true, loose: true } as const;

const ALIAS_RANGE = /^npm:(?:@[^/]+\/)?[^@]+@(.+)$/;

/**
 * `"foo": "npm:bar@^1.2.3"` constrains versions exactly like `^1.2.3` does.
 * Other protocols (file:, git:, workspace:, catalog:) carry no comparable
 * constraint and stay deliberately unparseable.
 */
export const normalizeRange = (range: RangeSpec): RangeSpec => {
  const alias = ALIAS_RANGE.exec(range);
  return alias?.[1] ?? range;
};

export const isStable = (version: string): boolean =>
  Boolean(semver.valid(version)) && semver.prerelease(version) === null;

/**
 * `satisfies` in loose mode answers `false` for gibberish rather than throwing,
 * so the range has to be validated explicitly first.
 */
export const testRange = (version: Version, range: RangeSpec): RangeVerdict => {
  if (typeof range !== 'string') return null;
  const normalized = normalizeRange(range);
  if (semver.validRange(normalized, MATCH) === null) return null;
  try {
    return semver.satisfies(version, normalized, MATCH);
  } catch {
    return null;
  }
};

export const accepts = (range: RangeSpec, version: Version): boolean =>
  testRange(version, range) === true;

export const isExpressible = (range: RangeSpec): boolean => testRange('1.0.0', range) !== null;

export const isExactVersion = (range: RangeSpec): boolean => Boolean(semver.valid(range));

/**
 * Under semver a 0.x minor bump is breaking, so `axios 0.21 -> 0.33` carries the
 * same risk as `css-select 2 -> 4`. `^0.0.z` pins a single patch, so 0.0.x bumps
 * are breaking too. Comparing major numbers alone would wave both through.
 */
export const isBreakingUpgrade = (from: Version, to: Version): boolean => {
  if (!semver.valid(from) || !semver.valid(to)) return true;
  if (semver.major(from) !== semver.major(to)) return true;
  if (semver.major(from) !== 0) return false;
  if (semver.minor(from) !== semver.minor(to)) return true;
  return semver.minor(from) === 0 && semver.patch(from) !== semver.patch(to);
};

export type EscapeVersion =
  | { readonly found: true; readonly version: Version }
  | { readonly found: false; readonly reason: string };

/**
 * The lowest published version that escapes the advisory without going backwards
 * from what is installed.
 */
export const findEscapeVersion = (
  versions: readonly Version[],
  advisoryRange: RangeSpec,
  installed: Version
): EscapeVersion => {
  if (!semver.valid(installed)) {
    return { found: false, reason: `installed version "${installed}" is not semver` };
  }

  const upgrades = versions
    .filter(isStable)
    .filter((version) => semver.gt(version, installed))
    .sort(semver.compare);

  for (const version of upgrades) {
    const vulnerable = testRange(version, advisoryRange);
    if (vulnerable === null) {
      return { found: false, reason: `advisory range is unparseable: ${advisoryRange}` };
    }
    if (!vulnerable) return { found: true, version };
  }

  return {
    found: false,
    reason: `no published release above ${installed} escapes ${advisoryRange}`,
  };
};

export const isAheadOf = (version: Version, range: RangeSpec): boolean => {
  const floor = rangeFloor(range);
  return floor !== null && semver.gt(version, floor);
};

/** The lowest version a range would accept, or `null` if it has none. */
export const rangeFloor = (range: RangeSpec): Version | null => {
  try {
    return semver.minVersion(normalizeRange(range))?.version ?? null;
  } catch {
    return null;
  }
};
