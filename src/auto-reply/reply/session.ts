// Manages reply session records, labels, ids, and route persistence.
import crypto from "node:crypto";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { retireSessionMcpRuntime } from "../../agents/agent-bundle-mcp-tools.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { clearBootstrapSnapshotOnSessionBoundary } from "../../agents/bootstrap-cache.js";
import { clearAllCliSessions, getCliSessionBinding } from "../../agents/cli-session.js";
import { resetRegisteredAgentHarnessSessions } from "../../agents/harness/registry.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../../browser-lifecycle-cleanup.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { conversationRouteContextFromMsgContext } from "../../config/sessions/conversation-route-context.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import {
  hasTerminalMainSessionTranscriptNewerThanRegistry,
  isRestartRecoveryTombstone,
  resolveSessionLifecycleTimestamps,
  resolveSessionWorkStartError,
} from "../../config/sessions/lifecycle.js";
import { canonicalizeMainSessionAlias } from "../../config/sessions/main-session.js";
import { deriveSessionMetaPatch } from "../../config/sessions/metadata.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { resolveResetPreservedSelection } from "../../config/sessions/reset-preserved-selection.js";
import {
  evaluateSessionFreshness,
  resolveChannelResetConfig,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveThreadFlag,
  type SessionFreshness,
} from "../../config/sessions/reset.js";
import {
  commitReplySessionInitialization,
  loadReplySessionInitializationSnapshot,
} from "../../config/sessions/session-accessor.js";
import { sessionEntryForkedFromParent } from "../../config/sessions/session-entry-lineage.js";
import { buildSessionCreationStamp } from "../../config/sessions/session-entry-provenance.js";
import { resolveSessionKey } from "../../config/sessions/session-key.js";
import type { SessionResetBoundaryRequest } from "../../config/sessions/session-reset-boundary-event.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import { resolveMaintenanceConfigFromInput } from "../../config/sessions/store-maintenance.js";
import { runExclusiveSessionStoreWrite } from "../../config/sessions/store-writer.js";
import {
  isRecoverableTerminalSessionStatus,
  recoverTerminalSessionEntryForVisibleTurn,
} from "../../config/sessions/terminal-status.js";
import {
  SESSION_TOTAL_TOKENS_VERSION,
  type GroupKeyResolution,
  type InternalSessionEntry,
  type SessionEntry,
  type SessionScope,
} from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  forgetActiveSessionForShutdown,
  noteActiveSessionForShutdown,
} from "../../gateway/active-sessions-shutdown-tracker.js";
import { emitSessionAutoResetHook } from "../../hooks/session-auto-reset.js";
import { isDiagnosticFlagEnabled } from "../../infra/diagnostic-flags.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { deliverSessionMaintenanceWarning } from "../../infra/session-maintenance-warning.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookSessionEndReason } from "../../plugins/hook-types.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import {
  buildAgentMainSessionKey,
  isAcpSessionKey,
  isSubagentSessionKey,
  normalizeMainKey,
} from "../../routing/session-key.js";
import { resolveAgentHarnessSessionContextError } from "../../sessions/agent-harness-session-key.js";
import { isInterSessionInputProvenance } from "../../sessions/input-provenance.js";
import {
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_RESET_MESSAGE,
  ModelSelectionLockedError,
} from "../../sessions/model-overrides.js";
import {
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import {
  prepareChannelParticipantObservation,
  recordAcceptedSessionParticipantInput,
} from "../../sessions/session-participant-input.js";
import {
  recordSessionCreated,
  classifySessionStateActor,
  registerMainSessionGroupWatch,
} from "../../sessions/session-state-events.js";
import {
  deliveryContextFromSession,
  normalizeSessionDeliveryState,
  sessionDeliveryOrigin,
  sessionDeliveryRoute,
} from "../../utils/delivery-context.shared.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import type {
  FinalizedRuntimeMsgContext,
  FinalizedTemplateContext as TemplateContext,
  MsgContext,
} from "../templating.js";
import { resolveEffectiveResetTargetSessionKey } from "./acp-reset-target.js";
import { resolveConversationBindingContextFromMessage } from "./conversation-binding-input.js";
import { normalizeInboundTextNewlines } from "./inbound-text.js";
import { replyRunRegistry } from "./reply-run-registry.js";
import { resolveRuntimePolicySessionKey } from "./runtime-policy-session-key.js";
import {
  maybeRetireLegacyMainDeliveryRoute,
  resolveSessionDeliveryRoute,
} from "./session-delivery.js";
import {
  createReplySessionEntryHandle,
  type ReplySessionEntryHandle,
} from "./session-entry-handle.js";
import { buildSessionEndHookPayload, buildSessionStartHookPayload } from "./session-hooks.js";
import {
  ReplySessionInitConflictError,
  runWithSessionInitConflictRetry,
} from "./session-init-conflict-retry.js";
import {
  canReplaceRestartTombstoneFromParent,
  prepareReplySessionParentFork,
} from "./session-parent-fork-prepare.js";
import { clearSessionResetRuntimeState } from "./session-reset-cleanup.js";
import { resolveAuthorizedSessionResetCommand } from "./session-reset-command.js";
import {
  stripThreadFromSessionRoute,
  stripThreadIdFromDeliveryContext,
  stripThreadIdFromOrigin,
} from "./session-route-reset.js";

const log = createSubsystemLogger("session-init");

type ReplySessionEndReason = Extract<
  PluginHookSessionEndReason,
  "new" | "reset" | "idle" | "daily" | "unknown"
>;

function resolveExplicitSessionEndReason(
  matchedResetTriggerLower?: string,
): Extract<ReplySessionEndReason, "new" | "reset"> {
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
}): ReplySessionEndReason | undefined {
  return params.entry ? params.freshness?.staleReason : undefined;
}

