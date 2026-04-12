import crypto from "node:crypto";
import path from "node:path";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { clearBootstrapSnapshotOnSessionRollover } from "../../agents/bootstrap-cache.js";
import { resetRegisteredAgentHarnessSessions } from "../../agents/harness/registry.js";
import { disposeSessionMcpRuntime } from "../../agents/pi-bundle-mcp-tools.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import { canonicalizeMainSessionAlias } from "../../config/sessions/main-session.js";
import { deriveSessionMetaPatch } from "../../config/sessions/metadata.js";
import { resolveSessionTranscriptPath, resolveStorePath } from "../../config/sessions/paths.js";
import {
  evaluateSessionFreshness,
  resolveChannelResetConfig,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveThreadFlag,
  type SessionFreshness,
} from "../../config/sessions/reset.js";
import { resolveAndPersistSessionFile } from "../../config/sessions/session-file.js";
import { resolveSessionKey } from "../../config/sessions/session-key.js";
import { resolveMaintenanceConfigFromInput } from "../../config/sessions/store-maintenance.js";
import { loadSessionStore, updateSessionStore } from "../../config/sessions/store.js";
import { parseSessionThreadInfo } from "../../config/sessions/thread-info.js";
import {
  DEFAULT_RESET_TRIGGERS,
  type GroupKeyResolution,
  type SessionEntry,
  type SessionScope,
} from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { deliverSessionMaintenanceWarning } from "../../infra/session-maintenance-warning.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookSessionEndReason } from "../../plugins/hook-types.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import { isInterSessionInputProvenance } from "../../sessions/input-provenance.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { normalizeSessionDeliveryFields } from "../../utils/delivery-context.shared.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import { resolveConversationBindingContextFromMessage } from "./conversation-binding-input.js";
import { normalizeInboundTextNewlines } from "./inbound-text.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
import {
  maybeRetireLegacyMainDeliveryRoute,
  resolveLastChannelRaw,
  resolveLastToRaw,
} from "./session-delivery.js";
import { forkSessionFromParent, resolveParentForkMaxTokens } from "./session-fork.js";
import { buildSessionEndHookPayload, buildSessionStartHookPayload } from "./session-hooks.js";

const log = createSubsystemLogger("session-init");
let sessionArchiveRuntimePromise: Promise<
  typeof import("../../gateway/session-archive.runtime.js")
> | null = null;

function loadSessionArchiveRuntime() {
  sessionArchiveRuntimePromise ??= import("../../gateway/session-archive.runtime.js");
  return sessionArchiveRuntimePromise;
}

function resolveExplicitSessionEndReason(
  matchedResetTriggerLower?: string,
): PluginHookSessionEndReason {
  return matchedResetTriggerLower === "/reset" ? "reset" : "new";
}

function resolveSessionDefaultAccountId(params: {
  cfg: OpenClawConfig;
  channelRaw?: string;
  accountIdRaw?: string;
  persistedLastAccountId?: string;
}): string | undefined {
  const explicit = normalizeOptionalString(params.accountIdRaw);
  if (explicit) {
    return explicit;
  }
  const persisted = normalizeOptionalString(params.persistedLastAccountId);
  if (persisted) {
    return persisted;
  }
  const channel = normalizeOptionalLowercaseString(params.channelRaw);
  if (!channel) {
    return undefined;
  }
  const channels = params.cfg.channels as Record<string, { defaultAccount?: unknown } | undefined>;
  const configuredDefault = channels?.[channel]?.defaultAccount;
  return normalizeOptionalString(configuredDefault);
}

function resolveStaleSessionEndReason(params: {
  entry: SessionEntry | undefined;
  freshness?: SessionFreshness;
  now: number;
}): PluginHookSessionEndReason | undefined {
  if (!params.entry || !params.freshness) {
    return undefined;
  }
  const staleDaily =
    params.freshness.dailyResetAt != null && params.entry.updatedAt < params.freshness.dailyResetAt;
  const staleIdle =
    params.freshness.idleExpiresAt != null && params.now > params.freshness.idleExpiresAt;
  if (staleIdle) {
    return "idle";
  }
  if (staleDaily) {
    return "daily";
  }
  return undefined;
}

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

