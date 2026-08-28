import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import type { Lockfile } from '../src/domain/dependency-graph';
import { buildDependencyGraph, lookupChain } from '../src/domain/dependency-graph';
import type { AuditEntry, AuditReport } from '../src/domain/finding';
import { hasOwnAdvisory, readFindings } from '../src/domain/finding';
import { mergeOverrides, planOverrides } from '../src/domain/override-set';
import { assessProject } from '../src/domain/project-health';
import type { OverrideRemedy, Remediation, VersionsFor } from '../src/domain/remediation';
import { classifyAll, classifyFinding } from '../src/domain/remediation';
import {
  accepts,
  findEscapeVersion,
  isAheadOf,
  isBreakingUpgrade,
  isExpressible,
} from '../src/domain/semver-policy';
import { assessOverrides } from '../src/domain/verification';
import { readDeclarations } from '../src/domain/override-set';
import { explainPackage, hasForcedBreaking } from '../src/domain/explanation';
import { analyseUsage } from '../src/domain/usage';
import { assessOverridesForPruning, pruneOverrides } from '../src/domain/pruning';
import { emptyKnowledge } from '../src/domain/advisory';
import { parseJsonc, specifierToPackage } from '../src/infrastructure/source-scanner';
import { groupRemediations } from '../src/features/remediate';
import { assertUsableReport } from '../src/infrastructure/npm-client';
import { mapWithConcurrency } from '../src/infrastructure/pool';

let passed = 0;

const describe = (name: string, fn: () => void): void => {
  console.log(`\n${name}`);
  fn();
};

const it = (label: string, fn: () => void): void => {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
};

/**
 * One fixture covering every shape the classifier has to tell apart: a
 * stale-but-in-range copy, a breaking upgrade, two majors side by side, an exact
 * pin, a direct dependency, an aliased install, and a copy whose directory
 * parent is NOT the package that declared it.
 */
const LOCKFILE: Lockfile = {
  lockfileVersion: 3,
  packages: {
    '': { dependencies: { next: '^12.3.5' }, devDependencies: { eslint: '^7.13.0' } },

    'node_modules/eslint': { version: '7.32.0', dependencies: { 'file-entry-cache': '^6.0.1' } },
    'node_modules/file-entry-cache': { version: '6.0.1', dependencies: { 'flat-cache': '^3.0.4' } },
    'node_modules/flat-cache': { version: '3.1.1', dependencies: { flatted: '^3.2.9' } },
    'node_modules/flatted': { version: '3.2.9' },

    'node_modules/svgo': { version: '1.3.2', dependencies: { 'css-select': '^2.0.0' } },
    'node_modules/css-select': { version: '2.1.0' },

    'node_modules/ws': { version: '7.5.13' },
    'node_modules/jsdom': { version: '20.0.0', dependencies: { ws: '^8.0.0' } },
    'node_modules/jsdom/node_modules/ws': { version: '8.16.0' },

    'node_modules/express': { version: '4.21.2', dependencies: { cookie: '0.7.1' } },
    'node_modules/cookie': { version: '0.7.1' },

    'node_modules/next': { version: '12.3.7' },

    'node_modules/string-width-cjs': { name: 'string-width', version: '4.2.0' },

    'node_modules/graphql-config': { version: '3.0.0', dependencies: { glob: '^7.0.0' } },
    'node_modules/graphql-config/node_modules/glob': {
      version: '7.1.0',
      dependencies: { minimatch: '^3.0.0' },
    },
    'node_modules/graphql-config/node_modules/minimatch': { version: '3.0.4' },
  },
};

const graph = buildDependencyGraph(LOCKFILE);

const REGISTRY: Readonly<Record<string, readonly string[]>> = {
  flatted: ['3.2.9', '3.4.2', '3.4.4'],
  'css-select': ['2.1.0', '3.0.0', '4.3.0'],
  cookie: ['0.7.1', '0.7.2'],
  next: ['12.3.7', '16.3.3'],
  ws: ['7.5.13', '8.16.0', '8.21.0'],
  minimatch: ['3.0.4', '3.1.4'],
  'string-width': ['4.2.0', '4.2.3'],
};

const versionsFor: VersionsFor = (name) => {
  const versions = REGISTRY[name];
  return versions ? { ok: true, versions } : { ok: false, reason: 'unknown package' };
};

const finding = (name: string, range: string, extra: Partial<AuditEntry> = {}) => {
  const report: AuditReport = {
    vulnerabilities: {
      [name]: {
        name,
        severity: 'high',
        range,
        isDirect: false,
        via: [{ title: `${name} advisory` }],
        ...extra,
      },
    },
  };
  return readFindings(report)[0]!;
};

const only = (name: string, range: string, extra?: Partial<AuditEntry>): Remediation => {
  const results = classifyFinding(finding(name, range, extra), graph, versionsFor);
  assert.strictEqual(results.length, 1, `expected exactly one remediation for ${name}`);
  return results[0]!;
};

const overridesOf = (
  remediations: readonly Remediation[],
  options?: Parameters<typeof planOverrides>[1]
) => planOverrides(remediations, options).overrides;

