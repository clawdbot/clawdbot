// ClawHub package metadata, security, search, and telemetry operations.
import { isRecord as isJsonObject } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createClawHubError,
  fetchClawHubJson,
  isClawHubTelemetryDisabled,
  readClawHubStringField,
  readRequiredClawHubBooleanField,
  readRequiredClawHubStringArrayField,
  requestClawHub,
  resolveClawHubAuthToken,
  type ClawHubFetch,
} from "./clawhub-client.js";

export type ClawHubPackageFamily = "skill" | "code-plugin" | "bundle-plugin";
export type ClawHubPackageChannel = "official" | "community" | "private";
// Keep aligned with @openclaw/plugin-package-contract ExternalPluginCompatibility.
export type ClawHubPackageCompatibility = {
  pluginApiRange?: string;
  builtWithOpenClawVersion?: string;
  pluginSdkVersion?: string;
  minGatewayVersion?: string;
};
type ClawHubPackageHostTarget = {
  os?: string | null;
  arch?: string | null;
  libc?: string | null;
  key?: string | null;
};
type ClawHubPackageEnvironmentSummary = {
  requiresLocalDesktop?: boolean;
  requiresBrowser?: boolean;
  requiresAudioDevice?: boolean;
  requiresNetwork?: boolean;
  requiresExternalServices?: string[];
  requiresOsPermissions?: string[];
  supportsRemoteHost?: boolean;
  knownUnsupported?: string[];
};
export type ClawHubPackageArtifactSummary = {
  kind?: string | null;
  sha256?: string | null;
  size?: number | null;
  format?: string | null;
  npmIntegrity?: string | null;
  npmShasum?: string | null;
  npmTarballName?: string | null;
  npmUnpackedSize?: number | null;
  npmFileCount?: number | null;
  downloadUrl?: string | null;
  tarballUrl?: string | null;
  legacyDownloadUrl?: string | null;
};
type ClawHubArtifactScanState =
  | "pending"
  | "clean"
  | "suspicious"
  | "malicious"
  | "not-run"
  | (string & {});
type ClawHubArtifactModerationState = "approved" | "quarantined" | "revoked" | (string & {});
export type ClawHubPackageSecurityTrust = {
  scanStatus?: ClawHubArtifactScanState | null;
  moderationState?: ClawHubArtifactModerationState | null;
  blockedFromDownload: boolean;
  reasons: string[];
  pending: boolean;
  stale: boolean;
};
export type ClawHubResolvedArtifact =
  | {
      source: "clawhub";
      artifactKind: "legacy-zip";
      packageName: string;
      version: string;
      downloadUrl?: string | null;
      artifactSha256?: string | null;
      scanState?: ClawHubArtifactScanState | null;
      moderationState?: ClawHubArtifactModerationState | null;
    }
  | {
      source: "clawhub";
      artifactKind: "npm-pack";
      packageName: string;
      version: string;
      downloadUrl?: string | null;
      npmIntegrity: string;
      npmShasum?: string | null;
      artifactSha256?: string | null;
      scanState?: ClawHubArtifactScanState | null;
      moderationState?: ClawHubArtifactModerationState | null;
    };
