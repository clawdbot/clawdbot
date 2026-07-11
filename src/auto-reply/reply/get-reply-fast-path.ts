// Runs lightweight get-reply fast-path commands before full agent setup.
import crypto from "node:crypto";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType } from "../../channels/chat-type.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { loadSessionEntry, listSessionEntries } from "../../config/sessions/session-accessor.js";
import { resolveSessionKey } from "../../config/sessions/session-key.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/sqlite-marker.js";
import type { SessionEntry, SessionScope } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_RESET_MESSAGE,
  ModelSelectionLockedError,
} from "../../sessions/model-overrides.js";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import { normalizeCommandBody } from "../commands-registry.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import { isFormattedGoalContinuationPrompt } from "./commands-goal.js";
import { parseSoftResetCommand } from "./commands-reset-mode.js";
import type { CommandContext } from "./commands-types.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
import { createReplySessionEntryHandle } from "./session-entry-handle.js";
import type { SessionInitResult } from "./session.js";

// Reply completeness is process-local metadata. Keep it off config objects so
// frozen runtime snapshots and identity-keyed caches remain valid.
const replyConfigRuntimeModes = new WeakMap<OpenClawConfig, "fast" | "full">();

function isSlowReplyTestAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.OPENCLAW_ALLOW_SLOW_REPLY_TESTS === "1" || env.OPENCLAW_STRICT_FAST_REPLY_CONFIG === "0"
  );
}

function resolveFastSessionKey(params: {
  ctx: MsgContext;
  sessionScope: SessionScope;
  mainKey?: string;
}): string {
  const { ctx } = params;
  const nativeCommandTarget = resolveCommandTurnTargetSessionKey(ctx) ?? "";
  if (nativeCommandTarget) {
    return nativeCommandTarget;
  }
  return resolveSessionKey(params.sessionScope, ctx, params.mainKey);
}

export function markCompleteReplyConfig<T extends OpenClawConfig>(
  config: T,
  options?: { runtimeMode?: "fast" | "full" },
): T {
  replyConfigRuntimeModes.set(config, options?.runtimeMode ?? "fast");
  return config;
}

export function withFastReplyConfig<T extends OpenClawConfig>(config: T): T {
  return markCompleteReplyConfig(config, { runtimeMode: "fast" });
}

export function withFullRuntimeReplyConfig<T extends OpenClawConfig>(config: T): T {
  return markCompleteReplyConfig(config, { runtimeMode: "full" });
}

function isCompleteReplyConfig(config: unknown): config is OpenClawConfig {
  return Boolean(
    config && typeof config === "object" && replyConfigRuntimeModes.has(config as OpenClawConfig),
  );
}

function usesFullReplyRuntime(config: unknown): boolean {
  return Boolean(
    config &&
    typeof config === "object" &&
    replyConfigRuntimeModes.get(config as OpenClawConfig) === "full",
  );
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
  });
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const sessionStore: Record<string, SessionEntry> = Object.fromEntries(
    listSessionEntries({ storePath }).map(({ sessionKey: entryKey, entry }) => [entryKey, entry]),
  );
  const existingEntry = loadSessionEntry({ storePath, sessionKey });
  const commandSource = ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "";
  const triggerBodyNormalized = isFormattedGoalContinuationPrompt(commandSource)
    ? commandSource.trim()
    : stripStructuralPrefixes(commandSource).trim();
  const normalizedChatType = normalizeChatType(ctx.ChatType);
  const isGroup = normalizedChatType != null && normalizedChatType !== "direct";
  const strippedForReset = isGroup
    ? stripMentions(triggerBodyNormalized, ctx, cfg, agentId)
    : triggerBodyNormalized;
  const normalizedResetBody = normalizeCommandBody(strippedForReset, {
    botUsername: ctx.BotUsername,
  });
  const softReset = parseSoftResetCommand(normalizedResetBody);
  const resetMatch = normalizedResetBody.match(/^\/(new|reset)(?:\s|$)/i);
  const resetTriggered = Boolean(resetMatch) && !softReset.matched;
  if (resetTriggered && isModelSelectionLocked(existingEntry)) {
    throw new ModelSelectionLockedError(MODEL_SELECTION_LOCKED_RESET_MESSAGE);
  }
  const previousSessionEntry = resetTriggered && existingEntry ? { ...existingEntry } : undefined;
  const sessionId =
    !resetTriggered && existingEntry ? existingEntry.sessionId : crypto.randomUUID();
  const bodyStripped = resetTriggered
    ? normalizedResetBody.slice(resetMatch?.[0].length ?? 0).trimStart()
    : (ctx.BodyForAgent ?? ctx.Body ?? "");
  const now = Date.now();
  const sessionFile =
    !resetTriggered && existingEntry?.sessionFile
      ? existingEntry.sessionFile
      : formatSqliteSessionFileMarker({ agentId, sessionId, storePath });
  const sessionEntry: SessionEntry = {
    ...(!resetTriggered ? existingEntry : undefined),
    sessionId,
    sessionFile,
    updatedAt: now,
    sessionStartedAt: resetTriggered ? now : (existingEntry?.sessionStartedAt ?? now),
    lastInteractionAt: now,
    thinkingLevel: resetTriggered ? existingEntry?.thinkingLevel : existingEntry?.thinkingLevel,
    verboseLevel: resetTriggered ? existingEntry?.verboseLevel : existingEntry?.verboseLevel,
    reasoningLevel: resetTriggered ? existingEntry?.reasoningLevel : existingEntry?.reasoningLevel,
    ttsAuto: resetTriggered ? existingEntry?.ttsAuto : existingEntry?.ttsAuto,
    responseUsage: existingEntry?.responseUsage,
    modelOverride: resetTriggered ? existingEntry?.modelOverride : existingEntry?.modelOverride,
    providerOverride: resetTriggered
      ? existingEntry?.providerOverride
      : existingEntry?.providerOverride,
    authProfileOverride: resetTriggered
      ? existingEntry?.authProfileOverride
      : existingEntry?.authProfileOverride,
    authProfileOverrideSource: resetTriggered
      ? existingEntry?.authProfileOverrideSource
      : existingEntry?.authProfileOverrideSource,
    authProfileOverrideCompactionCount: resetTriggered
      ? existingEntry?.authProfileOverrideCompactionCount
      : existingEntry?.authProfileOverrideCompactionCount,
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
