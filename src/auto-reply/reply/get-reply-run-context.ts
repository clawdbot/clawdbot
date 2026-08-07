import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { resolveEmbeddedFullAccessState } from "../../agents/embedded-agent-runner/sandbox-info.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import type { SilentReplyPromptMode } from "../../agents/system-prompt.types.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { resolveSilentReplySettings } from "../../config/silent-reply.js";
import { logVerbose } from "../../globals.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { isFastTestRuntimeEnv } from "../../infra/env.js";
import { resolveHeartbeatRunScope } from "../../infra/heartbeat-run-scope.js";
import {
  isAcpSessionKey,
  isSubagentSessionKey,
  normalizeMainKey,
} from "../../routing/session-key.js";
import { hasControlCommand } from "../command-detection.js";
import {
  isNativeCommandTurn,
  isTextSlashCommandTurn,
  resolveCommandTurnContext,
} from "../command-turn-context.js";
import { resolveEnvelopeFormatOptions } from "../envelope.js";
import { normalizeThinkLevel } from "../thinking.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { applySessionHints } from "./body.js";
import { shouldUseReplyFastTestRuntime } from "./get-reply-fast-path.js";
import {
  buildExecOverridePromptHint,
  hasInboundHistoryBody,
  hasReplyTargetContext,
  resolvePromptSessionContextForSystemEvent,
  resolvePromptSilentReplyConversationType,
  stripPromptThinkingDirectives,
} from "./get-reply-run-helpers.js";
import { resolvePromptSourceReplyMode } from "./get-reply-run-source-mode.js";
import type { RunPreparedReplyParams } from "./get-reply-run.types.js";
import { buildDirectChatContext, buildGroupChatContext, buildGroupIntro } from "./groups.js";
import { hasInboundMedia } from "./inbound-media.js";
import {
  buildInboundMetaSystemPrompt,
  buildInboundUserContextPrefix,
  formatActiveGoalContext,
  resolveInboundUserContextPromptJoiner,
} from "./inbound-meta.js";
import { buildReplyPromptEnvelopeBase } from "./prompt-prelude.js";
import { resolveRuntimePolicySessionKey } from "./runtime-policy-session-key.js";
import {
  resolveBareResetBootstrapFileAccess,
  resolveBareSessionResetPromptState,
} from "./session-reset-prompt.js";
import { shouldApplyStartupContext, buildSessionStartupContextPrelude } from "./startup-context.js";
import { resolveTypingMode } from "./typing-mode.js";
import { resolveRunTypingPolicy } from "./typing-policy.js";

