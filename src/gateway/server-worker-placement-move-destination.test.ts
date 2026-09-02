import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../infra/node-runner-inventory.js";
import { createGatewayWorkerPlacementMoveDestinationResolver } from "./server-worker-placement-move-destination.js";
import { bindDeviceWorkerAvailability } from "./worker-environments/device-provider.js";
import { createWorkerPlacementMoveService } from "./worker-environments/placement-move-service.js";

const SESSION_KEY = "agent:main:move-source";
const CODEX_COMMAND = "codex.exec-server.stdio.v2";
const DEVICE_REQUIREMENT = { requiredNodeCommands: [CODEX_COMMAND], consumesWorkerSlot: false };

describe("worker placement move destination owner", () => {
  it.each([
    {
      name: "allows an explicitly enabled zero-slot paired-device runtime",
      target: { kind: "device" as const, deviceId: "paired-build-mac" },
      supported: true,
      expectedError: "source placement barrier started",
      barrierCalls: 1,
    },
    {
      name: "rejects an unsupported paired-device runtime before source mutation",
      target: { kind: "device" as const, deviceId: "paired-build-mac" },
      supported: false,
      expectedError: "runtime codex does not support paired-device placement",
      barrierCalls: 0,
    },
    {
      name: "rejects an incompatible profile before changing its exact active source",
      target: { kind: "profile" as const, profileId: "incompatible" },
      supported: false,
      expectedError: "worker profile incompatible does not support remote-exec placement",
      barrierCalls: 0,
    },
    {
      name: "carries runtime-owned node command requirements into a compatible cloud profile",
      target: { kind: "profile" as const, profileId: "compatible" },
      supported: true,
      expectedError: "source placement barrier started",
      barrierCalls: 1,
    },
  ])("$name", async ({ target, supported, expectedError, barrierCalls }) => {
    const source = Object.freeze({
      sessionId: "session-move-source",
      state: "active",
      generation: 4,
      environmentId: "environment-source",
      activeOwnerEpoch: 2,
      executionMode: "remote-exec",
    });
    const sourceBefore = JSON.stringify(source);
    const entry = { sessionId: source.sessionId, worktree: { id: "worktree-recovery" } };
    const config = {
      cloudWorkers: {
        profiles: {
          compatible: { provider: "multimode-cloud" },
          incompatible: { provider: "worker-only" },
        },
      },
      gateway: { nodes: { commands: { allow: [CODEX_COMMAND] } } },
    };
    const supportsExecutionMode = vi.fn((profileId: string) => profileId === "compatible");
    const environments = { supportsExecutionMode };
    bindDeviceWorkerAvailability(environments, async (deviceId) => ({
      available: true,
      node: {
        nodeId: deviceId,
        connId: `conn-${deviceId}`,
        pairingIdentity: `identity-${deviceId}`,
        pairingGeneration: `generation-${deviceId}`,
        clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
        clientMode: GATEWAY_CLIENT_MODES.NODE,
        protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
        workerHost: { enabled: true, capacity: { total: 2, available: 0 } },
        commands: [CODEX_COMMAND],
      },
    }));
    const resolveDestination = vi.fn(
      createGatewayWorkerPlacementMoveDestinationResolver({
        environments: environments as never,
        getConfig: () => config,
        loadSessionRuntime: async () =>
          ({
            managedWorktrees: {
              findLiveByOwner: () => ({
                id: "worktree-recovery",
                ownerId: SESSION_KEY,
                path: "/gateway/workspace",
              }),
            },
            resolveGatewaySessionStoreTargetWithStore: () => ({
              agentId: "main",
              canonicalKey: SESSION_KEY,
              storePath: "/gateway/session.sqlite",
              storeKeys: [SESSION_KEY],
              store: { [SESSION_KEY]: entry },
            }),
            resolveCanonicalSessionEntryFromStoreKeys: () => entry,
            resolveWorkerPlacementSessionRuntime: () => "codex",
            resolveWorkerPlacementCapabilities: () => ({
              executionMode: "remote-exec",
              ...(supported ? { devicePlacement: DEVICE_REQUIREMENT } : {}),
            }),
          }) as never,
      }),
    );
    const runMoveBarrier = vi.fn(async () => {
      throw new Error("source placement barrier started");
    });
    const reclaimSource = vi.fn();
    const dispatch = vi.fn();
    const beginPlacementMove = vi.fn();
    const destroy = vi.fn();
    const moves = createWorkerPlacementMoveService({
      placements: {
        get: () => source,
        getPlacementMove: () => undefined,
        beginPlacementMove,
      } as never,
      environments: { get: () => undefined, destroy } as never,
      runMoveBarrier,
      dispatch,
      reclaimSource,
      validateAbandonSource: vi.fn(),
      abandonSource: vi.fn(),
      resolveDestination,
    });

    await expect(
      moves.move({
        sessionId: source.sessionId,
        sessionKey: SESSION_KEY,
        agentId: "main",
        source: {
          generation: source.generation,
          environmentId: source.environmentId,
          ownerEpoch: source.activeOwnerEpoch,
        },
        target,
      }),
    ).rejects.toThrow(expectedError);

    expect(runMoveBarrier).toHaveBeenCalledTimes(barrierCalls);
    expect(beginPlacementMove).not.toHaveBeenCalled();
    expect(reclaimSource).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(JSON.stringify(source)).toBe(sourceBefore);
    if (supported) {
      await expect(resolveDestination.mock.results[0]?.value).resolves.toMatchObject({
        executionMode: "remote-exec",
        devicePlacement: DEVICE_REQUIREMENT,
      });
    }
    if (target.kind === "profile") {
      expect(supportsExecutionMode).toHaveBeenCalledWith(target.profileId, "remote-exec");
    }
  });
});
