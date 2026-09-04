import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import {
  agentCommandMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
} from "./test-helpers.js";

describe("Gateway close during agent admission", () => {
  let harness: GatewayServerHarness;
  let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;
  let acquisition: Promise<GatewayServerHarness> | undefined;
  installGatewayTestHooks({
    scope: "suite",
    setup: async () => {
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

  it("refuses provider execution when close overtakes acquired but unregistered WS work", async ({
    signal,
  }) => {
    await prepareGatewayReplyRuntimeForTest();
    const admissionHeld = createDeferred();
    const releaseAdmission = createDeferred();
    const commandStarted = createDeferred();
    const releaseCommand = createDeferred();
    const terminalObserved = createDeferred();
    const drainEntered = createDeferred();
    let serviceCompletion: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    let observedTerminal = false;
    const release = () => {
      releaseAdmission.resolve();
      releaseCommand.resolve();
    };
    signal.addEventListener("abort", release, { once: true });
    const admissionModule = await import("./agent-turn/agent-run-admission-phase.js");
    const prepare = admissionModule.prepareAgentRunDispatch;
    vi.spyOn(admissionModule, "prepareAgentRunDispatch").mockImplementationOnce(async (params) => {
      const acquire = params.acquireGatewayWorkAdmission;
      return await prepare({
        ...params,
        acquireGatewayWorkAdmission: async (...args) => {
          await acquire(...args);
          admissionHeld.resolve();
          await releaseAdmission.promise;
        },
      });
    });
    const serviceModule = await import("./agent-turn/agent-turn-service.js");
    const createService = serviceModule.createAgentTurnService;
    vi.spyOn(serviceModule, "createAgentTurnService").mockImplementationOnce((...args) => {
      const service = createService(...args);
      const start = service.startTurn.bind(service);
      vi.spyOn(service, "startTurn").mockImplementationOnce((params) => {
        serviceCompletion = start({
          ...params,
          io: {
            ...params.io,
            emitAcceptance: (...frame) => {
              params.io.emitAcceptance(...frame);
              if (!frame[0][0]) {
                observedTerminal = true;
                terminalObserved.resolve();
              }
            },
            emitFinal: (...frame) => {
              params.io.emitFinal(...frame);
              observedTerminal = true;
              terminalObserved.resolve();
            },
          },
        });
        return serviceCompletion;
      });
      return service;
    });
    vi.mocked(agentCommandMock).mockReset();
    vi.mocked(agentCommandMock).mockImplementationOnce(async () => {
      commandStarted.resolve();
      await releaseCommand.promise;
      return { payloads: [{ text: "late provider reply" }], meta: { durationMs: 1 } };
    });
    try {
      const { ws } = await harness.openClient();
      ws.send(
        JSON.stringify({
          type: "req",
          id: "late-admission",
          method: "agent",
          params: {
            message: "hold before registering the run",
            sessionKey: "main",
            idempotencyKey: "late-admission",
          },
        }),
      );
      await admissionHeld.promise;
      expect(kernel.gatewayRequestContext.chatAbortControllers.size).toBe(0);
      const drain = kernel.connectionWork.drain.bind(kernel.connectionWork);
      vi.spyOn(kernel.connectionWork, "drain").mockImplementationOnce(() => {
        const operation = drain();
        drainEntered.resolve();
        return operation;
      });
      // Exercise public per-Gateway close without a process-global restart fence.
      closing = harness.server.close({ reason: "gateway stopping", restartExpectedMs: null });
      await drainEntered.promise;
      releaseAdmission.resolve();
      await Promise.race([commandStarted.promise, terminalObserved.promise]);
      const providerStartedAfterClose = vi.mocked(agentCommandMock).mock.calls.length > 0;
      releaseCommand.resolve();
      await terminalObserved.promise;
      await serviceCompletion;
      await closing;
      expect(observedTerminal).toBe(true);
      expect(providerStartedAfterClose).toBe(false);
    } finally {
      release();
      await Promise.allSettled([serviceCompletion]);
      if (vi.mocked(agentCommandMock).mock.calls.length > 0) {
        await terminalObserved.promise;
      }
      await Promise.allSettled([closing]);
      vi.restoreAllMocks();
      signal.removeEventListener("abort", release);
    }
  });
});
