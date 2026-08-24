/**
 * Submits or skips the prompt after build/preflight and before stream execution.
 * It may assume prompt context is assembled and admission state is published.
 */
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ImageContent } from "../../../llm/types.js";
import { getAgentScopedMediaLocalRoots } from "../../../media/local-roots.js";
import { readPersistedMediaFacts } from "../../../media/media-facts.js";
import { resolveSessionToolMode } from "../../../plugins/session-tool-modes.js";
import type { createTrajectoryRuntimeRecorder } from "../../../trajectory/runtime.js";
import { resolveImageSanitizationLimits } from "../../image-sanitization.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { SandboxContext } from "../../sandbox/types.js";
import type { AgentSession } from "../../sessions/index.js";
import { ackPendingAgentSteeringItems } from "../../subagents/registry/subagent-registry.js";
import { normalizeAssistantReplayContent } from "../replay-history.js";
import { updateActiveEmbeddedRunSnapshot } from "../runs.js";
import {
  type getEmbeddedSessionPromptState,
  type ToolResultPromptProjectionState,
  hasSessionUserTurnBeenSent,
  markSessionUserTurnsSent,
} from "../session-prompt-state.js";
import { truncateOversizedToolResultsInMessages } from "../tool-result-truncation.js";
import { snapshotRecentMessages } from "./attempt-context-summary.js";
import {
  installModelPromptTransform,
  installRuntimeContextMessageForPrompt,
} from "./attempt-llm-boundary.js";
import {
  isSessionsYieldAbortError,
  persistSessionsYieldContextMessage,
  stripSessionsYieldArtifacts,
  waitForSessionsYieldAbortSettle,
} from "./attempt-sessions-yield.js";
import { detectAndLoadPromptImages } from "./images.js";
import { wrapStreamFnWithMessageTransform } from "./message-transform-stream-wrapper.js";
import { isMidTurnPrecheckSignal, type MidTurnPrecheckRequest } from "./midturn-precheck.js";
import { readPersistedMediaImageLayout } from "./prompt-image-metadata.js";
import type { RuntimeContextCustomMessage } from "./runtime-context-prompt.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/**
 * Submits one prepared prompt while owning provider transforms and cleanup.
 */
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
  attempt: Pick<EmbeddedRunAttemptParams, "sessionId" | "toolMode" | "userTurnTranscriptRecorder">;
  activeSession: PromptSubmissionSession;
  appendContext?: string;
  contextTokenBudget: number;
  images: ImageContent[];
  leasedSteering?: SteeringLease;
  modelPrompt: string;
  onFinalPromptText: (prompt: string) => void;
  onSteeringAcknowledged: () => void;
  prependContext?: string;
  promptActiveSession: PromptActiveSession;
  runtimeContextMessage?: RuntimeContextCustomMessage;
  runtimeOnly: boolean;
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
    const providerPromptStreamFn = wrapStreamFnWithMessageTransform(baseStreamFn, (messages) => {
      const providerPromptHistoryTruncation = truncateOversizedToolResultsInMessages(
        messages,
        input.contextTokenBudget,
        input.toolResultMaxChars,
        input.toolResultAggregateMaxChars,
        input.toolResultPromptProjectionState,
      );
      const providerMessages =
        providerPromptHistoryTruncation.messages !== messages
          ? providerPromptHistoryTruncation.messages
          : messages;
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
      return providerMessages;
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
  const resolvedToolMode = resolveSessionToolMode({
    selection: attempt.toolMode,
    runtimeId: "openclaw",
  });
  updateActiveEmbeddedRunSnapshot(attempt.sessionId, {
    transcriptLeafId: input.transcriptLeafId,
    messages: snapshotRecentMessages(normalizedReplayMessages),
    inFlightPrompt: input.transcriptPrompt,
    toolMode: resolvedToolMode?.status === "available" ? resolvedToolMode.selection : undefined,
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

type PromptSubmissionSkipReason = "blank_user_prompt" | "empty_prompt_history_images";

/** Classifies prompt submissions that have no visible current-turn content. */
export function resolvePromptSubmissionSkipReason(params: {
  prompt: string;
  messages: readonly unknown[];
  imageCount: number;
  runtimeOnly?: boolean;
}): PromptSubmissionSkipReason | null {
  if (params.prompt.trim().length > 0 || params.imageCount > 0) {
    return null;
  }
  return params.messages.some(hasVisiblePromptHistory)
    ? "blank_user_prompt"
    : "empty_prompt_history_images";
}

function hasVisiblePromptHistory(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== "user" && record.role !== "assistant") {
    return false;
  }
  return hasNonEmptyContent(record.content);
}

function hasNonEmptyContent(content: unknown): boolean {
  if (typeof content === "string") {
    return content.trim().length > 0;
  }
  if (Array.isArray(content)) {
    return content.some(hasNonEmptyContent);
  }
  if (!content || typeof content !== "object") {
    return false;
  }
  const record = content as { text?: unknown; content?: unknown };
  return hasNonEmptyContent(record.text) || hasNonEmptyContent(record.content);
}

/** Classifies prompt failures and performs yield or mid-turn recovery. */
type PromptErrorAttempt = Pick<EmbeddedRunAttemptParams, "runId" | "sessionId">;
type WithOwnedTranscriptWrite = <T>(operation: () => Promise<T> | T) => Promise<T>;

type EmbeddedAttemptPromptErrorOutcome = {
  promptFailure?: {
    error: unknown;
    source: "prompt";
  };
};

export async function handleEmbeddedAttemptPromptError(input: {
  activeSession: AgentSession;
  attempt: PromptErrorAttempt;
  error: unknown;
  handleMidTurnPrecheckRequest: (request: MidTurnPrecheckRequest) => void;
  markYieldAborted: () => void;
  releaseLeasedSteering: (error?: unknown) => void;
  withOwnedTranscriptWrite: WithOwnedTranscriptWrite;
  yieldAbortSettled: Promise<void> | null;
  yieldDetected: boolean;
  yieldMessage: string | null;
}): Promise<EmbeddedAttemptPromptErrorOutcome> {
  input.releaseLeasedSteering(input.error);
  const yieldAborted = input.yieldDetected && isSessionsYieldAbortError(input.error);
  if (yieldAborted) {
    // Publish terminal state before fallible recovery so outer cleanup still recognizes the yield.
    input.markYieldAborted();
    await waitForSessionsYieldAbortSettle({
      settlePromise: input.yieldAbortSettled,
      runId: input.attempt.runId,
      sessionId: input.attempt.sessionId,
    });
    await input.withOwnedTranscriptWrite(async () => {
      stripSessionsYieldArtifacts(input.activeSession);
      if (input.yieldMessage) {
        await persistSessionsYieldContextMessage(input.activeSession, input.yieldMessage);
      }
    });
    return {};
  }

  if (isMidTurnPrecheckSignal(input.error)) {
    const request = input.error.request;
    await input.withOwnedTranscriptWrite(() => {
      input.handleMidTurnPrecheckRequest(request);
    });
    return {};
  }

  return {
    promptFailure: {
      error: input.error,
      source: "prompt",
    },
  };
}

/** Prepares prompt-lock ownership and prompt-local images for submission. */
type PromptExecutionAttempt = Pick<
  EmbeddedRunAttemptParams,
  | "config"
  | "imageOrder"
  | "images"
  | "media"
  | "model"
  | "sessionFile"
  | "sessionKey"
  | "sessionTarget"
  | "userTurnTranscriptRecorder"
>;
type PromptImageResult = Awaited<ReturnType<typeof detectAndLoadPromptImages>>;

function emptyPromptImages(): PromptImageResult {
  return {
    images: [],
    imageFactIndexes: [],
    detectedRefs: [],
    failedMediaCount: 0,
    loadedCount: 0,
    skippedCount: 0,
  };
}

export async function prepareEmbeddedAttemptPromptExecution(input: {
  attempt: PromptExecutionAttempt;
  /** Prepared run owner; scopes media roots without re-resolving session identity. */
  mediaOwnerAgentId: string;
  effectiveFsWorkspaceOnly: boolean;
  effectiveWorkspace: string;
  prompt: string;
  sandbox?: SandboxContext | null;
  skipPromptSubmission: boolean;
  pluginHarness?: boolean;
}): Promise<
  PromptImageResult & {
    imageOrder?: PromptExecutionAttempt["imageOrder"];
    media?: PromptExecutionAttempt["media"];
  }
> {
  if (input.skipPromptSubmission) {
    return emptyPromptImages();
  }

  const { attempt } = input;
  const persistedMessage =
    attempt.userTurnTranscriptRecorder?.message ??
    (await attempt.userTurnTranscriptRecorder?.resolveMessage());
  const persistedMedia = persistedMessage ? (readPersistedMediaFacts(persistedMessage) ?? []) : [];

  const result = await detectAndLoadPromptImages({
    prompt: input.prompt,
    workspaceDir: input.effectiveWorkspace,
    model: attempt.model,
    existingImages: attempt.images,
    imageOrder: attempt.imageOrder,
    media: persistedMedia.length > 0 ? persistedMedia : attempt.media,
    mediaImageLayout: persistedMessage
      ? readPersistedMediaImageLayout(persistedMessage)
      : undefined,
    maxBytes: MAX_IMAGE_BYTES,
    maxDimensionPx: resolveImageSanitizationLimits(attempt.config).maxDimensionPx,
    workspaceOnly: input.effectiveFsWorkspaceOnly,
    localRoots: input.effectiveFsWorkspaceOnly
      ? undefined
      : getAgentScopedMediaLocalRoots(attempt.config ?? {}, input.mediaOwnerAgentId),
    sandbox:
      input.sandbox?.enabled && input.sandbox.fsBridge
        ? { root: input.sandbox.workspaceDir, bridge: input.sandbox.fsBridge }
        : undefined,
  });
  if (!input.pluginHarness) {
    return result;
  }
  if (result.failedMediaCount) {
    throw new Error(
      `failed to hydrate ${result.failedMediaCount} structured image attachment(s) for plugin harness input`,
    );
  }
  return {
    ...result,
    imageOrder: result.images.length ? result.images.map(() => "inline" as const) : undefined,
    media: undefined,
  };
}
