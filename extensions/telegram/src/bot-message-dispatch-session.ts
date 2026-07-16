// Telegram plugin module owns dispatch-time session and transcript access.
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  appendAssistantMirrorMessageByIdentity,
  readLatestAssistantTextByIdentity,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { resolveTelegramConfigReasoningDefault } from "./agent-config.js";
import type { TelegramBotDeps } from "./bot-deps.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import { getSessionEntry } from "./bot-message-dispatch.runtime.js";
import type {
  CurrentTurnTranscriptFinal,
  FreshTelegramSessionEntryLoader,
  TelegramReasoningLevel,
  TelegramScopedTranscriptSession,
  TelegramTranscriptMirrorPayload,
} from "./bot-message-dispatch.types.js";

export function createFreshTelegramSessionEntryLoader(params: {
  cfg: OpenClawConfig;
  telegramDeps: TelegramBotDeps;
}): FreshTelegramSessionEntryLoader {
  const entriesByPathAndKey = new Map<string, ReturnType<typeof getSessionEntry>>();
  const load = ((agentId: string, sessionKey: string) => {
    const storePath = params.telegramDeps.resolveStorePath(params.cfg.session?.store, { agentId });
    const cacheKey = `${storePath}\0${sessionKey}`;
    if (entriesByPathAndKey.has(cacheKey)) {
      return { storePath, entry: entriesByPathAndKey.get(cacheKey) };
    }
    const entry = (params.telegramDeps.getSessionEntry ?? getSessionEntry)({
      storePath,
      sessionKey,
      readConsistency: "latest",
    });
    entriesByPathAndKey.set(cacheKey, entry);
    return { storePath, entry };
  }) as FreshTelegramSessionEntryLoader;
  load.clear = () => entriesByPathAndKey.clear();
  return load;
}

export function resolveTelegramReasoningLevel(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  agentId: string;
  loadFreshSessionEntry: FreshTelegramSessionEntryLoader;
}): TelegramReasoningLevel {
  const configDefault = resolveTelegramConfigReasoningDefault(params.cfg, params.agentId);
  if (!params.sessionKey) {
    return configDefault;
  }
  try {
    const { entry } = params.loadFreshSessionEntry(params.agentId, params.sessionKey);
    const level = entry?.reasoningLevel;
    return level === "on" || level === "stream" || level === "off" ? level : configDefault;
  } catch {
    return "off";
  }
}

function resolveTelegramMirroredTranscriptText(
  payload: TelegramTranscriptMirrorPayload,
): string | null {
  const mediaUrls = payload.mediaUrls?.filter((url) => url.trim()) ?? [];
  if (mediaUrls.length > 0) {
    return mediaUrls
      .map((url) => {
        const pathname = url.split("#")[0]?.split("?")[0] ?? url;
        const base = path.basename(pathname);
        return base && base !== "." && base !== "/" ? base : "media";
      })
      .join(", ");
  }
  return payload.text?.trim() || null;
}

function resolveTelegramScopedTranscriptSession(params: {
  agentId: string;
  loadFreshSessionEntry: FreshTelegramSessionEntryLoader;
  sessionKey: string;
}): TelegramScopedTranscriptSession | undefined {
  const { entry, storePath } = params.loadFreshSessionEntry(params.agentId, params.sessionKey);
  const sessionId = entry?.sessionId?.trim();
  return sessionId ? { sessionId, storePath } : undefined;
}

export async function mirrorTelegramAssistantReplyToTranscript(params: {
  cfg: OpenClawConfig;
  idempotencyKey: string;
  loadFreshSessionEntry: FreshTelegramSessionEntryLoader;
  route: TelegramMessageContext["route"];
  sessionKey: string;
  payload: TelegramTranscriptMirrorPayload;
}) {
  const text = resolveTelegramMirroredTranscriptText(params.payload);
  if (!text) {
    return;
  }
  const session = resolveTelegramScopedTranscriptSession({
    agentId: params.route.agentId,
    loadFreshSessionEntry: params.loadFreshSessionEntry,
    sessionKey: params.sessionKey,
  });
  if (!session) {
    return;
  }
  const appended = await appendAssistantMirrorMessageByIdentity({
    agentId: params.route.agentId,
    config: params.cfg,
    idempotencyKey: params.idempotencyKey,
    deliveryMirror: { kind: "channel-final", sourceMessageId: params.idempotencyKey },
    sessionId: session.sessionId,
    sessionKey: params.sessionKey,
    storePath: session.storePath,
    text,
  });
  if (!appended.ok && appended.code !== "session-rebound") {
    logVerbose(`telegram transcript mirror append failed: ${appended.reason}`);
  }
}

export function createCurrentTurnTranscriptFinalResolver(params: {
  agentId: string;
  dispatchStartedAt: number;
  loadFreshSessionEntry: FreshTelegramSessionEntryLoader;
  sessionKey?: string;
}): () => Promise<CurrentTurnTranscriptFinal | undefined> {
  return async () => {
    if (!params.sessionKey) {
      return undefined;
    }
    try {
      const { entry, storePath } = params.loadFreshSessionEntry(params.agentId, params.sessionKey);
      if (!entry?.sessionId) {
        return undefined;
      }
      const latest = await readLatestAssistantTextByIdentity({
        agentId: params.agentId,
        sessionId: entry.sessionId,
        sessionKey: params.sessionKey,
        storePath,
      });
      if (!latest?.timestamp || latest.timestamp < params.dispatchStartedAt) {
        return undefined;
      }
      return { ...(latest.id ? { messageId: latest.id } : {}), text: latest.text };
    } catch (err) {
      logVerbose(`telegram transcript final candidate lookup failed: ${formatErrorMessage(err)}`);
      return undefined;
    }
  };
}
