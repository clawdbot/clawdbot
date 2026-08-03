import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../types.js";
import type { AdmittedFollowupTurn } from "./followup-turn-admission.js";
import type { FollowupExecutionResult } from "./followup-turn-execution.js";
import type { FollowupRun } from "./queue.js";

const state = vi.hoisted(() => ({
  account: vi.fn(),
  admit: vi.fn(),
  completeLifecycle: vi.fn(),
  completedSourceDelivery: false,
  deliver: vi.fn(),
  execute: vi.fn(),
  resolveDecision: vi.fn(),
  clearRunContext: vi.fn(),
}));

vi.mock("../../infra/agent-run-registry.js", () => ({
  clearAgentRunContext: (...args: unknown[]) => state.clearRunContext(...args),
}));

vi.mock("../../agents/embedded-agent-runner/delivery-evidence.js", () => ({
  hasCompletedSourceReplyDeliveryEvidence: () => state.completedSourceDelivery,
}));

vi.mock("./agent-runner-result-accounting.js", () => ({
  accountFollowupTurn: (...args: unknown[]) => state.account(...args),
}));

vi.mock("./followup-turn-admission.js", () => ({
  admitFollowupTurn: (...args: unknown[]) => state.admit(...args),
  settleQueuedFollowupPresentation: async (defaults: {
    opts?: { onQueuedFollowupSettled?: () => Promise<void> | void };
  }) => {
    try {
      await defaults.opts?.onQueuedFollowupSettled?.();
    } catch {}
  },
}));

vi.mock("./followup-turn-execution.js", () => ({
  executeFollowupTurn: (...args: unknown[]) => state.execute(...args),
}));

vi.mock("./followup-delivery.js", () => ({
  deliverFollowupDecision: (...args: unknown[]) => state.deliver(...args),
  resolveFollowupDeliveryDecision: (...args: unknown[]) => state.resolveDecision(...args),
}));

vi.mock("./queue.js", () => ({
  completeFollowupRunLifecycle: (...args: unknown[]) => state.completeLifecycle(...args),
  FollowupRunDeferredError: class FollowupRunDeferredError extends Error {},
}));

vi.mock("../../runtime.js", () => ({ defaultRuntime: { error: vi.fn() } }));

const { createFollowupRunner } = await import("./followup-runner.js");
const { FollowupRunDeferredError } = await import("./queue.js");

