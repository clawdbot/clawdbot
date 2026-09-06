// Runs lightweight get-reply fast-path commands before full agent setup.
import crypto from "node:crypto";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveSessionParentSessionKey } from "../../channels/plugins/session-conversation.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { resolveResetPreservedSelection } from "../../config/sessions/reset-preserved-selection.js";
import { loadReplySessionInitializationSnapshot } from "../../config/sessions/session-accessor.js";
import { buildSessionCreationStamp } from "../../config/sessions/session-entry-provenance.js";
import { resolveSessionKey } from "../../config/sessions/session-key.js";
import {
  DEFAULT_RESET_TRIGGERS,
  type SessionEntry,
  type SessionScope,
} from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isVitestRuntimeEnv } from "../../infra/env.js";
import {
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_RESET_MESSAGE,
  ModelSelectionLockedError,
} from "../../sessions/model-overrides.js";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import { normalizeCommandBody } from "../commands-registry.js";
import type {
  FinalizedRuntimeMsgContext as MsgContext,
  FinalizedTemplateContext as TemplateContext,
} from "../templating.js";
import { isFormattedGoalContinuationPrompt } from "./commands-goal.js";
import type { CommandContext } from "./commands-types.js";
import { stripMentions } from "./mentions.js";
import {
  isCompleteReplyConfig,
  markReplyConfigRuntimeMode,
  usesFullReplyRuntime,
} from "./reply-config-runtime-mode.js";
import { createReplySessionEntryHandle } from "./session-entry-handle.js";
import { resolveSessionResetCommand } from "./session-reset-command.js";
import type { SessionInitResult } from "./session.js";

function isSlowReplyTestAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    (isVitestRuntimeEnv(env) && env.OPENCLAW_ALLOW_SLOW_REPLY_TESTS === "1") ||
    env.OPENCLAW_STRICT_FAST_REPLY_CONFIG === "0"
  );
}

function resolveFastSessionKey(params: {
  ctx: MsgContext;
  sessionScope: SessionScope;
  mainKey?: string;
  agentId: string;
}): string {
  const { ctx } = params;
  const nativeCommandTarget = resolveCommandTurnTargetSessionKey(ctx) ?? "";
  if (nativeCommandTarget) {
    return nativeCommandTarget;
  }
  return resolveSessionKey(params.sessionScope, ctx, params.mainKey, params.agentId);
}

export function withFullRuntimeReplyConfig<T extends OpenClawConfig>(config: T): T {
  return markReplyConfigRuntimeMode(config, "full");
}

export function resolveGetReplyConfig(params: {
  getRuntimeConfig: () => OpenClawConfig;
  isFastTestEnv: boolean;
  configOverride?: OpenClawConfig;
}): OpenClawConfig {
  const { configOverride } = params;
  if (configOverride == null) {
    return params.getRuntimeConfig();
  }
  if (params.isFastTestEnv && !isCompleteReplyConfig(configOverride) && !isSlowReplyTestAllowed()) {
    throw new Error(
      "Fast reply tests must pass with withFastReplyConfig()/markCompleteReplyConfig(); set OPENCLAW_ALLOW_SLOW_REPLY_TESTS=1 to opt out.",
    );
  }
  if (params.isFastTestEnv && isCompleteReplyConfig(configOverride)) {
    return configOverride;
  }
  if (isCompleteReplyConfig(configOverride)) {
    return configOverride;
  }
  return applyMergePatch(params.getRuntimeConfig(), configOverride) as OpenClawConfig;
}

export function shouldUseReplyFastTestBootstrap(params: {
  isFastTestEnv: boolean;
  configOverride?: OpenClawConfig;
}): boolean {
  return (
    params.isFastTestEnv &&
    isCompleteReplyConfig(params.configOverride) &&
    !usesFullReplyRuntime(params.configOverride)
  );
}

export function shouldUseReplyFastTestRuntime(params: {
  cfg: OpenClawConfig;
  isFastTestEnv: boolean;
}): boolean {
  return (
    params.isFastTestEnv && isCompleteReplyConfig(params.cfg) && !usesFullReplyRuntime(params.cfg)
  );
}

