/** Reads official external plugin/channel/provider catalogs into manifest-like metadata. */
import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub.js";
import { readResponseWithLimit } from "../infra/http-body.js";
import { isRecord } from "../utils.js";
import type {
  PluginManifestCatalog,
  PluginManifestChannelConfig,
  PluginManifestContracts,
  PluginManifestProviderEndpoint,
  PluginPackageInstall,
} from "./manifest.js";
import { BUNDLED_OFFICIAL_EXTERNAL_PLUGIN_CATALOGS } from "./official-external-plugin-bundled-catalogs.js";

type ManifestKey = typeof MANIFEST_KEY;

class HostedCatalogSnapshotWriteError extends Error {
  readonly originalError: unknown;

  constructor(originalError: unknown) {
    super("hosted catalog snapshot write failed");
    this.name = "HostedCatalogSnapshotWriteError";
    this.originalError = originalError;
  }
}

class HostedCatalogTrustConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostedCatalogTrustConfigurationError";
  }
}

export type OfficialExternalProviderAuthChoice = {
  method?: string;
  choiceId?: string;
  deprecatedChoiceIds?: readonly string[];
  choiceLabel?: string;
  choiceHint?: string;
  assistantPriority?: number;
  assistantVisibility?: "visible" | "manual-only";
  groupId?: string;
  groupLabel?: string;
  groupHint?: string;
  optionKey?: string;
  cliFlag?: string;
  cliOption?: string;
  cliDescription?: string;
  onboardingScopes?: readonly ("text-inference" | "image-generation" | "music-generation")[];
};

type OfficialExternalProviderCatalogProvider = {
  id?: string;
  aliases?: readonly string[];
  name?: string;
  docs?: string;
  categories?: readonly string[];
  envVars?: readonly string[];
  authChoices?: readonly OfficialExternalProviderAuthChoice[];
};

export type OfficialExternalWebSearchProvider = {
  id?: string;
  label?: string;
  hint?: string;
  onboardingScopes?: readonly "text-inference"[];
  requiresCredential?: boolean;
  credentialLabel?: string;
  envVars?: readonly string[];
  placeholder?: string;
  signupUrl?: string;
  docsUrl?: string;
  credentialPath?: string;
  autoDetectOrder?: number;
};

/** Manifest-like metadata stored in official external catalog entries. */
type OfficialExternalPluginCatalogManifest = {
  plugin?: {
    id?: string;
    label?: string;
  };
  catalog?: PluginManifestCatalog;
  channel?: {
    id?: string;
    label?: string;
    envVars?: readonly string[];
  };
  providers?: readonly OfficialExternalProviderCatalogProvider[];
  /**
   * Mirrors the plugin manifest's providerEndpoints so endpoint classification
   * keeps working when the plugin is not installed (dist excludes it).
   */
  providerEndpoints?: readonly PluginManifestProviderEndpoint[];
  webSearchProviders?: readonly OfficialExternalWebSearchProvider[];
  install?: PluginPackageInstall & { sourceRef?: string };
  contracts?: PluginManifestContracts;
  channelConfigs?: Record<string, PluginManifestChannelConfig>;
};

/** Raw official external catalog entry loaded from generated catalog JSON. */
export type OfficialExternalPluginCatalogEntry = {
  id?: string;
  title?: string;
  type?: string;
  state?: string;
  publisher?: {
    id?: string;
    trust?: string;
  };
  name?: string;
  version?: string;
  description?: string;
  icon?: string;
  source?: string;
  kind?: string;
  featured?: boolean;
  featuredAt?: number;
  install?: {
    candidates?: readonly OfficialExternalPluginCatalogInstallCandidate[];
  };
} & Partial<Record<ManifestKey, OfficialExternalPluginCatalogManifest>>;

type OfficialExternalPluginCatalogInstallCandidate = {
  sourceRef?: string;
  package?: string;
  version?: string;
  integrity?: string;
  repo?: string;
  path?: string;
  commit?: string;
};

type OfficialExternalPluginCatalogSourceProfile =
  | {
      type: "npm";
      registry?: string;
    }
  | {
      type: "clawhub";
      baseUrl?: string;
    }
  | {
      type: "git";
      baseUrl?: string;
    };

type OfficialExternalPluginCatalogFeedProfile = {
  url: string;
  feedId?: string;
  verification?: OfficialExternalPluginCatalogFeedVerification;
};

type OfficialExternalPluginCatalogFeedVerification =
  | {
      mode: "unsigned";
    }
  | {
      mode: "signed";
      keys: readonly OfficialExternalPluginCatalogFeedSigningKey[];
      threshold?: number;
    };

export type OfficialExternalPluginCatalogFeedSigningKey = {
  keyId: string;
  publicKey: string;
};

type OfficialExternalPluginCatalogProfileConfig = {
  feeds?: Record<string, OfficialExternalPluginCatalogFeedProfile>;
  sources?: Record<string, OfficialExternalPluginCatalogSourceProfile>;
};

/** Feed-shaped wrapper used by the bundled external plugin catalog fallback. */
export type OfficialExternalPluginCatalogFeed = {
  schemaVersion: 1 | 2;
  id: string;
  generatedAt: string;
  expiresAt?: string;
  sequence: number;
  description?: string;
  entries: readonly OfficialExternalPluginCatalogEntry[];
};

export type HostedOfficialExternalPluginCatalogMetadata = {
  url: string;
  status: number;
  etag?: string;
  lastModified?: string;
  checksum: string;
};

export type HostedOfficialExternalPluginCatalogSnapshot = {
  body: string;
  metadata: HostedOfficialExternalPluginCatalogMetadata;
  savedAt: string;
  trust?: HostedOfficialExternalPluginCatalogTrustState;
  monotonic?: HostedOfficialExternalPluginCatalogSnapshotMonotonicState;
};

export type HostedOfficialExternalPluginCatalogSnapshotStore = {
  read: (url: string) => Promise<HostedOfficialExternalPluginCatalogSnapshot | null | undefined>;
  write: (snapshot: HostedOfficialExternalPluginCatalogSnapshot) => Promise<void>;
};

export type HostedOfficialExternalPluginCatalogTrustState = {
  mode: "signed";
  signedBy: string;
  signatureCount: number;
  threshold: number;
  verifiedAt: string;
};

export class HostedCatalogSignedFeedMonotonicityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostedCatalogSignedFeedMonotonicityError";
  }
}

export type HostedOfficialExternalPluginCatalogSnapshotMonotonicState = {
  mode: "signed-feed";
  sequence: number;
  generatedAt?: string;
};

export type HostedOfficialExternalPluginCatalogLoadResult =
  | {
      source: "hosted";
      entries: OfficialExternalPluginCatalogEntry[];
      feed: OfficialExternalPluginCatalogFeed;
      metadata: HostedOfficialExternalPluginCatalogMetadata;
      trust?: HostedOfficialExternalPluginCatalogTrustState;
    }
  | {
      source: "hosted-snapshot";
      entries: OfficialExternalPluginCatalogEntry[];
      feed: OfficialExternalPluginCatalogFeed;
      metadata: HostedOfficialExternalPluginCatalogMetadata;
      snapshot: HostedOfficialExternalPluginCatalogSnapshot;
      trust?: HostedOfficialExternalPluginCatalogTrustState;
      error: string;
    }
  | {
      source: "bundled-fallback";
      entries: OfficialExternalPluginCatalogEntry[];
      error: string;
      metadata?: Omit<HostedOfficialExternalPluginCatalogMetadata, "checksum"> & {
        checksum?: string;
      };
    };

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type OfficialExternalProviderContract =
  | "embeddingProviders"
  | "mediaUnderstandingProviders"
  | "memoryEmbeddingProviders"
  | "speechProviders"
  | "webFetchProviders";

