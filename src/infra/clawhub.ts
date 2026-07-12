// Fetches and validates ClawHub package metadata and artifacts.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { retryClawHubRead } from "./clawhub-retry.js";
import { sha256Base64, sha256Hex as digestSha256Hex } from "./crypto-digest.js";
import { readResponseTextSnippet, readResponseWithLimit } from "./http-body.js";
import { parseRegistryNpmSpec } from "./npm-registry-spec.js";
import {
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
} from "./parse-finite-number.js";
import { isAtLeast, parseSemver } from "./runtime-guard.js";
import { compareComparableSemver, parseComparableSemver } from "./semver-compare.js";
import { createTempDownloadTarget } from "./temp-download.js";
export { parseClawHubPluginSpec } from "./clawhub-spec.js";

const DEFAULT_CLAWHUB_URL = "https://clawhub.ai";
const DEFAULT_GITHUB_CODELOAD_URL = "https://codeload.github.com";
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const SKILL_CARD_MAX_BYTES = 256 * 1024;
// Align with marketplace archive downloads (src/plugins/marketplace.ts).
const CLAWHUB_ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
// ClawHub is an external marketplace: bound untrusted JSON and error bodies so
// a hostile or malfunctioning host cannot exhaust memory with an endless stream.
const CLAWHUB_JSON_MAX_BYTES = 16 * 1024 * 1024;
const CLAWHUB_ERROR_BODY_MAX_BYTES = 8 * 1024;
const CLAWHUB_ERROR_BODY_MAX_CHARS = 400;

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
    channel?: string | null;
    isOfficial?: boolean | null;
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
    official?: boolean | null;
    channel?: string | null;
    isOfficial?: boolean | null;
  } | null;
};

export type ClawHubSkillInstallResolutionResponse =
  | {
      ok: true;
      slug: string;
      channel?: string | null;
      isOfficial?: boolean | null;
      installKind: "archive";
      archive: {
        version: string;
        downloadUrl: string;
        channel?: string | null;
        isOfficial?: boolean | null;
      };
    }
  | {
      ok: true;
      slug: string;
      channel?: string | null;
      isOfficial?: boolean | null;
      installKind: "github";
      /** Commit-pinned source approved by ClawHub's install resolver policy. */
      github: {
        repo: string;
        path: string;
        commit: string;
        contentHash: string;
        sourceUrl: string;
      };
    }
  | {
      ok: false;
      slug: string;
      reason: string;
      message: string;
      status: number;
    };

export type ClawHubSkillVerificationDecision = "pass" | "fail" | (string & {});

export type ClawHubSkillVerificationResponse = {
  schema: "clawhub.skill.verify.v1";
  ok: boolean;
  decision: ClawHubSkillVerificationDecision;
  reasons: string[];
  slug?: string | null;
  displayName?: string | null;
  pageUrl?: string | null;
  publisherHandle?: string | null;
  publisherDisplayName?: string | null;
  createdAt?: number | null;
  skill: unknown;
  publisher: unknown;
  version: unknown;
  card: unknown;
  artifact: unknown;
  provenance: unknown;
  security: unknown;
  signature: unknown;
};

export type ClawHubSkillSecurityVerdictRequestItem = {
  slug: string;
  ownerHandle?: string;
  version: string;
};

export type ClawHubSkillSecurityVerdictItem = {
  ok: boolean;
  decision: ClawHubSkillVerificationDecision;
  reasons: string[];
  requestedSlug: string;
  requestedVersion: string;
  slug?: string | null;
  version?: string | null;
  displayName?: string | null;
  publisherHandle?: string | null;
  publisherDisplayName?: string | null;
  createdAt?: number | null;
  checkedAt?: number | null;
  skillUrl?: string | null;
  securityAuditUrl?: string | null;
  security?: unknown;
  error?: {
    code?: string;
    message?: string;
  };
};

