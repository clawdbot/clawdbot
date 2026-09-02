import { setReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  externalCliDiscoveryForProviderAuth,
  loadAuthProfileStoreForRuntime,
  markAuthProfileFailure,
  markAuthProfileSuccess,
  type AuthProfileStore,
} from "../auth-profiles.js";
import {
  resolveCliRuntimeArtifactFingerprint,
  resolveCliRuntimeOwnerFingerprint,
} from "../cli-auth-epoch.js";
import type { CliOutput, CliTerminalInterruption } from "../cli-output-contracts.js";
import { claudeCliSessionTranscriptHasContent as claudeCliSessionTranscriptHasContentImpl } from "../command/attempt-execution.helpers.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent-runner.js";
import { resolveExplicitFinalSourceReplyDeliveryEvidence } from "../embedded-agent-runner/delivery-evidence.js";
import { resolveAuthProfileFailureReason } from "../embedded-agent-runner/run/auth-profile-failure-policy.js";
import { buildEmbeddedRunPayloads } from "../embedded-agent-runner/run/payloads.js";
import { mergeAttemptToolMediaPayloads } from "../embedded-agent-runner/run/tool-media-payloads.js";
import { coerceToFailoverError, isFailoverError } from "../failover-error.js";
import { CliAuthProfilePreparationError } from "./auth-profile-preparation-error.js";
import { hashCliReseedPrompt } from "./reseed-envelope.js";
import type { ClaudeCliRunDiagnosticLifecycle } from "./run-diagnostics.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

const log = createSubsystemLogger("agents/cli-runner");

/** Formats the visible terminal reason for an interrupted turn that retained partial output. */
export function formatCliTerminalInterruption(interruption: CliTerminalInterruption): string {
  return `CLI turn ${interruption.reason} after partial output`;
}

export const cliRunSettlementDeps = {
  claudeCliSessionTranscriptHasContent: claudeCliSessionTranscriptHasContentImpl,
  delay: async (delayMs: number) => {
    await new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
  },
  loadAuthProfileStoreForRuntime,
  markAuthProfileFailure,
  markAuthProfileSuccess,
};

async function settleCliAuthProfile(params: {
  store: AuthProfileStore;
  profileId: string;
  provider: string;
  agentDir?: string;
  terminal:
    | { outcome: "success" }
    | {
        outcome: "failure";
        error: unknown;
        config?: RunCliAgentParams["config"];
        runId: string;
        modelId?: string;
      };
}): Promise<void> {
  try {
    if (params.terminal.outcome === "success") {
      await cliRunSettlementDeps.markAuthProfileSuccess({
        store: params.store,
        profileId: params.profileId,
        provider: params.provider,
        agentDir: params.agentDir,
      });
      return;
    }
    const error = params.terminal.error;
    const reason = resolveAuthProfileFailureReason({
      failoverReason: isFailoverError(error) ? error.reason : null,
      providerStarted:
        isFailoverError(error) && error.reason === "timeout"
          ? error.cliTimeout?.observedActivity
          : undefined,
    });
    if (reason) {
      await cliRunSettlementDeps.markAuthProfileFailure({
        store: params.store,
        profileId: params.profileId,
        reason,
        cfg: params.terminal.config,
        agentDir: params.agentDir,
        runId: params.terminal.runId,
        modelId: params.terminal.modelId,
      });
    }
  } catch (error) {
    log.warn(
      `CLI auth-profile ${params.terminal.outcome} settlement failed: ${formatErrorMessage(error)}`,
    );
  }
}

export function isClaudeCliBackend(provider: string): boolean {
  return provider.trim().toLowerCase() === "claude-cli";
}

