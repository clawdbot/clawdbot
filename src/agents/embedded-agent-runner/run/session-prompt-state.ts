import type { ContextEngineSessionTarget } from "../../../context-engine/types.js";
import { registerAgentRunContext } from "../../../infra/agent-run-registry.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import {
  resolveAgentRunSessionTarget,
  type AgentRunSessionTarget,
} from "../../run-session-target.js";
import { log } from "../logger.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import { buildContextEngineCompactionSessionTarget } from "./session-bootstrap.js";

const MID_TURN_PRECHECK_CONTINUATION_PROMPT =
  "Continue from the current transcript after the latest tool result. Do not repeat the original user request, and do not rerun completed tools unless the transcript shows they are still needed.";

type ActivePrompt = {
  override?: string;
  persisted: boolean;
  internal: boolean;
};

type SessionWriterFence = Pick<
  AgentRunSessionTarget,
  "expectedLifecycleRevision" | "expectedWriterRunId"
>;

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
  const sessionWriterFence: SessionWriterFence | undefined = expectedWriterRunId
    ? {
        ...(params.sessionTarget?.expectedLifecycleRevision !== undefined
          ? { expectedLifecycleRevision: params.sessionTarget.expectedLifecycleRevision }
          : {}),
        expectedWriterRunId,
      }
    : undefined;
  let sessionTargetAdopted = false;
  // Only retries after this run mutates its transcript may wait for deferred projection work.
  // Fresh attempts retain the projection owner's bounded, retryable failure contract.
  let settleOwnedTranscriptProjection = false;
  let suppressNextUserMessagePersistence = params.suppressNextUserMessagePersistence ?? false;
  let activePrompt: ActivePrompt = {
    persisted: suppressNextUserMessagePersistence,
    internal: false,
  };

  const adoptSessionId = (nextSessionId: string | undefined) => {
    if (!nextSessionId || nextSessionId === activeSessionId) {
      return;
    }
    activeSessionId = nextSessionId;
    // Keep every active-run owner on the rotated identity. Restart recovery
    // uses the reply registry while lifecycle persistence uses run context.
    params.replyOperation?.updateSessionId(activeSessionId);
    params.onSessionIdChanged?.(activeSessionId);
    registerAgentRunContext(params.runId, {
      sessionId: activeSessionId,
      lifecycleGeneration,
    });
  };
  const adoptSessionTarget = async (nextSessionTarget: ContextEngineSessionTarget | undefined) => {
    if (!nextSessionTarget) {
      return;
    }
    const resolvedTarget = await resolveAgentRunSessionTarget({
      agentId: nextSessionTarget.agentId ?? sessionAgentId,
      config: params.config,
      missingSessionKey: "resolve-existing",
      sessionId: nextSessionTarget.sessionId ?? activeSessionId,
      sessionKey: nextSessionTarget.sessionKey ?? resolvedSessionKey,
      sessionTarget: nextSessionTarget,
    });
    activeSessionTarget = {
      ...resolvedTarget,
      ...(nextSessionTarget.threadId !== undefined ? { threadId: nextSessionTarget.threadId } : {}),
    };
    sessionTargetAdopted = true;
    activeSessionFile = resolvedTarget.sessionKey;
    adoptSessionId(resolvedTarget.sessionId);
  };
  // Internal control prompts are model-only context, never operator-authored transcript turns.
  const activateInternalPrompt = (prompt: string) => {
    activePrompt = { override: prompt, persisted: true, internal: true };
    suppressNextUserMessagePersistence = true;
  };
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
    // Context engines receive only portable session identity. Keep the admitted
    // writer fact private while carrying it across rebased/adopted targets.
    get sessionWriterFence() {
      return sessionWriterFence;
    },
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
    adoptSessionTarget,
    activateInternalPrompt,
    markOwnedTranscriptRetry: () => {
      settleOwnedTranscriptProjection = true;
    },
    settleOwnedTranscriptProjection: async (
      target: AgentRunSessionTarget | undefined,
      abortSignal?: AbortSignal,
    ) => {
      const sessionId = target?.sessionId ?? activeSessionId;
      if (settleOwnedTranscriptProjection && target && sessionId) {
        settleOwnedTranscriptProjection = false;
        const { waitForSessionTranscriptProjection } =
          await import("../../../config/sessions/session-transcript-reconcile.js");
        await waitForSessionTranscriptProjection({ ...target, sessionId }, abortSignal);
      }
    },
    continueFromCurrentTranscript: () => {
      activateInternalPrompt(MID_TURN_PRECHECK_CONTINUATION_PROMPT);
    },
    onUserMessagePersisted,
    waitForCurrentUserMessagePersistence,
    prepareCompactedTranscriptRetry: async () => {
      await waitForCurrentUserMessagePersistence();
      settleOwnedTranscriptProjection = true;
      if (activePrompt.internal) {
        suppressNextUserMessagePersistence = activePrompt.persisted;
      } else if (activePrompt.persisted) {
        activateInternalPrompt(MID_TURN_PRECHECK_CONTINUATION_PROMPT);
      }
    },
  };
}