describe('semver-policy', () => {
  it('finds the lowest release above the installed version', () => {
    assert.deepStrictEqual(findEscapeVersion(['3.2.9', '3.3.0', '3.4.2', '3.4.4'], '<=3.4.1', '3.2.9'), {
      found: true,
      version: '3.4.2',
    });
  });

  it('ignores prereleases', () => {
    const result = findEscapeVersion(['1.0.0', '2.0.0-beta.1', '2.0.0'], '<2.0.0', '1.0.0');
    assert.strictEqual(result.found && result.version, '2.0.0');
  });

  it('refuses to guess when the advisory range is unparseable', () => {
    const result = findEscapeVersion(['1.0.0', '2.0.0'], 'not-a-range', '1.0.0');
    assert.strictEqual(result.found, false);
    assert.match(result.found ? '' : result.reason, /unparseable/);
  });

  it('reports when nothing published escapes the advisory', () => {
    assert.strictEqual(findEscapeVersion(['1.0.0', '1.1.0'], '*', '1.0.0').found, false);
  });

  it('treats a major bump as breaking', () => {
    assert.strictEqual(isBreakingUpgrade('2.1.0', '4.3.0'), true);
  });

  it('treats a 0.x minor bump as breaking (axios 0.21 -> 0.33)', () => {
    assert.strictEqual(isBreakingUpgrade('0.21.4', '0.33.0'), true);
  });

  it('treats patch and post-1.0 minor bumps as non-breaking', () => {
    assert.strictEqual(isBreakingUpgrade('0.7.1', '0.7.2'), false);
    assert.strictEqual(isBreakingUpgrade('1.20.3', '1.20.6'), false);
  });

  it('treats a 0.0.z bump as breaking, since ^0.0.1 pins one patch', () => {
    assert.strictEqual(isBreakingUpgrade('0.0.1', '0.0.2'), true);
  });

  it('detects a resolved version ahead of the declared floor', () => {
    assert.strictEqual(isAheadOf('4.0.4', '^2.3.1'), true);
    assert.strictEqual(isAheadOf('2.0.0', '^2.3.1'), false);
  });

  it('never treats an unparseable consumer range as acceptance', () => {
    assert.strictEqual(accepts('not-a-range', '1.0.0'), false);
  });

  it('reads an npm: alias range as the range it constrains', () => {
    assert.strictEqual(accepts('npm:string-width@^4.2.0', '4.2.3'), true);
    assert.strictEqual(accepts('npm:string-width@^4.2.0', '5.0.0'), false);
  });

  it('treats non-registry protocols as inexpressible constraints', () => {
    for (const range of ['file:../x', 'workspace:^1.0.0', 'github:u/r']) {
      assert.strictEqual(accepts(range, '1.0.0'), false);
      assert.strictEqual(isExpressible(range), false);
    }
  });
});

describe('dependency-graph', () => {
  const instanceAt = (name: string, instancePath: string) =>
    graph.instancesOf(name).find((instance) => instance.path === instancePath)!;

  it('walks node_modules ancestors outward', () => {
    assert.deepStrictEqual(lookupChain('node_modules/a/node_modules/b'), [
      'node_modules/a/node_modules/b',
      'node_modules/a',
      '',
    ]);
  });

  it('lets a nested copy shadow the hoisted one', () => {
    assert.strictEqual(
      graph.resolve('node_modules/jsdom', 'ws'),
      'node_modules/jsdom/node_modules/ws'
    );
    assert.strictEqual(graph.resolve('node_modules/svgo', 'ws'), 'node_modules/ws');
  });

  it('scopes an override by the DECLARING package, not the directory parent', () => {
    assert.deepStrictEqual(
      graph.scopeKeysFor(
        instanceAt('minimatch', 'node_modules/graphql-config/node_modules/minimatch')
      ),
      ['glob']
    );
  });

  it('leaves a hoisted copy unscoped', () => {
    assert.deepStrictEqual(graph.scopeKeysFor(instanceAt('flatted', 'node_modules/flatted')), []);
  });

  it('finds an aliased install under its real package name', () => {
    const aliased = graph.instancesOf('string-width');
    assert.deepStrictEqual(
      aliased.map((instance) => instance.path),
      ['node_modules/string-width-cjs']
    );
    assert.strictEqual(aliased[0]!.treeName, 'string-width-cjs');
  });

  it('counts the root as a consumer of its devDependencies', () => {
    assert.deepStrictEqual(
      graph.consumersOf('eslint').map((consumer) => consumer.range),
      ['^7.13.0']
    );
  });

  it('knows which copies a scope key governs', () => {
    assert.deepStrictEqual([...graph.instancesGovernedBy('jsdom', 'ws')], [
      'node_modules/jsdom/node_modules/ws',
    ]);
  });

  it('recognises root dependencies', () => {
    assert.deepStrictEqual(graph.directDependency('next'), {
      field: 'dependencies',
      range: '^12.3.5',
    });
    assert.strictEqual(graph.directDependency('flatted'), null);
  });

  it('rejects a lockfile too old to support overrides', () => {
    assert.throws(() => buildDependencyGraph({ lockfileVersion: 1 }), /lockfileVersion 1/);
  });
});