function hasProviderOwnedSession(entry: SessionEntry | undefined): boolean {
  const provider = normalizeOptionalString(entry?.providerOverride ?? entry?.modelProvider);
  return Boolean(provider && getCliSessionBinding(entry, provider));
}

export type SessionInitResult = {
  sessionCtx: TemplateContext;
  sessionEntry: SessionEntry;
  initialSessionEntry?: SessionEntry;
  previousSessionEntry?: SessionEntry;
  sessionEntryHandle: ReplySessionEntryHandle;
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

type InitSessionStateParams = {
  cfg: OpenClawConfig;
  commandAuthorized: boolean;
  ctx: FinalizedRuntimeMsgContext;
  expectedExistingSessionId?: string;
  pinExpectedExistingSession?: boolean;
  newlyCreatedSessionId?: string;
  requestedSessionId?: string;
  resumeRequestedSession?: boolean;
  signal?: AbortSignal;
};

type InitSessionStateAttemptContext = {
  agentId: string;
  conversationBindingContext: ReturnType<typeof resolveSessionConversationBindingContext>;
  isSystemEvent: boolean;
  retargetedSession: boolean;
  sessionCtxForState: FinalizedRuntimeMsgContext;
  storePath: string;
};

type InitSessionStateAttemptOutcome =
  | { kind: "complete"; result: SessionInitResult }
  | { kind: "lifecycle-mutation"; sessionId: string; sessionKey: string };

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
  touch?: boolean;
  bindingContext?: {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
  } | null;
}): string | undefined {
  const bindingContext =
    params.bindingContext === undefined
      ? resolveSessionConversationBindingContext(params.cfg, params.ctx)
      : params.bindingContext;
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
  if (params.touch !== false) {
    getSessionBindingService().touch(binding.bindingId);
  }
  return binding.targetSessionKey;
}

function resolveInitSessionStateAttemptContext(
  params: Pick<InitSessionStateParams, "cfg" | "ctx">,
  options?: { touchConversationBinding?: boolean },
): InitSessionStateAttemptContext {
  const { cfg, ctx } = params;
  // Automated system events must not reset sessions or retarget conversation bindings.
  const isSystemEvent =
    ctx.Provider === "heartbeat" || ctx.Provider === "cron-event" || ctx.Provider === "exec-event";
  const conversationBindingContext = isSystemEvent
    ? null
    : resolveSessionConversationBindingContext(cfg, ctx);
  // Slash/menu commands may arrive on a transport session while targeting the chat session.
  // Prefer explicit command target before binding lookup so command mutations land there.
  const commandTargetSessionKey = resolveCommandTurnTargetSessionKey(ctx);
  const targetSessionKey =
    commandTargetSessionKey ??
    resolveBoundConversationSessionKey({
      cfg,
      ctx,
      bindingContext: conversationBindingContext,
      touch: options?.touchConversationBinding,
    });
  const sessionCtxForState =
    targetSessionKey && targetSessionKey !== ctx.SessionKey
      ? { ...ctx, SessionKey: targetSessionKey }
      : ctx;
  const agentId = resolveSessionAgentId({
    sessionKey: sessionCtxForState.SessionKey,
    config: cfg,
    fallbackAgentId: sessionCtxForState.AgentId,
  });
  return {
    agentId,
    conversationBindingContext,
    isSystemEvent,
    retargetedSession: sessionCtxForState !== ctx,
    sessionCtxForState,
    storePath: resolveSessionStorePathForScope({
      agentId,
      sessionKey: sessionCtxForState.SessionKey,
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }),
    }),
  };
}

type ReplySessionPreprocessingState = {
  sessionEntry?: SessionEntry;
  sessionKey: string;
  storePath: string;
};

/** Resolves durable ownership before utility preprocessing can invoke another model. */
export function resolveReplySessionPreprocessingState(
  params: Pick<InitSessionStateParams, "cfg" | "ctx">,
): ReplySessionPreprocessingState {
  const attemptContext = resolveInitSessionStateAttemptContext(params, {
    touchConversationBinding: false,
  });
  const sessionKey = canonicalizeMainSessionAlias({
    cfg: params.cfg,
    agentId: attemptContext.agentId,
    sessionKey: resolveSessionKey(
      params.cfg.session?.scope ?? "per-sender",
      attemptContext.sessionCtxForState,
      normalizeMainKey(params.cfg.session?.mainKey),
    ),
  });
  const sessionEntry = loadReplySessionInitializationSnapshot({
    agentId: attemptContext.agentId,
    storePath: attemptContext.storePath,
    sessionKey,
  }).currentEntry;
  const contextError = resolveAgentHarnessSessionContextError(sessionKey, sessionEntry);
  if (contextError) {
    throw new Error(contextError);
  }
  return {
    sessionEntry,
    sessionKey,
    storePath: attemptContext.storePath,
  };
}

/** Initializes or reuses the reply session state for one inbound turn. */
type SessionModelOverrideSelection = Pick<
  SessionEntry,
  "modelOverride" | "providerOverride" | "modelOverrideSource" | "modelOverrideRouteResolution"
>;

function selectSessionModelOverride(
  entry: Partial<SessionModelOverrideSelection>,
): SessionModelOverrideSelection {
  return {
    modelOverride: entry.modelOverride,
    providerOverride: entry.providerOverride,
    modelOverrideSource: entry.modelOverrideSource,
    modelOverrideRouteResolution: entry.modelOverrideRouteResolution,
  };
}

