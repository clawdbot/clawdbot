import { setImmediate as nextTurn } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { isAgentRunRestartAbortReason } from "../agents/run-termination.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { registerChatAbortController } from "./chat-abort.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import {
  agentCommandMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
} from "./test-helpers.js";

for (const mode of ["stop", "restart", "graceful"] as const) {
  describe(`Gateway detached execution during ${mode}`, () => {
    let harness: GatewayServerHarness;
    let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;
    let agentDispatch: typeof import("./agent-turn/agent-run-dispatch.js");
    let acquisition: Promise<GatewayServerHarness> | undefined;
    let restartMarkers: ReturnType<typeof vi.fn>;
    installGatewayTestHooks({
      scope: "suite",
      setup: async () => {
        const recoveryModule =
          await import("../agents/main-session-recovery/main-session-restart-recovery.js");
        restartMarkers = vi.spyOn(recoveryModule, "markRestartAbortedMainSessions");
        const kernelModule = await import("./server-kernel.js");
        const createKernel = kernelModule.createGatewayKernel;
        const capture = vi
          .spyOn(kernelModule, "createGatewayKernel")
          .mockImplementation(async (...args) => {
            kernel = await createKernel(...args);
            return kernel;
          });
        try {
          acquisition = startGatewayServerHarness();
          harness = await acquisition;
          agentDispatch = await import("./agent-turn/agent-run-dispatch.js");
        } finally {
          capture.mockRestore();
        }
      },
      cleanup: async () => {
        const [result] = await Promise.allSettled([acquisition]);
        if (result.status === "fulfilled") {
          await result.value?.close();
        }
      },
    });
    beforeEach(async () => {
      vi.mocked(agentCommandMock).mockReset();
      await prepareGatewayReplyRuntimeForTest();
    });

    it("settles the original command and finalizer before retiring its Gateway", async ({
      signal,
    }) => {
      const commandStarted = createDeferred();
      const commandRelease = createDeferred();
      const finalizerEntered = createDeferred();
      const finalizerRelease = createDeferred();
      const terminalObserved = createDeferred();
      const drainEntered = createDeferred();
      const graceObserved = createDeferred();
      const runId = `gateway-${mode}-execution`;
      const order: string[] = [];
      const foreign = registerChatAbortController({
        chatAbortControllers: new Map(),
        runId,
        sessionId: "foreign-session",
        sessionKey: "agent:foreign:main",
        timeoutMs: 60_000,
        kind: "agent",
      });
      let terminalPayload: unknown;
      let dispatchStarted = false;
      let runSignal: AbortSignal | undefined;
      let abortedAtDrain: boolean | undefined;
      let emergencyReleaseUsed = false;
      let closing: Promise<void> | undefined;
      let request: Promise<unknown> | undefined;
      let grace: ReturnType<typeof waitForGatewayActiveWork> | undefined;
      const release = () => {
        commandRelease.resolve();
        finalizerRelease.resolve();
      };
      signal.addEventListener("abort", release, { once: true });
      const dispatch = agentDispatch.dispatchAgentRunFromGateway;
      const observeDispatch = vi
        .spyOn(agentDispatch, "dispatchAgentRunFromGateway")
        .mockImplementation((params) => {
          dispatchStarted = true;
          runSignal = params.abortController.signal;
          // Preserve the original dispatcher, including its detached baseline return contract.
          return dispatch({
            ...params,
            onSettled: async (outcome) => {
              finalizerEntered.resolve();
              await finalizerRelease.promise;
              const result = await params.onSettled?.(outcome);
              order.push("finalizer settled");
              return result ?? true;
            },
            cleanupAbortController: () => {
              params.cleanupAbortController();
              order.push("run owner released");
            },
            io: {
              ...params.io,
              emitFinal: (...args) => {
                params.io.emitFinal(...args);
                terminalPayload = args[0][1];
                terminalObserved.resolve();
              },
            },
          });
        });
      vi.mocked(agentCommandMock).mockImplementationOnce(async (options) => {
        if (!isRecord(options) || !(options.abortSignal instanceof AbortSignal)) {
          throw new Error("the admitted Gateway command has no cancellation signal");
        }
        const abortSignal = options.abortSignal;
        const cancelled = createDeferred();
        const onAbort = () => cancelled.resolve();
        abortSignal.addEventListener("abort", onAbort, { once: true });
        try {
          if (typeof options.onExecutionStarted === "function") {
            options.onExecutionStarted();
          }
          commandStarted.resolve();
          await Promise.race([commandRelease.promise, cancelled.promise]);
          order.push("command settled");
          if (abortSignal.aborted) {
            throw abortSignal.reason;
          }
          return { payloads: [{ text: "completed during grace" }], meta: { durationMs: 1 } };
        } finally {
          abortSignal.removeEventListener("abort", onAbort);
        }
      });
      try {
        // Give the caller an existing WS-equivalent owner; the admitted execution must retain it.
        request = kernel.connectionWork.track(() =>
          kernel.gatewayInstanceRuntime.recovery.dispatchAgent({
            message: "exercise the admitted command lifetime",
            sessionKey: "main",
            idempotencyKey: runId,
          }),
        );
        expect(await request).toMatchObject({ status: "accepted", runId });
        await commandStarted.promise;
        expect(order).toEqual([]);
        expect(runSignal?.aborted).toBe(false);
        kernel.registerGatewayLifetimeSidecars([
          {
            stop: () => {
              order.push("dependencies stopped");
            },
          },
        ]);
        const drain = kernel.connectionWork.drain.bind(kernel.connectionWork);
        vi.spyOn(kernel.connectionWork, "drain").mockImplementationOnce(() => {
          abortedAtDrain = runSignal?.aborted;
          const operation = drain();
          drainEntered.resolve();
          return operation;
        });

        if (mode === "graceful") {
          // This is the same owner inventory the CLI waits on before ordinary server.close().
          grace = waitForGatewayActiveWork(5_000, {
            onSnapshot: (snapshot) => {
              if (!snapshot.idle) {
                graceObserved.resolve();
              }
            },
          });
          await graceObserved.promise;
          expect(runSignal?.aborted).toBe(false);
          release();
          await terminalObserved.promise;
          expect(await grace).toMatchObject({ drained: true });
        }
        closing = harness.server.close({
          reason: mode === "restart" ? "gateway restart" : "gateway stopping",
          restartExpectedMs: mode === "restart" ? 0 : null,
          ...(mode === "restart" ? { drainTimeoutMs: 0 } : {}),
        });
        await drainEntered.promise;
        await nextTurn();
        const beforeEmergencyRelease = [...order];
        if (mode !== "graceful" && !runSignal?.aborted) {
          emergencyReleaseUsed = true;
          commandRelease.resolve();
        }
        await finalizerEntered.promise;
        await nextTurn();
        const beforeFinalizerRelease = [...order];
        finalizerRelease.resolve();
        await terminalObserved.promise;
        await nextTurn();
        await closing;

        expect(foreign.controller.signal.aborted).toBe(false);
        if (mode === "restart") {
          expect(restartMarkers).toHaveBeenCalledOnce();
        } else {
          expect(restartMarkers).not.toHaveBeenCalled();
        }
        if (mode === "graceful") {
          expect(abortedAtDrain).toBe(false);
          expect(runSignal?.aborted).toBe(false);
          expect(terminalPayload).toMatchObject({ status: "ok" });
        } else {
          expect(abortedAtDrain).toBe(true);
          expect(emergencyReleaseUsed).toBe(false);
          expect(beforeEmergencyRelease).not.toContain("dependencies stopped");
          expect(beforeFinalizerRelease).not.toContain("dependencies stopped");
          expect(isAgentRunRestartAbortReason(runSignal?.reason)).toBe(mode === "restart");
          expect(terminalPayload).toMatchObject({
            status: "timeout",
            stopReason: mode === "restart" ? "restart" : "rpc",
          });
        }
        expect(order).toEqual([
          "command settled",
          "finalizer settled",
          "run owner released",
          "dependencies stopped",
        ]);
      } finally {
        release();
        await Promise.allSettled([request, grace]);
        if (dispatchStarted) {
          // A started command must publish its original terminal tail before fixture restoration.
          await terminalObserved.promise;
        }
        await Promise.allSettled([closing]);
        observeDispatch.mockRestore();
        vi.restoreAllMocks();
        foreign.cleanup();
        signal.removeEventListener("abort", release);
      }
    });
  });
}