describe('finding', () => {
  it('separates own advisories from inherited ones', () => {
    assert.strictEqual(hasOwnAdvisory(finding('flatted', '<=3.4.1')), true);

    const inherited = readFindings({
      vulnerabilities: {
        'sitecore-jss': { name: 'sitecore-jss', severity: 'high', range: '*', via: ['axios'] },
      },
    })[0]!;
    assert.strictEqual(hasOwnAdvisory(inherited), false);
    assert.deepStrictEqual(inherited.inheritedFrom, ['axios']);
  });
});

describe('remediation', () => {
  it('classifies a stale in-range copy as a SAFE override', () => {
    const result = only('flatted', '<=3.4.1') as OverrideRemedy;
    assert.strictEqual(result.kind, 'override');
    assert.strictEqual(result.tier, 'safe');
    assert.strictEqual(result.to, '3.4.2');
    assert.deepStrictEqual(result.rejectedBy, []);
  });

  it('refuses a breaking upgrade its consumer would reject (css-select/svgo)', () => {
    const result = only('css-select', '<3.1.0');
    assert.strictEqual(result.kind, 'risky');
    assert.deepStrictEqual(
      result.kind === 'risky' ? result.rejectedBy.map((c) => `${c.name} ${c.range}`) : [],
      ['svgo ^2.0.0']
    );
  });

  it('allows a non-breaking bump past an exact pin, as TIGHT', () => {
    const result = only('cookie', '<0.7.2') as OverrideRemedy;
    assert.strictEqual(result.tier, 'tight');
    assert.deepStrictEqual(result.rejectedBy.map((c) => c.range), ['0.7.1']);
  });

  it('routes a direct dependency to an upgrade, never an override', () => {
    const result = only('next', '<16.0.0', { isDirect: true });
    assert.strictEqual(result.kind, 'direct-upgrade');
    assert.strictEqual(result.kind === 'direct-upgrade' && result.declared, '^12.3.5');
  });

  it('reads direct dependencies from package.json, not the drifted lockfile', () => {
    const drifted = buildDependencyGraph(
      { lockfileVersion: 3, packages: { '': {}, 'node_modules/axios': { version: '1.3.5' } } },
      { manifest: { dependencies: { axios: '^1.3.5' } } }
    );
    const [result] = classifyFinding(finding('axios', '<1.20.0'), drifted, () => ({
      ok: true,
      versions: ['1.3.5', '1.20.0'],
    }));
    assert.strictEqual(result!.kind, 'direct-upgrade');
  });

  it('passes inherited findings through untouched', () => {
    const inherited = readFindings({
      vulnerabilities: {
        'sitecore-jss': { name: 'sitecore-jss', severity: 'high', range: '*', via: ['axios'] },
      },
    })[0]!;
    assert.strictEqual(classifyFinding(inherited, graph, versionsFor)[0]!.kind, 'inherited');
  });

  it('reports a package missing from the lockfile as absent', () => {
    assert.strictEqual(
      classifyFinding(finding('unknown-pkg', '<1.0.0'), graph, versionsFor)[0]!.kind,
      'absent'
    );
  });

  it('surfaces a registry outage as unresolvable, not as safe', () => {
    const [result] = classifyFinding(finding('flatted', '<=3.4.1'), graph, () => ({
      ok: false,
      reason: 'registry lookup failed',
    }));
    assert.strictEqual(result!.kind, 'unresolvable');
  });

  it('emits one remediation per installed copy', () => {
    assert.strictEqual(classifyFinding(finding('ws', '<8.21.0'), graph, versionsFor).length, 2);
  });

  // Found against a real project. npm reports one finding per package, listing
  // only the vulnerable paths, but every copy of the name was being classified.
  // For a copy already above the range the escape search looks *above* it and
  // returns the next major, which consumers reject - so a patched copy was
  // reported as "DO NOT OVERRIDE, upgrade the parent instead".
  it('ignores a copy already above the advisory range', () => {
    const results = classifyFinding(finding('ws', '<8.0.0'), graph, versionsFor);
    assert.strictEqual(results.length, 1);
    assert.strictEqual((results[0] as OverrideRemedy).instancePath, 'node_modules/ws');
  });

  it('does not demand the next major of a copy that is already patched', () => {
    // 7.5.13 and 8.16.0 both sit above this range, as ws did after audit fix.
    const results = classifyFinding(finding('ws', '>=7.0.0 <7.5.11'), graph, versionsFor);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0]!.kind, 'absent');
    assert.ok(!results.some((remedy) => remedy.kind === 'risky'));
  });

  it('still classifies a copy when the advisory range cannot be parsed', () => {
    // Unreadable must not read as "not affected", which would drop the finding.
    const results = classifyFinding(finding('ws', 'not-a-range'), graph, versionsFor);
    assert.ok(results.every((remedy) => remedy.kind !== 'absent'));
  });

  it('refuses a nested copy with no attributable declarer instead of overriding globally', () => {
    const orphanGraph = buildDependencyGraph({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { app: '^1.0.0' } },
        'node_modules/app': { version: '1.0.0', dependencies: { foo: '^1.0.0' } },
        'node_modules/foo': { version: '1.0.0' },
        'node_modules/bar': {
          version: '1.0.0',
          peerDependencies: { foo: '^2.0.0' },
          peerDependenciesMeta: { foo: { optional: true } },
        },
        'node_modules/bar/node_modules/foo': { version: '2.0.0' },
      },
    });
    const results = classifyFinding(finding('foo', '<2.0.1'), orphanGraph, () => ({
      ok: true,
      versions: ['1.0.0', '2.0.0', '2.0.1'],
    }));

    const orphan = results.find(
      (remedy) => 'instancePath' in remedy && remedy.instancePath === 'node_modules/bar/node_modules/foo'
    )!;
    assert.strictEqual(orphan.kind, 'unresolvable');
    assert.deepStrictEqual(overridesOf(results), {});
  });

  it('keys an override for an aliased copy by its tree name', () => {
    const result = only('string-width', '<4.2.3') as OverrideRemedy;
    assert.strictEqual(result.overrideName, 'string-width-cjs');
    assert.deepStrictEqual(overridesOf([result]), { 'string-width-cjs': '4.2.3' });
  });
});

