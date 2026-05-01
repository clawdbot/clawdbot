import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveBlueBubblesEffectiveAllowPrivateNetworkFromConfig,
  resolveBlueBubblesPrivateNetworkConfigValue,
} from "./accounts-normalization.js";
import { createBlueBubblesClientFromParts } from "./client.js";
import { rememberBlueBubblesReplyCache } from "./monitor-reply-cache.js";
import { normalizeBlueBubblesHandle } from "./targets.js";
import type { BlueBubblesAccountConfig } from "./types.js";

const DEFAULT_REPLY_FETCH_TIMEOUT_MS = 5_000;

// Reject pathological GUIDs before they reach the API path: a trailing slash
// would yield an empty bare GUID and turn the request into a list query
// against `/api/v1/message/`; arbitrary characters could let a malformed
// payload steer encoded path segments. Real BlueBubbles GUIDs are alnum + the
// punctuation set below; 128 chars is comfortable headroom (CWE-20).
const REPLY_TO_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const REPLY_TO_ID_MAX_LENGTH = 128;
const PART_INDEX_REPLY_TO_ID_PATTERN = /^p:\d{1,10}\/([A-Za-z0-9._:-]+)$/;
const PART_INDEX_REPLY_TO_ID_MAX_LENGTH = REPLY_TO_ID_MAX_LENGTH + "p:".length + 10 + "/".length;

type BlueBubblesReplyFetchResult = {
  body?: string;
  sender?: string;
};

/**
 * In-flight dedupe so concurrent webhooks for replies to the same message
 * (e.g., several recipients in a group chat replying near-simultaneously)
 * coalesce into a single BlueBubbles HTTP fetch.
 *
 * Key shape: `${accountId}:${replyToId}` to keep accounts isolated.
 */
const inflight = new Map<string, Promise<BlueBubblesReplyFetchResult | null>>();

/**
 * @internal Reset shared module state. Test-only.
 */
export function _resetBlueBubblesReplyFetchState(): void {
  inflight.clear();
}

type FetchBlueBubblesReplyContextParams = {
  accountId: string;
  replyToId: string;
  baseUrl: string;
  password: string;
  /**
   * Optional account config — used to resolve the SSRF policy for this fetch
   * via the same three-mode resolver the BlueBubbles client uses. Even when
   * omitted the request is still SSRF-guarded; the typed client routes
   * through the resolver internally and never returns `undefined`.
   */
  accountConfig?: BlueBubblesAccountConfig;
  /** Optional chat scope used to populate the reply cache for subsequent hits. */
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number;
  /** Defaults to 5_000 ms. */
  timeoutMs?: number;
  /** Override the typed client factory. Test seam. */
  clientFactory?: typeof createBlueBubblesClientFromParts;
};

/**
 * Best-effort fallback: when the local in-memory reply cache misses, ask the
 * BlueBubbles HTTP API for the original message so the agent still gets reply
 * context. Returns `null` on any failure (network error, non-2xx, parse error,
 * empty payload). Never throws.
 *
 * On success, the cache is populated so subsequent replies to the same message
 * resolve from RAM without another round-trip.
 *
 * Cache misses happen in legitimate, common deployments: multi-instance setups
 * sharing one BB account, container/process restarts, cross-tenant shared
 * groups, and long-lived chats where TTL/LRU has evicted the message.
 */
export function fetchBlueBubblesReplyContext(
  params: FetchBlueBubblesReplyContextParams,
): Promise<BlueBubblesReplyFetchResult | null> {
  const replyToId = sanitizeReplyToId(params.replyToId);
  if (!replyToId || !params.baseUrl || !params.password) {
    return Promise.resolve(null);
  }
  const key = `${params.accountId}:${replyToId}`;
  const existing = inflight.get(key);
  if (existing) {
    return existing;
  }
  const promise = runFetch(params, replyToId).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

/**
 * Strip a part-index prefix (`p:0/<guid>` → `<guid>`) and validate the result
 * against the GUID character set + length cap. Returns null when the id is
 * empty or cannot safely be used as a path segment.
 */
function sanitizeReplyToId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const bare = trimmed.includes("/") ? (trimmed.split("/").pop() ?? "") : trimmed;
  if (!bare || bare.length > REPLY_TO_ID_MAX_LENGTH || !REPLY_TO_ID_PATTERN.test(bare)) {
    return null;
  }
  return bare;
}

