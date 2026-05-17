import fs from "node:fs/promises";
import {
  resolveAutoFallbackPrimaryProbe,
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
  resolveAgentSkillsFilter,
} from "../../agents/agent-scope.js";
import { modelKey, resolveModelRefFromString } from "../../agents/model-selection.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { DEFAULT_AGENT_WORKSPACE_DIR, ensureAgentWorkspace } from "../../agents/workspace.js";
import { resolveChannelModelOverride } from "../../channels/model-overrides.js";
import { type OpenClawConfig, getRuntimeConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { buildAgentHookContextChannelFields } from "../../plugins/hook-agent-context.js";
import { defaultRuntime } from "../../runtime.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS, stripHeartbeatToken } from "../heartbeat.js";
import type { ReplyPayload } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";
import { normalizeVerboseLevel } from "../thinking.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { resolveDefaultModel } from "./directive-handling.defaults.js";
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
import { finalizeInboundContext } from "./inbound-context.js";
import { hasInboundMedia } from "./inbound-media.js";
import { emitPreAgentMessageHooks } from "./message-preprocess-hooks.js";
import { createFastTestModelSelectionState, createModelSelectionState } from "./model-selection.js";
import { sanitizePendingFinalDeliveryText } from "./pending-final-delivery.js";
import { initSessionState } from "./session.js";
import {
  isStaleHeartbeatAutoFallbackOverride,
  resolveStoredModelOverride,
} from "./stored-model-override.js";
import { createTypingController } from "./typing.js";

type ResetCommandAction = "new" | "reset";

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

function resolveHeartbeatAckMaxChars(cfg: OpenClawConfig, agentId: string): number {
  const agentHeartbeat = resolveAgentConfig(cfg, agentId)?.heartbeat;
  return Math.max(
    0,
    agentHeartbeat?.ackMaxChars ??
      cfg.agents?.defaults?.heartbeat?.ackMaxChars ??
      DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  );
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

const hookRunnerGlobalLoader = createLazyImportLoader(
  () => import("../../plugins/hook-runner-global.js"),
);
const originRoutingLoader = createLazyImportLoader(() => import("./origin-routing.js"));

function loadHookRunnerGlobal() {
  return hookRunnerGlobalLoader.load();
}

function loadOriginRouting() {
  return originRoutingLoader.load();
}

function mergeSkillFilters(channelFilter?: string[], agentFilter?: string[]): string[] | undefined {
  const normalize = (list?: string[]) => {
    if (!Array.isArray(list)) {
      return undefined;
    }
    return normalizeStringEntries(list);
  };
  const channel = normalize(channelFilter);
  const agent = normalize(agentFilter);
  if (!channel && !agent) {
    return undefined;
  }
  if (!channel) {
    return agent;
  }
  if (!agent) {
    return channel;
  }
  if (channel.length === 0 || agent.length === 0) {
    return [];
  }
  const agentSet = new Set(agent);
  return channel.filter((name) => agentSet.has(name));
}

function hasLinkCandidate(ctx: MsgContext): boolean {
  const message = ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.Body;
  if (!message) {
    return false;
  }
  return /\bhttps?:\/\/\S+/i.test(message);
}

async function applyMediaUnderstandingIfNeeded(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  activeModel: { provider: string; model: string };
}): Promise<boolean> {
  if (!hasInboundMedia(params.ctx)) {
    return false;
  }
  try {
    const { applyMediaUnderstanding } = await loadMediaUnderstandingApplyRuntime();
    await applyMediaUnderstanding(params);
    return true;
  } catch (err) {
    mediaUnderstandingApplyRuntimeLoader.clear();
    logVerbose(
      `media understanding failed, proceeding with raw content: ${formatErrorMessage(err)}`,
    );
    return false;
  }
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
  const isFastTestEnv = process.env.OPENCLAW_TEST_FAST === "1";
  const cfg = resolveGetReplyConfig({
    getRuntimeConfig,
    isFastTestEnv,
    configOverride,
  });
  const useFastTestBootstrap = shouldUseReplyFastTestBootstrap({
    isFastTestEnv,
    configOverride,
  });
  const useFastTestRuntime = shouldUseReplyFastTestRuntime({
    cfg,
    isFastTestEnv,
  });
  const finalized = finalizeInboundContext(ctx);
  const targetSessionKey = resolveCommandTurnTargetSessionKey(finalized);
  const agentSessionKey = targetSessionKey || finalized.SessionKey;
  const traceAttributes = {
    surface: normalizeOptionalString(finalized.Surface ?? finalized.Provider) ?? "unknown",
    hasSessionKey: Boolean(agentSessionKey),
    isHeartbeat: opts?.isHeartbeat === true,
    hasMedia: hasInboundMedia(finalized),
  };
  const traceGetReplyPhase = <T>(name: string, run: () => Promise<T> | T): Promise<T> =>
    measureDiagnosticsTimelineSpan(name, run, {
      phase: "agent-turn",
      config: cfg,
      attributes: traceAttributes,
    });
  const agentId = resolveSessionAgentId({
    sessionKey: agentSessionKey,
    config: cfg,
  });
  const mergedSkillFilter = mergeSkillFilters(
    opts?.skillFilter,
    resolveAgentSkillsFilter(cfg, agentId),
  );
  const resolvedOpts =
    mergedSkillFilter !== undefined ? { ...opts, skillFilter: mergedSkillFilter } : opts;
  const agentCfg = cfg.agents?.defaults;
  const sessionCfg = cfg.session;
  const { defaultProvider, defaultModel, aliasIndex } = resolveDefaultModel({
    cfg,
    agentId,
  });
  let provider = defaultProvider;
  let model = defaultModel;
  let hasResolvedHeartbeatModelOverride = false;
  let hasAppliedImageModelOverride = false;
  let imageModelFallbacksOverride: string[] | undefined;
  const modelOverrideRaw = normalizeOptionalString(opts?.modelOverride);
  if (modelOverrideRaw) {
    const modelOverrideRef = resolveModelRefFromString({
      raw: modelOverrideRaw,
      defaultProvider,
      aliasIndex,
    });
    if (modelOverrideRef) {
      provider = modelOverrideRef.ref.provider;
      model = modelOverrideRef.ref.model;
      hasAppliedImageModelOverride = true;
      imageModelFallbacksOverride = opts?.modelOverrideFallbacks?.filter(
        (fallback): fallback is string => normalizeOptionalString(fallback) !== undefined,
      );
    } else {
      defaultRuntime.log?.(
        `[image-model-switch] Failed to resolve image model override ${modelOverrideRaw}; using default model ${modelKey(defaultProvider, defaultModel)}`,
      );
    }
  } else if (opts?.isHeartbeat) {
    // Prefer the resolved per-agent heartbeat model passed from the heartbeat runner,
    // fall back to the global defaults heartbeat model for backward compatibility.
    const heartbeatRaw =
      normalizeOptionalString(opts.heartbeatModelOverride) ??
      normalizeOptionalString(agentCfg?.heartbeat?.model) ??
      "";
    const heartbeatRef = heartbeatRaw
      ? resolveModelRefFromString({
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

  const workspaceDirRaw = resolveAgentWorkspaceDir(cfg, agentId) ?? DEFAULT_AGENT_WORKSPACE_DIR;
  const workspaceDirForNativeCommand = workspaceDirRaw;
  const agentDir = resolveAgentDir(cfg, agentId);
  const timeoutMs = resolveAgentTimeoutMs({ cfg, overrideSeconds: opts?.timeoutOverrideSeconds });
  const configuredTypingSeconds =
    agentCfg?.typingIntervalSeconds ?? sessionCfg?.typingIntervalSeconds;
  const typingIntervalSeconds =
    typeof configuredTypingSeconds === "number" ? configuredTypingSeconds : 6;
  const typing = createTypingController({
    onReplyStart: opts?.onReplyStart,
    onCleanup: opts?.onTypingCleanup,
    typingIntervalSeconds,
    silentToken: SILENT_REPLY_TOKEN,
    log: defaultRuntime.log,
  });
  opts?.onTypingController?.(typing);

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
        opts: resolvedOpts,
        skillFilter: mergedSkillFilter,
      }),
  );
  if (nativeSlashCommandFastReply.handled) {
    return nativeSlashCommandFastReply.reply;
  }

  const workspace = await traceGetReplyPhase("reply.ensure_workspace", async () =>
    useFastTestBootstrap
      ? (await fs.mkdir(workspaceDirRaw, { recursive: true }), { dir: workspaceDirRaw })
      : await ensureAgentWorkspace({
          dir: workspaceDirRaw,
          ensureBootstrapFiles: !agentCfg?.skipBootstrap && !isFastTestEnv,
          skipOptionalBootstrapFiles: agentCfg?.skipOptionalBootstrapFiles,
        }),
  );
  const workspaceDir = workspace.dir;

  if (!isFastTestEnv && hasInboundMedia(finalized)) {
    await traceGetReplyPhase("reply.apply_media_understanding", () =>
      applyMediaUnderstandingIfNeeded({
        ctx: finalized,
        cfg,
        agentDir,
        workspaceDir,
        activeModel: { provider, model },
      }),
    );
  }
  if (!isFastTestEnv && hasLinkCandidate(finalized)) {
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
  const sessionState = useFastTestBootstrap
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
        }),
      );
  let {
    sessionCtx,
    sessionEntry,
    previousSessionEntry,
    sessionStore,
    sessionKey,
    sessionId,
    isNewSession,
    resetTriggered,
    systemSent,
    abortedLastRun,
    storePath,
    sessionScope,
    groupResolution,
    isGroup,
    triggerBodyNormalized,
    bodyStripped,
  } = sessionState;

  if (sessionEntry?.pendingFinalDelivery && sessionEntry.pendingFinalDeliveryText) {
    const text = sanitizePendingFinalDeliveryText(sessionEntry.pendingFinalDeliveryText);

    // If it's a heartbeat, we definitely want to try delivering the lost reply now.
    // If it's a user message, we deliver the lost reply first, then continue.
    // For now, let's just return the lost reply if it's a heartbeat.
    if (opts?.isHeartbeat) {
      const heartbeatPending = classifyHeartbeatPendingFinalDelivery(
        text,
        resolveHeartbeatAckMaxChars(cfg, agentId),
      );
      if (heartbeatPending.shouldClear) {
        sessionEntry.pendingFinalDelivery = undefined;
        sessionEntry.pendingFinalDeliveryText = undefined;
        sessionEntry.pendingFinalDeliveryCreatedAt = undefined;
        sessionEntry.pendingFinalDeliveryLastAttemptAt = undefined;
        sessionEntry.pendingFinalDeliveryAttemptCount = undefined;
        sessionEntry.pendingFinalDeliveryLastError = undefined;
        sessionEntry.pendingFinalDeliveryContext = undefined;
        if (sessionKey && sessionStore) {
          sessionStore[sessionKey] = sessionEntry;
        }
        if (sessionKey && storePath) {
          const { updateSessionStoreEntry } = await import("../../config/sessions.js");
          await updateSessionStoreEntry({
            storePath,
            sessionKey,
            update: async () => ({
              pendingFinalDelivery: undefined,
              pendingFinalDeliveryText: undefined,
              pendingFinalDeliveryCreatedAt: undefined,
              pendingFinalDeliveryLastAttemptAt: undefined,
              pendingFinalDeliveryAttemptCount: undefined,
              pendingFinalDeliveryLastError: undefined,
              pendingFinalDeliveryContext: undefined,
            }),
          });
        }
      } else {
        const updatedAt = Date.now();
        const attemptCount = (sessionEntry.pendingFinalDeliveryAttemptCount ?? 0) + 1;
        sessionEntry.pendingFinalDeliveryLastAttemptAt = updatedAt;
        sessionEntry.pendingFinalDeliveryAttemptCount = attemptCount;
        sessionEntry.pendingFinalDeliveryLastError = null;
        const replayText = sanitizePendingFinalDeliveryText(heartbeatPending.replayText);
        sessionEntry.pendingFinalDeliveryText = replayText;
        sessionEntry.updatedAt = updatedAt;
        if (sessionKey && sessionStore) {
          sessionStore[sessionKey] = sessionEntry;
        }
        if (sessionKey && storePath) {
          const { updateSessionStoreEntry } = await import("../../config/sessions.js");
          await updateSessionStoreEntry({
            storePath,
            sessionKey,
            update: async () => ({
              pendingFinalDeliveryText: replayText,
              pendingFinalDeliveryLastAttemptAt: updatedAt,
              pendingFinalDeliveryAttemptCount: attemptCount,
              pendingFinalDeliveryLastError: null,
              updatedAt,
            }),
          });
        }
        return { text: replayText };
      }
    }
  }

  if (resetTriggered && normalizeOptionalString(bodyStripped)) {
    const { applyResetModelOverride } = await loadSessionResetModelRuntime();
    await applyResetModelOverride({
      cfg,
      agentId,
      resetTriggered,
      bodyStripped,
      sessionCtx,
      ctx: finalized,
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      defaultProvider,
      defaultModel,
      aliasIndex,
    });
  }

  const channelModelOverride = cfg.channels?.modelByChannel
    ? resolveChannelModelOverride({
        cfg,
        channel:
          groupResolution?.channel ??
          sessionEntry.channel ??
          sessionEntry.origin?.provider ??
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
      })
    : null;
  const resolvedChannelModelOverride =
    channelModelOverride && !hasResolvedHeartbeatModelOverride
      ? resolveModelRefFromString({
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
  const staleHeartbeatAutoFallbackOverride = isStaleHeartbeatAutoFallbackOverride({
    isHeartbeat: opts?.isHeartbeat === true,
    hasResolvedHeartbeatModelOverride,
    sessionEntry,
    storedOverride: storedModelOverride,
    defaultProvider,
    defaultModel,
    primaryProvider,
    primaryModel,
  });
  if (
    storedModelOverride?.model &&
    !hasResolvedHeartbeatModelOverride &&
    !hasAppliedImageModelOverride &&
    !staleHeartbeatAutoFallbackOverride
  ) {
    provider = storedModelOverride.provider ?? defaultProvider;
    model = storedModelOverride.model;
  }
  const canApplyAutoFallbackPrimaryProbe =
    !hasResolvedHeartbeatModelOverride &&
    !hasAppliedImageModelOverride &&
    !staleHeartbeatAutoFallbackOverride;
  const autoFallbackPrimaryProbe = canApplyAutoFallbackPrimaryProbe
    ? resolveAutoFallbackPrimaryProbe({
        entry: sessionEntry,
        sessionKey,
        primaryProvider,
        primaryModel,
      })
    : undefined;
  const hasEffectiveSessionModelOverride =
    hasSessionModelOverride && !staleHeartbeatAutoFallbackOverride;
  if (
    !hasResolvedHeartbeatModelOverride &&
    !hasEffectiveSessionModelOverride &&
    !hasAppliedImageModelOverride &&
    resolvedChannelModelOverride
  ) {
    provider = resolvedChannelModelOverride.ref.provider;
    model = resolvedChannelModelOverride.ref.model;
  }
  const imageModelOverrideBaseProvider = hasAppliedImageModelOverride
    ? (() => {
        if (
          storedModelOverride?.model &&
          !hasResolvedHeartbeatModelOverride &&
          !staleHeartbeatAutoFallbackOverride
        ) {
          return storedModelOverride.provider ?? defaultProvider;
        }
        if (!hasEffectiveSessionModelOverride && resolvedChannelModelOverride) {
          return resolvedChannelModelOverride.ref.provider;
        }
        const runtimeProvider = normalizeOptionalString(sessionEntry.modelProvider);
        const runtimeModel = normalizeOptionalString(sessionEntry.model);
        if (runtimeProvider && runtimeModel) {
          return runtimeProvider;
        }
        return defaultProvider;
      })()
    : undefined;

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
      ctx,
      cfg,
      agentId,
      sessionKey,
      isGroup,
      triggerBodyNormalized,
      commandAuthorized,
    });
    return await traceGetReplyPhase("reply.run_prepared_reply", () =>
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
        commandSource:
          finalized.BodyForCommands ?? finalized.CommandBody ?? finalized.RawBody ?? "",
        allowTextCommands: shouldHandleFastReplyTextCommands({
          cfg,
          commandSource: finalized.CommandSource,
        }),
        directives: clearInlineDirectives(
          finalized.BodyForCommands ?? finalized.CommandBody ?? finalized.RawBody ?? "",
        ),
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
        opts: resolvedOpts,
        defaultProvider,
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
        hasAppliedImageModelOverride,
        imageModelOverrideBaseProvider,
        imageModelFallbacksOverride,
        autoFallbackPrimaryProbe,
      }),
    );
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
      hasOneTurnModelOverride: hasAppliedImageModelOverride,
      hasResolvedHeartbeatModelOverride,
      typing,
      opts: resolvedOpts,
      skillFilter: mergedSkillFilter,
    }),
  );
  if (directiveResult.kind === "reply") {
    return directiveResult.reply;
  }

  let {
    commandSource,
    command,
    allowTextCommands,
    skillCommands,
    directives,
    cleanedBody,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    defaultActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    execOverrides,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    provider: resolvedProvider,
    model: resolvedModel,
    modelState,
    contextTokens,
    inlineStatusRequested,
    directiveAck,
    perMessageQueueMode,
    perMessageQueueOptions,
  } = directiveResult.result;
  provider = resolvedProvider;
  model = resolvedModel;

  const maybeEmitMissingResetHooks = async () => {
    if (!resetTriggered || !command.isAuthorizedSender || command.resetHookTriggered) {
      return;
    }
    const resetMatch = command.commandBodyNormalized.match(/^\/(new|reset)(?:\s|$)/);
    if (!resetMatch) {
      return;
    }
    const { emitResetCommandHooks } = await loadCommandsCoreRuntime();
    const action: ResetCommandAction = resetMatch[1] === "reset" ? "reset" : "new";
    await emitResetCommandHooks({
      action,
      ctx,
      cfg,
      command,
      sessionKey,
      sessionEntry,
      previousSessionEntry,
      workspaceDir,
    });
  };

  const inlineActionResult = await traceGetReplyPhase("reply.handle_inline_actions", () =>
    handleInlineActions({
      ctx,
      sessionCtx,
      cfg,
      agentId,
      agentDir,
      sessionEntry,
      previousSessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      sessionScope,
      workspaceDir,
      isGroup,
      opts: resolvedOpts,
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
    return inlineActionResult.reply;
  }
  await maybeEmitMissingResetHooks();
  directives = inlineActionResult.directives;
  cleanedBody = inlineActionResult.cleanedBody;
  abortedLastRun = inlineActionResult.abortedLastRun ?? abortedLastRun;
  const runAutoFallbackPrimaryProbe = directives.hasModelDirective
    ? undefined
    : autoFallbackPrimaryProbe;
  const runProvider = runAutoFallbackPrimaryProbe?.provider ?? provider;
  const runModel = runAutoFallbackPrimaryProbe?.model ?? model;
  let runModelState = modelState;
  if (runAutoFallbackPrimaryProbe) {
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
      hasOneTurnModelOverride: hasAppliedImageModelOverride,
      skipStoredModelOverride: true,
      hasResolvedHeartbeatModelOverride,
      isHeartbeat: opts?.isHeartbeat === true,
    });
    const hasExplicitThinkLevel =
      resolvedOpts?.thinkingLevelOverride !== undefined ||
      directives.thinkLevel !== undefined ||
      (!directives.clearThinkLevel && sessionEntry.thinkingLevel !== undefined) ||
      agentCfg?.thinkingDefault !== undefined;
    if (!hasExplicitThinkLevel) {
      resolvedThinkLevel = await runModelState.resolveDefaultThinkingLevel();
    }
    const agentEntry = resolveAgentConfig(cfg, agentId);
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
    if (!hasExplicitReasoningLevel && resolvedThinkLevel === "off") {
      resolvedReasoningLevel = await runModelState.resolveDefaultReasoningLevel();
    }
  }

  // Allow plugins to intercept and return a synthetic reply before the LLM runs.
  if (!useFastTestBootstrap) {
    const { getGlobalHookRunner } = await loadHookRunnerGlobal();
    const hookRunner = getGlobalHookRunner();
    if (hookRunner?.hasHooks("before_agent_reply")) {
      const { resolveOriginMessageProvider } = await loadOriginRouting();
      const hookMessageProvider = resolveOriginMessageProvider({
        originatingChannel: sessionCtx.OriginatingChannel,
        provider: sessionCtx.Provider,
      });
      const hookResult = await traceGetReplyPhase("reply.before_agent_reply_hooks", () =>
        hookRunner.runBeforeAgentReply(
          { cleanedBody },
          {
            agentId,
            sessionKey: agentSessionKey,
            sessionId,
            workspaceDir,
            trigger: opts?.isHeartbeat ? "heartbeat" : "user",
            ...buildAgentHookContextChannelFields({
              sessionKey: agentSessionKey,
              messageProvider: hookMessageProvider,
              currentChannelId: sessionCtx.OriginatingTo ?? ctx.OriginatingTo ?? ctx.To,
              messageTo: sessionCtx.OriginatingTo ?? ctx.OriginatingTo ?? ctx.To,
            }),
          },
        ),
      );
      if (hookResult?.handled) {
        return hookResult.reply ?? { text: SILENT_REPLY_TOKEN };
      }
    }
  }

  // ctx.MediaStaged=true means the caller (e.g. chat.send RPC) already staged
  // synchronously so it could surface 5xx before respond(). Skipping here keeps
  // staging a single-call contract instead of relying on relative-path no-op
  // semantics in stageSandboxMedia.
  if (!useFastTestBootstrap && sessionKey && !ctx.MediaStaged && hasInboundMedia(ctx)) {
    const { stageSandboxMedia } = await loadStageSandboxMediaRuntime();
    await traceGetReplyPhase("reply.stage_media", () =>
      stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey,
        workspaceDir,
      }),
    );
  }

  return await traceGetReplyPhase("reply.run_prepared_reply", () =>
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
      perMessageQueueMode,
      perMessageQueueOptions,
      typing,
      opts: resolvedOpts,
      defaultProvider,
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
      hasAppliedImageModelOverride,
      imageModelOverrideBaseProvider,
      imageModelFallbacksOverride,
      autoFallbackPrimaryProbe: runAutoFallbackPrimaryProbe,
    }),
  );
}