function resolveReplySessionRolloverState(
  entry: SessionEntry,
  sessionKey: string,
): Partial<InternalSessionEntry> {
  const preservedSelection = resolveResetPreservedSelection({ entry });
  // Stable ACP rows predate durable creation stamps. Preserve their restrictions
  // fail-closed so rollover cannot turn an existing child into a root session.
  const preserveSpawnLineage = isSubagentSessionKey(sessionKey) || isAcpSessionKey(sessionKey);
  return {
    thinkingLevel: entry.thinkingLevel,
    verboseLevel: entry.verboseLevel,
    traceLevel: entry.traceLevel,
    reasoningLevel: entry.reasoningLevel,
    ttsAuto: entry.ttsAuto,
    responseUsage: entry.responseUsage,
    ...selectSessionModelOverride(preservedSelection),
    authProfileOverride: preservedSelection.authProfileOverride,
    authProfileOverrideSource: preservedSelection.authProfileOverrideSource,
    authProfileOverrideCompactionCount: preservedSelection.authProfileOverrideCompactionCount,
    label: entry.label,
    displayName: entry.displayName,
    // Notice debt survives rollover: erasing it here would recreate the
    // silent ambiguous-loss outcome the debt exists to prevent.
    pendingDeliveryNotice: entry.pendingDeliveryNotice,
    ...(preserveSpawnLineage
      ? {
          spawnedBy: entry.spawnedBy,
          spawnedWorkspaceDir: entry.spawnedWorkspaceDir,
          spawnedCwd: entry.spawnedCwd,
          spawnDepth: entry.spawnDepth,
          subagentRole: entry.subagentRole,
          subagentControlScope: entry.subagentControlScope,
        }
      : {}),
    parentSessionKey: entry.parentSessionKey,
    parentSessionId: entry.parentSessionId,
    forkedFromParent: entry.forkedFromParent,
    forkSource: entry.forkSource,
    createdVia: entry.createdVia,
    createdActor: entry.createdActor,
    createdAt: entry.createdAt,
    ...(entry.sandbox === "required" ? { sandbox: "required" } : {}),
  };
}

export async function initSessionState(params: InitSessionStateParams): Promise<SessionInitResult> {
  prepareChannelParticipantObservation(params.ctx);
  return await runWithSessionInitConflictRetry(
    async () => await initSessionStateAttempt(params, false),
    { signal: params.signal },
  );
}

async function initSessionStateAttempt(
  params: InitSessionStateParams,
  staleSnapshotRetried: boolean,
): Promise<SessionInitResult> {
  const attemptContext = resolveInitSessionStateAttemptContext(params);
  // Guarded revision checks only serialize correctly when the snapshot and
  // commit share the same writer lane.
  const attempt = await runExclusiveSessionStoreWrite(
    attemptContext.storePath,
    async () =>
      await initSessionStateAttemptLocked(params, attemptContext, staleSnapshotRetried, undefined),
  );
  if (attempt.kind === "complete") {
    return attempt.result;
  }

  let rollover = attempt;
  while (true) {
    const candidate = rollover;
    const identities = [candidate.sessionKey, candidate.sessionId];
    let preparedOutcome: InitSessionStateAttemptOutcome | undefined;
    // Drain foreign owners before the rollover takes the writer lane. Holding
    // that lane while waiting would deadlock owners that release after a write.
    const outcome = await runExclusiveSessionLifecycleMutation({
      scope: attemptContext.storePath,
      identities,
      signal: params.signal,
      prepare: async () => {
        // A queued rollover may change identity or become obsolete. Recheck
        // before interrupting, then reacquire any refreshed identity first.
        const revalidated = await runExclusiveSessionStoreWrite(
          attemptContext.storePath,
          async () => await initSessionStateAttemptLocked(params, attemptContext, false, undefined),
        );
        if (
          revalidated.kind === "complete" ||
          revalidated.sessionKey !== candidate.sessionKey ||
          revalidated.sessionId !== candidate.sessionId
        ) {
          preparedOutcome = revalidated;
          return;
        }
        const drained = await interruptSessionWorkAdmissions({
          scope: attemptContext.storePath,
          identities,
          timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
        });
        if (!drained) {
          throw new Error(
            `timed out draining work before reply session rollover: ${candidate.sessionKey}`,
          );
        }
      },
      run: async () => {
        if (preparedOutcome) {
          return preparedOutcome;
        }
        // Interrupted owners can rebind while draining. The locked attempt
        // must match this exact fenced identity before any rollover side effect.
        return await runExclusiveSessionStoreWrite(
          attemptContext.storePath,
          async () => await initSessionStateAttemptLocked(params, attemptContext, false, candidate),
        );
      },
    });
    if (outcome.kind === "complete") {
      return outcome.result;
    }
    rollover = outcome;
  }
}

