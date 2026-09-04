/** Projects CLI completion and terminal failure through the existing reply contract. */
import { setReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { appendAgentRunFailure } from "../agent-run-result.js";
import type { CliOutput, CliTerminalInterruption } from "../cli-output-contracts.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent-runner.js";
import { resolveExplicitFinalSourceReplyDeliveryEvidence } from "../embedded-agent-runner/delivery-evidence.js";
import { buildEmbeddedRunPayloads } from "../embedded-agent-runner/run/payloads.js";
import { mergeAttemptToolMediaPayloads } from "../embedded-agent-runner/run/tool-media-payloads.js";
import { hashCliReseedPrompt } from "./reseed-envelope.js";
import { formatCliToolCleanupError, type CliToolCleanupFailure } from "./tool-cleanup-error.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

export function isClaudeCliBackend(provider: string): boolean {
  return provider.trim().toLowerCase() === "claude-cli";
}

function buildCliContextAgentMeta(context: PreparedCliRunContext) {
  return isClaudeCliBackend(context.params.provider) && context.contextWindowInfo
    ? { contextTokens: context.contextWindowInfo.tokens, contextTokensSource: "resolved" as const }
    : {};
}

/** Formats an interrupted turn that retained partial output. */
export function formatCliTerminalInterruption(interruption: CliTerminalInterruption): string {
  return `CLI turn ${interruption.reason} after partial output`;
}

export function buildCliToolCleanupResult(
  context: PreparedCliRunContext,
  failure: CliToolCleanupFailure,
): EmbeddedAgentRunResult {
  return buildCliRunResult({
    context,
    output: failure.output,
    toolCleanupFailure: failure,
    effectiveCliSessionId: failure.output.sessionId,
    // Failed finalization cannot establish a new successful reseed receipt.
    usedHistoryPrompt: false,
    userTurnHandled: false,
    sessionBindingDisabled: context.preparedBackend.backend.sessionMode === "none",
  });
}

export function resolveCliSourceReplyMirror(params: {
  evidence: Pick<
    CliOutput,
    | "didSendViaMessagingTool"
    | "didDeliverSourceReplyViaMessageTool"
    | "messagingToolSentTargets"
    | "messagingToolSourceReplyPayloads"
  >;
  runParams: RunCliAgentParams;
  modelId: string;
}): { payloads: ReplyPayload[]; delivered: boolean; visibleText?: string } {
  const { evidence, modelId, runParams } = params;
  const payloads = buildEmbeddedRunPayloads({
    assistantTexts: [],
    lastAssistant: undefined,
    sessionKey: runParams.sessionKey ?? "",
    provider: runParams.provider,
    model: modelId,
    didSendViaMessagingTool: evidence.didSendViaMessagingTool,
    didDeliverSourceReplyViaMessageTool: evidence.didDeliverSourceReplyViaMessageTool,
    messagingToolSentTargets: evidence.messagingToolSentTargets,
    messagingToolSourceReplyPayloads: evidence.messagingToolSourceReplyPayloads,
    sourceReplyDeliveryMode: runParams.sourceReplyDeliveryMode,
    agentId: runParams.agentId,
    runId: runParams.runId,
  });
  const delivered =
    payloads.length > 0 ||
    (runParams.sourceReplyDeliveryMode === "message_tool_only" &&
      evidence.didDeliverSourceReplyViaMessageTool === true);
  const visibleText =
    payloads
      .map((payload) => payload.text?.trim() ?? "")
      .filter(Boolean)
      .join("\n\n") || undefined;
  return { payloads, delivered, visibleText };
}

export function buildBlockedCliRunResult(params: {
  message: string;
  context: PreparedCliRunContext;
  sessionBindingDisabled: boolean;
}): EmbeddedAgentRunResult {
  const { context, message, sessionBindingDisabled } = params;
  const runParams = context.params;
  return {
    payloads: [{ text: message, isError: true }],
    meta: {
      durationMs: Date.now() - context.started,
      finalAssistantVisibleText: message,
      finalAssistantRawText: message,
      livenessState: "blocked",
      error: {
        kind: "hook_block",
        message,
      },
      systemPromptReport: context.systemPromptReport,
      executionTrace: {
        winnerProvider: runParams.provider,
        winnerModel: context.modelId,
        attempts: [
          {
            provider: runParams.provider,
            model: context.modelId,
            result: "error",
            reason: "before_agent_run blocked the run",
          },
        ],
        fallbackUsed: false,
        runner: "cli",
      },
      requestShaping: {
        ...(runParams.thinkLevel ? { thinking: runParams.thinkLevel } : {}),
        ...(context.effectiveAuthProfileId ? { authMode: "auth-profile" } : {}),
      },
      completion: {
        finishReason: "blocked",
        stopReason: "blocked",
        refusal: true,
      },
      agentMeta: {
        sessionId: runParams.sessionId ?? "",
        provider: runParams.provider,
        model: context.modelId,
        ...buildCliContextAgentMeta(context),
        ...(sessionBindingDisabled ? { clearCliSessionBinding: true } : {}),
      },
    },
  };
}

export function buildCliDeliveredFailure(params: {
  error: unknown;
  evidence: NonNullable<
    ReturnType<typeof import("./delivery-evidence.js").getCliMessagingDeliveryEvidence>
  >;
  context: PreparedCliRunContext;
  sessionBindingDisabled: boolean;
  reusableCliSessionId?: string;
}): EmbeddedAgentRunResult {
  const { context, error, evidence, reusableCliSessionId, sessionBindingDisabled } = params;
  const runParams = context.params;
  const message = formatErrorMessage(error);
  const { payloads } = resolveCliSourceReplyMirror({
    evidence,
    runParams,
    modelId: context.modelId,
  });
  const visiblePayloads =
    payloads.length > 0
      ? payloads
      : resolveExplicitFinalSourceReplyDeliveryEvidence(evidence) === false
        ? [{ text: "The reply stopped after sending progress. Please try again.", isError: true }]
        : undefined;
  return {
    ...(visiblePayloads ? { payloads: visiblePayloads } : {}),
    meta: {
      durationMs: Date.now() - context.started,
      systemPromptReport: context.systemPromptReport,
      stopReason: "error",
      executionTrace: {
        winnerProvider: runParams.provider,
        winnerModel: context.modelId,
        attempts: [
          {
            provider: runParams.provider,
            model: context.modelId,
            result: "error",
            reason: message,
          },
        ],
        fallbackUsed: false,
        runner: "cli",
      },
      requestShaping: {
        ...(runParams.thinkLevel ? { thinking: runParams.thinkLevel } : {}),
        ...(context.effectiveAuthProfileId ? { authMode: "auth-profile" } : {}),
      },
      completion: {
        finishReason: "error",
        stopReason: "error",
        refusal: false,
      },
      agentMeta: {
        sessionId: "",
        provider: runParams.provider,
        model: context.modelId,
        ...buildCliContextAgentMeta(context),
        ...(sessionBindingDisabled || reusableCliSessionId ? { clearCliSessionBinding: true } : {}),
      },
    },
    didSendViaMessagingTool: true,
    ...(evidence.didDeliverSourceReplyViaMessageTool
      ? { didDeliverSourceReplyViaMessageTool: true }
      : {}),
    ...(evidence.messagingToolSentTexts?.length
      ? { messagingToolSentTexts: evidence.messagingToolSentTexts }
      : {}),
    ...(evidence.messagingToolSentMediaUrls?.length
      ? { messagingToolSentMediaUrls: evidence.messagingToolSentMediaUrls }
      : {}),
    ...(evidence.messagingToolSentTargets?.length
      ? { messagingToolSentTargets: evidence.messagingToolSentTargets }
      : {}),
    ...(evidence.messagingToolSourceReplyPayloads?.length
      ? { messagingToolSourceReplyPayloads: evidence.messagingToolSourceReplyPayloads }
      : {}),
  };
}

export function buildCliRunResult(params: {
  context: PreparedCliRunContext;
  output: CliOutput;
  toolCleanupFailure?: CliToolCleanupFailure;
  effectiveCliSessionId?: string;
  bindingFlushOk?: boolean;
  assistantTranscriptOwned?: boolean;
  assistantTranscriptIdempotencyKey?: string;
  usedHistoryPrompt: boolean;
  userTurnHandled: boolean;
  sessionBindingDisabled: boolean;
}): EmbeddedAgentRunResult {
  const {
    assistantTranscriptOwned,
    assistantTranscriptIdempotencyKey,
    bindingFlushOk,
    context,
    effectiveCliSessionId,
    output,
    toolCleanupFailure,
    sessionBindingDisabled,
    usedHistoryPrompt,
    userTurnHandled,
  } = params;
  const runParams = context.params;
  const text = output.text?.trim();
  const rawText = output.rawText?.trim();
  const sourceReplyMirror = resolveCliSourceReplyMirror({
    evidence: output,
    runParams,
    modelId: context.modelId,
  });
  const finalAssistantVisibleText = sourceReplyMirror.delivered
    ? sourceReplyMirror.visibleText
    : text;
  const payloads =
    sourceReplyMirror.payloads.length > 0
      ? sourceReplyMirror.payloads
      : sourceReplyMirror.delivered
        ? undefined
        : text
          ? [
              assistantTranscriptOwned
                ? setReplyPayloadMetadata(
                    { text },
                    {
                      assistantTranscriptOwned: true,
                      ...(assistantTranscriptIdempotencyKey
                        ? { assistantTranscriptIdempotencyKey }
                        : {}),
                    },
                  )
                : { text },
            ]
          : !toolCleanupFailure && runParams.allowEmptyAssistantReplyAsSilent === true
            ? [{ text: SILENT_REPLY_TOKEN }]
            : undefined;
  const payloadsWithToolMedia = mergeAttemptToolMediaPayloads({
    payloads,
    toolMediaUrls: output.toolMediaUrls,
    toolAudioAsVoice: output.toolAudioAsVoice,
    toolTrustedLocalMedia: output.toolTrustedLocalMedia,
    sourceReplyDeliveryMode: runParams.sourceReplyDeliveryMode,
  });
  const unflushedCliSessionId =
    !sessionBindingDisabled && effectiveCliSessionId && bindingFlushOk === false
      ? effectiveCliSessionId
      : undefined;
  const terminalInterruption = output.terminalInterruption;
  // An interrupted process cannot preserve its now-invalid native session binding.
  const cliSessionBindingCleared =
    terminalInterruption !== undefined ||
    sessionBindingDisabled ||
    unflushedCliSessionId !== undefined;
  const persistedCliSessionId = cliSessionBindingCleared ? undefined : effectiveCliSessionId;
  const createdReseedReceipt =
    persistedCliSessionId &&
    usedHistoryPrompt &&
    isClaudeCliBackend(runParams.provider) &&
    output.finalPromptText !== undefined &&
    userTurnHandled &&
    runParams.sessionId
      ? {
          version: 1 as const,
          promptHash: hashCliReseedPrompt(output.finalPromptText),
          localSessionId: runParams.sessionId,
          userTurnDisposition: runParams.userTurnTranscriptRecorder?.hasPersisted()
            ? ("persisted" as const)
            : ("omitted" as const),
        }
      : undefined;
  const preservedReseedReceipt =
    runParams.cliSessionBinding && persistedCliSessionId === runParams.cliSessionBinding.sessionId
      ? runParams.cliSessionBinding.reseedReceipt
      : undefined;
  const reseedReceipt = createdReseedReceipt ?? preservedReseedReceipt;
  const agentSessionId =
    terminalInterruption || unflushedCliSessionId
      ? ""
      : sessionBindingDisabled
        ? (runParams.sessionId ?? "")
        : (effectiveCliSessionId ?? runParams.sessionId ?? "");
  const yielded = output.yielded === true && !toolCleanupFailure;
  const cleanupMessage = toolCleanupFailure
    ? formatCliToolCleanupError(toolCleanupFailure.error)
    : undefined;
  const stopReason =
    terminalInterruption?.reason ?? (cleanupMessage ? "error" : yielded ? "end_turn" : "completed");

  if (!terminalInterruption && !toolCleanupFailure) {
    runParams.onSuccessfulAuthBinding?.({
      ...(context.effectiveAuthProfileId ? { authProfileId: context.effectiveAuthProfileId } : {}),
      ...(context.authBindingFingerprint
        ? { authFingerprint: context.authBindingFingerprint }
        : {}),
      ...(!context.authBindingFingerprint && context.runtimeOwnerFingerprint
        ? {
            runtimeOwnerFingerprint: context.runtimeOwnerFingerprint,
            runtimeOwnerKind: "cli-runtime" as const,
            runtimeOwnerId: context.backendResolved.id,
          }
        : {}),
      ...(context.runtimeArtifactFingerprint
        ? {
            runtimeArtifactFingerprint: context.runtimeArtifactFingerprint,
            runtimeArtifactId: context.backendResolved.id,
          }
        : {}),
      ...(context.authBindingSkipsLocalCredential ? { skipLocalCredential: true } : {}),
    });
  }

  const result: EmbeddedAgentRunResult = {
    payloads: payloadsWithToolMedia,
    meta: {
      durationMs: Date.now() - context.started,
      ...(cleanupMessage ? { stopReason } : {}),
      ...(output.finalPromptText ? { finalPromptText: output.finalPromptText } : {}),
      ...(finalAssistantVisibleText || rawText
        ? {
            ...(finalAssistantVisibleText ? { finalAssistantVisibleText } : {}),
            ...(rawText ? { finalAssistantRawText: rawText } : {}),
          }
        : {}),
      systemPromptReport: context.systemPromptReport,
      ...(terminalInterruption
        ? {
            aborted: true,
            providerStarted: true,
            stopReason,
            ...(terminalInterruption.reason === "timeout"
              ? { timeoutPhase: "provider" as const }
              : {}),
          }
        : yielded
          ? { yielded: true, livenessState: "paused" as const, stopReason }
          : {}),
      ...(output.yieldAcknowledgment ? { yieldAcknowledgment: output.yieldAcknowledgment } : {}),
      executionTrace: {
        winnerProvider: runParams.provider,
        winnerModel: context.modelId,
        attempts: [
          {
            provider: runParams.provider,
            model: context.modelId,
            result: terminalInterruption?.reason ?? (toolCleanupFailure ? "error" : "success"),
            ...(cleanupMessage
              ? { reason: cleanupMessage }
              : terminalInterruption
                ? { reason: formatCliTerminalInterruption(terminalInterruption) }
                : {}),
          },
        ],
        fallbackUsed: false,
        runner: "cli",
      },
      requestShaping: {
        ...(runParams.thinkLevel ? { thinking: runParams.thinkLevel } : {}),
        ...(context.effectiveAuthProfileId ? { authMode: "auth-profile" } : {}),
      },
      completion: {
        finishReason:
          terminalInterruption?.reason ??
          (toolCleanupFailure ? "error" : yielded ? "end_turn" : "stop"),
        stopReason,
        refusal: false,
      },
      ...(output.toolSummary ? { toolSummary: output.toolSummary } : {}),
      agentMeta: {
        sessionId: agentSessionId,
        provider: runParams.provider,
        model: context.modelId,
        ...buildCliContextAgentMeta(context),
        usage: output.usage,
        ...(output.usage ? { lastCallUsage: output.usage } : {}),
        ...(output.diagnosticUsage ? { diagnosticUsage: output.diagnosticUsage } : {}),
        ...(persistedCliSessionId
          ? {
              cliSessionBinding: {
                sessionId: persistedCliSessionId,
                ...(context.effectiveAuthProfileId
                  ? { authProfileId: context.effectiveAuthProfileId }
                  : {}),
                ...(output.resumeCheckpointId
                  ? { resumeCheckpointId: output.resumeCheckpointId }
                  : {}),
                ...(context.authEpoch ? { authEpoch: context.authEpoch } : {}),
                authEpochVersion: context.authEpochVersion,
                ...(context.extraSystemPromptHash
                  ? { extraSystemPromptHash: context.extraSystemPromptHash }
                  : {}),
                ...(context.messageToolPolicyHash
                  ? { messageToolPolicyHash: context.messageToolPolicyHash }
                  : {}),
                ...(context.promptToolNamesHash
                  ? { promptToolNamesHash: context.promptToolNamesHash }
                  : {}),
                ...(context.cwdHash ? { cwdHash: context.cwdHash } : {}),
                ...(context.preparedBackend.mcpConfigHash
                  ? { mcpConfigHash: context.preparedBackend.mcpConfigHash }
                  : {}),
                ...(context.preparedBackend.mcpResumeHash
                  ? { mcpResumeHash: context.preparedBackend.mcpResumeHash }
                  : {}),
                ...(reseedReceipt ? { reseedReceipt } : {}),
              },
            }
          : {}),
        ...(cliSessionBindingCleared ? { clearCliSessionBinding: true } : {}),
      },
    },
    ...(output.didSendViaMessagingTool ? { didSendViaMessagingTool: true } : {}),
    ...(output.didDeliverSourceReplyViaMessageTool
      ? { didDeliverSourceReplyViaMessageTool: true }
      : {}),
    ...(output.messagingToolSentTexts?.length
      ? { messagingToolSentTexts: output.messagingToolSentTexts }
      : {}),
    ...(output.messagingToolSentMediaUrls?.length
      ? { messagingToolSentMediaUrls: output.messagingToolSentMediaUrls }
      : {}),
    ...(output.messagingToolSentTargets?.length
      ? { messagingToolSentTargets: output.messagingToolSentTargets }
      : {}),
    ...(output.messagingToolSourceReplyPayloads?.length
      ? { messagingToolSourceReplyPayloads: output.messagingToolSourceReplyPayloads }
      : {}),
    ...(output.acceptedSessionSpawns?.length
      ? { acceptedSessionSpawns: output.acceptedSessionSpawns }
      : {}),
  };
  return cleanupMessage ? appendAgentRunFailure(result, cleanupMessage) : result;
}
