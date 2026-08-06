/**
 * Embedded-mode Gateway method stub.
 *
 * Implements only the Gateway calls needed by session tools and rejects unsupported methods.
 */
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
import {
  normalizeFastMode,
  type FastMode,
} from "@openclaw/normalization-core/string-coerce";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { readPositiveIntegerParam } from "./common.js";

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
  const maxHistoryBytes = rt.getMaxChatHistoryMessagesBytes();
  const sessionEntry =
    typeof entry?.sessionId === "string"
      ? {
          sessionId: entry.sessionId,
          ...(typeof entry.sessionFile === "string" ? { sessionFile: entry.sessionFile } : {}),
        }
      : undefined;

  const localMessages =
    sessionId && storePath
      ? await rt.readSessionMessagesAsync(
          {
            agentId: sessionAgentId,
            sessionEntry,
            sessionId,
            sessionKey,
            storePath,
          },
          {
            mode: "recent",
            maxMessages: max,
            maxBytes: Math.max(maxHistoryBytes * 2, 1024 * 1024),
            allowResetArchiveFallback: true,
          },
        )
      : [];

  const rawMessages = rt.augmentChatHistoryWithCliSessionImports({
    entry,
    provider: resolvedSessionModel.provider,
    localMessages,
  });

  const effectiveMaxChars = rt.resolveEffectiveChatHistoryMaxChars(cfg);

  // Mirror Gateway chat.history trimming so embedded mode has the same byte ceilings.
  const normalized = rt.augmentChatHistoryWithCanvasBlocks(
    rt.projectRecentChatDisplayMessages(rawMessages, {
      maxChars: effectiveMaxChars,
      maxMessages: max,
    }),
  );

  const perMessageHardCap = Math.min(rt.CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxHistoryBytes);
  const replaced = rt.replaceOversizedChatHistoryMessages({
    messages: normalized,
    maxSingleMessageBytes: perMessageHardCap,
  });
  const capped = rt.capArrayByJsonBytes(replaced.messages, maxHistoryBytes).items;
  const bounded = rt.enforceChatHistoryFinalBudget({ messages: capped, maxBytes: maxHistoryBytes });

  return {
    sessionKey,
    sessionId,
    messages: bounded.messages,
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
