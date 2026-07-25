export type PackageVersion = {
  packageName: string;
  version: string;
};

export type Manifest = {
  dependencies?: Record<string, string | undefined>;
  optionalDependencies?: Record<string, string | undefined>;
  scripts?: Record<string, string>;
};

export type ManifestLoadResult = {
  manifest: Manifest;
  publishedAt: string | null;
};

export type ManifestFinding = {
  type: string;
  packageName: string;
  version: string;
  dependency?: { name: string; spec: string; section: string };
  source?: string;
  script?: string;
  publishedAt?: string;
  minimumReleaseAgeMinutes?: number;
  workspaceExcluded?: boolean;
  workspaceExclusion?: string;
};

export type TransitiveManifestRiskReport = {
  generatedAt: string;
  packageVersions: number;
  findingCount: number;
  byType: Record<string, number>;
  workspacePolicy: {
    minimumReleaseAgeMinutes: number | null;
    minimumReleaseAgeExclude: string[];
  };
  workspaceExcludedFindingCount: number;
  workspaceExcludedByType: Record<string, number>;
  workspaceExcludedFindings: ManifestFinding[];
  metadataFailures: Array<{ packageName: string; version: string; error: string }>;
  findings: ManifestFinding[];
};

export function readBoundedNpmRegistryText(
  response: Response,
  maxBytes?: number,
  options?: { signal?: AbortSignal },
): Promise<string>;

export function fetchNpmManifest(options: {
  packageName: string;
  version: string;
  fetchImpl: typeof fetch;
  registryBaseUrl: string;
  maxBytes?: number;
  timeoutMs?: number;
}): Promise<ManifestLoadResult>;

export function createTransitiveManifestRiskReport(options: {
  packageVersions: PackageVersion[];
  manifestLoader: (entry: PackageVersion) => Promise<ManifestLoadResult>;
  now?: Date;
  minimumReleaseAgeMinutes?: number | null;
  minimumReleaseAgeExclude?: string[];
}): Promise<TransitiveManifestRiskReport>;

export function renderTransitiveManifestRiskMarkdownReport(
  report: TransitiveManifestRiskReport,
): string;

export function main(argv?: string[]): Promise<number>;
