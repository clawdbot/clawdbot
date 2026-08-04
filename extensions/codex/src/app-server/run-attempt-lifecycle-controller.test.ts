import { describe, expect, it, vi } from "vitest";
import { interruptCodexTurnAndWaitBestEffort } from "./attempt-client-cleanup.js";
import { createCodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import { buildCodexLifecycleTerminalMeta } from "./run-attempt-lifecycle-terminal.js";

function createTerminalReleaseHarness() {
  const order: string[] = [];
  const notificationHandlers = new Set<(notification: unknown) => void>();
  const cancel = vi.fn(() => order.push("cancel"));
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
      steeringQueueRef: { current: { cancel } },
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
  return { cancel, completeTurn, controller, order, request, resolveCompletion, state };
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
  it("fences unconsumed steering before interrupting a successful yield", async () => {
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
    expect(harness.state.completed).toBe(false);
    expect(harness.resolveCompletion).not.toHaveBeenCalled();

    harness.completeTurn();
    await vi.waitFor(() => expect(harness.resolveCompletion).toHaveBeenCalledOnce());

    expect(harness.state.completed).toBe(true);
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