describe('override-set', () => {
  const remediations = classifyAll(
    [finding('flatted', '<=3.4.1'), finding('minimatch', '<3.1.4'), finding('cookie', '<0.7.2')],
    graph,
    versionsFor
  );

  it('emits a flat override for a hoisted copy', () => {
    assert.strictEqual(overridesOf(remediations)['flatted'], '3.4.2');
  });

  it('emits a scoped override keyed by the declaring package', () => {
    assert.deepStrictEqual(overridesOf(remediations)['glob'], { minimatch: '3.1.4' });
  });

  it('never writes risky remediations', () => {
    assert.deepStrictEqual(
      overridesOf(classifyFinding(finding('css-select', '<3.1.0'), graph, versionsFor)),
      {}
    );
  });

  it('withholds TIGHT overrides unless explicitly included', () => {
    assert.strictEqual(overridesOf(remediations)['cookie'], undefined);
    assert.strictEqual(overridesOf(remediations, { includeTight: true })['cookie'], '0.7.2');
  });

  it('combines a package overridden AND scoped using the "." key', () => {
    const base = { kind: 'override', tier: 'safe', severity: 'high' } as const;
    assert.deepStrictEqual(
      overridesOf([
        { ...base, name: 'ws', overrideName: 'ws', to: '7.5.13', scopeKeys: [] },
        { ...base, name: 'thing', overrideName: 'thing', to: '1.0.0', scopeKeys: ['ws'] },
      ] as unknown as Remediation[]),
      { ws: { '.': '7.5.13', thing: '1.0.0' } }
    );
  });

  it('withholds a target two same-named parents disagree on, rather than picking one', () => {
    const base = { kind: 'override', tier: 'safe', severity: 'high', name: 'minimatch', overrideName: 'minimatch' } as const;
    const plan = planOverrides([
      { ...base, to: '3.1.4', scopeKeys: ['glob'] },
      { ...base, to: '9.0.5', scopeKeys: ['glob'] },
    ] as unknown as Remediation[]);
    assert.deepStrictEqual(plan.overrides, {});
    assert.deepStrictEqual(plan.conflicts[0]!.candidates, ['3.1.4', '9.0.5']);
  });

  it('never emits a top-level override for a direct dependency (npm EOVERRIDE)', () => {
    const remedy = {
      kind: 'override',
      tier: 'safe',
      severity: 'high',
      name: 'axios',
      overrideName: 'axios',
      to: '1.20.1',
      scopeKeys: [],
    } as unknown as Remediation;
    const plan = planOverrides([remedy], { isDirectDependency: (name) => name === 'axios' });
    assert.deepStrictEqual(plan.overrides, {});
    assert.match(plan.conflicts[0]!.reason, /EOVERRIDE/);
  });

  it('still scopes a direct dependency under a parent, which npm allows', () => {
    const remedy = {
      kind: 'override',
      tier: 'safe',
      severity: 'high',
      name: 'axios',
      overrideName: 'axios',
      to: '0.21.4',
      scopeKeys: ['@sitecore-jss/sitecore-jss'],
    } as unknown as Remediation;
    const plan = planOverrides([remedy], { isDirectDependency: (name) => name === 'axios' });
    assert.deepStrictEqual(plan.overrides, {
      '@sitecore-jss/sitecore-jss': { axios: '0.21.4' },
    });
    assert.deepStrictEqual(plan.conflicts, []);
  });

  it('merges into existing overrides without destroying a nested scope', () => {
    assert.deepStrictEqual(mergeOverrides({ glob: { minimatch: '3.1.4' } }, { glob: '7.2.3' }), {
      glob: { '.': '7.2.3', minimatch: '3.1.4' },
    });
  });

  it('merges deterministically', () => {
    assert.deepStrictEqual(Object.keys(mergeOverrides({ zzz: '1.0.0' }, { aaa: '2.0.0' })), [
      'aaa',
      'zzz',
    ]);
  });
});