export async function assertCliRuntimeBinding(context: PreparedCliRunContext): Promise<void> {
  if (!context.runtimeArtifactFingerprint) {
    return;
  }
  const currentArtifact = await resolveCliRuntimeArtifactFingerprint({
    provider: context.params.provider,
    config: context.params.config ?? context.contextEngineConfig,
    agentId: context.params.agentId,
    runtimeArtifactId: context.backendResolved.id,
  });
  if (currentArtifact !== context.runtimeArtifactFingerprint) {
    throw new Error("CLI executable/package artifact changed during successful inference");
  }
  if (!context.runtimeOwnerFingerprint) {
    return;
  }
  const currentOwner = await resolveCliRuntimeOwnerFingerprint({
    provider: context.params.provider,
    config: context.params.config ?? context.contextEngineConfig,
    ...(context.agentDir ? { agentDir: context.agentDir } : {}),
    agentId: context.params.agentId,
    runtimeOwnerId: context.backendResolved.id,
    ...(context.effectiveAuthProfileId ? { authProfileId: context.effectiveAuthProfileId } : {}),
    ...(context.authBindingSkipsLocalCredential ? { skipLocalCredential: true } : {}),
    runtimeArtifactFingerprint: currentArtifact,
  });
  if (currentOwner !== context.runtimeOwnerFingerprint) {
    throw new Error("CLI runtime owner changed during successful inference");
  }
}

export async function settleCliPreparationError(
  error: unknown,
  params: RunCliAgentParams,
): Promise<void> {
  if (!(error instanceof CliAuthProfilePreparationError)) {
    return;
  }
  const store = cliRunSettlementDeps.loadAuthProfileStoreForRuntime(error.agentDir, {
    externalCli: externalCliDiscoveryForProviderAuth({
      cfg: params.config,
      provider: error.provider,
      profileId: error.profileId,
    }),
  });
  await settleCliAuthProfile({
    store,
    profileId: error.profileId,
    provider: error.provider,
    agentDir: error.agentDir,
    terminal: {
      outcome: "failure",
      error,
      config: params.config,
      runId: params.runId,
      modelId: params.model,
    },
  });
}

