import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  WORKER_PROTOCOL_FEATURES,
  WORKER_RPC_SET_VERSION,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE } from "../../infra/node-commands.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import {
  nodeWorkerPlanHash,
  type NodeWorkerLaunchInput,
  type NodeWorkerSupervisorReceipt,
} from "../../worker/node-supervisor-protocol.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import { createNodeWorkerLaunchAdapter } from "./node-launch-adapter.js";

const DEVICE_ID = "device-session-host";
const WORKER_RUNS = {
  bundleHash: "a".repeat(64),
  openclawVersion: "2026.8.1",
  protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
};

function nodeProof(connId = "conn-1", available = 2): NodeWorkerSupervisorNodeProof {
  return {
    nodeId: DEVICE_ID,
    connId,
    pairingIdentity: "identity-1",
    pairingGeneration: "generation-1",
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    workerHost: { enabled: true, capacity: { total: 2, available } },
    commands: ["system.run"],
  };
}

function launchInput(): NodeWorkerLaunchInput {
  return {
    launchId: "turn-1",
    gatewayNamespace: "gateway-1",
    expectedBundleHash: WORKER_RUNS.bundleHash,
    placementGeneration: 4,
    descriptor: {
      version: 4,
      admission: {
        environmentId: "environment-1",
        credential: "worker-fixture-value",
        sessionId: "session-1",
        ownerEpoch: 3,
        rpcSetVersion: WORKER_RPC_SET_VERSION,
        handshake: structuredClone(WORKER_RUNS),
      },
      assignment: {
        agentId: "agent-1",
        operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
        agentRuntimeIdentityToken: "signed-runtime-token",
        runId: "run-1",
        turnId: "turn-1",
        prompt: "Inspect the workspace.",
        suppressPromptTranscript: true,
        workspaceDir: "/tmp/openclaw-worker/workspace",
        modelRef: { provider: "provider-1", model: "model-1" },
        inferenceOptions: {},
        initialMessages: [],
        transcript: { baseLeafId: null, nextSeq: 1 },
        liveEvents: { ackedSeq: 0, nextSeq: 1 },
        toolAuthority: { allowedToolNames: [] },
      },
    },
  };
}

function receipt(
  input: NodeWorkerLaunchInput,
  state: NodeWorkerSupervisorReceipt["state"],
): NodeWorkerSupervisorReceipt {
  const identity = {
    launchId: input.launchId,
    planHash: nodeWorkerPlanHash(input),
    environmentId: input.descriptor.admission.environmentId,
    sessionId: input.descriptor.admission.sessionId,
    ownerEpoch: input.descriptor.admission.ownerEpoch,
    placementGeneration: input.placementGeneration,
    runId: input.descriptor.assignment.runId,
  };
  if (state === "completed") {
    return {
      ...identity,
      state,
      resultJson: JSON.stringify({
        status: "completed",
        transcriptLeafId: "leaf-1",
        transcriptNextSeq: 2,
      }),
    };
  }
  if (state === "failed" || state === "interrupted" || state === "cancelled") {
    return { ...identity, state, errorText: `worker ${state}` };
  }
  return { ...identity, state };
}

function wire(payload: NodeWorkerSupervisorReceipt | null) {
  return { ok: true, payloadJSON: JSON.stringify(payload) };
}

function transportWith(
  invoke: NodeWorkerSupervisorTransport["invoke"],
  listCurrentNodes: NodeWorkerSupervisorTransport["listCurrentNodes"] = async () => [nodeProof()],
): NodeWorkerSupervisorTransport {
  return { invoke, isCurrent: () => true, listCurrentNodes, hasCurrentRunner: () => true };
}

function launchRequest(input = launchInput()) {
  return {
    deviceId: DEVICE_ID,
    input,
    isDispatchAuthorized: () => true,
    isCancellationAuthorized: () => true,
    timeoutMs: 10_000,
  };
}

