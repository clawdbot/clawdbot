import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  WORKER_PROTOCOL_FEATURES,
  WORKER_RPC_SET_VERSION,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import { parseWorkerLaunchPlan } from "../../worker/launch-descriptor.js";
import type { NodeWorkerSupervisorReceipt } from "../../worker/node-supervisor-protocol.js";
import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import type { createDeviceWorkerRuntime } from "./device-provider.js";

const workspaceFallbackMock = vi.hoisted(() =>
  vi.fn(() => ({
    syncWorkspace: vi.fn(),
    quiesceWorkspace: vi.fn(async () => ({
      assertActive: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
    })),
    reconcileWorkspace: vi.fn(),
  })),
);

vi.mock("./node-worker-workspace-fallback.js", () => ({
  createNodeWorkerWorkspaceFallback: workspaceFallbackMock,
}));

import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import type { WorkerEnvironmentRecord } from "./store.js";

const BUILD = {
  bundleHash: "a".repeat(64),
  openclawVersion: "2026.8.13",
  protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
};
type NodeWorkerLaunch = ReturnType<typeof createDeviceWorkerRuntime>["launchNodeWorker"];
type TerminalReceipt = Extract<
  NodeWorkerSupervisorReceipt,
  { state: "completed" | "failed" | "interrupted" | "cancelled" }
>;

function environment(): WorkerEnvironmentRecord {
  return {
    environmentId: "environment-1",
    providerId: "device",
    profileId: "device:node-1",
    profileSnapshot: { settings: { device: "node-1" } },
    provisionOperationId: "provision-1",
    sharedHost: true,
    desktop: null,
    bootstrapReceipt: { ...BUILD, installKind: "local" },
    ownerEpoch: 2,
    teardownTerminalState: null,
    attachedSessionIds: ["session-1"],
    lastError: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
    idleSinceAtMs: null,
    destroyRequestedAtMs: null,
    state: "attached",
    leaseId: "device-lease",
    sshEndpoint: null,
  };
}

function plan() {
  return parseWorkerLaunchPlan({
    version: 3,
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

function transport(): NodeWorkerSupervisorTransport {
  return {
    listCurrentNodes: async () => [
      {
        nodeId: "node-1",
        connId: "conn-1",
        pairingIdentity: "pairing-1",
        pairingGeneration: "generation-1",
        clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
        protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
        commands: ["system.run"],
        workerRuns: BUILD,
      },
    ],
    invoke: async () => ({ ok: false, error: { code: "UNAVAILABLE" } }),
  };
}

function startRequest() {
  return {
    environmentId: "environment-1",
    ownerEpoch: 2,
    deviceId: "node-1",
    sessionId: "session-1",
    expectedBuild: BUILD,
  };
}

describe("node worker tunnel manager", () => {
  it("reuses only the exact same epoch binding", async () => {
    const record = environment();
    const manager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      getEnvironment: () => record,
      getTransport: transport,
      launchNodeWorker: vi.fn(),
      validateWorkerTurn: () => true,
    });

    const first = await manager.start(startRequest());
    await expect(manager.start(startRequest())).resolves.toBe(first);
    await expect(manager.start({ ...startRequest(), sessionId: "session-other" })).rejects.toThrow(
      "binding changed",
    );
  });

  it("restores workspace command authority from the durable owner epoch", async () => {
    const record = environment();
    const invoke = vi.fn(
      async (request: Parameters<NodeWorkerSupervisorTransport["invoke"]>[0]) => {
        expect(request.params).toMatchObject({
          environmentId: "environment-1",
          sessionId: "session-1",
          generation: record.ownerEpoch,
        });
        return {
          ok: true,
          payloadJSON: JSON.stringify({
            workspaceDir: "/node/workspace",
            stdout: "restored",
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
            termination: "exit",
          }),
        };
      },
    );
    const manager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      getEnvironment: () => record,
      getTransport: () => ({ ...transport(), invoke }),
      launchNodeWorker: vi.fn(),
      validateWorkerTurn: () => true,
    });
    const resolveWorkspaceBinding = vi.fn(async () => ({
      localPath: "/gateway/workspace",
      manifestRef: `sha256:${"b".repeat(64)}`,
      remoteWorkspaceDir: "/node/workspace",
    }));
    manager.bindWorkspaceBindingResolver(resolveWorkspaceBinding);

    const handle = await manager.start(startRequest());
    await expect(
      handle.runWorkspaceCommand({
        argv: ["printf", "restored"],
        transportRetry: "idempotent",
      }),
    ).resolves.toMatchObject({ stdout: "restored", workspaceDir: "/node/workspace" });
    expect(resolveWorkspaceBinding).toHaveBeenCalledWith({
      environmentId: "environment-1",
      ownerEpoch: record.ownerEpoch,
      sessionId: "session-1",
    });
    expect(workspaceFallbackMock).toHaveBeenCalledWith(expect.any(Function), {
      localPath: "/gateway/workspace",
      manifestRef: `sha256:${"b".repeat(64)}`,
      remoteWorkspaceDir: "/node/workspace",
    });
  });

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
      getTransport: transport,
      launchNodeWorker,
      validateWorkerTurn: () => true,
    });
    const first = await manager.start(startRequest());
    const launched = first.launchTurn({ plan: plan(), placementGeneration: 4, timeoutMs: 5_000 });
    await vi.waitFor(() => expect(launchNodeWorker).toHaveBeenCalledOnce());
    record.ownerEpoch = 3;
    const replacement = manager.start({ ...startRequest(), ownerEpoch: 3 });

    await manager.stop("environment-1", 3);
    releaseLaunch.resolve();

    await expect(replacement).rejects.toThrow("start was cancelled");
    await expect(launched).resolves.toMatchObject({ code: 1, killed: true });
    expect(manager.status("environment-1")).toBe("stopped");
  });

  it("keeps cancellation authorized until an active launch settles", async () => {
    const record = environment();
    let cancellationWasAuthorized = false;
    const launch: NodeWorkerLaunch = async (request): Promise<TerminalReceipt> =>
      await new Promise<TerminalReceipt>((resolve) => {
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
    const launchNodeWorker = vi.fn(launch);
    const manager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      getEnvironment: () => record,
      getTransport: transport,
      launchNodeWorker,
      validateWorkerTurn: () => true,
    });
    const handle = await manager.start(startRequest());
    const launched = handle.launchTurn({ plan: plan(), placementGeneration: 4, timeoutMs: 5_000 });
    await vi.waitFor(() => expect(launchNodeWorker).toHaveBeenCalledOnce());

    await handle.stop();

    await expect(launched).resolves.toMatchObject({ code: 1, killed: true });
    expect(cancellationWasAuthorized).toBe(true);
    expect(manager.status("environment-1")).toBe("stopped");
  });
});
