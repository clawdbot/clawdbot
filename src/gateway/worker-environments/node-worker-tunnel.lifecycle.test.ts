import { describe, expect, it, vi } from "vitest";
import { WORKER_RPC_SET_VERSION } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { NODE_WORKER_ENVIRONMENT_STOP_COMMAND } from "../../infra/node-commands.js";
import { parseWorkerLaunchPlan } from "../../worker/launch-descriptor.js";
import type { NodeWorkerSupervisorReceipt } from "../../worker/node-supervisor-protocol.js";
import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import type { createDeviceWorkerRuntime } from "./device-provider.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import {
  BUILD,
  environment,
  startRequest,
  transport,
  workspaceTransfer,
} from "./node-worker-tunnel.test-support.js";
import { sameWorkerSessionTurnClaim } from "./placement-record.js";

type NodeWorkerLaunch = ReturnType<typeof createDeviceWorkerRuntime>["launchNodeWorker"];
type TerminalReceipt = Extract<
  NodeWorkerSupervisorReceipt,
  { state: "completed" | "failed" | "interrupted" | "cancelled" }
>;

function plan() {
  return parseWorkerLaunchPlan({
    version: 4,
    admission: {
      environmentId: "environment-1",
      credential: "worker-credential-fixture",
      sessionId: "session-1",
      ownerEpoch: 2,
      rpcSetVersion: WORKER_RPC_SET_VERSION,
      handshake: BUILD,
    },
    assignment: {
      agentId: "main",
      operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
      agentRuntimeIdentityToken: "runtime-token",
      runId: "run-1",
      turnId: "turn-1",
      prompt: "inspect",
      suppressPromptTranscript: true,
      workspaceDir: "/node/workspace",
      modelRef: { provider: "openai", model: "gpt-5.6-luna" },
      inferenceOptions: {},
      initialMessages: [],
      transcript: { baseLeafId: null, nextSeq: 1 },
      liveEvents: { ackedSeq: 0, nextSeq: 1 },
      toolAuthority: { allowedToolNames: [] },
    },
  });
}

function turnClaim() {
  return {
    sessionId: "session-1",
    claimId: "claim-1",
    runId: "run-1",
    placementGeneration: 4,
    owner: { kind: "worker" as const, environmentId: "environment-1", ownerEpoch: 2 },
  };
}

