import { execFileSync, spawnSync } from "node:child_process";
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
import type { NodeWorkerWorkspaceExecInput } from "../../worker/node-workspace-protocol.js";
import {
  NODE_WORKSPACE_TRANSFER_ERROR_CODE,
  NodeWorkerWorkspaceTransferError,
} from "../../worker/node-workspace-transfer-protocol.js";
import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import type { createDeviceWorkerRuntime } from "./device-provider.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import type { NodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { sameWorkerSessionTurnClaim } from "./placement-record.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";

const workspaceInfo = vi.hoisted(() => vi.fn());
const tunnelWarn = vi.hoisted(() => vi.fn());
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      if (subsystem === "gateway/worker-workspace") {
        return { ...logger, info: workspaceInfo };
      }
      return subsystem === "gateway/worker-tunnel" ? { ...logger, warn: tunnelWarn } : logger;
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
    nodeSetupId: null,
    nodeDeviceId: "node-1",
    sharedHost: true,
    desktop: null,
    bootstrapReceipt: { ...BUILD, installKind: "bundle" },
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

function transport(): NodeWorkerSupervisorTransport {
  return {
    hasCurrentRunner: () => true,
    listCurrentNodes: async () => [
      {
        nodeId: "node-1",
        connId: "conn-1",
        pairingIdentity: "pairing-1",
        pairingGeneration: "generation-1",
        clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
        protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
        workerHost: { enabled: true, capacity: { total: 2, available: 2 } },
        commands: ["system.run"],
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
  it.each([
    ["gateway-push", true],
    ["published-origin", false],
  ])("preserves the Gateway Git author through %s workspaces", async (_, dirty) => {
    const localPath = tempDirs.make("node-worker-git-author-gateway-");
    const remoteWorkspaceDir = path.join(tempDirs.make("node-worker-git-author-remote-"), "worker");
    const gitEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    delete gitEnv.GIT_AUTHOR_NAME;
    delete gitEnv.GIT_AUTHOR_EMAIL;
    delete gitEnv.GIT_COMMITTER_NAME;
    delete gitEnv.GIT_COMMITTER_EMAIL;
    const localGit = (args: string[]) =>
      execFileSync("git", ["-C", localPath, ...args], { encoding: "utf8", env: gitEnv }).trim();
    localGit(["init", "--quiet"]);
    localGit(["config", "user.name", "Gateway Repository Author"]);
    localGit(["config", "user.email", "gateway-author@example.invalid"]);
    await fs.writeFile(path.join(localPath, "tracked.txt"), "base\n");
    localGit(["add", "tracked.txt"]);
    localGit(["commit", "--quiet", "-m", "base"]);
    localGit(["remote", "add", "origin", "https://example.invalid/repository.git"]);
    if (dirty) {
      await fs.writeFile(path.join(localPath, "tracked.txt"), "gateway change\n");
    }
    const baseCommit = localGit(["rev-parse", "HEAD"]);
    const manifest = { version: 1 as const, baseCommit, entries: [] };
    const rawManifest = serializeWorkerWorkspaceManifest(manifest);
    const manifestRef = `sha256:${createHash("sha256").update(rawManifest).digest("hex")}`;
    const nodeTransport = transport();
    nodeTransport.invoke = vi.fn(async ({ params }) => {
      const input = params as NodeWorkerWorkspaceExecInput;
      let stdout = "";
      let stderr = "";
      let code = 0;
      if (input.transfer || input.argv.includes("clone")) {
        const clone = ["clone", "--quiet", "--no-checkout", localPath, remoteWorkspaceDir];
        execFileSync("git", clone, { env: gitEnv });
        if (input.transfer) {
          execFileSync("git", ["-C", remoteWorkspaceDir, "checkout", "--quiet", baseCommit], {
            env: gitEnv,
          });
          stdout = `${manifestRef}\n`;
        }
      } else if (input.argv[0] === "git") {
        const result = spawnSync("git", ["-C", remoteWorkspaceDir, ...input.argv.slice(1)], {
          encoding: "utf8",
          env: gitEnv,
        });
        stdout = result.stdout;
        stderr = result.stderr;
        code = result.status ?? 1;
      } else {
        stdout = `${manifestRef}\n`;
      }
      return {
        ok: true,
        payloadJSON: JSON.stringify({
          workspaceDir: remoteWorkspaceDir,
          stdout,
          stderr,
          code,
          signal: null,
          killed: false,
          termination: "exit",
        }),
      };
    });
    const transfer = {
      prepareSync: vi.fn(async () => ({
        snapshot: { manifest, manifestRef, rawManifest, root: localPath },
        token: "download-token",
      })),
      close: vi.fn(async () => {}),
      revoke: vi.fn(),
    } as unknown as NodeWorkspaceTransferService;
    const handle = await createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      getEnvironment: environment,
      getTransport: () => nodeTransport,
      launchNodeWorker: vi.fn(),
      validateWorkerTurn: () => true,
      workspaceTransfer: transfer,
    }).start(startRequest());

    await expect(
      handle.syncWorkspace({
        localPath,
        sessionId: "session-1",
        generation: 1,
        gitAuthor: { name: "Configured Gateway Author" },
      }),
    ).resolves.toEqual({ mode: "git", remoteWorkspaceDir, manifestRef });

    const commitArgs = [
      "-c",
      "user.useConfigOnly=true",
      "commit",
      "--allow-empty",
      "-m",
      "worker result",
    ];
    const commit = spawnSync("git", ["-C", remoteWorkspaceDir, ...commitArgs], {
      encoding: "utf8",
      env: gitEnv,
    });
    expect(commit.stderr).not.toContain("Author identity unknown");
    expect(commit.status).toBe(0);
    expect(
      execFileSync("git", ["-C", remoteWorkspaceDir, "show", "-s", "--format=%an <%ae>"], {
        encoding: "utf8",
        env: gitEnv,
      }).trim(),
    ).toBe("Configured Gateway Author <gateway-author@example.invalid>");

    await handle.stop();
  });

  it("revalidates the exact claim when a same-run replacement launches", async () => {
    const record = environment();
    let currentClaim = turnClaim();
    const authorizations: boolean[] = [];
    const manager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      getEnvironment: () => record,
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

  it("joins same-owner starts while workspace binding resolution is pending", async () => {
    const record = environment();
    const workspaceBinding = createDeferred<undefined>();
    const resolveWorkspaceBinding = vi.fn(async () => await workspaceBinding.promise);
    const manager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      getEnvironment: () => record,
      getTransport: transport,
      launchNodeWorker: vi.fn(),
      validateWorkerTurn: () => true,
      workspaceTransfer: workspaceTransfer(),
    });
    manager.bindWorkspaceBindingResolver(resolveWorkspaceBinding);

    const first = manager.start(startRequest());
    await vi.waitFor(() => expect(resolveWorkspaceBinding).toHaveBeenCalledOnce());
    const second = manager.start(startRequest());
    workspaceBinding.resolve(undefined);

    const [firstHandle, secondHandle] = await Promise.all([first, second]);
    expect(resolveWorkspaceBinding).toHaveBeenCalledOnce();
    expect(secondHandle).toBe(firstHandle);
  });

  it.each(["stop", "stopAll"] as const)(
    "%s fences a pending workspace resolver without waiting for it",
    async (operation) => {
      const record = environment();
      const workspaceBinding = createDeferred<undefined>();
      const resolverSettled = vi.fn();
      void workspaceBinding.promise.then(resolverSettled);
      const transfer = {
        ...workspaceTransfer(),
        closeAll: vi.fn(async () => {}),
      } as unknown as NodeWorkspaceTransferService;
      const resolveWorkspaceBinding = vi.fn(async () => await workspaceBinding.promise);
      const manager = createNodeWorkerTunnelManager({
        gatewayDeviceId: "gateway-device-1",
        getEnvironment: () => record,
        getTransport: transport,
        launchNodeWorker: vi.fn(),
        validateWorkerTurn: () => true,
        workspaceTransfer: transfer,
      });
      manager.bindWorkspaceBindingResolver(resolveWorkspaceBinding);

      const starting = manager.start(startRequest());
      await vi.waitFor(() => expect(resolveWorkspaceBinding).toHaveBeenCalledOnce());
      await (operation === "stop"
        ? manager.stop("environment-1", record.ownerEpoch)
        : manager.stopAll());

      expect(resolverSettled).not.toHaveBeenCalled();
      await expect(starting).rejects.toThrow("stopped before connecting");
      expect(manager.status("environment-1")).toBe("stopped");
      workspaceBinding.resolve(undefined);
    },
  );

  it("reports a cleanup failure after workspace binding initialization fails", async () => {
    tunnelWarn.mockClear();
    const record = environment();
    const transfer = workspaceTransfer();
    transfer.close = vi.fn(async () => {
      throw new Error("workspace cleanup failed");
    });
    const manager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      getEnvironment: () => record,
      getTransport: transport,
      launchNodeWorker: vi.fn(),
      validateWorkerTurn: () => true,
      workspaceTransfer: transfer,
    });
    manager.bindWorkspaceBindingResolver(async () => {
      throw new Error("workspace binding failed");
    });

    await expect(manager.start(startRequest())).rejects.toThrow("workspace binding failed");
    await vi.waitFor(() =>
      expect(tunnelWarn).toHaveBeenCalledWith(
        "node worker tunnel cleanup failed after initialization error",
        {
          environmentId: "environment-1",
          ownerEpoch: record.ownerEpoch,
          error: "workspace cleanup failed",
        },
      ),
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
      const invoke = vi.fn(async () => ({
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
      nodeTransport.invoke = invoke;
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
      if (outcome === "success") {
        expect(invoke).toHaveBeenCalledWith(
          expect.objectContaining({
            params: expect.objectContaining({
              argv: expect.arrayContaining(["all", manifestRef.slice("sha256:".length)]),
            }),
          }),
        );
      }
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
                workerHost: {
                  enabled: true,
                  capacity: { total: 2, available: launchEligible ? 2 : 0 },
                },
              },
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

  it("keeps the process timeout inside the node transport deadline", async () => {
    const record = environment();
    const manifest = { version: 1 as const, baseCommit: null, entries: [] };
    const rawManifest = serializeWorkerWorkspaceManifest(manifest);
    const manifestRef = `sha256:${createHash("sha256").update(rawManifest).digest("hex")}`;
    const validationOutputs = [`quiesced ${"c".repeat(32)}`, manifestRef, ""];
    let commandTimeoutMs: number | undefined;
    let transportTimeoutMs: number | undefined;
    const nodeTransport = transport();
    nodeTransport.invoke = vi.fn(async (request) => {
      const input = request.params as NodeWorkerWorkspaceExecInput;
      if (input.argv[0] === "slow-command") {
        commandTimeoutMs = input.timeoutMs;
        transportTimeoutMs = request.timeoutMs;
        return {
          ok: true,
          payloadJSON: JSON.stringify({
            workspaceDir: "/node/workspace",
            stdout: "",
            stderr: "",
            code: null,
            signal: "SIGTERM",
            killed: true,
            termination: "timeout",
          }),
        };
      }
      return {
        ok: true,
        payloadJSON: JSON.stringify({
          workspaceDir: "/node/workspace",
          stdout: validationOutputs.shift() ?? "",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        }),
      };
    });
    const transfer = workspaceTransfer();
    transfer.prepareSync = vi.fn(async () => ({
      snapshot: {
        manifest,
        manifestRef,
        rawManifest,
        root: "/gateway/workspace",
      },
      token: "restore-token",
    }));
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
    const handle = await manager.start(startRequest());

    await expect(
      handle.runWorkspaceCommand({
        argv: ["slow-command"],
        timeoutMs: 60_000,
        transportRetry: "never",
      }),
    ).resolves.toMatchObject({ killed: true, termination: "timeout" });
    expect(commandTimeoutMs).toBe(60_000);
    expect(transportTimeoutMs).toBeGreaterThan(60_000);
    expect(transportTimeoutMs).toBeLessThanOrEqual(65_000);
    expect(validationOutputs).toEqual([]);
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
    const invoke = vi.fn(async ({ params }) => {
      const input = params as { transfer?: { direction?: string } };
      if (input.transfer?.direction) {
        transferDirections.push(input.transfer.direction);
      }
      return { ok: true, payloadJSON: spawnResult(`${baseManifestRef}\n`) };
    });
    nodeTransport.invoke = invoke;
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
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          argv: expect.arrayContaining(["all", baseManifestRef.slice("sha256:".length)]),
        }),
      }),
    );
  });
});
