import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { runActiveReplySteer } from "../../auto-reply/reply/agent-runner-steer-adoption.js";
import {
  admitFollowupRunLifecycle,
  clearSessionQueues,
  completeFollowupRunLifecycle,
  getFollowupQueueDepth,
  scheduleFollowupDrain,
} from "../../auto-reply/reply/queue.js";
import { resetRecentQueuedMessageIdDedupe } from "../../auto-reply/reply/queue/enqueue.test-support.js";
import type { ReplyOperationRunState } from "../../auto-reply/reply/reply-operation-run-state.js";
import {
  createReplyOperation,
  type ReplyBackendHandle,
} from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import {
  createMockFollowupRun,
  createMockTypingController,
} from "../../auto-reply/reply/test-helpers.js";
import { createTypingSignaler } from "../../auto-reply/reply/typing-mode.js";
import type { TemplateContext } from "../../auto-reply/templating.js";
import type { EmbeddedAgentQueueHandle } from "../embedded-agent-runner/run-state.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "../embedded-agent-runner/run/attempt-queue-message.js";
import {
  clearActiveEmbeddedRun,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  setActiveEmbeddedRun,
} from "../embedded-agent-runner/runs.js";
import { testing as embeddedRunsTesting } from "../embedded-agent-runner/runs.test-support.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import type { AgentSession } from "./agent-session.js";
import type { ToolDefinition } from "./extensions/types.js";

registerAgentSessionLoopTestLifecycle();