function isResetAuthorizedForContext(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  commandAuthorized: boolean;
}): boolean {
  const auth = resolveCommandAuthorization(params);
  if (!params.commandAuthorized && !auth.isAuthorizedSender) {
    return false;
  }
  const provider = params.ctx.Provider;
  const internalGatewayCaller = provider
    ? isInternalMessageChannel(provider)
    : isInternalMessageChannel(params.ctx.Surface);
  if (!internalGatewayCaller) {
    return true;
  }
  const scopes = params.ctx.GatewayClientScopes;
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return true;
  }
  return scopes.includes("operator.admin");
}

function resolveSessionConversationBindingContext(
  cfg: OpenClawConfig,
  ctx: MsgContext,
): {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
} | null {
  const bindingContext = resolveConversationBindingContextFromMessage({
    cfg,
    ctx,
  });
  if (!bindingContext) {
    return null;
  }
  return {
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
    conversationId: bindingContext.conversationId,
    ...(bindingContext.parentConversationId
      ? { parentConversationId: bindingContext.parentConversationId }
      : {}),
  };
}

function resolveBoundConversationSessionKey(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  bindingContext?: {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
  } | null;
}): string | undefined {
  const bindingContext =
    params.bindingContext ?? resolveSessionConversationBindingContext(params.cfg, params.ctx);
  if (!bindingContext) {
    return undefined;
  }
  const binding = getSessionBindingService().resolveByConversation({
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
    conversationId: bindingContext.conversationId,
    ...(bindingContext.parentConversationId
      ? { parentConversationId: bindingContext.parentConversationId }
      : {}),
  });
  if (!binding?.targetSessionKey) {
    return undefined;
  }
  getSessionBindingService().touch(binding.bindingId);
  return binding.targetSessionKey;
}

