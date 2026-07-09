/** Reads official external plugin/channel/provider catalogs into manifest-like metadata. */
import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import officialExternalChannelCatalog from "../../scripts/lib/official-external-channel-catalog.json" with { type: "json" };
import officialExternalPluginCatalog from "../../scripts/lib/official-external-plugin-catalog.json" with { type: "json" };
import officialExternalProviderCatalog from "../../scripts/lib/official-external-provider-catalog.json" with { type: "json" };
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub.js";
import { isRecord } from "../utils.js";
import type {
  PluginManifestChannelConfig,
  PluginManifestContracts,
  PluginManifestProviderEndpoint,
  PluginPackageInstall,
} from "./manifest.js";

type ManifestKey = typeof MANIFEST_KEY;

class HostedCatalogSnapshotWriteError extends Error {
  readonly originalError: unknown;

  constructor(originalError: unknown) {
    super("hosted catalog snapshot write failed");
    this.name = "HostedCatalogSnapshotWriteError";
    this.originalError = originalError;
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

export type OfficialExternalProviderCatalogProvider = {
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
export type OfficialExternalPluginCatalogManifest = {
  plugin?: {
    id?: string;
    label?: string;
  };
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
  source?: string;
  kind?: string;
  install?: {
    candidates?: readonly OfficialExternalPluginCatalogInstallCandidate[];
  };
} & Partial<Record<ManifestKey, OfficialExternalPluginCatalogManifest>>;

export type OfficialExternalPluginCatalogInstallCandidate = {
  sourceRef?: string;
  package?: string;
  version?: string;
  integrity?: string;
  repo?: string;
  path?: string;
  commit?: string;
};

export type OfficialExternalPluginCatalogSourceProfile =
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

export type OfficialExternalPluginCatalogFeedProfile = {
  url: string;
  verification?: OfficialExternalPluginCatalogFeedVerification;
};

export type OfficialExternalPluginCatalogFeedVerification =
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

export type OfficialExternalPluginCatalogProfileConfig = {
  feeds?: Record<string, OfficialExternalPluginCatalogFeedProfile>;
  sources?: Record<string, OfficialExternalPluginCatalogSourceProfile>;
};

/** Feed-shaped wrapper used by the bundled external plugin catalog fallback. */
export type OfficialExternalPluginCatalogFeed = {
  schemaVersion: 1 | 2;
  id: string;
  generatedAt: string;
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

export type HostedOfficialExternalPluginCatalogSnapshotMonotonicState = {
  mode: "signed-feed";
  sequence: number;
  generatedAt: string;
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

const OFFICIAL_CATALOG_SOURCES = [
  officialExternalChannelCatalog,
  officialExternalProviderCatalog,
  officialExternalPluginCatalog,
] as const;

const SUPPORTED_OFFICIAL_EXTERNAL_CATALOG_FEED_SCHEMA_VERSIONS = new Set([1, 2]);
export const DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_URL =
  "https://clawhub.ai/v1/feeds/plugins";
export const DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PROFILE = "clawhub-public";
export const DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_CLAWHUB_SOURCE_REF = "public-clawhub";
export const DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_NPM_SOURCE_REF = "public-npm";
const DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_PROFILE_CONFIG: OfficialExternalPluginCatalogProfileConfig =
  {
    feeds: {
      [DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PROFILE]: {
        url: DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_URL,
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
const OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_HOSTNAME_ALLOWLIST = ["clawhub.ai"];

export function isOfficialExternalPluginCatalogFeed(
  raw: unknown,
): raw is OfficialExternalPluginCatalogFeed {
  if (!isRecord(raw)) {
    return false;
  }
  const sequence = raw.sequence;
  const entries = raw.entries;
  return (
    typeof raw.schemaVersion === "number" &&
    SUPPORTED_OFFICIAL_EXTERNAL_CATALOG_FEED_SCHEMA_VERSIONS.has(raw.schemaVersion) &&
    typeof raw.id === "string" &&
    raw.id.trim().length > 0 &&
    typeof raw.generatedAt === "string" &&
    raw.generatedAt.trim().length > 0 &&
    typeof sequence === "number" &&
    Number.isInteger(sequence) &&
    sequence >= 0 &&
    Array.isArray(entries)
  );
}

export function parseOfficialExternalPluginCatalogEntries(
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

function resolveOfficialExternalPluginCatalogProfileConfig(
  config?: OfficialExternalPluginCatalogProfileConfig,
): Required<OfficialExternalPluginCatalogProfileConfig> {
  return {
    feeds: {
      ...DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_PROFILE_CONFIG.feeds,
      ...config?.feeds,
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
}): {
  url: URL;
  hostnameAllowlist: string[];
  verification?: OfficialExternalPluginCatalogFeedVerification;
} {
  const profileConfig = resolveOfficialExternalPluginCatalogProfileConfig(params.catalogConfig);
  const explicitFeedUrl = normalizeOptionalString(params.feedUrl);
  const explicitProfileName = normalizeOptionalString(params.feedProfile);
  if (explicitFeedUrl) {
    const url = resolveHostedCatalogFeedUrl(explicitFeedUrl);
    if (!OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_HOSTNAME_ALLOWLIST.includes(url.hostname)) {
      throw new Error("hosted catalog feed URL hostname is not allowed");
    }
    const profile =
      explicitProfileName === undefined ? undefined : profileConfig.feeds[explicitProfileName];
    if (explicitProfileName !== undefined && !profile) {
      throw new Error(`hosted catalog feed profile "${explicitProfileName}" is not configured`);
    }
    return {
      url,
      hostnameAllowlist: OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_HOSTNAME_ALLOWLIST,
      ...(profile?.verification ? { verification: profile.verification } : {}),
    };
  }
  const profileName = explicitProfileName ?? DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_PROFILE;
  const profile = profileConfig.feeds[profileName];
  if (!profile) {
    throw new Error(`hosted catalog feed profile "${profileName}" is not configured`);
  }
  const url = resolveHostedCatalogFeedUrl(profile.url);
  return {
    url,
    hostnameAllowlist: uniqueStrings([
      ...OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_HOSTNAME_ALLOWLIST,
      url.hostname,
    ]),
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

export function validateOfficialExternalPluginCatalogEntrySourceRefs(
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

export function filterOfficialExternalPluginCatalogEntriesBySourceRefs(
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

function hasStreamingResponseBody(
  response: Response,
): response is Response & { body: ReadableStream<Uint8Array> } {
  return Boolean(
    response.body && typeof (response.body as { getReader?: unknown }).getReader === "function",
  );
}

async function readHostedCatalogChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunkTimeoutMs: number,
): Promise<Awaited<ReturnType<typeof reader.read>>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  return await new Promise((resolve, reject) => {
    const clear = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    };
    timeoutId = setTimeout(() => {
      timedOut = true;
      clear();
      void reader.cancel().catch(() => undefined);
      reject(new Error(`hosted catalog feed read timed out after ${chunkTimeoutMs}ms`));
    }, chunkTimeoutMs);
    void reader.read().then(
      (result) => {
        clear();
        if (!timedOut) {
          resolve(result);
        }
      },
      (err: unknown) => {
        clear();
        if (!timedOut) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      },
    );
  });
}

async function readHostedCatalogResponseText(params: {
  response: Response;
  maxBytes: number;
  chunkTimeoutMs: number;
}): Promise<string> {
  parseHostedCatalogContentLength(params.response.headers.get("content-length"), params.maxBytes);
  if (!hasStreamingResponseBody(params.response)) {
    const text = await params.response.text();
    if (new TextEncoder().encode(text).byteLength > params.maxBytes) {
      throw new Error(`hosted catalog feed exceeds ${params.maxBytes} bytes`);
    }
    return text;
  }
  const reader = params.response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await readHostedCatalogChunkWithTimeout(reader, params.chunkTimeoutMs);
      if (chunk.done) {
        break;
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > params.maxBytes) {
        throw new Error(`hosted catalog feed exceeds ${params.maxBytes} bytes`);
      }
      chunks.push(chunk.value);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function bundledOfficialExternalPluginCatalogEntries(): OfficialExternalPluginCatalogEntry[] {
  return OFFICIAL_CATALOG_SOURCES.flatMap((source) =>
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
  verification?: OfficialExternalPluginCatalogFeedVerification;
  verifiedAt: string;
}): Promise<{
  feed: OfficialExternalPluginCatalogFeed;
  trust?: HostedOfficialExternalPluginCatalogTrustState;
}> {
  const raw = JSON.parse(params.body) as unknown;
  if (params.verification?.mode === "signed") {
    const { verifyOfficialExternalPluginCatalogSignedEnvelope } =
      await import("./official-external-plugin-catalog-envelope.js");
    const threshold = params.verification.threshold ?? 1;
    const verification = verifyOfficialExternalPluginCatalogSignedEnvelope(raw, {
      trustedKeys: params.verification.keys,
      threshold,
    });
    if (!verification.ok) {
      throw new Error(verification.message);
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
    };
  }
  if (!isOfficialExternalPluginCatalogFeed(raw)) {
    throw new Error("hosted catalog feed did not match a supported schema version");
  }
  return { feed: raw };
}

async function loadHostedCatalogSnapshotResult(params: {
  snapshot: HostedOfficialExternalPluginCatalogSnapshot;
  error: unknown;
  expectedSha256?: string;
  ifNoneMatch?: string;
  ifModifiedSince?: string;
  catalogConfig?: OfficialExternalPluginCatalogProfileConfig;
  requireManifestInstallSourceRef?: boolean;
  verification?: OfficialExternalPluginCatalogFeedVerification;
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
    verification: params.verification,
    verifiedAt: params.snapshot.trust?.verifiedAt ?? params.snapshot.savedAt,
  });
  return {
    source: "hosted-snapshot",
    entries: dedupeOfficialExternalPluginCatalogEntries(
      filterOfficialExternalPluginCatalogEntriesBySourceRefs(
        parseOfficialExternalPluginCatalogEntries(parsed.feed),
        {
          catalogConfig: params.catalogConfig,
          requireManifestInstallSourceRef: params.requireManifestInstallSourceRef,
        },
      ),
    ),
    feed: parsed.feed,
    metadata: params.snapshot.metadata,
    snapshot: params.snapshot,
    ...(parsed.trust ? { trust: parsed.trust } : {}),
    error: formatHostedCatalogError(params.error),
  };
}

function isHostedCatalogSignedFeedRollback(params: {
  candidate: OfficialExternalPluginCatalogFeed;
  current: OfficialExternalPluginCatalogFeed;
}): boolean {
  if (params.candidate.sequence < params.current.sequence) {
    return true;
  }
  if (params.candidate.sequence > params.current.sequence) {
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
  verification?: OfficialExternalPluginCatalogFeedVerification;
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
          verification: params.verification,
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

export function createInMemoryHostedOfficialExternalPluginCatalogSnapshotStore(
  initialSnapshots: HostedOfficialExternalPluginCatalogSnapshot[] = [],
): HostedOfficialExternalPluginCatalogSnapshotStore {
  const snapshots = new Map<string, HostedOfficialExternalPluginCatalogSnapshot>();
  for (const snapshot of initialSnapshots) {
    snapshots.set(snapshot.metadata.url, snapshot);
  }
  return {
    async read(url) {
      return snapshots.get(url) ?? null;
    },
    async write(snapshot) {
      snapshots.set(snapshot.metadata.url, snapshot);
    },
  };
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

/** Keep signature verification crypto lazy for ordinary catalog metadata paths. */
export async function loadOfficialExternalPluginCatalogEnvelopeVerifier() {
  return await import("./official-external-plugin-catalog-envelope.js");
}

export async function loadHostedOfficialExternalPluginCatalogEntries(params?: {
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
    verification?: OfficialExternalPluginCatalogFeedVerification;
  };
  try {
    source = resolveHostedCatalogFeedSource({
      feedUrl: params?.feedUrl,
      feedProfile: params?.feedProfile,
      catalogConfig: params?.catalogConfig,
    });
  } catch (err) {
    return bundledFallbackResult(err);
  }
  const { url } = source;
  const snapshotStore = await resolveHostedCatalogSnapshotStore({
    snapshotStore: params?.snapshotStore,
    env: params?.env,
    stateDir: params?.stateDir,
    stateDatabasePath: params?.stateDatabasePath,
  });
  const expectedSha256 = normalizeOptionalString(params?.expectedSha256);
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
      verification: source.verification,
    });
  }
  const headers = new Headers();
  const ifNoneMatch = normalizeOptionalString(params?.ifNoneMatch);
  const ifModifiedSince = normalizeOptionalString(params?.ifModifiedSince);
  if (ifNoneMatch) {
    headers.set("if-none-match", ifNoneMatch);
  }
  if (ifModifiedSince) {
    headers.set("if-modified-since", ifModifiedSince);
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
        verification: source.verification,
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
        verification: source.verification,
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
        verification: source.verification,
      });
    }
    const verifiedAt = (params?.now?.() ?? new Date()).toISOString();
    const parsed = await parseHostedCatalogFeedBody({
      body,
      verification: source.verification,
      verifiedAt,
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
        verification: source.verification,
      });
    });
    if ("source" in parsed) {
      return parsed;
    }
    if (snapshotStore && parsed.trust?.mode === "signed") {
      const currentSnapshot = await snapshotStore.read(url.href);
      if (currentSnapshot?.trust?.mode === "signed") {
        const current = await parseHostedCatalogFeedBody({
          body: currentSnapshot.body,
          verification: source.verification,
          verifiedAt: currentSnapshot.trust.verifiedAt,
        });
        if (
          isHostedCatalogSignedFeedRollback({
            candidate: parsed.feed,
            current: current.feed,
          })
        ) {
          throw new Error("hosted catalog signed feed sequence is older than current snapshot");
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
        if (
          err instanceof Error &&
          err.message.includes("hosted catalog signed feed sequence is older")
        ) {
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
      verification: source.verification,
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

export function resolveOfficialExternalPluginCatalogProfileConfigFromConfig(config?: {
  marketplaces?: OfficialExternalPluginCatalogProfileConfig;
}): OfficialExternalPluginCatalogProfileConfig | undefined {
  return config?.marketplaces;
}

export async function loadConfiguredHostedOfficialExternalPluginCatalogEntries(
  config: { marketplaces?: OfficialExternalPluginCatalogProfileConfig } | undefined,
  params?: Omit<
    Parameters<typeof loadHostedOfficialExternalPluginCatalogEntries>[0],
    "catalogConfig"
  >,
): Promise<HostedOfficialExternalPluginCatalogLoadResult> {
  return await loadHostedOfficialExternalPluginCatalogEntries({
    ...params,
    catalogConfig: resolveOfficialExternalPluginCatalogProfileConfigFromConfig(config),
  });
}

export function listOfficialExternalPluginCatalogEntries(): OfficialExternalPluginCatalogEntry[] {
  return dedupeOfficialExternalPluginCatalogEntries(bundledOfficialExternalPluginCatalogEntries());
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
