/**
 * Embedded-mode Gateway method stub.
 *
 * Implements only the Gateway calls needed by session tools and rejects unsupported methods.
 */
import { normalizeFastMode, type FastMode } from "@openclaw/normalization-core/string-coerce";
import type {
  SessionsListParams,
  SessionsResolveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { parseAgentSessionKey, scopeLegacySessionKeyToAgent } from "../../routing/session-key.js";
import {
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readToolStringParam,
} from "./common.js";

type EmbeddedCallGateway = <T = Record<string, unknown>>(opts: CallGatewayOptions) => Promise<T>;

const SESSIONS_SEARCH_MAX_QUERY_CHARS = 4096;

type EmbeddedGatewayRuntime = typeof import("./embedded-gateway-stub.runtime.js");

let runtimeMod: EmbeddedGatewayRuntime | undefined;

async function getRuntime(): Promise<EmbeddedGatewayRuntime> {
  if (!runtimeMod) {
    // Lazy import keeps embedded tools cheap and gives tests a single mock boundary.
    runtimeMod = await import("./embedded-gateway-stub.runtime.js");
  }
  return runtimeMod;
}

function readOffsetParam(params: Record<string, unknown>): number | undefined {
  const offset = readNonNegativeIntegerParam(params, "offset");
  if (params.offset !== undefined && offset === undefined) {
    throw new Error("offset must be a non-negative integer");
  }
  return offset;
}

async function handleSessionsList(params: Record<string, unknown>) {
  const rt = await getRuntime();
  const cfg = rt.getRuntimeConfig();
  const opts = params as SessionsListParams;
  const { storePath, store, targetsBySessionKey } = rt.loadCombinedSessionStoreForGatewayCore(cfg, {
    agentId: opts.agentId,
    projection: "list",
  });
  return rt.listSessionsFromStoreAsync({
    cfg,
    storePath,
    store,
    targetsBySessionKey,
    opts,
  });
}

async function handleSessionsResolve(params: Record<string, unknown>) {
  const rt = await getRuntime();
  const cfg = rt.getRuntimeConfig();
  const resolved = await rt.resolveSessionKeyFromResolveParams({
    cfg,
    client: null,
    p: params as SessionsResolveParams,
  });
  if (!resolved.ok) {
    throw new Error(resolved.error.message);
  }
  if ("missing" in resolved) {
    return { ok: false };
  }
  if ("ambiguous" in resolved) {
    return { ok: false, candidates: resolved.candidates };
  }
  return { ok: true, key: resolved.key, agentId: resolved.agentId };
}

async function handleSessionsSearch(params: Record<string, unknown>) {
  const rt = await getRuntime();
  const cfg = rt.getRuntimeConfig();
  const query = typeof params.query === "string" ? params.query.trim() : "";
  if (!query) {
    throw new Error("query must not be empty");
  }
  if (query.length > SESSIONS_SEARCH_MAX_QUERY_CHARS) {
    throw new Error(`query must not exceed ${SESSIONS_SEARCH_MAX_QUERY_CHARS} characters`);
  }
  if (params.agentId !== undefined && params.sessionKeys === undefined) {
    throw new Error("agentId requires sessionKeys");
  }
  const requestedSessionKeys = Array.isArray(params.sessionKeys)
    ? params.sessionKeys.filter(
        (sessionKey): sessionKey is string => typeof sessionKey === "string",
      )
    : undefined;
  // Mirror the gateway protocol validator: an explicit sessionKeys filter must
  // stay non-empty, or an empty array would silently widen to an unfiltered
  // agent-wide search.
  if (params.sessionKeys !== undefined && (requestedSessionKeys?.length ?? 0) === 0) {
    throw new Error("sessionKeys must be a non-empty array of session keys");
  }
  const requestedAgentId = typeof params.agentId === "string" ? params.agentId.trim() : undefined;
  const sessionKeys = requestedSessionKeys?.map((sessionKey) =>
    requestedAgentId
      ? rt.resolveStoredSessionKeyForAgentStore({ cfg, agentId: requestedAgentId, sessionKey })
      : rt.resolveSessionStoreKey({ cfg, sessionKey }),
  );
  const agentIds = new Set(
    sessionKeys?.map((sessionKey) =>
      rt.resolveSessionAgentId({
        sessionKey,
        config: cfg,
        ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
      }),
    ),
  );
  if (
    agentIds.size > 1 ||
    (requestedAgentId && [...agentIds].some((agentId) => agentId !== requestedAgentId))
  ) {
    throw new Error("sessions.search supports one agent per call");
  }
  const agentId =
    requestedAgentId ??
    agentIds.values().next().value ??
    rt.resolveSessionAgentId({ sessionKey: "main", config: cfg });
  const result = rt.searchSessionTranscripts({
    agentId,
    storePath: rt.resolveSessionStorePathCore(cfg.session?.store, { agentId }),
    query,
    limit: readPositiveIntegerParam(params, "limit"),
    sessionKeys,
  });
  return {
    results: result.hits,
    ...(result.indexing ? { indexing: true } : {}),
    ...(result.truncated ? { truncated: true } : {}),
  };
}

async function handleChatHistory(params: Record<string, unknown>): Promise<{
  sessionKey: string;
  sessionId: string | undefined;
  messages: unknown[];
  offset?: number;
  nextOffset?: number;
  hasMore?: boolean;
  totalMessages?: number;
  thinkingLevel?: string;
  fastMode?: FastMode;
  verboseLevel?: string;
}> {
  const rt = await getRuntime();

  const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey : "";
  const agentId = typeof params.agentId === "string" ? params.agentId : undefined;
  const parsedAgentId = parseAgentSessionKey(sessionKey)?.agentId;
  const requestedAgentId = agentId ?? parsedAgentId;
  const limit = readPositiveIntegerParam(params, "limit");
  const offset = readOffsetParam(params) ?? 0;
  const messageId = readToolStringParam(params, "messageId", {
    required: params.messageId !== undefined,
  });
  const requestedSessionId = readToolStringParam(params, "sessionId", {
    required: params.sessionId !== undefined,
  });
  if (params.offset !== undefined && messageId !== undefined) {
    throw new Error("offset and messageId cannot be used together");
  }
  if (requestedSessionId !== undefined && messageId === undefined) {
    throw new Error("sessionId requires messageId");
  }

  const sessionLoadOptions = requestedAgentId ? { agentId: requestedAgentId } : undefined;
  const { cfg, storePath, entry, canonicalKey } = rt.loadSessionEntry(
    sessionKey,
    sessionLoadOptions,
  );
  const sessionAgentId = rt.resolveSessionAgentId({
    sessionKey,
    config: cfg,
    agentId: requestedAgentId,
  });
  if (requestedSessionId) {
    const transcriptSessionKey = rt.resolveTranscriptSessionKeyBySessionId({
      agentId: sessionAgentId,
      sessionId: requestedSessionId,
      storePath,
    });
    if (
      !transcriptSessionKey ||
      scopeLegacySessionKeyToAgent({
        sessionKey: transcriptSessionKey,
        agentId: sessionAgentId,
      }) !== scopeLegacySessionKeyToAgent({ sessionKey: canonicalKey, agentId: sessionAgentId })
    ) {
      throw new Error("sessionId does not belong to sessionKey");
    }
  }
  const sessionId = requestedSessionId ?? entry?.sessionId;
  // Reset archives share a logical key, but not the replacement's start boundary or CLI binding.
  const historyEntry =
    requestedSessionId && requestedSessionId !== entry?.sessionId ? undefined : entry;
  const resolvedSessionModel = rt.resolveSessionModelRef(cfg, entry, sessionAgentId);
  const hardMax = 1000;
  const defaultLimit = 200;
  const requested = typeof limit === "number" ? limit : defaultLimit;
  const max = Math.min(hardMax, requested);
  const maxHistoryBytes = rt.getMaxChatHistoryMessagesBytes();
  const effectiveMaxChars = rt.resolveEffectiveChatHistoryMaxChars(cfg);
  const page = await rt.readChatHistoryPage({
    entry: historyEntry,
    provider: resolvedSessionModel.provider,
    sessionId,
    storePath,
    sessionAgentId,
    canonicalKey,
    max,
    maxHistoryBytes,
    effectiveMaxChars,
    offset: params.offset === undefined ? undefined : offset,
    messageId,
  });

  // Keep transport-level byte limits identical after the shared reader projects the page.
  const perMessageHardCap = Math.min(rt.CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxHistoryBytes);
  const replaced = rt.replaceOversizedChatHistoryMessages({
    messages: page.messages,
    maxSingleMessageBytes: perMessageHardCap,
  });
  const capped = messageId
    ? (rt.capChatHistoryAroundMessage({
        messages: replaced.messages,
        messageId,
        // Reserve array framing and separators without evicting the requested anchor.
        maxCost: maxHistoryBytes - 1,
        messageCost: (message) => jsonUtf8Bytes(message) + 1,
      }) ?? rt.capArrayByJsonBytes(replaced.messages, maxHistoryBytes).items)
    : rt.capArrayByJsonBytes(replaced.messages, maxHistoryBytes).items;
  const pagination = params.offset === undefined ? undefined : page.pagination;
  const nextOffset =
    pagination !== undefined
      ? rt.resolveChatHistoryNextOffset({
          messages: capped,
          totalMessages: pagination.totalMessages,
          offset: pagination.offset,
          rawPageMessages: pagination.rawPageMessages,
          replayOldestRecord: rt.shouldReplayOldestChatHistoryRecord({
            projected: page.messages,
            bounded: capped,
          }),
        })
      : 0;
  const hasMore =
    pagination !== undefined &&
    pagination.exhausted !== true &&
    nextOffset < pagination.totalMessages;

  return {
    sessionKey,
    sessionId,
    messages: capped,
    ...(params.offset !== undefined
      ? { offset, hasMore, totalMessages: pagination?.totalMessages ?? page.messages.length }
      : {}),
    ...(hasMore ? { nextOffset } : {}),
    thinkingLevel: entry?.thinkingLevel,
    fastMode: normalizeFastMode(entry?.fastMode),
    verboseLevel: entry?.verboseLevel,
  };
}

/** Creates a local callGateway replacement for supported session methods. */
export function createEmbeddedCallGateway(): EmbeddedCallGateway {
  return async <T = Record<string, unknown>>(opts: CallGatewayOptions): Promise<T> => {
    const method = opts.method?.trim();
    const params = (opts.params ?? {}) as Record<string, unknown>;

    switch (method) {
      case "sessions.list":
        return (await handleSessionsList(params)) as T;
      case "sessions.resolve":
        return (await handleSessionsResolve(params)) as T;
      case "sessions.search":
        return (await handleSessionsSearch(params)) as T;
      case "chat.history":
        return (await handleChatHistory(params)) as T;
      default:
        throw new Error(
          `Method "${method}" requires a running gateway (unavailable in local embedded mode).`,
        );
    }
  };
}