describe('verification', () => {
  const vulnerable = new Set(['minimatch']);

  const verdictOf = (
    overrides: Parameters<typeof assessOverrides>[0]['overrides'],
    name: string,
    scopeKey: string | null = null
  ) =>
    assessOverrides({ graph, overrides, vulnerableNames: vulnerable })
      .filter((a) => a.name === name && a.scopeKey === scopeKey)
      .map((a) => a.verdict);

  it("flattens npm's nested override grammar", () => {
    assert.deepStrictEqual(
      readDeclarations({ ws: '7.5.13', jsdom: { ws: '8.21.0' }, express: { '.': '4.22.0' } }),
      [
        { name: 'ws', scopeKey: null, range: '7.5.13' },
        { name: 'ws', scopeKey: 'jsdom', range: '8.21.0' },
        { name: 'express', scopeKey: null, range: '4.22.0' },
      ]
    );
  });

  it('reports an honoured exact override as PINNED', () => {
    assert.deepStrictEqual(verdictOf({ flatted: '3.2.9' }, 'flatted'), ['pinned']);
  });

  it('does not judge a scoped copy against the flat override', () => {
    assert.deepStrictEqual(verdictOf({ ws: '7.5.13', jsdom: { ws: '^8.0.0' } }, 'ws'), ['pinned']);
    assert.deepStrictEqual(verdictOf({ ws: '7.5.13', jsdom: { ws: '^8.0.0' } }, 'ws', 'jsdom'), [
      'range',
    ]);
  });

  it('calls a newer resolved copy AHEAD rather than a failure', () => {
    assert.deepStrictEqual(verdictOf({ cookie: '0.5.0' }, 'cookie'), ['ahead']);
  });

  it('fails only when the package is still in the audit', () => {
    assert.deepStrictEqual(verdictOf({ glob: { minimatch: '3.1.4' } }, 'minimatch', 'glob'), [
      'still-vulnerable',
    ]);
  });

  it('calls a divergence benign when the audit is clean', () => {
    assert.deepStrictEqual(
      assessOverrides({
        graph,
        overrides: { glob: { minimatch: '3.1.4' } },
        vulnerableNames: new Set(),
      }).map((a) => a.verdict),
      ['diverged']
    );
  });

  it('marks an override with nothing to act on as INERT', () => {
    assert.deepStrictEqual(verdictOf({ hoek: '^6.1.3' }, 'hoek'), ['inert']);
  });

  it('does not call an override clean while the audit still lists it', () => {
    assert.deepStrictEqual(
      assessOverrides({
        graph,
        overrides: { flatted: '3.2.9' },
        vulnerableNames: new Set(['flatted']),
      }).map((a) => a.verdict),
      ['still-vulnerable']
    );
  });

  it('downgrades to a warning when several copies make the audit ambiguous', () => {
    const hoisted = assessOverrides({
      graph,
      overrides: { ws: '7.5.13' },
      vulnerableNames: new Set(['ws']),
    }).find((a) => a.instancePath === 'node_modules/ws')!;
    assert.strictEqual(hoisted.verdict, 'still-listed');
  });
});

describe('project-health', () => {
  const snapshot = (over: Partial<Parameters<typeof assessProject>[0]>) =>
    assessProject({
      dir: '/x',
      packageManager: null,
      hasOverrides: false,
      hasResolutions: false,
      hasNpmLock: true,
      hasYarnLock: false,
      lockfileVersion: 3,
      ...over,
    }).blockers;

  it('flags a lockfileVersion 1 project', () => {
    assert.match(snapshot({ lockfileVersion: 1 }).join(), /silently ignored/);
  });

  it('flags an ambiguous package manager', () => {
    assert.match(snapshot({ hasYarnLock: true }).join(), /authoritative/);
  });

  it('passes a healthy project', () => {
    assert.deepStrictEqual(snapshot({}), []);
  });
});

describe('remediate grouping', () => {
  it('sorts remediations into the tiers the report presents', () => {
    const groups = groupRemediations(
      classifyAll(
        [
          finding('flatted', '<=3.4.1'),
          finding('css-select', '<3.1.0'),
          finding('cookie', '<0.7.2'),
          finding('minimatch', '<3.1.4'),
        ],
        graph,
        versionsFor
      )
    );
    assert.deepStrictEqual(groups.safe.map((r) => r.name), ['flatted']);
    assert.deepStrictEqual(groups.risky.map((r) => r.name), ['css-select']);
    assert.deepStrictEqual(groups.tight.map((r) => r.name), ['cookie']);
    assert.deepStrictEqual(groups.scoped.map((r) => r.name), ['minimatch']);
  });
});

