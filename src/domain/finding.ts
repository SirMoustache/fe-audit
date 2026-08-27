import type { PackageName, RangeSpec } from './semver-policy';

export type Severity = 'info' | 'low' | 'moderate' | 'high' | 'critical';

/** The subset of `npm audit --json` this tool reads. */
export interface AuditAdvisory {
  readonly title?: string;
}

export interface AuditEntry {
  readonly name: PackageName;
  readonly severity: Severity;
  readonly range: RangeSpec;
  readonly isDirect?: boolean;
  readonly via: readonly (string | AuditAdvisory)[];
}

export interface AuditTotals {
  readonly info?: number;
  readonly low?: number;
  readonly moderate?: number;
  readonly high?: number;
  readonly critical?: number;
  readonly total?: number;
}

export interface AuditReport {
  readonly vulnerabilities?: Readonly<Record<string, AuditEntry>>;
  readonly metadata?: { readonly vulnerabilities?: AuditTotals };
  readonly error?: { readonly summary?: string; readonly detail?: string };
}

/**
 * A vulnerability as this tool understands it.
 *
 * npm reports a package as vulnerable both when it has its own advisory and when
 * it merely contains something that does. Only the first kind is a problem to
 * solve; the second clears itself once its parent is fixed. The audit format
 * expresses that distinction incidentally — as whether `via` holds objects or
 * strings — so it is worth naming properly on the way in.
 */
export interface Finding {
  readonly name: PackageName;
  readonly severity: Severity;
  readonly advisoryRange: RangeSpec;
  readonly isDirect: boolean;
  readonly advisories: readonly string[];
  readonly inheritedFrom: readonly PackageName[];
}

const isAdvisory = (via: string | AuditAdvisory): via is AuditAdvisory => typeof via !== 'string';

const toFinding = (entry: AuditEntry): Finding =>
  Object.freeze({
    name: entry.name,
    severity: entry.severity,
    advisoryRange: entry.range,
    isDirect: entry.isDirect === true,
    advisories: entry.via.filter(isAdvisory).map((via) => via.title ?? 'unnamed advisory'),
    inheritedFrom: entry.via.filter((via): via is string => !isAdvisory(via)),
  });

export const readFindings = (report: AuditReport): readonly Finding[] =>
  Object.values(report.vulnerabilities ?? {}).map(toFinding);

export const readTotals = (report: AuditReport): AuditTotals =>
  report.metadata?.vulnerabilities ?? {};

export const hasOwnAdvisory = (finding: Finding): boolean => finding.advisories.length > 0;

export const vulnerablePackageNames = (report: AuditReport): ReadonlySet<PackageName> =>
  new Set(Object.keys(report.vulnerabilities ?? {}));