const SUPPORTED_OFFICIAL_EXTERNAL_CATALOG_FEED_SCHEMA_VERSIONS = new Set([1, 2]);
export const DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_URL =
  "https://clawhub.ai/v1/feeds/plugins";
export const DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PROFILE = "clawhub-public";
export const DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_ID = "clawhub-official";
const DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_CLAWHUB_SOURCE_REF = "public-clawhub";
const DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_NPM_SOURCE_REF = "public-npm";
export const DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_CLAWHUB_TRUSTED_KEY_ID_ENV =
  "OPENCLAW_CLAWHUB_FEED_TRUSTED_KEY_ID";
export const DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_CLAWHUB_TRUSTED_PUBLIC_KEY_ENV =
  "OPENCLAW_CLAWHUB_FEED_TRUSTED_PUBLIC_KEY";
export const DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_CLAWHUB_TRUSTED_KEYS: readonly OfficialExternalPluginCatalogFeedSigningKey[] =
  [];
const DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_PROFILE_CONFIG: OfficialExternalPluginCatalogProfileConfig =
  {
    feeds: {
      [DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PROFILE]: {
        url: DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_URL,
        feedId: DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_ID,
      },
    },
    sources: {
      [DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_CLAWHUB_SOURCE_REF]: {
        type: "clawhub",
        baseUrl: "https://clawhub.ai",
      },
      [DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_NPM_SOURCE_REF]: {
        type: "npm",
        registry: "https://registry.npmjs.org/",
      },
    },
  };
const DEFAULT_HOSTED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_TIMEOUT_MS = 5000;
const DEFAULT_HOSTED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_MAX_BYTES = 1024 * 1024;
const DEFAULT_HOSTED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_CHUNK_TIMEOUT_MS = 5000;
const DSSE_ENVELOPE_MEDIA_TYPE = "application/vnd.dsse+json";
const OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_HOSTNAME_ALLOWLIST = ["clawhub.ai"];
const ISO_CALENDAR_DATE_PREFIX_RE = /^(\d{4})-(\d{2})-(\d{2})/u;

export function parseOfficialExternalPluginCatalogTimestamp(value: string): number | undefined {
  const timestamp = value.trim();
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  const calendarDate = ISO_CALENDAR_DATE_PREFIX_RE.exec(timestamp);
  if (!calendarDate) {
    return parsed;
  }
  const year = Number(calendarDate[1]);
  const month = Number(calendarDate[2]);
  const day = Number(calendarDate[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  // Shipped releases accepted every Date.parse-compatible serialization. Keep those
  // formats, but reject ISO-shaped impossible dates that Date.parse normalizes.
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1]!
    ? parsed
    : undefined;
}

export function isOfficialExternalPluginCatalogSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isOfficialExternalPluginCatalogFeed(
  raw: unknown,
): raw is OfficialExternalPluginCatalogFeed {
  if (!isRecord(raw)) {
    return false;
  }
  const sequence = raw.sequence;
  const generatedAt = raw.generatedAt;
  const generatedAtMs =
    typeof generatedAt === "string"
      ? parseOfficialExternalPluginCatalogTimestamp(generatedAt)
      : undefined;
  const entries = raw.entries;
  return (
    typeof raw.schemaVersion === "number" &&
    SUPPORTED_OFFICIAL_EXTERNAL_CATALOG_FEED_SCHEMA_VERSIONS.has(raw.schemaVersion) &&
    typeof raw.id === "string" &&
    raw.id.trim().length > 0 &&
    typeof generatedAt === "string" &&
    generatedAt.trim().length > 0 &&
    generatedAtMs !== undefined &&
    isOfficialExternalPluginCatalogSequence(sequence) &&
    Array.isArray(entries)
  );
}

function parseOfficialExternalPluginCatalogEntries(
  raw: unknown,
): OfficialExternalPluginCatalogEntry[] {
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is OfficialExternalPluginCatalogEntry => isRecord(entry));
  }
  if (isOfficialExternalPluginCatalogFeed(raw)) {
    return raw.entries.filter((entry): entry is OfficialExternalPluginCatalogEntry =>
      isRecord(entry),
    );
  }
  if (!isRecord(raw)) {
    return [];
  }
  if ("schemaVersion" in raw) {
    return [];
  }
  const list = raw.entries ?? raw.packages ?? raw.plugins;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter((entry): entry is OfficialExternalPluginCatalogEntry => isRecord(entry));
}

function normalizeHostedCatalogHeader(value: string | null): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized || undefined;
}

function sha256Hex(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function resolveHostedCatalogFeedUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error("hosted catalog feed URL is invalid");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("hosted catalog feed URL must use HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("hosted catalog feed URL must not include credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("hosted catalog feed URL must not include query strings or fragments");
  }
  return parsed;
}

function resolveDefaultClawHubFeedVerificationFromEnv(
  env?: NodeJS.ProcessEnv,
): OfficialExternalPluginCatalogFeedVerification | undefined {
  const keyId = normalizeOptionalString(
    env?.[DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_CLAWHUB_TRUSTED_KEY_ID_ENV],
  );
  const publicKey = normalizeOptionalString(
    env?.[DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_CLAWHUB_TRUSTED_PUBLIC_KEY_ENV],
  );
  if (!keyId && !publicKey) {
    return undefined;
  }
  if (!keyId || !publicKey) {
    throw new HostedCatalogTrustConfigurationError(
      "default ClawHub feed trust requires both key id and public key env vars",
    );
  }
  return {
    mode: "signed",
    keys: [{ keyId, publicKey }],
  };
}

function resolveOfficialExternalPluginCatalogProfileConfig(
  config?: OfficialExternalPluginCatalogProfileConfig,
  env?: NodeJS.ProcessEnv,
): Required<OfficialExternalPluginCatalogProfileConfig> {
  const configuredDefaultFeed =
    config?.feeds?.[DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PROFILE];
  const envVerification = configuredDefaultFeed?.verification
    ? undefined
    : resolveDefaultClawHubFeedVerificationFromEnv(env);
  const bundledVerification =
    DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_CLAWHUB_TRUSTED_KEYS.length > 0
      ? {
          mode: "signed" as const,
          keys: DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_CLAWHUB_TRUSTED_KEYS,
        }
      : undefined;
  const defaultVerification = envVerification ?? bundledVerification;
  const defaultFeed = DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_PROFILE_CONFIG.feeds?.[
    DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PROFILE
  ] ?? {
    url: DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_URL,
    feedId: DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_ID,
  };
  return {
    feeds: {
      ...config?.feeds,
      [DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PROFILE]: {
        ...defaultFeed,
        ...(defaultVerification ? { verification: defaultVerification } : {}),
        ...configuredDefaultFeed,
      },
    },
    sources: {
      ...DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_PROFILE_CONFIG.sources,
      ...config?.sources,
    },
  };
}

