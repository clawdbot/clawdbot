// Source-owner composition: real SQLite owners, registry wire and node command effects.
// This does not exercise Gateway authentication, provider provisioning or packaged workers.
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../../infra/device-identity.js";
import { approveDevicePairing } from "../../infra/device-pairing-approval.js";
import { captureNodePairingState } from "../../infra/device-pairing-node-state.js";
import { approveNodePairing, requestNodePairing } from "../../infra/device-pairing-node.js";
import { requestDevicePairing } from "../../infra/device-pairing.js";
import { NODE_WORKER_WORKSPACE_EXEC_COMMAND } from "../../infra/node-commands.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import { rawDataToString } from "../../infra/ws.js";
import type { NodeInvokeRequestPayload } from "../../node-host/invoke.js";
import { invokeNodeWorkerSupervisorCommand } from "../../node-host/node-worker-supervisor-commands.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { runExec } from "../../process/exec.js";
import type { Deferred } from "../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createNodeRegistryRuntime, updateNodeRunnerInventory } from "../node-registry-private.js";
import { NodeRegistry } from "../node-registry.js";
import { hashWorkerCredential } from "./credential.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import { createWorkerProjectPreparationIdentity } from "./preparation-identity.js";
import { createWorkerEnvironmentStore } from "./store.js";
import { prepareWorkerProjectSnapshot } from "./workspace-git-base.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { readActualWorkspaceManifest } from "./workspace-reconcile.js";

