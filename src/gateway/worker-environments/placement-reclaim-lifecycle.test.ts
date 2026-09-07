import { describe, expect, it, vi } from "vitest";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { NODE_WORKER_ENVIRONMENT_STOP_COMMAND } from "../../infra/node-commands.js";
import type { NodeWorkerWorkspaceExecInput } from "../../worker/node-workspace-protocol.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import * as nodeSupport from "./node-worker-tunnel.test-support.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import { MANIFEST_REF, REQUEST, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerPlacementIdleSweep } from "./placement-idle-sweep.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import * as support from "./service.test-support.js";
import type { WorkerTunnelManager } from "./tunnel.js";
import {
  REMOTE_WORKSPACE_QUIESCE_JS,
  REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
  REMOTE_WORKSPACE_RESUME_JS,
} from "./workspace-quiescence-scripts.js";

describe("placement reclaim with provider-owned node teardown", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each([
    { operation: "reclaim", failure: "rejection" },
    { operation: "reclaim", failure: "timeout" },
    { operation: "move", failure: "rejection" },
    { operation: "move", failure: "timeout" },
    { operation: "recovery", failure: "rejection" },
    { operation: "reclaim", failure: "reconciliation" },
    { operation: "reclaim", failure: "resume-owner-close" },
  ] as const)(
    "keeps $operation $failure observable across quiescence and teardown",
    async ({ operation, failure }) => {
      let placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const harnessOptions = {
        workspacePath: support.testState.root,
        reconcileChanged: false,
        reconcileCommitsManifest: false,
      };
      let harness = createHarness(placements, harnessOptions);
      const environmentId = harness.ready.environmentId;
      const build = {
        ...support.BOOTSTRAP_RECEIPT,
        protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
      };
      support.testState.prepareInstallation = async () => ({
        ...support.BUNDLE_ARTIFACT,
        ...build,
      });
      support.testState.store.createIntent({
        environmentId,
        providerId: "fake",
        profileId: REQUEST.profileId,
        profileSnapshot: { settings: { region: "test" } },
        provisionOperationId: "provision-fixture",
      });
      support.testState.store.transition({ environmentId, from: "requested", to: "provisioning" });
      support.testState.store.transition({
        environmentId,
        from: "provisioning",
        to: "ready",
        patch: {
          ...support.readyPatch(environmentId, { ...build, installKind: "bundle" }),
          leaseId: "lease-fixture",
          nodeDeviceId: "node-fixture",
          sharedHost: false,
        },
      });
      const attached = support.testState.store.transition({
        environmentId,
        from: "ready",
        to: "attached",
        patch: {
          ...support.attachedPatch(environmentId, REQUEST.sessionId),
          sharedHost: false,
        },
      });
      const active = harness.placements.seedActive(attached.ownerEpoch);
      if (active.state !== "active") {
        throw new Error("expected active placement");
      }
      if (operation === "recovery") {
        placements.markWorkspaceResultPending(
          placements.claimTurn({
            ...REQUEST,
            claimId: "pending-claim",
            runId: "pending-run",
            owner: { kind: "worker", environmentId, ownerEpoch: attached.ownerEpoch },
          }),
        );
        placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
        harness = createHarness(placements, harnessOptions);
      }
      harness.markEnvironmentOwnerEpoch(attached.ownerEpoch);
      const transport = nodeSupport.transport();
      const nodes = await transport.listCurrentNodes();
      nodes[0]!.nodeId = attached.nodeDeviceId!;
      transport.listCurrentNodes = async () => nodes;
      const nonce = "d".repeat(32);
      const invoke = vi.fn<typeof transport.invoke>(async ({ command, params }) => {
        if (command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND) {
          return { ok: true, payloadJSON: "null" };
        }
        const input = params as NodeWorkerWorkspaceExecInput;
        const stdout =
          input.argv[2] === REMOTE_WORKSPACE_QUIESCE_JS
            ? `quiesced ${nonce}`
            : input.argv[2] === REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS
              ? `renewed ${nonce}`
              : MANIFEST_REF;
        return {
          ok: true,
          payloadJSON: nodeSupport.workspaceCommandPayload(active.remoteWorkspaceDir, { stdout }),
        };
      });
      transport.invoke = nodeSupport.withWorkspaceDrain(invoke);
      const transfer = nodeSupport.workspaceTransfer();
      transfer.closeAll = vi.fn(async () => {});
      transfer.prepareSync = vi.fn(async () => ({
        token: "fixture-transfer",
        snapshot: {
          root: support.testState.root,
          manifest: { version: 1 as const, baseCommit: null, entries: [] },
          manifestRef: MANIFEST_REF,
          rawManifest: "",
        },
      }));
      const tunnels = createNodeWorkerTunnelManager({
        gatewayDeviceId: "gateway-fixture",
        getEnvironment: (id) => support.testState.store.get(id),
        listEnvironments: () => support.testState.store.list(),
        getTransport: () => transport,
        launchNodeWorker: vi.fn(),
        validateWorkerTurn: (claim) => placements.validateTurnClaim(claim),
        workspaceTransfer: transfer,
      });
      tunnels.bindWorkspaceBindingResolver(async () => ({
        source: { kind: "local", path: support.testState.root },
        remoteWorkspaceDir: active.remoteWorkspaceDir,
        manifestRef: MANIFEST_REF,
      }));
      const handle = await tunnels.start({
        environmentId,
        ownerEpoch: attached.ownerEpoch,
        deviceId: attached.nodeDeviceId!,
        sessionId: active.sessionId,
        executionMode: "worker-turn",
        expectedBuild: build,
      });
      // Keep transfer/apply outside this lifecycle proof; the real tunnel owns quiescence
      // and its captured authority, and the real provider lifecycle fences that owner.
      const workspace = await harness.environments.startTunnel({
        environmentId,
        ownerEpoch: attached.ownerEpoch,
      });
      handle.reconcileWorkspace = vi.fn(workspace.reconcileWorkspace.bind(workspace));
      const reconciliationError = new Error("workspace transfer interrupted");
      let closingOwner: Promise<unknown> | undefined;
      if (failure === "reconciliation" || failure === "resume-owner-close") {
        vi.mocked(handle.reconcileWorkspace).mockImplementationOnce(async () => {
          if (failure === "resume-owner-close") {
            transport.listCurrentNodes = async () => {
              transport.listCurrentNodes = async () => nodes;
              closingOwner = service.destroy(environmentId);
              await closingOwner;
              return nodes;
            };
          }
          throw reconciliationError;
        });
      }
      const providerPending = createDeferred();
      const destroyStarted = createDeferred();
      const destroy = vi.fn(async () => {});
      if (failure !== "reconciliation" && failure !== "resume-owner-close") {
        destroy.mockImplementationOnce(async () => {
          destroyStarted.resolve();
          if (failure === "timeout") {
            await providerPending.promise;
          } else {
            throw new Error("provider destruction is indeterminate");
          }
        });
      }
      const service = support.createService(
        support.createProvider({ supportedExecutionModes: ["worker-turn"], destroy }),
        { nodeTunnelManager: tunnels, providerCallTimeoutMs: 1_000 },
      );
      let primaryError: unknown;
      vi.mocked(harness.environments.get).mockImplementation(service.get);
      vi.mocked(harness.environments.startTunnel).mockImplementation(async (request) => {
        await service.startTunnel(request);
        return handle;
      });
      vi.mocked(harness.environments.stopTunnel).mockImplementation(service.stopTunnel);
      vi.mocked(harness.environments.reconcileOnce).mockImplementation(service.reconcileOnce);
      vi.mocked(harness.environments.destroy).mockImplementation(async (id) => {
        try {
          return await service.destroy(id);
        } catch (error) {
          primaryError = error;
          expect(support.testState.store.get(id)).toMatchObject({
            state: "attached",
            attachedSessionIds: [active.sessionId],
            ownerEpoch: attached.ownerEpoch,
            destroyRequestedAtMs: support.testState.nowMs,
          });
          expect(support.testState.store.getCredential(id)).toBeUndefined();
          expect(tunnels.status(id)).toBe("stopped");
          providerPending.resolve();
          throw error;
        }
      });
      const coordinated = coordinateWorkerPlacementDispatch(harness.service, (_request, run) =>
        run(),
      );
      invoke.mockClear();
      vi.mocked(harness.environments.startTunnel).mockClear();
      vi.useFakeTimers();
      const request = {
        sessionId: active.sessionId,
        sessionKey: active.sessionKey,
        agentId: active.agentId,
      };
      const result = (
        operation === "recovery"
          ? coordinated.reconcileActive()
          : operation === "reclaim"
            ? coordinated.reclaim(request)
            : coordinated.move({
                ...request,
                source: {
                  generation: active.generation,
                  environmentId,
                  ownerEpoch: attached.ownerEpoch,
                },
                target: { kind: "gateway" },
              })
      ).catch((error: unknown) => error);
      try {
        if (failure === "resume-owner-close") {
          const outcome = await result;
          expect(closingOwner).toBeDefined();
          await closingOwner;
          expect.soft(outcome).toBe(reconciliationError);
          expect(destroy).toHaveBeenCalledOnce();
          expect(tunnels.status(environmentId)).toBe("stopped");
          expect(service.get(environmentId)?.state).toBe("destroyed");
          expect(
            invoke.mock.calls.filter(
              ([call]) =>
                (call.params as NodeWorkerWorkspaceExecInput).argv?.[2] ===
                REMOTE_WORKSPACE_RESUME_JS,
            ),
          ).toEqual([]);
          return;
        }
        if (failure === "reconciliation") {
          expect(await result).toBe(reconciliationError);
          expect(destroy).not.toHaveBeenCalled();
          expect(tunnels.status(environmentId)).toBe("connected");
          expect(placements.get(active.sessionId)).toMatchObject({
            state: "draining",
            turnClaim: null,
          });
          expect(
            invoke.mock.calls.filter(
              ([call]) =>
                (call.params as NodeWorkerWorkspaceExecInput).argv?.[2] ===
                REMOTE_WORKSPACE_RESUME_JS,
            ),
          ).toHaveLength(1);
          await expect(coordinated.reclaim(request)).resolves.toMatchObject({
            state: "reclaimed",
          });
          return;
        }
        await Promise.race([
          destroyStarted.promise,
          result.then((outcome) => {
            throw outcome;
          }),
        ]);
        if (failure === "timeout") {
          await vi.advanceTimersByTimeAsync(1_001);
        }
        const outcome = await result;
        const expectedError =
          failure === "timeout"
            ? "Worker provider operation timed out after 1000ms"
            : "provider destruction is indeterminate";
        expect(primaryError).toMatchObject({ code: "provider_failure", message: expectedError });
        if (operation === "recovery") {
          expect(outcome).toBeUndefined();
          expect
            .soft(harness.reportWorkspaceResultRecoveryFailure)
            .toHaveBeenCalledWith(expect.objectContaining({ error: expectedError }));
          expect(placements.get(active.sessionId)?.state).toBe("draining");
        } else {
          expect.soft(outcome).toBe(primaryError);
        }
        expect(placements.get(active.sessionId)?.state).toBe("draining");
        expect(placements.listPendingWorkspaceResults()).toEqual([
          expect.objectContaining({ workspaceAcceptedAtMs: expect.any(Number) }),
        ]);
        expect(destroy).toHaveBeenCalledOnce();
        await coordinated.reconcileActive();
        expect(placements.get(active.sessionId)).toMatchObject({
          state: operation === "move" ? "local" : "reclaimed",
          generation: active.generation + 3,
          turnClaim: null,
          recoveryError: null,
        });
        expect(placements.listPendingWorkspaceResults()).toEqual([]);
        expect(service.get(environmentId)?.state).toBe("destroyed");
        expect(destroy).toHaveBeenCalledTimes(2);
        expect(harness.environments.startTunnel).toHaveBeenCalledOnce();
        expect(
          invoke.mock.calls.filter(
            ([call]) =>
              (call.params as NodeWorkerWorkspaceExecInput).argv?.[2] ===
              REMOTE_WORKSPACE_RESUME_JS,
          ),
        ).toEqual([]);
      } finally {
        providerPending.resolve();
        vi.useRealTimers();
        await closingOwner;
      }
    },
  );
});

