import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { isAtLeast, parseSemver } from "./runtime-guard.js";
import { compareComparableSemver, parseComparableSemver } from "./semver-compare.js";
import { createTempDownloadTarget } from "./temp-download.js";
export { parseClawHubPluginSpec } from "./clawhub-spec.js";

const DEFAULT_CLAWHUB_URL = "https://clawhub.ai";
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export type ClawHubPackageFamily = "skill" | "code-plugin" | "bundle-plugin";
export type ClawHubPackageChannel = "official" | "community" | "private";
// Keep aligned with @openclaw/plugin-package-contract ExternalPluginCompatibility.
export type ClawHubPackageCompatibility = {
  pluginApiRange?: string;
  builtWithOpenClawVersion?: string;
  pluginSdkVersion?: string;
  minGatewayVersion?: string;
};
export type ClawHubPackageHostTarget = {
  os?: string | null;
  arch?: string | null;
  libc?: string | null;
  key?: string | null;
};
export type ClawHubPackageEnvironmentSummary = {
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
export type ClawHubArtifactKind = "legacy-zip" | "npm-pack";
export type ClawHubArtifactScanState =
  | "pending"
  | "clean"
  | "suspicious"
  | "malicious"
  | "not-run"
  | (string & {});
export type ClawHubArtifactModerationState = "approved" | "quarantined" | "revoked" | (string & {});
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
export type ClawHubPackageReadinessPhase =
  | "planned"
  | "published"
  | "clawpack-ready"
  | "legacy-zip-only"
  | "metadata-ready"
  | "blocked"
  | "ready-for-openclaw"
  | (string & {});
export type ClawHubPackageReadiness = {
  ready?: boolean | null;
  readyForOpenClaw?: boolean | null;
  installReady?: boolean | null;
  phase?: ClawHubPackageReadinessPhase | null;
  status?: ClawHubPackageReadinessPhase | null;
  package?: {
    name?: string | null;
    family?: ClawHubPackageFamily | (string & {}) | null;
    channel?: ClawHubPackageChannel | (string & {}) | null;
    isOfficial?: boolean | null;
  } | null;
  packageName?: string | null;
  artifactKind?: ClawHubArtifactKind | (string & {}) | null;
  blockers?: string[];
  scanState?: ClawHubArtifactScanState | null;
  moderationState?: ClawHubArtifactModerationState | null;
};
export type ClawHubPackageListItem = {
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

export type ClawHubSkillSearchResult = {
  score: number;
  slug: string;
  displayName: string;
  summary?: string;
  version?: string;
  updatedAt?: number;
};

export type ClawHubSkillDetail = {
  skill: {
    slug: string;
    displayName: string;
    summary?: string;
    tags?: Record<string, string>;
    createdAt: number;
    updatedAt: number;
  } | null;
  latestVersion?: {
    version: string;
    createdAt: number;
    changelog?: string;
  } | null;
  metadata?: {
    os?: string[] | null;
    systems?: string[] | null;
  } | null;
  owner?: {
    handle?: string | null;
    displayName?: string | null;
    image?: string | null;
  } | null;
};

export type ClawHubSkillListResponse = {
  items: Array<{
    slug: string;
    displayName: string;
    summary?: string;
    tags?: Record<string, string>;
    latestVersion?: {
      version: string;
      createdAt: number;
      changelog?: string;
    } | null;
    metadata?: {
      os?: string[] | null;
      systems?: string[] | null;
    } | null;
    createdAt: number;
    updatedAt: number;
  }>;
  nextCursor?: string | null;
};

export type ClawHubDownloadResult = {
  archivePath: string;
  integrity: string;
  sha256Hex: string;
  artifact: "archive" | "clawpack";
  clawpackHeaderSha256?: string;
  clawpackHeaderSpecVersion?: number;
  npmIntegrity?: string;
  npmShasum?: string;
  npmTarballName?: string;
  cleanup: () => Promise<void>;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type ClawHubRequestParams = {
  baseUrl?: string;
  path: string;
  token?: string;
  timeoutMs?: number;
  search?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
};

type ClawHubConfigLike = {
  token?: unknown;
  accessToken?: unknown;
  authToken?: unknown;
  apiToken?: unknown;
  auth?: ClawHubConfigLike | null;
  session?: ClawHubConfigLike | null;
  credentials?: ClawHubConfigLike | null;
  user?: ClawHubConfigLike | null;
};

export class ClawHubRequestError extends Error {
  readonly status: number;
  readonly requestPath: string;
  readonly responseBody: string;

  constructor(params: { path: string; status: number; body: string }) {
    super(`ClawHub ${params.path} failed (${params.status}): ${params.body}`);
    this.name = "ClawHubRequestError";
    this.status = params.status;
    this.requestPath = params.path;
    this.responseBody = params.body;
  }
}

function normalizeBaseUrl(baseUrl?: string): string {
  const envValue =
    normalizeOptionalString(process.env.OPENCLAW_CLAWHUB_URL) ||
    normalizeOptionalString(process.env.CLAWHUB_URL) ||
    DEFAULT_CLAWHUB_URL;
  const value = (normalizeOptionalString(baseUrl) || envValue).replace(/\/+$/, "");
  return value || DEFAULT_CLAWHUB_URL;
}

function extractTokenFromClawHubConfig(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as ClawHubConfigLike;
  return (
    normalizeOptionalString(record.accessToken) ??
    normalizeOptionalString(record.authToken) ??
    normalizeOptionalString(record.apiToken) ??
    normalizeOptionalString(record.token) ??
    extractTokenFromClawHubConfig(record.auth) ??
    extractTokenFromClawHubConfig(record.session) ??
    extractTokenFromClawHubConfig(record.credentials) ??
    extractTokenFromClawHubConfig(record.user)
  );
}

function resolveClawHubConfigPaths(): string[] {
  const explicit =
    normalizeOptionalString(process.env.OPENCLAW_CLAWHUB_CONFIG_PATH) ||
    normalizeOptionalString(process.env.CLAWHUB_CONFIG_PATH) ||
    normalizeOptionalString(process.env.CLAWDHUB_CONFIG_PATH); // legacy misspelling from older clawhub CLI builds; keep for back-compat
  if (explicit) {
    return [explicit];
  }

  const xdgConfigHome = normalizeOptionalString(process.env.XDG_CONFIG_HOME);
  const configHome =
    xdgConfigHome && xdgConfigHome.length > 0 ? xdgConfigHome : path.join(os.homedir(), ".config");
  const xdgPath = path.join(configHome, "clawhub", "config.json");

  if (process.platform === "darwin") {
    return [
      path.join(os.homedir(), "Library", "Application Support", "clawhub", "config.json"),
      xdgPath,
    ];
  }

  return [xdgPath];
}

export async function resolveClawHubAuthToken(): Promise<string | undefined> {
  const envToken =
    normalizeOptionalString(process.env.OPENCLAW_CLAWHUB_TOKEN) ||
    normalizeOptionalString(process.env.CLAWHUB_TOKEN) ||
    normalizeOptionalString(process.env.CLAWHUB_AUTH_TOKEN);
  if (envToken) {
    return envToken;
  }

  for (const configPath of resolveClawHubConfigPaths()) {
    try {
      const raw = await fs.readFile(configPath, "utf8");
      const token = extractTokenFromClawHubConfig(JSON.parse(raw));
      if (token) {
        return token;
      }
    } catch {
      // Try the next candidate path.
    }
  }
  return undefined;
}

function normalizePartialComparableVersion(version: string): {
  version: string;
  isPartial: boolean;
} {
  const trimmed = version.trim();
  return /^[vV]?[0-9]+\.[0-9]+$/.test(trimmed)
    ? { version: `${trimmed}.0`, isPartial: true }
    : { version: trimmed, isPartial: false };
}

function compareSemver(left: string, right: string): number | null {
  return compareComparableSemver(
    parseComparableSemver(normalizePartialComparableVersion(left).version),
    parseComparableSemver(normalizePartialComparableVersion(right).version),
  );
}

function upperBoundForCaret(version: string): string | null {
  const parsed = parseComparableSemver(normalizePartialComparableVersion(version).version);
  if (!parsed) {
    return null;
  }
  if (parsed.major > 0) {
    return `${parsed.major + 1}.0.0`;
  }
  if (parsed.minor > 0) {
    return `0.${parsed.minor + 1}.0`;
  }
  return `0.0.${parsed.patch + 1}`;
}

function matchWildcardComparator(token: string): "any" | "none" | null {
  const match = /^(>=|<=|>|<|=|\^|~)?\s*([*xX])$/.exec(token);
  if (!match) {
    return null;
  }
  const operator = match[1];
  return operator === ">" || operator === "<" ? "none" : "any";
}

function satisfiesComparator(version: string, token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) {
    return true;
  }
  const wildcard = matchWildcardComparator(trimmed);
  if (wildcard) {
    return wildcard === "any" && parseComparableSemver(version) != null;
  }
  if (trimmed.startsWith("^")) {
    const base = trimmed.slice(1).trim();
    const upperBound = upperBoundForCaret(base);
    const lowerCmp = compareSemver(version, base);
    const upperCmp = upperBound ? compareSemver(version, upperBound) : null;
    return lowerCmp != null && upperCmp != null && lowerCmp >= 0 && upperCmp < 0;
  }

  const match = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(trimmed);
  if (!match) {
    return false;
  }
  const operator = match[1];
  const target = match[2]?.trim();
  if (!target) {
    return false;
  }
  const normalizedTarget = normalizePartialComparableVersion(target);
  const cmp = compareSemver(version, normalizedTarget.version);
  if (cmp == null) {
    return false;
  }
  switch (operator) {
    case ">=":
      return cmp >= 0;
    case "<=":
      return cmp <= 0;
    case ">":
      return cmp > 0;
    case "<":
      return cmp < 0;
    case "=":
    default:
      return normalizedTarget.isPartial && !operator ? cmp >= 0 : cmp === 0;
  }
}

function satisfiesSemverRange(version: string, range: string): boolean {
  const tokens = range
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    return false;
  }
  return tokens.every((token) => satisfiesComparator(version, token));
}

const OPENCLAW_CALVER_STABLE_CORRECTION_PATTERN = /^[vV]?(\d{4}\.\d{1,2}\.\d{1,2})-\d+$/;

function normalizeCalVerCorrectionForPluginApi(pluginApiVersion: string): string {
  const match = OPENCLAW_CALVER_STABLE_CORRECTION_PATTERN.exec(pluginApiVersion.trim());
  return match?.[1] ?? pluginApiVersion;
}

function buildUrl(params: Pick<ClawHubRequestParams, "baseUrl" | "path" | "search">): URL {
  const url = new URL(params.path, `${normalizeBaseUrl(params.baseUrl)}/`);
  for (const [key, value] of Object.entries(params.search ?? {})) {
    if (!value) {
      continue;
    }
    url.searchParams.set(key, value);
  }
  return url;
}

async function clawhubRequest(
  params: ClawHubRequestParams,
): Promise<{ response: Response; url: URL; hasToken: boolean }> {
  const url = buildUrl(params);
  const token = normalizeOptionalString(params.token) || (await resolveClawHubAuthToken());
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new Error(
          `ClawHub request timed out after ${params.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS}ms`,
        ),
      ),
    params.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
  );
  try {
    const response = await (params.fetchImpl ?? fetch)(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: controller.signal,
    });
    return { response, url, hasToken: Boolean(token) };
  } finally {
    clearTimeout(timeout);
  }
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text || response.statusText || `HTTP ${response.status}`;
  } catch {
    return response.statusText || `HTTP ${response.status}`;
  }
}