describe("node worker launch adapter", () => {
  it("fails with a typed availability result when no node dispatches within the grace", async () => {
    vi.useFakeTimers();
    const onDispatchReady = vi.fn();
    const adapter = createNodeWorkerLaunchAdapter({
      getTransport: () => transportWith(vi.fn(), async () => []),
    });
    try {
      const launch = adapter
        .launch({ ...launchRequest(), timeoutMs: 30_000, onDispatchReady })
        .catch((error: unknown) => error);
      await vi.runAllTimersAsync();

      expect(await launch).toMatchObject({
        name: "WorkerRunnerUnavailableError",
        code: "runner-offline",
      });
      expect(onDispatchReady).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("launches once, polls status, and returns the exact completed receipt", async () => {
    const input = launchInput();
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (request) =>
      request.command === "worker.launch.v1"
        ? wire(receipt(input, "running"))
        : wire(receipt(input, "completed")),
    );
    const adapter = createNodeWorkerLaunchAdapter({
      getTransport: () => transportWith(invoke),
      sleep: async () => {},
    });

    await expect(adapter.launch(launchRequest(input))).resolves.toEqual(
      receipt(input, "completed"),
    );
    expect(invoke.mock.calls.map(([request]) => request.command)).toEqual([
      "worker.launch.v1",
      "worker.status.v1",
    ]);
  });

  it("reacquires the node and replays the identical launch after ambiguous disconnect", async () => {
    const input = launchInput();
    let launchCalls = 0;
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (request) => {
      if (request.command !== "worker.launch.v1") {
        throw new Error("unexpected status call");
      }
      launchCalls += 1;
      request.onDispatchReady?.(`invoke-${launchCalls}`);
      return launchCalls === 1
        ? { ok: false, error: { code: "DISCONNECTED", message: "node disconnected" } }
        : wire(receipt(input, "completed"));
    });
    let listCalls = 0;
    const listCurrentNodes = vi.fn(async () => [nodeProof(`conn-${++listCalls}`)]);
    const adapter = createNodeWorkerLaunchAdapter({
      getTransport: () => transportWith(invoke, listCurrentNodes),
      sleep: async () => {},
    });

    await expect(adapter.launch(launchRequest(input))).resolves.toEqual(
      receipt(input, "completed"),
    );
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0]?.[0].params).toEqual(input);
    expect(invoke.mock.calls[1]?.[0].params).toEqual(input);
    expect(invoke.mock.calls[0]?.[0].node.connId).toBe("conn-1");
    expect(invoke.mock.calls[1]?.[0].node.connId).toBe("conn-2");
  });

  it("does not retry or cancel a dispatched launch rejected before capacity admission", async () => {
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (request) => {
      request.onDispatchReady?.("invoke-1");
      return {
        ok: false,
        error: {
          code: NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE,
          message: "node worker capacity remained full for 10000 ms",
        },
      };
    });
    const adapter = createNodeWorkerLaunchAdapter({
      getTransport: () => transportWith(invoke),
      sleep: async () => {},
    });

    await expect(adapter.launch(launchRequest())).rejects.toMatchObject({
      code: NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE,
      message: "device worker capacity remained full",
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls.map(([request]) => request.command)).toEqual(["worker.launch.v1"]);
  });

  it("snapshots the launch plan before asynchronous node discovery", async () => {
    const input = launchInput();
    const expectedInput = structuredClone(input);
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (request) => {
      expect(request.params).toEqual(expectedInput);
      return wire(receipt(expectedInput, "completed"));
    });
    const listCurrentNodes = vi.fn(async () => {
      input.descriptor.assignment.prompt = "mutated after launch call";
      return [nodeProof()];
    });
    const adapter = createNodeWorkerLaunchAdapter({
      getTransport: () => transportWith(invoke, listCurrentNodes),
    });

    await expect(adapter.launch(launchRequest(input))).resolves.toEqual(
      receipt(expectedInput, "completed"),
    );
    expect(input.descriptor.assignment.prompt).toBe("mutated after launch call");
  });

  it("polls an existing launch while the node reports full capacity", async () => {
    const input = launchInput();
    let launched = false;
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (request) => {
      if (request.command === "worker.launch.v1") {
        launched = true;
        return wire(receipt(input, "running"));
      }
      return wire(receipt(input, "completed"));
    });
    const adapter = createNodeWorkerLaunchAdapter({
      getTransport: () =>
        transportWith(invoke, async () => [nodeProof("conn-1", launched ? 0 : 2)]),
      sleep: async () => {},
    });

    await expect(adapter.launch(launchRequest(input))).resolves.toEqual(
      receipt(input, "completed"),
    );
    expect(invoke.mock.calls.map(([request]) => request.command)).toEqual([
      "worker.launch.v1",
      "worker.status.v1",
    ]);
  });

  it("replays launch when status cannot find the durable receipt", async () => {
    const input = launchInput();
    const responses = [
      wire(receipt(input, "running")),
      wire(null),
      wire(receipt(input, "completed")),
    ];
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async () => responses.shift()!);
    const adapter = createNodeWorkerLaunchAdapter({
      getTransport: () => transportWith(invoke),
      sleep: async () => {},
    });

    await expect(adapter.launch(launchRequest(input))).resolves.toEqual(
      receipt(input, "completed"),
    );
    expect(invoke.mock.calls.map(([request]) => request.command)).toEqual([
      "worker.launch.v1",
      "worker.status.v1",
      "worker.launch.v1",
    ]);
  });

  it("cancels before rejecting a post-dispatch identity mismatch", async () => {
    const input = launchInput();
    const mismatched = { ...receipt(input, "completed"), environmentId: "environment-other" };
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (request) => {
      if (request.command === "worker.cancel.v1") {
        return wire(receipt(input, "cancelled"));
      }
      request.onDispatchReady?.("invoke-1");
      return wire(mismatched);
    });
    const adapter = createNodeWorkerLaunchAdapter({
      getTransport: () => transportWith(invoke),
    });

    await expect(adapter.launch(launchRequest(input))).rejects.toThrow(
      "node worker supervisor receipt identity mismatch",
    );
    expect(invoke.mock.calls.map(([request]) => request.command)).toEqual([
      "worker.launch.v1",
      "worker.cancel.v1",
    ]);
  });

  it("retries a timed-out launch RPC within the overall deadline", async () => {
    const input = launchInput();
    let launchCalls = 0;
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (request) => {
      launchCalls += 1;
      request.onDispatchReady?.(`invoke-${launchCalls}`);
      return launchCalls === 1
        ? await new Promise<never>(() => {})
        : wire(receipt(input, "completed"));
    });
    const adapter = createNodeWorkerLaunchAdapter({
      getTransport: () => transportWith(invoke),
      rpcTimeoutMs: 10,
      sleep: async () => {},
    });

    await expect(adapter.launch({ ...launchRequest(input), timeoutMs: 100 })).resolves.toEqual(
      receipt(input, "completed"),
    );
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("durably cancels after caller abort and returns the terminal cancellation receipt", async () => {
    const input = launchInput();
    const controller = new AbortController();
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (request) => {
      if (request.command === "worker.cancel.v1") {
        expect(request.params).toEqual(
          expect.objectContaining({
            launchId: input.launchId,
            planHash: nodeWorkerPlanHash(input),
          }),
        );
        return wire(receipt(input, "cancelled"));
      }
      request.onDispatchReady?.("invoke-1");
      return wire(receipt(input, "running"));
    });
    const adapter = createNodeWorkerLaunchAdapter({
      getTransport: () => transportWith(invoke),
      sleep: async () => {
        controller.abort();
      },
    });

    await expect(
      adapter.launch({ ...launchRequest(input), signal: controller.signal }),
    ).resolves.toEqual(receipt(input, "cancelled"));
    expect(invoke.mock.calls.at(-1)?.[0].command).toBe("worker.cancel.v1");
  });

  it("cancels an existing launch after worker hosting is withdrawn", async () => {
    const input = launchInput();
    const controller = new AbortController();
    let launched = false;
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (request) => {
      if (request.command === "worker.cancel.v1") {
        return wire(receipt(input, "cancelled"));
      }
      launched = true;
      request.onDispatchReady?.("invoke-1");
      return wire(receipt(input, "running"));
    });
    const adapter = createNodeWorkerLaunchAdapter({
      getTransport: () =>
        transportWith(invoke, async () => [nodeProof("conn-1", launched ? 0 : 2)]),
      sleep: async () => {
        controller.abort();
      },
    });

    await expect(
      adapter.launch({ ...launchRequest(input), signal: controller.signal }),
    ).resolves.toEqual(receipt(input, "cancelled"));
    expect(invoke.mock.calls.at(-1)?.[0].command).toBe("worker.cancel.v1");
    expect(invoke.mock.calls.at(-1)?.[0].node.workerHost.capacity).toEqual({
      total: 2,
      available: 0,
    });
  });

  it("keeps cancelling through missing and active receipts until terminal", async () => {
    const input = launchInput();
    const controller = new AbortController();
    const cancelResponses = [
      wire(null),
      wire(receipt(input, "running")),
      wire(receipt(input, "cancelled")),
    ];
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (request) => {
      if (request.command === "worker.cancel.v1") {
        return cancelResponses.shift()!;
      }
      request.onDispatchReady?.("invoke-1");
      return wire(receipt(input, "running"));
    });
    const adapter = createNodeWorkerLaunchAdapter({
      getTransport: () => transportWith(invoke),
      pollIntervalMs: 1,
      sleep: async () => {
        controller.abort();
      },
    });

    await expect(
      adapter.launch({ ...launchRequest(input), signal: controller.signal }),
    ).resolves.toEqual(receipt(input, "cancelled"));
    expect(
      invoke.mock.calls.filter(([request]) => request.command === "worker.cancel.v1"),
    ).toHaveLength(3);
  });

  it("retries a timed-out cancellation RPC within one cleanup deadline", async () => {
    const input = launchInput();
    const controller = new AbortController();
    let cancelCalls = 0;
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (request) => {
      if (request.command === "worker.cancel.v1") {
        cancelCalls += 1;
        return cancelCalls === 1
          ? await new Promise<never>(() => {})
          : wire(receipt(input, "cancelled"));
      }
      request.onDispatchReady?.("invoke-1");
      return wire(receipt(input, "running"));
    });
    const adapter = createNodeWorkerLaunchAdapter({
      getTransport: () => transportWith(invoke),
      rpcTimeoutMs: 10,
      cancellationTimeoutMs: 100,
      sleep: async () => {
        controller.abort();
      },
    });

    await expect(
      adapter.launch({ ...launchRequest(input), signal: controller.signal }),
    ).resolves.toEqual(receipt(input, "cancelled"));
    expect(cancelCalls).toBe(2);
  });

  it("uses distinct cancellation authority after dispatch authority closes", async () => {
    const input = launchInput();
    let dispatchAuthorized = true;
    const cancelAuthorized = vi.fn(() => true);
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (request) => {
      if (request.command === "worker.cancel.v1") {
        return wire(receipt(input, "cancelled"));
      }
      request.onDispatchReady?.("invoke-1");
      return wire(receipt(input, "running"));
    });
    const adapter = createNodeWorkerLaunchAdapter({
      getTransport: () => transportWith(invoke),
      sleep: async () => {
        dispatchAuthorized = false;
      },
    });

    await expect(
      adapter.launch({
        ...launchRequest(input),
        isDispatchAuthorized: () => dispatchAuthorized,
        isCancellationAuthorized: cancelAuthorized,
      }),
    ).resolves.toEqual(receipt(input, "cancelled"));
    expect(cancelAuthorized).toHaveBeenCalled();
    expect(invoke.mock.calls.at(-1)?.[0].command).toBe("worker.cancel.v1");
  });

  it("bounds node discovery with the overall launch deadline", async () => {
    const input = launchInput();
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>();
    const listCurrentNodes = vi.fn(async () => await new Promise<never>(() => {}));
    const adapter = createNodeWorkerLaunchAdapter({
      getTransport: () => transportWith(invoke, listCurrentNodes),
    });

    await expect(adapter.launch({ ...launchRequest(input), timeoutMs: 25 })).rejects.toThrow(
      "node worker launch timed out",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports unknown cancellation outcome after a hard cancellation deadline", async () => {
    const input = launchInput();
    const controller = new AbortController();
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (request) => {
      if (request.command === "worker.cancel.v1") {
        return await new Promise<never>(() => {});
      }
      request.onDispatchReady?.("invoke-1");
      return wire(receipt(input, "running"));
    });
    // Scheduling lag lands the clock read that sizes the RPC budget ahead of the timer wheel,
    // so the per-RPC timer expires just before the cancellation deadline it was derived from.
    // That must stay a terminal deadline, not a retryable RPC timeout that funds a second
    // cancel dispatch out of the residue.
    let cancelling = false;
    let cancelClockReads = 0;
    const adapter = createNodeWorkerLaunchAdapter({
      getTransport: () => transportWith(invoke),
      cancellationTimeoutMs: 25,
      now: () => Date.now() + (cancelling && ++cancelClockReads === 3 ? 5 : 0),
      sleep: async () => {
        controller.abort();
        cancelling = true;
      },
    });

    await expect(
      adapter.launch({ ...launchRequest(input), signal: controller.signal }),
    ).rejects.toThrow("node worker launch failed and cancellation could not be confirmed");
    expect(
      invoke.mock.calls.filter(([request]) => request.command === "worker.cancel.v1"),
    ).toHaveLength(1);
  });
});
