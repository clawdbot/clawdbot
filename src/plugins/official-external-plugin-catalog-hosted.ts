// Loads hosted official catalogs while preserving feed authority and snapshot freshness.
import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { formatErrorMessage } from "../infra/errors.js";
import { cancelUnreadResponseBody, readResponseWithLimit } from "../infra/http-body.js";
import {
  HostedCatalogSignedFeedMonotonicityError,
  isOfficialExternalPluginCatalogFeed,
  parseOfficialExternalPluginCatalogTimestamp,
  parseOfficialExternalPluginCatalogEntries,
  filterOfficialExternalPluginCatalogEntriesBySourceRefs,
  dedupeOfficialExternalPluginCatalogEntries,
  resolveHostedCatalogFeedSource,
  shouldRequireManifestInstallSourceRef,
} from "./official-external-plugin-catalog-source.js";
import { listOfficialExternalPluginCatalogEntries } from "./official-external-plugin-catalog.js";
import type {
  OfficialExternalPluginCatalogEntry,
  OfficialExternalPluginCatalogFeedVerification,
  OfficialExternalPluginCatalogProfileConfig,
  OfficialExternalPluginCatalogFeed,
  HostedOfficialExternalPluginCatalogSnapshot,
  HostedOfficialExternalPluginCatalogSnapshotStore,
  HostedOfficialExternalPluginCatalogTrustState,
  HostedOfficialExternalPluginCatalogLoadResult,
} from "./official-external-plugin-catalog.types.js";

const DEFAULT_HOSTED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_TIMEOUT_MS = 5000;

const DEFAULT_HOSTED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_MAX_BYTES = 1024 * 1024;

const DEFAULT_HOSTED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_CHUNK_TIMEOUT_MS = 5000;

const DSSE_ENVELOPE_MEDIA_TYPE = "application/vnd.dsse+json";

class HostedCatalogFeedTimestampError extends Error {
  constructor(
    message: string,
    readonly sequence: number,
  ) {
    super(message);
  }
}

class HostedCatalogSnapshotWriteError extends Error {
  readonly originalError: unknown;

  constructor(originalError: unknown) {
    super("hosted catalog snapshot write failed");
    this.name = "HostedCatalogSnapshotWriteError";
    this.originalError = originalError;
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function normalizeHostedCatalogHeader(value: string | null): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized || undefined;
}

function sha256Hex(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

function bundledFallbackResult(
  error: unknown,
  metadata?: HostedOfficialExternalPluginCatalogLoadResult["metadata"],
): HostedOfficialExternalPluginCatalogLoadResult {
  return {
    source: "bundled-fallback",
    entries: listOfficialExternalPluginCatalogEntries(),
    error: formatErrorMessage(error),
    ...(metadata ? { metadata } : {}),
  };
}

function emptyBundledFallbackResult(error: unknown): HostedOfficialExternalPluginCatalogLoadResult {
  return {
    source: "bundled-fallback",
    entries: [],
    error: formatErrorMessage(error),
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
    const generatedAtMs = parseOfficialExternalPluginCatalogTimestamp(
      verification.feed.generatedAt,
    );
    const expiresAt = normalizeOptionalString(verification.feed.expiresAt);
    if (generatedAtMs === undefined) {
      throw new Error("hosted catalog signed feed requires a valid generatedAt value");
    }
    let expired: boolean;
    if (!expiresAt) {
      if (params.allowMissingExpiry !== true) {
        throw new Error("hosted catalog signed feed requires a valid expiresAt value");
      }
      expired = true;
    } else {
      const expiresAtMs = parseOfficialExternalPluginCatalogTimestamp(expiresAt);
      if (expiresAtMs === undefined) {
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
      feed: enforceHostedCatalogFeedInstallAuthority(verification.feed),
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
  return { feed: enforceHostedCatalogFeedInstallAuthority(raw) };
}

function enforceHostedCatalogFeedInstallAuthority(
  feed: OfficialExternalPluginCatalogFeed,
): OfficialExternalPluginCatalogFeed {
  if (feed.schemaVersion < 2) {
    return feed;
  }
  return {
    ...feed,
    entries: feed.entries.map((entry) => {
      const state = normalizeOptionalString(entry.state);
      const publisherTrust = normalizeOptionalString(entry.publisher?.trust);
      return state === "available" && publisherTrust === "official"
        ? entry
        : removeOfficialExternalPluginCatalogInstallAuthority(entry);
    }),
  };
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
      ? `${formatErrorMessage(params.error)}; ${parsed.feed.expiresAt ? `hosted catalog signed feed expired at ${parsed.feed.expiresAt}` : "hosted catalog signed feed has no expiresAt"}`
      : formatErrorMessage(params.error),
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
          `${formatErrorMessage(params.error)}; snapshot fallback failed: ${formatErrorMessage(snapshotErr)}`,
        );
      }
      return bundledFallbackResult(
        `${formatErrorMessage(params.error)}; snapshot fallback failed: ${formatErrorMessage(snapshotErr)}`,
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
    expectedFeedId?: string;
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
    await cancelUnreadResponseBody(response);
    await release?.().catch(() => undefined);
  }
}