async function buildClawHubError(
  response: Response,
  url: URL,
  hasToken: boolean,
): Promise<ClawHubRequestError> {
  let body = await readErrorBody(response);
  if (response.status === 429) {
    const suffix = formatRateLimitSuffix(response.headers, hasToken);
    if (suffix) {
      body = `${body} ${suffix}`;
    }
  }
  return new ClawHubRequestError({
    path: url.pathname,
    status: response.status,
    body,
  });
}

function formatRateLimitSuffix(headers: Headers, hasToken: boolean): string {
  const reset =
    normalizeHeaderValue(headers.get("RateLimit-Reset")) ??
    normalizeHeaderValue(headers.get("Retry-After"));
  const segments: string[] = [];
  if (reset && Number.isFinite(Number(reset))) {
    segments.push(`(resets in ${reset}s)`);
  }
  if (!hasToken) {
    segments.push("Sign in for higher rate limits.");
  }
  return segments.join(" ");
}

async function fetchJson<T>(params: ClawHubRequestParams): Promise<T> {
  const { response, url, hasToken } = await clawhubRequest(params);
  if (!response.ok) {
    throw await buildClawHubError(response, url, hasToken);
  }
  return (await response.json()) as T;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function optionalStringField(
  source: Record<string, unknown>,
  field: string,
  context: string,
): string | null | undefined {
  const value = source[field];
  if (value === undefined || value === null || typeof value === "string") {
    return value;
  }
  throw new Error(`Malformed ClawHub ${context}: expected ${field} to be a string or null.`);
}

function requiredBooleanField(
  source: Record<string, unknown>,
  field: string,
  context: string,
): boolean {
  const value = source[field];
  if (typeof value === "boolean") {
    return value;
  }
  throw new Error(`Malformed ClawHub ${context}: expected ${field} to be a boolean.`);
}

function requiredStringArrayField(
  source: Record<string, unknown>,
  field: string,
  context: string,
): string[] {
  const value = source[field];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value;
  }
  throw new Error(`Malformed ClawHub ${context}: expected ${field} to be a string array.`);
}

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
  const name = optionalStringField(value, "name", "security package");
  const displayName = optionalStringField(value, "displayName", "security package");
  const family = optionalStringField(value, "family", "security package");
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
  const id = optionalStringField(value, "id", "security release");
  const version = optionalStringField(value, "version", "security release");
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
    blockedFromDownload: requiredBooleanField(trust, "blockedFromDownload", "security trust"),
    reasons: requiredStringArrayField(trust, "reasons", "security trust"),
    pending: requiredBooleanField(trust, "pending", "security trust"),
    stale: requiredBooleanField(trust, "stale", "security trust"),
  };
  const scanStatus = optionalStringField(trust, "scanStatus", "security trust");
  const moderationState = optionalStringField(trust, "moderationState", "security trust");
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

