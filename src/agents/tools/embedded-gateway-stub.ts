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
import type {
  ReadSessionMessagesAsyncOptions,
  SessionTranscriptReadScope,
} from "../../gateway/session-transcript-readers.js";
import type { SessionsListResult } from "../../gateway/session-utils.types.js";
import type { SessionsResolveResult } from "../../gateway/sessions-resolve.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { readNonNegativeIntegerParam, readPositiveIntegerParam } from "./common.js";

type EmbeddedCallGateway = <T = Record<string, unknown>>(opts: CallGatewayOptions) => Promise<T>;

interface EmbeddedGatewayRuntime {
  resolveSessionAgentId: (opts: {
    sessionKey: string;
    config: OpenClawConfig;
    agentId?: string;
  }) => string;
  getRuntimeConfig: () => OpenClawConfig;
  augmentChatHistoryWithCliSessionImports: (opts: {
    entry: unknown;
    provider: string | undefined;
    localMessages: unknown[];
  }) => unknown[];
  getMaxChatHistoryMessagesBytes: () => number;
  augmentChatHistoryWithCanvasBlocks: (msgs: unknown[]) => unknown[];
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES: number;
  enforceChatHistoryFinalBudget: (opts: { messages: unknown[]; maxBytes: number }) => {
    messages: unknown[];
  };
  replaceOversizedChatHistoryMessages: (opts: {
    messages: unknown[];
    maxSingleMessageBytes: number;
  }) => { messages: unknown[] };
  resolveEffectiveChatHistoryMaxChars: (cfg: OpenClawConfig) => number;
  dropPreSessionStartAnnouncePairs: (
    messages: unknown[],
    sessionStartedAt: number | undefined,
  ) => unknown[];
  projectChatDisplayMessages: (msgs: unknown[], opts?: { maxChars?: number }) => unknown[];
  projectRecentChatDisplayMessages: (
    msgs: unknown[],
    opts?: { maxChars?: number; maxMessages?: number },
  ) => unknown[];
  capArrayByJsonBytes: (items: unknown[], maxBytes: number) => { items: unknown[] };
  listSessionsFromStoreAsync: (opts: {
    cfg: OpenClawConfig;
    storePath: string;
    store: unknown;
    opts: SessionsListParams;
  }) => Promise<SessionsListResult>;
  loadCombinedSessionStoreForGateway: (
    cfg: OpenClawConfig,
    opts?: { agentId?: string },
  ) => {
    storePath: string;
    store: unknown;
  };
  resolveSessionKeyFromResolveParams: (opts: {
    cfg: OpenClawConfig;
    p: SessionsResolveParams;
  }) => Promise<SessionsResolveResult>;
  loadSessionEntry: (
    sessionKey: string,
    opts?: { agentId?: string },
  ) => {
    cfg: OpenClawConfig;
    storePath: string | undefined;
    entry: Record<string, unknown> | undefined;
  };
  readSessionMessagesAsync: (
    scope: SessionTranscriptReadScope,
    opts: ReadSessionMessagesAsyncOptions,
  ) => Promise<unknown[]>;
  readRecentSessionMessagesWithStatsAsync: (
    scope: SessionTranscriptReadScope,
    opts: { maxMessages: number; maxBytes?: number; allowResetArchiveFallback?: boolean },
  ) => Promise<{ messages: unknown[]; totalMessages: number }>;
  readSessionMessagesPageWithStatsAsync: (
    scope: SessionTranscriptReadScope,
    opts: { offset: number; maxMessages: number; allowResetArchiveFallback?: boolean },
  ) => Promise<{ messages: unknown[]; totalMessages: number }>;
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

function readChatHistoryMessageSeq(message: unknown): number | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const metadata = (message as Record<string, unknown>)["__openclaw"];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const seq = (metadata as Record<string, unknown>).seq;
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0 ? seq : undefined;
}

function resolveChatHistoryNextOffset(params: {
  messages: unknown[];
  totalMessages: number;
  offset: number;
  rawPageMessages: number;
}): number {
  const oldestSeq = params.messages
    .map((message) => readChatHistoryMessageSeq(message))
    .find((seq): seq is number => typeof seq === "number");
  if (oldestSeq !== undefined) {
    return Math.max(params.offset, params.totalMessages - oldestSeq + 1);
  }
  return params.offset + params.rawPageMessages;
}

function capOffsetChatHistoryProjectedMessages(messages: unknown[], max: number): unknown[] {
  if (messages.length <= max) {
    return messages;
  }
  const start = Math.max(0, messages.length - max);
  const boundarySeq = readChatHistoryMessageSeq(messages[start]);
  if (boundarySeq === undefined) {
    return messages.slice(start);
  }
  // Offset cursors can only resume at transcript-record boundaries.
  // Keep boundary rows with the same seq together so projection mirrors are not stranded.
  let safeStart = start;
  while (safeStart > 0 && readChatHistoryMessageSeq(messages[safeStart - 1]) === boundarySeq) {
    safeStart--;
  }
  return messages.slice(safeStart);
}

function dropChatHistoryOverreadContextMessage(
  messages: unknown[],
  contextMessage: unknown,
): unknown[] {
  if (contextMessage === undefined) {
    return messages;
  }
  const index = messages.indexOf(contextMessage);
  if (index < 0) {
    return messages;
  }
  return [...messages.slice(0, index), ...messages.slice(index + 1)];
}