describe('source scanning', () => {
  it('maps a specifier to the package that owns it', () => {
    assert.strictEqual(specifierToPackage('lodash/merge'), 'lodash');
    assert.strictEqual(specifierToPackage('@scope/pkg/sub'), '@scope/pkg');
  });

  it('ignores anything that is not an installed package', () => {
    for (const specifier of ['./local', '../up', '/abs', 'node:fs', 'fs', 'path']) {
      assert.strictEqual(specifierToPackage(specifier), null, specifier);
    }
  });

  it('ignores unresolved template literals', () => {
    assert.strictEqual(specifierToPackage('${component.path}'), null);
  });

  it('ignores tsconfig path aliases', () => {
    const aliases = new Set(['components', '@/jaden-ui']);
    assert.strictEqual(specifierToPackage('components/Card', aliases), null);
    assert.strictEqual(specifierToPackage('@/jaden-ui/Button', aliases), null);
    assert.strictEqual(specifierToPackage('react', aliases), 'react');
  });

  it('strips comments without being confused by glob patterns', () => {
    // `components/*` and `**/*.ts` contain /* and */, so a regex-based
    // comment stripper swallows everything between them.
    const config = parseJsonc<{ compilerOptions: { paths: Record<string, string[]> } }>(`{
      "compilerOptions": {
        // "components/*": ["src/old/*"],
        "paths": { "components/*": ["src/components/*"] }
      },
      /* block */
      "include": ["**/*.ts"],
    }`);
    assert.deepStrictEqual(Object.keys(config.compilerOptions.paths), ['components/*']);
  });
});

describe('usage', () => {
  const usageGraph = buildDependencyGraph(
    {
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { react: '^18.0.0' }, devDependencies: { eslint: '^7.0.0' } },
        'node_modules/react': { version: '18.2.0' },
        'node_modules/eslint': { version: '7.32.0', bin: { eslint: 'bin/eslint.js' } },
        'node_modules/eslint-plugin-react': { version: '7.21.5' },
        'node_modules/mui': { version: '5.0.0', peerDependencies: { '@emotion/react': '^11' } },
        'node_modules/@emotion/react': { version: '11.10.5' },
        'node_modules/ngrok': { version: '4.0.0', dependencies: { request: '^2.88.0' } },
        'node_modules/request': { version: '2.88.2' },
        'node_modules/@types/react': { version: '18.2.28' },
      },
    },
    { manifest: {} }
  );

  const declared = [
    { name: 'react', field: 'dependencies', range: '^18.0.0' },
    { name: 'eslint', field: 'devDependencies', range: '^7.0.0' },
    { name: 'eslint-plugin-react', field: 'devDependencies', range: '^7.21.5' },
    { name: 'mui', field: 'dependencies', range: '^5.0.0' },
    { name: '@emotion/react', field: 'dependencies', range: '^11.0.0' },
    { name: 'ngrok', field: 'devDependencies', range: '^4.0.0' },
    { name: '@types/react', field: 'devDependencies', range: '^18.2.28' },
  ];

  const report = analyseUsage({
    graph: usageGraph,
    declared,
    imports: new Map([
      ['react', ['src/App.tsx']],
      ['mui', ['src/App.tsx']],
      ['left-pad', ['src/util.ts']],
    ]),
    // eslint's plugin is named in shorthand, as eslint configs always do.
    configText: new Map([['.eslintrc', '{ "plugins": ["react"] }']]),
    scripts: { lint: 'eslint ./src' },
    binNames: new Map([['eslint', ['eslint']]]),
    overrides: { 'no-longer-here': '1.0.0' },
    findings: [finding('request', '<=2.88.2')],
  });

  const kindsFor = (name: string) =>
    report.used.find((entry) => entry.name === name)?.evidence.map((e) => e.kind) ?? [];

  it('recognises an import', () => {
    assert.strictEqual(kindsFor('react').includes('imported'), true);
  });

  it('recognises a package invoked by its bin in a script', () => {
    assert.deepStrictEqual(kindsFor('eslint'), ['script']);
  });

  it('recognises a plugin named by its tool shorthand', () => {
    assert.deepStrictEqual(kindsFor('eslint-plugin-react'), ['config']);
  });

  it('recognises a peer dependency of a used package', () => {
    assert.deepStrictEqual(kindsFor('@emotion/react'), ['peer-of']);
  });

  it('recognises types for a used package', () => {
    assert.deepStrictEqual(kindsFor('@types/react'), ['types-for']);
  });

  it('reports only genuinely unreferenced dependencies', () => {
    assert.deepStrictEqual(report.unreferenced.map((entry) => entry.name), ['ngrok']);
  });

  it('quantifies what removing an unused dependency would drop', () => {
    const ngrok = report.unreferenced[0]!;
    assert.deepStrictEqual(ngrok.carriesVulnerable, ['request']);
    assert.strictEqual(ngrok.subtreeSize, 1);
  });

  it('reports an import that was never declared', () => {
    assert.deepStrictEqual(
      report.phantom.map((entry) => [entry.name, entry.resolvable]),
      [['left-pad', false]]
    );
  });

  it('reports an override with nothing left to apply to', () => {
    assert.deepStrictEqual(report.deadOverrides.map((entry) => entry.name), ['no-longer-here']);
  });
});