export async function settlePreparedCliRun(params: {
  context: PreparedCliRunContext;
  diagnosticLifecycle?: ClaudeCliRunDiagnosticLifecycle;
  run: () => Promise<EmbeddedAgentRunResult>;
}): Promise<EmbeddedAgentRunResult> {
  const { context, diagnosticLifecycle, run } = params;
  const runParams = context.params;
  let result: EmbeddedAgentRunResult | undefined;
  let runError: unknown;
  try {
    result = await run();
  } catch (error) {
    runError = error;
  }
  const terminalRunError = runError;
  let cleanupError: unknown;
  const recordCleanupError = (error: unknown) => {
    cleanupError ??= error;
  };
  if (runParams.cleanupCliLiveSessionOnRunEnd === true) {
    try {
      const { closeCliLiveSession } = await import("./cli-live-session-registry.js");
      await closeCliLiveSession(context, "restart");
    } catch (error) {
      recordCleanupError(error);
    }
  }
  if (runParams.cleanupBundleMcpOnRunEnd === true) {
    // The run's session ID is immutable; its session key can already belong to
    // a newer run. Never retire the newer runtime or close the shared listener.
    try {
      const { retireSessionMcpRuntime } = await import("../agent-bundle-mcp-tools.js");
      await retireSessionMcpRuntime({
        sessionId: runParams.sessionId,
        reason: "cli-run-end",
        onError: recordCleanupError,
      });
    } catch (error) {
      recordCleanupError(error);
    }
  }
  if (cleanupError) {
    if (runError || result?.didSendViaMessagingTool === true) {
      log.warn(`cli run cleanup failed after completion: ${formatErrorMessage(cleanupError)}`);
    } else {
      diagnosticLifecycle?.setPhase("cleanup");
      runError =
        cleanupError instanceof Error ? cleanupError : new Error(formatErrorMessage(cleanupError));
    }
  }
  // Settle only after backend recovery is exhausted. Recording inside an
  // attempt would quarantine a healthy profile for a recovered session fault.
  if (context.effectiveAuthProfileId && context.authProfileStore) {
    const profileId = context.effectiveAuthProfileId;
    const authProfileStore = context.authProfileStore;
    if (terminalRunError) {
      await settleCliAuthProfile({
        store: authProfileStore,
        profileId,
        provider: authProfileStore.profiles[profileId]?.provider ?? runParams.provider,
        agentDir: context.agentDir,
        terminal: {
          outcome: "failure",
          error: terminalRunError,
          config: runParams.config,
          runId: runParams.runId,
          modelId: context.modelId,
        },
      });
    } else if (result?.meta.executionTrace?.attempts?.at(-1)?.result === "success") {
      const provider = authProfileStore.profiles[profileId]?.provider ?? runParams.provider;
      await settleCliAuthProfile({
        store: authProfileStore,
        profileId,
        provider,
        agentDir: context.agentDir,
        terminal: { outcome: "success" },
      });
    }
  }
  if (runError) {
    throw runError instanceof Error ? runError : new Error(formatErrorMessage(runError));
  }
  return result as EmbeddedAgentRunResult;
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
  preparedContextAgentMeta: { contextTokens?: number };
  sessionBindingDisabled: boolean;
}): EmbeddedAgentRunResult {
  const { context, message, preparedContextAgentMeta, sessionBindingDisabled } = params;
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
        ...preparedContextAgentMeta,
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
  preparedContextAgentMeta: { contextTokens?: number };
  sessionBindingDisabled: boolean;
  reusableCliSessionId?: string;
}): EmbeddedAgentRunResult {
  const {
    context,
    error,
    evidence,
    preparedContextAgentMeta,
    reusableCliSessionId,
    sessionBindingDisabled,
  } = params;
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
        ...preparedContextAgentMeta,
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
  effectiveCliSessionId?: string;
  bindingFlushOk?: boolean;
  assistantTranscriptOwned?: boolean;
  assistantTranscriptIdempotencyKey?: string;
  usedHistoryPrompt: boolean;
  userTurnHandled: boolean;
  sessionBindingDisabled: boolean;
  preparedContextAgentMeta: { contextTokens?: number };
}): EmbeddedAgentRunResult {
  const {
    assistantTranscriptOwned,
    assistantTranscriptIdempotencyKey,
    bindingFlushOk,
    context,
    effectiveCliSessionId,
    output,
    preparedContextAgentMeta,
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
          : runParams.allowEmptyAssistantReplyAsSilent === true
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
  const yielded = output.yielded === true;
  const stopReason = terminalInterruption?.reason ?? (yielded ? "end_turn" : "completed");

  if (!terminalInterruption) {
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

  return {
    payloads: payloadsWithToolMedia,
    meta: {
      durationMs: Date.now() - context.started,
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
            result: terminalInterruption?.reason ?? "success",
            ...(terminalInterruption
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
        finishReason: terminalInterruption?.reason ?? (yielded ? "end_turn" : "stop"),
        stopReason,
        refusal: false,
      },
      ...(output.toolSummary ? { toolSummary: output.toolSummary } : {}),
      agentMeta: {
        sessionId: agentSessionId,
        provider: runParams.provider,
        model: context.modelId,
        ...preparedContextAgentMeta,
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
}

export function settleCliBackendOutcome(params: {
  runResult: EmbeddedAgentRunResult | undefined;
  runError: unknown;
  runFailed: boolean;
  cleanupError: Error | undefined;
  deliveredMessagingSideEffect: boolean;
  diagnosticLifecycle?: ClaudeCliRunDiagnosticLifecycle;
  failoverContext: { provider: string; model: string; sessionId: string; lane?: string };
}): EmbeddedAgentRunResult {
  const {
    cleanupError,
    deliveredMessagingSideEffect,
    diagnosticLifecycle,
    failoverContext,
    runError,
    runFailed,
    runResult,
  } = params;
  if (cleanupError) {
    if (!deliveredMessagingSideEffect) {
      if (runFailed) {
        log.warn(`CLI run also failed before backend cleanup: ${formatErrorMessage(runError)}`);
      }
      diagnosticLifecycle?.setPhase("cleanup");
      throw cleanupError;
    }
    log.warn(
      `CLI backend cleanup failed after confirmed message delivery: ${formatErrorMessage(cleanupError)}`,
    );
  }
  if (runFailed) {
    throw coerceToFailoverError(runError, failoverContext) ?? runError;
  }
  if (!runResult) {
    throw new Error("CLI run completed without a result");
  }
  return runResult;
}
