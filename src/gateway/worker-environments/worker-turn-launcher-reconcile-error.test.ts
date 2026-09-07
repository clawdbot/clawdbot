import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
  WORKER_RPC_SET_VERSION,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { NODE_WORKER_ENVIRONMENT_STOP_COMMAND } from "../../infra/node-commands.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { installWorkerPlacementReconcileGuard } from "../server-worker-placement-reconcile-guard.js";
import { StaleWorkerBuildError } from "./admission.js";
import { hashWorkerCredential } from "./credential.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import {
  transport,
  withWorkspaceDrain,
  workspaceTransfer,
} from "./node-worker-tunnel.test-support.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import { createWorkerPlacementDispatchService } from "./placement-dispatch.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import { createWorkerEnvironmentService } from "./service.js";
import { BUNDLE_ARTIFACT, createProvider } from "./service.test-support.js";
import { createWorkerEnvironmentStore } from "./store.js";
import {
  ENVIRONMENT_ID,
  MANIFEST_REF,
  SESSION_ID,
  SESSION_KEY,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  placements,
  root,
  setupWorkerTurnLauncherTest,
  turn,
} from "./worker-turn-launcher.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

describe("worker turn recovery after environment reconciliation errors", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  it("settles a stale-build turn when a lost shared node rejects its stop acknowledgement", async () => {
    const store = createWorkerEnvironmentStore({ database: openOpenClawStateDatabase() });
    let installation = {
      ...BUNDLE_ARTIFACT,
      protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
    };
    const nodeTransport = transport();
    let rejectStop = true;
    const stopRequests = vi.fn<typeof nodeTransport.invoke>(async (request) => {
      expect(request.command).toBe(NODE_WORKER_ENVIRONMENT_STOP_COMMAND);
      return rejectStop
        ? { ok: false, error: { code: "UNAVAILABLE" } }
        : { ok: true, payloadJSON: "null" };
    });
    vi.spyOn(nodeTransport, "invoke").mockImplementation(withWorkspaceDrain(stopRequests));
    const transfer = workspaceTransfer();
    transfer.closeAll = vi.fn(async () => {});
    const nodeTunnelManager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-recovery-fixture",
      getEnvironment: store.get,
      listEnvironments: store.list,
      getTransport: () => nodeTransport,
      launchNodeWorker: vi.fn(),
      validateWorkerTurn: (claim) => placements.validateTurnClaim(claim),
      workspaceTransfer: transfer,
    });
    const inspect = vi.fn(async () => ({ status: "destroyed" as const }));
    const provider = createProvider({ supportedExecutionModes: ["worker-turn"], inspect });
    const warn = vi.fn();
    const environments = createWorkerEnvironmentService({
      store,
      getConfig: () => ({}),
      resolveProvider: () => provider,
      prepareInstallation: async () => installation,
      bootstrapWorker: vi.fn(),
      executeInference: vi.fn(),
      placementStore: createWorkerSessionPlacementGate(placements),
      nodeTunnelManager,
      logger: { warn },
    });
    const workspaceOperations = createWorkerWorkspaceOperationCoordinator();
    const dispatch = coordinateWorkerPlacementDispatch(
      createWorkerPlacementDispatchService({
        placements,
        environments,
        runnerAvailability: { read: () => undefined, version: () => 0 },
        workspaceOperations,
        runLocalBarrier: async ({ startDispatch }) => startDispatch(),
        runRecoveryBarrier: async ({ run }) => await run({ kind: "local", path: root }),
        runActivationBarrier: async ({ activate }) => activate(),
        runMoveBarrier: async ({ begin }) => begin(),
        resolveMoveDestination: async () => undefined,
        runReclaimPreparation: async ({ run, authorize }) => await run(authorize),
        runReclaimBarrier: async ({ begin, reclaim }) =>
          await reclaim({ kind: "local", path: root }, begin()),
        runFailedReclaimBarrier: async ({ reclaim }) => await reclaim(),
        resolveWorkspace: async () => ({ kind: "local" as const, path: root }),
        reportWorkspaceResultConflict: async () => {},
        resolveWorkspaceResultConflict: async () => ({ kind: "absent" }),
      }),
      (_request, run) => run(),
    );
    const uninstall = installWorkerPlacementReconcileGuard({
      placements,
      environments,
      dispatch,
      isStopping: () => false,
    });
    try {
      store.createIntent({
        environmentId: ENVIRONMENT_ID,
        providerId: provider.id,
        profileId: "development",
        profileSnapshot: { executionMode: "worker-turn", settings: { device: "node-1" } },
        provisionOperationId: "shared-node-recovery",
      });
      store.transition({ environmentId: ENVIRONMENT_ID, from: "requested", to: "provisioning" });
      const ready = store.transition({
        environmentId: ENVIRONMENT_ID,
        from: "provisioning",
        to: "ready",
        patch: {
          leaseId: "shared-node-lease",
          nodeDeviceId: "node-1",
          sharedHost: true,
          credential: {
            credentialHash: hashWorkerCredential("ready-worker-recovery-fixture"),
            sessionId: null,
            rpcSetVersion: WORKER_RPC_SET_VERSION,
            expiresAtMs: Date.now() + 60_000,
          },
          bootstrapReceipt: {
            bundleHash: installation.bundleHash,
            openclawVersion: installation.openclawVersion,
            protocolFeatures: installation.protocolFeatures,
            installKind: "bundle",
          },
        },
      });
      const attached = await environments.attachSession({
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: ready.ownerEpoch,
        sessionId: SESSION_ID,
      });
      let placement = placements.startDispatch({
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        executionMode: "worker-turn",
      });
      placement = placements.transition({
        sessionId: SESSION_ID,
        from: "requested",
        to: "provisioning",
        expectedGeneration: placement.generation,
        patch: { environmentId: ENVIRONMENT_ID },
      });
      placement = placements.transition({
        sessionId: SESSION_ID,
        from: "provisioning",
        to: "syncing",
        expectedGeneration: placement.generation,
        patch: { workerBundleHash: installation.bundleHash },
      });
      placement = placements.transition({
        sessionId: SESSION_ID,
        from: "syncing",
        to: "starting",
        expectedGeneration: placement.generation,
        patch: { remoteWorkspaceDir: "/worker/workspace", workspaceBaseManifestRef: MANIFEST_REF },
      });
      placements.transition({
        sessionId: SESSION_ID,
        from: "starting",
        to: "active",
        expectedGeneration: placement.generation,
        patch: { activeOwnerEpoch: attached.ownerEpoch },
      });
      installation = { ...installation, bundleHash: "d".repeat(64) };
      const startTunnel = vi.spyOn(environments, "startTunnel");
      const launcher = createWorkerSessionTurnPlacementProvider({
        placements,
        environments,
        workspaceOperations,
        reconcileActivePlacement: dispatch.reconcileActive,
      });
      const runId = "stale-build-shared-node-stop-failed";
      const failure = await launcher
        .executeTurn(
          { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId },
          turn(runId),
          vi.fn(),
        )
        .catch((error: unknown) => error);

      expect(startTunnel).toHaveBeenCalledOnce();
      await expect(startTunnel.mock.results[0]?.value).rejects.toBeInstanceOf(
        StaleWorkerBuildError,
      );
      expect(inspect).toHaveBeenCalledOnce();
      expect(stopRequests).toHaveBeenCalled();
      expect(store.getCredential(ENVIRONMENT_ID)).toBeUndefined();
      expect(placements.listPendingWorkspaceResults()).toEqual([]);
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "failed", turnClaim: null });
      expect(failure).toBeInstanceOf(Error);
      expect(warn).toHaveBeenCalledWith(
        `Worker environment reconcile failed (${ENVIRONMENT_ID}, ${provider.id})`,
      );
    } finally {
      rejectStop = false;
      await uninstall();
      await environments.stop();
    }
  });
});