describe("AgentSession handoff adoption integration", () => {
  it("cancels a pending-acceptance steer before one follow-up reuses the session", async () => {
    const queueKey = "agent:main:telegram:direct:handoff-proof";
    const sessionId = "handoff-proof-session";
    const steerText = "STEER-DURING-HANDOFF";
    const finalText = "HANDOFF-FOLLOWUP-DELIVERED";
    const toolAuthorityFingerprint = "handoff-proof-authority";
    const sessionRef: { current?: AgentSession } = {};
    const settled = vi.fn();
    const acceptanceEvents: boolean[] = [];
    const deferred = vi.fn();
    const adopted = vi.fn();
    const abandoned = vi.fn();
    const lifecycleSettled = vi.fn();
    const finalDelivery = vi.fn(async (_text: string) => {});
    const followupRuns: string[] = [];
    const followupOperations: string[] = [];
    let releaseSteerPromise!: () => void;
    const steerPromise = new Promise<void>((resolve) => {
      releaseSteerPromise = resolve;
    });
    let reportSteerReturned!: () => void;
    const steerReturned = new Promise<void>((resolve) => {
      reportSteerReturned = resolve;
    });
    let releaseOwner!: () => void;
    const ownerReleased = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    embeddedRunsTesting.resetActiveEmbeddedRuns();
    replyRunTesting.resetReplyRunRegistry();
    resetRecentQueuedMessageIdDedupe();
    let resolveSteerEnqueued!: () => void;
    const steerEnqueued = new Promise<void>((resolve) => {
      resolveSteerEnqueued = resolve;
    });
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      ["agent_settled", [async () => settled()]],
    ]);
    const yieldTool: ToolDefinition = {
      name: "yield_turn",
      label: "Yield turn",
      description: "ends the current turn for an external handoff",
      parameters: Type.Object({}),
      execute: async () => {
        const activeSession = sessionRef.current;
        if (!activeSession) {
          throw new Error("session not ready");
        }
        await steerEnqueued;
        activeSession.agent.steer({
          role: "custom",
          customType: "test.turn-handoff",
          content: "resume only for external delivery",
          display: false,
          timestamp: Date.now(),
        });
        activeSession.agent.abort({ code: "turn_handoff", turnHandoff: true });
        return { content: [{ type: "text", text: "yielded" }], details: { yielded: true } };
      },
    };
    const requests: Context[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      requests.push(context);
      return createAssistantResultStream(
        createAssistant(
          activeModel,
          requests.length === 1
            ? [{ type: "toolCall", id: "call-yield", name: "yield_turn", arguments: {} }]
            : [{ type: "text", text: finalText }],
          requests.length === 1 ? "toolUse" : "stop",
        ),
      );
    });
    const { session } = await createTestSession({
      customTools: [yieldTool],
      resourceLoader: createResourceLoader(handlers),
    });
    sessionRef.current = session;
    const lifecycleEvents: string[] = [];
    session.subscribe((event) => {
      lifecycleEvents.push(event.type);
      if (event.type === "queue_update" && event.steering.includes(steerText)) {
        resolveSteerEnqueued();
      }
    });
    const delayedSteerTarget = {
      agent: session.agent,
      subscribe: session.subscribe.bind(session),
      steer: async (...args: Parameters<AgentSession["steer"]>) => {
        await session.steer(...args);
        await steerPromise;
        reportSteerReturned();
      },
    };
    const queueMessage: EmbeddedAgentQueueHandle["queueMessage"] = async (text, options) =>
      await steerActiveSessionWithOptionalDeliveryWait(delayedSteerTarget, text, {
        ...options,
        onQueueAccepted: (accepted) => {
          acceptanceEvents.push(accepted);
          options?.onQueueAccepted?.(accepted);
        },
      });
    const queueHandle: EmbeddedAgentQueueHandle = {
      kind: "embedded",
      runId: "handoff-proof-active-run",
      toolAuthorityFingerprint,
      queueMessage,
      messageInjection: { isAvailable: () => session.isStreaming, queueMessage },
      isStreaming: () => session.isStreaming,
      isStopped: () => !session.isStreaming,
      isCompacting: () => false,
      supportsQueueMessageImages: true,
      supportsTranscriptCommitWait: true,
      cancel: () => {},
      abort: () => {},
    };
    const activeOperation = createReplyOperation({
      sessionKey: queueKey,
      sessionId,
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    const replyBackend: ReplyBackendHandle = {
      kind: "embedded",
      runId: queueHandle.runId,
      toolAuthorityFingerprint,
      supportsQueueMessageImages: true,
      messageInjection: {
        isAvailable: () => true,
        queueMessage: async (text, options) => {
          const outcome = await queueEmbeddedAgentMessageWithOutcomeAsync(sessionId, text, options);
          if (!outcome.queued) {
            throw new Error(outcome.errorMessage ?? outcome.reason);
          }
          return outcome.transcriptCommit === "unconfirmed"
            ? {
                transcriptCommit: outcome.transcriptCommit,
                errorMessage: outcome.errorMessage ?? "transcript commitment unconfirmed",
              }
            : undefined;
        },
      },
      cancel: () => {},
    };
    const typing = createMockTypingController();
    const typingSignals = createTypingSignaler({ typing, mode: "never", isHeartbeat: false });
    const runState: ReplyOperationRunState = {};
    const turnAdoptionLifecycle = {
      admission: "exclusive" as const,
      onDeferred: () => deferred(),
      onAdopted: async () => adopted(),
      onAbandoned: abandoned,
      onSettled: lifecycleSettled,
    };
    const followupRun = createMockFollowupRun({
      prompt: steerText,
      messageId: "handoff-proof-message",
      originatingChannel: "telegram",
      originatingTo: "chat:handoff-proof",
      turnAdoptionLifecycle,
      run: {
        sessionId,
        sessionKey: queueKey,
        messageProvider: "telegram",
      },
    });
    const runFollowup = async (queued: typeof followupRun) => {
      await ownerReleased;
      const followupOperation = createReplyOperation({
        sessionKey: queueKey,
        sessionId,
        turnKind: "queued_followup",
        resetTriggered: false,
      });
      followupOperation.setPhase("running");
      followupOperations.push(followupOperation.turnKind);
      followupRuns.push(queued.prompt);
      try {
        await admitFollowupRunLifecycle(queued);
        await session.prompt(queued.prompt);
        const deliveredText = session.messages
          .filter((message) => message.role === "assistant")
          .flatMap((message) => message.content)
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .at(-1);
        if (!deliveredText) {
          throw new Error("follow-up produced no visible response");
        }
        await finalDelivery(deliveredText);
        completeFollowupRunLifecycle(queued);
      } finally {
        followupOperation.complete();
      }
    };
    const steerParams = {
      followupRun,
      opts: undefined,
      providedReplyOperation: activeOperation,
      queueKey,
      releaseAdmissionTicket: vi.fn(),
      replyOperationRunState: runState,
      resolvedQueue: { mode: "steer" as const, debounceMs: 0 },
      restartRecoverySourceTurnId: undefined,
      runFollowup,
      sessionCtx: {
        Provider: "telegram",
        MessageSid: "handoff-proof-message",
      } as TemplateContext,
      sessionKey: queueKey,
      touchActiveSessionEntry: vi.fn(async () => {}),
      typing,
      typingSignals,
      toolAuthorityFingerprint,
    };

    try {
      activeOperation.attachBackend(replyBackend);
      setActiveEmbeddedRun(sessionId, queueHandle, queueKey);

      const initialPrompt = session.prompt("yield now");
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      await Promise.all([runActiveReplySteer(steerParams), initialPrompt]);
      releaseSteerPromise();
      await steerReturned;
      await Promise.resolve();

      expect(acceptanceEvents).toEqual([false]);
      expect(deferred).toHaveBeenCalledOnce();
      expect(adopted).not.toHaveBeenCalled();
      expect(abandoned).not.toHaveBeenCalled();
      expect(lifecycleSettled).not.toHaveBeenCalled();
      expect(followupRuns).toEqual([]);
      expect(session.pendingMessageCount).toBe(0);
      expect(session.getSteeringMessages()).toEqual([]);
      expect(runState.admission).toEqual({ status: "accepted", mode: "followup" });
      expect(settled).not.toHaveBeenCalled();
      expect(lifecycleEvents).toContain("agent_handoff");
      expect(lifecycleEvents).not.toContain("agent_settled");

      clearActiveEmbeddedRun(sessionId, queueHandle, queueKey);
      await expect(
        queueEmbeddedAgentMessageWithOutcomeAsync(sessionId, "stale owner probe", {
          waitForTranscriptCommit: true,
        }),
      ).resolves.toMatchObject({ queued: false, reason: "transcript_commit_wait_unsupported" });
      activeOperation.complete();
      releaseOwner();
      await vi.waitFor(() => expect(finalDelivery).toHaveBeenCalledExactlyOnceWith(finalText));

      expect(adopted).toHaveBeenCalledOnce();
      expect(abandoned).not.toHaveBeenCalled();
      expect(lifecycleSettled).toHaveBeenCalledOnce();
      expect(followupRuns).toEqual([steerText]);
      expect(followupOperations).toEqual(["queued_followup"]);
      expect(requests).toHaveLength(2);
      expect(
        requests.filter((request) => JSON.stringify(request.messages).includes(steerText)),
      ).toHaveLength(1);
      expect(JSON.stringify(requests[1]?.messages).split(steerText)).toHaveLength(2);
      expect(getFollowupQueueDepth(queueKey)).toBe(0);

      scheduleFollowupDrain(queueKey, runFollowup);
      const redelivery = createMockFollowupRun({
        ...followupRun,
        turnAdoptionLifecycle: {
          admission: "exclusive",
          onAdopted: vi.fn(),
        },
        run: followupRun.run,
      });
      await runActiveReplySteer({
        ...steerParams,
        followupRun: redelivery,
        providedReplyOperation: undefined,
      });
      scheduleFollowupDrain(queueKey, runFollowup);
      await Promise.resolve();

      expect(getFollowupQueueDepth(queueKey)).toBe(0);
      expect(followupRuns).toEqual([steerText]);
      expect(followupOperations).toEqual(["queued_followup"]);
      expect(finalDelivery).toHaveBeenCalledOnce();
      expect(requests).toHaveLength(2);
    } finally {
      releaseSteerPromise();
      releaseOwner();
      activeOperation.complete();
      clearActiveEmbeddedRun(sessionId, queueHandle, queueKey);
      clearSessionQueues([queueKey]);
      embeddedRunsTesting.resetActiveEmbeddedRuns();
      replyRunTesting.resetReplyRunRegistry();
      resetRecentQueuedMessageIdDedupe();
      session.agent.clearAllQueues();
    }
  });
});