async function handleSessionsList(params: Record<string, unknown>) {
  const rt = await getRuntime();
  const cfg = rt.getRuntimeConfig();
  const opts = params as SessionsListParams;
  const { storePath, store } = rt.loadCombinedSessionStoreForGateway(cfg, {
    agentId: opts.agentId,
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
    p: params as SessionsResolveParams,
  });
  if (!resolved.ok) {
    throw new Error(resolved.error.message);
  }
  if ("missing" in resolved) {
    return { ok: false };
  }
  return { ok: true, key: resolved.key };
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

  const sessionLoadOptions = requestedAgentId ? { agentId: requestedAgentId } : undefined;
  const { cfg, storePath, entry } = rt.loadSessionEntry(sessionKey, sessionLoadOptions);
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
  const rawHistoryWindowMessages = max * 20 + 20;
  const maxHistoryBytes = rt.getMaxChatHistoryMessagesBytes();
  const sessionEntry =
    typeof entry?.sessionId === "string"
      ? {
          sessionId: entry.sessionId,
          ...(typeof entry.sessionFile === "string" ? { sessionFile: entry.sessionFile } : {}),
        }
      : undefined;

  const localMessages =
    params.offset === undefined && sessionId && storePath
      ? await rt.readSessionMessagesAsync(
          {
            agentId: sessionAgentId,
            sessionEntry,
            sessionId,
            sessionKey,
            storePath,
          },
          params.offset === undefined
            ? {
                mode: "recent",
                maxMessages: max,
                maxBytes: Math.max(maxHistoryBytes * 2, 1024 * 1024),
                allowResetArchiveFallback: true,
              }
            : {
                mode: "full",
                reason: "chat.history offset pagination",
                allowResetArchiveFallback: true,
              },
        )
      : [];
  const offsetPage =
    params.offset !== undefined && sessionId && storePath
      ? offset === 0
        ? await rt.readRecentSessionMessagesWithStatsAsync(
            {
              agentId: sessionAgentId,
              sessionEntry,
              sessionId,
              sessionKey,
              storePath,
            },
            {
              maxMessages: rawHistoryWindowMessages + 1,
              maxBytes: Math.max(maxHistoryBytes * 2, 1024 * 1024),
              allowResetArchiveFallback: true,
            },
          )
        : await rt.readSessionMessagesPageWithStatsAsync(
            {
              agentId: sessionAgentId,
              sessionEntry,
              sessionId,
              sessionKey,
              storePath,
            },
            {
              offset,
              maxMessages: max + 1,
              allowResetArchiveFallback: true,
            },
          )
      : undefined;

  const sessionStartedAt =
    typeof entry?.sessionStartedAt === "number" ? entry.sessionStartedAt : undefined;
  const offsetPageOverreadContextMessage =
    offsetPage !== undefined
      ? offset === 0
        ? offsetPage.messages.length > rawHistoryWindowMessages
          ? offsetPage.messages[0]
          : undefined
        : offsetPage.messages.length > max
          ? offsetPage.messages[0]
          : undefined
      : undefined;
  const localMessagesForHistory =
    offsetPage !== undefined
      ? dropChatHistoryOverreadContextMessage(
          rt.dropPreSessionStartAnnouncePairs(offsetPage.messages, sessionStartedAt),
          offsetPageOverreadContextMessage,
        )
      : localMessages;
  const rawMessages =
    params.offset === undefined
      ? rt.augmentChatHistoryWithCliSessionImports({
          entry,
          provider: resolvedSessionModel.provider,
          localMessages: localMessagesForHistory,
        })
      : localMessagesForHistory;
  const recencyFilteredMessages = rt.dropPreSessionStartAnnouncePairs(
    rawMessages,
    sessionStartedAt,
  );

  const effectiveMaxChars = rt.resolveEffectiveChatHistoryMaxChars(cfg);

  // Mirror Gateway chat.history trimming so embedded mode has the same byte ceilings.
  const projected =
    params.offset === undefined
      ? rt.projectRecentChatDisplayMessages(recencyFilteredMessages, {
          maxChars: effectiveMaxChars,
          maxMessages: max,
        })
      : offset === 0
        ? rt.projectRecentChatDisplayMessages(recencyFilteredMessages, {
            maxChars: effectiveMaxChars,
            maxMessages: max,
          })
        : rt.projectChatDisplayMessages(recencyFilteredMessages, { maxChars: effectiveMaxChars });
  const windowed =
    params.offset === undefined || offset === 0
      ? projected
      : capOffsetChatHistoryProjectedMessages(projected, max);
  const normalized = rt.augmentChatHistoryWithCanvasBlocks(windowed);

  const perMessageHardCap = Math.min(rt.CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxHistoryBytes);
  const replaced = rt.replaceOversizedChatHistoryMessages({
    messages: normalized,
    maxSingleMessageBytes: perMessageHardCap,
  });
  const capped = rt.capArrayByJsonBytes(replaced.messages, maxHistoryBytes).items;
  const bounded = rt.enforceChatHistoryFinalBudget({ messages: capped, maxBytes: maxHistoryBytes });
  const nextOffset =
    offsetPage !== undefined
      ? resolveChatHistoryNextOffset({
          messages: bounded.messages,
          totalMessages: offsetPage.totalMessages,
          offset,
          rawPageMessages:
            offset === 0
              ? offsetPage.messages.length
              : Math.min(max, Math.max(0, offsetPage.totalMessages - offset)),
        })
      : 0;
  const hasMore = offsetPage !== undefined ? nextOffset < offsetPage.totalMessages : false;

  return {
    sessionKey,
    sessionId,
    messages: bounded.messages,
    ...(params.offset !== undefined
      ? { offset, hasMore, totalMessages: offsetPage?.totalMessages ?? projected.length }
      : {}),
    ...(hasMore && offsetPage !== undefined ? { nextOffset } : {}),
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
      case "chat.history":
        return (await handleChatHistory(params)) as T;
      default:
        throw new Error(
          `Method "${method}" requires a running gateway (unavailable in local embedded mode).`,
        );
    }
  };
}
