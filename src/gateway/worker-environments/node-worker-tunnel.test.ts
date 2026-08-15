import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  WORKER_PROTOCOL_FEATURES,
  WORKER_RPC_SET_VERSION,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import { parseWorkerLaunchPlan } from "../../worker/launch-descriptor.js";
import type { NodeWorkerSupervisorReceipt } from "../../worker/node-supervisor-protocol.js";
import {
  NODE_WORKSPACE_TRANSFER_ERROR_CODE,
  NodeWorkerWorkspaceTransferError,
} from "../../worker/node-workspace-transfer-protocol.js";
import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import type { createDeviceWorkerRuntime } from "./device-provider.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import type { NodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";

const workspaceInfo = vi.hoisted(() => vi.fn());
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "gateway/worker-workspace" ? { ...logger, info: workspaceInfo } : logger;
    },
  };
});

const BUILD = {
  bundleHash: "a".repeat(64),
  openclawVersion: "2026.8.13",
  protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
};
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
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
        workerBuild: BUILD,
        workerRuns: BUILD,
      },
    ],
    isCurrent: () => true,
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

function workspaceTransfer(): NodeWorkspaceTransferService {
  return {
    close: vi.fn(async () => {}),
    revoke: vi.fn(),
  } as unknown as NodeWorkspaceTransferService;
}