export type ClawHubSkillSecurityVerdictsResponse = {
  schema: "clawhub.skill.security-verdicts.v1";
  items: ClawHubSkillSecurityVerdictItem[];
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
  path?: string;
  url?: string;
  method?: "GET" | "POST";
  json?: unknown;
  token?: string;
  timeoutMs?: number;
  search?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  skipAuth?: boolean;
  retryTransientReads?: boolean;
  headers?: Record<string, string>;
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

function resolveClawHubRequestTimeoutMs(timeoutMs: unknown): number {
  return resolveTimerTimeoutMs(timeoutMs, DEFAULT_FETCH_TIMEOUT_MS);
}

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

function normalizeGitHubCodeloadBaseUrl(): string {
  const value =
    normalizeOptionalString(process.env.OPENCLAW_CLAWHUB_GITHUB_CODELOAD_BASE_URL) ||
    normalizeOptionalString(process.env.CLAWHUB_GITHUB_CODELOAD_BASE_URL) ||
    DEFAULT_GITHUB_CODELOAD_URL;
  return value.replace(/\/+$/, "") || DEFAULT_GITHUB_CODELOAD_URL;
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

function shouldPreservePluginApiPrereleaseFloor(target: string): boolean {
  return Boolean(
    parseComparableSemver(normalizePartialComparableVersion(target).version)?.prerelease?.length,
  );
}

function normalizePluginApiVersionForComparator(version: string, target: string): string {
  const normalizedCorrection = normalizeOpenClawNumericCorrectionForPluginApi(version);
  if (normalizedCorrection) {
    return normalizedCorrection;
  }
  return shouldPreservePluginApiPrereleaseFloor(target)
    ? version
    : normalizeOpenClawReleaseSuffixForPluginApi(version);
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
    const comparableVersion = normalizePluginApiVersionForComparator(version, base);
    const lowerCmp = compareSemver(comparableVersion, base);
    const upperCmp = upperBound ? compareSemver(comparableVersion, upperBound) : null;
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
  const comparableVersion = normalizePluginApiVersionForComparator(version, target);
  const normalizedTarget = normalizePartialComparableVersion(target);
  const cmp = compareSemver(comparableVersion, normalizedTarget.version);
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
    default:
      return normalizedTarget.isPartial && !operator ? cmp >= 0 : cmp === 0;
  }
}

function satisfiesSemverRange(version: string, range: string): boolean {
  const tokens = normalizeStringEntries(range.trim().split(/\s+/));
  if (tokens.length === 0) {
    return false;
  }
  return tokens.every((token) => satisfiesComparator(version, token));
}

const OPENCLAW_RELEASE_SUFFIX_PATTERN =
  /^[vV]?(\d{4}\.[1-9]\d?\.[1-9]\d*)(?:-\d+|-(?:alpha|beta|rc)\.\d+)$/i;
const OPENCLAW_NUMERIC_CORRECTION_PATTERN = /^[vV]?(\d{4}\.[1-9]\d?\.[1-9]\d*)-\d+$/;

function normalizeOpenClawNumericCorrectionForPluginApi(
  pluginApiVersion: string,
): string | undefined {
  return OPENCLAW_NUMERIC_CORRECTION_PATTERN.exec(pluginApiVersion.trim())?.[1];
}

function normalizeOpenClawReleaseSuffixForPluginApi(pluginApiVersion: string): string {
  const match = OPENCLAW_RELEASE_SUFFIX_PATTERN.exec(pluginApiVersion.trim());
  return match?.[1] ?? pluginApiVersion;
}

function buildUrl(params: Pick<ClawHubRequestParams, "baseUrl" | "path" | "search" | "url">): URL {
  if (params.url) {
    const url = new URL(params.url, `${normalizeBaseUrl(params.baseUrl)}/`);
    for (const [key, value] of Object.entries(params.search ?? {})) {
      if (!value) {
        continue;
      }
      url.searchParams.set(key, value);
    }
    return url;
  }
  if (!params.path) {
    throw new Error("ClawHub request path is required");
  }
  const url = new URL(`${normalizeBaseUrl(params.baseUrl)}/`);
  const basePath = url.pathname.replace(/\/+$/, "");
  const requestPath = params.path.startsWith("/") ? params.path : `/${params.path}`;
  url.pathname = `${basePath}${requestPath}`;
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
  const token = params.skipAuth
    ? undefined
    : normalizeOptionalString(params.token) || (await resolveClawHubAuthToken());
  const timeoutMs = resolveClawHubRequestTimeoutMs(params.timeoutMs);
  const request = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error(`ClawHub request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const headers = {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(params.json === undefined ? {} : { "Content-Type": "application/json" }),
      ...params.headers,
    };
    const init: RequestInit = { signal: controller.signal };
    if (params.method) {
      init.method = params.method;
    }
    if (Object.keys(headers).length > 0) {
      init.headers = headers;
    }
    if (params.json !== undefined) {
      init.body = JSON.stringify(params.json);
    }
    try {
      const response = await (params.fetchImpl ?? fetch)(url, init);
      return { response, url, hasToken: Boolean(token) };
    } finally {
      clearTimeout(timeout);
    }
  };

  // A write may have committed before its response failed, so only replay
  // idempotent reads across transient ClawHub transport failures.
  if ((params.method ?? "GET") !== "GET" || params.retryTransientReads === false) {
    return await request();
  }
  return await retryClawHubRead(request, {
    disposeRetry: async ({ response }) => {
      await response.body?.cancel().catch(() => undefined);
    },
  });
}

async function readErrorBody(response: Response, timeoutMs?: number): Promise<string> {
  try {
    const snippet = await readResponseTextSnippet(response, {
      maxBytes: CLAWHUB_ERROR_BODY_MAX_BYTES,
      maxChars: CLAWHUB_ERROR_BODY_MAX_CHARS,
      chunkTimeoutMs: resolveClawHubRequestTimeoutMs(timeoutMs),
    });
    return snippet || response.statusText || `HTTP ${response.status}`;
  } catch {
    return response.statusText || `HTTP ${response.status}`;
  }
}

async function buildClawHubError(
  response: Response,
  url: URL,
  hasToken: boolean,
  timeoutMs?: number,
): Promise<ClawHubRequestError> {
  let body = await readErrorBody(response, timeoutMs);
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
    throw await buildClawHubError(response, url, hasToken, params.timeoutMs);
  }
  return parseClawHubJsonBody<T>(response, url, params.timeoutMs);
}

async function parseClawHubJsonBody<T>(
  response: Response,
  url: URL,
  timeoutMs?: number,
): Promise<T> {
  const buffer = await readResponseWithLimit(response, CLAWHUB_JSON_MAX_BYTES, {
    chunkTimeoutMs: resolveClawHubRequestTimeoutMs(timeoutMs),
    onOverflow: ({ size, maxBytes }) =>
      new Error(
        `ClawHub ${url.pathname} response exceeded ${maxBytes} bytes (${size} bytes received)`,
      ),
    onIdleTimeout: ({ chunkTimeoutMs }) =>
      new Error(`ClawHub ${url.pathname} response stalled after ${chunkTimeoutMs}ms`),
  });
  try {
    return JSON.parse(new TextDecoder().decode(buffer)) as T;
  } catch (cause) {
    throw new Error(`ClawHub ${url.pathname} returned malformed JSON`, { cause });
  }
}

async function readClawHubResponseBytes(params: {
  response: Response;
  maxBytes?: number;
  timeoutMs?: number;
  resourceLabel: string;
}): Promise<Uint8Array> {
  const timeoutMs = resolveClawHubRequestTimeoutMs(params.timeoutMs);
  const maxBytes = params.maxBytes ?? CLAWHUB_ARCHIVE_MAX_BYTES;
  const contentEncoding = normalizeOptionalString(params.response.headers.get("content-encoding"));
  const declaredSize =
    !contentEncoding || contentEncoding.toLowerCase() === "identity"
      ? parseStrictNonNegativeInteger(params.response.headers.get("content-length"))
      : undefined;
  if (declaredSize !== undefined && declaredSize > maxBytes) {
    // Fetch may decode encoded bodies while retaining their wire length, so
    // only identity lengths can safely short-circuit the decoded stream cap.
    await params.response.body?.cancel().catch(() => undefined);
    throw createClawHubBodyLimitError(params.resourceLabel, declaredSize, maxBytes, "declared");
  }
  return await readResponseWithLimit(params.response, maxBytes, {
    chunkTimeoutMs: timeoutMs,
    onOverflow: ({ size, maxBytes: limitBytes }) =>
      createClawHubBodyLimitError(params.resourceLabel, size, limitBytes),
    onIdleTimeout: ({ chunkTimeoutMs }) =>
      new Error(`ClawHub ${params.resourceLabel} body stalled after ${chunkTimeoutMs}ms`),
  });
}

function createClawHubBodyLimitError(
  resourceLabel: string,
  size: number,
  maxBytes: number,
  measurement: "declared" | "received" = "received",
): Error {
  return new Error(
    `ClawHub ${resourceLabel} exceeded ${maxBytes} bytes (${size} bytes ${measurement})`,
  );
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

function requiredStringField(
  source: Record<string, unknown>,
  field: string,
  context: string,
): string {
  const value = source[field];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new Error(`Malformed ClawHub ${context}: expected ${field} to be a non-empty string.`);
}

function requiredNumberField(
  source: Record<string, unknown>,
  field: string,
  context: string,
): number {
  const value = source[field];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new Error(`Malformed ClawHub ${context}: expected ${field} to be a number.`);
}

function optionalBooleanField(
  source: Record<string, unknown>,
  field: string,
  context: string,
): boolean | undefined {
  const value = source[field];
  if (value === undefined || typeof value === "boolean") {
    return value;
  }
  throw new Error(`Malformed ClawHub ${context}: expected ${field} to be a boolean.`);
}

function optionalStringArrayField(
  source: Record<string, unknown>,
  field: string,
  context: string,
): string[] | undefined {
  const value = source[field];
  if (value === undefined) {
    return undefined;
  }
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
  const releaseId = optionalStringField(value, "releaseId", "security release");
  const legacyId = optionalStringField(value, "id", "security release");
  const version = optionalStringField(value, "version", "security release");
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

/** Resolves the configured ClawHub base URL, falling back to the default public host. */
export function resolveClawHubBaseUrl(baseUrl?: string): string {
  return normalizeBaseUrl(baseUrl);
}

export function isDefaultClawHubBaseUrl(baseUrl?: string): boolean {
  return normalizeBaseUrl(baseUrl) === normalizeBaseUrl(DEFAULT_CLAWHUB_URL);
}

function buildVersionOrTagSearch(params: {
  version?: string;
  tag?: string;
  ownerHandle?: string;
}): { version?: string; tag?: string; ownerHandle?: string } | undefined {
  const version = normalizeOptionalString(params.version);
  const ownerHandle = normalizeOptionalString(params.ownerHandle);
  if (version) {
    return { version, ...(ownerHandle ? { ownerHandle } : {}) };
  }
  const tag = normalizeOptionalString(params.tag);
  if (tag) {
    return { tag, ...(ownerHandle ? { ownerHandle } : {}) };
  }
  return ownerHandle ? { ownerHandle } : undefined;
}

function buildGitHubZipUrl(repo: string, commit: string): string {
  const url = new URL(`${normalizeGitHubCodeloadBaseUrl()}/`);
  const basePath = url.pathname.replace(/\/+$/, "");
  const repoPath = repo
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  url.pathname = `${basePath}/${repoPath}/zip/${encodeURIComponent(commit)}`;
  return url.toString();
}

function formatSha256Integrity(bytes: Uint8Array): string {
  return `sha256-${sha256Base64(bytes)}`;
}

function formatSha256Hex(bytes: Uint8Array): string {
  return digestSha256Hex(bytes);
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

/** Normalizes ClawHub SHA-256 metadata into Subresource Integrity format. */
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

/** Normalizes ClawHub SHA-256 metadata into lowercase hex form. */
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
  ownerHandle?: string;
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
    search: params.ownerHandle ? { ownerHandle: params.ownerHandle } : undefined,
  });
}

export async function fetchClawHubSkillInstallResolution(params: {
  slug: string;
  ownerHandle?: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  forceInstall?: boolean;
}): Promise<ClawHubSkillInstallResolutionResponse> {
  const { response, url, hasToken } = await clawhubRequest({
    baseUrl: params.baseUrl,
    path: `/api/v1/skills/${encodeURIComponent(params.slug)}/install`,
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    search: {
      ownerHandle: params.ownerHandle,
      forceInstall: params.forceInstall ? "1" : undefined,
    },
  });
  const isStructuredBlock = [403, 409, 410, 423].includes(response.status);
  if (!response.ok && !isStructuredBlock) {
    throw await buildClawHubError(response, url, hasToken, params.timeoutMs);
  }
  return parseClawHubJsonBody<ClawHubSkillInstallResolutionResponse>(
    response,
    url,
    params.timeoutMs,
  );
}

export async function fetchClawHubSkillVerification(params: {
  slug: string;
  ownerHandle?: string;
  version?: string;
  tag?: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<ClawHubSkillVerificationResponse> {
  return await fetchJson<ClawHubSkillVerificationResponse>({
    baseUrl: params.baseUrl,
    path: `/api/v1/skills/${encodeURIComponent(params.slug)}/verify`,
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    search: buildVersionOrTagSearch(params),
  });
}

export async function fetchClawHubSkillSecurityVerdicts(params: {
  items: ClawHubSkillSecurityVerdictRequestItem[];
  baseUrl?: string;
  token?: string;
  skipAuth?: boolean;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<ClawHubSkillSecurityVerdictsResponse> {
  return await fetchJson<ClawHubSkillSecurityVerdictsResponse>({
    baseUrl: params.baseUrl,
    path: "/api/v1/skills/-/security-verdicts",
    method: "POST",
    json: { items: params.items },
    token: params.token,
    skipAuth: params.skipAuth,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
  });
}

export async function fetchClawHubSkillCard(params: {
  slug?: string;
  ownerHandle?: string;
  url?: string;
  version?: string;
  tag?: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<string> {
  const cardUrl = normalizeOptionalString(params.url);
  const slug = normalizeOptionalString(params.slug);
  if (!cardUrl && !slug) {
    throw new Error("ClawHub skill card fetch requires a slug or card URL");
  }
  const explicitToken = normalizeOptionalString(params.token);
  const skipAuth =
    cardUrl != null &&
    explicitToken == null &&
    new URL(cardUrl, `${normalizeBaseUrl(params.baseUrl)}/`).origin !==
      new URL(`${normalizeBaseUrl(params.baseUrl)}/`).origin;
  const { response, url, hasToken } = await clawhubRequest({
    baseUrl: params.baseUrl,
    url: cardUrl,
    path: slug ? `/api/v1/skills/${encodeURIComponent(slug)}/card` : undefined,
    token: explicitToken,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    search: cardUrl ? undefined : buildVersionOrTagSearch(params),
    skipAuth,
  });
  if (!response.ok) {
    throw await buildClawHubError(response, url, hasToken, params.timeoutMs);
  }
  const bytes = await readClawHubResponseBytes({
    response,
    maxBytes: SKILL_CARD_MAX_BYTES,
    timeoutMs: params.timeoutMs,
    resourceLabel: slug ? `skill card for ${slug}` : `skill card at ${url.pathname}`,
  });
  return new TextDecoder().decode(bytes);
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
      throw await buildClawHubError(response, url, hasToken, params.timeoutMs);
    }
    const bytes = await readClawHubResponseBytes({
      response,
      timeoutMs: params.timeoutMs,
      resourceLabel: `ClawPack download for ${params.name}@${params.version}`,
    });
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
    const specVersion = parseStrictPositiveInteger(rawSpecVersion);
    const target = await createTempDownloadTarget({
      prefix: "openclaw-clawhub-clawpack",
      fileName: npmTarballName,
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
    throw await buildClawHubError(response, url, hasToken, params.timeoutMs);
  }
  const bytes = await readClawHubResponseBytes({
    response,
    timeoutMs: params.timeoutMs,
    resourceLabel: `package archive download for ${params.name}`,
  });
  const sha256Hex = formatSha256Hex(bytes);
  const target = await createTempDownloadTarget({
    prefix: "openclaw-clawhub-package",
    fileName: `${params.name}.zip`,
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
  ownerHandle?: string;
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
      ownerHandle: params.ownerHandle,
      version: params.version,
      tag: params.version ? undefined : params.tag,
    },
  });
  if (!response.ok) {
    throw await buildClawHubError(response, url, hasToken, params.timeoutMs);
  }
  const bytes = await readClawHubResponseBytes({
    response,
    timeoutMs: params.timeoutMs,
    resourceLabel: `skill archive download for ${params.slug}`,
  });
  const sha256Hex = formatSha256Hex(bytes);
  const target = await createTempDownloadTarget({
    prefix: "openclaw-clawhub-skill",
    fileName: `${params.slug}.zip`,
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

export async function downloadClawHubSkillArchiveUrl(params: {
  url: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<ClawHubDownloadResult> {
  const explicitToken = normalizeOptionalString(params.token);
  const requestUrl = new URL(params.url, `${normalizeBaseUrl(params.baseUrl)}/`);
  const registryOrigin = new URL(`${normalizeBaseUrl(params.baseUrl)}/`).origin;
  const skipAuth = explicitToken == null && requestUrl.origin !== registryOrigin;
  const { response, url, hasToken } = await clawhubRequest({
    baseUrl: params.baseUrl,
    url: params.url,
    token: explicitToken,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    skipAuth,
  });
  if (!response.ok) {
    throw await buildClawHubError(response, url, hasToken, params.timeoutMs);
  }
  const bytes = await readClawHubResponseBytes({
    response,
    timeoutMs: params.timeoutMs,
    resourceLabel: `skill archive download at ${url.pathname}`,
  });
  const sha256Hex = formatSha256Hex(bytes);
  const target = await createTempDownloadTarget({
    prefix: "openclaw-clawhub-skill",
    fileName: "skill.zip",
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

export async function downloadClawHubGitHubSkillArchive(params: {
  repo: string;
  commit: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<ClawHubDownloadResult> {
  const downloadUrl = buildGitHubZipUrl(params.repo, params.commit);
  const { response, url, hasToken } = await clawhubRequest({
    url: downloadUrl,
    skipAuth: true,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
  });
  if (!response.ok) {
    throw await buildClawHubError(response, url, hasToken, params.timeoutMs);
  }
  const bytes = await readClawHubResponseBytes({
    response,
    timeoutMs: params.timeoutMs,
    resourceLabel: `GitHub source archive for ${params.repo}@${params.commit}`,
  });
  const sha256Hex = formatSha256Hex(bytes);
  const target = await createTempDownloadTarget({
    prefix: "openclaw-clawhub-github-skill",
    fileName: `${params.commit}.zip`,
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

export async function reportClawHubSkillInstallTelemetry(params: {
  baseUrl?: string;
  token?: string;
  slug: string;
  ownerHandle?: string;
  version?: string | null;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<void> {
  const token = normalizeOptionalString(params.token) ?? (await resolveClawHubAuthToken());
  if (!token || isClawHubTelemetryDisabled()) {
    return;
  }
  const slug = params.slug.trim();
  if (!slug) {
    return;
  }

  const { response, url, hasToken } = await clawhubRequest({
    baseUrl: params.baseUrl,
    path: "/api/cli/telemetry/install",
    method: "POST",
    token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    json: {
      event: "install",
      slug,
      ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
      version: params.version ?? undefined,
    },
  });
  if (!response.ok) {
    throw await buildClawHubError(response, url, hasToken, params.timeoutMs);
  }
}

function isClawHubTelemetryDisabled(): boolean {
  const raw = process.env.CLAWHUB_DISABLE_TELEMETRY ?? process.env.CLAWDHUB_DISABLE_TELEMETRY;
  if (!raw) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** Resolves the preferred latest package version from detail metadata. */
export function resolveLatestVersionFromPackage(detail: ClawHubPackageDetail): string | null {
  return detail.package?.latestVersion ?? detail.package?.tags?.latest ?? null;
}

/** Checks whether a host plugin API version satisfies a ClawHub plugin API range. */
export function satisfiesPluginApiRange(
  pluginApiVersion: string,
  pluginApiRange?: string | null,
): boolean {
  if (!pluginApiRange) {
    return true;
  }
  return satisfiesSemverRange(pluginApiVersion, pluginApiRange);
}

/** Checks whether the current gateway version satisfies a package minimum gateway version. */
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

// ─── ClawHub promotions ────────────────────────────────────────────────────
// Promotional model offers published by ClawHub (GET /api/v1/promotions).
// The payload is declarative only: provider/authChoiceId/pluginNames are
// validated against the local provider catalog by the caller before any
// install/auth action, so a malformed or hostile record cannot execute code.

export type ClawHubPromotionModel = {
  modelRef: string;
  alias?: string;
  suggestedDefault?: boolean;
};

export type ClawHubPromotion = {
  slug: string;
  title: string;
  blurb: string;
  sponsor?: string;
  status: string;
  active: boolean;
  startsAt: number;
  endsAt: number;
  provider?: string;
  authChoiceId?: string;
  pluginNames?: string[];
  models: ClawHubPromotionModel[];
  signupUrl?: string;
  docsUrl?: string;
  launchPageUrl?: string;
};

// A hosted-feed snapshot entry: the same declarative payload without the
// live-only status/active flags (the feed only ever contains live records;
// clients still window-filter on startsAt/endsAt).
export type ClawHubPromotionsFeedEntry = Omit<ClawHubPromotion, "status" | "active">;

export type ClawHubPromotionsFeed = {
  schemaVersion: number;
  id: string;
  generatedAt: string;
  sequence: number;
  expiresAt: string;
  entries: ClawHubPromotionsFeedEntry[];
};

// Shell-safe contract for provider/model refs: they are echoed into
// copy-paste CLI commands, so whitespace and shell metacharacters must fail
// parsing rather than reach a terminal.
const CLAWHUB_PROMOTION_MODEL_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function parseClawHubPromotionModel(value: unknown, context: string): ClawHubPromotionModel {
  if (!isJsonObject(value)) {
    throw new Error(`Malformed ClawHub ${context}: expected each model to be an object.`);
  }
  const modelRef = requiredStringField(value, "modelRef", context);
  if (!CLAWHUB_PROMOTION_MODEL_REF_RE.test(modelRef)) {
    throw new Error(`Malformed ClawHub ${context}: modelRef contains unsupported characters.`);
  }
  const model: ClawHubPromotionModel = {
    modelRef,
  };
  const alias = optionalStringField(value, "alias", context);
  if (alias) {
    model.alias = alias;
  }
  const suggestedDefault = optionalBooleanField(value, "suggestedDefault", context);
  if (suggestedDefault !== undefined) {
    model.suggestedDefault = suggestedDefault;
  }
  return model;
}

// ClawHub's server-side slug contract. Enforced here because slugs are echoed
// into copy-paste CLI commands; anything else would be a shell-injection path.
const CLAWHUB_PROMOTION_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// Safe identifier grammar for provider ids and auth choice ids.
const CLAWHUB_PROMOTION_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._@/-]*$/;

// Shared shape between the live API promotion and a feed entry: everything
// except the live-only `status`/`active` flags.
function parseClawHubPromotionCore(
  value: Record<string, unknown>,
  context: string,
): ClawHubPromotionsFeedEntry {
  const modelsRaw = value.models;
  if (!Array.isArray(modelsRaw) || modelsRaw.length === 0) {
    throw new Error(`Malformed ClawHub ${context}: expected models to be a non-empty array.`);
  }
  const slug = requiredStringField(value, "slug", context);
  if (!CLAWHUB_PROMOTION_SLUG_RE.test(slug)) {
    throw new Error(`Malformed ClawHub ${context}: slug must be lowercase [a-z0-9-].`);
  }
  const startsAt = requiredNumberField(value, "startsAt", context);
  const endsAt = requiredNumberField(value, "endsAt", context);
  if (endsAt <= startsAt) {
    throw new Error(`Malformed ClawHub ${context}: promotion window must end after it starts.`);
  }
  const promotion: ClawHubPromotionsFeedEntry = {
    slug,
    title: requiredStringField(value, "title", context),
    blurb: requiredStringField(value, "blurb", context),
    startsAt,
    endsAt,
    models: modelsRaw.map((entry) => parseClawHubPromotionModel(entry, context)),
  };
  const optionalStrings = ["sponsor", "signupUrl", "docsUrl", "launchPageUrl"] as const;
  for (const field of optionalStrings) {
    const parsed = optionalStringField(value, field, context);
    if (parsed) {
      promotion[field] = parsed;
    }
  }
  // Identifier fields are echoed into error messages and config; hold them to
  // a safe identifier grammar so remote payloads cannot smuggle terminal
  // controls or whitespace through failure paths.
  const identifierFields = ["provider", "authChoiceId"] as const;
  for (const field of identifierFields) {
    const parsed = optionalStringField(value, field, context);
    if (!parsed) {
      continue;
    }
    if (!CLAWHUB_PROMOTION_IDENTIFIER_RE.test(parsed)) {
      throw new Error(`Malformed ClawHub ${context}: ${field} contains unsupported characters.`);
    }
    promotion[field] = parsed;
  }
  const pluginNames = optionalStringArrayField(value, "pluginNames", context);
  if (pluginNames && pluginNames.length > 0) {
    for (const name of pluginNames) {
      const parsed = parseRegistryNpmSpec(name);
      if (!parsed || parsed.selectorKind !== "none" || parsed.name !== name) {
        throw new Error(
          `Malformed ClawHub ${context}: pluginNames must contain npm package names.`,
        );
      }
    }
    promotion.pluginNames = pluginNames;
  }
  return promotion;
}

export function parseClawHubPromotion(value: unknown): ClawHubPromotion {
  const context = "promotion";
  if (!isJsonObject(value)) {
    throw new Error(`Malformed ClawHub ${context}: expected an object.`);
  }
  return {
    ...parseClawHubPromotionCore(value, context),
    status: requiredStringField(value, "status", context),
    active: requiredBooleanField(value, "active", context),
  };
}

export async function fetchClawHubPromotions(
  params: {
    baseUrl?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
  } = {},
): Promise<ClawHubPromotion[]> {
  const response = await fetchJson<unknown>({
    baseUrl: params.baseUrl,
    path: "/api/v1/promotions",
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
  });
  if (!isJsonObject(response) || !Array.isArray(response.promotions)) {
    throw new Error("Malformed ClawHub promotions response: expected a promotions array.");
  }
  return response.promotions.map((entry) => parseClawHubPromotion(entry));
}

export async function fetchClawHubPromotion(params: {
  slug: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<ClawHubPromotion> {
  const response = await fetchJson<unknown>({
    baseUrl: params.baseUrl,
    path: `/api/v1/promotions/${encodeURIComponent(params.slug)}`,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
  });
  return parseClawHubPromotion(response);
}

// ─── ClawHub promotions feed (GET /api/v1/feeds/promotions) ───────────────
// Immutable hosted snapshot used for passive discovery: cheap conditional
// GETs (`If-None-Match` → 304), never authoritative for claiming — `promos
// claim` always revalidates against the live API so the kill switch wins
// regardless of snapshot staleness.

const CLAWHUB_PROMOTIONS_FEED_ID = "clawhub-promotions";
// Strict cross-repo wire contract with ClawHub's promotionsFeed publisher.
// Bump only in lockstep with the server-side schema.
const CLAWHUB_PROMOTIONS_FEED_SCHEMA_VERSION = 1;

export function parseClawHubPromotionsFeed(value: unknown): ClawHubPromotionsFeed {
  const context = "promotions feed";
  if (!isJsonObject(value)) {
    throw new Error(`Malformed ClawHub ${context}: expected an object.`);
  }
  const id = requiredStringField(value, "id", context);
  if (id !== CLAWHUB_PROMOTIONS_FEED_ID) {
    throw new Error(`Malformed ClawHub ${context}: unexpected feed id.`);
  }
  const schemaVersion = requiredNumberField(value, "schemaVersion", context);
  if (schemaVersion !== CLAWHUB_PROMOTIONS_FEED_SCHEMA_VERSION) {
    throw new Error(`Unsupported ClawHub ${context} schema version ${schemaVersion}.`);
  }
  const sequence = requiredNumberField(value, "sequence", context);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error(`Malformed ClawHub ${context}: sequence must be a non-negative integer.`);
  }
  const generatedAt = requiredStringField(value, "generatedAt", context);
  const expiresAt = requiredStringField(value, "expiresAt", context);
  const generatedAtMs = Date.parse(generatedAt);
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(generatedAtMs) || !Number.isFinite(expiresAtMs)) {
    throw new Error(`Malformed ClawHub ${context}: timestamps must be ISO dates.`);
  }
  if (expiresAtMs <= generatedAtMs) {
    throw new Error(`Malformed ClawHub ${context}: expiresAt must be after generatedAt.`);
  }
  const entriesRaw = value.entries;
  if (!Array.isArray(entriesRaw)) {
    throw new Error(`Malformed ClawHub ${context}: expected an entries array.`);
  }
  const entries = entriesRaw.map((entry) => {
    if (!isJsonObject(entry)) {
      throw new Error(`Malformed ClawHub ${context}: expected each entry to be an object.`);
    }
    if (requiredStringField(entry, "type", context) !== "promotion") {
      throw new Error(`Malformed ClawHub ${context}: unexpected entry type.`);
    }
    return parseClawHubPromotionCore(entry, context);
  });
  return { schemaVersion, id, generatedAt, sequence, expiresAt, entries };
}

export type ClawHubPromotionsFeedFetchResult =
  | { status: "not-modified" }
  | { status: "ok"; feed: ClawHubPromotionsFeed; payload: string; etag?: string };

export async function fetchClawHubPromotionsFeed(
  params: {
    etag?: string;
    baseUrl?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
  } = {},
): Promise<ClawHubPromotionsFeedFetchResult> {
  const { response, url } = await clawhubRequest({
    baseUrl: params.baseUrl,
    path: "/api/v1/feeds/promotions",
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    // This passive refresh runs inline from interactive commands. Its cache
    // cadence owns retries; shared backoff would turn the 2.5s cap into ~24s.
    retryTransientReads: false,
    // Public CDN-served snapshot; an Authorization header would only
    // fragment edge caches.
    skipAuth: true,
    ...(params.etag ? { headers: { "If-None-Match": params.etag } } : {}),
  });
  if (response.status === 304) {
    return { status: "not-modified" };
  }
  if (!response.ok) {
    throw await buildClawHubError(response, url, false, params.timeoutMs);
  }
  const buffer = await readClawHubResponseBytes({
    response,
    maxBytes: CLAWHUB_JSON_MAX_BYTES,
    timeoutMs: params.timeoutMs,
    resourceLabel: "promotions feed",
  });
  const payload = new TextDecoder().decode(buffer);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(payload);
  } catch (cause) {
    throw new Error(`ClawHub ${url.pathname} returned malformed JSON`, { cause });
  }
  const feed = parseClawHubPromotionsFeed(parsedJson);
  const etag = response.headers.get("etag") ?? undefined;
  return { status: "ok", feed, payload, ...(etag ? { etag } : {}) };
}