async function initSessionStateAttemptLocked(
  params: InitSessionStateParams,
  attemptContext: InitSessionStateAttemptContext,
  staleSnapshotRetried: boolean,
  lifecycleMutationIdentity: { sessionId: string; sessionKey: string } | undefined,
): Promise<InitSessionStateAttemptOutcome> {
  const { ctx, cfg, commandAuthorized } = params;
  const {
    agentId,
    conversationBindingContext,
    isSystemEvent,
    retargetedSession,
    sessionCtxForState,
    storePath,
  } = attemptContext;
  const sessionCfg = cfg.session;
  const maintenanceConfig = resolveMaintenanceConfigFromInput(sessionCfg?.maintenance);
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);
  const groupResolution = resolveGroupSessionKey(sessionCtxForState) ?? undefined;
  const sessionScope = sessionCfg?.scope ?? "per-sender";
  const ingressTimingEnabled = isDiagnosticFlagEnabled("ingress.timing", cfg);

  let sessionEntry: SessionEntry;

  let sessionId: string | undefined;
  let isNewSession = false;
  let bodyStripped: string | undefined;
  let systemSent;
  let abortedLastRun;
  let resetTriggered = false;

  let preservedState: Partial<SessionEntry> | undefined;

  const normalizedChatType = normalizeChatType(ctx.ChatType);
  const isGroup =
    normalizedChatType != null && normalizedChatType !== "direct" ? true : Boolean(groupResolution);
  const { resetAuthorized, resetCommand } = resolveAuthorizedSessionResetCommand({
    ctx,
    cfg,
    agentId,
    isGroup,
    commandAuthorized,
  });
  const { matchedResetTriggerLower, softResetMatched, triggerBodyNormalized } = resetCommand;
  if (matchedResetTriggerLower !== undefined) {
    isNewSession = true;
    bodyStripped = resetCommand.payload ?? "";
    resetTriggered = true;
  }

  // Canonicalize so the written key matches what all read paths produce.
  const sessionKey: string = canonicalizeMainSessionAlias({
    cfg,
    agentId,
    sessionKey: resolveSessionKey(sessionScope, sessionCtxForState, mainKey, agentId),
  });
  // CRITICAL: Skip cache to ensure fresh data when resolving session identity.
  // Stale cache (especially with multiple gateway processes or on Windows where
  // mtime granularity may miss rapid writes) can cause incorrect sessionId
  // generation, leading to orphaned transcript files. See #17971.
  const sessionStoreLoadStartMs = ingressTimingEnabled ? Date.now() : 0;
  const initializationSnapshot = loadReplySessionInitializationSnapshot({
    agentId,
    storePath,
    sessionKey,
  });
  if (ingressTimingEnabled) {
    log.info(
      `session-init store-load agent=${agentId} session=${sessionCtxForState.SessionKey ?? "(no-session)"} ` +
        `elapsedMs=${Date.now() - sessionStoreLoadStartMs} path=${storePath}`,
    );
  }
  const retiredLegacyMainDelivery = maybeRetireLegacyMainDeliveryRoute({
    sessionCfg,
    sessionKey,
    legacyMain: initializationSnapshot.readEntry(
      buildAgentMainSessionKey({
        agentId,
        mainKey,
      }),
    ),
    agentId,
    mainKey,
    isGroup,
    ctx,
  });
  const entry = initializationSnapshot.currentEntry;
  const createdNewEntry = entry === undefined;
  const parentSessionKey = normalizeOptionalString(ctx.ParentSessionKey);
  const parentForkSourceEntry =
    parentSessionKey && parentSessionKey !== sessionKey
      ? initializationSnapshot.readEntry(parentSessionKey)
      : undefined;
  const restartTombstoneReset =
    resetTriggered &&
    isRestartRecoveryTombstone(entry) &&
    entry?.pluginOwnerId === undefined &&
    !isSystemEvent &&
    classifySessionStateActor({ inputProvenance: ctx.InputProvenance }).actorType === "human";
  const restartTombstoneParentFork = canReplaceRestartTombstoneFromParent({
    actorType: isSystemEvent
      ? "system"
      : classifySessionStateActor({ inputProvenance: ctx.InputProvenance }).actorType,
    entry,
    hasParentForkSource: Boolean(parentForkSourceEntry?.sessionId),
    inboundAccessAuthorized: ctx.InboundAccessAuthorized,
    inboundEventKind: ctx.InboundEventKind,
    nativeCommandTarget: resolveCommandTurnTargetSessionKey(ctx),
    sessionKey,
  });
  const archivedSessionError = resolveSessionWorkStartError(sessionKey, entry, {
    allowRestartTombstoneReplacement: restartTombstoneReset || restartTombstoneParentFork,
  });
  if (archivedSessionError) {
    throw new Error(archivedSessionError);
  }
  // Locked model selection is coupled to the current native session id. Reject before
  // lifecycle cleanup so a reset cannot detach the durable harness binding.
  if (resetTriggered && isModelSelectionLocked(entry)) {
    throw new ModelSelectionLockedError(MODEL_SELECTION_LOCKED_RESET_MESSAGE);
  }
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
  const canReuseExistingEntry =
    Boolean(entry?.sessionId) &&
    typeof entry?.updatedAt === "number" &&
    Number.isFinite(entry.updatedAt);
  // Gateway admission pins the source session. A conversation or command target owns a
  // different session id, so applying the source constraint there rejects valid routing.
  const expectedExistingSessionId = retargetedSession
    ? undefined
    : params.expectedExistingSessionId?.trim() || undefined;
  if (expectedExistingSessionId && entry?.sessionId !== expectedExistingSessionId) {
    throw new Error(`session rebound for sessionKey: ${sessionKey}`);
  }
  const pinExpectedExistingSession =
    params.pinExpectedExistingSession === true && expectedExistingSessionId !== undefined;
  const requestedSessionId = params.requestedSessionId?.trim() || undefined;
  const requestedCurrentSession = Boolean(
    requestedSessionId && entry?.sessionId && entry.sessionId === requestedSessionId,
  );
  // Control UI sends sessionId on ordinary sends too, so only the one-shot reconnect
  // resume signal is allowed to suppress configured idle/daily rollover.
  const reconnectResumeRequested =
    params.resumeRequestedSession === true && requestedCurrentSession;
  // Implicit expiry must preserve the same identity for model-locked native sessions too.
  const lockedModelSelection = isModelSelectionLocked(entry);
  const skipImplicitExpiry =
    lockedModelSelection || (hasProviderOwnedSession(entry) && resetPolicy.configured !== true);
  const lifecycleTimestamps = resolveSessionLifecycleTimestamps({
    entry,
    agentId,
    sessionKey,
    storePath,
  });
  const entryFreshness = entry
    ? skipImplicitExpiry
      ? ({ fresh: true } satisfies SessionFreshness)
      : evaluateSessionFreshness({
          updatedAt: entry.updatedAt,
          sessionStartedAt: lifecycleTimestamps.sessionStartedAt,
          lastInteractionAt: lifecycleTimestamps.lastInteractionAt,
          now,
          policy: resetPolicy,
        })
    : undefined;
  const softResetAllowed =
    softResetMatched &&
    resetAuthorized &&
    !isAcpSessionKey(
      resolveEffectiveResetTargetSessionKey({
        cfg,
        channel: conversationBindingContext?.channel,
        accountId: conversationBindingContext?.accountId,
        conversationId: conversationBindingContext?.conversationId,
        parentConversationId: conversationBindingContext?.parentConversationId,
        activeSessionKey: sessionKey,
        allowNonAcpBindingSessionKey: false,
        skipConfiguredFallbackWhenActiveSessionNonAcp: false,
      }) ?? "",
    );
  const terminalMainTranscriptNewerThanRegistry =
    !isSystemEvent &&
    (await hasTerminalMainSessionTranscriptNewerThanRegistry({
      entry,
      sessionScope,
      sessionKey,
      agentId,
      mainKey,
      storePath,
    }));
  const recoverTerminalVisibleEntry =
    canReuseExistingEntry &&
    !isSystemEvent &&
    !resetTriggered &&
    (entryFreshness?.fresh ?? false) &&
    isRecoverableTerminalSessionStatus(entry?.status);
  const freshEntry =
    !restartTombstoneParentFork &&
    ((lockedModelSelection && canReuseExistingEntry) ||
      (isSystemEvent && canReuseExistingEntry) ||
      (((pinExpectedExistingSession && canReuseExistingEntry) ||
        (reconnectResumeRequested && canReuseExistingEntry) ||
        recoverTerminalVisibleEntry ||
        (entryFreshness?.fresh ?? false) ||
        (softResetAllowed && canReuseExistingEntry)) &&
        !terminalMainTranscriptNewerThanRegistry));
  const activeReplyOperation = replyRunRegistry.get(sessionKey);
  const deferImplicitRolloverForActiveRun =
    !resetTriggered &&
    !freshEntry &&
    canReuseExistingEntry &&
    entryFreshness?.fresh === false &&
    entryFreshness.staleReason != null &&
    activeReplyOperation?.phase !== "queued" &&
    activeReplyOperation?.sessionId === entry?.sessionId;
  // Implicit daily/idle rollover must not rename a transcript while that exact
  // session's active writer is still running. Admission will steer/wait/queue;
  // queued pre-dispatch reservations still let the current turn roll over.
  const effectiveFreshEntry = deferImplicitRolloverForActiveRun ? true : freshEntry;
  // Capture the current session entry before any reset so its transcript can be
  // archived afterward.  We need to do this for both explicit resets (/new, /reset)
  // and for scheduled/daily resets where the session has become stale (!freshEntry).
  // Without this, daily-reset transcripts are left as orphaned files on disk (#35481).
  const previousSessionEntry =
    (resetTriggered || !effectiveFreshEntry) && entry ? { ...entry } : undefined;
  const previousSessionEndReason = resetTriggered
    ? resolveExplicitSessionEndReason(matchedResetTriggerLower)
    : resolveStaleSessionEndReason({
        entry,
        freshness: entryFreshness,
      });
  const lifecycleMutationMatches = Boolean(
    previousSessionEntry &&
    lifecycleMutationIdentity?.sessionKey === sessionKey &&
    lifecycleMutationIdentity.sessionId === previousSessionEntry.sessionId,
  );
  if (previousSessionEntry && !lifecycleMutationMatches) {
    return {
      kind: "lifecycle-mutation",
      sessionId: previousSessionEntry.sessionId,
      sessionKey,
    };
  }
  const recoveredTerminalEntry =
    entry && recoverTerminalVisibleEntry
      ? recoverTerminalSessionEntryForVisibleTurn(entry)
      : undefined;
  const reusableEntry = recoveredTerminalEntry ?? entry;

  if (!isNewSession && effectiveFreshEntry && canReuseExistingEntry && reusableEntry) {
    sessionId = reusableEntry.sessionId;
    systemSent = reusableEntry.systemSent ?? false;
    abortedLastRun = reusableEntry.abortedLastRun ?? false;
    preservedState = selectSessionModelOverride(reusableEntry);
  } else {
    // Durable resets retain their transcript identity for cursor continuity; ACP
    // resets still rotate the local session id that owns provider conversation state.
    sessionId =
      isAcpSessionKey(sessionKey) || restartTombstoneParentFork
        ? crypto.randomUUID()
        : (entry?.sessionId ?? crypto.randomUUID());
    isNewSession = true;
    systemSent = false;
    abortedLastRun = false;
    // Preserve user-driven model/auth overrides across ANY rollover that mints
    // a new session from an existing entry — explicit /new and /reset AND
    // implicit stale rollovers (daily/idle reset boundary). Auto-created
    // fallback overrides (rate-limit auth rotation, model auto-pin) are still
    // cleared by resolveResetPreservedSelection so resets return to the
    // configured default. Previously this was gated on `resetTriggered`, so a
    // user `/model` override set after the daily reset hour was silently
    // dropped on the next turn (the rollover took this branch with
    // resetTriggered === false), reverting the session to the default model
    // despite the `Model set to ... for this session` ack (#90119, #69301).
    if (entry) {
      // Behavior overrides carry across ANY new-session mint (explicit /new AND
      // implicit daily/idle rollover), mirroring the model/auth carry above
      // (#90119). Any persisted level is safe to forward — user `/think` or a
      // spawn-applied default (subagent-spawn-thinking.ts) — so unlike model
      // overrides these need no fallback-provenance filtering (#92562).
      // Explicit /new and /reset rotate CLI conversation bindings elsewhere.
      preservedState = resolveReplySessionRolloverState(entry, sessionKey);
    }
  }

  const baseEntry = !isNewSession && effectiveFreshEntry ? reusableEntry : undefined;
  const usageFamilyKey = previousSessionEntry
    ? (previousSessionEntry.usageFamilyKey ?? sessionKey)
    : baseEntry?.usageFamilyKey;
  const usageFamilySessionIds = previousSessionEntry
    ? Array.from(
        new Set([
          ...(previousSessionEntry.usageFamilySessionIds ?? []),
          previousSessionEntry.sessionId,
          sessionId,
        ]),
      )
    : baseEntry?.usageFamilySessionIds;
  // Track the originating channel/to for announce routing (subagent announce-back).
  const originatingChannelRaw = ctx.OriginatingChannel as string | undefined;
  const isInterSession = isInterSessionInputProvenance(ctx.InputProvenance);
  // Automated heartbeat/cron/exec turns run inside the conversation session,
  // but they must not rewrite the session's remembered external delivery route.
  // Otherwise a heartbeat target like "group:..." or a synthetic sender like
  // "heartbeat" leaks into the shared session and later user replies route to
  // the wrong chat.
  const baseDeliveryContext = deliveryContextFromSession(baseEntry);
  const baseDeliveryRoute = sessionDeliveryRoute(baseEntry);
  const baseDeliveryOrigin = sessionDeliveryOrigin(baseEntry);
  const deliveryRoute = isSystemEvent
    ? { channel: baseDeliveryContext?.channel, to: baseDeliveryContext?.to }
    : resolveSessionDeliveryRoute({
        originatingChannelRaw,
        originatingToRaw: ctx.OriginatingTo,
        toRaw: ctx.To,
        persistedLastTo: baseDeliveryContext?.to,
        persistedLastChannel: baseDeliveryContext?.channel,
        sessionKey,
        isInterSession,
      });
  const { channel: lastChannelRaw, to: lastToRaw } = deliveryRoute;
  const lastAccountIdRaw = isSystemEvent
    ? baseDeliveryContext?.accountId
    : resolveSessionDefaultAccountId({
        cfg,
        channelRaw: lastChannelRaw,
        accountIdRaw: ctx.AccountId,
        persistedLastAccountId: baseDeliveryContext?.accountId,
      });
  // Internal turns share the established external route and must not erase its
  // thread. External non-thread turns still clear stale thread routing.
  const preservePersistedThread = isThread || isInternalMessageChannel(originatingChannelRaw);
  const lastThreadIdRaw = isSystemEvent
    ? baseDeliveryContext?.threadId
    : (ctx.MessageThreadId ??
      ctx.TransportThreadId ??
      (preservePersistedThread ? baseDeliveryContext?.threadId : undefined));
  const delivery = isSystemEvent
    ? normalizeSessionDeliveryState({
        route: isThread ? baseDeliveryRoute : stripThreadFromSessionRoute(baseDeliveryRoute),
        context: isThread
          ? baseDeliveryContext
          : stripThreadIdFromDeliveryContext(baseDeliveryContext),
        origin: isThread ? baseDeliveryOrigin : stripThreadIdFromOrigin(baseDeliveryOrigin),
      })
    : normalizeSessionDeliveryState({
        context: {
          channel: lastChannelRaw,
          to: lastToRaw,
          accountId: lastAccountIdRaw,
          threadId: lastThreadIdRaw,
        },
        origin: baseDeliveryOrigin,
      });
  const creationStamp =
    !entry && ctx.SessionCreation ? buildSessionCreationStamp(ctx.SessionCreation) : undefined;
  sessionEntry = {
    ...baseEntry,
    ...preservedState,
    ...creationStamp,
    sessionId,
    lifecycleRevision: isNewSession ? crypto.randomUUID() : baseEntry?.lifecycleRevision,
    updatedAt: Date.now(),
    sessionStartedAt: isNewSession
      ? now
      : (baseEntry?.sessionStartedAt ?? lifecycleTimestamps.sessionStartedAt),
    lastInteractionAt: isSystemEvent ? baseEntry?.lastInteractionAt : now,
    agentStatus: isSystemEvent ? baseEntry?.agentStatus : undefined,
    systemSent,
    abortedLastRun: recoveredTerminalEntry ? undefined : abortedLastRun,
    pinnedAt: entry?.pinnedAt,
    usageFamilyKey,
    usageFamilySessionIds,
    previousSessionId: baseEntry?.previousSessionId,
    cliSessionIds: baseEntry?.cliSessionIds,
    cliSessionBindings: baseEntry?.cliSessionBindings,
    claudeCliSessionId: baseEntry?.claudeCliSessionId,
    sendPolicy: baseEntry?.sendPolicy,
    queueMode: baseEntry?.queueMode,
    queueDebounceMs: baseEntry?.queueDebounceMs,
    queueCap: baseEntry?.queueCap,
    queueDrop: baseEntry?.queueDrop,
    chatType: baseEntry?.chatType,
    delivery,
    groupId: baseEntry?.groupId,
    subject: baseEntry?.subject,
    groupChannel: baseEntry?.groupChannel,
    space: baseEntry?.space,
    groupActivation: entry?.groupActivation,
    groupActivationNeedsSystemIntro: entry?.groupActivationNeedsSystemIntro,
  };
  const metaPatch = deriveSessionMetaPatch({
    ctx: sessionCtxForState,
    sessionKey,
    existing: sessionEntry,
    groupResolution,
    skipSystemEventOrigin: isSystemEvent,
  });
  if (metaPatch) {
    sessionEntry = { ...sessionEntry, ...metaPatch };
  }
  if (isSystemEvent && !isThread) {
    sessionEntry = {
      ...sessionEntry,
      delivery: normalizeSessionDeliveryState({
        route: stripThreadFromSessionRoute(sessionDeliveryRoute(sessionEntry)),
        context: stripThreadIdFromDeliveryContext(deliveryContextFromSession(sessionEntry)),
        origin: stripThreadIdFromOrigin(sessionDeliveryOrigin(sessionEntry)),
      }),
    };
  }
  if (!sessionEntry.chatType) {
    sessionEntry.chatType = "direct";
  }
  const threadLabel = normalizeOptionalString(ctx.ThreadLabel);
  if (threadLabel) {
    sessionEntry.displayName = threadLabel;
  }
  const alreadyForked = sessionEntryForkedFromParent(sessionEntry);
  if (params.signal?.aborted === true) {
    throw new Error("reply session initialization aborted");
  }
  if (isNewSession) {
    sessionEntry.compactionCount = 0;
    sessionEntry.memoryFlush = undefined;
    // Runtime model fields are persisted last-run cache, not user selection.
    // Reset must drop them so the next turn resolves current defaults or the
    // explicit providerOverride/modelOverride values preserved above.
    sessionEntry.modelProvider = undefined;
    sessionEntry.model = undefined;
    sessionEntry.fallbackNotice = undefined;
    sessionEntry.systemPromptReport = undefined;
    sessionEntry.startedAt = undefined;
    sessionEntry.endedAt = undefined;
    sessionEntry.runtimeMs = undefined;
    sessionEntry.status = undefined;
    // New empty transcripts have a known zero context. Parent-context forks
    // inherit history without a fresh count, so keep those explicitly unknown.
    sessionEntry.totalTokens = 0;
    sessionEntry.totalTokensFresh = true;
    sessionEntry.totalTokensVersion = SESSION_TOTAL_TOKENS_VERSION;
    sessionEntry.inputTokens = undefined;
    sessionEntry.outputTokens = undefined;
    sessionEntry.estimatedCostUsd = undefined;
    sessionEntry.cacheRead = undefined;
    sessionEntry.cacheWrite = undefined;
    sessionEntry.contextTokens = undefined;
    sessionEntry.contextTokensSource = undefined;
    sessionEntry.contextBudgetStatus = undefined;
    sessionEntry.goal = undefined;
    // Skills snapshots are prompt/runtime caches. Do not preserve a stale
    // snapshot through /new; the next turn must rebuild the visible skill list.
    sessionEntry.skillsSnapshot = undefined;
  }
  const continuityReason =
    previousSessionEndReason === "idle" || previousSessionEndReason === "daily"
      ? previousSessionEndReason
      : "reset";
  const resetBoundary: SessionResetBoundaryRequest | undefined = previousSessionEntry
    ? resetTriggered
      ? { context: "clear", reason: resolveExplicitSessionEndReason(matchedResetTriggerLower) }
      : { context: "preserve-tail", reason: continuityReason }
    : undefined;
  const resetBoundaryAppended = resetBoundary !== undefined;
  const committed = await commitReplySessionInitialization({
    activeSessionKey: sessionKey,
    agentId,
    archivePreviousTranscript: false,
    expectedRevision: initializationSnapshot.revision,
    maintenanceConfig,
    onArchiveError: (error, sourcePath) => {
      log.warn(
        `failed to archive previous session transcript ${sourcePath} for session ${previousSessionEntry?.sessionId}`,
        { error: String(error) },
      );
    },
    onMaintenanceWarning: (warning) =>
      deliverSessionMaintenanceWarning({
        cfg,
        sessionKey,
        entry: sessionEntry,
        warning,
      }),
    prepareSessionEntry: async ({ readEntry, sessionEntry: entryToCommit }) => {
      if (params.signal?.aborted === true) {
        throw new Error("reply session initialization aborted");
      }
      return await prepareReplySessionParentFork({
        agentId,
        alreadyForked,
        parentSessionKey,
        requireParentForkReplacement: restartTombstoneParentFork,
        readEntry,
        sessionEntry: entryToCommit,
        sessionKey,
        storePath,
        warn: (message) => log.warn(message),
      });
    },
    ...(resetBoundary ? { resetBoundary } : {}),
    beforeEntryMutation: ({ currentEntry, sessionEntry: entryToCommit }) => {
      if (!previousSessionEntry || !currentEntry) {
        return;
      }
      if (resetBoundaryAppended) {
        clearAllCliSessions(entryToCommit);
        entryToCommit.agentHarnessId = undefined;
      }
    },
    previousEntry: previousSessionEntry,
    ...(!isSystemEvent &&
    sessionCtxForState.InboundAccessAuthorized === true &&
    sessionCtxForState.ConversationRouteContextObserved === true
      ? { routeContext: conversationRouteContextFromMsgContext(sessionCtxForState) ?? null }
      : {}),
    retiredEntry: retiredLegacyMainDelivery,
    sessionEntry,
    sessionKey,
    snapshotEntry: initializationSnapshot.currentEntry,
    storePath,
  });
  if (!committed.ok) {
    if (!staleSnapshotRetried) {
      return await initSessionStateAttemptLocked(params, attemptContext, true, undefined);
    }
    // Propagate a typed conflict so initSessionState can retry with backoff
    // outside the store writer lane instead of surfacing this to the caller.
    throw new ReplySessionInitConflictError(sessionKey);
  }
  if (previousSessionEntry) {
    try {
      clearSessionResetRuntimeState([sessionKey, previousSessionEntry.sessionId], {
        activeReplySessionId: previousSessionEntry.sessionId,
        agentId,
        reason:
          previousSessionEndReason === "new" ||
          previousSessionEndReason === "reset" ||
          previousSessionEndReason === "idle" ||
          previousSessionEndReason === "daily"
            ? previousSessionEndReason
            : "reset",
      });
    } catch (error) {
      // The replacement is already durable. Runtime cleanup is best-effort and
      // must not turn a committed reset into a reported initialization failure.
      log.warn(`failed to clear reset runtime state for session ${sessionKey}: ${String(error)}`);
    }
  }
  sessionEntry = committed.sessionEntry;
  sessionId = sessionEntry.sessionId;
  // Admission may commit the first row before dispatch. Preserve its Goal and generation
  // through initialization, then report the first lifecycle only for that winning dispatch.
  const createdByAdmission =
    pinExpectedExistingSession &&
    params.newlyCreatedSessionId === sessionId &&
    !previousSessionEntry;
  const isFirstSessionTurn = isNewSession || createdByAdmission;
  if (!isSystemEvent && !isInterSession) {
    recordAcceptedSessionParticipantInput(ctx, {
      agentId,
      sessionKey,
      storePath,
      onError: (error) => log.warn("failed to record session participant", { error }),
    });
  }
  clearBootstrapSnapshotOnSessionBoundary({
    boundaryAppended: resetBoundaryAppended,
    sessionKey,
  });
  if (createdNewEntry) {
    recordSessionCreated({ sessionKey, agentId, entry: sessionEntry });
  }
  if (
    !isSystemEvent &&
    classifySessionStateActor({ inputProvenance: ctx.InputProvenance }).actorType === "human"
  ) {
    registerMainSessionGroupWatch({
      sessionKey,
      agentId,
      entry: sessionEntry,
      mainKey,
    });
  }
  const sessionStore = committed.sessionStoreView;
  const sessionEntryHandle = createReplySessionEntryHandle({
    sessionEntry,
    sessionKey,
    sessionStore,
  });
  const previousSessionTranscript = committed.previousSessionTranscript;
  if (previousSessionEntry?.sessionId) {
    emitSessionAutoResetHook({
      cfg,
      sessionId: previousSessionEntry.sessionId,
      sessionKey,
      reason: previousSessionEndReason,
      sessionFile: previousSessionTranscript.sessionFile,
      transcriptArchived: previousSessionTranscript.transcriptArchived,
      nextSessionId: sessionId,
      nextSessionKey: sessionKey,
      agentId,
      workspaceDir: previousSessionEntry.spawnedWorkspaceDir,
      storePath,
    });
  }

  if (previousSessionEntry?.sessionId) {
    await retireSessionMcpRuntime({
      sessionId: previousSessionEntry.sessionId,
      reason: "reply-session-rollover",
      onError: (error, sessionIdLocal) => {
        log.warn(`failed to dispose bundle MCP runtime for session ${sessionIdLocal}`, {
          error: String(error),
        });
      },
    });
    await resetRegisteredAgentHarnessSessions({
      agentId,
      sessionId: previousSessionEntry.sessionId,
      sessionKey,
      sessionFile: sessionKey,
      reason: previousSessionEndReason ?? "unknown",
    });
    // Direct-message browser tabs use a peer-scoped runtime identity even when
    // their transcript aliases main; cleanup must carry both exact keys.
    const runtimePolicySessionKey =
      resolveRuntimePolicySessionKey({
        agentId,
        cfg,
        ctx: sessionCtxForState,
        sessionKey,
      }) ?? sessionKey;
    void runWithGatewayIndependentRootWorkContinuation(async () => {
      await cleanupBrowserSessionsForLifecycleEnd({
        cfg,
        sessionKeys: [previousSessionEntry.sessionId, sessionKey, runtimePolicySessionKey],
        onWarn: (message) => log.warn(message),
        onError: (error) => log.warn(`browser tab cleanup failed: ${String(error)}`),
      });
    }).catch((error: unknown) => {
      log.warn(`browser tab cleanup admission failed: ${String(error)}`);
    });
  }

  const sessionCtx: TemplateContext = {
    ...sessionCtxForState,
    agentText: normalizeInboundTextNewlines(bodyStripped ?? sessionCtxForState.agentText),
    BodyStripped: normalizeInboundTextNewlines(bodyStripped ?? sessionCtxForState.agentText),
    SessionId: sessionId,
    IsNewSession: isFirstSessionTurn ? "true" : "false",
  };

  // Run session plugin hooks (fire-and-forget)
  const hookRunner = getGlobalHookRunner();
  if (hookRunner && isFirstSessionTurn) {
    const effectiveSessionId = sessionId ?? "";

    // If replacing an existing session, fire session_end for the old one
    if (previousSessionEntry?.sessionId) {
      // The shutdown finalizer must not re-fire session_end for a session
      // that is being replaced here; forget unconditionally so the next drain
      // skips this id even when no `session_end` plugin is currently attached.
      forgetActiveSessionForShutdown(previousSessionEntry.sessionId);
      if (hookRunner.hasHooks("session_end")) {
        const payload = buildSessionEndHookPayload({
          sessionId: previousSessionEntry.sessionId,
          sessionKey,
          agentId,
          reason: previousSessionEndReason,
          sessionFile: previousSessionTranscript.sessionFile,
          transcriptArchived: previousSessionTranscript.transcriptArchived,
          nextSessionId: effectiveSessionId,
        });
        void runWithGatewayIndependentRootWorkContinuation(async () => {
          await hookRunner.runSessionEnd(payload.event, payload.context);
        }).catch(() => {});
      }
    }

    // Fire session_start for the new session
    if (effectiveSessionId) {
      // Track the new session so the shutdown finalizer fires a typed
      // session_end with reason="shutdown"/"restart" if the gateway stops
      // while this session is still active (see #57790).
      noteActiveSessionForShutdown({
        cfg,
        sessionKey,
        sessionId: effectiveSessionId,
        storePath,
        sessionFile: sessionKey,
        agentId,
      });
    }
    if (hookRunner.hasHooks("session_start")) {
      const payload = buildSessionStartHookPayload({
        sessionId: effectiveSessionId,
        sessionKey,
        agentId,
        resumedFrom: previousSessionEntry?.sessionId,
      });
      void runWithGatewayIndependentRootWorkContinuation(async () => {
        await hookRunner.runSessionStart(payload.event, payload.context);
      }).catch(() => {});
    }
  }

  return {
    kind: "complete",
    result: {
      sessionCtx,
      sessionEntry,
      sessionEntryHandle,
      previousSessionEntry,
      sessionStore,
      sessionKey,
      sessionId: sessionId ?? crypto.randomUUID(),
      isNewSession: isFirstSessionTurn,
      resetTriggered,
      systemSent,
      abortedLastRun,
      storePath,
      sessionScope,
      groupResolution,
      isGroup,
      bodyStripped,
      triggerBodyNormalized,
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
