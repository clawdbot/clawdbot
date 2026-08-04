/**
 * Submits one prepared prompt while owning provider transforms and cleanup.
 */
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ImageContent } from "../../../llm/types.js";
import type { createTrajectoryRuntimeRecorder } from "../../../trajectory/runtime.js";
import type { AgentMessage } from "../../runtime/index.js";
import { ackPendingAgentSteeringItems } from "../../subagent-registry.js";
import { log } from "../logger.js";
import { normalizeAssistantReplayContent } from "../replay-history.js";
import { updateActiveEmbeddedRunSnapshot } from "../runs.js";
import type {
  getEmbeddedSessionPromptState,
  ToolResultPromptProjectionState,
} from "../session-prompt-state.js";
import {
  hasSessionUserTurnBeenSent,
  markSessionUserTurnsSent,
  replaceToolResultPromptProjectionState,
} from "../session-prompt-state.js";
import { snapshotRecentMessages } from "./attempt-context-summary.js";
import {
  installModelPromptTransform,
  installRuntimeContextMessageForPrompt,
} from "./attempt.llm-boundary.js";
import { wrapStreamFnWithContextTransform } from "./message-transform-stream-wrapper.js";
import { MidTurnPrecheckSignal } from "./midturn-precheck.js";
import { admitProviderPrompt } from "./provider-prompt-admission.js";
import type { RuntimeContextCustomMessage } from "./runtime-context-prompt.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type PromptSubmissionSession = {
  messages: AgentMessage[];
  agent: {
    state: { messages: AgentMessage[] };
    streamFn: StreamFn;
    transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
    continue?: () => Promise<void>;
  };
};

type PromptActiveSession = (
  prompt: string,
  options?: {
    images?: ImageContent[];
    preflightResult?: (submitted: boolean) => void;
  },
) => Promise<void>;

type SteeringLease = {
  leaseId: string;
  runIds: readonly string[];
};

type TrajectoryRecorder = ReturnType<typeof createTrajectoryRuntimeRecorder>;

export async function submitEmbeddedAttemptPrompt(input: {
  attempt: Pick<EmbeddedRunAttemptParams, "sessionId" | "userTurnTranscriptRecorder">;
  activeSession: PromptSubmissionSession;
  appendContext?: string;
  contextTokenBudget: number;
  images: ImageContent[];
  leasedSteering?: SteeringLease;
  modelPrompt: string;
  midTurnPrecheckEnabled: boolean;
  onFinalPromptText: (prompt: string) => void;
  onSteeringAcknowledged: () => void;
  prependContext?: string;
  promptActiveSession: PromptActiveSession;
  runtimeContextMessage?: RuntimeContextCustomMessage;
  runtimeOnly: boolean;
  reserveTokens: number;
  sessionPromptState: ReturnType<typeof getEmbeddedSessionPromptState>;
  systemPrompt: string;
  toolResultAggregateMaxChars: number;
  toolResultMaxChars: number;
  toolResultPromptProjectionState: ToolResultPromptProjectionState;
  trajectoryRecorder: TrajectoryRecorder | null;
  transcriptLeafId: string | null;
  transcriptPrompt: string;
}): Promise<void> {
  const { activeSession, attempt } = input;
  const normalizedReplayMessages = normalizeAssistantReplayContent(activeSession.messages);
  if (normalizedReplayMessages !== activeSession.messages) {
    activeSession.agent.state.messages = normalizedReplayMessages;
  }

  const installProviderPromptHistoryTransform = (): (() => void) => {
    const baseStreamFn = activeSession.agent.streamFn;
    let providerCalls = 0;
    const providerPromptStreamFn = wrapStreamFnWithContextTransform(baseStreamFn, (context) => {
      const admission = admitProviderPrompt({
        context,
        contextTokenBudget: input.contextTokenBudget,
        midTurnPrecheckEnabled: input.midTurnPrecheckEnabled && providerCalls > 0,
        reserveTokens: input.reserveTokens,
        toolResultAggregateMaxChars: input.toolResultAggregateMaxChars,
        toolResultMaxChars: input.toolResultMaxChars,
        projectionState: input.toolResultPromptProjectionState,
      });
      if (admission.status === "recovery_required") {
        log.info(
          `[context-overflow-midturn-precheck] provider context requires recovery ` +
            `route=${admission.request.route} ` +
            `estimatedPromptTokens=${admission.request.estimatedPromptTokens} ` +
            `promptBudgetBeforeReserve=${admission.request.promptBudgetBeforeReserve}`,
        );
        throw new MidTurnPrecheckSignal(admission.request);
      }
      replaceToolResultPromptProjectionState(
        input.toolResultPromptProjectionState,
        admission.projectionState,
      );
      providerCalls += 1;
      const providerMessages = admission.context.messages as AgentMessage[];
      // Mark the current turn sent at provider dispatch so late media appends
      // instead of rewriting its prompt-cache slot (#99495).
      markSessionUserTurnsSent(input.sessionPromptState, providerMessages);
      const recorder = attempt.userTurnTranscriptRecorder;
      if (
        recorder &&
        hasSessionUserTurnBeenSent(input.sessionPromptState, recorder.message) !== false
      ) {
        recorder.markSentToProvider?.();
      }
      return admission.context;
    });
    activeSession.agent.streamFn = providerPromptStreamFn;
    return () => {
      if (activeSession.agent.streamFn === providerPromptStreamFn) {
        activeSession.agent.streamFn = baseStreamFn;
      }
    };
  };

  input.onFinalPromptText(input.transcriptPrompt);
  input.trajectoryRecorder?.recordEvent("prompt.submitted", {
    prompt: input.modelPrompt,
    systemPrompt: input.systemPrompt,
    messages: activeSession.messages,
    imagesCount: input.images.length,
  });
  updateActiveEmbeddedRunSnapshot(attempt.sessionId, {
    transcriptLeafId: input.transcriptLeafId,
    messages: snapshotRecentMessages(normalizedReplayMessages),
    inFlightPrompt: input.transcriptPrompt,
  });

  let captureCurrentPromptForModel = false;
  const cleanupModelPromptTransform = installModelPromptTransform({
    session: activeSession,
    transcriptPrompt: input.transcriptPrompt,
    modelPrompt: input.modelPrompt,
    prependContext: input.prependContext,
    appendContext: input.appendContext,
    shouldCapturePrompt: () => captureCurrentPromptForModel,
  });
  const armModelPromptTransform = (submitted: boolean) => {
    if (submitted) {
      captureCurrentPromptForModel = true;
    }
  };
  const cleanupProviderPromptHistoryTransform = installProviderPromptHistoryTransform();
  try {
    if (input.runtimeOnly) {
      await input.promptActiveSession(input.transcriptPrompt, {
        preflightResult: armModelPromptTransform,
      });
    } else {
      const cleanupRuntimeContextMessage = installRuntimeContextMessageForPrompt({
        session: activeSession,
        message: input.runtimeContextMessage,
      });
      try {
        await input.promptActiveSession(input.transcriptPrompt, {
          ...(input.images.length > 0 ? { images: input.images } : {}),
          preflightResult: armModelPromptTransform,
        });
      } finally {
        cleanupRuntimeContextMessage();
      }
    }
    if (input.leasedSteering) {
      ackPendingAgentSteeringItems(input.leasedSteering);
      input.onSteeringAcknowledged();
    }
  } finally {
    cleanupProviderPromptHistoryTransform();
    cleanupModelPromptTransform();
  }
}