export function shouldUseReplyFastDirectiveExecution(params: {
  isFastTestBootstrap: boolean;
  isGroup: boolean;
  isHeartbeat: boolean;
  resetTriggered: boolean;
  triggerBodyNormalized: string;
}): boolean {
  if (
    !params.isFastTestBootstrap ||
    params.isGroup ||
    params.isHeartbeat ||
    params.resetTriggered
  ) {
    return false;
  }
  return !params.triggerBodyNormalized.includes("/");
}

export function buildFastReplyCommandContext(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  isGroup: boolean;
  triggerBodyNormalized: string;
  commandAuthorized: boolean;
}): CommandContext {
  const { ctx, cfg, agentId, sessionKey, isGroup, triggerBodyNormalized, commandAuthorized } =
    params;
  const originatingChannel = normalizeOptionalLowercaseString(ctx.OriginatingChannel);
  const surface = normalizeOptionalLowercaseString(ctx.Surface ?? ctx.Provider) ?? "";
  const channel =
    originatingChannel ?? normalizeOptionalLowercaseString(ctx.Provider ?? surface) ?? "";
  const from = normalizeOptionalString(ctx.From ?? ctx.SenderId);
  const to = normalizeOptionalString(ctx.To ?? ctx.OriginatingTo);
  return {
    surface,
    channel,
    channelId: normalizeAnyChannelId(channel) ?? normalizeAnyChannelId(surface) ?? undefined,
    accountId: normalizeOptionalString(ctx.AccountId),
    ownerList: [],
    senderIsOwner: false,
    isAuthorizedSender: commandAuthorized,
    senderId: from,
    abortKey: sessionKey ?? from ?? to,
    rawBodyNormalized: triggerBodyNormalized,
    commandBodyNormalized: normalizeCommandBody(
      isGroup ? stripMentions(triggerBodyNormalized, ctx, cfg, agentId) : triggerBodyNormalized,
      { botUsername: ctx.BotUsername },
    ),
    from,
    to,
  };
}

export function shouldHandleFastReplyTextCommands(params: {
  cfg: OpenClawConfig;
  commandSource?: string;
}): boolean {
  return params.commandSource === "native" || params.cfg.commands?.text !== false;
}