export function resolveClawHubBaseUrl(baseUrl?: string): string {
  return normalizeBaseUrl(baseUrl);
}

function formatSha256Integrity(bytes: Uint8Array): string {
  const digest = createHash("sha256").update(bytes).digest("base64");
  return `sha256-${digest}`;
}

function formatSha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function formatSha512Integrity(bytes: Uint8Array): string {
  const digest = createHash("sha512").update(bytes).digest("base64");
  return `sha512-${digest}`;
}

function formatSha1Hex(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex");
}

function normalizeHeaderValue(value: string | null): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function safePackageTarballName(name: string, version: string): string {
  const base = name
    .replace(/^@/, "")
    .replace(/[\\/]+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "-");
  return `${base || "package"}-${version}.tgz`;
}

export function normalizeClawHubSha256Integrity(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const prefixedBase64 = /^sha256-([A-Za-z0-9+/]+={0,1})$/.exec(trimmed);
  if (prefixedBase64?.[1]) {
    try {
      const decoded = Buffer.from(prefixedBase64[1], "base64");
      if (decoded.length === 32) {
        return `sha256-${decoded.toString("base64")}`;
      }
    } catch {
      return null;
    }
    return null;
  }
  const prefixedHex = /^sha256:([A-Fa-f0-9]{64})$/.exec(trimmed);
  if (prefixedHex?.[1]) {
    return `sha256-${Buffer.from(prefixedHex[1], "hex").toString("base64")}`;
  }
  if (/^[A-Fa-f0-9]{64}$/.test(trimmed)) {
    return `sha256-${Buffer.from(trimmed, "hex").toString("base64")}`;
  }
  return null;
}

