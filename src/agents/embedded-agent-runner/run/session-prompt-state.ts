import {
  runWithoutOwnedSessionTranscriptWrites,
  withOwnedSessionTranscriptWrites,
  type SessionTranscriptWriterFence,
} from "../../../config/sessions/transcript-write-context.js";
import type { ContextEngineSessionTarget } from "../../../context-engine/types.js";
import { registerAgentRunContext } from "../../../infra/agent-run-registry.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import type { AgentRunSessionTarget } from "../../run-session-target.js";
import { TOOL_FAILURE_INSTRUCTION } from "../../tool-outcome-instructions.js";
import type { AcceptedCompactionSuccessor } from "../compaction-successor.js";
import { log } from "../logger.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import {
  buildContextEngineCompactionSessionTarget,
  prepareInitialSessionWriter,
} from "./session-bootstrap.js";

const MID_TURN_PRECHECK_CONTINUATION_PROMPT =
  "Continue from the current transcript after the latest tool result. Do not repeat the original user request, and do not rerun completed tools unless the transcript shows they are still needed.";

type ActivePrompt = {
  override?: string;
  persisted: boolean;
  internal: boolean;
};

export function createEmbeddedRunSessionPromptState(input: {
  runParams: PreparedEmbeddedRunInput["runParams"];
  sessionAgentId: string;
  resolvedSessionKey: string;
  lifecycleGeneration: PreparedEmbeddedRunInput["lifecycleGeneration"];
}) {
  const { runParams: params, sessionAgentId, resolvedSessionKey, lifecycleGeneration } = input;
  let activeSessionId = params.sessionId;
  let activeSessionFile = params.sessionFile;
  let activeSessionTarget: ContextEngineSessionTarget | undefined =
    buildContextEngineCompactionSessionTarget({
      agentId: params.agentId ?? sessionAgentId,
      config: params.config,
      sessionFile: activeSessionFile,
      sessionId: activeSessionId,
      sessionKey: resolvedSessionKey,
      sessionTarget: params.sessionTarget,
    });
  const expectedWriterRunId = params.sessionTarget?.expectedWriterRunId?.trim();
  const existingWriterFence: SessionTranscriptWriterFence | undefined = expectedWriterRunId
    ? {
        expectedLifecycleRevision: params.sessionTarget?.expectedLifecycleRevision,
        expectedWriterRunId,
      }
    : undefined;
  const initialWriter = prepareInitialSessionWriter({
    runParams: params,
    target: activeSessionTarget,
  });
  const initialTarget = initialWriter ? { ...activeSessionTarget } : undefined;
  let sessionTargetAdopted = false;
  let committedCompactionSuccessor: AcceptedCompactionSuccessor | undefined;
  // Only retries after this run mutates its transcript may wait for deferred projection work.
  // Fresh attempts retain the projection owner's bounded, retryable failure contract.
  let settleOwnedTranscriptProjection = false;
  let suppressNextUserMessagePersistence = params.suppressNextUserMessagePersistence ?? false;
  let basePromptOverride: string | undefined;
  let compactionContinuationInstruction: string | undefined;
  const activePrompt: ActivePrompt = {
    get override() {
      const instruction = compactionContinuationInstruction;
      return instruction && basePromptOverride?.trim()
        ? `${basePromptOverride}\n\n${instruction}`
        : (instruction ?? basePromptOverride);
    },
    persisted: suppressNextUserMessagePersistence,
    internal: false,
  };

  const notifySessionIdChanged = () => {
    // Update host provenance before callbacks can close the exact run owner.
    registerAgentRunContext(params.runId, { sessionId: activeSessionId, lifecycleGeneration });
    params.replyOperation?.updateSessionId(activeSessionId);
    params.onSessionIdChanged?.(activeSessionId);
  };
  const adoptSessionId = (nextSessionId: string | undefined) => {
    if (!nextSessionId || nextSessionId === activeSessionId) {
      return;
    }
    activeSessionId = nextSessionId;
    notifySessionIdChanged();
  };
  const capturePreparedCompactionTarget = (
    target: Pick<AcceptedCompactionSuccessor, "sessionId" | "sessionFile" | "sessionTarget">,
  ) => {
    activeSessionId = target.sessionId;
    activeSessionFile = target.sessionFile;
    activeSessionTarget = target.sessionTarget;
    sessionTargetAdopted = true;
  };
  const recordCommittedCompactionSuccessor = (accepted: AcceptedCompactionSuccessor) => {
    // Commit-edge bookkeeping only: observers may cancel before the patch promise
    // returns, so neither notification callbacks nor another await belongs here.
    committedCompactionSuccessor = accepted;
    capturePreparedCompactionTarget(accepted);
  };
  const notifyCompactionSessionAdopted = (previousSessionId: string | undefined) => {
    if (previousSessionId && previousSessionId !== activeSessionId) {
      notifySessionIdChanged();
    }
  };
  // Internal control prompts are model-only context, never operator-authored transcript turns.
  const activateInternalPrompt = (prompt: string) => {
    basePromptOverride = prompt;
    Object.assign(activePrompt, { persisted: true, internal: true });
    suppressNextUserMessagePersistence = true;
  };
  const activateCompactionContinuation = (instruction: string) => {
    compactionContinuationInstruction = instruction;
    activateInternalPrompt(basePromptOverride ?? "");
  };
  const clearCompactionContinuation = () => (compactionContinuationInstruction = undefined);
  const onUserMessagePersisted: NonNullable<
    PreparedEmbeddedRunInput["runParams"]["onUserMessagePersisted"]
  > = (message) => {
    const messageMetadata = message as {
      __openclaw?: { beforeAgentRunBlocked?: unknown };
    };
    const blockedBeforeAgentRun = messageMetadata["__openclaw"]?.beforeAgentRunBlocked;
    const markCurrentUserMessagePersisted = () => {
      activePrompt.persisted = true;
      params.onUserMessagePersisted?.(message);
    };
    const recorder = params.userTurnTranscriptRecorder;
    if (!recorder) {
      markCurrentUserMessagePersisted();
      return;
    }
    const markWhenPersisted = (persisted: { message?: unknown } | undefined) => {
      if (persisted?.message || recorder.hasPersisted()) {
        markCurrentUserMessagePersisted();
      }
    };
    const canonicalPersistence =
      blockedBeforeAgentRun !== undefined
        ? recorder.persistBlocked(message)
        : recorder.persistApproved();
    const observedPersistence = canonicalPersistence
      .then(markWhenPersisted)
      .catch((persistError: unknown) => {
        log.warn(
          `failed to persist canonical ${blockedBeforeAgentRun !== undefined ? "blocked " : ""}embedded user turn transcript: ${formatErrorMessage(persistError)}`,
        );
      });
    recorder.markRuntimePersistencePending(observedPersistence);
  };
  const waitForCurrentUserMessagePersistence = async () => {
    if (params.userTurnTranscriptRecorder?.hasRuntimePersistencePending() === true) {
      await params.userTurnTranscriptRecorder.waitForRuntimePersistence();
    }
  };

  return {
    get sessionId() {
      return activeSessionId;
    },
    get sessionFile() {
      return activeSessionFile;
    },
    set sessionFile(value: string) {
      activeSessionFile = value;
    },
    get sessionTarget() {
      return activeSessionTarget;
    },
    set sessionTarget(value: ContextEngineSessionTarget | undefined) {
      activeSessionTarget = value;
      sessionTargetAdopted = true;
    },
    get sessionTargetAdopted() {
      return sessionTargetAdopted;
    },
    get committedCompactionSuccessor() {
      return committedCompactionSuccessor;
    },
    // Context engines receive only portable session identity. Keep the admitted
    // writer fact private while carrying it across rebased/adopted targets.
    get sessionWriterFence() {
      return existingWriterFence ?? initialWriter?.committedFence;
    },
    withSessionWriterContext: <T>(run: () => Promise<T>): Promise<T> =>
      initialWriter && !initialWriter.committedFence
        ? withOwnedSessionTranscriptWrites(
            {
              sessionTarget: initialTarget,
              initialWriter,
              withTranscriptWrite: async (write) => await write(),
            },
            run,
          )
        : runWithoutOwnedSessionTranscriptWrites(run),
    get activePrompt() {
      return activePrompt;
    },
    get suppressNextUserMessagePersistence() {
      return suppressNextUserMessagePersistence;
    },
    set suppressNextUserMessagePersistence(value: boolean) {
      suppressNextUserMessagePersistence = value;
    },
    adoptSessionId,
    capturePreparedCompactionTarget,
    recordCommittedCompactionSuccessor,
    notifyCompactionSessionAdopted,
    activateInternalPrompt,
    activateCompactionContinuation,
    clearCompactionContinuation,
    markOwnedTranscriptRetry: () => {
      settleOwnedTranscriptProjection = true;
    },
    settleOwnedTranscriptProjection: async (
      target: AgentRunSessionTarget | undefined,
      abortSignal?: AbortSignal,
    ) => {
      const sessionId = target?.sessionId ?? activeSessionId;
      // A caller's manager owns the transcript even when metadata has a durable target.
      // Waiting on that borrowed identity can block an unrelated in-memory retry.
      if (settleOwnedTranscriptProjection && !params.sessionManager && target && sessionId) {
        settleOwnedTranscriptProjection = false;
        const { waitForSessionTranscriptProjection } =
          await import("../../../config/sessions/session-transcript-reconcile.js");
        await waitForSessionTranscriptProjection({ ...target, sessionId }, abortSignal);
      }
    },
    continueFromCurrentTranscript: (options?: { includeToolFailureInstruction?: boolean }) => {
      const prompt = options?.includeToolFailureInstruction
        ? `${MID_TURN_PRECHECK_CONTINUATION_PROMPT} ${TOOL_FAILURE_INSTRUCTION}`
        : MID_TURN_PRECHECK_CONTINUATION_PROMPT;
      activateInternalPrompt(prompt);
    },
    onUserMessagePersisted,
    waitForCurrentUserMessagePersistence,
    prepareCompactedTranscriptRetry: async (assertActive: () => void) => {
      await waitForCurrentUserMessagePersistence();
      assertActive();
      settleOwnedTranscriptProjection = true;
      if (activePrompt.internal) {
        suppressNextUserMessagePersistence = activePrompt.persisted;
      } else if (activePrompt.persisted) {
        activateInternalPrompt(MID_TURN_PRECHECK_CONTINUATION_PROMPT);
      }
    },
  };
}