describe('pruning', () => {
  const pruneGraph = buildDependencyGraph(
    {
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { app: '^1.0.0' } },
        // Consumers agree on a safe version: the override is doing nothing.
        'node_modules/flat-cache': { version: '3.1.1', dependencies: { flatted: '^3.2.9' } },
        'node_modules/flatted': { version: '3.4.4' },
        // Consumers agree on a version the override pins BELOW.
        'node_modules/jsonwebtoken': { version: '9.0.3', dependencies: { jws: '^4.0.1' } },
        'node_modules/jws': { version: '3.2.3' },
        // Consumers agree on a version that is still vulnerable.
        'node_modules/consumer': { version: '1.0.0', dependencies: { lodash: '~4.17.0' } },
        'node_modules/lodash': { version: '4.18.1' },
        // Consumers disagree, so npm would nest copies.
        'node_modules/cli': { version: '1.0.0', dependencies: { tmp: '^0.1.0' } },
        'node_modules/editor': { version: '3.1.0', dependencies: { tmp: '^0.0.33' } },
        'node_modules/tmp': { version: '0.2.7' },
      },
    },
    { manifest: {} }
  );

  const versions = new Map([
    ['flatted', ['3.2.9', '3.4.2', '3.4.4']],
    ['jws', ['3.2.2', '3.2.3', '4.0.0', '4.0.1']],
    ['lodash', ['4.17.20', '4.17.21', '4.18.1']],
    ['tmp', ['0.0.33', '0.1.0', '0.2.7']],
  ]);

  const knowledge = {
    advisories: new Map([
      ['flatted', [{ title: 'a', severity: 'high', vulnerableRange: '<=3.4.1' }]],
      ['jws', [{ title: 'b', severity: 'high', vulnerableRange: '<3.2.3' }]],
      ['lodash', [{ title: 'c', severity: 'high', vulnerableRange: '<=4.17.23' }]],
      ['tmp', [{ title: 'd', severity: 'high', vulnerableRange: '<0.2.6' }]],
    ]),
    queried: new Set(['flatted', 'jws', 'lodash', 'tmp']),
  };

  const assess = (overrides: Parameters<typeof assessOverridesForPruning>[0]['overrides']) =>
    assessOverridesForPruning({ graph: pruneGraph, overrides, versions, knowledge });

  const verdictOf = (name: string, overrides: Record<string, string>) =>
    assess(overrides).find((entry) => entry.name === name)?.verdict;

  it('keeps an override whose removal would reinstate a vulnerable version', () => {
    // Consumers cap lodash at ~4.17.x, and every 4.17.x is still vulnerable.
    assert.strictEqual(verdictOf('lodash', { lodash: '4.18.1' }), 'needed');
  });

  it('drops an override when consumers already agree on a safe version', () => {
    assert.strictEqual(verdictOf('flatted', { flatted: '^3.4.2' }), 'redundant');
  });

  it('flags an override that pins below what consumers accept', () => {
    assert.strictEqual(verdictOf('jws', { jws: '3.2.3' }), 'harmful');
  });

  it('keeps an override when consumers disagree but every option is vulnerable', () => {
    assert.strictEqual(verdictOf('tmp', { tmp: '^0.2.4' }), 'needed');
  });

  it('reports an override with nothing to act on as inert', () => {
    assert.strictEqual(verdictOf('gone', { gone: '1.0.0' }), 'inert');
  });

  it('never calls an override redundant when advisory data is missing', () => {
    const withoutData = assessOverridesForPruning({
      graph: pruneGraph,
      overrides: { flatted: '^3.4.2' },
      versions,
      knowledge: emptyKnowledge(),
    });
    assert.strictEqual(withoutData[0]!.verdict, 'unknown');
  });

  it('removes only the overrides it judged removable', () => {
    const overrides = { flatted: '^3.4.2', jws: '3.2.3', lodash: '4.18.1' };
    const remaining = pruneOverrides(overrides, assess(overrides));
    assert.deepStrictEqual(remaining, { lodash: '4.18.1' });
  });

  it('leaves a scoped override untouched when only its sibling is removable', () => {
    const overrides = { flatted: '^3.4.2', 'flat-cache': { flatted: '^3.4.2' } };
    const remaining = pruneOverrides(overrides, assess(overrides));
    assert.strictEqual('flatted' in remaining, false);
  });
});

describe('npm report guard', () => {
  it('refuses to read an audit error as a clean project', () => {
    assert.throws(
      () => assertUsableReport({ error: { summary: 'ENOLOCK could not read lockfile' } }, '/x'),
      /ENOLOCK/
    );
  });

  it('passes a normal report through', () => {
    const report: AuditReport = { vulnerabilities: {}, metadata: {} };
    assert.strictEqual(assertUsableReport(report, '/x'), report);
  });
});