function resolveHostedCatalogFeedSource(params: {
  feedUrl?: string;
  feedProfile?: string;
  catalogConfig?: OfficialExternalPluginCatalogProfileConfig;
  env?: NodeJS.ProcessEnv;
}): {
  url: URL;
  hostnameAllowlist: string[];
  expectedFeedId?: string;
  verification?: OfficialExternalPluginCatalogFeedVerification;
} {
  const explicitFeedUrl = normalizeOptionalString(params.feedUrl);
  const explicitProfileName = normalizeOptionalString(params.feedProfile);
  if (explicitFeedUrl) {
    const url = resolveHostedCatalogFeedUrl(explicitFeedUrl);
    if (!OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_HOSTNAME_ALLOWLIST.includes(url.hostname)) {
      throw new Error("hosted catalog feed URL hostname is not allowed");
    }
    const profileConfig =
      explicitProfileName === undefined
        ? undefined
        : resolveOfficialExternalPluginCatalogProfileConfig(
            params.catalogConfig,
            explicitProfileName === DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PROFILE
              ? params.env
              : undefined,
          );
    const profile =
      explicitProfileName === undefined ? undefined : profileConfig?.feeds[explicitProfileName];
    if (explicitProfileName !== undefined && !profile) {
      throw new Error(`hosted catalog feed profile "${explicitProfileName}" is not configured`);
    }
    if (profile?.verification?.mode === "signed" && !profile.feedId) {
      throw new HostedCatalogTrustConfigurationError(
        `signed hosted catalog feed profile "${explicitProfileName}" requires feedId`,
      );
    }
    return {
      url,
      hostnameAllowlist: OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_HOSTNAME_ALLOWLIST,
      ...(profile?.feedId ? { expectedFeedId: profile.feedId } : {}),
      ...(profile?.verification ? { verification: profile.verification } : {}),
    };
  }
  const profileName = explicitProfileName ?? DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PROFILE;
  const profileConfig = resolveOfficialExternalPluginCatalogProfileConfig(
    params.catalogConfig,
    profileName === DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PROFILE ? params.env : undefined,
  );
  const profile = profileConfig.feeds[profileName];
  if (!profile) {
    throw new Error(`hosted catalog feed profile "${profileName}" is not configured`);
  }
  if (profile.verification?.mode === "signed" && !profile.feedId) {
    throw new HostedCatalogTrustConfigurationError(
      `signed hosted catalog feed profile "${profileName}" requires feedId`,
    );
  }
  const url = resolveHostedCatalogFeedUrl(profile.url);
  return {
    url,
    hostnameAllowlist: uniqueStrings([
      ...OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_HOSTNAME_ALLOWLIST,
      url.hostname,
    ]),
    ...(profile.feedId ? { expectedFeedId: profile.feedId } : {}),
    verification: profile.verification,
  };
}

function getOfficialExternalPluginCatalogSourceRefs(
  config?: OfficialExternalPluginCatalogProfileConfig,
): Set<string> {
  return new Set(Object.keys(resolveOfficialExternalPluginCatalogProfileConfig(config).sources));
}

function getFeedEntryInstallCandidateRecords(
  entry: OfficialExternalPluginCatalogEntry,
): OfficialExternalPluginCatalogInstallCandidate[] {
  const install = isRecord(entry.install) ? entry.install : undefined;
  const candidates = install?.candidates;
  if (!Array.isArray(candidates)) {
    return [];
  }
  return candidates.filter(
    (candidate): candidate is OfficialExternalPluginCatalogInstallCandidate => isRecord(candidate),
  );
}

function getFeedEntryInstallCandidates(
  entry: OfficialExternalPluginCatalogEntry,
): OfficialExternalPluginCatalogInstallCandidate[] {
  const state = normalizeOptionalString(entry.state);
  if (state !== "available") {
    return [];
  }
  const publisherTrust = normalizeOptionalString(entry.publisher?.trust);
  if (publisherTrust !== "official") {
    return [];
  }
  return getFeedEntryInstallCandidateRecords(entry);
}

function shouldRequireManifestInstallSourceRef(params: {
  feedUrl?: string;
  feedProfile?: string;
  catalogConfig?: OfficialExternalPluginCatalogProfileConfig;
}): boolean {
  const feedUrl = normalizeOptionalString(params.feedUrl);
  if (feedUrl) {
    try {
      return (
        resolveHostedCatalogFeedUrl(feedUrl).href !==
        resolveHostedCatalogFeedUrl(DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_URL).href
      );
    } catch {
      return true;
    }
  }
  const profileName =
    normalizeOptionalString(params.feedProfile) ??
    DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PROFILE;
  if (profileName !== DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PROFILE) {
    return true;
  }
  const profileConfig = resolveOfficialExternalPluginCatalogProfileConfig(params.catalogConfig);
  const profileUrl = normalizeOptionalString(profileConfig.feeds[profileName]?.url);
  try {
    return (
      resolveHostedCatalogFeedUrl(profileUrl ?? DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_URL)
        .href !==
      resolveHostedCatalogFeedUrl(DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_URL).href
    );
  } catch {
    return true;
  }
}

function getManifestInstallSourceRefCandidate(
  entry: OfficialExternalPluginCatalogEntry,
): OfficialExternalPluginCatalogInstallCandidate | undefined {
  const install = getOfficialExternalPluginCatalogManifest(entry)?.install;
  if (!install) {
    return undefined;
  }
  const hasInstallSpec = Boolean(
    normalizeOptionalString(install.clawhubSpec) ||
    normalizeOptionalString(install.npmSpec) ||
    normalizeOptionalString(install.localPath),
  );
  if (!hasInstallSpec) {
    return undefined;
  }
  return {
    sourceRef: normalizeOptionalString(install.sourceRef),
    package:
      normalizeOptionalString(install.npmSpec) ?? normalizeOptionalString(install.clawhubSpec),
  };
}

function validateOfficialExternalPluginCatalogEntrySourceRefs(
  entry: OfficialExternalPluginCatalogEntry,
  params?: {
    catalogConfig?: OfficialExternalPluginCatalogProfileConfig;
    requireManifestInstallSourceRef?: boolean;
  },
): string[] {
  const configuredSourceRefs = getOfficialExternalPluginCatalogSourceRefs(params?.catalogConfig);
  const errors: string[] = [];
  let candidates = getFeedEntryInstallCandidateRecords(entry);
  if (params?.requireManifestInstallSourceRef) {
    const manifestCandidate = getManifestInstallSourceRefCandidate(entry);
    if (manifestCandidate) {
      candidates = [...candidates, manifestCandidate];
    } else if (candidates.length === 0) {
      candidates = [{}];
    }
  }
  for (const candidate of candidates) {
    const sourceRef = normalizeOptionalString(candidate.sourceRef);
    if (!sourceRef) {
      errors.push("feed install candidate is missing sourceRef");
    } else if (!configuredSourceRefs.has(sourceRef)) {
      errors.push(`feed install candidate references unknown sourceRef "${sourceRef}"`);
    }
  }
  return errors;
}

function filterOfficialExternalPluginCatalogEntriesBySourceRefs(
  entries: OfficialExternalPluginCatalogEntry[],
  params?: {
    catalogConfig?: OfficialExternalPluginCatalogProfileConfig;
    requireManifestInstallSourceRef?: boolean;
  },
): OfficialExternalPluginCatalogEntry[] {
  return entries.filter(
    (entry) => validateOfficialExternalPluginCatalogEntrySourceRefs(entry, params).length === 0,
  );
}

function parseHostedCatalogContentLength(raw: string | null, maxBytes: number): void {
  const normalized = normalizeOptionalString(raw);
  if (!normalized) {
    return;
  }
  if (!/^\d+$/.test(normalized)) {
    throw new Error("hosted catalog feed has invalid content-length");
  }
  const size = Number(normalized);
  if (!Number.isSafeInteger(size) || size > maxBytes) {
    throw new Error(`hosted catalog feed exceeds ${maxBytes} bytes`);
  }
}

async function readHostedCatalogResponseText(params: {
  response: Response;
  maxBytes: number;
  chunkTimeoutMs: number;
}): Promise<string> {
  parseHostedCatalogContentLength(params.response.headers.get("content-length"), params.maxBytes);
  const streamless = !params.response.body || typeof params.response.body.getReader !== "function";
  // Hosted remote feeds are untrusted input, so fail closed when Fetch cannot
  // provide a streaming body instead of trusting Content-Length before read.
  if (streamless) {
    throw new Error("hosted catalog feed streaming response body unavailable");
  }
  const buffer = await readResponseWithLimit(params.response, params.maxBytes, {
    chunkTimeoutMs: params.chunkTimeoutMs,
    onOverflow: ({ maxBytes }) => new Error(`hosted catalog feed exceeds ${maxBytes} bytes`),
    onIdleTimeout: ({ chunkTimeoutMs }) =>
      new Error(`hosted catalog feed read timed out after ${chunkTimeoutMs}ms`),
  });
  return new TextDecoder().decode(buffer);
}