describe("SSH placement cleanup after worker credential expiry", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each(["reclaim", "move", "idle suspend"] as const)(
    "%s reconciles the workspace before releasing the exact lease",
    async (operation) => {
      const placements = createWorkerSessionPlacementStore({
        database: support.testState.stateDb,
        now: () => support.testState.nowMs,
      });
      const harness = createHarness(placements, { workspacePath: support.testState.root });
      const environmentId = harness.ready.environmentId;
      const identity = support.seedAttachedIdentity(environmentId, REQUEST.sessionId);
      const active = seedActivePlacement(placements, {
        environmentId,
        ownerEpoch: identity.ownerEpoch,
        executionMode: "remote-exec",
      });
      if (active.state !== "active") {
        throw new Error("expected active SSH placement");
      }
      await harness.environments.attachSession({
        environmentId,
        ownerEpoch: harness.ready.ownerEpoch,
        sessionId: REQUEST.sessionId,
      });
      const workspace = await harness.environments.startTunnel({
        environmentId,
        ownerEpoch: identity.ownerEpoch,
      });
      const reconcileWorkspace = vi.spyOn(workspace, "reconcileWorkspace");
      const tunnelManager = {
        status: () => "connected" as const,
        start: vi.fn(async () => workspace),
        stop: vi.fn(async () => {}),
        stopAll: vi.fn(async () => {}),
      } as unknown as WorkerTunnelManager;
      const destroy = vi.fn(async () => {
        expect(reconcileWorkspace).toHaveBeenCalledOnce();
      });
      const service = support.createService(support.createProvider({ destroy }), { tunnelManager });
      vi.mocked(harness.environments.get).mockImplementation(service.get);
      vi.mocked(harness.environments.startTunnel).mockImplementation(service.startTunnel);
      vi.mocked(harness.environments.stopTunnel).mockImplementation(service.stopTunnel);
      vi.mocked(harness.environments.destroy).mockImplementation(service.destroy);
      support.testState.nowMs = identity.credentialExpiresAtMs + 60_001;

      if (operation === "move") {
        await harness.service.move({
          ...REQUEST,
          source: {
            generation: active.generation,
            environmentId,
            ownerEpoch: identity.ownerEpoch,
          },
          target: { kind: "gateway" },
        });
      } else if (operation === "idle suspend") {
        support.getDevelopmentProfile().suspendAfter = "1m";
        const warn = vi.fn();
        await createWorkerPlacementIdleSweep({
          placements,
          environments: service,
          dispatch: harness.service,
          getConfig: () => support.testState.config,
          now: () => support.testState.nowMs,
          info: vi.fn(),
          warn,
        }).sweep();
        expect(warn).not.toHaveBeenCalled();
      } else {
        await harness.service.reclaim(REQUEST);
      }

      expect(destroy).toHaveBeenCalledOnce();
      expect(service.get(environmentId)?.state).toBe("destroyed");
      expect(placements.get(active.sessionId)).toMatchObject({
        state: operation === "move" ? "local" : "reclaimed",
        turnClaim: null,
      });
      expect(placements.listPendingWorkspaceResults()).toEqual([]);
    },
  );
});
