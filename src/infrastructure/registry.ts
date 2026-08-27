import { createHash } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import type { VersionLookup } from '../domain/remediation';
import type { PackageName, Version } from '../domain/semver-policy';
import { npmConfigGet, viewVersions } from './npm-client';
import { mapWithConcurrency } from './pool';

const PUBLIC_REGISTRY = 'https://registry.npmjs.org/';

/** The abbreviated packument is a fraction of the size and still lists versions. */
const ABBREVIATED = 'application/vnd.npm.install-v1+json';

const DEFAULTS = {
  concurrency: 12,
  cacheTtlMs: 60 * 60 * 1000,
  requestTimeoutMs: 10_000,
} as const;

export interface RegistryOptions {
  readonly concurrency?: number;
  readonly cache?: boolean;
  readonly cacheTtlMs?: number;
  readonly cacheDir?: string;
  readonly onProgress?: (completed: number, total: number) => void;
}

export interface Registry {
  fetchAll(names: readonly PackageName[]): Promise<ReadonlyMap<PackageName, VersionLookup>>;
}

const defaultCacheDir = (): string =>
  process.env['FE_AUDIT_CACHE_DIR'] ?? path.join(os.tmpdir(), 'fe-audit-cache');

const cacheFile = (dir: string, registry: string, name: PackageName): string => {
  const key = createHash('sha1').update(`${registry}\u0000${name}`).digest('hex');
  return path.join(dir, `${key}.json`);
};

interface CacheRecord {
  readonly fetchedAt: number;
  readonly versions: readonly Version[];
}

const readCache = (file: string, ttlMs: number): readonly Version[] | null => {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as CacheRecord;
    if (Date.now() - record.fetchedAt > ttlMs) return null;
    return record.versions;
  } catch {
    return null;
  }
};

const writeCache = (file: string, versions: readonly Version[]): void => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const record: CacheRecord = { fetchedAt: Date.now(), versions };
    fs.writeFileSync(file, JSON.stringify(record));
  } catch {
    // A cache that cannot be written must never fail the run.
  }
};

/** Scoped names are a single path segment, so the slash has to be encoded. */
const packumentUrl = (registry: string, name: PackageName): string =>
  registry.replace(/\/?$/, '/') + name.replace('/', '%2f');

const fetchOverHttp = (registry: string, name: PackageName): Promise<readonly Version[] | null> =>
  new Promise((resolve) => {
    const request = https.get(
      packumentUrl(registry, name),
      {
        // Packuments for popular packages run to hundreds of kilobytes; gzip
        // takes them to roughly a third, and download time dominates the run.
        headers: { accept: ABBREVIATED, 'accept-encoding': 'gzip' },
        timeout: DEFAULTS.requestTimeoutMs,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          resolve(null);
          return;
        }

        const stream =
          response.headers['content-encoding'] === 'gzip'
            ? response.pipe(createGunzip())
            : response;

        let body = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => {
          body += chunk;
        });
        stream.on('error', () => resolve(null));
        stream.on('end', () => {
          try {
            const packument = JSON.parse(body) as { versions?: Record<string, unknown> };
            const versions = Object.keys(packument.versions ?? {});
            resolve(versions.length > 0 ? versions : null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });

/**
 * Published versions for a package.
 *
 * The HTTP fast path is roughly fifty times quicker than spawning `npm view`,
 * but it is only safe where the answer is unambiguous: an unscoped package on
 * the public registry. A scope may be mapped to a private registry that this
 * process cannot see, and answering from npmjs would risk returning a different
 * package's versions entirely. Those go through npm, which already knows the
 * project's registry and auth configuration.
 */
export const createRegistry = (cwd: string, options: RegistryOptions = {}): Registry => {
  const concurrency = options.concurrency ?? DEFAULTS.concurrency;
  const useCache = options.cache !== false;
  const ttlMs = options.cacheTtlMs ?? DEFAULTS.cacheTtlMs;
  const cacheDir = options.cacheDir ?? defaultCacheDir();

  let registryUrl: Promise<string> | null = null;
  const defaultRegistry = (): Promise<string> => {
    registryUrl ??= npmConfigGet('registry', cwd)
      .then((value) => value || PUBLIC_REGISTRY)
      .catch(() => PUBLIC_REGISTRY);
    return registryUrl;
  };

  const canUseHttp = (name: PackageName, registry: string): boolean =>
    !name.startsWith('@') && registry.replace(/\/?$/, '/') === PUBLIC_REGISTRY;

  const fetchOne = async (name: PackageName): Promise<VersionLookup> => {
    const registry = await defaultRegistry();
    const file = cacheFile(cacheDir, registry, name);

    if (useCache) {
      const cached = readCache(file, ttlMs);
      if (cached) return { ok: true, versions: cached };
    }

    const viaHttp = canUseHttp(name, registry) ? await fetchOverHttp(registry, name) : null;
    const versions = viaHttp ?? (await viewVersions(name, cwd));

    if (!versions) return { ok: false, reason: `registry lookup failed for ${name}` };
    if (useCache) writeCache(file, versions);
    return { ok: true, versions };
  };

  return {
    async fetchAll(names) {
      let completed = 0;
      const entries = await mapWithConcurrency(names, concurrency, async (name) => {
        const result = await fetchOne(name);
        completed += 1;
        options.onProgress?.(completed, names.length);
        return [name, result] as const;
      });
      return new Map(entries);
    },
  };
};