export function normalizeClawHubSha256Hex(value: string): string | null {
  const trimmed = value.trim();
  if (!/^[A-Fa-f0-9]{64}$/.test(trimmed)) {
    return null;
  }
  return normalizeLowercaseStringOrEmpty(trimmed);
}

export async function fetchClawHubPackageDetail(params: {
  name: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<ClawHubPackageDetail> {
  return await fetchJson<ClawHubPackageDetail>({
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
  fetchImpl?: FetchLike;
}): Promise<ClawHubPackageVersion> {
  return await fetchJson<ClawHubPackageVersion>({
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
  fetchImpl?: FetchLike;
}): Promise<ClawHubPackageArtifactResolverResponse> {
  return await fetchJson<ClawHubPackageArtifactResolverResponse>({
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
  fetchImpl?: FetchLike;
}): Promise<ClawHubPackageSecurityResponse> {
  const response = await fetchJson<unknown>({
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

export async function fetchClawHubPackageReadiness(params: {
  name: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<ClawHubPackageReadiness> {
  return await fetchJson<ClawHubPackageReadiness>({
    baseUrl: params.baseUrl,
    path: `/api/v1/packages/${encodeURIComponent(params.name)}/readiness`,
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
  });
}

export async function searchClawHubPackages(params: {
  query: string;
  family?: ClawHubPackageFamily;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  limit?: number;
}): Promise<ClawHubPackageSearchResult[]> {
  const result = await fetchJson<{ results: ClawHubPackageSearchResult[] }>({
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

export async function searchClawHubSkills(params: {
  query: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  limit?: number;
}): Promise<ClawHubSkillSearchResult[]> {
  const result = await fetchJson<{ results: ClawHubSkillSearchResult[] }>({
    baseUrl: params.baseUrl,
    path: "/api/v1/search",
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    search: {
      q: params.query.trim(),
      limit: params.limit ? String(params.limit) : undefined,
    },
  });
  return result.results ?? [];
}

export async function fetchClawHubSkillDetail(params: {
  slug: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<ClawHubSkillDetail> {
  return await fetchJson<ClawHubSkillDetail>({
    baseUrl: params.baseUrl,
    path: `/api/v1/skills/${encodeURIComponent(params.slug)}`,
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
  });
}

export async function listClawHubSkills(params: {
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  limit?: number;
}): Promise<ClawHubSkillListResponse> {
  return await fetchJson<ClawHubSkillListResponse>({
    baseUrl: params.baseUrl,
    path: "/api/v1/skills",
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    search: {
      limit: params.limit ? String(params.limit) : undefined,
    },
  });
}

export async function downloadClawHubPackageArchive(params: {
  name: string;
  version?: string;
  tag?: string;
  artifact?: "archive" | "clawpack";
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<ClawHubDownloadResult> {
  if (params.artifact === "clawpack") {
    if (!params.version) {
      throw new Error("ClawPack package downloads require an explicit version.");
    }
    const { response, url, hasToken } = await clawhubRequest({
      baseUrl: params.baseUrl,
      path: `/api/v1/packages/${encodeURIComponent(params.name)}/versions/${encodeURIComponent(
        params.version,
      )}/artifact/download`,
      token: params.token,
      timeoutMs: params.timeoutMs,
      fetchImpl: params.fetchImpl,
    });
    if (!response.ok) {
      throw await buildClawHubError(response, url, hasToken);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const sha256Hex = formatSha256Hex(bytes);
    const npmIntegrity = formatSha512Integrity(bytes);
    const npmShasum = formatSha1Hex(bytes);
    const headerSha256 = normalizeClawHubSha256Hex(
      response.headers.get("X-ClawHub-Artifact-Sha256") ??
        response.headers.get("X-ClawHub-ClawPack-Sha256") ??
        "",
    );
    if (!headerSha256) {
      throw new Error(
        `ClawHub ClawPack download for "${params.name}@${params.version}" is missing X-ClawHub-Artifact-Sha256.`,
      );
    }
    if (headerSha256 !== sha256Hex) {
      throw new Error(
        `ClawHub ClawPack download for "${params.name}@${params.version}" declared sha256 ${headerSha256}, got ${sha256Hex}.`,
      );
    }
    const headerNpmIntegrity = normalizeHeaderValue(
      response.headers.get("X-ClawHub-Npm-Integrity"),
    );
    if (headerNpmIntegrity && headerNpmIntegrity !== npmIntegrity) {
      throw new Error(
        `ClawHub ClawPack download for "${params.name}@${params.version}" declared npm integrity ${headerNpmIntegrity}, got ${npmIntegrity}.`,
      );
    }
    const headerNpmShasum = normalizeHeaderValue(response.headers.get("X-ClawHub-Npm-Shasum"));
    if (headerNpmShasum && headerNpmShasum !== npmShasum) {
      throw new Error(
        `ClawHub ClawPack download for "${params.name}@${params.version}" declared npm shasum ${headerNpmShasum}, got ${npmShasum}.`,
      );
    }
    const npmTarballName =
      normalizeHeaderValue(response.headers.get("X-ClawHub-Npm-Tarball-Name")) ??
      safePackageTarballName(params.name, params.version);
    const rawSpecVersion = response.headers.get("X-ClawHub-ClawPack-Spec-Version");
    const specVersion = rawSpecVersion ? Number.parseInt(rawSpecVersion, 10) : undefined;
    const target = await createTempDownloadTarget({
      prefix: "openclaw-clawhub-clawpack",
      fileName: npmTarballName,
      tmpDir: os.tmpdir(),
    });
    await fs.writeFile(target.path, bytes);
    return {
      archivePath: target.path,
      integrity: normalizeClawHubSha256Integrity(sha256Hex) ?? formatSha256Integrity(bytes),
      sha256Hex,
      artifact: "clawpack",
      clawpackHeaderSha256: headerSha256,
      ...(typeof specVersion === "number" && Number.isSafeInteger(specVersion) && specVersion >= 0
        ? { clawpackHeaderSpecVersion: specVersion }
        : {}),
      npmIntegrity,
      npmShasum,
      npmTarballName,
      cleanup: target.cleanup,
    };
  }
  const search = params.version
    ? { version: params.version }
    : params.tag
      ? { tag: params.tag }
      : undefined;
  const { response, url, hasToken } = await clawhubRequest({
    baseUrl: params.baseUrl,
    path: `/api/v1/packages/${encodeURIComponent(params.name)}/download`,
    search,
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
  });
  if (!response.ok) {
    throw await buildClawHubError(response, url, hasToken);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sha256Hex = formatSha256Hex(bytes);
  const target = await createTempDownloadTarget({
    prefix: "openclaw-clawhub-package",
    fileName: `${params.name}.zip`,
    tmpDir: os.tmpdir(),
  });
  await fs.writeFile(target.path, bytes);
  return {
    archivePath: target.path,
    integrity: formatSha256Integrity(bytes),
    sha256Hex,
    artifact: "archive",
    cleanup: target.cleanup,
  };
}

export async function downloadClawHubSkillArchive(params: {
  slug: string;
  version?: string;
  tag?: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<ClawHubDownloadResult> {
  const { response, url, hasToken } = await clawhubRequest({
    baseUrl: params.baseUrl,
    path: "/api/v1/download",
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    search: {
      slug: params.slug,
      version: params.version,
      tag: params.version ? undefined : params.tag,
    },
  });
  if (!response.ok) {
    throw await buildClawHubError(response, url, hasToken);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sha256Hex = formatSha256Hex(bytes);
  const target = await createTempDownloadTarget({
    prefix: "openclaw-clawhub-skill",
    fileName: `${params.slug}.zip`,
    tmpDir: os.tmpdir(),
  });
  await fs.writeFile(target.path, bytes);
  return {
    archivePath: target.path,
    integrity: formatSha256Integrity(bytes),
    sha256Hex,
    artifact: "archive",
    cleanup: target.cleanup,
  };
}

export function resolveLatestVersionFromPackage(detail: ClawHubPackageDetail): string | null {
  return detail.package?.latestVersion ?? detail.package?.tags?.latest ?? null;
}

export function isClawHubFamilySkill(detail: ClawHubPackageDetail | ClawHubSkillDetail): boolean {
  if ("package" in detail) {
    return detail.package?.family === "skill";
  }
  return Boolean(detail.skill);
}

export function satisfiesPluginApiRange(
  pluginApiVersion: string,
  pluginApiRange?: string | null,
): boolean {
  if (!pluginApiRange) {
    return true;
  }
  return satisfiesSemverRange(
    normalizeCalVerCorrectionForPluginApi(pluginApiVersion),
    pluginApiRange,
  );
}

export function satisfiesGatewayMinimum(
  currentVersion: string,
  minGatewayVersion?: string | null,
): boolean {
  if (!minGatewayVersion) {
    return true;
  }
  const current = parseSemver(currentVersion);
  const minimum = parseSemver(minGatewayVersion);
  if (!current || !minimum) {
    return false;
  }
  return isAtLeast(current, minimum);
}