describe("node worker tunnel lifetime", () => {
  it("revalidates the exact claim when a same-run replacement launches", async () => {
    const record = environment();
    let currentClaim = turnClaim();
    const authorizations: boolean[] = [];
    const manager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      getEnvironment: () => record,
      listEnvironments: () => [record],
      getTransport: transport,
      launchNodeWorker: vi.fn<NodeWorkerLaunch>(async (request) => {
        authorizations.push(request.isDispatchAuthorized());
        return {
          launchId: request.input.launchId,
          planHash: "b".repeat(64),
          environmentId: request.input.descriptor.admission.environmentId,
          sessionId: request.input.descriptor.admission.sessionId,
          ownerEpoch: request.input.descriptor.admission.ownerEpoch,
          placementGeneration: request.input.placementGeneration,
          runId: request.input.descriptor.assignment.runId,
          state: "cancelled",
          errorText: "test launch finished",
        };
      }),
      validateWorkerTurn: (claim) => sameWorkerSessionTurnClaim(claim, currentClaim),
      workspaceTransfer: workspaceTransfer(),
    });
    const handle = await manager.start(startRequest());
    const staleClaim = currentClaim;
    currentClaim = { ...staleClaim, claimId: "claim-2", placementGeneration: 5 };

    await handle.launchTurn({ plan: plan(), turnClaim: staleClaim });
    await handle.launchTurn({ plan: plan(), turnClaim: currentClaim });

    expect(authorizations).toEqual([false, true]);
  });

  it("projects a terminal gateway connection failure into the launch result", async () => {
    const record = environment();
    const errorText =
      "worker admission deadline exceeded after 3 attempts to gateway.example:18789: connect failed: Opening handshake has timed out";
    const manager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      getEnvironment: () => record,
      listEnvironments: () => [record],
      getTransport: transport,
      launchNodeWorker: vi.fn<NodeWorkerLaunch>(async (request) => ({
        launchId: request.input.launchId,
        planHash: "b".repeat(64),
        environmentId: request.input.descriptor.admission.environmentId,
        sessionId: request.input.descriptor.admission.sessionId,
        ownerEpoch: request.input.descriptor.admission.ownerEpoch,
        placementGeneration: request.input.placementGeneration,
        runId: request.input.descriptor.assignment.runId,
        state: "cancelled",
        errorText,
      })),
      validateWorkerTurn: () => true,
      workspaceTransfer: workspaceTransfer(),
    });
    const handle = await manager.start(startRequest());

    await expect(
      handle.launchTurn({ plan: plan(), turnClaim: turnClaim() }),
    ).resolves.toMatchObject({
      code: 1,
      killed: true,
      stderr: errorText,
    });
  });

  it("reuses only the exact same epoch binding", async () => {
    const record = environment();
    const manager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      getEnvironment: () => record,
      listEnvironments: () => [record],
      getTransport: transport,
      launchNodeWorker: vi.fn(),
      validateWorkerTurn: () => true,
      workspaceTransfer: workspaceTransfer(),
    });

    const first = await manager.start(startRequest());
    await expect(manager.start(startRequest())).resolves.toBe(first);
    await expect(manager.start({ ...startRequest(), sessionId: "session-other" })).rejects.toThrow(
      "binding changed",
    );
  });

  it("closes remote-exec workspaces without requiring an embedded worker lifetime command", async () => {
    const record = environment();
    record.profileSnapshot = { ...record.profileSnapshot, executionMode: "remote-exec" };
    const nodeTransport = transport();
    const nodes = await nodeTransport.listCurrentNodes();
    for (const node of nodes) {
      delete node.workerHost.environmentSession;
    }
    nodeTransport.listCurrentNodes = async () => nodes;
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>();
    nodeTransport.invoke = invoke;
    const transfer = workspaceTransfer();
    const manager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      getEnvironment: () => record,
      listEnvironments: () => [record],
      getTransport: () => nodeTransport,
      launchNodeWorker: vi.fn(),
      validateWorkerTurn: () => true,
      workspaceTransfer: transfer,
    });
    const handle = await manager.start({ ...startRequest(), executionMode: "remote-exec" });
    await expect(handle.launchTurn({ plan: plan(), turnClaim: turnClaim() })).rejects.toThrow(
      "remote-exec",
    );
    // Later durable changes cannot widen the retiring handle's process ownership.
    record.profileSnapshot = { ...record.profileSnapshot, executionMode: "worker-turn" };
    await handle.stop();
    expect(invoke).not.toHaveBeenCalled();
    expect(transfer.close).toHaveBeenCalledExactlyOnceWith(record.environmentId);
  });

  it("stops a completed turn's environment before exposing its replacement", async () => {
    const record = environment();
    const stopped = createDeferred();
    const nodeTransport = transport();
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (request) => {
      expect(request.isDispatchAuthorized()).toBe(true);
      await stopped.promise;
      return { ok: true, payloadJSON: "null" };
    });
    nodeTransport.invoke = invoke;
    const manager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      getEnvironment: () => record,
      listEnvironments: () => [record],
      getTransport: () => nodeTransport,
      launchNodeWorker: async (request) => ({
        launchId: request.input.launchId,
        planHash: "b".repeat(64),
        environmentId: record.environmentId,
        sessionId: "session-1",
        ownerEpoch: 2,
        placementGeneration: 4,
        runId: "run-1",
        state: "completed",
        resultJson: '{"status":"completed"}',
      }),
      validateWorkerTurn: () => true,
      workspaceTransfer: workspaceTransfer(),
    });
    const first = await manager.start(startRequest());
    await expect(first.launchTurn({ plan: plan(), turnClaim: turnClaim() })).resolves.toMatchObject(
      { code: 0 },
    );
    record.ownerEpoch = 3;
    const replacing = manager.start({ ...startRequest(), ownerEpoch: 3 });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    expect(manager.status(record.environmentId)).toBe("connecting");
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      command: NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
      params: { environmentId: record.environmentId, sessionId: "session-1", ownerEpoch: 2 },
    });
    stopped.resolve();
    await replacing;
    expect(invoke.mock.calls[0]?.[0].isDispatchAuthorized()).toBe(false);

    await manager.stop(record.environmentId, 2);
    expect(invoke).toHaveBeenCalledOnce();
    expect(manager.status(record.environmentId)).toBe("connected");
    await manager.stop(record.environmentId, 3);
    expect(invoke.mock.calls[1]?.[0].params).toMatchObject({ ownerEpoch: 3 });
  });

  it.each(["stop", "stopAll"] as const)(
    "%s recovers exact durable owners after restart and retries an unconfirmed stop",
    async (operation) => {
      const record = environment();
      record.bootstrapReceipt = null;
      const nodeTransport = transport();
      const invoke = vi
        .fn<NodeWorkerSupervisorTransport["invoke"]>()
        .mockResolvedValueOnce({ ok: false, error: { code: "DISCONNECTED" } })
        .mockResolvedValue({ ok: true, payloadJSON: "null" });
      nodeTransport.invoke = invoke;
      const transfer = { ...workspaceTransfer(), closeAll: vi.fn(async () => {}) };
      const manager = createNodeWorkerTunnelManager({
        gatewayDeviceId: "gateway-device-1",
        getEnvironment: () => record,
        listEnvironments: () => [record],
        getTransport: () => nodeTransport,
        launchNodeWorker: vi.fn(),
        validateWorkerTurn: () => true,
        workspaceTransfer: transfer,
      });
      const stop = () =>
        operation === "stop" ? manager.stop(record.environmentId, 2) : manager.stopAll();

      await expect(stop()).rejects.toThrow("DISCONNECTED");
      expect(invoke.mock.calls[0]?.[0].isDispatchAuthorized()).toBe(false);
      await stop();
      expect(invoke.mock.calls.map(([request]) => request.params)).toEqual([
        expect.objectContaining({
          environmentId: record.environmentId,
          sessionId: "session-1",
          ownerEpoch: 2,
        }),
        expect.objectContaining({
          environmentId: record.environmentId,
          sessionId: "session-1",
          ownerEpoch: 2,
        }),
      ]);
    },
  );

  it("cancels a replacement start before it can install a late handle", async () => {
    const record = environment();
    const releaseLaunch = createDeferred();
    const launch: NodeWorkerLaunch = async (request): Promise<TerminalReceipt> =>
      await new Promise<TerminalReceipt>((resolve) => {
        request.signal?.addEventListener(
          "abort",
          () => {
            void releaseLaunch.promise.then(() => {
              resolve({
                launchId: request.input.launchId,
                planHash: "b".repeat(64),
                environmentId: request.input.descriptor.admission.environmentId,
                sessionId: request.input.descriptor.admission.sessionId,
                ownerEpoch: request.input.descriptor.admission.ownerEpoch,
                placementGeneration: request.input.placementGeneration,
                runId: request.input.descriptor.assignment.runId,
                state: "cancelled",
                errorText: "node worker cancelled",
              });
            });
          },
          { once: true },
        );
      });
    const launchNodeWorker = vi.fn(launch);
    const manager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      getEnvironment: () => record,
      listEnvironments: () => [record],
      getTransport: transport,
      launchNodeWorker,
      validateWorkerTurn: () => true,
      workspaceTransfer: workspaceTransfer(),
    });
    const first = await manager.start(startRequest());
    const launched = first.launchTurn({
      plan: plan(),
      turnClaim: turnClaim(),
      timeoutMs: 5_000,
    });
    await vi.waitFor(() => expect(launchNodeWorker).toHaveBeenCalledOnce());
    record.ownerEpoch = 3;
    const replacement = manager.start({ ...startRequest(), ownerEpoch: 3 });

    const stopping = manager.stop("environment-1", 3);
    const stopSettled = vi.fn();
    void stopping.then(stopSettled, stopSettled);
    await expect(replacement).rejects.toThrow("stopped before connecting");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(stopSettled).not.toHaveBeenCalled();
    releaseLaunch.resolve();
    await stopping;

    await expect(launched).resolves.toMatchObject({ code: 1, killed: true });
    expect(manager.status("environment-1")).toBe("stopped");
  });

  it("keeps cancellation authorized until an active launch settles", async () => {
    const record = environment();
    let cancellationWasAuthorized = false;
    const onDispatchReady = vi.fn();
    const launch: NodeWorkerLaunch = async (request): Promise<TerminalReceipt> => {
      request.onDispatchReady?.();
      return await new Promise<TerminalReceipt>((resolve) => {
        request.signal?.addEventListener(
          "abort",
          () => {
            cancellationWasAuthorized = request.isCancellationAuthorized();
            resolve({
              launchId: request.input.launchId,
              planHash: "b".repeat(64),
              environmentId: request.input.descriptor.admission.environmentId,
              sessionId: request.input.descriptor.admission.sessionId,
              ownerEpoch: request.input.descriptor.admission.ownerEpoch,
              placementGeneration: request.input.placementGeneration,
              runId: request.input.descriptor.assignment.runId,
              state: "cancelled",
              errorText: "node worker cancelled",
            });
          },
          { once: true },
        );
      });
    };
    const launchNodeWorker = vi.fn(launch);
    const manager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      getEnvironment: () => record,
      listEnvironments: () => [record],
      getTransport: transport,
      launchNodeWorker,
      validateWorkerTurn: () => true,
      workspaceTransfer: workspaceTransfer(),
    });
    const handle = await manager.start(startRequest());
    const launched = handle.launchTurn({
      plan: plan(),
      turnClaim: turnClaim(),
      timeoutMs: 5_000,
      onDispatchReady,
    });
    await vi.waitFor(() => expect(launchNodeWorker).toHaveBeenCalledOnce());
    expect(onDispatchReady).toHaveBeenCalledOnce();

    await handle.stop();

    await expect(launched).resolves.toMatchObject({ code: 1, killed: true });
    expect(cancellationWasAuthorized).toBe(true);
    expect(manager.status("environment-1")).toBe("stopped");
  });
});
