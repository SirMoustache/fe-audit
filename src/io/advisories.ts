import https from 'node:https';
import { createGunzip } from 'node:zlib';
import type { Severity } from '../domain/finding';
import type { PackageName, RangeSpec, Version } from '../domain/semver-policy';

const BULK_PATH = '/-/npm/v1/security/advisories/bulk';
const REQUEST_TIMEOUT_MS = 15_000;

/** How many packages to ask about in one request. */
const BATCH_SIZE = 40;

export interface Advisory {
  readonly title: string;
  readonly severity: Severity;
  readonly vulnerableRange: RangeSpec;
}

export type AdvisoryIndex = ReadonlyMap<PackageName, readonly Advisory[]>;

interface BulkAdvisory {
  readonly title?: string;
  readonly severity?: Severity;
  readonly vulnerable_versions?: RangeSpec;
}

const postJson = (origin: string, payload: unknown): Promise<unknown | null> =>
  new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const url = new URL(BULK_PATH, origin);
    const request = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'accept-encoding': 'gzip',
        },
        timeout: REQUEST_TIMEOUT_MS,
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
        let text = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => {
          text += chunk;
        });
        stream.on('error', () => resolve(null));
        stream.on('end', () => {
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve(null);
          }
        });
      }
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
    request.end(body);
  });

const chunk = <T>(items: readonly T[], size: number): readonly (readonly T[])[] =>
  items.length === 0
    ? []
    : [items.slice(0, size), ...chunk(items.slice(size), size)];

export interface AdvisoryLookup {
  readonly advisories: AdvisoryIndex;
  /** Packages the service answered for. Anything absent was never established. */
  readonly queried: ReadonlySet<PackageName>;
}

/**
 * Advisories for specific packages, independent of `npm audit`.
 *
 * This matters because `npm audit` only reports what is currently vulnerable.
 * Deciding whether an existing override is still earning its keep needs the
 * advisory itself, which by definition no longer shows up once the override has
 * done its job.
 *
 * The endpoint only returns advisories matching the versions submitted, so every
 * published version has to be sent to see the full picture. A failed batch is
 * reported as unqueried rather than as "no advisories", because the difference
 * decides whether an override looks safe to delete.
 */
export const fetchAdvisories = async (
  versionsByPackage: ReadonlyMap<PackageName, readonly Version[]>,
  { registry = 'https://registry.npmjs.org/' } = {}
): Promise<AdvisoryLookup> => {
  const index = new Map<PackageName, Advisory[]>();
  const queried = new Set<PackageName>();
  const entries = [...versionsByPackage.entries()].filter(([, versions]) => versions.length > 0);

  for (const batch of chunk(entries, BATCH_SIZE)) {
    const payload = Object.fromEntries(batch.map(([name, versions]) => [name, versions]));
    const response = (await postJson(registry, payload)) as Record<
      string,
      BulkAdvisory[]
    > | null;
    if (!response) continue;

    for (const [name] of batch) {
      queried.add(name);
      index.set(name, []);
    }

    for (const [name, advisories] of Object.entries(response)) {
      index.set(
        name,
        advisories
          .filter((advisory) => typeof advisory.vulnerable_versions === 'string')
          .map((advisory) => ({
            title: advisory.title ?? 'unnamed advisory',
            severity: advisory.severity ?? 'moderate',
            vulnerableRange: advisory.vulnerable_versions as RangeSpec,
          }))
      );
    }
  }

  return { advisories: index, queried };
};
