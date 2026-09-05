import { setImmediate as yieldImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { interruptCodexTurnAndWaitBestEffort } from "./attempt-client-cleanup.js";
import { createCodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import { buildCodexLifecycleTerminalMeta } from "./run-attempt-lifecycle-terminal.js";
import { createCodexAttemptTurnState } from "./run-attempt-turn-state.js";
import { createClientHarness } from "./test-support.js";
import { getCodexAppServerTurnRouter } from "./turn-router.js";

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
  it("keeps native yield cleanup alive after its subscription route is released", async () => {
    const physical = createClientHarness({
      onWrite: (line, send) => {
        const request = JSON.parse(line) as { id: number; method: string };
        if (request.method === "turn/interrupt") {
          send({ id: request.id, result: {} });
        }
      },
    });
    const router = getCodexAppServerTurnRouter(physical.client);
    const route = router.reserveThread({ threadId: "thread-1", onNotification: vi.fn() });
    const peerRoute = router.reserveThread({ threadId: "thread-peer", onNotification: vi.fn() });
    const resources = {
      prompt: {
        context: {
          runtime: {
            connection: {
              params: { timeoutMs: 60_000 },
              options: {},
              attemptStartedAt: Date.now(),
              runAbortController: new AbortController(),
              fastModeAutoProgressState: {},
            },
          },
        },
      },
      state: { client: physical.client, thread: { threadId: "thread-1" }, turnRoute: route },
      projectorRef: {},
      startupTimeoutMs: 1_000,
    };
    const runtime = createCodexAttemptTurnState(resources as never);
    runtime.steeringQueueRef.current = { cancel: vi.fn() } as never;
    const interrupt = vi.spyOn(runtime, "interruptTurn");
    const controller = createCodexAttemptLifecycleController(resources as never, runtime);
    try {
      route.armTurn();
      await route.bindTurn("turn-1");
      controller.scheduleTurnReleaseAfterTerminalDynamicTool(terminalYieldResult(true));
      await yieldImmediate();
      expect(runtime.state.completed).toBe(true);
      expect(interrupt).toHaveBeenCalledOnce();
      const nativeCleanup = interrupt.mock.results[0]?.value;
      const settled = vi.fn();
      void nativeCleanup?.then(settled, settled);

      route.release();
      await yieldImmediate();
      expect(settled).not.toHaveBeenCalled();
      expect(physical.stdinDestroyed).toBe(false);
      expect(peerRoute.signal.aborted).toBe(false);
      physical.send({
        method: "turn/completed",
        params: {
          threadId: "thread-peer",
          turn: { id: "peer-turn", status: "completed" },
        },
      });
      await yieldImmediate();
      expect(settled).not.toHaveBeenCalled();
      physical.send({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "interrupted" },
        },
      });
      await expect(nativeCleanup).resolves.toBe(true);
      expect(physical.stdinDestroyed).toBe(false);
      expect(peerRoute.signal.aborted).toBe(false);
    } finally {
      runtime.deadlines.dispose();
      physical.client.close();
    }
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
      expect.objectContaining({ timeoutMs: 5_000 }),
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