function bundledOfficialExternalPluginCatalogEntries(): OfficialExternalPluginCatalogEntry[] {
  return BUNDLED_OFFICIAL_EXTERNAL_PLUGIN_CATALOGS.flatMap((source) =>
    filterOfficialExternalPluginCatalogEntriesBySourceRefs(
      parseOfficialExternalPluginCatalogEntries(source),
    ),
  );
}

function dedupeOfficialExternalPluginCatalogEntries(
  entries: OfficialExternalPluginCatalogEntry[],
): OfficialExternalPluginCatalogEntry[] {
  const resolved = new Map<string, OfficialExternalPluginCatalogEntry>();
  for (const entry of entries) {
    const key = resolveOfficialExternalPluginCatalogEntryKey(entry);
    if (key && !resolved.has(key)) {
      resolved.set(key, entry);
    }
  }
  return [...resolved.values()];
}

function resolveOfficialExternalPluginCatalogEntryKey(
  entry: OfficialExternalPluginCatalogEntry,
): string | undefined {
  const pluginId = resolveOfficialExternalPluginId(entry);
  if (pluginId) {
    return `${normalizeOptionalString(entry.kind) ?? "plugin"}:${pluginId}`;
  }
  const name = normalizeOptionalString(entry.name);
  if (name) {
    return name;
  }
  const id = normalizeOptionalString(entry.id);
  if (id) {
    return `${normalizeOptionalString(entry.kind) ?? normalizeOptionalString(entry.type) ?? "plugin"}:${id}`;
  }
  return undefined;
}

function formatHostedCatalogError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bundledFallbackResult(
  error: unknown,
  metadata?: HostedOfficialExternalPluginCatalogLoadResult["metadata"],
): HostedOfficialExternalPluginCatalogLoadResult {
  return {
    source: "bundled-fallback",
    entries: listOfficialExternalPluginCatalogEntries(),
    error: formatHostedCatalogError(error),
    ...(metadata ? { metadata } : {}),
  };
}

function emptyBundledFallbackResult(error: unknown): HostedOfficialExternalPluginCatalogLoadResult {
  return {
    source: "bundled-fallback",
    entries: [],
    error: formatHostedCatalogError(error),
  };
}

async function parseHostedCatalogFeedBody(params: {
  body: string;
  expectedFeedId?: string;
  verification?: OfficialExternalPluginCatalogFeedVerification;
  verifiedAt: string;
  allowLegacyBetaEnvelope?: boolean;
  now: Date;
  allowExpired?: boolean;
  allowMissingExpiry?: boolean;
}): Promise<{
  feed: OfficialExternalPluginCatalogFeed;
  trust?: HostedOfficialExternalPluginCatalogTrustState;
  expired?: boolean;
}> {
  const raw = JSON.parse(params.body) as unknown;
  if (params.verification?.mode === "signed") {
    const { verifyOfficialExternalPluginCatalogSignedEnvelope } =
      await import("./official-external-plugin-catalog-envelope.js");
    const threshold = params.verification.threshold ?? 1;
    const verification = verifyOfficialExternalPluginCatalogSignedEnvelope(raw, {
      trustedKeys: params.verification.keys,
      threshold,
      ...(params.allowLegacyBetaEnvelope ? { allowLegacyBetaEnvelope: true } : {}),
    });
    if (!verification.ok) {
      const invalidTimestampSequence =
        verification.error === "invalid-payload" && "authenticatedPayload" in verification
          ? readOfficialExternalPluginCatalogInvalidTimestampSequence(
              verification.authenticatedPayload,
            )
          : undefined;
      if (invalidTimestampSequence !== undefined) {
        throw new HostedCatalogFeedTimestampError(verification.message, invalidTimestampSequence);
      }
      throw new Error(verification.message);
    }
    if (params.expectedFeedId && verification.feed.id !== params.expectedFeedId) {
      throw new Error(
        `hosted catalog feed id "${verification.feed.id}" did not match expected "${params.expectedFeedId}"`,
      );
    }
    const generatedAtMs = Date.parse(verification.feed.generatedAt);
    const expiresAt = normalizeOptionalString(verification.feed.expiresAt);
    if (!Number.isFinite(generatedAtMs)) {
      throw new Error("hosted catalog signed feed requires a valid generatedAt value");
    }
    let expired: boolean;
    if (!expiresAt) {
      if (params.allowMissingExpiry !== true) {
        throw new Error("hosted catalog signed feed requires a valid expiresAt value");
      }
      expired = true;
    } else {
      const expiresAtMs = Date.parse(expiresAt);
      if (!Number.isFinite(expiresAtMs)) {
        throw new Error("hosted catalog signed feed requires a valid expiresAt value");
      }
      if (expiresAtMs <= generatedAtMs) {
        throw new Error("hosted catalog signed feed expiresAt must be later than generatedAt");
      }
      expired = expiresAtMs <= params.now.getTime();
    }
    if (expired && params.allowExpired !== true) {
      throw new Error(
        expiresAt
          ? `hosted catalog signed feed expired at ${expiresAt}`
          : "hosted catalog signed feed has no expiresAt",
      );
    }
    return {
      feed: verification.feed,
      trust: {
        mode: "signed",
        signedBy: verification.signedBy,
        signatureCount: verification.signatureCount ?? 1,
        threshold,
        verifiedAt: params.verifiedAt,
      },
      ...(expired ? { expired: true } : {}),
    };
  }
  if (!isOfficialExternalPluginCatalogFeed(raw)) {
    throw new Error("hosted catalog feed did not match a supported schema version");
  }
  if (params.expectedFeedId && raw.id !== params.expectedFeedId) {
    throw new Error(
      `hosted catalog feed id "${raw.id}" did not match expected "${params.expectedFeedId}"`,
    );
  }
  return { feed: raw };
}

class HostedCatalogFeedTimestampError extends Error {
  constructor(
    message: string,
    readonly sequence: number,
  ) {
    super(message);
  }
}

function readOfficialExternalPluginCatalogInvalidTimestampSequence(
  raw: unknown,
): number | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  if (
    typeof raw.generatedAt === "string" &&
    parseOfficialExternalPluginCatalogTimestamp(raw.generatedAt) !== undefined
  ) {
    return undefined;
  }
  const normalized = {
    ...raw,
    generatedAt: "1970-01-01T00:00:00.000Z",
  };
  return isOfficialExternalPluginCatalogFeed(normalized) ? normalized.sequence : undefined;
}

