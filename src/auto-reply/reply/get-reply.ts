// Main auto-reply pipeline: prepares context, runs commands, and dispatches agents.
import fs from "node:fs/promises";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isImplicitAcpWorkspaceCandidate } from "../../agents/agent-scope-config.js";
import {
  hasLegacyAutoFallbackWithoutOrigin,
  resolveAutoFallbackPrimaryProbe,
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
  resolveAgentSkillsFilter,
} from "../../agents/agent-scope.js";
import { resolveConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import { projectConversationToolNames } from "../../agents/conversation-tool-policy-pipeline.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { resolveModelRefFromString } from "../../agents/model-selection.js";
import { publishedModelCatalogOwnerMatchesAgent } from "../../agents/prepared-model-catalog-owner.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { resolveEffectiveToolFsRootExpansionAllowed } from "../../agents/tool-fs-policy.js";
import { DEFAULT_AGENT_WORKSPACE_DIR, ensureAgentWorkspace } from "../../agents/workspace.js";
import { resolveChannelModelOverride } from "../../channels/model-overrides.js";
import { type OpenClawConfig, getRuntimeConfig } from "../../config/config.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import { isSessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import { logVerbose } from "../../globals.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { isFastTestRuntimeEnv } from "../../infra/env.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ApplyMediaUnderstandingResult } from "../../media-understanding/apply.js";
import type { ExtractedFileImage } from "../../media-understanding/extracted-file-images.js";
import { hasStagedMediaFacts, normalizeMediaFacts } from "../../media/media-facts.js";
import { defaultRuntime } from "../../runtime.js";
import {
  isModelSelectionLocked,
  ModelSelectionLockedError,
} from "../../sessions/model-overrides.js";
import { ensureSessionDiffBaseline } from "../../sessions/session-diff-baseline.js";
import { resolveStoredModelOverride } from "../../sessions/stored-model-overrides.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import {
  sessionDeliveryChannel,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.shared.js";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS, stripHeartbeatToken } from "../heartbeat.js";
import type { ReplyPayload } from "../reply-payload.js";
import type { RuntimeMsgContext as MsgContext } from "../templating.js";
import { normalizeThinkLevel, normalizeVerboseLevel } from "../thinking.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { resolveDefaultModel } from "./directive-handling.defaults.js";
import { resolveActiveExplicitSteerSessionKey } from "./explicit-steer-routing.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import {
  initFastReplySessionState,
  buildFastReplyCommandContext,
  shouldHandleFastReplyTextCommands,
  shouldUseReplyFastDirectiveExecution,
  resolveGetReplyConfig,
  shouldUseReplyFastTestBootstrap,
  shouldUseReplyFastTestRuntime,
} from "./get-reply-fast-path.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";
import { maybeResolveNativeSlashCommandFastReply } from "./get-reply-native-slash-fast-path.js";
import { runPreparedReply } from "./get-reply-run.js";
import type {
  InternalGetReplyOptions as BaseInternalGetReplyOptions,
  ReplySessionBinding,
} from "./get-reply.types.js";
import { finalizeInboundContext } from "./inbound-context.js";
import {
  hasInboundAudio,
  hasInboundMedia,
  hasInboundMediaForUnderstanding,
} from "./inbound-media.js";
import { emitPreAgentMessageHooks } from "./message-preprocess-hooks.js";
import { createFastTestModelSelectionState, createModelSelectionState } from "./model-selection.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import {
  PENDING_FINAL_DELIVERY_CLEAR_PATCH,
  sanitizePendingFinalDeliveryText,
} from "./pending-final-delivery.js";
import { getPreparedReplyDispatchRuntime } from "./prepared-reply-dispatch-context.js";
import { attachProgressNarratorToReplyOptions } from "./progress-narrator.js";
import { createReplyTimingTracker } from "./reply-timing-tracker.js";
import { resolveRuntimePolicySessionKey } from "./runtime-policy-session-key.js";
import { initSessionState, resolveReplySessionPreprocessingState } from "./session.js";
import { mergeSkillFilters } from "./skill-filter.js";
import { stageRemoteInboundMediaIfNeeded } from "./stage-remote-inbound-media.js";
import { isStaleHeartbeatAutoFallbackOverride } from "./stored-model-override.js";
import { createTypingController } from "./typing.js";

type ResetCommandAction = "new" | "reset";

type RuntimeInternalGetReplyOptions = BaseInternalGetReplyOptions & {
  onSessionPrepared?: (binding: ReplySessionBinding) => void;
  extractedFileImages?: ExtractedFileImage[];
};

function classifyHeartbeatPendingFinalDelivery(text: string, ackMaxChars: number) {
  const stripped = stripHeartbeatToken(text, {
    mode: "heartbeat",
    maxAckChars: ackMaxChars,
  });
  return {
    shouldClear: stripped.shouldSkip,
    replayText: stripped.didStrip && stripped.text ? stripped.text : text,
  };
}

const sessionResetModelRuntimeLoader = createLazyImportLoader(
  () => import("./session-reset-model.runtime.js"),
);
const stageSandboxMediaRuntimeLoader = createLazyImportLoader(
  () => import("./stage-sandbox-media.runtime.js"),
);
const mediaUnderstandingApplyRuntimeLoader = createLazyImportLoader(
  () => import("../../media-understanding/apply.runtime.js"),
);
const linkUnderstandingApplyRuntimeLoader = createLazyImportLoader(
  () => import("../../link-understanding/apply.runtime.js"),
);
const replyResolverTimingLog = createSubsystemLogger("auto-reply/reply-resolver-timing");
const commandsCoreRuntimeLoader = createLazyImportLoader(
  () => import("./commands-core.runtime.js"),
);

function loadSessionResetModelRuntime() {
  return sessionResetModelRuntimeLoader.load();
}

function loadStageSandboxMediaRuntime() {
  return stageSandboxMediaRuntimeLoader.load();
}

function loadMediaUnderstandingApplyRuntime() {
  return mediaUnderstandingApplyRuntimeLoader.load();
}

function loadLinkUnderstandingApplyRuntime() {
  return linkUnderstandingApplyRuntimeLoader.load();
}

function loadCommandsCoreRuntime() {
  return commandsCoreRuntimeLoader.load();
}

