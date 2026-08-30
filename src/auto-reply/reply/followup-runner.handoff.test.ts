import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AdmittedFollowupTurn } from "./followup-turn-admission.js";
import type { FollowupExecutionResult } from "./followup-turn-execution.js";
import type { FollowupRun, QueueSettings } from "./queue.js";

const state = vi.hoisted(() => ({
  account: vi.fn(),
  admit: vi.fn(),
  deliver: vi.fn(),
  execute: vi.fn(),
  resolveDecision: vi.fn(),
}));

vi.mock("../../infra/agent-run-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/agent-run-registry.js")>()),
  clearAgentRunContext: vi.fn(),
}));
vi.mock("../../agents/embedded-agent-runner/delivery-evidence.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../agents/embedded-agent-runner/delivery-evidence.js")
  >()),
  hasCompletedSourceReplyDeliveryEvidence: () => true,
}));
vi.mock("./agent-runner-result-accounting.js", () => ({
  accountFollowupTurn: (...args: unknown[]) => state.account(...args),
}));
vi.mock("./followup-turn-admission.js", () => ({
  admitFollowupTurn: (...args: unknown[]) => state.admit(...args),
  settleQueuedFollowupPresentation: vi.fn(async () => {}),
}));
vi.mock("./followup-turn-execution.js", () => ({
  executeFollowupTurn: (...args: unknown[]) => state.execute(...args),
}));
vi.mock("./followup-delivery.js", () => ({
  deliverFollowupDecision: (...args: unknown[]) => state.deliver(...args),
  resolveFollowupDeliveryDecision: (...args: unknown[]) => state.resolveDecision(...args),
}));
vi.mock("../../runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../runtime.js")>();
  return { ...actual, defaultRuntime: { ...actual.defaultRuntime, error: vi.fn() } };
});

const { scheduleFollowupDrainAfterReplyOperationClear } = await import("./agent-runner-core.js");
const { createFollowupRunner } = await import("./followup-runner.js");
const { clearSessionQueues, enqueueFollowupRun } = await import("./queue.js");
const { createQueueTestRun } = await import("./queue.test-helpers.js");
const { consumeQueuedReplyCompletionHandoff, recordReplyOperationCompletedSourceReply } =
  await import("./reply-completion-handoff.js");
const { createReplyOperation } = await import("./reply-run-registry.js");

function createQueuedRun(key: string, prompt: string): FollowupRun {
  const queued = createQueueTestRun({
    prompt,
    currentInboundEventKind: "user_request",
    originatingChannel: "telegram",
    originatingTo: "chat-1",
    originatingAccountId: "primary",
    originatingThreadId: 7,
  });
  queued.run.sessionKey = key;
  queued.run.sessionId = "session-1";
  queued.run.messageProvider = "telegram";
  queued.run.agentAccountId = "primary";
  queued.run.sourceReplyDeliveryMode = "message_tool_only";
  return queued;
}

function createTypingController() {
  return {
    onReplyStart: vi.fn(async () => {}),
    startTypingLoop: vi.fn(async () => {}),
    startTypingOnText: vi.fn(async () => {}),
    refreshTypingTtl: vi.fn(),
    isActive: vi.fn(() => false),
    markRunComplete: vi.fn(),
    markDispatchIdle: vi.fn(),
    cleanup: vi.fn(),
  };
}

function createExecution(turn: AdmittedFollowupTurn): FollowupExecutionResult {
  return {
    commentaryPayloadsEnabled: false,
    execution: {
      runId: turn.runId,
      outcome: {
        kind: "settled",
        status: "ok",
        result: { payloads: [], meta: { durationMs: 0 } },
        resolved: { provider: "anthropic", model: "claude" },
        fallback: { exhausted: false, attempts: [] },
        autoCompactionCount: 0,
        didLogHeartbeatStrip: false,
      },
    },
    runStartedAt: 1,
    sessionCtx: {},
    pendingToolTasks: new Set(),
    progress: { drain: vi.fn(async () => {}) },
  } as FollowupExecutionResult;
}

describe("queued completion handoff through FollowupRunner", () => {
  const queueKeys = new Set<string>();

  beforeEach(() => {
    vi.clearAllMocks();
    state.resolveDecision.mockReturnValue({ kind: "suppress", reason: "silent" });
    state.account.mockResolvedValue({});
  });

  afterEach(() => {
    clearSessionQueues([...queueKeys]);
    queueKeys.clear();
  });

  it("replaces A with B before the active drain admits prequeued C", async () => {
    const key = `test-followup-runner-completion-chain-${Date.now()}`;
    queueKeys.add(key);
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const source = createQueuedRun(key, "A");
    const queuedB = createQueuedRun(key, "B");
    const queuedC = createQueuedRun(key, "C");
    const ownerA = createReplyOperation({
      sessionKey: key,
      sessionId: "session-1",
      resetTriggered: false,
    });
    const operations = [ownerA];
    const observed = new Map<string, ReturnType<typeof consumeQueuedReplyCompletionHandoff>>();
    const done = createDeferred();

    state.admit.mockImplementation(async ({ queued }: { queued: FollowupRun }) => {
      const operation = createReplyOperation({
        sessionKey: key,
        sessionId: "session-1",
        resetTriggered: false,
      });
      operations.push(operation);
      observed.set(queued.prompt, consumeQueuedReplyCompletionHandoff(queued, operation));
      return {
        kind: "admitted",
        turn: {
          runId: `run-${queued.prompt}`,
          queued,
          operation,
          config: {},
          session: {
            kind: "detached",
            current: () => undefined,
            publish: vi.fn(),
            adopt: vi.fn(),
          },
          sendPolicy: "allow",
          preflightCompactionApplied: false,
        } as AdmittedFollowupTurn,
      };
    });
    state.execute.mockImplementation(async ({ turn }: { turn: AdmittedFollowupTurn }) => {
      if (turn.queued.prompt === "B") {
        recordReplyOperationCompletedSourceReply(turn.operation, turn.queued);
      }
      return createExecution(turn);
    });
    state.deliver.mockImplementation(async ({ turn }: { turn: AdmittedFollowupTurn }) => {
      if (turn.queued.prompt === "C") {
        done.resolve();
      }
    });

    const runFollowup = createFollowupRunner({
      typing: createTypingController(),
      typingMode: "instant",
      defaultModel: "claude",
    });
    enqueueFollowupRun(key, queuedB, settings);
    enqueueFollowupRun(key, queuedC, settings);
    recordReplyOperationCompletedSourceReply(ownerA, source);
    scheduleFollowupDrainAfterReplyOperationClear({
      operation: ownerA,
      queueKey: key,
      runFollowup,
    });
    ownerA.complete();

    try {
      await done.promise;
      expect([...observed.keys()]).toEqual(["B", "C"]);
      expect(observed.get("B")).toBeDefined();
      expect(observed.get("C")).toBeDefined();
      expect(observed.get("C")).not.toBe(observed.get("B"));
    } finally {
      for (const operation of operations) {
        operation.complete();
      }
    }
  });
});