async function loadHostedCatalogSnapshotResult(params: {
  snapshot: HostedOfficialExternalPluginCatalogSnapshot;
  error: unknown;
  expectedSha256?: string;
  ifNoneMatch?: string;
  ifModifiedSince?: string;
  catalogConfig?: OfficialExternalPluginCatalogProfileConfig;
  requireManifestInstallSourceRef?: boolean;
  expectedFeedId?: string;
  verification?: OfficialExternalPluginCatalogFeedVerification;
  now: Date;
}): Promise<HostedOfficialExternalPluginCatalogLoadResult> {
  assertSnapshotMatchesRequestValidators({
    snapshot: params.snapshot,
    ifNoneMatch: params.ifNoneMatch,
    ifModifiedSince: params.ifModifiedSince,
  });
  const checksum = sha256Hex(params.snapshot.body);
  if (checksum !== params.snapshot.metadata.checksum) {
    throw new Error("hosted catalog snapshot checksum mismatch");
  }
  if (params.expectedSha256 && params.expectedSha256 !== checksum) {
    throw new Error("hosted catalog snapshot checksum did not match expected checksum");
  }
  const parsed = await parseHostedCatalogFeedBody({
    body: params.snapshot.body,
    expectedFeedId: params.expectedFeedId,
    verification: params.verification,
    verifiedAt: params.snapshot.trust?.verifiedAt ?? params.snapshot.savedAt,
    allowLegacyBetaEnvelope: true,
    now: params.now,
    allowExpired: true,
    allowMissingExpiry: true,
  });
  const entries = dedupeOfficialExternalPluginCatalogEntries(
    filterOfficialExternalPluginCatalogEntriesBySourceRefs(
      parseOfficialExternalPluginCatalogEntries(parsed.feed),
      {
        catalogConfig: params.catalogConfig,
        requireManifestInstallSourceRef: params.requireManifestInstallSourceRef,
      },
    ),
  );
  const visibleEntries = parsed.expired
    ? entries.map((entry) => removeOfficialExternalPluginCatalogInstallAuthority(entry))
    : entries;
  return {
    source: "hosted-snapshot",
    entries: visibleEntries,
    feed: parsed.expired ? { ...parsed.feed, entries: visibleEntries } : parsed.feed,
    metadata: params.snapshot.metadata,
    snapshot: params.snapshot,
    ...(parsed.trust ? { trust: parsed.trust } : {}),
    error: parsed.expired
      ? `${formatHostedCatalogError(params.error)}; ${parsed.feed.expiresAt ? `hosted catalog signed feed expired at ${parsed.feed.expiresAt}` : "hosted catalog signed feed has no expiresAt"}`
      : formatHostedCatalogError(params.error),
  };
}

function removeOfficialExternalPluginCatalogInstallAuthority(
  entry: OfficialExternalPluginCatalogEntry,
): OfficialExternalPluginCatalogEntry {
  const { install: _feedInstall, [MANIFEST_KEY]: manifest, ...metadata } = entry;
  if (!manifest) {
    return { ...metadata, state: "unavailable" };
  }
  const { install: _manifestInstall, ...manifestMetadata } = manifest;
  return {
    ...metadata,
    state: "unavailable",
    [MANIFEST_KEY]: manifestMetadata,
  };
}

function isHostedCatalogSignedFeedRollback(params: {
  candidate: OfficialExternalPluginCatalogFeed;
  current: Pick<OfficialExternalPluginCatalogFeed, "sequence"> & { generatedAt?: string };
}): boolean {
  if (params.candidate.sequence < params.current.sequence) {
    return true;
  }
  if (params.candidate.sequence > params.current.sequence) {
    return false;
  }
  if (params.current.generatedAt === undefined) {
    return false;
  }
  return Date.parse(params.candidate.generatedAt) < Date.parse(params.current.generatedAt);
}

function assertSnapshotMatchesRequestValidators(params: {
  snapshot: HostedOfficialExternalPluginCatalogSnapshot;
  ifNoneMatch?: string;
  ifModifiedSince?: string;
}): void {
  if (params.ifNoneMatch && params.snapshot.metadata.etag !== params.ifNoneMatch) {
    throw new Error("hosted catalog snapshot ETag did not match request validator");
  }
  if (
    !params.ifNoneMatch &&
    params.ifModifiedSince &&
    params.snapshot.metadata.lastModified !== params.ifModifiedSince
  ) {
    throw new Error("hosted catalog snapshot Last-Modified did not match request validator");
  }
}

async function snapshotOrBundledFallbackResult(params: {
  error: unknown;
  snapshotStore?: HostedOfficialExternalPluginCatalogSnapshotStore;
  url: string;
  metadata?: HostedOfficialExternalPluginCatalogLoadResult["metadata"];
  expectedSha256?: string;
  ifNoneMatch?: string;
  ifModifiedSince?: string;
  catalogConfig?: OfficialExternalPluginCatalogProfileConfig;
  requireManifestInstallSourceRef?: boolean;
  expectedFeedId?: string;
  verification?: OfficialExternalPluginCatalogFeedVerification;
  now: Date;
}): Promise<HostedOfficialExternalPluginCatalogLoadResult> {
  if (params.snapshotStore) {
    try {
      const snapshot = await params.snapshotStore.read(params.url);
      if (snapshot) {
        return await loadHostedCatalogSnapshotResult({
          snapshot,
          error: params.error,
          expectedSha256: params.expectedSha256,
          ifNoneMatch: params.ifNoneMatch,
          ifModifiedSince: params.ifModifiedSince,
          catalogConfig: params.catalogConfig,
          requireManifestInstallSourceRef: params.requireManifestInstallSourceRef,
          expectedFeedId: params.expectedFeedId,
          verification: params.verification,
          now: params.now,
        });
      }
    } catch (snapshotErr) {
      if (params.verification?.mode === "signed") {
        return emptyBundledFallbackResult(
          `${formatHostedCatalogError(params.error)}; snapshot fallback failed: ${formatHostedCatalogError(snapshotErr)}`,
        );
      }
      return bundledFallbackResult(
        `${formatHostedCatalogError(params.error)}; snapshot fallback failed: ${formatHostedCatalogError(snapshotErr)}`,
        params.metadata,
      );
    }
  }
  if (params.verification?.mode === "signed") {
    return emptyBundledFallbackResult(params.error);
  }
  return bundledFallbackResult(params.error, params.metadata);
}
async function resolveHostedCatalogSnapshotStore(params: {
  snapshotStore?: HostedOfficialExternalPluginCatalogSnapshotStore | null;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  stateDatabasePath?: string;
}): Promise<HostedOfficialExternalPluginCatalogSnapshotStore | undefined> {
  if (params.snapshotStore !== undefined) {
    return params.snapshotStore ?? undefined;
  }
  const { createSqliteHostedOfficialExternalPluginCatalogSnapshotStore } =
    await import("./official-external-plugin-catalog-snapshot-store.js");
  return createSqliteHostedOfficialExternalPluginCatalogSnapshotStore({
    ...(params.env ? { env: params.env } : {}),
    ...(params.stateDir ? { stateDir: params.stateDir } : {}),
    ...(params.stateDatabasePath ? { stateDatabasePath: params.stateDatabasePath } : {}),
  });
}

