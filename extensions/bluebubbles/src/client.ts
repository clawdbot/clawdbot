// BlueBubblesClient — consolidated BB API client.
//
// Resolves the BB server URL, auth material, and SSRF policy ONCE at
// construction, then exposes typed operations that cannot omit any of them.
//
// Designed to replace the scattered pattern of each callsite computing its own
// SsrFPolicy and passing it to `blueBubblesFetchWithTimeout`. Related issues:
//   - #34749 image attachments blocked by SSRF guard (localhost)
//   - #57181 SSRF blocks BB plugin internal API calls
//   - #59722 SSRF allowlist doesn't cover reactions
//   - #60715 BB health check fails on LAN/private serverUrl
//   - #66869 move `?password=` → header auth (future-proofed via AuthStrategy)

import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isBlockedHostnameOrIp, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveBlueBubblesServerAccount } from "./account-resolve.js";
import { extractAttachments } from "./monitor-normalize.js";
import { postMultipartFormData } from "./multipart.js";
import { resolveRequestUrl } from "./request-url.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { getBlueBubblesRuntime } from "./runtime.js";
import {
  blueBubblesFetchWithTimeout,
  normalizeBlueBubblesServerUrl,
  type BlueBubblesAttachment,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MULTIPART_TIMEOUT_MS = 60_000;

// --- Auth strategy ---------------------------------------------------------

/**
 * Pluggable authentication for BlueBubbles API requests. Mutates the URL/init
 * pair in place before the request is dispatched.
 *
 * Two built-in strategies are provided:
 *   - `blueBubblesQueryStringAuth` — today's `?password=...` pattern (default).
 *   - `blueBubblesHeaderAuth` — header-based auth; flip the default here when
 *     BB Server ships the header-auth change for #66869.
 */
export interface BlueBubblesAuthStrategy {
  /**
   * Stable identifier for this strategy. Used by the client cache fingerprint
   * so two clients for the same account + credential that differ only in auth
   * strategy don't silently collapse onto the same cached instance.
   * (Greptile #68234 P2)
   */
  readonly id: string;
  decorate(req: { url: URL; init: RequestInit }): void;
}

export function blueBubblesQueryStringAuth(password: string): BlueBubblesAuthStrategy {
  return {
    id: "query-string",
    decorate({ url }) {
      url.searchParams.set("password", password);
    },
  };
}

export function blueBubblesHeaderAuth(
  password: string,
  headerName = "X-BB-Password",
): BlueBubblesAuthStrategy {
  return {
    id: `header:${headerName}`,
    decorate({ init }) {
      const headers = new Headers(init.headers ?? undefined);
      headers.set(headerName, password);
      init.headers = headers;
    },
  };
}

// --- Policy resolution -----------------------------------------------------

function safeExtractHostname(baseUrl: string): string | undefined {
  try {
    const hostname = new URL(normalizeBlueBubblesServerUrl(baseUrl)).hostname.trim();
    return hostname || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the BB client's SSRF policy at construction time. Three modes —
 * all of which go through `fetchWithSsrFGuard`; we never hand back a policy
 * that skips the guard:
 *
 *   1. `{ allowPrivateNetwork: true }` — user explicitly opted in
 *      (`network.dangerouslyAllowPrivateNetwork: true`). Private/loopback
 *      addresses are permitted for this client.
 *
 *   2. `{ allowedHostnames: [trustedHostname] }` — narrow allowlist. Applied
 *      when we have a parseable hostname AND the user has not explicitly
 *      opted out (or the hostname isn't private anyway). This is the case
 *      that closes #34749, #57181, #59722, #60715 for self-hosted BB on
 *      private/localhost addresses without requiring a full opt-in.
 *
 *   3. `{}` — guarded with the default-deny policy. Applied when we can't
 *      produce a valid allowlist (opt-out on a private hostname, or an
 *      unparseable baseUrl). Previously returned `undefined` and skipped
 *      the guard entirely, which was an SSRF bypass when a user explicitly
 *      opted out of private-network access. Aisle #68234 found this.
 *
 * Prior to this helper, the logic lived inline in `attachments.ts` and was
 * inconsistently replicated across 15+ callsites. Resolving once ensures
 * every request from a client instance uses the same policy.
 */
export function resolveBlueBubblesClientSsrfPolicy(params: {
  baseUrl: string;
  allowPrivateNetwork: boolean;
  allowPrivateNetworkConfig?: boolean;
}): {
  ssrfPolicy: SsrFPolicy;
  trustedHostname?: string;
  trustedHostnameIsPrivate: boolean;
} {
  const trustedHostname = safeExtractHostname(params.baseUrl);
  const trustedHostnameIsPrivate = trustedHostname ? isBlockedHostnameOrIp(trustedHostname) : false;

  if (params.allowPrivateNetwork) {
    return {
      ssrfPolicy: { allowPrivateNetwork: true },
      trustedHostname,
      trustedHostnameIsPrivate,
    };
  }

  if (
    trustedHostname &&
    (params.allowPrivateNetworkConfig !== false || !trustedHostnameIsPrivate)
  ) {
    return {
      ssrfPolicy: { allowedHostnames: [trustedHostname] },
      trustedHostname,
      trustedHostnameIsPrivate,
    };
  }

  // Mode 3: default-deny guard. Honors an explicit opt-out on a private
  // hostname and fails-safe on unparseable URLs. Never undefined. (aisle #68234)
  return { ssrfPolicy: {}, trustedHostname, trustedHostnameIsPrivate };
}

// --- Client ----------------------------------------------------------------

export type BlueBubblesClientOptions = {
  cfg?: OpenClawConfig;
  accountId?: string;
  serverUrl?: string;
  password?: string;
  timeoutMs?: number;
  authStrategy?: (password: string) => BlueBubblesAuthStrategy;
};

type ClientConstructorParams = {
  accountId: string;
  baseUrl: string;
  password: string;
  ssrfPolicy: SsrFPolicy;
  trustedHostname: string | undefined;
  trustedHostnameIsPrivate: boolean;
  defaultTimeoutMs: number;
  authStrategy: BlueBubblesAuthStrategy;
};

type MediaFetchErrorCode = "max_bytes" | "http_error" | "fetch_failed";

function readMediaFetchErrorCode(error: unknown): MediaFetchErrorCode | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return code === "max_bytes" || code === "http_error" || code === "fetch_failed"
    ? code
    : undefined;
}

export class BlueBubblesClient {
  readonly accountId: string;
  readonly baseUrl: string;
  readonly trustedHostname: string | undefined;
  readonly trustedHostnameIsPrivate: boolean;

  private readonly password: string;
  private readonly ssrfPolicy: SsrFPolicy;
  private readonly defaultTimeoutMs: number;
  private readonly authStrategy: BlueBubblesAuthStrategy;

  constructor(params: ClientConstructorParams) {
    this.accountId = params.accountId;
    this.baseUrl = params.baseUrl;
    this.password = params.password;
    this.ssrfPolicy = params.ssrfPolicy;
    this.trustedHostname = params.trustedHostname;
    this.trustedHostnameIsPrivate = params.trustedHostnameIsPrivate;
    this.defaultTimeoutMs = params.defaultTimeoutMs;
    this.authStrategy = params.authStrategy;
  }

  /**
   * Read the resolved SSRF policy for this client. Exposed primarily for tests
   * and diagnostics; production code should never need to inspect it.
   */
  getSsrfPolicy(): SsrFPolicy {
    return this.ssrfPolicy;
  }

  // Build an authorized URL+init pair. Auth is applied exactly once per
  // request; the SSRF policy is attached by `request()` below.
  private buildAuthorizedRequest(params: { path: string; method: string; init?: RequestInit }): {
    url: string;
    init: RequestInit;
  } {
    const normalized = normalizeBlueBubblesServerUrl(this.baseUrl);
    const url = new URL(params.path, `${normalized}/`);
    const init: RequestInit = { ...params.init, method: params.method };
    this.authStrategy.decorate({ url, init });
    return { url: url.toString(), init };
  }

  /**
   * Core request method. All typed operations on the client route through
   * this method, which handles auth decoration, SSRF policy, and timeout.
   */
  async request(params: {
    method: string;
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<Response> {
    const init: RequestInit = {};
    if (params.headers) {
      init.headers = { ...params.headers };
    }
    if (params.body !== undefined) {
      init.headers = {
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      };
      init.body = JSON.stringify(params.body);
    }
    const prepared = this.buildAuthorizedRequest({
      path: params.path,
      method: params.method,
      init,
    });
    return await blueBubblesFetchWithTimeout(
      prepared.url,
      prepared.init,
      params.timeoutMs ?? this.defaultTimeoutMs,
      this.ssrfPolicy,
    );
  }

  /**
   * JSON request helper. Returns both the response (for status/headers) and
   * parsed body (null on non-ok or parse failure — callers check both).
   */
  async requestJson(params: {
    method: string;
    path: string;
    body?: unknown;
    timeoutMs?: number;
  }): Promise<{ response: Response; data: unknown }> {
    const response = await this.request(params);
    if (!response.ok) {
      return { response, data: null };
    }
    const raw: unknown = await response.json().catch(() => null);
    return { response, data: raw };
  }

  /**
   * Multipart POST (attachment send, group icon set). The caller supplies the
   * boundary and body parts; the client handles URL construction, auth, and
   * SSRF policy. Timeout defaults to 60s because uploads can be large.
   *
   * Auth-decorated headers from `prepared.init` are forwarded via `extraHeaders`
   * so header-auth strategies keep working on multipart paths. (Greptile #68234 P1)
   */
  async requestMultipart(params: {
    path: string;
    boundary: string;
    parts: Uint8Array[];
    timeoutMs?: number;
  }): Promise<Response> {
    const prepared = this.buildAuthorizedRequest({
      path: params.path,
      method: "POST",
      init: {},
    });
    return await postMultipartFormData({
      url: prepared.url,
      boundary: params.boundary,
      parts: params.parts,
      timeoutMs: params.timeoutMs ?? DEFAULT_MULTIPART_TIMEOUT_MS,
      ssrfPolicy: this.ssrfPolicy,
      extraHeaders: prepared.init.headers,
    });
  }

  // --- Probe operations ----------------------------------------------------

  /** GET /api/v1/ping — health check. Raw response for status inspection. */
  async ping(params: { timeoutMs?: number } = {}): Promise<Response> {
    return await this.request({
      method: "GET",
      path: "/api/v1/ping",
      timeoutMs: params.timeoutMs,
    });
  }

  /** GET /api/v1/server/info — server/OS/Private-API metadata. */
  async getServerInfo(params: { timeoutMs?: number } = {}): Promise<Response> {
    return await this.request({
      method: "GET",
      path: "/api/v1/server/info",
      timeoutMs: params.timeoutMs,
    });
  }

  // --- Reactions (fixes #59722) -------------------------------------------

  /**
   * POST /api/v1/message/react. Uses the same SSRF policy as every other
   * operation on this client — closing the gap where `reactions.ts` passed
   * `{}` (always guarded, always blocks private IPs) while other callsites
   * used mode-aware policies.
   */
  async react(params: {
    chatGuid: string;
    selectedMessageGuid: string;
    reaction: string;
    partIndex?: number;
    timeoutMs?: number;
  }): Promise<Response> {
    return await this.request({
      method: "POST",
      path: "/api/v1/message/react",
      body: {
        chatGuid: params.chatGuid,
        selectedMessageGuid: params.selectedMessageGuid,
        reaction: params.reaction,
        partIndex: typeof params.partIndex === "number" ? params.partIndex : 0,
      },
      timeoutMs: params.timeoutMs,
    });
  }

  // --- Attachments (fixes #34749) -----------------------------------------

  /**
   * GET /api/v1/message/{guid} to read attachment metadata. BlueBubbles may
   * fire `new-message` before attachment indexing completes, so this re-reads
   * after a delay. (#65430, #67437)
   */
  async getMessageAttachments(params: {
    messageGuid: string;
    timeoutMs?: number;
  }): Promise<BlueBubblesAttachment[]> {
    const { response, data } = await this.requestJson({
      method: "GET",
      path: `/api/v1/message/${encodeURIComponent(params.messageGuid)}`,
      timeoutMs: params.timeoutMs,
    });
    if (!response.ok || typeof data !== "object" || data === null) {
      return [];
    }
    const inner = (data as { data?: unknown }).data;
    if (typeof inner !== "object" || inner === null) {
      return [];
    }
    return extractAttachments(inner as Record<string, unknown>);
  }

  /**
   * Download an attachment via the channel media fetcher. Unlike the legacy
   * helper, the SSRF policy is threaded to BOTH `fetchRemoteMedia` AND the
   * `fetchImpl` callback — closing #34749 where the callback silently fell
   * back to the unguarded fetch path regardless of the outer policy.
   *
   * Note: the actual SSRF check still happens upstream in `fetchRemoteMedia`.
   * Passing `ssrfPolicy` to `blueBubblesFetchWithTimeout` in the callback
   * keeps it in the guarded path if the host needs re-validation (e.g. on a
   * BB Server that issues 302 redirects to a different host).
   */
  async downloadAttachment(params: {
    attachment: BlueBubblesAttachment;
    maxBytes?: number;
    timeoutMs?: number;
  }): Promise<{ buffer: Uint8Array; contentType?: string }> {
    const guid = params.attachment.guid?.trim();
    if (!guid) {
      throw new Error("BlueBubbles attachment guid is required");
    }
    const maxBytes =
      typeof params.maxBytes === "number" ? params.maxBytes : DEFAULT_ATTACHMENT_MAX_BYTES;
    const prepared = this.buildAuthorizedRequest({
      path: `/api/v1/attachment/${encodeURIComponent(guid)}/download`,
      method: "GET",
      init: {},
    });
    const clientSsrfPolicy = this.ssrfPolicy;
    const effectiveTimeoutMs = params.timeoutMs ?? this.defaultTimeoutMs;
    // Auth-decorated headers from buildAuthorizedRequest (for header-auth
    // strategies) must flow through the fetchImpl callback too, otherwise
    // the runtime might dispatch with only its own default headers. Merge
    // prepared.init.headers with any headers the runtime supplies; runtime
    // headers (typically Range for partial reads) win on conflict.
    // (Greptile #68234 P1)
    const preparedHeaders = prepared.init.headers;

    try {
      const fetched = await getBlueBubblesRuntime().channel.media.fetchRemoteMedia({
        url: prepared.url,
        filePathHint: params.attachment.transferName ?? params.attachment.guid ?? "attachment",
        maxBytes,
        ssrfPolicy: clientSsrfPolicy,
        fetchImpl: async (input, init) => {
          const mergedHeaders = new Headers(preparedHeaders);
          if (init?.headers) {
            const runtimeHeaders = new Headers(init.headers);
            runtimeHeaders.forEach((value, key) => mergedHeaders.set(key, value));
          }
          return await blueBubblesFetchWithTimeout(
            resolveRequestUrl(input),
            { ...init, method: init?.method ?? "GET", headers: mergedHeaders },
            effectiveTimeoutMs,
            clientSsrfPolicy,
          );
        },
      });
      return {
        buffer: new Uint8Array(fetched.buffer),
        contentType: fetched.contentType ?? params.attachment.mimeType ?? undefined,
      };
    } catch (error) {
      if (readMediaFetchErrorCode(error) === "max_bytes") {
        throw new Error(`BlueBubbles attachment too large (limit ${maxBytes} bytes)`, {
          cause: error,
        });
      }
      throw new Error(`BlueBubbles attachment download failed: ${formatErrorMessage(error)}`, {
        cause: error,
      });
    }
  }
}

// --- Factory and cache -----------------------------------------------------

type CachedClientEntry = {
  client: BlueBubblesClient;
  /** Fingerprint of auth + SSRF-policy inputs — cache hit requires full match. */
  fingerprint: string;
};
const clientFingerprints = new Map<string, CachedClientEntry>();

function buildClientFingerprint(params: {
  baseUrl: string;
  password: string;
  authStrategyId: string;
  allowPrivateNetwork: boolean;
  allowPrivateNetworkConfig?: boolean;
}): string {
  // Keep every construction-time behavior input here. The client stores auth
  // and SSRF policy immutably, so config flips must rebuild without requiring
  // a process restart or an explicit cache invalidation call.
  return JSON.stringify({
    baseUrl: params.baseUrl,
    password: params.password,
    authStrategyId: params.authStrategyId,
    allowPrivateNetwork: params.allowPrivateNetwork,
    allowPrivateNetworkConfig: params.allowPrivateNetworkConfig ?? null,
  });
}

/**
 * Get or create a `BlueBubblesClient` for one BB account. The client is cached
 * by `accountId` — the next call with the same account AND same {baseUrl,
 * password} returns the existing instance. Password or URL change rebuilds.
 * Call `invalidateBlueBubblesClient(accountId)` from account config reload
 * paths to evict explicitly.
 */
export function createBlueBubblesClient(opts: BlueBubblesClientOptions = {}): BlueBubblesClient {
  const resolved = resolveBlueBubblesServerAccount({
    cfg: opts.cfg,
    accountId: opts.accountId,
    serverUrl: opts.serverUrl,
    password: opts.password,
  });
  const cacheKey = resolved.accountId || DEFAULT_ACCOUNT_ID;
  const authFactory = opts.authStrategy ?? blueBubblesQueryStringAuth;
  const authStrategy = authFactory(resolved.password);
  const fingerprint = buildClientFingerprint({
    baseUrl: resolved.baseUrl,
    password: resolved.password,
    authStrategyId: authStrategy.id,
    allowPrivateNetwork: resolved.allowPrivateNetwork,
    allowPrivateNetworkConfig: resolved.allowPrivateNetworkConfig,
  });
  const cached = clientFingerprints.get(cacheKey);
  if (cached && cached.fingerprint === fingerprint) {
    return cached.client;
  }

  const policyResult = resolveBlueBubblesClientSsrfPolicy({
    baseUrl: resolved.baseUrl,
    allowPrivateNetwork: resolved.allowPrivateNetwork,
    allowPrivateNetworkConfig: resolved.allowPrivateNetworkConfig,
  });

  const client = new BlueBubblesClient({
    accountId: cacheKey,
    baseUrl: resolved.baseUrl,
    password: resolved.password,
    ssrfPolicy: policyResult.ssrfPolicy,
    trustedHostname: policyResult.trustedHostname,
    trustedHostnameIsPrivate: policyResult.trustedHostnameIsPrivate,
    defaultTimeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    authStrategy,
  });
  clientFingerprints.set(cacheKey, { client, fingerprint });
  return client;
}

/** Evict a cached client by account id. Called from account config reload paths. */
export function invalidateBlueBubblesClient(accountId?: string): void {
  const key = accountId || DEFAULT_ACCOUNT_ID;
  clientFingerprints.delete(key);
}

/** @internal Clear the whole client cache. Test helper. */
export function clearBlueBubblesClientCache(): void {
  clientFingerprints.clear();
}

/**
 * Build a BlueBubblesClient from a pre-resolved `{baseUrl, password,
 * allowPrivateNetwork}` tuple, skipping the account/config resolution path.
 *
 * Used by low-level helpers (`probe.ts`, `catchup.ts`, `history.ts`, etc.)
 * that are called with the resolved tuple rather than a full config bag.
 * Migrated callers pass their existing booleans straight through — the
 * three-mode policy resolution then runs exactly once here.
 *
 * Uncached — intended for short-lived callsites. Prefer `createBlueBubblesClient`
 * when a `cfg` + `accountId` are available.
 */
export function createBlueBubblesClientFromParts(params: {
  baseUrl: string;
  password: string;
  allowPrivateNetwork: boolean;
  allowPrivateNetworkConfig?: boolean;
  accountId?: string;
  timeoutMs?: number;
  authStrategy?: (password: string) => BlueBubblesAuthStrategy;
}): BlueBubblesClient {
  const policyResult = resolveBlueBubblesClientSsrfPolicy({
    baseUrl: params.baseUrl,
    allowPrivateNetwork: params.allowPrivateNetwork,
    allowPrivateNetworkConfig: params.allowPrivateNetworkConfig,
  });
  const authFactory = params.authStrategy ?? blueBubblesQueryStringAuth;
  return new BlueBubblesClient({
    accountId: params.accountId || DEFAULT_ACCOUNT_ID,
    baseUrl: params.baseUrl,
    password: params.password,
    ssrfPolicy: policyResult.ssrfPolicy,
    trustedHostname: policyResult.trustedHostname,
    trustedHostnameIsPrivate: policyResult.trustedHostnameIsPrivate,
    defaultTimeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    authStrategy: authFactory(params.password),
  });
}