describe('explanation', () => {
  // Mirrors the real tmp case: an override forced 0.2.7 onto two consumers
  // that both declared against it, and no build-time code path revealed it.
  const forcedGraph = buildDependencyGraph(
    {
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { app: '^1.0.0' }, devDependencies: { cli: '^1.0.0' } },
        'node_modules/app': { version: '1.0.0' },
        'node_modules/cli': { version: '1.0.0', dependencies: { tmp: '^0.1.0' } },
        'node_modules/editor': { version: '3.1.0', dependencies: { tmp: '^0.0.33' } },
        'node_modules/tmp': { version: '0.2.7' },
      },
    },
    { manifest: { dependencies: { app: '^1.0.0' }, devDependencies: { cli: '^1.0.0' } } }
  );

  it('names every consumer that rejects the installed version', () => {
    const result = explainPackage({ graph: forcedGraph, name: 'tmp', overrides: { tmp: '^0.2.4' } });
    assert.deepStrictEqual(
      result.instances[0]!.rejecting.map((c) => `${c.name} ${c.range}`),
      ['cli ^0.1.0', 'editor ^0.0.33']
    );
  });

  it('identifies an override that forced a breaking version', () => {
    const forced = explainPackage({
      graph: forcedGraph,
      name: 'tmp',
      overrides: { tmp: '^0.2.4' },
    });
    assert.strictEqual(hasForcedBreaking(forced), true);
  });

  it('does not blame an override that is not there', () => {
    const unforced = explainPackage({ graph: forcedGraph, name: 'tmp' });
    assert.strictEqual(hasForcedBreaking(unforced), false);
  });

  it('separates production reach from build-only reach', () => {
    assert.strictEqual(explainPackage({ graph: forcedGraph, name: 'app' }).production, true);
    assert.strictEqual(explainPackage({ graph: forcedGraph, name: 'tmp' }).production, false);
  });

  it('reports a package that is not installed', () => {
    const missing = explainPackage({ graph: forcedGraph, name: 'nope' });
    assert.strictEqual(missing.present, false);
    assert.deepStrictEqual(missing.instances, []);
  });

  it('explains every copy when several exist', () => {
    const result = explainPackage({ graph, name: 'ws' });
    assert.strictEqual(result.instances.length, 2);
    assert.deepStrictEqual(
      result.instances.map((instance) => instance.hoisted),
      [true, false]
    );
  });

  it('carries advisory context when the audit provided it', () => {
    const result = explainPackage({
      graph: forcedGraph,
      name: 'tmp',
      findings: [finding('tmp', '<=0.2.5')],
    });
    assert.strictEqual(result.advisory?.range, '<=0.2.5');
    assert.strictEqual(result.advisory?.ownFlaw, true);
  });
});

/**
 * The domain's purity is why the suite runs offline in a second, and until now
 * it was enforced only by prose in CONTRIBUTING. One hurried import is enough
 * to lose it, and nothing would fail.
 *
 * This reads the source rather than the compiled output because `import type`
 * is erased at build time — a type-only import from infrastructure still points
 * the dependency the wrong way in the code people read and edit.
 */
describe('layer boundaries', () => {
  const domainDir = path.resolve(__dirname, '../../src/domain');

  const sources = fs
    .readdirSync(domainDir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, text: fs.readFileSync(path.join(domainDir, name), 'utf8') }));

  const specifiersIn = (text: string): string[] =>
    [
      ...text.matchAll(
        /(?:from|require\()\s*['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm
      ),
    ].map((m) => (m[1] ?? m[2]) as string);

  it('finds the domain sources it is meant to be policing', () => {
    // Guards against the check passing vacuously if the folder is ever moved.
    assert.ok(sources.length >= 5, `expected domain sources, found ${sources.length}`);
    assert.ok(sources.some((s) => s.name === 'remediation.ts'));
  });

  it('domain imports nothing from an outer layer', () => {
    const outward = sources.flatMap(({ name, text }) =>
      specifiersIn(text)
        .filter((spec) => /(^|\/)(infrastructure|features|presentation)\//.test(spec))
        .map((spec) => `${name} -> ${spec}`)
    );
    assert.deepStrictEqual(outward, []);
  });

  it('domain reaches no platform capability', () => {
    const platform = sources.flatMap(({ name, text }) =>
      specifiersIn(text)
        .filter((spec) => builtinModules.includes(spec.replace(/^node:/, '')))
        .map((spec) => `${name} -> ${spec}`)
    );
    assert.deepStrictEqual(platform, []);
  });
});

/** Async assertions run after the synchronous suites above. */
const asyncChecks = async (): Promise<void> => {
  console.log('\nconcurrency pool');

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  await it_('preserves input order regardless of completion order', async () => {
    const result = await mapWithConcurrency([30, 10, 20, 0], 4, async (ms, index) => {
      await delay(ms);
      return index;
    });
    assert.deepStrictEqual(result, [0, 1, 2, 3]);
  });

  await it_('never exceeds the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(5);
      active -= 1;
      return null;
    });
    assert.strictEqual(peak <= 3, true, `peak concurrency was ${peak}`);
  });

  await it_('handles an empty list without hanging', async () => {
    assert.deepStrictEqual(await mapWithConcurrency([], 8, async () => null), []);
  });

  await it_('tolerates a limit larger than the input', async () => {
    assert.deepStrictEqual(
      await mapWithConcurrency([1, 2], 99, async (n) => n * 2),
      [2, 4]
    );
  });

  console.log(`\n${passed} assertions passed\n`);
};

async function it_(label: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

void asyncChecks();