async function loadHostedOfficialExternalPluginCatalogEntries(params?: {
  feedUrl?: string;
  feedProfile?: string;
  catalogConfig?: OfficialExternalPluginCatalogProfileConfig;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
  chunkTimeoutMs?: number;
  ifNoneMatch?: string;
  ifModifiedSince?: string;
  expectedSha256?: string;
  offline?: boolean;
  requireSnapshotWrite?: boolean;
  snapshotStore?: HostedOfficialExternalPluginCatalogSnapshotStore | null;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  stateDatabasePath?: string;
  now?: () => Date;
}): Promise<HostedOfficialExternalPluginCatalogLoadResult> {
  let source: {
    url: URL;
    hostnameAllowlist: string[];
    expectedFeedId?: string;
    verification?: OfficialExternalPluginCatalogFeedVerification;
  };
  try {
    source = resolveHostedCatalogFeedSource({
      feedUrl: params?.feedUrl,
      feedProfile: params?.feedProfile,
      catalogConfig: params?.catalogConfig,
      env: params?.env ?? process.env,
    });
  } catch (err) {
    return err instanceof HostedCatalogTrustConfigurationError
      ? emptyBundledFallbackResult(err)
      : bundledFallbackResult(err);
  }
  const { url } = source;
  const snapshotStore = await resolveHostedCatalogSnapshotStore({
    snapshotStore: params?.snapshotStore,
    env: params?.env,
    stateDir: params?.stateDir,
    stateDatabasePath: params?.stateDatabasePath,
  });
  const expectedSha256 = normalizeOptionalString(params?.expectedSha256);
  const currentTime = () => params?.now?.() ?? new Date();
  const requireManifestInstallSourceRef = shouldRequireManifestInstallSourceRef({
    feedUrl: params?.feedUrl,
    feedProfile: params?.feedProfile,
    catalogConfig: params?.catalogConfig,
  });
  if (params?.offline === true) {
    return await snapshotOrBundledFallbackResult({
      error: "hosted catalog feed offline mode",
      snapshotStore,
      url: url.href,
      expectedSha256,
      catalogConfig: params?.catalogConfig,
      requireManifestInstallSourceRef,
      expectedFeedId: source.expectedFeedId,
      verification: source.verification,
      now: currentTime(),
    });
  }
  const headers = new Headers();
  const ifNoneMatch = normalizeOptionalString(params?.ifNoneMatch);
  const signedOperation = source.verification?.mode === "signed";
  const ifModifiedSince = signedOperation
    ? undefined
    : normalizeOptionalString(params?.ifModifiedSince);
  if (ifNoneMatch) {
    headers.set("if-none-match", ifNoneMatch);
  }
  if (ifModifiedSince) {
    headers.set("if-modified-since", ifModifiedSince);
  }
  if (signedOperation) {
    headers.set("accept", DSSE_ENVELOPE_MEDIA_TYPE);
  }
  const metadataBase = (response: Response) => {
    const etag = normalizeHostedCatalogHeader(response.headers.get("etag"));
    const lastModified = normalizeHostedCatalogHeader(response.headers.get("last-modified"));
    return {
      url: url.href,
      status: response.status,
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified } : {}),
    };
  };
  let response: Response | undefined;
  let release: (() => Promise<void>) | undefined;
  try {
    const { fetchWithSsrFGuard } = await import("../infra/net/fetch-guard.js");
    const guarded = await fetchWithSsrFGuard({
      url: url.href,
      fetchImpl: params?.fetchImpl,
      init: { method: "GET", headers },
      requireHttps: true,
      maxRedirects: 2,
      timeoutMs: params?.timeoutMs ?? DEFAULT_HOSTED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_TIMEOUT_MS,
      policy: { hostnameAllowlist: source.hostnameAllowlist },
      auditContext: "official-external-plugin-catalog-feed",
    });
    response = guarded.response;
    release = guarded.release;
    const base = metadataBase(response);
    if (response.status === 304) {
      return await snapshotOrBundledFallbackResult({
        error: "hosted catalog feed returned HTTP 304",
        snapshotStore,
        url: url.href,
        metadata: base,
        expectedSha256,
        ifNoneMatch,
        ifModifiedSince,
        catalogConfig: params?.catalogConfig,
        requireManifestInstallSourceRef,
        expectedFeedId: source.expectedFeedId,
        verification: source.verification,
        now: currentTime(),
      });
    }
    if (!response.ok) {
      return await snapshotOrBundledFallbackResult({
        error: `hosted catalog feed returned HTTP ${response.status}`,
        snapshotStore,
        url: url.href,
        metadata: base,
        expectedSha256,
        ifNoneMatch,
        ifModifiedSince,
        catalogConfig: params?.catalogConfig,
        requireManifestInstallSourceRef,
        expectedFeedId: source.expectedFeedId,
        verification: source.verification,
        now: currentTime(),
      });
    }
    if (
      signedOperation &&
      response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
        DSSE_ENVELOPE_MEDIA_TYPE
    ) {
      return await snapshotOrBundledFallbackResult({
        error: `signed hosted catalog feed must use ${DSSE_ENVELOPE_MEDIA_TYPE}`,
        snapshotStore,
        url: url.href,
        metadata: base,
        expectedSha256,
        ifNoneMatch,
        catalogConfig: params?.catalogConfig,
        requireManifestInstallSourceRef,
        expectedFeedId: source.expectedFeedId,
        verification: source.verification,
        now: currentTime(),
      });
    }
    const body = await readHostedCatalogResponseText({
      response,
      maxBytes: params?.maxBytes ?? DEFAULT_HOSTED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_MAX_BYTES,
      chunkTimeoutMs:
        params?.chunkTimeoutMs ?? DEFAULT_HOSTED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_CHUNK_TIMEOUT_MS,
    });
    const checksum = sha256Hex(body);
    const metadata = { ...base, checksum };
    if (expectedSha256 && expectedSha256 !== checksum) {
      return await snapshotOrBundledFallbackResult({
        error: `hosted catalog feed checksum mismatch: expected ${expectedSha256}`,
        snapshotStore,
        url: url.href,
        metadata,
        expectedSha256,
        ifNoneMatch,
        ifModifiedSince,
        catalogConfig: params?.catalogConfig,
        requireManifestInstallSourceRef,
        expectedFeedId: source.expectedFeedId,
        verification: source.verification,
        now: currentTime(),
      });
    }
    const now = currentTime();
    const verifiedAt = now.toISOString();
    const parsed = await parseHostedCatalogFeedBody({
      body,
      expectedFeedId: source.expectedFeedId,
      verification: source.verification,
      verifiedAt,
      now,
    }).catch(async (err: unknown) => {
      return await snapshotOrBundledFallbackResult({
        error: err,
        snapshotStore,
        url: url.href,
        metadata,
        expectedSha256,
        ifNoneMatch,
        ifModifiedSince,
        catalogConfig: params?.catalogConfig,
        requireManifestInstallSourceRef,
        expectedFeedId: source.expectedFeedId,
        verification: source.verification,
        now,
      });
    });
    if ("source" in parsed) {
      return parsed;
    }
    if (snapshotStore && parsed.trust?.mode === "signed") {
      const currentSnapshot = await snapshotStore.read(url.href);
      if (currentSnapshot?.trust?.mode === "signed") {
        const current =
          currentSnapshot.monotonic?.mode === "signed-feed"
            ? currentSnapshot.monotonic
            : (
                await parseHostedCatalogFeedBody({
                  body: currentSnapshot.body,
                  expectedFeedId: source.expectedFeedId,
                  verification: source.verification,
                  verifiedAt: currentSnapshot.trust.verifiedAt,
                  allowLegacyBetaEnvelope: true,
                  now,
                  allowExpired: true,
                  allowMissingExpiry: true,
                }).catch((err: unknown) => {
                  // Only an authenticated invalid-timestamp payload is repairable. Signature
                  // and trust failures must remain fail-closed so rollback checks cannot be bypassed.
                  if (err instanceof HostedCatalogFeedTimestampError) {
                    return { feed: { sequence: err.sequence } };
                  }
                  throw err;
                })
              ).feed;
        if (
          isHostedCatalogSignedFeedRollback({
            candidate: parsed.feed,
            current,
          })
        ) {
          throw new HostedCatalogSignedFeedMonotonicityError(
            "hosted catalog signed feed sequence is older than current snapshot",
          );
        }
      }
    }
    const entries = filterOfficialExternalPluginCatalogEntriesBySourceRefs(
      parseOfficialExternalPluginCatalogEntries(parsed.feed),
      {
        catalogConfig: params?.catalogConfig,
        requireManifestInstallSourceRef,
      },
    );
    await snapshotStore
      ?.write({
        body,
        metadata,
        savedAt: verifiedAt,
        ...(parsed.trust ? { trust: parsed.trust } : {}),
        ...(parsed.trust?.mode === "signed"
          ? {
              monotonic: {
                mode: "signed-feed",
                sequence: parsed.feed.sequence,
                generatedAt: parsed.feed.generatedAt,
              },
            }
          : {}),
      })
      .catch((err: unknown) => {
        if (err instanceof HostedCatalogSignedFeedMonotonicityError) {
          throw err;
        }
        if (params?.requireSnapshotWrite) {
          throw new HostedCatalogSnapshotWriteError(err);
        }
      });
    return {
      source: "hosted",
      entries: dedupeOfficialExternalPluginCatalogEntries(entries),
      feed: parsed.feed,
      metadata,
      ...(parsed.trust ? { trust: parsed.trust } : {}),
    };
  } catch (err) {
    if (err instanceof HostedCatalogSnapshotWriteError) {
      throw err.originalError;
    }
    return await snapshotOrBundledFallbackResult({
      error: err,
      snapshotStore,
      url: url.href,
      expectedSha256,
      ifNoneMatch,
      ifModifiedSince,
      catalogConfig: params?.catalogConfig,
      requireManifestInstallSourceRef,
      expectedFeedId: source.expectedFeedId,
      verification: source.verification,
      now: currentTime(),
    });
  } finally {
    if (response?.bodyUsed !== true) {
      await response?.body?.cancel().catch(() => undefined);
    }
    await release?.().catch(() => undefined);
  }
}