export async function prepareReplyRunContext(params: RunPreparedReplyParams) {
  const {
    ctx,
    sessionCtx,
    cfg,
    agentId,
    agentCfg,
    sessionCfg,
    commandAuthorized,
    command,
    allowTextCommands,
    defaultActivation,
    elevatedEnabled,
    elevatedAllowed,
    provider,
    model,
    perMessageQueueMode,
    typing,
    opts,
    isNewSession,
    resetTriggered,
    systemSent,
    sessionKey,
    storePath,
    workspaceDir: configuredWorkspaceDir,
    sessionEntryHandle,
    sessionStore,
  } = params;
  const runtimePolicySessionKey = resolveRuntimePolicySessionKey({ cfg, ctx, sessionKey });
  const { resolvedElevatedLevel, execOverrides, abortedLastRun } = params;
  let { sessionEntry } = params;
  const isHeartbeat = opts?.isHeartbeat === true;
  const heartbeatRunScope = resolveHeartbeatRunScope(opts);
  const explicitThinkingLevelOverride = normalizeThinkLevel(opts?.thinkingLevelOverride);
  const effectiveQueueMode = opts?.queueModeOverride ?? perMessageQueueMode;
  const traceAttributes = {
    provider,
    hasSessionKey: Boolean(sessionKey),
    isHeartbeat,
    queueMode: effectiveQueueMode ?? "configured",
  };
  const traceRunPhase = <T>(name: string, run: () => Promise<T> | T): Promise<T> =>
    measureDiagnosticsTimelineSpan(name, run, {
      phase: "agent-turn",
      config: cfg,
      attributes: traceAttributes,
    });
  const promptSessionCtx = resolvePromptSessionContextForSystemEvent({
    sessionCtx,
    sessionEntry,
    ctx,
    isHeartbeat,
  });
  const inboundEventKind = promptSessionCtx.InboundEventKind;
  const { sourceReplyDeliveryMode, sessionPromptSourceReplyDeliveryMode } =
    resolvePromptSourceReplyMode({ promptSessionCtx, opts });
  const silentReplyConversationType = resolvePromptSilentReplyConversationType({
    ctx: promptSessionCtx,
    inboundSessionKey: ctx.SessionKey,
  });
  const silentReplySettings = resolveSilentReplySettings({
    cfg,
    sessionKey: runtimePolicySessionKey,
    surface: promptSessionCtx.Surface ?? promptSessionCtx.Provider,
    conversationType: silentReplyConversationType,
  });
  const useFastReplyRuntime = shouldUseReplyFastTestRuntime({
    cfg,
    isFastTestEnv: isFastTestRuntimeEnv(),
  });
  const thinkingRuntime = resolveEffectiveAgentRuntime({
    cfg,
    provider,
    modelId: model,
    agentId,
    sessionKey: runtimePolicySessionKey,
    sessionEntry,
  });
  const fullAccessState = resolveEmbeddedFullAccessState({
    execElevated: {
      enabled: elevatedEnabled,
      allowed: elevatedAllowed,
      defaultLevel: resolvedElevatedLevel ?? "off",
    },
  });

  const isFirstTurnInSession = isNewSession || !systemSent;
  const isGroupChat =
    promptSessionCtx.ChatType === "group" || promptSessionCtx.ChatType === "channel";
  const isDirectChat = promptSessionCtx.ChatType === "direct" || promptSessionCtx.ChatType === "dm";
  const { typingPolicy, suppressTyping } = resolveRunTypingPolicy({
    requestedPolicy: opts?.typingPolicy,
    suppressTyping: opts?.suppressTyping === true,
    isHeartbeat,
    originatingChannel: ctx.OriginatingChannel,
  });
  const typingMode = resolveTypingMode({
    configured: resolveAgentConfig(cfg, agentId)?.typingMode ?? agentCfg?.typingMode,
    isGroupChat,
    wasMentioned: ctx.WasMentioned === true,
    isHeartbeat,
    typingPolicy,
    suppressTyping,
    sourceReplyDeliveryMode,
  });
  const shouldInjectGroupIntro = Boolean(
    isGroupChat && (isFirstTurnInSession || sessionEntry?.groupActivationNeedsSystemIntro),
  );
  const directChatContext = isDirectChat
    ? buildDirectChatContext({
        sessionCtx: promptSessionCtx,
        sourceReplyDeliveryMode: sessionPromptSourceReplyDeliveryMode,
      })
    : "";
  // Always include persistent group chat context (provider + reply guidance).
  const groupChatContext = isGroupChat
    ? buildGroupChatContext({
        sessionCtx: promptSessionCtx,
        sourceReplyDeliveryMode: sessionPromptSourceReplyDeliveryMode,
        silentReplyPolicy: silentReplySettings.policy,
        silentToken: SILENT_REPLY_TOKEN,
      })
    : "";
  // Claude CLI fixes the system prompt at session creation; group intro must stay session-stable.
  const groupIntro = isGroupChat ? buildGroupIntro({ sessionEntry, defaultActivation }) : "";
  const allowEmptyAssistantReplyAsSilent = isGroupChat && silentReplySettings.policy === "allow";
  const groupSystemPrompt = normalizeOptionalString(promptSessionCtx.GroupSystemPrompt) ?? "";
  const inboundMetaPrompt = buildInboundMetaSystemPrompt(
    isNewSession ? sessionCtx : { ...sessionCtx, ThreadStarterBody: undefined },
    cfg,
    // promptSessionCtx restores the persisted channel/account for system-event
    // turns, so reply formatting hints resolve against the delivery channel.
    { includeFormattingHints: !useFastReplyRuntime, formattingHintsCtx: promptSessionCtx },
  );
  const execOverridePromptHint = buildExecOverridePromptHint({
    execOverrides,
    elevatedLevel: resolvedElevatedLevel,
    fullAccessAvailable: fullAccessState.available,
    fullAccessBlockedReason: fullAccessState.blockedReason,
  });
  const extraSystemPromptParts = [
    inboundMetaPrompt,
    directChatContext,
    groupChatContext,
    groupIntro,
    groupSystemPrompt,
    execOverridePromptHint,
  ].filter(Boolean);
  const extraSystemPromptStatic = [
    directChatContext,
    groupChatContext,
    groupIntro,
    groupSystemPrompt,
    execOverridePromptHint,
  ]
    .filter(Boolean)
    .join("\n\n");
  const cliSessionBindingFacts = {
    extraSystemPromptStatic,
    ...(sessionPromptSourceReplyDeliveryMode
      ? { sourceReplyDeliveryMode: sessionPromptSourceReplyDeliveryMode }
      : {}),
  };
  const silentReplyPromptMode: SilentReplyPromptMode =
    directChatContext || groupChatContext || sourceReplyDeliveryMode === "message_tool_only"
      ? "none"
      : "generic";
  const baseBody = sessionCtx.agentText ?? "";
  const rawBodyTrimmed = (ctx.commandText ?? "").trim();
  const baseBodyTrimmedRaw = baseBody.trim();
  const normalizedCommandBody = command.commandBodyNormalized.trim();
  const softResetTriggered = command.softResetTriggered === true;
  const softResetTail = command.softResetTail?.trim() ?? "";
  const effectiveResetTriggered = resetTriggered || softResetTriggered;
  const hasCurrentReplyTargetContext =
    hasReplyTargetContext(ctx) || hasReplyTargetContext(sessionCtx);
  const isWholeMessageCommand =
    normalizedCommandBody === rawBodyTrimmed ||
    normalizedCommandBody === rawBodyTrimmed.toLowerCase();
  const isResetOrNewCommand = /^\/(new|reset)(?:\s|$)/i.test(normalizedCommandBody);
  const commandTurn = resolveCommandTurnContext(ctx);
  const isRegisteredWholeMessageCommand =
    isWholeMessageCommand && (hasControlCommand(rawBodyTrimmed, cfg) || isResetOrNewCommand);
  const isActiveCommandTurn =
    isNativeCommandTurn(commandTurn) ||
    (allowTextCommands &&
      ctx.CommandInterpretationSuppressed !== true &&
      (isTextSlashCommandTurn(commandTurn) || isRegisteredWholeMessageCommand));
  if (
    isActiveCommandTurn &&
    (!commandAuthorized || !command.isAuthorizedSender) &&
    isRegisteredWholeMessageCommand
  ) {
    opts?.onDeliberateSilentTerminalReply?.();
    typing.cleanup();
    return { kind: "reply", reply: undefined } as const;
  }
  const isBareNewOrReset = /^\/(new|reset)$/i.test(normalizedCommandBody);
  const isBareSessionReset =
    softResetTriggered ||
    (isNewSession &&
      (isBareNewOrReset ||
        (!hasCurrentReplyTargetContext &&
          baseBodyTrimmedRaw.length === 0 &&
          rawBodyTrimmed.length > 0)));
  const startupAction =
    softResetTriggered || /^\/reset(?:\s|$)/i.test(normalizedCommandBody) ? "reset" : "new";
  const sessionWorkspaceOverride = resolveIngressWorkspaceOverrideForSessionRun({
    spawnedBy: sessionEntry?.spawnedBy,
    workspaceDir: sessionEntry?.spawnedWorkspaceDir,
    cwd: sessionEntry?.spawnedCwd,
  });
  const workspaceDir = sessionWorkspaceOverride ?? configuredWorkspaceDir;
  const bareResetPromptState =
    isBareSessionReset && workspaceDir
      ? await resolveBareSessionResetPromptState({
          cfg,
          workspaceDir,
          isPrimaryRun: !isSubagentSessionKey(sessionKey) && !isAcpSessionKey(sessionKey),
          isCanonicalWorkspace: !sessionWorkspaceOverride,
          hasBootstrapFileAccess: () =>
            resolveBareResetBootstrapFileAccess({
              cfg,
              agentId,
              sessionKey,
              workspaceDir,
              modelProvider: provider,
              modelId: model,
            }),
        })
      : null;
  const startupContextPrelude =
    isBareSessionReset &&
    bareResetPromptState?.shouldPrependStartupContext !== false &&
    shouldApplyStartupContext({ cfg, action: startupAction })
      ? await buildSessionStartupContextPrelude({ workspaceDir, cfg })
      : null;
  const baseBodyFinal = isBareSessionReset
    ? (bareResetPromptState?.prompt ?? "")
    : stripPromptThinkingDirectives(baseBody);
  const hasUserBody =
    baseBodyFinal.trim().length > 0 ||
    softResetTail.length > 0 ||
    hasInboundHistoryBody(sessionCtx) ||
    hasCurrentReplyTargetContext;
  const hasMediaAttachment = hasInboundMedia(sessionCtx) || (opts?.images?.length ?? 0) > 0;
  if (!hasUserBody && !hasMediaAttachment) {
    // Skip onReplyStart when typing is suppressed (e.g. sendPolicy deny) —
    // otherwise channels that wire onReplyStart to typing indicators leak
    // visible signals even though outbound delivery is suppressed.
    if (!suppressTyping) {
      await typing.onReplyStart();
    }
    logVerbose("Inbound body empty after normalization; skipping agent run");
    typing.cleanup();
    return {
      kind: "reply",
      reply: { text: "I didn't receive any text in your message. Please resend or add a caption." },
    } as const;
  }

  const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
  const inboundUserContextSessionCtx = isNewSession
    ? {
        ...sessionCtx,
        ...(normalizeOptionalString(sessionCtx.ThreadHistoryBody)
          ? { InboundHistory: undefined, ThreadStarterBody: undefined }
          : {}),
      }
    : { ...sessionCtx, ThreadStarterBody: undefined };
  let inboundContextSessionEntry = isHeartbeat
    ? undefined
    : (sessionStore?.[sessionKey] ?? sessionEntryHandle?.getCurrent() ?? sessionEntry);
  let activeGoalContext = formatActiveGoalContext(inboundContextSessionEntry);
  let inboundUserContext = buildInboundUserContextPrefix(
    inboundUserContextSessionCtx,
    envelopeOptions,
    inboundContextSessionEntry,
  );
  const refreshInboundContextAfterAdmissionWait = async () => {
    if (isHeartbeat) {
      return;
    }
    inboundContextSessionEntry =
      storePath && sessionKey
        ? loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" })
        : (sessionEntryHandle?.getCurrent() ?? sessionStore?.[sessionKey] ?? sessionEntry);
    activeGoalContext = formatActiveGoalContext(inboundContextSessionEntry);
    inboundUserContext = buildInboundUserContextPrefix(
      inboundUserContextSessionCtx,
      envelopeOptions,
      inboundContextSessionEntry,
    );
  };
  const inboundUserContextPromptJoiner = resolveInboundUserContextPromptJoiner(sessionCtx);
  const promptEnvelopeBase = buildReplyPromptEnvelopeBase({
    ctx,
    sessionCtx,
    baseBody: baseBodyFinal,
    hasUserBody,
    inboundUserContext,
    activeGoalContext,
    inboundUserContextPromptJoiner,
    isBareSessionReset,
    startupAction,
    startupContextPrelude,
    softResetTail,
    isHeartbeat,
    inboundEventKind,
    sourceReplyDeliveryMode,
  });
  // A commitment-only wake must not consume the one-shot aborted-run hint;
  // that recovery context belongs to the next normal conversation turn.
  const prefixedBodyBase =
    heartbeatRunScope === "commitment-only"
      ? promptEnvelopeBase.effectiveBaseBody
      : await applySessionHints({
          baseBody: promptEnvelopeBase.effectiveBaseBody,
          abortedLastRun,
          sessionEntry,
          sessionEntryHandle,
          sessionStore,
          sessionKey,
          storePath,
          abortKey: command.abortKey,
        });
  sessionEntry = sessionEntryHandle?.getCurrent() ?? sessionEntry;
  const isGroupSession = sessionEntry?.chatType === "group" || sessionEntry?.chatType === "channel";
  const isMainSession = !isGroupSession && sessionKey === normalizeMainKey(sessionCfg?.mainKey);

  return {
    kind: "ready",
    params,
    runtimePolicySessionKey,
    isHeartbeat,
    heartbeatRunScope,
    explicitThinkingLevelOverride,
    effectiveQueueMode,
    traceRunPhase,
    promptSessionCtx,
    inboundEventKind,
    sourceReplyDeliveryMode,
    silentReplyPromptMode,
    useFastReplyRuntime,
    thinkingRuntime,
    fullAccessState,
    isFirstTurnInSession,
    extraSystemPromptParts,
    extraSystemPromptStatic,
    cliSessionBindingFacts,
    baseBodyTrimmedRaw,
    effectiveResetTriggered,
    isBareSessionReset,
    startupAction,
    startupContextPrelude,
    softResetTail,
    workspaceDir,
    baseBodyFinal,
    hasUserBody,
    shouldInjectGroupIntro,
    typingMode,
    promptEnvelopeBase,
    prefixedBodyBase,
    sessionEntry,
    getSessionEntry: () => sessionEntry,
    isMainSession,
    inboundUserContextPromptJoiner,
    getInboundContext: () => ({ activeGoalContext, inboundUserContext }),
    refreshInboundContextAfterAdmissionWait,
    allowEmptyAssistantReplyAsSilent,
  } as const;
}

export type PreparedReplyRunContext = Extract<
  Awaited<ReturnType<typeof prepareReplyRunContext>>,
  { kind: "ready" }
>;