describe("node worker tunnel manager", () => {
  it("projects a terminal gateway connection failure into the launch result", async () => {
    const record = environment();
    const errorText =
      "worker could not reach gateway gateway.example: certificate rejected; check TLS pin/publicUrl configuration";
    const manager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      getEnvironment: () => record,
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
      handle.launchTurn({ plan: plan(), placementGeneration: 4 }),
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

  it.each(["success", "failure"] as const)(
    "keeps same-owner starts behind restored workspace validation on %s",
    async (outcome) => {
      const record = environment();
      const validation = createDeferred();
      const manifest = { version: 1 as const, baseCommit: null, entries: [] };
      const rawManifest = serializeWorkerWorkspaceManifest(manifest);
      const manifestRef = `sha256:${createHash("sha256").update(rawManifest).digest("hex")}`;
      const outputs = [`quiesced ${"c".repeat(32)}`, manifestRef, ""];
      const nodeTransport = transport();
      nodeTransport.invoke = vi.fn(async () => ({
        ok: true,
        payloadJSON: JSON.stringify({
          workspaceDir: "/node/workspace",
          stdout: outputs.shift() ?? "",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        }),
      }));
      const prepareSync = vi.fn(async () => {
        await validation.promise;
        if (outcome === "failure") {
          throw new Error("restored workspace validation failed");
        }
        return {
          snapshot: { manifest, manifestRef, rawManifest, root: "/gateway/workspace" },
          token: "restore-token",
        };
      });
      const transfer = workspaceTransfer();
      transfer.prepareSync = prepareSync;
      const manager = createNodeWorkerTunnelManager({
        gatewayDeviceId: "gateway-device-1",
        getEnvironment: () => record,
        getTransport: () => nodeTransport,
        launchNodeWorker: vi.fn(),
        validateWorkerTurn: () => true,
        workspaceTransfer: transfer,
      });
      manager.bindWorkspaceBindingResolver(async () => ({
        localPath: "/gateway/workspace",
        manifestRef,
        remoteWorkspaceDir: "/node/workspace",
      }));
      const first = manager.start(startRequest());
      await vi.waitFor(() => expect(prepareSync).toHaveBeenCalledOnce());
      expect(manager.status("environment-1")).toBe("connecting");
      const second = manager.start(startRequest());
      const secondSettled = vi.fn();
      void second.then(secondSettled, secondSettled);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(secondSettled).not.toHaveBeenCalled();
      validation.resolve();
      const results = await Promise.allSettled([first, second]);
      const expectedStatus = outcome === "success" ? "fulfilled" : "rejected";
      expect(results.map((result) => result.status)).toEqual([expectedStatus, expectedStatus]);
      expect(manager.status("environment-1")).toBe(outcome === "success" ? "connected" : "stopped");
    },
  );

  it("keeps concurrent workspace commands on the admitted build while launch capacity is full", async () => {
    const record = environment();
    const manifest = { version: 1 as const, baseCommit: null, entries: [] };
    const rawManifest = serializeWorkerWorkspaceManifest(manifest);
    const manifestRef = `sha256:${createHash("sha256").update(rawManifest).digest("hex")}`;
    const outputs = [`quiesced ${"c".repeat(32)}`, manifestRef, ""];
    let launchEligible = true;
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
            stdout: outputs.shift() ?? "",
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
            termination: "exit",
          }),
        };
      },
    );
    const prepareSync = vi.fn(async () => ({
      snapshot: {
        manifest,
        manifestRef,
        rawManifest,
        root: "/gateway/workspace",
      },
      token: "restore-token",
    }));
    const transfer = {
      prepareSync,
      close: vi.fn(async () => {}),
      revoke: vi.fn(),
    } as unknown as NodeWorkspaceTransferService;
    const manager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      getEnvironment: () => record,
      getTransport: () => {
        const nodeTransport = transport();
        return {
          ...nodeTransport,
          listCurrentNodes: async () => {
            const [proof] = await nodeTransport.listCurrentNodes();
            if (!proof) {
              return [];
            }
            return [
              {
                ...proof,
                workerBuild: BUILD,
                ...(launchEligible ? {} : { workerRuns: undefined }),
              } as typeof proof & { workerBuild: typeof BUILD },
            ];
          },
          invoke,
        };
      },
      launchNodeWorker: vi.fn(),
      validateWorkerTurn: () => true,
      workspaceTransfer: transfer,
    });
    const resolveWorkspaceBinding = vi.fn(async () => ({
      localPath: "/gateway/workspace",
      manifestRef,
      remoteWorkspaceDir: "/node/workspace",
    }));
    manager.bindWorkspaceBindingResolver(resolveWorkspaceBinding);

    const handle = await manager.start(startRequest());
    launchEligible = false;
    const reconciled = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        handle.runWorkspaceCommand({
          argv: ["printf", `reconciled-${index}`],
          transportRetry: "never",
        }),
      ),
    );
    expect(reconciled).toHaveLength(12);
    expect(reconciled).toEqual(
      expect.arrayContaining(
        Array.from({ length: 12 }, () =>
          expect.objectContaining({ stdout: "", workspaceDir: "/node/workspace" }),
        ),
      ),
    );
    expect(resolveWorkspaceBinding).toHaveBeenCalledWith({
      environmentId: "environment-1",
      ownerEpoch: record.ownerEpoch,
      sessionId: "session-1",
    });
    expect(prepareSync).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: "environment-1",
        generation: record.ownerEpoch,
        localPath: "/gateway/workspace",
      }),
    );
    expect(outputs).toEqual([]);
  });

  it("preserves a typed workspace transfer cause from the node", async () => {
    workspaceInfo.mockClear();
    const record = environment();
    const localPath = tempDirs.make("node-worker-transfer-error-");
    const rawManifest = serializeWorkerWorkspaceManifest({
      version: 1,
      baseCommit: null,
      entries: [],
    });
    const manifestRef = `sha256:${createHash("sha256").update(rawManifest).digest("hex")}`;
    const nodeTransport = transport();
    nodeTransport.invoke = vi.fn(async () => ({
      ok: false,
      error: {
        code: NODE_WORKSPACE_TRANSFER_ERROR_CODE,
        message: "workspace-transfer-failed: gateway TLS fingerprint mismatch",
      },
    }));
    const transfer = {
      prepareSync: vi.fn(async () => ({
        snapshot: {
          manifest: { version: 1 as const, baseCommit: null, entries: [] },
          manifestRef,
          rawManifest,
          root: localPath,
        },
        token: "download-token",
      })),
      close: vi.fn(async () => {}),
      revoke: vi.fn(),
    } as unknown as NodeWorkspaceTransferService;
    const manager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      getEnvironment: () => record,
      getTransport: () => nodeTransport,
      launchNodeWorker: vi.fn(),
      validateWorkerTurn: () => true,
      workspaceTransfer: transfer,
    });
    const handle = await manager.start(startRequest());

    await expect(
      handle.syncWorkspace({ localPath, sessionId: "session-1", generation: 1 }),
    ).rejects.toMatchObject({
      name: NodeWorkerWorkspaceTransferError.name,
      code: NODE_WORKSPACE_TRANSFER_ERROR_CODE,
      message: "workspace-transfer-failed: gateway TLS fingerprint mismatch",
    });
    expect(workspaceInfo).toHaveBeenCalledWith("worker workspace sync path selected", {
      environmentId: "environment-1",
      sessionId: "session-1",
      path: "gateway-push",
      reason: "not-git-workspace",
      originAttemptMs: expect.any(Number),
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
      workspaceTransfer: workspaceTransfer(),
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
      getTransport: transport,
      launchNodeWorker,
      validateWorkerTurn: () => true,
      workspaceTransfer: workspaceTransfer(),
    });
    const handle = await manager.start(startRequest());
    const launched = handle.launchTurn({
      plan: plan(),
      placementGeneration: 4,
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

  it("recaptures the node manifest and rejects divergence before reconciliation", async () => {
    const record = environment();
    const localPath = tempDirs.make("node-worker-verify-stable-");
    const remoteWorkspaceDir = path.join(localPath, "remote");
    await fs.mkdir(remoteWorkspaceDir);
    const raw = serializeWorkerWorkspaceManifest({ version: 1, baseCommit: null, entries: [] });
    const baseManifestRef = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
    const divergentManifestRef = `sha256:${"f".repeat(64)}`;
    const spawnResult = (stdout: string) =>
      JSON.stringify({
        workspaceDir: remoteWorkspaceDir,
        stdout,
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      });
    const nodeTransport = transport();
    nodeTransport.invoke = vi.fn(async ({ params }) => {
      const input = params as { transfer?: { direction?: string } };
      return {
        ok: true,
        payloadJSON: spawnResult(
          input.transfer ? `${baseManifestRef}\n` : `${divergentManifestRef}\n`,
        ),
      };
    });
    const transfer = {
      prepareSync: vi.fn(async () => ({
        snapshot: {
          manifest: { version: 1 as const, baseCommit: null, entries: [] },
          manifestRef: baseManifestRef,
          rawManifest: raw,
          root: localPath,
        },
        token: "download-token",
      })),
      prepareUpload: vi.fn(() => "upload-token"),
      takeUpload: vi.fn(() => ({
        base: { version: 1 as const, baseCommit: null, entries: [] },
        baseManifestRef,
        baseRaw: raw,
        current: { version: 1 as const, baseCommit: null, entries: [] },
        currentManifestRef: baseManifestRef,
        currentRaw: raw,
        stagingRoot: localPath,
      })),
      close: vi.fn(async () => {}),
      revoke: vi.fn(),
    } as unknown as NodeWorkspaceTransferService;
    const manager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      getEnvironment: () => record,
      getTransport: () => nodeTransport,
      launchNodeWorker: vi.fn(),
      validateWorkerTurn: () => true,
      workspaceTransfer: transfer,
    });
    const handle = await manager.start(startRequest());
    await handle.syncWorkspace({ localPath, sessionId: "session-1", generation: 1 });

    await expect(
      handle.reconcileWorkspace({
        localPath,
        remoteWorkspaceDir,
        baseManifestRef,
        journal: { load: () => undefined, begin: vi.fn(), commit: vi.fn(), abort: vi.fn() },
      }),
    ).rejects.toThrow("changed during final reconciliation");
  });

  it("does not republish an accepted manifest already current on the node", async () => {
    const record = environment();
    const localPath = tempDirs.make("node-worker-accepted-current-");
    const remoteWorkspaceDir = tempDirs.make("node-worker-accepted-current-remote-");
    const manifest = { version: 1 as const, baseCommit: null, entries: [] };
    const raw = serializeWorkerWorkspaceManifest(manifest);
    const baseManifestRef = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
    const spawnResult = (stdout: string) =>
      JSON.stringify({
        workspaceDir: remoteWorkspaceDir,
        stdout,
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      });
    const transferDirections: string[] = [];
    const nodeTransport = transport();
    nodeTransport.invoke = vi.fn(async ({ params }) => {
      const input = params as { transfer?: { direction?: string } };
      if (input.transfer?.direction) {
        transferDirections.push(input.transfer.direction);
      }
      return { ok: true, payloadJSON: spawnResult(`${baseManifestRef}\n`) };
    });
    const publishSnapshot = vi.fn(() => "accepted-download-token");
    const transfer = {
      prepareSync: vi.fn(async () => ({
        snapshot: { manifest, manifestRef: baseManifestRef, rawManifest: raw, root: localPath },
        token: "download-token",
      })),
      prepareUpload: vi.fn(() => "upload-token"),
      takeUpload: vi.fn(() => ({
        base: manifest,
        baseManifestRef,
        baseRaw: raw,
        current: manifest,
        currentManifestRef: baseManifestRef,
        currentRaw: raw,
        stagingRoot: localPath,
      })),
      getSnapshot: vi.fn(() => ({ manifest, manifestRef: baseManifestRef, rawManifest: raw })),
      publishSnapshot,
      close: vi.fn(async () => {}),
      revoke: vi.fn(),
    } as unknown as NodeWorkspaceTransferService;
    const manager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      getEnvironment: () => record,
      getTransport: () => nodeTransport,
      launchNodeWorker: vi.fn(),
      validateWorkerTurn: () => true,
      workspaceTransfer: transfer,
    });
    const handle = await manager.start(startRequest());
    await handle.syncWorkspace({ localPath, sessionId: "session-1", generation: 1 });

    const reconciliation = await handle.reconcileWorkspace({
      localPath,
      remoteWorkspaceDir,
      baseManifestRef,
      journal: { load: () => undefined, begin: vi.fn(), commit: vi.fn(), abort: vi.fn() },
    });

    expect(reconciliation.manifestRef).toBe(baseManifestRef);
    expect(transferDirections).toEqual(["download", "upload"]);
    expect(publishSnapshot).not.toHaveBeenCalled();
  });
});