function normalizePartIndexReplyToIdAlias(raw: string, bareReplyToId: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length > PART_INDEX_REPLY_TO_ID_MAX_LENGTH) {
    return null;
  }
  const match = PART_INDEX_REPLY_TO_ID_PATTERN.exec(trimmed);
  if (!match || match[1] !== bareReplyToId) {
    return null;
  }
  return trimmed;
}

async function runFetch(
  params: FetchBlueBubblesReplyContextParams,
  replyToId: string,
): Promise<BlueBubblesReplyFetchResult | null> {
  const factory = params.clientFactory ?? createBlueBubblesClientFromParts;
  // Route through the typed BlueBubbles client. `client.request()` always
  // applies the SSRF policy resolved via the canonical three-mode helper
  // (mode 1: explicit private-network opt-in, mode 2: hostname allowlist for
  // trusted self-hosted servers, mode 3: default-deny guard). Going through
  // the typed surface guarantees consistency with every other BB client
  // request and removes the risk of an `undefined` policy slipping past the
  // guard. (PR #71820 review; same threat model as #68234.)
  const client = factory({
    accountId: params.accountId,
    baseUrl: params.baseUrl,
    password: params.password,
    allowPrivateNetwork: resolveBlueBubblesEffectiveAllowPrivateNetworkFromConfig({
      baseUrl: params.baseUrl,
      config: params.accountConfig,
    }),
    allowPrivateNetworkConfig: resolveBlueBubblesPrivateNetworkConfigValue(params.accountConfig),
    timeoutMs: params.timeoutMs ?? DEFAULT_REPLY_FETCH_TIMEOUT_MS,
  });
  try {
    const response = await client.request({
      method: "GET",
      path: `/api/v1/message/${encodeURIComponent(replyToId)}`,
      timeoutMs: params.timeoutMs ?? DEFAULT_REPLY_FETCH_TIMEOUT_MS,
    });
    if (!response.ok) {
      return null;
    }
    const json = (await response.json()) as Record<string, unknown>;
    const data = (json.data ?? json) as Record<string, unknown> | undefined;
    if (!data || typeof data !== "object") {
      return null;
    }
    const body = extractBody(data);
    const sender = extractSender(data);
    if (!body && !sender) {
      return null;
    }
    const cacheEntry = {
      accountId: params.accountId,
      messageId: replyToId,
      chatGuid: params.chatGuid,
      chatIdentifier: params.chatIdentifier,
      chatId: params.chatId,
      senderLabel: sender,
      body,
      timestamp: Date.now(),
    };
    rememberBlueBubblesReplyCache(cacheEntry);
    const partIndexReplyToId = normalizePartIndexReplyToIdAlias(params.replyToId, replyToId);
    if (partIndexReplyToId) {
      rememberBlueBubblesReplyCache({
        ...cacheEntry,
        messageId: partIndexReplyToId,
      });
    }
    return { body, sender };
  } catch {
    // Best-effort: swallow network/parse errors. Caller proceeds with empty
    // reply context, which matches existing pre-fallback behavior.
    return null;
  }
}

function extractBody(data: Record<string, unknown>): string | undefined {
  return (
    normalizeOptionalString(data.text) ??
    normalizeOptionalString(data.body) ??
    normalizeOptionalString(data.subject)
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractSender(data: Record<string, unknown>): string | undefined {
  const handle = asRecord(data.handle) ?? asRecord(data.sender);
  const raw =
    normalizeOptionalString(handle?.address) ??
    normalizeOptionalString(handle?.id) ??
    normalizeOptionalString(data.senderId) ??
    normalizeOptionalString(data.sender);
  if (!raw) {
    return undefined;
  }
  return normalizeBlueBubblesHandle(raw) || raw;
}