function hasLinkCandidate(ctx: MsgContext): boolean {
  const message = ctx.commandText;
  if (!message) {
    return false;
  }
  return /\bhttps?:\/\/\S+/i.test(message);
}

async function applyMediaUnderstandingIfNeeded(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  activeModel: { provider: string; model: string };
  processingMode?: "audio-only";
  selfServeLocalPaths?: boolean;
}): Promise<ApplyMediaUnderstandingResult | undefined> {
  if (!hasInboundMediaForUnderstanding(params.ctx)) {
    return undefined;
  }
  try {
    const { applyMediaUnderstanding } = await loadMediaUnderstandingApplyRuntime();
    return await applyMediaUnderstanding(params);
  } catch (err) {
    mediaUnderstandingApplyRuntimeLoader.clear();
    logVerbose(
      `media understanding failed, proceeding with raw content: ${formatErrorMessage(err)}`,
    );
    return undefined;
  }
}

function hasExplicitAudioUnderstandingConfig(cfg: OpenClawConfig): boolean {
  const audio = cfg.tools?.media?.audio;
  return audio !== undefined && audio.enabled !== false;
}

function canSelfServeLocalPaths(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  sessionKey?: string;
  workspaceDir: string;
  provider: string;
  model: string;
  opts?: GetReplyOptions;
  senderIsOwner: boolean;
  spawnedBy?: string;
  stagedPathsAvailable: boolean;
}): boolean {
  if (params.opts?.disableTools === true) {
    return false;
  }
  const policySessionKey = resolveRuntimePolicySessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    ctx: params.ctx,
    sessionKey: params.sessionKey,
  });
  const sandboxed = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    classificationSessionKey: policySessionKey,
  }).sandboxed;
  if (
    (sandboxed && !params.stagedPathsAvailable) ||
    (!sandboxed &&
      !resolveEffectiveToolFsRootExpansionAllowed({ cfg: params.cfg, agentId: params.agentId }))
  ) {
    return false;
  }
  const capabilityProfile = resolveConversationCapabilityProfile({
    config: params.cfg,
    sessionKey: policySessionKey,
    runSessionKey: policySessionKey === params.sessionKey ? undefined : params.sessionKey,
    agentId: params.agentId,
    agentDir: params.agentDir,
    agentAccountId: params.ctx.AccountId,
    messageProvider: resolveOriginMessageProvider({
      originatingChannel: params.ctx.OriginatingChannel,
      provider: params.ctx.Provider ?? params.ctx.Surface,
    }),
    chatType: params.ctx.ChatType,
    conversationToolPolicy: params.ctx.ConversationToolPolicy,
    groupId: resolveGroupSessionKey(params.ctx)?.id,
    groupChannel:
      normalizeOptionalString(params.ctx.GroupChannel) ??
      normalizeOptionalString(params.ctx.GroupSubject),
    groupSpace: normalizeOptionalString(params.ctx.GroupSpace),
    memberRoleIds: params.ctx.MemberRoleIds,
    spawnedBy: params.spawnedBy,
    senderId: normalizeOptionalString(params.ctx.SenderId),
    senderName: normalizeOptionalString(params.ctx.SenderName),
    senderUsername: normalizeOptionalString(params.ctx.SenderUsername),
    senderE164: normalizeOptionalString(params.ctx.SenderE164),
    senderIsOwner: params.senderIsOwner,
    modelProvider: params.provider,
    modelId: params.model,
    workspaceDir: params.workspaceDir,
    runtimeToolAllowlist: params.opts?.toolsAllow,
    inheritRuntimeToolAllowlist: true,
    inputProvenance: params.ctx.InputProvenance,
  });
  return (
    projectConversationToolNames({
      capabilityProfile,
      toolNames: ["read"],
      warn: () => {},
    }).length === 1
  );
}

function collectStagedAttachmentPaths(ctx: MsgContext): ReadonlyMap<number, string> {
  return new Map(
    normalizeMediaFacts(ctx.media).flatMap((fact, index) => {
      const mediaPath = normalizeOptionalString(fact.path);
      return mediaPath ? [[index, mediaPath] as const] : [];
    }),
  );
}

function withExtractedFileImages(
  opts: RuntimeInternalGetReplyOptions | undefined,
  extractedFileImages: ExtractedFileImage[] | undefined,
): RuntimeInternalGetReplyOptions | undefined {
  if (!extractedFileImages || extractedFileImages.length === 0) {
    return opts;
  }
  return {
    ...opts,
    extractedFileImages: [...(opts?.extractedFileImages ?? []), ...extractedFileImages],
  };
}

async function applyLinkUnderstandingIfNeeded(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
}): Promise<boolean> {
  if (!hasLinkCandidate(params.ctx)) {
    return false;
  }
  try {
    const { applyLinkUnderstanding } = await loadLinkUnderstandingApplyRuntime();
    await applyLinkUnderstanding(params);
    return true;
  } catch (err) {
    linkUnderstandingApplyRuntimeLoader.clear();
    logVerbose(
      `link understanding failed, proceeding with raw content: ${formatErrorMessage(err)}`,
    );
    return false;
  }
}