function normalizeDefaultChoice(value: unknown): PluginPackageInstall["defaultChoice"] | undefined {
  return value === "clawhub" || value === "npm" || value === "local" ? value : undefined;
}

function formatFeedInstallCandidateSpec(
  candidate: OfficialExternalPluginCatalogInstallCandidate,
): string | undefined {
  const packageName = normalizeOptionalString(candidate.package);
  if (!packageName) {
    return undefined;
  }
  const version = normalizeOptionalString(candidate.version);
  if (!version || packageName.endsWith(`@${version}`)) {
    return packageName;
  }
  return `${packageName}@${version}`;
}

function getFeedEntryCandidateSourceType(
  candidate: OfficialExternalPluginCatalogInstallCandidate,
  config?: OfficialExternalPluginCatalogProfileConfig,
): OfficialExternalPluginCatalogSourceProfile["type"] | undefined {
  const sourceRef = normalizeOptionalString(candidate.sourceRef);
  if (!sourceRef) {
    return undefined;
  }
  return resolveOfficialExternalPluginCatalogProfileConfig(config).sources[sourceRef]?.type;
}

function getPreferredFeedEntryInstallCandidate(params: {
  entry: OfficialExternalPluginCatalogEntry;
  catalogConfig?: OfficialExternalPluginCatalogProfileConfig;
}): OfficialExternalPluginCatalogInstallCandidate | undefined {
  const candidates = getFeedEntryInstallCandidates(params.entry).filter((candidate) =>
    Boolean(normalizeOptionalString(candidate.package)),
  );
  return (
    candidates.find(
      (candidate) =>
        normalizeOptionalString(candidate.sourceRef) ===
        DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_CLAWHUB_SOURCE_REF,
    ) ??
    candidates.find(
      (candidate) =>
        normalizeOptionalString(candidate.sourceRef) ===
        DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_NPM_SOURCE_REF,
    ) ??
    candidates.find((candidate) =>
      Boolean(getFeedEntryCandidateSourceType(candidate, params.catalogConfig)),
    )
  );
}

function resolveFeedEntryInstallCandidate(params: {
  entry: OfficialExternalPluginCatalogEntry;
  catalogConfig?: OfficialExternalPluginCatalogProfileConfig;
}): PluginPackageInstall | null {
  const candidate = getPreferredFeedEntryInstallCandidate(params);
  if (!candidate) {
    return null;
  }
  const spec = formatFeedInstallCandidateSpec(candidate);
  if (!spec) {
    return null;
  }
  const sourceType = getFeedEntryCandidateSourceType(candidate, params.catalogConfig);
  if (sourceType === "clawhub") {
    const expectedIntegrity = normalizeClawHubSha256ExpectedIntegrity(candidate.integrity);
    return {
      clawhubSpec: `clawhub:${spec}`,
      defaultChoice: "clawhub",
      ...(expectedIntegrity ? { expectedIntegrity } : {}),
    };
  }
  if (sourceType === "npm") {
    const expectedIntegrity = normalizeNpmExpectedIntegrity(candidate.integrity);
    return {
      npmSpec: spec,
      defaultChoice: "npm",
      ...(expectedIntegrity ? { expectedIntegrity } : {}),
    };
  }
  return null;
}

function normalizeClawHubSha256ExpectedIntegrity(value: unknown): string | undefined {
  const integrity = normalizeOptionalString(value);
  return integrity ? (normalizeClawHubSha256Integrity(integrity) ?? undefined) : undefined;
}

function normalizeNpmExpectedIntegrity(value: unknown): string | undefined {
  const integrity = normalizeOptionalString(value);
  if (!integrity || !/^[a-z0-9]+-[A-Za-z0-9+/=]+$/i.test(integrity)) {
    return undefined;
  }
  return integrity;
}

/** Returns manifest metadata from an official external catalog entry when present. */
export function getOfficialExternalPluginCatalogManifest(
  entry: OfficialExternalPluginCatalogEntry,
): OfficialExternalPluginCatalogManifest | undefined {
  const manifest = entry[MANIFEST_KEY];
  return isRecord(manifest) ? manifest : undefined;
}

export function resolveOfficialExternalPluginId(
  entry: OfficialExternalPluginCatalogEntry,
): string | undefined {
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  return (
    normalizeOptionalString(manifest?.plugin?.id) ??
    normalizeOptionalString(manifest?.channel?.id) ??
    normalizeOptionalString(manifest?.providers?.[0]?.id) ??
    normalizeOptionalString(entry.id)
  );
}

function resolveOfficialExternalPluginLookupIds(
  entry: OfficialExternalPluginCatalogEntry,
): string[] {
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  const lookupIds = [
    normalizeOptionalString(manifest?.plugin?.id),
    normalizeOptionalString(manifest?.channel?.id),
  ];
  for (const provider of manifest?.providers ?? []) {
    lookupIds.push(normalizeOptionalString(provider.id));
    for (const alias of provider.aliases ?? []) {
      lookupIds.push(normalizeOptionalString(alias));
    }
  }
  return uniqueStrings(lookupIds.filter((value): value is string => Boolean(value)));
}

export function resolveOfficialExternalPluginLabel(
  entry: OfficialExternalPluginCatalogEntry,
): string {
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  return (
    normalizeOptionalString(manifest?.plugin?.label) ??
    normalizeOptionalString(manifest?.channel?.label) ??
    normalizeOptionalString(manifest?.providers?.[0]?.name) ??
    normalizeOptionalString(entry.title) ??
    normalizeOptionalString(entry.name) ??
    resolveOfficialExternalPluginId(entry) ??
    "plugin"
  );
}

export function resolveOfficialExternalPluginInstall(
  entry: OfficialExternalPluginCatalogEntry,
  params?: { catalogConfig?: OfficialExternalPluginCatalogProfileConfig },
): PluginPackageInstall | null {
  const state = normalizeOptionalString(entry.state);
  if (state && state !== "available") {
    return null;
  }
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  const install = manifest?.install;
  const clawhubSpec = normalizeOptionalString(install?.clawhubSpec);
  const manifestNpmSpec = normalizeOptionalString(install?.npmSpec);
  const localPath = normalizeOptionalString(install?.localPath);
  const candidateInstall = resolveFeedEntryInstallCandidate({
    entry,
    catalogConfig: params?.catalogConfig,
  });
  if (candidateInstall) {
    return {
      ...candidateInstall,
      ...(install?.minHostVersion ? { minHostVersion: install.minHostVersion } : {}),
      ...(install?.expectedIntegrity && !candidateInstall.expectedIntegrity
        ? { expectedIntegrity: install.expectedIntegrity }
        : {}),
      ...(install?.allowInvalidConfigRecovery === true ? { allowInvalidConfigRecovery: true } : {}),
    };
  }
  const hasFeedInstallCandidates = getFeedEntryInstallCandidateRecords(entry).length > 0;
  const npmSpec =
    manifestNpmSpec ?? (hasFeedInstallCandidates ? undefined : normalizeOptionalString(entry.name));
  const defaultChoice =
    normalizeDefaultChoice(install?.defaultChoice) ??
    (npmSpec ? "npm" : clawhubSpec ? "clawhub" : localPath ? "local" : undefined);
  if (!clawhubSpec && !npmSpec && !localPath) {
    return null;
  }
  return {
    ...(clawhubSpec ? { clawhubSpec } : {}),
    ...(npmSpec ? { npmSpec } : {}),
    ...(localPath ? { localPath } : {}),
    ...(defaultChoice ? { defaultChoice } : {}),
    ...(install?.minHostVersion ? { minHostVersion: install.minHostVersion } : {}),
    ...(install?.expectedIntegrity ? { expectedIntegrity: install.expectedIntegrity } : {}),
    ...(install?.allowInvalidConfigRecovery === true ? { allowInvalidConfigRecovery: true } : {}),
  };
}

