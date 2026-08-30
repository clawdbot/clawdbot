import { formatErrorMessage } from "../../infra/errors.js";
import { resolveHostFinalDeferredDraftCandidate } from "../embedded-agent-messaging-extraction.js";
import { resolveCliSessionId, type CliRecoveryOptions } from "./cli-run-recovery.js";
import { assertCliRuntimeBinding, resolveCliSourceReplyMirror } from "./cli-run-settlement.js";
import {
  buildCliHookAssistantMessage,
  resolveCliAssistantStopReason,
} from "./cli-run-transcript.js";
import { attachCliMessagingDeliveryEvidence } from "./delivery-evidence.js";
import { createCliFailoverError } from "./exit-error.js";
import { cliBackendLog } from "./log.js";
import type { ClaudeCliRunDiagnosticLifecycle } from "./run-diagnostics.js";
import type { PreparedCliRunContext } from "./types.js";

type ExecutePreparedCliRun = typeof import("./execute.runtime.js").executePreparedCliRun;

type CliAttemptResult = {
  output: Awaited<ReturnType<ExecutePreparedCliRun>>;
  assistantText: string;
  assistantTexts: string[];
  finalCandidateText: string;
  hostFinalDeferredCandidate?: string;
  lastAssistant?: ReturnType<typeof buildCliHookAssistantMessage>;
  sourceReplyWasDelivered: boolean;
  usedHistoryPrompt: boolean;
};

/** Execute one prepared context while preserving the selected runtime and delivery evidence. */
export async function executeCliAttemptForContext(params: {
  attemptContext: PreparedCliRunContext;
  cliSessionIdToUse?: string;
  options?: CliRecoveryOptions;
  diagnosticLifecycle?: ClaudeCliRunDiagnosticLifecycle;
  executePreparedCliRun: ExecutePreparedCliRun;
  cliFailoverContext: Parameters<typeof createCliFailoverError>[2];
}): Promise<CliAttemptResult> {
  const attemptParams = params.attemptContext.params;
  const timeoutMs = params.options?.timeoutMs ?? attemptParams.timeoutMs;
  const forkCliSessionOnResume =
    params.options?.forkCliSessionOnResume ?? attemptParams.forkCliSessionOnResume;
  const cliSessionResumeAt =
    params.cliSessionIdToUse && forkCliSessionOnResume
      ? (params.options?.resumeAt ??
        attemptParams.cliSessionResumeAt ??
        attemptParams.cliSessionBinding?.resumeCheckpointId)
      : undefined;
  const persistCliSessionForkSuccessor =
    params.options?.onForkSuccessorPersisted && attemptParams.persistCliSessionForkSuccessor
      ? async (sessionId: string) => {
          await attemptParams.persistCliSessionForkSuccessor?.(sessionId);
          params.options?.onForkSuccessorPersisted?.(sessionId);
        }
      : attemptParams.persistCliSessionForkSuccessor;
  const effectiveAttemptContext =
    timeoutMs === attemptParams.timeoutMs &&
    forkCliSessionOnResume === attemptParams.forkCliSessionOnResume &&
    cliSessionResumeAt === attemptParams.cliSessionResumeAt &&
    persistCliSessionForkSuccessor === attemptParams.persistCliSessionForkSuccessor
      ? params.attemptContext
      : {
          ...params.attemptContext,
          params: {
            ...attemptParams,
            timeoutMs,
            forkCliSessionOnResume,
            cliSessionResumeAt,
            persistCliSessionForkSuccessor,
          },
        };
  params.diagnosticLifecycle?.setPhase("send");
  const output = await params.executePreparedCliRun(
    effectiveAttemptContext,
    params.cliSessionIdToUse,
    params.diagnosticLifecycle ? { onPhase: params.diagnosticLifecycle.setPhase } : undefined,
  );
  params.diagnosticLifecycle?.setPhase("resolve");
  const sourceReplyMirror = resolveCliSourceReplyMirror({
    evidence: output,
    runParams: attemptParams,
    modelId: params.attemptContext.modelId,
  });
  const assistantText = sourceReplyMirror.delivered
    ? (sourceReplyMirror.visibleText ?? "")
    : output.text.trim();
  const hostFinalDeferredCandidate = resolveHostFinalDeferredDraftCandidate(
    output.messagingToolSourceReplyPayloads,
  );
  const finalCandidateText = hostFinalDeferredCandidate ?? assistantText;
  if (
    !finalCandidateText &&
    !output.didSendViaMessagingTool &&
    attemptParams.allowEmptyAssistantReplyAsSilent !== true
  ) {
    const process = output.diagnostics?.process;
    if (process) {
      const diagnostics = [
        `backend=${process.backendId}`,
        `reason=${process.processReason}`,
        `exitCode=${process.exitCode ?? "null"}`,
        `exitSignal=${process.exitSignal ?? "null"}`,
        `durationMs=${process.durationMs}`,
        `stdoutBytes=${process.stdoutBytes}`,
        `stdoutHash=${process.stdoutHash}`,
        `stderrBytes=${process.stderrBytes}`,
        `stderrHash=${process.stderrHash}`,
        `useResume=${process.useResume ? "true" : "false"}`,
      ].join(" ");
      cliBackendLog.warn(`cli empty response diagnostics: ${diagnostics}`);
    }
    throw attachCliMessagingDeliveryEvidence(
      createCliFailoverError(
        "CLI backend returned an empty response.",
        "empty_response",
        params.cliFailoverContext,
      ),
      output,
    );
  }
  const assistantTexts = assistantText ? [assistantText] : [];
  const lastAssistant =
    finalCandidateText.length > 0
      ? buildCliHookAssistantMessage({
          text: finalCandidateText,
          provider: attemptParams.provider,
          model: params.attemptContext.modelId,
          usage: output.usage,
          stopReason: resolveCliAssistantStopReason(output),
        })
      : undefined;
  return {
    output,
    assistantText,
    assistantTexts,
    finalCandidateText,
    hostFinalDeferredCandidate,
    lastAssistant,
    sourceReplyWasDelivered: sourceReplyMirror.delivered,
    usedHistoryPrompt:
      params.cliSessionIdToUse === undefined &&
      params.attemptContext.openClawHistoryPrompt !== undefined,
  };
}