export function initFastReplySessionState(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId: string;
  commandAuthorized: boolean;
  workspaceDir: string;
}): SessionInitResult {
  const { ctx, cfg, agentId, commandAuthorized } = params;
  const sessionScope = cfg.session?.scope ?? "per-sender";
  const sessionKey = resolveFastSessionKey({
    ctx,
    sessionScope,
    mainKey: cfg.session?.mainKey,
    agentId,
  });
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  const relatedSessionKeys = [
    ctx.ParentSessionKey,
    ctx.ModelParentSessionKey,
    ctx.CommandTargetSessionKey,
    resolveSessionParentSessionKey(sessionKey),
  ].filter((key): key is string => typeof key === "string");
  const snapshot = loadReplySessionInitializationSnapshot({
    agentId,
    storePath,
    sessionKey,
    relatedSessionKeys,
  });
  const existingEntry = snapshot.currentEntry;
  const sessionStore: Record<string, SessionEntry> = {};
  for (const key of [...relatedSessionKeys, existingEntry?.parentSessionKey]) {
    const entry = key ? snapshot.readEntry(key) : undefined;
    if (key && entry) {
      sessionStore[key] = entry;
    }
  }
  const commandSource = ctx.commandText ?? "";
  const normalizedChatType = normalizeChatType(ctx.ChatType);
  const isGroup = normalizedChatType != null && normalizedChatType !== "direct";
  const resetCommand = resolveSessionResetCommand({
    commandText: commandSource,
    rawText: ctx.rawText,
    resetTriggers: cfg.session?.resetTriggers?.length
      ? cfg.session.resetTriggers
      : DEFAULT_RESET_TRIGGERS,
    ctx,
    cfg,
    agentId,
    isGroup,
    resetAuthorized: commandAuthorized,
  });
  const triggerBodyNormalized = isFormattedGoalContinuationPrompt(commandSource)
    ? commandSource.trim()
    : resetCommand.triggerBodyNormalized;
  const resetTriggered = resetCommand.matchedResetTriggerLower !== undefined;
  if (resetTriggered && isModelSelectionLocked(existingEntry)) {
    throw new ModelSelectionLockedError(MODEL_SELECTION_LOCKED_RESET_MESSAGE);
  }
  const previousSessionEntry = resetTriggered && existingEntry ? { ...existingEntry } : undefined;
  const sessionId =
    !resetTriggered && existingEntry ? existingEntry.sessionId : crypto.randomUUID();
  const bodyStripped = resetTriggered ? (resetCommand.payload ?? "") : (ctx.agentText ?? "");
  const now = Date.now();
  const resetPreservedSelection = resetTriggered
    ? resolveResetPreservedSelection({ entry: existingEntry })
    : {};
  const sessionEntry: SessionEntry = {
    ...(!resetTriggered ? existingEntry : undefined),
    sessionId,
    ...(!existingEntry && ctx.SessionCreation
      ? buildSessionCreationStamp(ctx.SessionCreation)
      : {}),
    ...(resetTriggered && existingEntry
      ? {
          previousSessionId: existingEntry.sessionId,
          spawnedBy: existingEntry.spawnedBy,
          spawnedWorkspaceDir: existingEntry.spawnedWorkspaceDir,
          spawnedCwd: existingEntry.spawnedCwd,
          parentSessionKey: existingEntry.parentSessionKey,
          parentSessionId: existingEntry.parentSessionId,
          forkedFromParent: existingEntry.forkedFromParent,
          forkSource: existingEntry.forkSource,
          createdVia: existingEntry.createdVia,
          createdActor: existingEntry.createdActor,
          createdAt: existingEntry.createdAt,
          ...(existingEntry.sandbox === "required" ? { sandbox: "required" as const } : {}),
          spawnDepth: existingEntry.spawnDepth,
          subagentRole: existingEntry.subagentRole,
          subagentControlScope: existingEntry.subagentControlScope,
        }
      : {}),
    ...resetPreservedSelection,
    updatedAt: now,
    sessionStartedAt: resetTriggered ? now : (existingEntry?.sessionStartedAt ?? now),
    lastInteractionAt: now,
    agentStatus: undefined,
    thinkingLevel: existingEntry?.thinkingLevel,
    verboseLevel: existingEntry?.verboseLevel,
    reasoningLevel: existingEntry?.reasoningLevel,
    ttsAuto: existingEntry?.ttsAuto,
    responseUsage: existingEntry?.responseUsage,
    ...(normalizedChatType ? { chatType: normalizedChatType } : {}),
    ...(normalizeOptionalString(ctx.Provider)
      ? { channel: normalizeOptionalString(ctx.Provider) }
      : {}),
    ...(normalizeOptionalString(ctx.GroupSubject)
      ? { subject: normalizeOptionalString(ctx.GroupSubject) }
      : {}),
    ...(normalizeOptionalString(ctx.GroupChannel)
      ? { groupChannel: normalizeOptionalString(ctx.GroupChannel) }
      : {}),
  };
  sessionStore[sessionKey] = sessionEntry;
  const sessionEntryHandle = createReplySessionEntryHandle({
    sessionEntry,
    sessionKey,
    sessionStore,
  });
  const sessionCtx: TemplateContext = {
    ...ctx,
    commandText: ctx.commandText ?? "",
    agentText: bodyStripped,
    rawText: ctx.rawText ?? "",
    SessionKey: sessionKey,
    CommandAuthorized: commandAuthorized,
    BodyStripped: bodyStripped,
    ...(normalizedChatType ? { ChatType: normalizedChatType } : {}),
  };
  return {
    sessionCtx,
    sessionEntry,
    initialSessionEntry: existingEntry ? { ...existingEntry } : undefined,
    sessionEntryHandle,
    sessionStore,
    sessionKey,
    sessionId,
    isNewSession: resetTriggered || !existingEntry,
    resetTriggered,
    systemSent: false,
    abortedLastRun: false,
    storePath,
    sessionScope,
    groupResolution: undefined,
    isGroup,
    bodyStripped,
    triggerBodyNormalized,
    previousSessionEntry,
  };
}
