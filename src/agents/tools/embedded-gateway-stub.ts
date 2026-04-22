import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CallGatewayOptions } from "../../gateway/call.js";
import type { SessionsListParams, SessionsResolveParams } from "../../gateway/protocol/index.js";
import type { SessionsListResult } from "../../gateway/session-utils.types.js";
import type { SessionsResolveResult } from "../../gateway/sessions-resolve.js";

type EmbeddedCallGateway = <T = Record<string, unknown>>(opts: CallGatewayOptions) => Promise<T>;

interface EmbeddedGatewayRuntime {
  resolveSessionAgentId: (opts: { sessionKey: string; config: OpenClawConfig }) => string;
  loadConfig: () => OpenClawConfig;
  stripEnvelopeFromMessages: (msgs: unknown[]) => unknown[];
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
  sanitizeChatHistoryMessages: (msgs: unknown[], maxChars: number) => unknown[];
  capArrayByJsonBytes: (items: unknown[], maxBytes: number) => { items: unknown[] };
  listSessionsFromStore: (opts: {
    cfg: OpenClawConfig;
    storePath: string;
    store: unknown;
    opts: SessionsListParams;
  }) => SessionsListResult;
  loadCombinedSessionStoreForGateway: (cfg: OpenClawConfig) => {
    storePath: string;
    store: unknown;
  };
  resolveSessionKeyFromResolveParams: (opts: {
    cfg: OpenClawConfig;
    p: SessionsResolveParams;
  }) => Promise<SessionsResolveResult>;
  loadSessionEntry: (sessionKey: string) => {
    cfg: OpenClawConfig;
    storePath: string | undefined;
    entry: Record<string, unknown> | undefined;
  };
  readSessionMessages: (sessionId: string, storePath: string, sessionFile?: string) => unknown[];
  resolveSessionModelRef: (
    cfg: OpenClawConfig,
    entry: unknown,
    sessionAgentId: string,
  ) => { provider: string | undefined };
}

let runtimeMod: EmbeddedGatewayRuntime | undefined;

async function getRuntime(): Promise<EmbeddedGatewayRuntime> {
  if (!runtimeMod) {
    const modPath = [".", "embedded-gateway-stub.runtime.js"].join("/");
    runtimeMod = (await import(modPath)) as EmbeddedGatewayRuntime;
  }
  return runtimeMod;
}

async function handleSessionsList(params: Record<string, unknown>) {
  const rt = await getRuntime();
  const cfg = rt.loadConfig();
  const { storePath, store } = rt.loadCombinedSessionStoreForGateway(cfg);
  return rt.listSessionsFromStore({
    cfg,
    storePath,
    store,
    opts: params as SessionsListParams,
  });
}

async function handleSessionsResolve(params: Record<string, unknown>) {
  const rt = await getRuntime();
  const cfg = rt.loadConfig();
  const resolved = await rt.resolveSessionKeyFromResolveParams({
    cfg,
    p: params as SessionsResolveParams,
  });
  if (!resolved.ok) {
    throw new Error(resolved.error.message);
  }
  return { ok: true, key: resolved.key };
}

async function handleChatHistory(params: Record<string, unknown>): Promise<{
  sessionKey: string;
  sessionId: string | undefined;
  messages: unknown[];
  thinkingLevel?: string;
  fastMode?: boolean;
  verboseLevel?: string;
}> {
  const rt = await getRuntime();

  const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey : "";
  const limit = typeof params.limit === "number" ? params.limit : undefined;

  const { cfg, storePath, entry } = rt.loadSessionEntry(sessionKey);
  const sessionId = entry?.sessionId as string | undefined;
  const sessionAgentId = rt.resolveSessionAgentId({ sessionKey, config: cfg });
  const resolvedSessionModel = rt.resolveSessionModelRef(cfg, entry, sessionAgentId);

  const localMessages =
    sessionId && storePath
      ? rt.readSessionMessages(sessionId, storePath, entry?.sessionFile as string | undefined)
      : [];

  const rawMessages = rt.augmentChatHistoryWithCliSessionImports({
    entry,
    provider: resolvedSessionModel.provider,
    localMessages,
  });

  const hardMax = 1000;
  const defaultLimit = 200;
  const requested = typeof limit === "number" ? limit : defaultLimit;
  const max = Math.min(hardMax, requested);
  const effectiveMaxChars = rt.resolveEffectiveChatHistoryMaxChars(cfg);

  const sliced = rawMessages.length > max ? rawMessages.slice(-max) : rawMessages;
  const sanitized = rt.stripEnvelopeFromMessages(sliced);
  const normalized = rt.augmentChatHistoryWithCanvasBlocks(
    rt.sanitizeChatHistoryMessages(sanitized, effectiveMaxChars),
  );

  const maxHistoryBytes = rt.getMaxChatHistoryMessagesBytes();
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
    fastMode: entry?.fastMode as boolean | undefined,
    verboseLevel: entry?.verboseLevel as string | undefined,
  };
}

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