const BUNDLE_HASH = "b".repeat(64);
const ENVIRONMENT_ID = "prepared-authority-environment";
const NAMESPACE = "prepared-authority-gateway";
const SESSION = {
  sessionId: "prepared-authority-session",
  sessionKey: "agent:main:prepared-authority",
  agentId: "main",
  executionMode: "worker-turn" as const,
};
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  const failures: unknown[] = [];
  try {
    for (const close of cleanup.splice(0).toReversed()) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
  } finally {
    closeOpenClawStateDatabaseForTest();
  }
  if (failures.length) {
    throw new AggregateError(failures, "prepared authority fixture cleanup failed");
  }
});

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "prepared-authority-")));
  cleanup.push(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });
  const gatewayState = path.join(root, "gateway-state");
  const nodeHome = path.join(root, "node-home");
  const sourceDir = path.join(root, "project");
  await fs.mkdir(sourceDir);
  const git = async (...args: string[]) =>
    (await runExec("git", ["-C", sourceDir, ...args], { timeoutMs: 10_000 })).stdout.trim();
  await git("init", "--quiet");
  await fs.writeFile(path.join(sourceDir, "source.txt"), "pristine prepared source\n");
  await git("add", ".");
  await git(
    "-c",
    "user.name=QA",
    "-c",
    "user.email=qa@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  const project = await prepareWorkerProjectSnapshot({
    localPath: sourceDir,
    namespace: NAMESPACE,
    signal: AbortSignal.timeout(10_000),
  });
  if (!project) {
    throw new Error("fixture project has no committed snapshot");
  }
  const profileSnapshot = { install: "bundle", settings: {}, executionMode: "worker-turn" };
  const preparation = createWorkerProjectPreparationIdentity({
    namespace: NAMESPACE,
    providerId: "fixture-provider",
    profileId: "fixture-profile",
    profileSnapshot,
    project,
    target: { machineClass: "fixture-standard", platform: process.platform, arch: process.arch },
    // Bounded fixture pins exercise identity binding; no packaged-artifact proof is claimed.
    artifacts: {
      nodeBootstrapSha256: "c".repeat(64),
      enabledPluginIds: [],
      workerBundleHash: BUNDLE_HASH,
      workerArchiveSha256: "d".repeat(64),
      openclawVersion: "2026.9.1",
      protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
    },
  });
  const preparationKey = preparation.key;
  const cacheKey = preparation.cacheKey;
  const ownerRoot = path.join(nodeHome, ".openclaw-worker", "prepared", NAMESPACE, cacheKey);
  const workspaceDir = path.join(ownerRoot, "workspace");
  const homeDir = path.join(ownerRoot, "home");
  await fs.mkdir(homeDir, { recursive: true });
  await git("clone", "--quiet", "--local", "--no-hardlinks", sourceDir, workspaceDir);
  const { manifestRef, manifest } = await readActualWorkspaceManifest({
    root: workspaceDir,
    baseCommit: project.baseCommit,
  });
  const manifests = path.join(homeDir, ".openclaw-worker", "manifests");
  await fs.mkdir(manifests, { recursive: true });
  await fs.writeFile(
    path.join(manifests, `${manifestRef.slice(7)}.json`),
    serializeWorkerWorkspaceManifest(manifest),
  );
  const workspace = new NodeWorkerWorkspaceRuntime({
    ephemeral: true,
    env: {
      PATH: process.env.PATH,
      HOME: nodeHome,
      OPENCLAW_STATE_DIR: path.join(root, "node-state"),
    },
  });
  await workspace.prepare({
    action: "register",
    environmentId: ENVIRONMENT_ID,
    gatewayNamespace: NAMESPACE,
    preparationKey,
    cacheKey,
    workspaceDir,
    homeDir,
    sourceManifestRef: manifestRef,
  });

  const identity = loadOrCreateDeviceIdentity({ path: path.join(root, "identity.sqlite") });
  const publicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
  const requested = await requestDevicePairing(
    {
      deviceId: identity.deviceId,
      publicKey,
      role: "node",
      scopes: [],
      clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
      clientMode: "node",
    },
    gatewayState,
  );
  const approvedDevice = await approveDevicePairing(requested.request.requestId, gatewayState);
  if (approvedDevice?.status !== "approved") {
    throw new Error("fixture device pairing was not approved");
  }
  const requestedNode = await requestNodePairing(
    {
      nodeId: identity.deviceId,
      clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
      clientMode: "node",
      platform: process.platform,
      commands: [NODE_WORKER_WORKSPACE_EXEC_COMMAND],
    },
    gatewayState,
  );
  const approvedNode = await approveNodePairing(
    requestedNode.request.requestId,
    { callerScopes: ["operator.pairing", "operator.admin"] },
    gatewayState,
  );
  if (!approvedNode || !("nextPairingGeneration" in approvedNode)) {
    throw new Error("fixture node command surface was not approved");
  }
  const readPairing = async () => {
    const state = await captureNodePairingState(identity.deviceId, gatewayState);
    if (!state?.generation) {
      throw new Error("fixture node pairing is unavailable");
    }
    return { identity: state.identity.key, generation: state.generation.key };
  };
  const pairing = await readPairing();
  let pause: { entered: Deferred; release: Deferred } | undefined;
  const { nodeRegistry, nodeWorkerSupervisorTransport: transport } = createNodeRegistryRuntime(
    () =>
      new NodeRegistry({
        resolveCurrentPairingState: async () => {
          const pending = pause;
          if (pending) {
            pause = undefined;
            pending.entered.resolve();
            await pending.release.promise;
          }
          return await readPairing();
        },
      }),
  );
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const sockets = new Set<WebSocket>();
  server.on("connection", (accepted) => {
    sockets.add(accepted);
  });
  const nodeTasks = new Set<Promise<void>>();
  const invocations = new Set<Promise<unknown>>();
  const releases = new Set<() => void>();
  const nodeErrors: unknown[] = [];
  const connId = "prepared-authority-connection";
  cleanup.push(async () => {
    for (const release of releases) {
      release();
    }
    await Promise.allSettled(invocations);
    await Promise.allSettled(nodeTasks);
    nodeRegistry.unregister(connId);
    for (const ownedSocket of sockets) {
      ownedSocket.terminate();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    expect(nodeErrors).toEqual([]);
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture listener is unavailable");
  }
  const connected = once(server, "connection");
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  sockets.add(client);
  await once(client, "open");
  const socket: WebSocket | undefined = (await connected)[0];
  if (!socket) {
    throw new Error("fixture socket is unavailable");
  }
  // Registration is the boundary under test; handshake authentication is deliberately out of scope.
  nodeRegistry.register(
    {
      connId,
      socket,
      usesSharedGatewayAuth: false,
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: {
          id: GATEWAY_CLIENT_IDS.NODE_HOST,
          version: "test",
          platform: process.platform,
          mode: "node",
        },
        device: {
          id: identity.deviceId,
          publicKey,
          signature: "registration-fixture",
          signedAt: 1,
          nonce: "fixture",
        },
        commands: [NODE_WORKER_WORKSPACE_EXEC_COMMAND],
      },
    },
    { pairingIdentity: pairing.identity, pairingGeneration: pairing.generation },
  );
  updateNodeRunnerInventory({
    registry: nodeRegistry,
    nodeId: identity.deviceId,
    connId,
    declaration: {
      protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
      workerHost: {
        enabled: true,
        capacity: { total: 1, available: 1 },
        environmentSession: 1,
        workspaceManifest: 1,
      },
    },
  });
  const [node] = await transport.listCurrentNodes();
  if (!node) {
    throw new Error("fixture node has no supervisor proof");
  }
  const frames: NodeInvokeRequestPayload[] = [];
  client.on("message", (raw) => {
    const event = JSON.parse(rawDataToString(raw)) as {
      event: string;
      payload: NodeInvokeRequestPayload;
    };
    if (event.event !== "node.invoke.request") {
      return;
    }
    frames.push(event.payload);
    const frame = event.payload;
    const task = invokeNodeWorkerSupervisorCommand({
      command: frame.command,
      paramsJSON: frame.paramsJSON,
      workspace,
    })
      .then((result) => {
        if (!result.handled) {
          throw new Error("fixture received an unsupported node command");
        }
        client.send(
          JSON.stringify({
            id: frame.id,
            nodeId: identity.deviceId,
            ok: result.ok,
            ...(result.ok
              ? { payloadJSON: JSON.stringify(result.payload) }
              : { error: { code: result.code, message: result.message } }),
          }),
        );
      })
      .catch((error: unknown) => {
        nodeErrors.push(error);
      })
      .finally(() => nodeTasks.delete(task));
    nodeTasks.add(task);
  });
  socket.on("message", (raw) => {
    const result = JSON.parse(rawDataToString(raw)) as Parameters<
      NodeRegistry["handleInvokeResult"]
    >[0];
    nodeRegistry.handleInvokeResult({ ...result, connId });
  });

  const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: gatewayState } });
  const environments = createWorkerEnvironmentStore({ database });
  const placements = createWorkerSessionPlacementStore({ database });
  const now = Date.now();
  const assertNodeCurrent = () => {
    if (!transport.isCurrent(node)) {
      throw new Error("fixture node ownership changed");
    }
  };
  const admitted = environments.ensurePreparedIntent({
    intent: {
      environmentId: ENVIRONMENT_ID,
      providerId: "fixture-provider",
      profileId: "fixture-profile",
      provisionOperationId: "fixture-provision",
      profileSnapshot: { ...profileSnapshot, project: { ...project, preparation } },
      preparation: { key: preparationKey, demandAtMs: now, expiresAtMs: now + 60_000 },
    },
    projectKey: project.key,
    target: 1,
    maxTotal: 1,
    assertCurrent: assertNodeCurrent,
  });
  if (!admitted) {
    throw new Error("fixture reserve was not admitted");
  }
  environments.transition({ environmentId: ENVIRONMENT_ID, from: "requested", to: "provisioning" });
  const credential = (sessionId: string | null) => ({
    credentialHash: hashWorkerCredential(`fixture:${sessionId}`),
    sessionId,
    rpcSetVersion: 1,
    expiresAtMs: now + 60_000,
  });
  const ready = environments.transition({
    environmentId: ENVIRONMENT_ID,
    from: "provisioning",
    to: "ready",
    patch: {
      leaseId: "fixture-lease",
      nodeDeviceId: identity.deviceId,
      sharedHost: false,
      bootstrapReceipt: {
        bundleHash: BUNDLE_HASH,
        openclawVersion: "2026.9.1",
        protocolFeatures: [],
      },
      credential: credential(null),
    },
  });
  const requestedPlacement = placements.startDispatch(SESSION);
  const consumed = placements.bindPreparedEnvironment({
    ...SESSION,
    expectedGeneration: requestedPlacement.generation,
    environmentId: ENVIRONMENT_ID,
    ownerEpoch: ready.ownerEpoch,
    providerId: ready.providerId,
    profileId: ready.profileId,
    preparationKey,
    nodeDeviceId: identity.deviceId,
    leaseId: ready.leaseId!,
    bundleHash: BUNDLE_HASH,
    assertCurrent: assertNodeCurrent,
  });
  if (!consumed) {
    throw new Error("fixture reserve was not consumed");
  }
  const syncing = placements.transition({
    sessionId: SESSION.sessionId,
    from: "provisioning",
    to: "syncing",
    expectedGeneration: consumed.generation,
    patch: { workerBundleHash: BUNDLE_HASH },
  });
  const attached = environments.transition({
    environmentId: ENVIRONMENT_ID,
    from: "ready",
    to: "attached",
    placementBinding: {
      ...SESSION,
      generation: syncing.generation,
      preparationKey,
      assertCurrent: assertNodeCurrent,
    },
    patch: { attachedSessionIds: [SESSION.sessionId], credential: credential(SESSION.sessionId) },
  });
  await workspace.prepare({
    action: "bind",
    sessionId: SESSION.sessionId,
    sessionKey: SESSION.sessionKey,
    gatewayNamespace: NAMESPACE,
    environmentId: ENVIRONMENT_ID,
    preparationKey,
    cacheKey,
    ownerEpoch: attached.ownerEpoch,
  });
  const starting = placements.transition({
    sessionId: SESSION.sessionId,
    from: "syncing",
    to: "starting",
    expectedGeneration: syncing.generation,
    patch: { workspaceBaseManifestRef: manifestRef, remoteWorkspaceDir: workspaceDir },
  });
  placements.transition({
    sessionId: SESSION.sessionId,
    from: "starting",
    to: "active",
    expectedGeneration: starting.generation,
    patch: { activeOwnerEpoch: attached.ownerEpoch },
  });
  const gate = createWorkerSessionPlacementGate(placements);
  const claim = (id: string) =>
    placements.claimTurn({
      ...SESSION,
      claimId: id,
      runId: id,
      owner: { kind: "worker", environmentId: ENVIRONMENT_ID, ownerEpoch: attached.ownerEpoch },
    });
  const invoke = (
    turnClaim: WorkerSessionTurnClaim,
    marker: string,
    sessionKey = SESSION.sessionKey,
  ) => {
    const operation = transport.invoke({
      node,
      command: NODE_WORKER_WORKSPACE_EXEC_COMMAND,
      requireWorkspaceManifest: true,
      timeoutMs: 10_000,
      params: {
        gatewayNamespace: NAMESPACE,
        environmentId: ENVIRONMENT_ID,
        sessionId: SESSION.sessionId,
        sessionKey,
        preparationKey,
        generation: attached.ownerEpoch,
        argv: [
          "node",
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`,
        ],
      },
      isDispatchAuthorized: () => gate.validateWorkerTurn(turnClaim),
    });
    invocations.add(operation);
    void operation.finally(() => invocations.delete(operation)).catch(() => {});
    return operation;
  };
  return {
    workspaceDir,
    placements,
    environments,
    frames,
    claim,
    invoke,
    pausePairing() {
      const pending = { entered: createDeferred(), release: createDeferred() };
      pause = pending;
      releases.add(() => pending.release.resolve());
      return pending;
    },
  };
}

describe("prepared workspace authority at registry dispatch", () => {
  it(
    "rejects the nearest mismatched bound session before the real command writes",
    { timeout: 30_000 },
    async () => {
      const f = await fixture();
      const claim = f.claim("mismatched-session");
      await expect(
        f.invoke(claim, "denied.txt", "agent:main:other-session"),
      ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
      await expect(fs.stat(path.join(f.workspaceDir, "denied.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(f.invoke(claim, "allowed.txt")).resolves.toMatchObject({ ok: true });
      expect(await fs.readFile(path.join(f.workspaceDir, "allowed.txt"), "utf8")).toBe("executed");
    },
  );

  it.each(["unchanged", "released", "replacement claim", "placement teardown"] as const)(
    "revalidates a real prepared owner after pairing resolution: %s",
    { timeout: 30_000 },
    async (change) => {
      const f = await fixture();
      const original = f.claim("original-claim");
      const paused = f.pausePairing();
      const invocation = f.invoke(original, "pending.txt");
      await withTestTimeout(
        paused.entered.promise,
        5_000,
        "registry did not reach pairing resolution",
      );
      expect(f.frames).toEqual([]);
      let replacement: WorkerSessionTurnClaim | undefined;
      if (change === "released" || change === "replacement claim") {
        f.placements.releaseTurn(original);
        if (change === "replacement claim") {
          replacement = f.claim("replacement-claim");
        }
      }
      if (change === "placement teardown") {
        const placement = f.placements.get(SESSION.sessionId)!;
        if (placement.activeOwnerEpoch === null) {
          throw new Error("fixture lost its active owner");
        }
        const owner = {
          sessionId: SESSION.sessionId,
          environmentId: ENVIRONMENT_ID,
          ownerEpoch: placement.activeOwnerEpoch,
        };
        const draining = f.placements.startDrain({
          ...owner,
          expectedGeneration: placement.generation,
        });
        f.placements.startReconcile({ ...owner, expectedGeneration: draining.generation });
        const environment = f.environments.get(ENVIRONMENT_ID)!;
        f.environments.requestDestroy({ environmentId: ENVIRONMENT_ID, state: environment.state });
        f.environments.transition({
          environmentId: ENVIRONMENT_ID,
          from: "attached",
          to: "draining",
        });
      }
      paused.release.resolve();
      if (change === "unchanged") {
        await expect(invocation).resolves.toMatchObject({ ok: true });
        expect(await fs.readFile(path.join(f.workspaceDir, "pending.txt"), "utf8")).toBe(
          "executed",
        );
      } else {
        await expect(invocation).resolves.toMatchObject({
          ok: false,
          error: { code: "APPROVAL_AUTHORITY_CLOSED" },
        });
        expect(f.frames).toEqual([]);
        await expect(fs.stat(path.join(f.workspaceDir, "pending.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        if (replacement) {
          await expect(f.invoke(replacement, "replacement.txt")).resolves.toMatchObject({
            ok: true,
          });
          expect(await fs.readFile(path.join(f.workspaceDir, "replacement.txt"), "utf8")).toBe(
            "executed",
          );
        }
      }
    },
  );
});