export type ClawHubPackageArtifactResolverResponse = {
  package?: {
    name?: string | null;
    displayName?: string | null;
    family?: ClawHubPackageFamily | (string & {}) | null;
  } | null;
  version?:
    | ({
        version?: string | null;
        createdAt?: number | null;
        changelog?: string | null;
        distTags?: string[];
        files?: unknown[];
        sha256hash?: string | null;
        compatibility?: ClawHubPackageCompatibility | null;
        artifact?: ClawHubPackageArtifactSummary | null;
        clawpack?: ClawHubPackageClawPackSummary | null;
      } & Record<string, unknown>)
    | string
    | null;
  artifact?: ClawHubResolvedArtifact | null;
};
export type ClawHubPackageSecurityResponse = {
  package?: {
    name?: string | null;
    displayName?: string | null;
    family?: ClawHubPackageFamily | (string & {}) | null;
  } | null;
  release?: {
    id?: string | null;
    version?: string | null;
  } | null;
  trust: ClawHubPackageSecurityTrust;
};
export type ClawHubPackageClawPackSummary = {
  available: boolean;
  specVersion?: number | null;
  format?: string | null;
  sha256?: string | null;
  size?: number | null;
  fileCount?: number | null;
  manifestSha256?: string | null;
  npmIntegrity?: string | null;
  npmShasum?: string | null;
  npmTarballName?: string | null;
  builtAt?: number | null;
  buildVersion?: string | null;
  hostTargets?: ClawHubPackageHostTarget[];
  environment?: ClawHubPackageEnvironmentSummary | null;
  runtimeBundles?: unknown[];
};
type ClawHubPackageListItem = {
  name: string;
  displayName: string;
  family: ClawHubPackageFamily;
  runtimeId?: string | null;
  channel: ClawHubPackageChannel;
  isOfficial: boolean;
  summary?: string | null;
  ownerHandle?: string | null;
  createdAt: number;
  updatedAt: number;
  latestVersion?: string | null;
  capabilityTags?: string[];
  executesCode?: boolean;
  verificationTier?: string | null;
  stats?: {
    downloads?: number;
    installs?: number;
    stars?: number;
    versions?: number;
  } | null;
  clawpackAvailable?: boolean;
  hostTargetKeys?: string[];
  environmentFlags?: string[];
  artifact?: ClawHubPackageArtifactSummary | null;
  clawpack?: ClawHubPackageClawPackSummary;
};
export type ClawHubPackageDetail = {
  package:
    | (ClawHubPackageListItem & {
        tags?: Record<string, string>;
        compatibility?: ClawHubPackageCompatibility | null;
        capabilities?: {
          executesCode?: boolean;
          runtimeId?: string;
          capabilityTags?: string[];
          bundleFormat?: string;
          hostTargets?: string[];
          pluginKind?: string;
          channels?: string[];
          providers?: string[];
          hooks?: string[];
          bundledSkills?: string[];
        } | null;
        verification?: {
          tier?: string;
          scope?: string;
          summary?: string;
          sourceRepo?: string;
          sourceCommit?: string;
          hasProvenance?: boolean;
          scanStatus?: string;
        } | null;
        artifact?: ClawHubPackageArtifactSummary | null;
        clawpack?: ClawHubPackageClawPackSummary;
      })
    | null;
  owner?: {
    handle?: string | null;
    displayName?: string | null;
    image?: string | null;
  } | null;
};

export type ClawHubPackageVersion = {
  package: {
    name: string;
    displayName: string;
    family: ClawHubPackageFamily;
  } | null;
  version: {
    version: string;
    createdAt: number;
    changelog: string;
    distTags?: string[];
    files?: Array<{
      path: string;
      size?: number;
      sha256: string;
      contentType?: string;
    }>;
    sha256hash?: string | null;
    compatibility?: ClawHubPackageCompatibility | null;
    capabilities?: ClawHubPackageDetail["package"] extends infer T
      ? T extends { capabilities?: infer C }
        ? C
        : never
      : never;
    verification?: ClawHubPackageDetail["package"] extends infer T
      ? T extends { verification?: infer C }
        ? C
        : never
      : never;
    artifact?: ClawHubPackageArtifactSummary | null;
    clawpack?: ClawHubPackageClawPackSummary;
  } | null;
};

export type ClawHubPackageSearchResult = {
  score: number;
  package: ClawHubPackageListItem;
};

function parseOptionalSecurityPackage(value: unknown): ClawHubPackageSecurityResponse["package"] {
  if (value === undefined || value === null) {
    return value;
  }
  if (!isJsonObject(value)) {
    throw new Error(
      "Malformed ClawHub security response: expected package to be an object or null.",
    );
  }
  const result: NonNullable<ClawHubPackageSecurityResponse["package"]> = {};
  const name = readClawHubStringField(value, "name", "security package");
  const displayName = readClawHubStringField(value, "displayName", "security package");
  const family = readClawHubStringField(value, "family", "security package");
  if (name !== undefined) {
    result.name = name;
  }
  if (displayName !== undefined) {
    result.displayName = displayName;
  }
  if (family !== undefined) {
    result.family = family;
  }
  return result;
}

function parseOptionalSecurityRelease(value: unknown): ClawHubPackageSecurityResponse["release"] {
  if (value === undefined || value === null) {
    return value;
  }
  if (!isJsonObject(value)) {
    throw new Error(
      "Malformed ClawHub security response: expected release to be an object or null.",
    );
  }
  const result: NonNullable<ClawHubPackageSecurityResponse["release"]> = {};
  const releaseId = readClawHubStringField(value, "releaseId", "security release");
  const legacyId = readClawHubStringField(value, "id", "security release");
  const version = readClawHubStringField(value, "version", "security release");
  const id = releaseId ?? legacyId;
  if (id !== undefined) {
    result.id = id;
  }
  if (version !== undefined) {
    result.version = version;
  }
  return result;
}

