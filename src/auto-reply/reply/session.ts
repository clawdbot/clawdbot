import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { ClawdbotConfig } from "../../config/config.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import {
  DEFAULT_RESET_TRIGGERS,
  deriveSessionMetaPatch,
  evaluateSessionFreshness,
  type GroupKeyResolution,
  loadSessionStore,
  resolveChannelResetConfig,
  resolveThreadFlag,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveGroupSessionKey,
  resolveSessionFilePath,
  resolveSessionKey,
  resolveSessionTranscriptPath,
  resolveStorePath,
  type SessionEntry,
  type SessionScope,
  updateSessionStore,
} from "../../config/sessions.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
import { formatInboundBodyWithSenderMeta } from "./inbound-sender-meta.js";
import { normalizeInboundTextNewlines } from "./inbound-text.js";
import { normalizeSessionDeliveryFields } from "../../utils/delivery-context.js";

export type SessionInitResult = {
  sessionCtx: TemplateContext;
  sessionEntry: SessionEntry;
  previousSessionEntry?: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  sessionId: string;
  isNewSession: boolean;
  resetTriggered: boolean;
  systemSent: boolean;
  abortedLastRun: boolean;
  storePath: string;
  sessionScope: SessionScope;
  groupResolution?: GroupKeyResolution;
  isGroup: boolean;
  bodyStripped?: string;
  triggerBodyNormalized: string;
};

function forkSessionFromParent(params: {
  parentEntry: SessionEntry;
}): { sessionId: string; sessionFile: string } | null {
  const parentSessionFile = resolveSessionFilePath(
    params.parentEntry.sessionId,
    params.parentEntry,
  );
  if (!parentSessionFile || !fs.existsSync(parentSessionFile)) return null;
  try {
    const manager = SessionManager.open(parentSessionFile);
    const leafId = manager.getLeafId();
    if (leafId) {
      const sessionFile = manager.createBranchedSession(leafId) ?? manager.getSessionFile();
      const sessionId = manager.getSessionId();
      if (sessionFile && sessionId) return { sessionId, sessionFile };
    }
    const sessionId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const fileTimestamp = timestamp.replace(/[:.]/g, "-");
    const sessionFile = path.join(manager.getSessionDir(), `${fileTimestamp}_${sessionId}.jsonl`);
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: sessionId,
      timestamp,
      cwd: manager.getCwd(),
      parentSession: parentSessionFile,
    };
    fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, "utf-8");
    return { sessionId, sessionFile };
  } catch {
    return null;
  }
}