function assertMatchingCliRevisionRuntime(
  originalContext: PreparedCliRunContext,
  revisionContext: PreparedCliRunContext,
): void {
  const mismatches = [
    ["provider", originalContext.params.provider, revisionContext.params.provider],
    ["model", originalContext.modelId, revisionContext.modelId],
    ["backend", originalContext.backendResolved.id, revisionContext.backendResolved.id],
    [
      "auth profile",
      originalContext.effectiveAuthProfileId,
      revisionContext.effectiveAuthProfileId,
    ],
    [
      "auth binding",
      originalContext.authBindingFingerprint,
      revisionContext.authBindingFingerprint,
    ],
    [
      "runtime owner",
      originalContext.runtimeOwnerFingerprint,
      revisionContext.runtimeOwnerFingerprint,
    ],
    [
      "runtime artifact",
      originalContext.runtimeArtifactFingerprint,
      revisionContext.runtimeArtifactFingerprint,
    ],
  ].filter(([, expected, actual]) => expected !== actual);
  if (mismatches.length > 0) {
    throw new Error(
      `CLI final-candidate revision changed the selected runtime (${mismatches
        .map(([field]) => field)
        .join(", ")})`,
    );
  }
  if (revisionContext.params.disableTools !== true) {
    throw new Error("CLI final-candidate revision did not preserve the required zero-tool cap");
  }
  if (revisionContext.backendResolved.nativeToolMode === "selectable") {
    const availability = revisionContext.params.cliToolAvailability;
    if (!availability || availability.native.length !== 0 || availability.openClaw.length !== 0) {
      throw new Error(
        "CLI final-candidate revision did not enforce an exact empty native/OpenClaw tool surface",
      );
    }
  }
}

async function prepareCliRevisionContext(params: {
  originalContext: PreparedCliRunContext;
  instruction: string;
  successorSessionId?: string;
}): Promise<PreparedCliRunContext> {
  const { prepareCliRunContext } = await import("./prepare.runtime.js");
  return await prepareCliRunContext({
    ...params.originalContext.params,
    prompt: params.instruction,
    transcriptPrompt: params.instruction,
    disableTools: true,
    toolsAllow: undefined,
    cliToolAvailability: undefined,
    cliSessionBinding: undefined,
    cliSessionId: params.successorSessionId,
    forkCliSessionOnResume: false,
    cliSessionResumeAt: undefined,
    claimCliSessionFork: undefined,
    restoreCliSessionFork: undefined,
    persistCliSessionForkSuccessor: undefined,
    onBeforeForkedCliSessionRetry: undefined,
    onBeforeFreshCliSessionRetry: undefined,
    suppressNextUserMessagePersistence: true,
  });
}

async function acceptSourceLocalCleanup(
  callback: (() => void | Promise<void>) | undefined,
): Promise<void> {
  if (!callback) {
    return;
  }
  try {
    await callback();
  } catch (error) {
    cliBackendLog.warn(
      `CLI turn-local final-candidate cleanup failed; continuing accepted action: ${formatErrorMessage(error)}`,
    );
  }
}