function parseClawHubPackageSecurityResponse(value: unknown): ClawHubPackageSecurityResponse {
  if (!isJsonObject(value)) {
    throw new Error("Malformed ClawHub security response: expected an object.");
  }
  const trust = value.trust;
  if (!isJsonObject(trust)) {
    throw new Error("Malformed ClawHub security response: expected trust to be an object.");
  }
  const parsedTrust: ClawHubPackageSecurityTrust = {
    blockedFromDownload: readRequiredClawHubBooleanField(
      trust,
      "blockedFromDownload",
      "security trust",
    ),
    reasons: readRequiredClawHubStringArrayField(trust, "reasons", "security trust"),
    pending: readRequiredClawHubBooleanField(trust, "pending", "security trust"),
    stale: readRequiredClawHubBooleanField(trust, "stale", "security trust"),
  };
  const scanStatus = readClawHubStringField(trust, "scanStatus", "security trust");
  const moderationState = readClawHubStringField(trust, "moderationState", "security trust");
  if (scanStatus !== undefined) {
    parsedTrust.scanStatus = scanStatus;
  }
  if (moderationState !== undefined) {
    parsedTrust.moderationState = moderationState;
  }
  const result: ClawHubPackageSecurityResponse = { trust: parsedTrust };
  const parsedPackage = parseOptionalSecurityPackage(value.package);
  const parsedRelease = parseOptionalSecurityRelease(value.release);
  if (parsedPackage !== undefined) {
    result.package = parsedPackage;
  }
  if (parsedRelease !== undefined) {
    result.release = parsedRelease;
  }
  return result;
}

export async function fetchClawHubPackageDetail(params: {
  name: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: ClawHubFetch;
}): Promise<ClawHubPackageDetail> {
  return await fetchClawHubJson<ClawHubPackageDetail>({
    baseUrl: params.baseUrl,
    path: `/api/v1/packages/${encodeURIComponent(params.name)}`,
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
  });
}

export async function fetchClawHubPackageVersion(params: {
  name: string;
  version: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: ClawHubFetch;
}): Promise<ClawHubPackageVersion> {
  return await fetchClawHubJson<ClawHubPackageVersion>({
    baseUrl: params.baseUrl,
    path: `/api/v1/packages/${encodeURIComponent(params.name)}/versions/${encodeURIComponent(
      params.version,
    )}`,
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
  });
}

export async function fetchClawHubPackageArtifact(params: {
  name: string;
  version: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: ClawHubFetch;
}): Promise<ClawHubPackageArtifactResolverResponse> {
  return await fetchClawHubJson<ClawHubPackageArtifactResolverResponse>({
    baseUrl: params.baseUrl,
    path: `/api/v1/packages/${encodeURIComponent(params.name)}/versions/${encodeURIComponent(
      params.version,
    )}/artifact`,
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
  });
}

export async function fetchClawHubPackageSecurity(params: {
  name: string;
  version: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: ClawHubFetch;
}): Promise<ClawHubPackageSecurityResponse> {
  const response = await fetchClawHubJson<unknown>({
    baseUrl: params.baseUrl,
    path: `/api/v1/packages/${encodeURIComponent(params.name)}/versions/${encodeURIComponent(
      params.version,
    )}/security`,
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
  });
  return parseClawHubPackageSecurityResponse(response);
}

export async function searchClawHubPackages(params: {
  query: string;
  family?: ClawHubPackageFamily;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: ClawHubFetch;
  limit?: number;
}): Promise<ClawHubPackageSearchResult[]> {
  const result = await fetchClawHubJson<{ results: ClawHubPackageSearchResult[] }>({
    baseUrl: params.baseUrl,
    path: "/api/v1/packages/search",
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    search: {
      q: params.query.trim(),
      family: params.family,
      limit: params.limit ? String(params.limit) : undefined,
    },
  });
  return result.results ?? [];
}

export async function reportClawHubPluginInstallTelemetry(params: {
  baseUrl?: string;
  token?: string;
  packageName: string;
  version?: string | null;
  timeoutMs?: number;
  fetchImpl?: ClawHubFetch;
}): Promise<void> {
  const token = normalizeOptionalString(params.token) ?? (await resolveClawHubAuthToken());
  if (!token || isClawHubTelemetryDisabled()) {
    return;
  }
  const packageName = normalizeOptionalString(params.packageName);
  if (!packageName) {
    return;
  }

  const { response, url, hasToken } = await requestClawHub({
    baseUrl: params.baseUrl,
    path: "/api/cli/telemetry/install",
    method: "POST",
    token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    json: {
      event: "plugin_install",
      packageName,
      version: params.version ?? undefined,
    },
  });
  if (!response.ok) {
    throw await createClawHubError(response, url, hasToken, params.timeoutMs);
  }
}

export function resolveLatestVersionFromPackage(detail: ClawHubPackageDetail): string | null {
  return detail.package?.latestVersion ?? detail.package?.tags?.latest ?? null;
}