export async function initSessionState(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  commandAuthorized: boolean;
}): Promise<SessionInitResult> {
  const { ctx, cfg, commandAuthorized } = params;
  const conversationBindingContext = resolveSessionConversationBindingContext(cfg, ctx);
  // Native slash commands (Telegram/Discord/Slack) are delivered on a separate
  // "slash session" key, but should mutate the target chat session.
  const commandTargetSessionKey =
    ctx.CommandSource === "native"
      ? normalizeOptionalString(ctx.CommandTargetSessionKey)
      : undefined;
  // Native slash/menu commands can arrive on a transport-specific "slash session"
  // while explicitly targeting an existing chat session. Honor that explicit target
  // before any binding lookup so command-side mutations land on the intended session.
  const targetSessionKey =
    commandTargetSessionKey ??
    resolveBoundConversationSessionKey({
      cfg,
      ctx,
      bindingContext: conversationBindingContext,
    });
  const sessionCtxForState =
    targetSessionKey && targetSessionKey !== ctx.SessionKey
      ? { ...ctx, SessionKey: targetSessionKey }
      : ctx;
  const sessionCfg = cfg.session;
  const maintenanceConfig = resolveMaintenanceConfigFromInput(sessionCfg?.maintenance);
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);
  const agentId = resolveSessionAgentId({
    sessionKey: sessionCtxForState.SessionKey,
    config: cfg,
  });
  const groupResolution = resolveGroupSessionKey(sessionCtxForState) ?? undefined;
  const resetTriggers = sessionCfg?.resetTriggers?.length
    ? sessionCfg.resetTriggers
    : DEFAULT_RESET_TRIGGERS;
  const parentForkMaxTokens = resolveParentForkMaxTokens(cfg);
  const sessionScope = sessionCfg?.scope ?? "per-sender";
  const storePath = resolveStorePath(sessionCfg?.store, { agentId });
  const ingressTimingEnabled = process.env.OPENCLAW_DEBUG_INGRESS_TIMING === "1";

  // CRITICAL: Skip cache to ensure fresh data when resolving session identity.
  // Stale cache (especially with multiple gateway processes or on Windows where
  // mtime granularity may miss rapid writes) can cause incorrect sessionId
  // generation, leading to orphaned transcript files. See #17971.
  const sessionStoreLoadStartMs = ingressTimingEnabled ? Date.now() : 0;
  const sessionStore: Record<string, SessionEntry> = loadSessionStore(storePath, {
    skipCache: true,
  });
  if (ingressTimingEnabled) {
    log.info(
      `session-init store-load agent=${agentId} session=${sessionCtxForState.SessionKey ?? "(no-session)"} ` +
        `elapsedMs=${Date.now() - sessionStoreLoadStartMs} path=${storePath}`,
    );
  }
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
  let persistedAuthProfileOverride: string | undefined;
  let persistedAuthProfileOverrideSource: SessionEntry["authProfileOverrideSource"];
  let persistedAuthProfileOverrideCompactionCount: number | undefined;
  let persistedLabel: string | undefined;
  let persistedSpawnedBy: SessionEntry["spawnedBy"];
  let persistedSpawnedWorkspaceDir: SessionEntry["spawnedWorkspaceDir"];
  let persistedParentSessionKey: SessionEntry["parentSessionKey"];
  let persistedForkedFromParent: SessionEntry["forkedFromParent"];
  let persistedSpawnDepth: SessionEntry["spawnDepth"];
  let persistedSubagentRole: SessionEntry["subagentRole"];
  let persistedSubagentControlScope: SessionEntry["subagentControlScope"];
  let persistedDisplayName: SessionEntry["displayName"];

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
  const resetAuthorized = isResetAuthorizedForContext({
    ctx,
    cfg,
    commandAuthorized,
  });
  // Timestamp/message prefixes (e.g. "[Dec 4 17:35] ") are added by the
  // web inbox before we get here. They prevented reset triggers like "/new"
  // from matching, so strip structural wrappers when checking for resets.
  const strippedForReset = isGroup
    ? stripMentions(triggerBodyNormalized, ctx, cfg, agentId)
    : triggerBodyNormalized;
  // Reset triggers are configured as lowercased commands (e.g. "/new"), but users may type
  // "/NEW" etc. Match case-insensitively while keeping the original casing for any stripped body.
  const trimmedBodyLower = normalizeLowercaseStringOrEmpty(trimmedBody);
  const strippedForResetLower = normalizeLowercaseStringOrEmpty(strippedForReset);
  let matchedResetTriggerLower: string | undefined;

  for (const trigger of resetTriggers) {
    if (!trigger) {
      continue;
    }
    if (!resetAuthorized) {
      break;
    }
    const triggerLower = normalizeLowercaseStringOrEmpty(trigger);
    if (trimmedBodyLower === triggerLower || strippedForResetLower === triggerLower) {
      isNewSession = true;
      bodyStripped = "";
      resetTriggered = true;
      matchedResetTriggerLower = triggerLower;
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
      matchedResetTriggerLower = triggerLower;
      break;
    }
  }

  // Canonicalize so the written key matches what all read paths produce.
  // resolveSessionKey uses DEFAULT_AGENT_ID="main"; the configured default
  // agent may differ, causing key mismatch and orphaned sessions (#29683).
  sessionKey = canonicalizeMainSessionAlias({
    cfg,
    agentId,
    sessionKey: resolveSessionKey(sessionScope, sessionCtxForState, mainKey),
  });
  const retiredLegacyMainDelivery = maybeRetireLegacyMainDeliveryRoute({
    sessionCfg,
    sessionKey,
    sessionStore,
    agentId,
    mainKey,
    isGroup,
    ctx,
  });
  if (retiredLegacyMainDelivery) {
    sessionStore[retiredLegacyMainDelivery.key] = retiredLegacyMainDelivery.entry;
  }
  const entry = sessionStore[sessionKey];
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
  // Heartbeat, cron-event, and exec-event runs should NEVER trigger session resets.
  // These are automated system events, not user interactions that should affect
  // session continuity. Forcing freshEntry=true prevents accidental data loss.
  // See #58409 for details on silent session reset bug.
  const isSystemEvent =
    ctx.Provider === "heartbeat" || ctx.Provider === "cron-event" || ctx.Provider === "exec-event";
  const entryFreshness = entry
    ? isSystemEvent
      ? ({ fresh: true } satisfies SessionFreshness)
      : evaluateSessionFreshness({ updatedAt: entry.updatedAt, now, policy: resetPolicy })
    : undefined;
  const freshEntry = entryFreshness?.fresh ?? false;
  // Capture the current session entry before any reset so its transcript can be
  // archived afterward.  We need to do this for both explicit resets (/new, /reset)
  // and for scheduled/daily resets where the session has become stale (!freshEntry).
  // Without this, daily-reset transcripts are left as orphaned files on disk (#35481).
  const previousSessionEntry = (resetTriggered || !freshEntry) && entry ? { ...entry } : undefined;
  const previousSessionEndReason = resetTriggered
    ? resolveExplicitSessionEndReason(matchedResetTriggerLower)
    : resolveStaleSessionEndReason({
        entry,
        freshness: entryFreshness,
        now,
      });
  clearBootstrapSnapshotOnSessionRollover({
    sessionKey,
    previousSessionId: previousSessionEntry?.sessionId,
  });

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
    persistedAuthProfileOverride = entry.authProfileOverride;
    persistedAuthProfileOverrideSource = entry.authProfileOverrideSource;
    persistedAuthProfileOverrideCompactionCount = entry.authProfileOverrideCompactionCount;
    persistedLabel = entry.label;
  } else {
    sessionId = crypto.randomUUID();
    isNewSession = true;
    systemSent = false;
    abortedLastRun = false;
    // When a reset trigger (/new, /reset) starts a new session, carry over
    // user-set behavior overrides (verbose, thinking, reasoning, ttsAuto)
    // so the user doesn't have to re-enable them every time.
    if (resetTriggered && entry) {
      persistedThinking = entry.thinkingLevel;
      persistedVerbose = entry.verboseLevel;
      persistedReasoning = entry.reasoningLevel;
      persistedTtsAuto = entry.ttsAuto;
      persistedModelOverride = entry.modelOverride;
      persistedProviderOverride = entry.providerOverride;
      persistedAuthProfileOverride = entry.authProfileOverride;
      persistedAuthProfileOverrideSource = entry.authProfileOverrideSource;
      persistedAuthProfileOverrideCompactionCount = entry.authProfileOverrideCompactionCount;
      // Explicit /new and /reset should rotate the underlying CLI conversation too.
      // Keep the model/auth choice, but force the next turn to mint a fresh CLI binding.
      persistedLabel = entry.label;
      persistedSpawnedBy = entry.spawnedBy;
      persistedSpawnedWorkspaceDir = entry.spawnedWorkspaceDir;
      persistedParentSessionKey = entry.parentSessionKey;
      persistedForkedFromParent = entry.forkedFromParent;
      persistedSpawnDepth = entry.spawnDepth;
      persistedSubagentRole = entry.subagentRole;
      persistedSubagentControlScope = entry.subagentControlScope;
      persistedDisplayName = entry.displayName;
    }
  }

  const baseEntry = !isNewSession && freshEntry ? entry : undefined;
  // Track the originating channel/to for announce routing (subagent announce-back).
  const originatingChannelRaw = ctx.OriginatingChannel as string | undefined;
  const isInterSession = isInterSessionInputProvenance(ctx.InputProvenance);
  const lastChannelRaw = resolveLastChannelRaw({
    originatingChannelRaw,
    persistedLastChannel: baseEntry?.lastChannel,
    sessionKey,
    isInterSession,
  });
  const lastToRaw = resolveLastToRaw({
    originatingChannelRaw,
    originatingToRaw: ctx.OriginatingTo,
    toRaw: ctx.To,
    persistedLastTo: baseEntry?.lastTo,
    persistedLastChannel: baseEntry?.lastChannel,
    sessionKey,
    isInterSession,
  });
  const lastAccountIdRaw = resolveSessionDefaultAccountId({
    cfg,
    channelRaw: lastChannelRaw,
    accountIdRaw: ctx.AccountId,
    persistedLastAccountId: baseEntry?.lastAccountId,
  });
  // Only fall back to persisted threadId for thread sessions.  Non-thread
  // sessions (e.g. DM without topics) must not inherit a stale threadId from a
  // previous interaction that happened inside a topic/thread.
  const lastThreadIdRaw = ctx.MessageThreadId || (isThread ? baseEntry?.lastThreadId : undefined);
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
    authProfileOverride: persistedAuthProfileOverride ?? baseEntry?.authProfileOverride,
    authProfileOverrideSource:
      persistedAuthProfileOverrideSource ?? baseEntry?.authProfileOverrideSource,
    authProfileOverrideCompactionCount:
      persistedAuthProfileOverrideCompactionCount ?? baseEntry?.authProfileOverrideCompactionCount,
    cliSessionIds: baseEntry?.cliSessionIds,
    cliSessionBindings: baseEntry?.cliSessionBindings,
    claudeCliSessionId: baseEntry?.claudeCliSessionId,
    label: persistedLabel ?? baseEntry?.label,
    spawnedBy: persistedSpawnedBy ?? baseEntry?.spawnedBy,
    spawnedWorkspaceDir: persistedSpawnedWorkspaceDir ?? baseEntry?.spawnedWorkspaceDir,
    parentSessionKey: persistedParentSessionKey ?? baseEntry?.parentSessionKey,
    forkedFromParent: persistedForkedFromParent ?? baseEntry?.forkedFromParent,
    spawnDepth: persistedSpawnDepth ?? baseEntry?.spawnDepth,
    subagentRole: persistedSubagentRole ?? baseEntry?.subagentRole,
    subagentControlScope: persistedSubagentControlScope ?? baseEntry?.subagentControlScope,
    sendPolicy: baseEntry?.sendPolicy,
    queueMode: baseEntry?.queueMode,
    queueDebounceMs: baseEntry?.queueDebounceMs,
    queueCap: baseEntry?.queueCap,
    queueDrop: baseEntry?.queueDrop,
    displayName: persistedDisplayName ?? baseEntry?.displayName,
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
  const threadLabel = normalizeOptionalString(ctx.ThreadLabel);
  if (threadLabel) {
    sessionEntry.displayName = threadLabel;
  }
  const parentSessionKey = normalizeOptionalString(ctx.ParentSessionKey);
  const alreadyForked = sessionEntry.forkedFromParent === true;
  if (
    parentSessionKey &&
    parentSessionKey !== sessionKey &&
    sessionStore[parentSessionKey] &&
    !alreadyForked
  ) {
    const parentTokens = sessionStore[parentSessionKey].totalTokens ?? 0;
    if (parentForkMaxTokens > 0 && parentTokens > parentForkMaxTokens) {
      // Parent context is too large — forking would create a thread session
      // that immediately overflows the model's context window. Start fresh
      // instead and mark as forked to prevent re-attempts. See #26905.
      log.warn(
        `skipping parent fork (parent too large): parentKey=${parentSessionKey} → sessionKey=${sessionKey} ` +
          `parentTokens=${parentTokens} maxTokens=${parentForkMaxTokens}`,
      );
      sessionEntry.forkedFromParent = true;
    } else {
      log.warn(
        `forking from parent session: parentKey=${parentSessionKey} → sessionKey=${sessionKey} ` +
          `parentTokens=${parentTokens}`,
      );
      const forked = await forkSessionFromParent({
        parentEntry: sessionStore[parentSessionKey],
        agentId,
        sessionsDir: path.dirname(storePath),
      });
      if (forked) {
        sessionId = forked.sessionId;
        sessionEntry.sessionId = forked.sessionId;
        sessionEntry.sessionFile = forked.sessionFile;
        sessionEntry.forkedFromParent = true;
        log.warn(`forked session created: file=${forked.sessionFile}`);
      }
    }
  }
  const threadIdFromSessionKey = parseSessionThreadInfo(
    sessionCtxForState.SessionKey ?? sessionKey,
  ).threadId;
  const fallbackSessionFile = !sessionEntry.sessionFile
    ? resolveSessionTranscriptPath(
        sessionEntry.sessionId,
        agentId,
        ctx.MessageThreadId ?? threadIdFromSessionKey,
      )
    : undefined;
  const resolvedSessionFile = await resolveAndPersistSessionFile({
    sessionId: sessionEntry.sessionId,
    sessionKey,
    sessionStore,
    storePath,
    sessionEntry,
    agentId,
    sessionsDir: path.dirname(storePath),
    fallbackSessionFile,
    activeSessionKey: sessionKey,
    maintenanceConfig,
  });
  sessionEntry = resolvedSessionFile.sessionEntry;
  if (isNewSession) {
    sessionEntry.compactionCount = 0;
    sessionEntry.memoryFlushCompactionCount = undefined;
    sessionEntry.memoryFlushAt = undefined;
    // Clear stale context hash so the first flush in the new session is not
    // incorrectly skipped due to a hash match with the old transcript (#30115).
    sessionEntry.memoryFlushContextHash = undefined;
    // Clear stale token metrics from previous session so /status doesn't
    // display the old session's context usage after /new or /reset.
    sessionEntry.totalTokens = undefined;
    sessionEntry.inputTokens = undefined;
    sessionEntry.outputTokens = undefined;
    sessionEntry.estimatedCostUsd = undefined;
    sessionEntry.contextTokens = undefined;
  }
  // Preserve per-session overrides while resetting compaction state on /new.
  sessionStore[sessionKey] = { ...sessionStore[sessionKey], ...sessionEntry };
  await updateSessionStore(
    storePath,
    (store) => {
      // Preserve per-session overrides while resetting compaction state on /new.
      store[sessionKey] = { ...store[sessionKey], ...sessionEntry };
      if (retiredLegacyMainDelivery) {
        store[retiredLegacyMainDelivery.key] = retiredLegacyMainDelivery.entry;
      }
    },
    {
      activeSessionKey: sessionKey,
      maintenanceConfig,
      onWarn: (warning) =>
        deliverSessionMaintenanceWarning({
          cfg,
          sessionKey,
          entry: sessionEntry,
          warning,
        }),
    },
  );

  // Archive old transcript so it doesn't accumulate on disk (#14869).
  let previousSessionTranscript: {
    sessionFile?: string;
    transcriptArchived?: boolean;
  } = {};
  if (previousSessionEntry?.sessionId) {
    const { archiveSessionTranscriptsDetailed, resolveStableSessionEndTranscript } =
      await loadSessionArchiveRuntime();
    const archivedTranscripts = archiveSessionTranscriptsDetailed({
      sessionId: previousSessionEntry.sessionId,
      storePath,
      sessionFile: previousSessionEntry.sessionFile,
      agentId,
      reason: "reset",
    });
    previousSessionTranscript = resolveStableSessionEndTranscript({
      sessionId: previousSessionEntry.sessionId,
      storePath,
      sessionFile: previousSessionEntry.sessionFile,
      agentId,
      archivedTranscripts,
    });
    await disposeSessionMcpRuntime(previousSessionEntry.sessionId).catch((error) => {
      log.warn(
        `failed to dispose bundle MCP runtime for session ${previousSessionEntry.sessionId}`,
        {
          error: String(error),
        },
      );
    });
    await resetRegisteredAgentHarnessSessions({
      sessionId: previousSessionEntry.sessionId,
      sessionKey,
      sessionFile: previousSessionEntry.sessionFile,
      reason: previousSessionEndReason ?? "unknown",
    });
  }

  const sessionCtx: TemplateContext = {
    ...sessionCtxForState,
    // Keep BodyStripped aligned with Body (best default for agent prompts).
    // RawBody is reserved for command/directive parsing and may omit context.
    BodyStripped: normalizeInboundTextNewlines(
      bodyStripped ??
        sessionCtxForState.BodyForAgent ??
        sessionCtxForState.Body ??
        sessionCtxForState.CommandBody ??
        sessionCtxForState.RawBody ??
        sessionCtxForState.BodyForCommands ??
        "",
    ),
    SessionId: sessionId,
    IsNewSession: isNewSession ? "true" : "false",
  };

  // Run session plugin hooks (fire-and-forget)
  const hookRunner = getGlobalHookRunner();
  if (hookRunner && isNewSession) {
    const effectiveSessionId = sessionId ?? "";

    // If replacing an existing session, fire session_end for the old one
    if (previousSessionEntry?.sessionId && previousSessionEntry.sessionId !== effectiveSessionId) {
      if (hookRunner.hasHooks("session_end")) {
        const payload = buildSessionEndHookPayload({
          sessionId: previousSessionEntry.sessionId,
          sessionKey,
          cfg,
          reason: previousSessionEndReason,
          sessionFile: previousSessionTranscript.sessionFile,
          transcriptArchived: previousSessionTranscript.transcriptArchived,
          nextSessionId: effectiveSessionId,
        });
        void hookRunner.runSessionEnd(payload.event, payload.context).catch(() => {});
      }
    }

    // Fire session_start for the new session
    if (hookRunner.hasHooks("session_start")) {
      const payload = buildSessionStartHookPayload({
        sessionId: effectiveSessionId,
        sessionKey,
        cfg,
        resumedFrom: previousSessionEntry?.sessionId,
      });
      void hookRunner.runSessionStart(payload.event, payload.context).catch(() => {});
    }
  }

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