export async function initSessionState(params: {
  ctx: MsgContext;
  cfg: ClawdbotConfig;
  commandAuthorized: boolean;
}): Promise<SessionInitResult> {
  const { ctx, cfg, commandAuthorized } = params;
  // Native slash commands (Telegram/Discord/Slack) are delivered on a separate
  // "slash session" key, but should mutate the target chat session.
  const targetSessionKey =
    ctx.CommandSource === "native" ? ctx.CommandTargetSessionKey?.trim() : undefined;
  const sessionCtxForState =
    targetSessionKey && targetSessionKey !== ctx.SessionKey
      ? { ...ctx, SessionKey: targetSessionKey }
      : ctx;
  const sessionCfg = cfg.session;
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);
  const agentId = resolveSessionAgentId({
    sessionKey: sessionCtxForState.SessionKey,
    config: cfg,
  });
  const groupResolution = resolveGroupSessionKey(sessionCtxForState) ?? undefined;
  const resetTriggers = sessionCfg?.resetTriggers?.length
    ? sessionCfg.resetTriggers
    : DEFAULT_RESET_TRIGGERS;
  const sessionScope = sessionCfg?.scope ?? "per-sender";
  const storePath = resolveStorePath(sessionCfg?.store, { agentId });

  const sessionStore: Record<string, SessionEntry> = loadSessionStore(storePath);
  let sessionKey: string | undefined;
  let sessionEntry: SessionEntry;

  let sessionId: string | undefined;
  let isNewSession = false;
  let bodyStripped: string | undefined;
  let systemSent = false;
  let abortedLastRun = false;
  let resetTriggered = false;

  let persistedThinking: string | undefined;
  let persistedVerbose: string | undefined;
  let persistedReasoning: string | undefined;
  let persistedTtsAuto: TtsAutoMode | undefined;
  let persistedModelOverride: string | undefined;
  let persistedProviderOverride: string | undefined;

  const normalizedChatType = normalizeChatType(ctx.ChatType);
  const isGroup =
    normalizedChatType != null && normalizedChatType !== "direct" ? true : Boolean(groupResolution);
  // Prefer CommandBody/RawBody (clean message) for command detection; fall back
  // to Body which may contain structural context (history, sender labels).
  const commandSource = ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "";
  // IMPORTANT: do NOT lowercase the entire command body.
  // Users often pass case-sensitive arguments (e.g. filesystem paths on Linux).
  // Command parsing downstream lowercases only the command token for matching.
  const triggerBodyNormalized = stripStructuralPrefixes(commandSource).trim();

  // Use CommandBody/RawBody for reset trigger matching (clean message without structural context).
  const rawBody = commandSource;
  const trimmedBody = rawBody.trim();
  const resetAuthorized = resolveCommandAuthorization({
    ctx,
    cfg,
    commandAuthorized,
  }).isAuthorizedSender;
  // Timestamp/message prefixes (e.g. "[Dec 4 17:35] ") are added by the
  // web inbox before we get here. They prevented reset triggers like "/new"
  // from matching, so strip structural wrappers when checking for resets.
  const strippedForReset = isGroup
    ? stripMentions(triggerBodyNormalized, ctx, cfg, agentId)
    : triggerBodyNormalized;

  // Reset triggers are configured as lowercased commands (e.g. "/new"), but users may type
  // "/NEW" etc. Match case-insensitively while keeping the original casing for any stripped body.
  const trimmedBodyLower = trimmedBody.toLowerCase();
  const strippedForResetLower = strippedForReset.toLowerCase();

  for (const trigger of resetTriggers) {
    if (!trigger) continue;
    if (!resetAuthorized) break;
    const triggerLower = trigger.toLowerCase();
    if (trimmedBodyLower === triggerLower || strippedForResetLower === triggerLower) {
      isNewSession = true;
      bodyStripped = "";
      resetTriggered = true;
      break;
    }
    const triggerPrefixLower = `${triggerLower} `;
    if (
      trimmedBodyLower.startsWith(triggerPrefixLower) ||
      strippedForResetLower.startsWith(triggerPrefixLower)
    ) {
      isNewSession = true;
      bodyStripped = strippedForReset.slice(trigger.length).trimStart();
      resetTriggered = true;
      break;
    }
  }

  sessionKey = resolveSessionKey(sessionScope, sessionCtxForState, mainKey);
  const entry = sessionStore[sessionKey];
  const previousSessionEntry = resetTriggered && entry ? { ...entry } : undefined;
  const now = Date.now();
  const isThread = resolveThreadFlag({
    sessionKey,
    messageThreadId: ctx.MessageThreadId,
    threadLabel: ctx.ThreadLabel,
    threadStarterBody: ctx.ThreadStarterBody,
    parentSessionKey: ctx.ParentSessionKey,
  });
  const resetType = resolveSessionResetType({ sessionKey, isGroup, isThread });
  const channelReset = resolveChannelResetConfig({
    sessionCfg,
    channel:
      groupResolution?.channel ??
      (ctx.OriginatingChannel as string | undefined) ??
      ctx.Surface ??
      ctx.Provider,
  });
  const resetPolicy = resolveSessionResetPolicy({
    sessionCfg,
    resetType,
    resetOverride: channelReset,
  });
  const freshEntry = entry
    ? evaluateSessionFreshness({ updatedAt: entry.updatedAt, now, policy: resetPolicy }).fresh
    : false;

  if (!isNewSession && freshEntry) {
    sessionId = entry.sessionId;
    systemSent = entry.systemSent ?? false;
    abortedLastRun = entry.abortedLastRun ?? false;
    persistedThinking = entry.thinkingLevel;
    persistedVerbose = entry.verboseLevel;
    persistedReasoning = entry.reasoningLevel;
    persistedTtsAuto = entry.ttsAuto;
    persistedModelOverride = entry.modelOverride;
    persistedProviderOverride = entry.providerOverride;
  } else {
    sessionId = crypto.randomUUID();
    isNewSession = true;
    systemSent = false;
    abortedLastRun = false;
  }

  const baseEntry = !isNewSession && freshEntry ? entry : undefined;
  // Track the originating channel/to for announce routing (subagent announce-back).
  const lastChannelRaw = (ctx.OriginatingChannel as string | undefined) || baseEntry?.lastChannel;
  const lastToRaw = (ctx.OriginatingTo as string | undefined) || ctx.To || baseEntry?.lastTo;
  const lastAccountIdRaw = (ctx.AccountId as string | undefined) || baseEntry?.lastAccountId;
  const lastThreadIdRaw =
    (ctx.MessageThreadId as string | number | undefined) || baseEntry?.lastThreadId;
  const deliveryFields = normalizeSessionDeliveryFields({
    deliveryContext: {
      channel: lastChannelRaw,
      to: lastToRaw,
      accountId: lastAccountIdRaw,
      threadId: lastThreadIdRaw,
    },
  });
  const lastChannel = deliveryFields.lastChannel ?? lastChannelRaw;
  const lastTo = deliveryFields.lastTo ?? lastToRaw;
  const lastAccountId = deliveryFields.lastAccountId ?? lastAccountIdRaw;
  const lastThreadId = deliveryFields.lastThreadId ?? lastThreadIdRaw;
  sessionEntry = {
    ...baseEntry,
    sessionId,
    updatedAt: Date.now(),
    systemSent,
    abortedLastRun,
    // Persist previously stored thinking/verbose levels when present.
    thinkingLevel: persistedThinking ?? baseEntry?.thinkingLevel,
    verboseLevel: persistedVerbose ?? baseEntry?.verboseLevel,
    reasoningLevel: persistedReasoning ?? baseEntry?.reasoningLevel,
    ttsAuto: persistedTtsAuto ?? baseEntry?.ttsAuto,
    responseUsage: baseEntry?.responseUsage,
    modelOverride: persistedModelOverride ?? baseEntry?.modelOverride,
    providerOverride: persistedProviderOverride ?? baseEntry?.providerOverride,
    sendPolicy: baseEntry?.sendPolicy,
    queueMode: baseEntry?.queueMode,
    queueDebounceMs: baseEntry?.queueDebounceMs,
    queueCap: baseEntry?.queueCap,
    queueDrop: baseEntry?.queueDrop,
    displayName: baseEntry?.displayName,
    chatType: baseEntry?.chatType,
    channel: baseEntry?.channel,
    groupId: baseEntry?.groupId,
    subject: baseEntry?.subject,
    groupChannel: baseEntry?.groupChannel,
    space: baseEntry?.space,
    deliveryContext: deliveryFields.deliveryContext,
    // Track originating channel for subagent announce routing.
    lastChannel,
    lastTo,
    lastAccountId,
    lastThreadId,
  };
  const metaPatch = deriveSessionMetaPatch({
    ctx: sessionCtxForState,
    sessionKey,
    existing: sessionEntry,
    groupResolution,
  });
  if (metaPatch) {
    sessionEntry = { ...sessionEntry, ...metaPatch };
  }
  if (!sessionEntry.chatType) {
    sessionEntry.chatType = "direct";
  }
  const threadLabel = ctx.ThreadLabel?.trim();
  if (threadLabel) {
    sessionEntry.displayName = threadLabel;
  }
  const parentSessionKey = ctx.ParentSessionKey?.trim();
  if (
    isNewSession &&
    parentSessionKey &&
    parentSessionKey !== sessionKey &&
    sessionStore[parentSessionKey]
  ) {
    const forked = forkSessionFromParent({
      parentEntry: sessionStore[parentSessionKey],
    });
    if (forked) {
      sessionId = forked.sessionId;
      sessionEntry.sessionId = forked.sessionId;
      sessionEntry.sessionFile = forked.sessionFile;
    }
  }
  if (!sessionEntry.sessionFile) {
    sessionEntry.sessionFile = resolveSessionTranscriptPath(
      sessionEntry.sessionId,
      agentId,
      ctx.MessageThreadId,
    );
  }
  if (isNewSession) {
    sessionEntry.compactionCount = 0;
    sessionEntry.memoryFlushCompactionCount = undefined;
    sessionEntry.memoryFlushAt = undefined;
  }
  // Preserve per-session overrides while resetting compaction state on /new.
  sessionStore[sessionKey] = { ...sessionStore[sessionKey], ...sessionEntry };
  await updateSessionStore(storePath, (store) => {
    // Preserve per-session overrides while resetting compaction state on /new.
    store[sessionKey] = { ...store[sessionKey], ...sessionEntry };
  });

  const sessionCtx: TemplateContext = {
    ...ctx,
    // Keep BodyStripped aligned with Body (best default for agent prompts).
    // RawBody is reserved for command/directive parsing and may omit context.
    BodyStripped: formatInboundBodyWithSenderMeta({
      ctx,
      body: normalizeInboundTextNewlines(
        bodyStripped ??
          ctx.BodyForAgent ??
          ctx.Body ??
          ctx.CommandBody ??
          ctx.RawBody ??
          ctx.BodyForCommands ??
          "",
      ),
    }),
    SessionId: sessionId,
    IsNewSession: isNewSession ? "true" : "false",
  };

  return {
    sessionCtx,
    sessionEntry,
    previousSessionEntry,
    sessionStore,
    sessionKey,
    sessionId: sessionId ?? crypto.randomUUID(),
    isNewSession,
    resetTriggered,
    systemSent,
    abortedLastRun,
    storePath,
    sessionScope,
    groupResolution,
    isGroup,
    bodyStripped,
    triggerBodyNormalized,
  };
}