export async function getReplyFromConfig(
  ctx: MsgContext,
  opts?: GetReplyOptions,
  configOverride?: OpenClawConfig,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const isFastTestEnv = isFastTestRuntimeEnv();
  const preparedReplyDispatchRuntime = configOverride
    ? undefined
    : getPreparedReplyDispatchRuntime();
  const cfg =
    preparedReplyDispatchRuntime?.config ??
    resolveGetReplyConfig({
      getRuntimeConfig,
      isFastTestEnv,
      configOverride,
    });
  // Profiler spans stay inert unless diagnostics enable `profiler` or
  // `reply.profiler`, so normal replies do not pay per-stage Date.now/array
  // bookkeeping while we can still split resolver costs on demand.
  const resolverTiming = createReplyTimingTracker({ log: replyResolverTimingLog, config: cfg });
  const useFastTestBootstrap = resolverTiming.measureSync("reply.resolve_fast_test_bootstrap", () =>
    shouldUseReplyFastTestBootstrap({
      isFastTestEnv,
      configOverride,
    }),
  );
  const useFastTestRuntime = resolverTiming.measureSync("reply.resolve_fast_test_runtime", () =>
    shouldUseReplyFastTestRuntime({
      cfg,
      isFastTestEnv,
    }),
  );
  const inboundMediaWasAlreadyStaged = hasStagedMediaFacts(ctx.media);
  const finalized = resolverTiming.measureSync("reply.finalize_context", () =>
    finalizeInboundContext(ctx),
  );
  // Resolve legacy text-slash source lanes before any session-scoped work.
  // The explicit steer command itself still flows through normal command and
  // prepared-reply handling; this only gives that path the active owner's key.
  const explicitSteerTargetSessionKey = resolverTiming.measureSync(
    "reply.resolve_explicit_steer_target",
    () => resolveActiveExplicitSteerSessionKey({ cfg, ctx: finalized }),
  );
  if (explicitSteerTargetSessionKey) {
    finalized.CommandTargetSessionKey = explicitSteerTargetSessionKey;
  }
  const initialAgentScope = resolverTiming.measureSync("reply.resolve_agent_scope", () => {
    const targetSessionKey = resolveCommandTurnTargetSessionKey(finalized);
    const resolvedAgentSessionKey = targetSessionKey || finalized.SessionKey;
    return {
      agentSessionKey: resolvedAgentSessionKey,
      agentId: resolveSessionAgentId({
        sessionKey: resolvedAgentSessionKey,
        config: cfg,
        fallbackAgentId: finalized.AgentId,
      }),
    };
  });
  const agentSessionKey = initialAgentScope.agentSessionKey;
  const agentId = initialAgentScope.agentId;
  if (
    preparedReplyDispatchRuntime &&
    !publishedModelCatalogOwnerMatchesAgent(preparedReplyDispatchRuntime, agentId)
  ) {
    throw new Error(
      `reply model catalog owner changed from ${agentId} to ${preparedReplyDispatchRuntime.agentId}`,
    );
  }
  const preparedAgentDir = preparedReplyDispatchRuntime?.agentDir;
  const preparedWorkspaceDir = preparedReplyDispatchRuntime?.workspaceDir;
  const preparedModelCatalog: ModelCatalogSnapshot | undefined =
    preparedReplyDispatchRuntime?.modelCatalog;
  const traceAttributes = resolverTiming.measureSync("reply.resolve_trace_context", () => ({
    surface: normalizeOptionalString(finalized.Surface ?? finalized.Provider) ?? "unknown",
    hasSessionKey: Boolean(agentSessionKey),
    isHeartbeat: opts?.isHeartbeat === true,
    hasMedia: hasInboundMedia(finalized),
  }));
  const messageId = finalized.MessageSid ?? finalized.MessageSidFirst ?? finalized.MessageSidLast;
  let resolverTimingSessionKey = agentSessionKey;
  const logResolverTiming = (outcome: string, reason?: string, error?: string) =>
    resolverTiming.logIfSlow({
      message: `reply resolver timings surface=${traceAttributes.surface} messageId=${
        messageId ?? "unknown"
      } sessionKey=${resolverTimingSessionKey ?? "unknown"} agentId=${agentId}`,
      outcome,
      reason,
      error,
      details: {
        surface: traceAttributes.surface,
        messageId,
        sessionKey: resolverTimingSessionKey,
        agentId,
      },
    });
  const traceGetReplyPhase = <T>(name: string, run: () => Promise<T> | T): Promise<T> =>
    resolverTiming.measure(name, () =>
      measureDiagnosticsTimelineSpan(name, run, {
        phase: "agent-turn",
        config: cfg,
        attributes: traceAttributes,
      }),
    );
  const mergedSkillFilter = resolverTiming.measureSync("reply.resolve_skill_filter", () =>
    mergeSkillFilters(opts?.skillFilter, resolveAgentSkillsFilter(cfg, agentId)),
  );
  const optsWithSkillFilter =
    mergedSkillFilter !== undefined ? { ...opts, skillFilter: mergedSkillFilter } : opts;
  const internalOptsWithSkillFilter = optsWithSkillFilter as
    | RuntimeInternalGetReplyOptions
    | undefined;
  let extractedFileImages: ExtractedFileImage[] | undefined;
  let enableLocalPathSelfServe: ApplyMediaUnderstandingResult["enableLocalPathSelfServe"];
  const agentCfg = cfg.agents?.defaults;
  const agentEntry = resolveAgentConfig(cfg, agentId);
  const configuredThinkingDefault =
    normalizeThinkLevel(agentEntry?.thinkingDefault) ??
    normalizeThinkLevel(agentCfg?.thinkingDefault);
  const sessionCfg = cfg.session;
  const { defaultProvider, defaultModel, aliasIndex } = resolverTiming.measureSync(
    "reply.resolve_default_model",
    () =>
      resolveDefaultModel({
        cfg,
        agentId,
      }),
  );
  let provider = defaultProvider;
  let model = defaultModel;
  let hasResolvedHeartbeatModelOverride = false;
  if (opts?.isHeartbeat) {
    // Prefer the resolved per-agent heartbeat model passed from the heartbeat runner,
    // fall back to the global defaults heartbeat model for backward compatibility.
    const heartbeatRaw =
      normalizeOptionalString(opts.heartbeatModelOverride) ??
      normalizeOptionalString(agentCfg?.heartbeat?.model) ??
      "";
    const heartbeatRef = heartbeatRaw
      ? resolveModelRefFromString({
          cfg,
          agentId,
          raw: heartbeatRaw,
          defaultProvider,
          aliasIndex,
        })
      : null;
    if (heartbeatRef) {
      provider = heartbeatRef.ref.provider;
      model = heartbeatRef.ref.model;
      hasResolvedHeartbeatModelOverride = true;
    }
  }

  const { workspaceDirRaw, workspaceDirForNativeCommand, agentDir, timeoutMs } =
    resolverTiming.measureSync("reply.resolve_workspace_agent_dir", () => {
      const workspaceDirRawLocal =
        preparedWorkspaceDir ??
        resolveAgentWorkspaceDir(cfg, agentId) ??
        DEFAULT_AGENT_WORKSPACE_DIR;
      return {
        workspaceDirRaw: workspaceDirRawLocal,
        workspaceDirForNativeCommand: workspaceDirRawLocal,
        agentDir: preparedAgentDir ?? resolveAgentDir(cfg, agentId),
        timeoutMs: resolveAgentTimeoutMs({
          cfg,
          overrideSeconds: opts?.timeoutOverrideSeconds,
        }),
      };
    });
  const typing = resolverTiming.measureSync("reply.create_typing_controller", () => {
    const configuredTypingSeconds = agentCfg?.typingIntervalSeconds;
    const typingIntervalSeconds =
      typeof configuredTypingSeconds === "number" ? configuredTypingSeconds : 6;
    const controller = createTypingController({
      onReplyStart: opts?.onReplyStart,
      onCleanup: opts?.onTypingCleanup,
      typingIntervalSeconds,
      keepalive: opts?.typingKeepalive ?? true,
      silentToken: SILENT_REPLY_TOKEN,
      log: defaultRuntime.log,
    });
    opts?.onTypingController?.(controller);
    return controller;
  });

  const nativeSlashCommandFastReply = await traceGetReplyPhase(
    "reply.native_slash_command_fast_path",
    () =>
      maybeResolveNativeSlashCommandFastReply({
        ctx: finalized,
        cfg,
        agentId,
        agentDir,
        agentCfg,
        commandAuthorized: finalized.CommandAuthorized,
        defaultProvider,
        defaultModel,
        aliasIndex,
        provider,
        model,
        workspaceDir: workspaceDirForNativeCommand,
        typing,
        opts: optsWithSkillFilter,
        skillFilter: mergedSkillFilter,
      }),
  );
  if (nativeSlashCommandFastReply.handled) {
    logResolverTiming("completed", "native_slash_command_fast_path");
    return nativeSlashCommandFastReply.reply;
  }
  const optsWithCommandQueueOverride = nativeSlashCommandFastReply.queueModeOverride
    ? { ...optsWithSkillFilter, queueModeOverride: nativeSlashCommandFastReply.queueModeOverride }
    : optsWithSkillFilter;

  const acpWorkspaceProvisioningInput = isImplicitAcpWorkspaceCandidate(cfg, agentId)
    ? await traceGetReplyPhase("reply.resolve_acp_workspace_provisioning", async () => {
        // Implicit ACP agents need the live session's ACP meta (per-session cwd
        // from /acp spawn --cwd or /acp cwd) before workspace scaffolding runs.
        const state = resolveReplySessionPreprocessingState({ ctx: finalized, cfg });
        return {
          cfg,
          agentId,
          sessionKey: state.sessionKey,
          ...(state.sessionEntry ? { sessionEntry: state.sessionEntry } : {}),
        };
      })
    : { cfg, agentId, ...(agentSessionKey ? { sessionKey: agentSessionKey } : {}) };

  const workspace = await traceGetReplyPhase("reply.ensure_workspace", async () =>
    useFastTestBootstrap
      ? (await fs.mkdir(workspaceDirRaw, { recursive: true }), { dir: workspaceDirRaw })
      : await ensureAgentWorkspace({
          dir: workspaceDirRaw,
          ensureBootstrapFiles: !agentCfg?.skipBootstrap && !isFastTestEnv,
          skipOptionalBootstrapFiles: agentCfg?.skipOptionalBootstrapFiles,
          provisioning: await (
            await import("../../agents/acp-workspace-provisioning.js")
          ).resolveAcpAgentWorkspaceProvisioningForTurn(acpWorkspaceProvisioningInput),
        }),
  );
  const workspaceDir = workspace.dir;

  if (
    !isFastTestEnv &&
    !inboundMediaWasAlreadyStaged &&
    normalizeOptionalString(finalized.MediaRemoteHost) &&
    hasInboundMedia(finalized)
  ) {
    await traceGetReplyPhase("reply.stage_remote_media_pre_understanding", () =>
      stageRemoteInboundMediaIfNeeded({
        ctx: finalized,
        cfg,
        agentId,
        sessionKey: agentSessionKey,
        workspaceDir,
      }),
    );
  }

  const mediaUnderstandingRequested = !isFastTestEnv && hasInboundMediaForUnderstanding(finalized);
  const linkUnderstandingRequested = !isFastTestEnv && hasLinkCandidate(finalized);
  const preprocessingState =
    mediaUnderstandingRequested || linkUnderstandingRequested
      ? await traceGetReplyPhase("reply.resolve_session_preprocessing_state", () =>
          resolveReplySessionPreprocessingState({ ctx: finalized, cfg }),
        )
      : undefined;
  const utilityModelSelectionLocked = isModelSelectionLocked(preprocessingState?.sessionEntry);

  if (mediaUnderstandingRequested) {
    const shouldApplyLockedAudio =
      utilityModelSelectionLocked &&
      hasInboundAudio(finalized) &&
      hasExplicitAudioUnderstandingConfig(cfg);
    // Native harnesses own image, video, and file interpretation. They cannot
    // transcribe audio, so an explicitly configured STT pipeline still runs alone.
    if (!utilityModelSelectionLocked || shouldApplyLockedAudio) {
      const mediaResult = await traceGetReplyPhase("reply.apply_media_understanding", () =>
        applyMediaUnderstandingIfNeeded({
          ctx: finalized,
          cfg,
          agentId,
          agentDir,
          workspaceDir,
          activeModel: { provider, model },
          // Cache and classify now; the final provider and owner policy are
          // resolved later, immediately before the embedded turn starts.
          selfServeLocalPaths: false,
          ...(shouldApplyLockedAudio ? { processingMode: "audio-only" as const } : {}),
        }),
      );
      if (mediaResult?.extractedFileImages.length) {
        extractedFileImages = mediaResult.extractedFileImages;
      }
      enableLocalPathSelfServe = mediaResult?.enableLocalPathSelfServe;
    }
  }
  if (linkUnderstandingRequested && !utilityModelSelectionLocked) {
    await traceGetReplyPhase("reply.apply_link_understanding", () =>
      applyLinkUnderstandingIfNeeded({
        ctx: finalized,
        cfg,
      }),
    );
  }
  emitPreAgentMessageHooks({
    ctx: finalized,
    cfg,
    isFastTestEnv,
  });

  const commandAuthorized = finalized.CommandAuthorized;
  let sessionState: Awaited<ReturnType<typeof initSessionState>>;
  try {
    sessionState = useFastTestBootstrap
      ? initFastReplySessionState({
          ctx: finalized,
          cfg,
          agentId,
          commandAuthorized,
          workspaceDir,
        })
      : await traceGetReplyPhase("reply.init_session_state", () =>
          initSessionState({
            ctx: finalized,
            cfg,
            commandAuthorized,
            ...(internalOptsWithSkillFilter?.expectedExistingSessionId
              ? { expectedExistingSessionId: internalOptsWithSkillFilter.expectedExistingSessionId }
              : {}),
            pinExpectedExistingSession:
              internalOptsWithSkillFilter?.pinExpectedExistingSession === true,
            newlyCreatedSessionId: internalOptsWithSkillFilter?.newlyCreatedSessionId,
            requestedSessionId: internalOptsWithSkillFilter?.requestedSessionId,
            resumeRequestedSession: internalOptsWithSkillFilter?.resumeRequestedSession,
            signal: internalOptsWithSkillFilter?.abortSignal,
          }),
        );
  } catch (error) {
    if (error instanceof ModelSelectionLockedError) {
      typing.cleanup();
      return { text: error.message };
    }
    throw error;
  }
  if (!useFastTestBootstrap) {
    try {
      const baselineEntry = await traceGetReplyPhase("reply.capture_session_diff_baseline", () =>
        ensureSessionDiffBaseline({
          cwd:
            normalizeOptionalString(sessionState.sessionEntry.spawnedCwd) ??
            normalizeOptionalString(sessionState.sessionEntry.spawnedWorkspaceDir) ??
            workspaceDir,
          entry: sessionState.sessionEntry,
          isNewSession: sessionState.isNewSession,
          sessionKey: sessionState.sessionKey,
          storePath: sessionState.storePath,
        }),
      );
      sessionState.sessionEntry = baselineEntry;
      sessionState.sessionEntryHandle.replaceCurrent(baselineEntry);
      sessionState.sessionStore[sessionState.sessionKey] = baselineEntry;
    } catch (error) {
      if (isSessionWorkStartInvalidatedError(error)) {
        throw error;
      }
      logVerbose(
        `session diff baseline capture failed; continuing without attribution filtering: ${formatErrorMessage(error)}`,
      );
    }
  }
  const {
    sessionCtx,
    sessionEntry,
    initialSessionEntry,
    sessionEntryHandle,
    previousSessionEntry,
    previousSessionMemory,
    previousSessionResetMessages,
    sessionStore,
    sessionKey,
    sessionId,
    isNewSession,
    resetTriggered,
    systemSent,
    storePath,
    sessionScope,
    groupResolution,
    isGroup,
    triggerBodyNormalized,
    bodyStripped,
  } = sessionState;
  const sessionModelSelectionLocked = isModelSelectionLocked(sessionEntry);
  if (sessionModelSelectionLocked && hasResolvedHeartbeatModelOverride) {
    // Heartbeat routing is turn-local. A native harness lock owns the durable
    // model selection, so heartbeat.model must not retarget its AppServer turn.
    provider = defaultProvider;
    model = defaultModel;
    hasResolvedHeartbeatModelOverride = false;
  }
  // Utility-model narration is turn-local decoration. Initialize the durable
  // session first, then keep it completely outside model-locked native runs.
  const optsWithSessionSkillOverrides = sessionEntry.toolOverrides?.skills
    ? { ...optsWithCommandQueueOverride, skillOverrides: sessionEntry.toolOverrides.skills }
    : optsWithCommandQueueOverride;
  const resolvedOpts = attachProgressNarratorToReplyOptions({
    cfg,
    agentId,
    userMessage: finalized.agentText,
    opts: optsWithSessionSkillOverrides,
    disabled: sessionModelSelectionLocked,
  });
  const internalResolvedOpts = resolvedOpts as RuntimeInternalGetReplyOptions | undefined;
  let { abortedLastRun } = sessionState;
  resolverTimingSessionKey = sessionKey ?? resolverTimingSessionKey;
  internalResolvedOpts?.onSessionPrepared?.({
    sessionKey,
    sessionId,
    storePath,
  });

  if (sessionEntry?.pendingFinalDelivery?.kind === "replayable") {
    const text = sanitizePendingFinalDeliveryText(sessionEntry.pendingFinalDelivery.text);

    // Heartbeats may safely clear ack-only pending state, but must not replay
    // user-facing pending finals through a different delivery target.
    if (opts?.isHeartbeat) {
      const heartbeatPending = classifyHeartbeatPendingFinalDelivery(
        text,
        DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
      );
      if (heartbeatPending.shouldClear) {
        Object.assign(sessionEntry, PENDING_FINAL_DELIVERY_CLEAR_PATCH);
        sessionEntryHandle.replaceCurrent(sessionEntry);
        if (sessionKey && sessionStore) {
          sessionStore[sessionKey] = sessionEntry;
        }
        if (sessionKey && storePath) {
          const { updateSessionEntry } = await import("../../config/sessions/session-accessor.js");
          await updateSessionEntry(
            { storePath, sessionKey },
            () => ({ ...PENDING_FINAL_DELIVERY_CLEAR_PATCH }),
            {
              skipMaintenance: true,
              takeCacheOwnership: true,
            },
          );
        }
      }
    }
  }

  if (resetTriggered && normalizeOptionalString(bodyStripped)) {
    const { applyResetModelOverride } = await loadSessionResetModelRuntime();
    try {
      await applyResetModelOverride({
        cfg,
        agentId,
        agentDir,
        workspaceDir,
        resetTriggered,
        bodyStripped,
        sessionCtx,
        ctx: finalized,
        sessionEntry,
        sessionEntryHandle,
        sessionStore,
        sessionKey,
        storePath,
        defaultProvider,
        defaultModel,
        aliasIndex,
      });
    } catch (error) {
      if (error instanceof ModelSelectionLockedError) {
        typing.cleanup();
        return { text: error.message };
      }
      if (!isSessionWorkStartInvalidatedError(error)) {
        throw error;
      }
      typing.cleanup();
      return { text: error.message };
    }
  }

  const channelModelOverride = cfg.channels?.modelByChannel
    ? resolveChannelModelOverride({
        cfg,
        channel:
          groupResolution?.channel ??
          sessionDeliveryChannel(sessionEntry) ??
          (typeof finalized.OriginatingChannel === "string"
            ? finalized.OriginatingChannel
            : undefined) ??
          finalized.Provider,
        groupId: groupResolution?.id ?? sessionEntry.groupId,
        groupChatType: sessionEntry.chatType ?? sessionCtx.ChatType ?? finalized.ChatType,
        groupChannel:
          sessionEntry.groupChannel ?? sessionCtx.GroupChannel ?? finalized.GroupChannel,
        groupSubject: sessionEntry.subject ?? sessionCtx.GroupSubject ?? finalized.GroupSubject,
        parentSessionKey: sessionCtx.ModelParentSessionKey ?? sessionCtx.ParentSessionKey,
        directUserIds: [
          sessionDeliveryOrigin(sessionEntry)?.nativeDirectUserId,
          sessionDeliveryOrigin(sessionEntry)?.from,
          sessionDeliveryOrigin(sessionEntry)?.to,
          finalized.OriginatingTo,
          finalized.From,
          finalized.SenderId,
        ],
      })
    : null;
  const resolvedChannelModelOverride =
    channelModelOverride && !hasResolvedHeartbeatModelOverride && !sessionModelSelectionLocked
      ? resolveModelRefFromString({
          cfg,
          agentId,
          raw: channelModelOverride.model,
          defaultProvider,
          aliasIndex,
        })
      : null;
  const primaryProvider = resolvedChannelModelOverride?.ref.provider ?? defaultProvider;
  const primaryModel = resolvedChannelModelOverride?.ref.model ?? defaultModel;
  const hasSessionModelOverride = Boolean(
    normalizeOptionalString(sessionEntry.modelOverride) ||
    normalizeOptionalString(sessionEntry.providerOverride),
  );
  const storedModelOverride = resolveStoredModelOverride({
    sessionEntry,
    sessionStore,
    sessionKey,
    parentSessionKey:
      sessionEntry.parentSessionKey ??
      sessionCtx.ModelParentSessionKey ??
      sessionCtx.ParentSessionKey,
    defaultProvider,
  });
  const staleHeartbeatAutoFallbackOverride =
    !sessionModelSelectionLocked &&
    isStaleHeartbeatAutoFallbackOverride({
      isHeartbeat: opts?.isHeartbeat === true,
      hasResolvedHeartbeatModelOverride,
      sessionEntry,
      storedOverride: storedModelOverride,
      defaultProvider,
      defaultModel,
      primaryProvider,
      primaryModel,
    });
  const staleLegacyAutoFallbackWithoutOrigin =
    !sessionModelSelectionLocked &&
    storedModelOverride?.source === "session" &&
    hasLegacyAutoFallbackWithoutOrigin(sessionEntry);
  if (
    storedModelOverride?.model &&
    !hasResolvedHeartbeatModelOverride &&
    !staleHeartbeatAutoFallbackOverride &&
    !staleLegacyAutoFallbackWithoutOrigin
  ) {
    provider = storedModelOverride.provider ?? defaultProvider;
    model = storedModelOverride.model;
  }
  const canApplyAutoFallbackPrimaryProbe =
    !sessionModelSelectionLocked &&
    !hasResolvedHeartbeatModelOverride &&
    !staleHeartbeatAutoFallbackOverride;
  const autoFallbackPrimaryProbe = canApplyAutoFallbackPrimaryProbe
    ? resolveAutoFallbackPrimaryProbe({
        entry: sessionEntry,
        sessionKey,
        primaryProvider,
        primaryModel,
      })
    : undefined;
  const hasEffectiveStoredModelOverride =
    Boolean(storedModelOverride || hasSessionModelOverride) &&
    !staleHeartbeatAutoFallbackOverride &&
    !staleLegacyAutoFallbackWithoutOrigin;
  if (
    !hasResolvedHeartbeatModelOverride &&
    !hasEffectiveStoredModelOverride &&
    resolvedChannelModelOverride
  ) {
    provider = resolvedChannelModelOverride.ref.provider;
    model = resolvedChannelModelOverride.ref.model;
  }

  if (
    shouldUseReplyFastDirectiveExecution({
      isFastTestBootstrap: useFastTestRuntime,
      isGroup,
      isHeartbeat: opts?.isHeartbeat === true,
      resetTriggered,
      triggerBodyNormalized,
    })
  ) {
    const fastCommand = buildFastReplyCommandContext({
      ctx: finalized,
      cfg,
      agentId,
      sessionKey,
      isGroup,
      triggerBodyNormalized,
      commandAuthorized,
    });
    if (
      enableLocalPathSelfServe &&
      canSelfServeLocalPaths({
        ctx: sessionCtx,
        cfg,
        agentId,
        agentDir,
        sessionKey,
        workspaceDir,
        provider: autoFallbackPrimaryProbe?.provider ?? provider,
        model: autoFallbackPrimaryProbe?.model ?? model,
        opts: resolvedOpts,
        senderIsOwner: fastCommand.senderIsOwner,
        spawnedBy: normalizeOptionalString(sessionEntry.spawnedBy),
        stagedPathsAvailable: false,
      })
    ) {
      enableLocalPathSelfServe([finalized, sessionCtx]);
    }
    logResolverTiming("milestone", "before_fast_directive_prepared_reply");
    const fastReplyResult = await traceGetReplyPhase("reply.run_prepared_reply", () =>
      runPreparedReply({
        ctx,
        sessionCtx,
        cfg,
        agentId,
        agentDir,
        agentCfg,
        sessionCfg,
        commandAuthorized,
        command: fastCommand,
        commandSource: finalized.commandText,
        allowTextCommands: shouldHandleFastReplyTextCommands({
          cfg,
          commandSource: finalized.CommandSource,
        }),
        directives: clearInlineDirectives(finalized.commandText),
        defaultActivation: "always",
        resolvedThinkLevel: undefined,
        resolvedVerboseLevel: normalizeVerboseLevel(agentCfg?.verboseDefault),
        resolvedReasoningLevel: "off",
        resolvedElevatedLevel: "off",
        execOverrides: undefined,
        elevatedEnabled: false,
        elevatedAllowed: false,
        blockStreamingEnabled: false,
        blockReplyChunking: undefined,
        resolvedBlockStreamingBreak: "text_end",
        modelState: createFastTestModelSelectionState({
          agentCfg,
          provider: autoFallbackPrimaryProbe?.provider ?? provider,
          model: autoFallbackPrimaryProbe?.model ?? model,
        }),
        provider: autoFallbackPrimaryProbe?.provider ?? provider,
        model: autoFallbackPrimaryProbe?.model ?? model,
        perMessageQueueMode: undefined,
        perMessageQueueOptions: undefined,
        typing,
        opts: withExtractedFileImages(resolvedOpts, extractedFileImages),
        defaultModel,
        timeoutMs,
        isNewSession,
        resetTriggered,
        systemSent,
        sessionEntry,
        sessionEntryHandle,
        sessionStore,
        sessionKey,
        sessionId,
        storePath,
        workspaceDir,
        abortedLastRun,
        autoFallbackPrimaryProbe,
      }),
    );
    logResolverTiming("completed", "fast_directive_prepared_reply");
    return fastReplyResult;
  }

  const directiveResult = await traceGetReplyPhase("reply.resolve_directives", () =>
    resolveReplyDirectives({
      ctx: finalized,
      cfg,
      agentId,
      agentDir,
      workspaceDir,
      agentCfg,
      sessionCtx,
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      sessionScope,
      groupResolution,
      isGroup,
      triggerBodyNormalized,
      resetTriggered,
      commandAuthorized,
      defaultProvider,
      defaultModel,
      primaryProvider,
      primaryModel,
      aliasIndex,
      provider,
      model,
      hasResolvedHeartbeatModelOverride,
      typing,
      opts: withExtractedFileImages(resolvedOpts, extractedFileImages),
      skillFilter: mergedSkillFilter,
      preparedModelCatalog,
    }),
  );
  if (directiveResult.kind === "reply") {
    logResolverTiming("completed", "directive_reply");
    return directiveResult.reply;
  }
  const {
    commandSource,
    command,
    allowTextCommands,
    skillCommands,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    defaultActivation,
    resolvedFastMode,
    resolvedFastModeAutoOnSeconds,
    resolvedFastModeOverride,
    resolvedFastModeAutoOnSecondsOverride,
    resolvedVerboseLevel,
    resolvedElevatedLevel,
    execOverrides,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    provider: resolvedProvider,
    model: resolvedModel,
    requestedRouteResolution,
    modelState,
    contextTokens,
    inlineStatusRequested,
    directiveAck,
    perMessageQueueMode,
    perMessageQueueOptions,
  } = directiveResult.result;
  let { directives, cleanedBody, resolvedThinkLevel, resolvedReasoningLevel } =
    directiveResult.result;
  provider = resolvedProvider;
  model = resolvedModel;

  const maybeEmitMissingResetHooks = async () => {
    if (!resetTriggered || !command.isAuthorizedSender || command.resetHookTriggered) {
      return;
    }
    const resetMatch = command.commandBodyNormalized.match(/^\/(new|reset)(?:\s|$)/i);
    if (!resetMatch) {
      return;
    }
    const { emitResetCommandHooks } = await loadCommandsCoreRuntime();
    const action: ResetCommandAction = resetMatch[1]?.toLowerCase() === "reset" ? "reset" : "new";
    await emitResetCommandHooks({
      action,
      agentId,
      ctx,
      cfg,
      command,
      sessionKey,
      storePath,
      sessionEntry,
      previousSessionEntry,
      previousSessionMemory,
      previousSessionResetMessages,
      onObservedReplyDelivery: resolvedOpts?.onObservedReplyDelivery,
      workspaceDir,
    });
  };

  const shouldPrepareStatusThinkingCatalog =
    inlineStatusRequested ||
    directives.hasStatusDirective ||
    command.commandBodyNormalized.trim() === "/status";
  const statusThinkingCatalog = shouldPrepareStatusThinkingCatalog
    ? await traceGetReplyPhase("reply.prepare_status_thinking_catalog", () =>
        modelState.resolveThinkingCatalog(),
      )
    : undefined;

  const inlineActionResult = await traceGetReplyPhase("reply.handle_inline_actions", () =>
    handleInlineActions({
      ctx,
      sessionCtx,
      cfg,
      agentId,
      agentDir,
      sessionEntry,
      ...(initialSessionEntry ? { initialSessionEntry } : {}),
      allowCreateSessionEntry: useFastTestBootstrap && initialSessionEntry === undefined,
      previousSessionEntry,
      previousSessionMemory,
      previousSessionResetMessages,
      sessionStore,
      sessionKey,
      storePath,
      sessionScope,
      workspaceDir,
      isGroup,
      opts: withExtractedFileImages(resolvedOpts, extractedFileImages),
      typing,
      allowTextCommands,
      inlineStatusRequested,
      command,
      skillCommands,
      directives,
      cleanedBody,
      elevatedEnabled,
      elevatedAllowed,
      elevatedFailures,
      defaultActivation: () => defaultActivation,
      thinkingCatalog: statusThinkingCatalog,
      resolvedThinkLevel,
      resolvedVerboseLevel,
      resolvedReasoningLevel,
      resolvedElevatedLevel,
      blockReplyChunking,
      resolvedBlockStreamingBreak,
      resolveDefaultThinkingLevel: modelState.resolveDefaultThinkingLevel,
      provider,
      model,
      contextTokens,
      directiveAck,
      abortedLastRun,
      skillFilter: mergedSkillFilter,
    }),
  );
  if (inlineActionResult.kind === "reply") {
    await maybeEmitMissingResetHooks();
    logResolverTiming("completed", "inline_action_reply");
    return inlineActionResult.reply;
  }
  await maybeEmitMissingResetHooks();
  directives = inlineActionResult.directives;
  cleanedBody = inlineActionResult.cleanedBody;
  const explicitSkillSelections = inlineActionResult.explicitSkillSelections;
  const queueModeOverride = inlineActionResult.queueModeOverride;
  const preparedReplyOpts = withExtractedFileImages(resolvedOpts, extractedFileImages);
  abortedLastRun = inlineActionResult.abortedLastRun ?? abortedLastRun;
  const runAutoFallbackPrimaryProbe = directives.hasModelDirective
    ? undefined
    : autoFallbackPrimaryProbe;
  const runProvider = runAutoFallbackPrimaryProbe?.provider ?? provider;
  const runModel = runAutoFallbackPrimaryProbe?.model ?? model;
  let runModelState = modelState;
  if (runAutoFallbackPrimaryProbe) {
    try {
      runModelState = await createModelSelectionState({
        cfg,
        agentId,
        agentCfg,
        sessionEntry,
        sessionStore,
        sessionKey,
        parentSessionKey:
          sessionEntry.parentSessionKey ??
          sessionCtx.ModelParentSessionKey ??
          sessionCtx.ParentSessionKey,
        storePath,
        defaultProvider,
        defaultModel,
        primaryProvider,
        primaryModel,
        provider: runProvider,
        model: runModel,
        hasModelDirective: false,
        skipStoredModelOverride: true,
        hasResolvedHeartbeatModelOverride,
        isHeartbeat: opts?.isHeartbeat === true,
        preparedModelCatalog,
      });
    } catch (error) {
      if (error instanceof ModelSelectionLockedError) {
        typing.cleanup();
        return { text: error.message };
      }
      if (!isSessionWorkStartInvalidatedError(error)) {
        throw error;
      }
      typing.cleanup();
      return { text: error.message };
    }
    const thinkingLevelOverride = normalizeThinkLevel(resolvedOpts?.thinkingLevelOverride);
    const hasTurnOrSessionThinkLevel =
      thinkingLevelOverride !== undefined ||
      directives.thinkLevel !== undefined ||
      (!directives.clearThinkLevel && sessionEntry.thinkingLevel !== undefined);
    const hasExplicitThinkLevel =
      hasTurnOrSessionThinkLevel ||
      configuredThinkingDefault !== undefined ||
      runModelState.hasConfiguredThinkingDefault === true;
    if (!hasTurnOrSessionThinkLevel) {
      resolvedThinkLevel = await runModelState.resolveDefaultThinkingLevel();
    }
    const rawSessionReasoningLevel = sessionEntry.reasoningLevel;
    const canUseReasoningState =
      command.isAuthorizedSender ||
      command.senderIsOwner ||
      (Array.isArray(ctx.GatewayClientScopes) &&
        ctx.GatewayClientScopes.includes("operator.admin"));
    const hasExplicitReasoningLevel =
      directives.reasoningLevel !== undefined ||
      (rawSessionReasoningLevel != null && canUseReasoningState) ||
      (rawSessionReasoningLevel != null && !canUseReasoningState) ||
      agentEntry?.reasoningDefault != null ||
      agentCfg?.reasoningDefault != null;
    if (!hasExplicitReasoningLevel) {
      const thinkingActive = resolvedThinkLevel !== "off";
      resolvedReasoningLevel =
        thinkingActive || hasExplicitThinkLevel
          ? "off"
          : await runModelState.resolveDefaultReasoningLevel();
    }
  }

  let stagedAttachmentPaths = hasStagedMediaFacts(finalized.media)
    ? collectStagedAttachmentPaths(finalized)
    : new Map<number, string>();
  // Already-staged facts or SDK projections must remain a single-stage contract.
  if (
    !useFastTestBootstrap &&
    sessionKey &&
    !inboundMediaWasAlreadyStaged &&
    !hasStagedMediaFacts(ctx.media) &&
    hasInboundMedia(ctx)
  ) {
    const { stageSandboxMedia } = await loadStageSandboxMediaRuntime();
    const stageResult = await traceGetReplyPhase("reply.stage_media", () =>
      stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        agentId,
        sessionKey,
        workspaceDir,
      }),
    );
    stagedAttachmentPaths = stageResult.staged;
  }

  if (
    enableLocalPathSelfServe &&
    canSelfServeLocalPaths({
      ctx: sessionCtx,
      cfg,
      agentId,
      agentDir,
      sessionKey,
      workspaceDir,
      provider: runProvider,
      model: runModel,
      opts: resolvedOpts,
      senderIsOwner: command.senderIsOwner,
      spawnedBy: normalizeOptionalString(sessionEntry.spawnedBy),
      stagedPathsAvailable: stagedAttachmentPaths.size > 0,
    })
  ) {
    enableLocalPathSelfServe(
      [finalized, sessionCtx],
      stagedAttachmentPaths.size > 0 ? stagedAttachmentPaths : undefined,
    );
  }

  logResolverTiming("milestone", "before_run_prepared_reply");
  const replyResult = await traceGetReplyPhase("reply.run_prepared_reply", () =>
    runPreparedReply({
      ctx,
      sessionCtx,
      cfg,
      agentId,
      agentDir,
      agentCfg,
      sessionCfg,
      commandAuthorized,
      command,
      commandSource,
      allowTextCommands,
      directives,
      defaultActivation,
      resolvedThinkLevel,
      resolvedFastMode,
      resolvedFastModeAutoOnSeconds,
      resolvedFastModeOverride,
      resolvedFastModeAutoOnSecondsOverride,
      resolvedVerboseLevel,
      resolvedReasoningLevel,
      resolvedElevatedLevel,
      execOverrides,
      elevatedEnabled,
      elevatedAllowed,
      blockStreamingEnabled,
      blockReplyChunking,
      resolvedBlockStreamingBreak,
      modelState: runModelState,
      provider: runProvider,
      model: runModel,
      requestedRouteResolution: runAutoFallbackPrimaryProbe
        ? runModelState.requestedRouteResolution
        : requestedRouteResolution,
      perMessageQueueMode,
      perMessageQueueOptions,
      typing,
      opts: queueModeOverride ? { ...preparedReplyOpts, queueModeOverride } : preparedReplyOpts,
      defaultModel,
      timeoutMs,
      isNewSession,
      resetTriggered,
      systemSent,
      sessionEntry,
      sessionStore,
      sessionKey,
      sessionId,
      storePath,
      workspaceDir,
      abortedLastRun,
      explicitSkillSelections,
      autoFallbackPrimaryProbe: runAutoFallbackPrimaryProbe,
    }),
  );
  logResolverTiming("completed", "prepared_reply");
  return replyResult;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
