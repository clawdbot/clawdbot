import { describe, expect, it, vi } from "vitest";
import { interruptCodexTurnAndWaitBestEffort } from "./attempt-client-cleanup.js";
import type { CodexDynamicToolRuntimeResponse } from "./dynamic-tool-response-state.js";
import { createCodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import { buildCodexLifecycleTerminalMeta } from "./run-attempt-lifecycle-terminal.js";

function createTerminalReleaseHarness() {
  const order: string[] = [];
  const notificationHandlers = new Set<(notification: unknown) => void>();
  const cancel = vi.fn(() => order.push("cancel"));
  const sealAdmission = vi.fn(() => order.push("seal-steering"));
  const sealServerRequests = vi.fn(() => order.push("seal-server-requests"));
  const beginSettlement = vi.fn(() => order.push("begin-settlement"));
  const clearTerminalReleaseDeadline = vi.fn();
  let terminalReleaseDeadline: (() => void) | undefined;
  const armTerminalReleaseDeadline = vi.fn((_deadlineAtMs: number, onDeadline: () => void) => {
    terminalReleaseDeadline = onDeadline;
  });
  const request = vi.fn(async (method: string) => {
    order.push(method);
    return {};
  });
  const resolveCompletion = vi.fn();
  const state = {
    completed: false,
    activeAppServerTurnRequests: 0,
    currentTurnHadNonTerminalDynamicToolResult: false,
    pendingTerminalDynamicToolRelease: undefined,
    terminalDynamicToolReleaseCheckScheduled: false,
    finalSourceReplyCommit: undefined,
    localCompletionRequested: false,
    resolveCompletion,
  };
  const client = {
    request,
    addNotificationHandler: (handler: (notification: unknown) => void) => {
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    },
    addRequestHandler: () => () => undefined,
    addCloseHandler: () => () => undefined,
  };
  const controller = createCodexAttemptLifecycleController(
    {
      prompt: {
        context: {
          runtime: {
            connection: {
              params: {},
              attemptStartedAt: 0,
              runAbortController: new AbortController(),
              fastModeAutoProgressState: {},
            },
          },
        },
      },
      state: { client },
    } as never,
    {
      state,
      activeTurnItemIds: new Set(),
      pendingOpenClawDynamicToolCompletionIds: new Set(),
      steeringQueueRef: { current: { cancel, sealAdmission } },
      serverRequestAdmission: { seal: sealServerRequests },
      deadlines: { beginSettlement },
      armTerminalReleaseDeadline,
      clearTerminalReleaseDeadline,
      interruptTurn: (turnId: string) =>
        interruptCodexTurnAndWaitBestEffort(client as never, {
          threadId: "thread-1",
          turnId,
        }),
      completeTurn: () => {
        state.completed = true;
        resolveCompletion();
      },
    } as never,
  );
  const completeTurn = () => {
    for (const handler of notificationHandlers) {
      handler({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "interrupted" },
        },
      });
    }
  };
  return {
    armTerminalReleaseDeadline,
    beginSettlement,
    cancel,
    completeTurn,
    controller,
    order,
    request,
    resolveCompletion,
    sealAdmission,
    sealServerRequests,
    state,
    triggerTerminalReleaseDeadline: () => terminalReleaseDeadline?.(),
  };
}

function terminalYieldResult(success: boolean) {
  return {
    call: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-yield",
      tool: "sessions_yield",
      arguments: {},
    },
    response: { success, terminate: true, contentItems: [] },
    durationMs: 1,
  };
}

function finalSourceReplyResult(success = true) {
  const response: CodexDynamicToolRuntimeResponse = {
    success,
    terminate: true,
    finalCurrentSourceReply: true,
    contentItems: [],
  };
  return {
    call: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-message-final",
      tool: "message",
      arguments: { action: "reply", final: true },
    },
    response,
    durationMs: 2,
  };
}

describe("buildCodexLifecycleTerminalMeta", () => {
  it("marks sessions_yield as a paused parent continuation", () => {
    expect(
      buildCodexLifecycleTerminalMeta({
        aborted: false,
        timedOut: false,
        yielded: true,
      }),
    ).toEqual({
      yielded: true,
      livenessState: "paused",
      stopReason: "end_turn",
    });
  });

  it("keeps ordinary successful turns terminal", () => {
    expect(
      buildCodexLifecycleTerminalMeta({
        aborted: false,
        timedOut: false,
        yielded: false,
      }),
    ).toBeUndefined();
  });

  it("keeps cancellation stronger than a stale yield signal", () => {
    expect(
      buildCodexLifecycleTerminalMeta({
        aborted: true,
        timedOut: false,
        yielded: true,
      }),
    ).toEqual({
      aborted: true,
      status: "cancelled",
      stopReason: "stop",
    });
  });
});