function createQueuedRun(overrides: Partial<FollowupRun> = {}): FollowupRun {
  return {
    prompt: "queued prompt",
    enqueuedAt: 1,
    run: {
      agentId: "agent",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionKey: "main",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      provider: "anthropic",
      model: "claude",
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
    ...overrides,
  };
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

function createTurn(
  order: string[] = [],
  result: AdmittedFollowupTurn["operation"]["result"] = null,
) {
  const operation = {
    result,
    complete: vi.fn(() => order.push("operation-complete")),
    fail: vi.fn(() => order.push("operation-failed")),
  };
  return {
    runId: "run-1",
    queued: createQueuedRun(),
    operation,
    config: {},
    session: {
      kind: "session",
      key: "main",
      current: () => undefined,
      publish: vi.fn(),
    },
    sendPolicy: "allow",
    preflightCompactionApplied: false,
  } as unknown as AdmittedFollowupTurn & { operation: typeof operation };
}

function createRejectedExecution(order: string[] = []): FollowupExecutionResult {
  return {
    execution: {
      runId: "run-1",
      outcome: { kind: "rejected", payload: { text: "failed" } },
    },
    runStartedAt: 1,
    sessionCtx: {},
    pendingToolTasks: new Set(),
    progress: {
      drain: vi.fn(async () => {
        order.push("progress-drained");
      }),
      visibleToolErrorObserved: () => false,
    },
  } as FollowupExecutionResult;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.completedSourceDelivery = false;
  state.resolveDecision.mockReturnValue({ kind: "suppress", reason: "silent" });
});

describe("createFollowupRunner", () => {
  it("completes lifecycle and both typing signals for an already-aborted item", async () => {
    const typing = createTypingController();
    const controller = new AbortController();
    controller.abort();
    const queued = createQueuedRun({ abortSignal: controller.signal });

    await createFollowupRunner({ typing, typingMode: "instant", defaultModel: "claude" })(queued);

    expect(state.admit).not.toHaveBeenCalled();
    expect(state.completeLifecycle).toHaveBeenCalledWith(queued);
    expect(typing.markRunComplete).toHaveBeenCalledOnce();
    expect(typing.markDispatchIdle).toHaveBeenCalledOnce();
  });

  it("turns active-lane deferral into a restorable queue error", async () => {
    const typing = createTypingController();
    const queued = createQueuedRun();
    state.admit.mockResolvedValue({ kind: "deferred", reason: "active-run" });

    await expect(
      createFollowupRunner({ typing, typingMode: "instant", defaultModel: "claude" })(queued),
    ).rejects.toBeInstanceOf(FollowupRunDeferredError);

    expect(state.completeLifecycle).not.toHaveBeenCalled();
    expect(typing.markRunComplete).toHaveBeenCalledOnce();
    expect(typing.markDispatchIdle).toHaveBeenCalledOnce();
  });

  it("releases an operation acquired before asynchronous admission cancellation", async () => {
    const order: string[] = [];
    const typing = createTypingController();
    const turn = createTurn(order);
    state.admit.mockResolvedValue({
      kind: "skipped",
      reason: "aborted",
      operation: turn.operation,
    });

    await createFollowupRunner({ typing, typingMode: "instant", defaultModel: "claude" })(
      turn.queued,
    );

    expect(order).toEqual(["operation-complete"]);
    expect(state.completeLifecycle).toHaveBeenCalledWith(turn.queued);
  });

  it("restores unexpected execution failures after releasing the admitted operation", async () => {
    const order: string[] = [];
    const typing = createTypingController();
    const turn = createTurn(order);
    const failure = new Error("candidate failed before settlement");
    state.admit.mockResolvedValue({ kind: "admitted", turn });
    state.execute.mockRejectedValue(failure);

    await expect(
      createFollowupRunner({ typing, typingMode: "instant", defaultModel: "claude" })(turn.queued),
    ).rejects.toBe(failure);

    expect(state.completeLifecycle).not.toHaveBeenCalled();
    expect(state.clearRunContext).toHaveBeenCalledWith("run-1");
    expect(order).toEqual(["operation-complete"]);
    expect(typing.markRunComplete).toHaveBeenCalledOnce();
    expect(typing.markDispatchIdle).toHaveBeenCalledOnce();
  });

  it("consumes a user abort before execution starts", async () => {
    const typing = createTypingController();
    const turn = createTurn([], { kind: "aborted", code: "aborted_by_user" });
    state.admit.mockResolvedValue({ kind: "admitted", turn });
    state.execute.mockRejectedValue(new Error("aborted before execution start"));

    await createFollowupRunner({ typing, typingMode: "instant", defaultModel: "claude" })(
      turn.queued,
    );

    expect(state.completeLifecycle).toHaveBeenCalledWith(turn.queued);
    expect(state.clearRunContext).toHaveBeenCalledWith("run-1");
    expect(turn.operation.fail).not.toHaveBeenCalled();
  });

  it("consumes a turn that fails after canonical execution starts", async () => {
    const typing = createTypingController();
    const turn = createTurn();
    state.admit.mockResolvedValue({ kind: "admitted", turn });
    state.execute.mockImplementation(async ({ onExecutionStarted }) => {
      onExecutionStarted?.();
      throw new Error("execution failed after start");
    });

    await createFollowupRunner({ typing, typingMode: "instant", defaultModel: "claude" })(
      turn.queued,
    );

    expect(state.execute).toHaveBeenCalledOnce();
    expect(state.completeLifecycle).toHaveBeenCalledWith(turn.queued);
    expect(state.clearRunContext).toHaveBeenCalledWith("run-1");
    expect(turn.operation.fail).toHaveBeenCalledWith("run_failed", expect.any(Error));
  });

  it("holds the reply operation through progress drain, accounting, and delivery", async () => {
    const order: string[] = [];
    const typing = createTypingController();
    const turn = createTurn(order);
    const execution = createRejectedExecution(order);
    state.admit.mockResolvedValue({ kind: "admitted", turn });
    state.execute.mockResolvedValue(execution);
    state.account.mockImplementation(async () => {
      order.push("accounted");
      return undefined;
    });
    state.resolveDecision.mockImplementation(() => {
      order.push("decision");
      return { kind: "deliver", payloads: [{ text: "done" } satisfies ReplyPayload] };
    });
    state.deliver.mockImplementation(async () => {
      order.push("delivered");
    });
    state.completeLifecycle.mockImplementation(() => order.push("lifecycle-complete"));

    await createFollowupRunner({
      typing,
      typingMode: "instant",
      defaultModel: "claude",
      opts: {
        onQueuedFollowupSettled: () => {
          order.push("presentation-settled");
        },
      },
    })(turn.queued);

    expect(order).toEqual([
      "progress-drained",
      "accounted",
      "decision",
      "delivered",
      "presentation-settled",
      "lifecycle-complete",
      "operation-complete",
    ]);
    expect(state.clearRunContext).toHaveBeenCalledWith("run-1");
  });

  it("does not replay a settled turn when progress presentation fails", async () => {
    const typing = createTypingController();
    const turn = createTurn();
    const execution = createRejectedExecution();
    execution.progress.drain = vi.fn(async () => {
      throw new Error("presentation failed");
    });
    state.admit.mockResolvedValue({ kind: "admitted", turn });
    state.execute.mockResolvedValue(execution);
    state.account.mockResolvedValue(undefined);
    state.resolveDecision.mockReturnValue({ kind: "suppress", reason: "silent" });
    state.deliver.mockResolvedValue(undefined);

    await createFollowupRunner({ typing, typingMode: "instant", defaultModel: "claude" })(
      turn.queued,
    );

    expect(state.execute).toHaveBeenCalledOnce();
    expect(state.account).toHaveBeenCalledOnce();
    expect(state.deliver).toHaveBeenCalledOnce();
    expect(state.completeLifecycle).toHaveBeenCalledWith(turn.queued);
    expect(turn.operation.fail).toHaveBeenCalledWith("run_failed", expect.any(Error));
  });

  it("reports a completed message-tool source delivery before final projection", async () => {
    const typing = createTypingController();
    const onObservedReplyDelivery = vi.fn(async () => {});
    const turn = createTurn();
    const execution = createRejectedExecution();
    execution.execution.outcome = {
      kind: "settled",
      status: "ok",
      result: { payloads: [], meta: { durationMs: 0 } },
      resolved: { provider: "anthropic", model: "claude" },
      fallback: { exhausted: false, attempts: [] },
      autoCompactionCount: 0,
      didLogHeartbeatStrip: false,
    };
    state.completedSourceDelivery = true;
    state.admit.mockResolvedValue({ kind: "admitted", turn });
    state.execute.mockResolvedValue(execution);
    state.account.mockResolvedValue({});
    state.deliver.mockResolvedValue(undefined);

    await createFollowupRunner({
      typing,
      typingMode: "instant",
      defaultModel: "claude",
      opts: { onObservedReplyDelivery },
    })(turn.queued);

    expect(onObservedReplyDelivery).toHaveBeenCalledOnce();
  });
});
