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
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CallGatewayOptions } from "../../gateway/call.js";
import type { ChatHistoryPage } from "../../gateway/server-methods/chat-history-pages.js";
import type { SessionsListResult } from "../../gateway/session-utils.types.js";
import type { SessionsResolveResult } from "../../gateway/sessions-resolve.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { readNonNegativeIntegerParam, readPositiveIntegerParam } from "./common.js";

type EmbeddedCallGateway = <T = Record<string, unknown>>(opts: CallGatewayOptions) => Promise<T>;

const SESSIONS_SEARCH_MAX_QUERY_CHARS = 4096;

interface EmbeddedGatewayRuntime {
  resolveSessionAgentId: (opts: {
    sessionKey: string;
    config: OpenClawConfig;
    agentId?: string;
  }) => string;
  getRuntimeConfig: () => OpenClawConfig;
  resolveDefaultAgentId: (config: OpenClawConfig) => string;
  resolveSessionStoreKey: (params: { cfg: OpenClawConfig; sessionKey: string }) => string;
  resolveStoredSessionKeyForAgentStore: (params: {
    cfg: OpenClawConfig;
    agentId: string;
    sessionKey: string;
  }) => string;
  searchSessionTranscripts: (params: {
    agentId: string;
    limit?: number;
    query: string;
    sessionKeys?: string[];
  }) => {
    hits: unknown[];
    indexing: boolean;
    truncated: boolean;
  };
  getMaxChatHistoryMessagesBytes: () => number;
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES: number;
  replaceOversizedChatHistoryMessages: (opts: {
    messages: unknown[];
    maxSingleMessageBytes: number;
  }) => { messages: unknown[] };
  resolveEffectiveChatHistoryMaxChars: (cfg: OpenClawConfig) => number;
  capArrayByJsonBytes: (items: unknown[], maxBytes: number) => { items: unknown[] };
  listSessionsFromStoreAsync: (opts: {
    cfg: OpenClawConfig;
    storePath: string;
    store: unknown;
    opts: SessionsListParams;
  }) => Promise<SessionsListResult>;
  loadCombinedSessionStoreForGatewayCore: (
    cfg: OpenClawConfig,
    opts?: { agentId?: string; projection?: "full" | "list" },
  ) => {
    storePath: string;
    store: unknown;
  };
  resolveSessionKeyFromResolveParams: (opts: {
    cfg: OpenClawConfig;
    client: null;
    p: SessionsResolveParams;
  }) => Promise<SessionsResolveResult>;
  loadSessionEntry: (
    sessionKey: string,
    opts?: { agentId?: string },
  ) => {
    cfg: OpenClawConfig;
    storePath: string | undefined;
    entry: Record<string, unknown> | undefined;
    canonicalKey: string;
  };
  readChatHistoryPage: (params: {
    entry: Record<string, unknown> | undefined;
    provider: string | undefined;
    sessionId: string | undefined;
    storePath: string | undefined;
    sessionAgentId: string;
    canonicalKey: string;
    max: number;
    maxHistoryBytes: number;
    effectiveMaxChars: number;
    offset: number | undefined;
    messageId: undefined;
  }) => Promise<ChatHistoryPage>;
  resolveChatHistoryNextOffset: (params: {
    messages: unknown[];
    totalMessages: number;
    offset: number;
    rawPageMessages: number;
    replayOldestRecord?: boolean;
  }) => number;
  shouldReplayOldestChatHistoryRecord: (params: {
    projected: unknown[];
    bounded: unknown[];
  }) => boolean;
  resolveSessionModelRef: (
    cfg: OpenClawConfig,
    entry: unknown,
    sessionAgentId: string,
  ) => { provider: string | undefined };
}

let runtimeMod: EmbeddedGatewayRuntime | undefined;

async function getRuntime(): Promise<EmbeddedGatewayRuntime> {
  if (!runtimeMod) {
    // Lazy import keeps embedded tools cheap and gives tests a single mock boundary.
    runtimeMod = (await import("./embedded-gateway-stub.runtime.js")) as EmbeddedGatewayRuntime;
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
  const { storePath, store } = rt.loadCombinedSessionStoreForGatewayCore(cfg, {
    agentId: opts.agentId,
    projection: "list",
  });
  return rt.listSessionsFromStoreAsync({
    cfg,
    storePath,
    store,
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
    requestedAgentId ?? agentIds.values().next().value ?? rt.resolveDefaultAgentId(cfg);
  const result = rt.searchSessionTranscripts({
    agentId,
    query,
    limit: readPositiveIntegerParam(params, "limit"),
    ...(sessionKeys ? { sessionKeys } : {}),
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
  const requestedOffset = readOffsetParam(params);

  const sessionLoadOptions = requestedAgentId ? { agentId: requestedAgentId } : undefined;
  const { cfg, storePath, entry, canonicalKey } = rt.loadSessionEntry(
    sessionKey,
    sessionLoadOptions,
  );
  const sessionId = entry?.sessionId as string | undefined;
  const sessionAgentId = rt.resolveSessionAgentId({
    sessionKey,
    config: cfg,
    agentId: requestedAgentId,
  });
  const resolvedSessionModel = rt.resolveSessionModelRef(cfg, entry, sessionAgentId);
  const hardMax = 1000;
  const defaultLimit = 200;
  const requested = typeof limit === "number" ? limit : defaultLimit;
  const max = Math.min(hardMax, requested);
  const maxHistoryBytes = rt.getMaxChatHistoryMessagesBytes();
  const effectiveMaxChars = rt.resolveEffectiveChatHistoryMaxChars(cfg);
  const historyPage = await rt.readChatHistoryPage({
    entry,
    provider: resolvedSessionModel.provider,
    sessionId,
    storePath,
    sessionAgentId,
    canonicalKey,
    max,
    maxHistoryBytes,
    effectiveMaxChars,
    offset: requestedOffset,
    messageId: undefined,
  });

  const perMessageHardCap = Math.min(rt.CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxHistoryBytes);
  const replaced = rt.replaceOversizedChatHistoryMessages({
    messages: historyPage.messages,
    maxSingleMessageBytes: perMessageHardCap,
  });
  const capped = rt.capArrayByJsonBytes(replaced.messages, maxHistoryBytes).items;
  const pagination = historyPage.pagination;
  const candidateNextOffset =
    pagination === undefined
      ? undefined
      : rt.resolveChatHistoryNextOffset({
          messages: capped,
          totalMessages: pagination.totalMessages,
          offset: pagination.offset,
          rawPageMessages: pagination.rawPageMessages,
          replayOldestRecord: rt.shouldReplayOldestChatHistoryRecord({
            projected: historyPage.messages,
            bounded: capped,
          }),
        });
  const hasMore =
    pagination !== undefined && candidateNextOffset !== undefined
      ? pagination.exhausted !== true && candidateNextOffset < pagination.totalMessages
      : undefined;
  const nextOffset = hasMore ? candidateNextOffset : undefined;

  return {
    sessionKey,
    sessionId,
    messages: capped,
    ...(historyPage.responseOffset !== undefined ? { offset: historyPage.responseOffset } : {}),
    ...(hasMore ? { nextOffset } : {}),
    ...(hasMore !== undefined ? { hasMore } : {}),
    ...(pagination !== undefined ? { totalMessages: pagination.totalMessages } : {}),
    thinkingLevel: entry?.thinkingLevel as string | undefined,
    fastMode: normalizeFastMode(entry?.fastMode),
    verboseLevel: entry?.verboseLevel as string | undefined,
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
