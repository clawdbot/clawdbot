import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
} from "../../infra/node-commands.js";
import { NODE_WORKSPACE_DRAIN_COMMAND } from "../../worker/node-workspace-protocol.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import * as nodeSupport from "./node-worker-tunnel.test-support.js";
import { REQUEST, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { FORCED_WORKER_ABANDONMENT_ERROR } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";

describe("offline device abandonment with retained physical cleanup", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each(
    (
      [
        "complete",
        "held",
        "failed",
        "restarted",
        "replacement-restarted",
        "authorization-closed",
        "retired-siblings",
        "retired-mixed",
      ] as const
    ).flatMap((cleanup) => [true, null].map((sharedHost) => ({ cleanup, sharedHost }))),
  )(
    "fences the old claim and retains exact cleanup ownership with $cleanup sibling cleanup and sharedHost=$sharedHost",
    async ({ cleanup, sharedHost }) => {
      let placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const harness = createHarness(placements, { workspacePath: support.testState.root });
      const environmentId = harness.ready.environmentId;
      const deviceId = "paired-device";
      const build = {
        ...support.BOOTSTRAP_RECEIPT,
        protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
      };
      support.testState.prepareInstallation = async () => ({
        ...support.BUNDLE_ARTIFACT,
        ...build,
      });
      function seedDevice(id: string, isolation: boolean | null = true) {
        support.testState.store.createIntent({
          environmentId: id,
          providerId: "device",
          profileId: `device:${deviceId}`,
          profileSnapshot: { settings: { device: deviceId }, executionMode: "worker-turn" },
          provisionOperationId: `provision:${id}`,
        });
        support.testState.store.transition({
          environmentId: id,
          from: "requested",
          to: "provisioning",
        });
        support.testState.store.transition({
          environmentId: id,
          from: "provisioning",
          to: "ready",
          patch: {
            ...support.readyPatch(id, { ...build, installKind: "bundle" }),
            leaseId: `lease:${id}`,
            nodeDeviceId: deviceId,
            ...(isolation === null ? {} : { sharedHost: isolation }),
          },
        });
      }
      seedDevice(environmentId, sharedHost);
      const attached = support.testState.store.transition({
        environmentId,
        from: "ready",
        to: "attached",
        patch: support.attachedPatch(environmentId, REQUEST.sessionId),
      });
      expect(attached.sharedHost).toBe(sharedHost);
      const active = harness.placements.seedActive(attached.ownerEpoch);
      if (active.state !== "active") {
        throw new Error("expected active placement");
      }
      const claim = placements.claimTurn({
        ...REQUEST,
        claimId: "abandoned-claim",
        runId: "abandoned-run",
        owner: { kind: "worker", environmentId, ownerEpoch: attached.ownerEpoch },
      });
      placements.authorizeWorkerTurnTools(claim, ["sessions_send"]);
      const replacementId = "worker-replacement";
      seedDevice(replacementId);
      const attachReplacement = () =>
        support.testState.store.transition({
          environmentId: replacementId,
          from: "ready",
          to: "attached",
          patch: support.attachedPatch(replacementId, active.sessionId),
        });
      expect(attachReplacement).toThrow("already attached");
      const transport = nodeSupport.transport();
      const connectedNodes = await transport.listCurrentNodes();
      connectedNodes[0]!.nodeId = deviceId;
      const listNodes = vi.fn<typeof transport.listCurrentNodes>(async () => connectedNodes);
      transport.listCurrentNodes = listNodes;
      const invoke = vi.fn(transport.invoke.bind(transport));
      transport.invoke = invoke;
      const transfer = { ...nodeSupport.workspaceTransfer(), closeAll: vi.fn(async () => {}) };
      const createTunnels = () =>
        createNodeWorkerTunnelManager({
          gatewayDeviceId: "gateway-fixture",
          getEnvironment: (id) => support.testState.store.get(id),
          listEnvironments: () => support.testState.store.list(),
          getTransport: () => transport,
          launchNodeWorker: vi.fn(),
          validateWorkerTurn: (candidate) => placements.validateTurnClaim(candidate),
          workspaceTransfer: transfer,
        });
      let tunnels = createTunnels();
      const destroy = vi.fn(async () => {});
      const cleanupStarted = createDeferred();
      const releaseCleanup = createDeferred();
      const cleanupFailure = new Error("desktop carrier cleanup failed");
      const stopDesktop = vi.fn(async () => {
        cleanupStarted.resolve();
        if (cleanup !== "complete") {
          await releaseCleanup.promise;
        }
        if (cleanup === "failed") {
          throw cleanupFailure;
        }
      });
      const createService = () =>
        support.createService(
          support.createProvider({
            id: "device",
            supportedExecutionModes: ["worker-turn"],
            inspect: async () => ({ status: "active", sharedHost: true }),
            destroy,
          }),
          {
            nodeTunnelManager: tunnels,
            nodeDesktopCarrier: {
              bindRuntime: vi.fn(),
              launchApp: vi.fn(),
              observe: vi.fn(),
              stop: stopDesktop,
              stopAll: vi.fn(async () => {}),
            },
            placementStore: createWorkerSessionPlacementGate(placements),
          },
        );
      let service = createService();
      const restartDisconnectedService = async () => {
        await expect(service.stop()).rejects.toThrow("not connected");
        support.testState.service = undefined;
        await support.reopenWorkerEnvironmentStore();
        placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
        tunnels = createTunnels();
        service = createService();
      };
      vi.mocked(harness.environments.get).mockImplementation(service.get);
      vi.mocked(harness.environments.destroy).mockImplementation(service.destroy);
      vi.mocked(harness.environments.stopTunnel).mockImplementation(service.stopTunnel);
      await tunnels.start({
        environmentId,
        ownerEpoch: attached.ownerEpoch,
        deviceId,
        sessionId: active.sessionId,
        executionMode: "worker-turn",
        expectedBuild: build,
      });
      listNodes.mockResolvedValue([]);

      try {
        const multipleRetired = cleanup === "retired-siblings" || cleanup === "retired-mixed";
        if (multipleRetired) {
          await expect(tunnels.stop(environmentId, attached.ownerEpoch)).rejects.toThrow(
            "not connected",
          );
          await expect(
            tunnels.start({
              environmentId,
              ownerEpoch: attached.ownerEpoch,
              deviceId,
              sessionId: active.sessionId,
              executionMode: "worker-turn",
              expectedBuild: build,
            }),
          ).rejects.toThrow("not connected");
          // Join the failed replacement's own retirement before testing another stop.
          await expect(tunnels.stop(environmentId, attached.ownerEpoch)).rejects.toThrow();
          if (cleanup === "retired-mixed") {
            vi.mocked(transfer.close).mockRejectedValueOnce(cleanupFailure);
          }
        }
        const credential = support.testState.store.getCredential(environmentId);
        for (const binding of [
          { environmentId, ownerEpoch: attached.ownerEpoch, sessionId: "different-session" },
          { environmentId, ownerEpoch: attached.ownerEpoch + 1, sessionId: active.sessionId },
        ]) {
          await expect(service.destroy(binding.environmentId, binding)).rejects.toThrow(
            "owner changed before retirement",
          );
        }
        expect(support.testState.store.getCredential(environmentId)).toEqual(credential);
        expect(support.testState.store.get(environmentId)?.destroyRequestedAtMs).toBeNull();
        expect(placements.validateTurnClaim(claim)).toBe(true);
        let settled = false;
        let authorized = true;
        const moving = harness.service
          .move(
            {
              ...REQUEST,
              source: {
                generation: active.generation,
                environmentId,
                ownerEpoch: attached.ownerEpoch,
              },
              target: { kind: "gateway" },
              abandonSource: true,
            },
            undefined,
            () => {
              if (!authorized) {
                throw new Error("session access revoked during cleanup");
              }
            },
          )
          .catch((error: unknown) => error)
          .finally(() => {
            settled = true;
          });
        await Promise.race([cleanupStarted.promise, moving]);
        if (cleanup !== "complete") {
          await setImmediate();
          expect.soft(settled).toBe(false);
        }
        authorized = cleanup !== "authorization-closed";
        releaseCleanup.resolve();
        const outcome = await moving;

        if (cleanup === "authorization-closed") {
          expect(outcome).toMatchObject({ message: "session access revoked during cleanup" });
          expect(placements.get(active.sessionId)?.state).toBe("failed");
        } else if (cleanup === "failed" || cleanup === "retired-mixed") {
          const errors = outcome instanceof AggregateError ? outcome.errors : [outcome];
          expect.soft(errors).toContain(cleanupFailure);
          expect(placements.get(active.sessionId)?.state).toBe("failed");
        } else {
          expect.soft(outcome).toMatchObject({ state: "local", turnClaim: null });
        }
        expect(placements.validateTurnClaim(claim)).toBe(false);
        expect(placements.isWorkerTurnToolAuthorized(claim, "sessions_send")).toBe(false);
        expect(placements.validateWorkspaceResultClaim(claim)).toBe(false);
        expect(support.testState.store.getCredential(environmentId)).toBeUndefined();
        await expect(service.acquireTurnCredential(claim)).rejects.toThrow(
          "claim is not authoritative",
        );
        expect(tunnels.status(environmentId)).toBe("stopped");
        expect(support.testState.store.get(environmentId)).toMatchObject({
          state: "attached",
          destroyRequestedAtMs: support.testState.nowMs,
          ownerEpoch: attached.ownerEpoch,
          attachedSessionIds: [active.sessionId],
          nodeDeviceId: deviceId,
          sharedHost,
        });
        expect(invoke).not.toHaveBeenCalled();
        expect(destroy).not.toHaveBeenCalled();

        stopDesktop.mockResolvedValue(undefined);
        if (cleanup === "restarted") {
          await restartDisconnectedService();
        }
        if (cleanup !== "replacement-restarted") {
          listNodes.mockResolvedValue(connectedNodes);
        }
        const replacement =
          cleanup === "failed" || cleanup === "retired-mixed" || cleanup === "authorization-closed"
            ? undefined
            : attachReplacement();
        let replacementClaim;
        if (replacement) {
          expect(replacement.ownerEpoch).toBeGreaterThan(attached.ownerEpoch);
          seedActivePlacement(placements, {
            environmentId: replacementId,
            ownerEpoch: replacement.ownerEpoch,
          });
          if (cleanup === "replacement-restarted") {
            // Reopen both owners together, then admit a fresh replacement turn below.
            await restartDisconnectedService();
            listNodes.mockResolvedValue(connectedNodes);
          }
          replacementClaim = placements.claimTurn({
            ...REQUEST,
            claimId: "replacement-claim",
            runId: "replacement-run",
            owner: {
              kind: "worker",
              environmentId: replacementId,
              ownerEpoch: replacement.ownerEpoch,
            },
          });
          placements.authorizeWorkerTurnTools(replacementClaim, ["sessions_send"]);
          const grant = await service.acquireTurnCredential(replacementClaim);
          expect(service.acknowledgeCredentialDelivery(grant)).toBe(true);
          await tunnels.start({
            environmentId: replacementId,
            ownerEpoch: replacement.ownerEpoch,
            deviceId,
            sessionId: active.sessionId,
            executionMode: "worker-turn",
            expectedBuild: build,
          });
        }
        const replacementCredential = support.testState.store.getCredential(replacementId);
        await service.reconcileOnce();
        const stopRequests = invoke.mock.calls
          .map(([request]) => request)
          .filter((request) => request.command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND);
        const drainRequests = invoke.mock.calls
          .map(([request]) => request)
          .filter((request) => request.command === NODE_WORKER_WORKSPACE_EXEC_COMMAND);
        expect(stopRequests).toHaveLength(multipleRetired ? 2 : 1);
        expect(drainRequests).toHaveLength(stopRequests.length);
        expect(invoke).toHaveBeenCalledTimes(stopRequests.length + drainRequests.length);
        for (const request of stopRequests) {
          expect(request).toMatchObject({
            command: NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
            params: {
              environmentId,
              sessionId: active.sessionId,
              ownerEpoch: attached.ownerEpoch,
            },
          });
        }
        for (const request of drainRequests) {
          expect(request.params).toMatchObject({
            environmentId,
            sessionId: active.sessionId,
            generation: attached.ownerEpoch,
            argv: [NODE_WORKSPACE_DRAIN_COMMAND],
          });
        }
        expect(service.get(environmentId)).toMatchObject({
          state: "failed",
          leaseId: null,
          nodeDeviceId: null,
          attachedSessionIds: [],
          lastError: FORCED_WORKER_ABANDONMENT_ERROR,
        });
        expect(destroy).toHaveBeenCalledOnce();
        if (replacement && replacementClaim) {
          expect(support.testState.store.get(replacementId)).toMatchObject({
            state: "attached",
            ownerEpoch: replacement.ownerEpoch,
            attachedSessionIds: [active.sessionId],
            destroyRequestedAtMs: null,
          });
          expect(support.testState.store.getCredential(replacementId)).toEqual(
            replacementCredential,
          );
          expect(tunnels.status(replacementId)).toBe("connected");
          expect(placements.validateTurnClaim(replacementClaim)).toBe(true);
          expect(placements.isWorkerTurnToolAuthorized(replacementClaim, "sessions_send")).toBe(
            true,
          );
          expect(placements.validateTurnClaim(claim)).toBe(false);
          expect(placements.isWorkerTurnToolAuthorized(claim, "sessions_send")).toBe(false);
          expect(placements.validateWorkspaceResultClaim(claim)).toBe(false);
        }
      } finally {
        releaseCleanup.resolve();
        stopDesktop.mockResolvedValue(undefined);
        listNodes.mockResolvedValue(connectedNodes);
        await service.destroy(environmentId);
        await service.destroy(replacementId);
      }
    },
  );
});