async function cleanupCliRevisionContext(
  revisionContext: PreparedCliRunContext | undefined,
): Promise<void> {
  if (!revisionContext) {
    return;
  }
  try {
    await revisionContext.preparedBackend.cleanup?.();
  } catch (error) {
    cliBackendLog.warn(
      `CLI final-candidate revision cleanup failed after execution: ${formatErrorMessage(error)}`,
    );
  }
}

/** Apply the source-local freshness gate and return the one accepted CLI candidate. */
export async function resolveAcceptedCliFinalCandidate(params: {
  initialResult: CliAttemptResult;
  fallbackCliSessionId?: string;
  originalContext: PreparedCliRunContext;
  executeAttemptForContext: (
    context: PreparedCliRunContext,
    cliSessionIdToUse?: string,
  ) => Promise<CliAttemptResult>;
}): Promise<{
  acceptedResult: CliAttemptResult;
  acceptedContext: PreparedCliRunContext;
  acceptedFallbackCliSessionId?: string;
  discarded: boolean;
}> {
  let acceptedResult = params.initialResult;
  let acceptedContext = params.originalContext;
  let acceptedFallbackCliSessionId = params.fallbackCliSessionId;
  let revisionAttempt = 0;
  let discarded = false;
  const gate = params.originalContext.params.onBeforeAgentFinalize;
  try {
    while (true) {
      const { output, finalCandidateText, sourceReplyWasDelivered } = acceptedResult;
      const terminalInterruption = output.terminalInterruption;
      if (!terminalInterruption) {
        await assertCliRuntimeBinding(acceptedContext);
      }
      if (!gate || terminalInterruption || finalCandidateText.length === 0) {
        break;
      }
      if (sourceReplyWasDelivered) {
        throw new Error("CLI source reply was delivered before its required final-candidate gate");
      }

      let decision: Awaited<ReturnType<typeof gate>>;
      try {
        decision = await gate({
          runId: params.originalContext.params.runId,
          sessionId: params.originalContext.params.sessionId,
          sessionKey: params.originalContext.params.sessionKey,
          provider: acceptedContext.params.provider,
          model: acceptedContext.modelId,
          lastAssistantMessage: finalCandidateText,
          revisionAttempt,
        });
      } catch (error) {
        cliBackendLog.warn(
          `CLI turn-local final-candidate gate failed; sending the current draft: ${formatErrorMessage(error)}`,
        );
        break;
      }
      if (decision.action === "continue") {
        break;
      }
      if (decision.action === "discard") {
        await acceptSourceLocalCleanup(decision.onAccepted);
        discarded = true;
        break;
      }
      if (revisionAttempt >= 2) {
        cliBackendLog.warn(
          "CLI turn-local final-candidate gate exceeded two revisions; sending the current draft",
        );
        break;
      }

      let revisionContext: PreparedCliRunContext | undefined;
      let revisionResult: CliAttemptResult;
      const successorSessionId = output.sessionId ?? acceptedFallbackCliSessionId;
      try {
        revisionContext = await prepareCliRevisionContext({
          originalContext: params.originalContext,
          instruction: decision.instruction,
          successorSessionId,
        });
        assertMatchingCliRevisionRuntime(params.originalContext, revisionContext);
        await acceptSourceLocalCleanup(decision.onAccepted);
        revisionResult = await params.executeAttemptForContext(
          revisionContext,
          resolveCliSessionId(revisionContext.reusableCliSession),
        );
      } catch (error) {
        cliBackendLog.warn(
          `CLI final-candidate revision failed; sending the pre-rewrite draft: ${formatErrorMessage(error)}`,
        );
        break;
      } finally {
        await cleanupCliRevisionContext(revisionContext);
      }
      // Binding failures are terminal, not recoverable rewrite failures. Publish
      // the candidate only after validation, including any awaited cleanup.
      await assertCliRuntimeBinding(revisionContext);
      acceptedResult = revisionResult;
      acceptedContext = revisionContext;
      acceptedFallbackCliSessionId = successorSessionId;
      revisionAttempt += 1;
    }
    // Finalizers and accepted-action cleanup can outlive the checked runtime.
    // Revalidate every terminal decision before the caller persists it.
    if (gate && !acceptedResult.output.terminalInterruption) {
      await assertCliRuntimeBinding(acceptedContext);
    }
  } catch (error) {
    throw attachCliMessagingDeliveryEvidence(error, acceptedResult.output);
  }
  return { acceptedResult, acceptedContext, acceptedFallbackCliSessionId, discarded };
}