describe("Codex terminal dynamic-tool release", () => {
  it("waits for native completion only after a confirmed final source reply", () => {
    const harness = createTerminalReleaseHarness();

    harness.controller.commitFinalSourceReply(finalSourceReplyResult());

    expect(harness.state.finalSourceReplyCommit).toMatchObject({
      call: expect.objectContaining({ callId: "call-message-final" }),
    });
    expect(harness.sealServerRequests).toHaveBeenCalledOnce();
    expect(harness.sealAdmission).toHaveBeenCalledOnce();
    expect(harness.beginSettlement).toHaveBeenCalledOnce();
    expect(harness.armTerminalReleaseDeadline).toHaveBeenCalledOnce();
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.cancel).not.toHaveBeenCalled();
    expect(harness.state.completed).toBe(false);
  });

  it("does not grant final-source grace to a generic terminal response", async () => {
    const harness = createTerminalReleaseHarness();
    const genericTerminal = finalSourceReplyResult();
    delete genericTerminal.response.finalCurrentSourceReply;

    harness.controller.commitFinalSourceReply(genericTerminal);
    harness.controller.scheduleTurnReleaseAfterTerminalDynamicTool(genericTerminal);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(harness.state.finalSourceReplyCommit).toBeUndefined();
    expect(harness.request).toHaveBeenCalledWith(
      "turn/interrupt",
      { threadId: "thread-1", turnId: "turn-1" },
      { timeoutMs: 5_000 },
    );
    expect(harness.state.completed).toBe(true);
  });

  it("does not commit a failed final source reply", () => {
    const harness = createTerminalReleaseHarness();

    harness.controller.commitFinalSourceReply(finalSourceReplyResult(false));

    expect(harness.state.finalSourceReplyCommit).toBeUndefined();
    expect(harness.sealServerRequests).not.toHaveBeenCalled();
    expect(harness.armTerminalReleaseDeadline).not.toHaveBeenCalled();
  });

  it("falls back to one bounded interrupt when native completion does not arrive", async () => {
    const harness = createTerminalReleaseHarness();
    harness.controller.commitFinalSourceReply(finalSourceReplyResult());

    harness.triggerTerminalReleaseDeadline();
    await vi.waitFor(() => expect(harness.request).toHaveBeenCalledOnce());
    expect(harness.state.completed).toBe(false);
    harness.completeTurn();
    await vi.waitFor(() => expect(harness.state.completed).toBe(true));

    harness.triggerTerminalReleaseDeadline();
    expect(harness.request).toHaveBeenCalledOnce();
    expect(harness.resolveCompletion).toHaveBeenCalledOnce();
  });

  it("completes a successful yield before native interrupt completion", async () => {
    const harness = createTerminalReleaseHarness();

    harness.controller.scheduleTurnReleaseAfterTerminalDynamicTool(terminalYieldResult(true));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(harness.cancel).toHaveBeenCalled();
    expect(harness.request).toHaveBeenCalledWith(
      "turn/interrupt",
      { threadId: "thread-1", turnId: "turn-1" },
      { timeoutMs: 5_000 },
    );
    expect(harness.order.indexOf("cancel")).toBeLessThan(harness.order.indexOf("turn/interrupt"));
    expect(harness.state.completed).toBe(true);
    expect(harness.resolveCompletion).toHaveBeenCalledOnce();

    harness.completeTurn();
    harness.controller.scheduleTurnReleaseAfterTerminalDynamicTool(terminalYieldResult(true));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(harness.request).toHaveBeenCalledOnce();
    expect(harness.resolveCompletion).toHaveBeenCalledOnce();
  });

  it("keeps steering open when the yield result fails", async () => {
    const harness = createTerminalReleaseHarness();

    harness.controller.scheduleTurnReleaseAfterTerminalDynamicTool(terminalYieldResult(false));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(harness.cancel).not.toHaveBeenCalled();
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.state.completed).toBe(false);
    expect(harness.resolveCompletion).not.toHaveBeenCalled();
  });
});