export async function loadConfiguredHostedOfficialExternalPluginCatalogEntries(
  params?: Parameters<typeof loadHostedOfficialExternalPluginCatalogEntries>[0],
): Promise<HostedOfficialExternalPluginCatalogLoadResult> {
  return await loadHostedOfficialExternalPluginCatalogEntries(params);
}

export function listOfficialExternalPluginCatalogEntries(): OfficialExternalPluginCatalogEntry[] {
  return dedupeOfficialExternalPluginCatalogEntries(bundledOfficialExternalPluginCatalogEntries());
}

/** Returns whether an id is the canonical id of an official external plugin. */
export function isOfficialExternalPluginId(pluginId: string): boolean {
  const normalized = normalizeOptionalString(pluginId)?.toLowerCase();
  if (!normalized) {
    return false;
  }
  return listOfficialExternalPluginCatalogEntries().some(
    (entry) => resolveOfficialExternalPluginId(entry)?.toLowerCase() === normalized,
  );
}

/** Resolves official external plugin owners for configured capability provider ids. */
export function resolveOfficialExternalProviderContractPluginIds(params: {
  contract: OfficialExternalProviderContract;
  providerIds: ReadonlySet<string>;
}): string[] {
  const configuredProviderIds = new Set(
    [...params.providerIds]
      .map((providerId) => normalizeOptionalString(providerId)?.toLowerCase())
      .filter((providerId): providerId is string => Boolean(providerId)),
  );
  if (configuredProviderIds.size === 0) {
    return [];
  }
  const pluginIds = new Set<string>();
  for (const entry of listOfficialExternalPluginCatalogEntries()) {
    const pluginId = resolveOfficialExternalPluginId(entry);
    const providerIds =
      getOfficialExternalPluginCatalogManifest(entry)?.contracts?.[params.contract];
    if (
      pluginId &&
      providerIds?.some((providerId) => {
        const normalized = normalizeOptionalString(providerId)?.toLowerCase();
        return normalized ? configuredProviderIds.has(normalized) : false;
      })
    ) {
      pluginIds.add(pluginId);
    }
  }
  return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}

/** Resolves official web provider owners from matching documented environment credentials. */
export function resolveOfficialExternalWebProviderContractPluginIdsForEnv(params: {
  contract: OfficialExternalProviderContract;
  env: NodeJS.ProcessEnv;
}): string[] {
  const pluginIds = new Set<string>();
  for (const entry of listOfficialExternalPluginCatalogEntries()) {
    const pluginId = resolveOfficialExternalPluginId(entry);
    const manifest = getOfficialExternalPluginCatalogManifest(entry);
    const contractProviderIds = new Set(
      (manifest?.contracts?.[params.contract] ?? [])
        .map((providerId) => normalizeOptionalString(providerId)?.toLowerCase())
        .filter((providerId): providerId is string => Boolean(providerId)),
    );
    if (
      pluginId &&
      contractProviderIds.size > 0 &&
      manifest?.webSearchProviders?.some((provider) => {
        const providerId = normalizeOptionalString(provider.id)?.toLowerCase();
        return (
          providerId !== undefined &&
          contractProviderIds.has(providerId) &&
          provider.envVars?.some((envVar) => Boolean(params.env[envVar]?.trim()))
        );
      })
    ) {
      pluginIds.add(pluginId);
    }
  }
  return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}

/** Resolves official external plugin owners for configured model provider ids. */
export function resolveOfficialExternalProviderPluginIds(params: {
  providerIds: ReadonlySet<string>;
}): string[] {
  const configuredProviderIds = new Set(
    [...params.providerIds]
      .map((providerId) => normalizeOptionalString(providerId)?.toLowerCase())
      .filter((providerId): providerId is string => Boolean(providerId)),
  );
  if (configuredProviderIds.size === 0) {
    return [];
  }
  const pluginIds = new Set<string>();
  for (const entry of listOfficialExternalProviderCatalogEntries()) {
    const pluginId = resolveOfficialExternalPluginId(entry);
    const providers = getOfficialExternalPluginCatalogManifest(entry)?.providers;
    if (
      pluginId &&
      providers?.some((provider) =>
        [provider.id, ...(provider.aliases ?? [])].some((providerId) => {
          const normalized = normalizeOptionalString(providerId)?.toLowerCase();
          return normalized ? configuredProviderIds.has(normalized) : false;
        }),
      )
    ) {
      pluginIds.add(pluginId);
    }
  }
  return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}

/** Resolves official external provider owners with configured environment credentials. */
export function resolveOfficialExternalProviderPluginIdsForEnv(env: NodeJS.ProcessEnv): string[] {
  const pluginIds = new Set<string>();
  for (const entry of listOfficialExternalProviderCatalogEntries()) {
    const pluginId = resolveOfficialExternalPluginId(entry);
    const providers = getOfficialExternalPluginCatalogManifest(entry)?.providers;
    if (
      pluginId &&
      providers?.some((provider) =>
        provider.envVars?.some((envVar) => Boolean(env[envVar]?.trim())),
      )
    ) {
      pluginIds.add(pluginId);
    }
  }
  return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}

export function listOfficialExternalChannelCatalogEntries(): OfficialExternalPluginCatalogEntry[] {
  return listOfficialExternalPluginCatalogEntries().filter((entry) =>
    Boolean(getOfficialExternalPluginCatalogManifest(entry)?.channel),
  );
}

export function listOfficialExternalChannelEnvVars(): Array<{
  channelId: string;
  envVars: readonly string[];
}> {
  return listOfficialExternalChannelCatalogEntries().flatMap((entry) => {
    const channel = getOfficialExternalPluginCatalogManifest(entry)?.channel;
    const channelId = normalizeOptionalString(channel?.id)?.toLowerCase();
    const envVars = uniqueStrings(
      (channel?.envVars ?? [])
        .map((envVar) => normalizeOptionalString(envVar))
        .filter((envVar): envVar is string => Boolean(envVar)),
    );
    return channelId && envVars.length > 0 ? [{ channelId, envVars }] : [];
  });
}

export function listOfficialExternalProviderCatalogEntries(): OfficialExternalPluginCatalogEntry[] {
  return listOfficialExternalPluginCatalogEntries().filter(
    (entry) => (getOfficialExternalPluginCatalogManifest(entry)?.providers?.length ?? 0) > 0,
  );
}

export function getOfficialExternalPluginCatalogEntry(
  pluginId: string,
): OfficialExternalPluginCatalogEntry | undefined {
  const normalized = pluginId.trim();
  if (!normalized) {
    return undefined;
  }
  return listOfficialExternalPluginCatalogEntries().find((entry) =>
    resolveOfficialExternalPluginLookupIds(entry).includes(normalized),
  );
}

export function getOfficialExternalPluginCatalogEntryForPackage(
  packageName: string | undefined,
): OfficialExternalPluginCatalogEntry | undefined {
  const normalized = packageName?.trim();
  if (!normalized) {
    return undefined;
  }
  return listOfficialExternalPluginCatalogEntries().find(
    (entry) => normalizeOptionalString(entry.name) === normalized,
  );
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
