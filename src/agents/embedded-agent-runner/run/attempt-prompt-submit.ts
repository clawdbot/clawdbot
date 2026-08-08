/**
 * Submits one prepared prompt while owning provider transforms and cleanup.
 */
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ImageContent } from "../../../llm/types.js";
import type { createTrajectoryRuntimeRecorder } from "../../../trajectory/runtime.js";
import type { AgentMessage } from "../../runtime/index.js";
import { ackPendingAgentSteeringItems } from "../../subagent-registry.js";
import { log } from "../logger.js";
import {
  getProviderPromptState,
  installProviderPromptContextAdmission,
} from "../provider-prompt-state.js";
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
import { MidTurnPrecheckSignal, type MidTurnPrecheckRequest } from "./midturn-precheck.js";
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
  attempt: Pick<EmbeddedRunAttemptParams, "runId" | "sessionId" | "userTurnTranscriptRecorder">;
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
  let pendingMidTurnPrecheckRequest: MidTurnPrecheckRequest | null = null;

  const installProviderPromptAdmission = (): (() => void) => {
    let providerCalls = 0;
    let pendingAdmissionCommit: (() => void) | undefined;
    const providerPromptState = getProviderPromptState(attempt.runId);
    const cleanup = installProviderPromptContextAdmission(
      providerPromptState,
      (context, accountingContext) => {
        const admission = admitProviderPrompt({
          context,
          accountingContext,
          contextTokenBudget: input.contextTokenBudget,
          midTurnPrecheckEnabled: input.midTurnPrecheckEnabled && providerCalls > 0,
          reserveTokens: input.reserveTokens,
          toolResultAggregateMaxChars: input.toolResultAggregateMaxChars,
          toolResultMaxChars: input.toolResultMaxChars,
          projectionState: input.toolResultPromptProjectionState,
        });
        if (admission.status === "recovery_required") {
          pendingMidTurnPrecheckRequest = admission.request;
          log.info(
            `[context-overflow-midturn-precheck] provider context requires recovery ` +
              `route=${admission.request.route} ` +
              `estimatedPromptTokens=${admission.request.estimatedPromptTokens} ` +
              `promptBudgetBeforeReserve=${admission.request.promptBudgetBeforeReserve}`,
          );
          throw new MidTurnPrecheckSignal(admission.request);
        }
        const providerMessages = admission.context.messages as AgentMessage[];
        const admittedProjectionState = admission.projectionState;
        // Adopt the admitted candidate only once the provider response arrives,
        // so a failed request cannot record an unsent prompt as sent.
        pendingAdmissionCommit = () => {
          replaceToolResultPromptProjectionState(
            input.toolResultPromptProjectionState,
            admittedProjectionState,
          );
          providerCalls += 1;
          // Late media must append after the provider accepts the original turn (#99495).
          markSessionUserTurnsSent(input.sessionPromptState, providerMessages);
          const recorder = attempt.userTurnTranscriptRecorder;
          if (
            recorder &&
            hasSessionUserTurnBeenSent(input.sessionPromptState, recorder.message) !== false
          ) {
            recorder.markSentToProvider?.();
          }
        };
        return admission.context;
      },
      () => {
        const commit = pendingAdmissionCommit;
        pendingAdmissionCommit = undefined;
        if (!commit) {
          return false;
        }
        commit();
        return true;
      },
    );
    return cleanup;
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
  const cleanupProviderPromptAdmission = installProviderPromptAdmission();
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
    if (pendingMidTurnPrecheckRequest) {
      const request = pendingMidTurnPrecheckRequest;
      pendingMidTurnPrecheckRequest = null;
      // AgentCore converts stream failures into assistant error messages. Re-raise the attempt-local
      // admission signal after its lifecycle settles so the embedded runner can route recovery.
      throw new MidTurnPrecheckSignal(request);
    }
    if (input.leasedSteering) {
      ackPendingAgentSteeringItems(input.leasedSteering);
      input.onSteeringAcknowledged();
    }
  } finally {
    cleanupProviderPromptAdmission();
    cleanupModelPromptTransform();
  }
}
