import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { PairedDevice } from "../../infra/device-pairing.types.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import {
  bindDeviceWorkerAvailability,
  createDeviceWorkerRuntime,
} from "../worker-environments/device-provider.js";
import { createHarness } from "../worker-environments/placement-dispatch-test-harness.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import {
  dispatchTestSessionId,
  dispatchTestSessionKey,
  getDispatchTestMocks,
  invokeSessionDispatch,
  makeDispatchTestContext,
  makeSessionTarget,
} from "./sessions-dispatch.test-support.js";

const dispatchTestMocks = getDispatchTestMocks();

function pairedNode(deviceId: string): PairedDevice {
  return {
    deviceId,
    publicKey: `public-key-${deviceId}`,
    role: "node",
    roles: ["node"],
    tokens: {
      node: {
        token: "fixture-token",
        role: "node",
        scopes: [],
        createdAtMs: 1,
      },
    },
    createdAtMs: 1,
    approvedAtMs: 1,
  };
}

function connectedNode(deviceId: string, available: number) {
  return {
    nodeId: deviceId,
    connId: `conn-${deviceId}`,
    pairingIdentity: `identity-${deviceId}`,
    pairingGeneration: `generation-${deviceId}`,
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    workerHost: { enabled: true, capacity: { total: 2, available } },
    commands: ["system.run"],
  } satisfies NodeWorkerSupervisorNodeProof;
}

describe("sessions.dispatch device targets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchTestMocks.resolveTarget.mockReturnValue(makeSessionTarget());
  });

  it("synthesizes the core device-provider target for a connected session-capable node", async () => {
    dispatchTestMocks.resolveTarget.mockReturnValue(
      makeSessionTarget({
        sessionId: dispatchTestSessionId,
        worktree: { id: "worktree-1", branch: "openclaw/device-test", repoRoot: "/repo" },
      }),
    );
    dispatchTestMocks.findLiveByOwner.mockReturnValue({
      id: "worktree-1",
      ownerKind: "session",
      ownerId: dispatchTestSessionKey,
    });
    const dispatch = vi.fn().mockResolvedValue({
      sessionId: dispatchTestSessionId,
      agentId: "main",
      sessionKey: dispatchTestSessionKey,
      executionMode: "worker-turn",
      state: "active",
      environmentId: "device-environment-1",
      generation: 1,
      activeOwnerEpoch: 2,
      workspaceBaseManifestRef: `sha256:${"a".repeat(64)}`,
      remoteWorkspaceDir: "/node/workspace",
      workerBundleHash: "b".repeat(64),
      lastTranscriptAckCursor: null,
      lastLiveEventAckCursor: null,
      recoveryError: null,
      terminalReason: null,
      terminalAtMs: null,
      turnClaim: null,
      createdAtMs: 1,
      updatedAtMs: 2,
      stateChangedAtMs: 2,
    } satisfies WorkerSessionPlacementRecord);
    const respond = await invokeSessionDispatch(
      makeDispatchTestContext({
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
      { deviceId: "device-1" },
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "device:device-1",
        deviceId: "device-1",
        inheritedProfile: {
          providerId: "device",
          profileSnapshot: { install: "bundle", settings: { device: "device-1" } },
        },
      }),
      expect.any(Function),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        placement: expect.objectContaining({ state: "active" }),
      }),
      undefined,
    );
  });

  it("returns a device dispatch failure to the operator", async () => {
    dispatchTestMocks.resolveTarget.mockReturnValue(
      makeSessionTarget({
        sessionId: dispatchTestSessionId,
        worktree: { id: "worktree-1", branch: "openclaw/device-test", repoRoot: "/repo" },
      }),
    );
    dispatchTestMocks.findLiveByOwner.mockReturnValue({
      id: "worktree-1",
      ownerKind: "session",
      ownerId: dispatchTestSessionKey,
    });
    const dispatch = vi
      .fn()
      .mockRejectedValue(
        new Error("device worker node is not connected: device-1; reconnect it before retrying"),
      );
    const respond = await invokeSessionDispatch(
      makeDispatchTestContext({
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
      { deviceId: "device-1" },
    );

    expect(dispatch).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
        message: expect.stringContaining("reconnect"),
      }),
    );
  });

  it.each([
    {
      name: "full",
      nodes: [connectedNode("device-1", 0)],
      expectedMessage: "at capacity (all worker slots in use)",
      rejectedMessage: "reconnect",
    },
    {
      name: "disconnected",
      nodes: [],
      expectedMessage: "reconnect",
      rejectedMessage: "at capacity",
    },
  ])(
    "carries a $name node rejection through the placement row and operator response",
    async ({ nodes, expectedMessage, rejectedMessage }) => {
      const root = await fs.mkdtemp(
        path.join(await fs.realpath(os.tmpdir()), "openclaw-session-dispatch-device-"),
      );
      try {
        const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
        const placements = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
        const harness = createHarness(placements);
        const runtime = createDeviceWorkerRuntime({
          getPairedDevice: async (deviceId) => pairedNode(deviceId),
        });
        runtime.bindNodeTransport({
          listCurrentNodes: async () => nodes,
          isCurrent: () => true,
          invoke: async () => ({ ok: false }),
        });
        bindDeviceWorkerAvailability(harness.environments, runtime.resolveAvailability);

        dispatchTestMocks.resolveTarget.mockReturnValue(
          makeSessionTarget({
            sessionId: dispatchTestSessionId,
            worktree: { id: "worktree-1", branch: "openclaw/device-test", repoRoot: "/repo" },
          }),
        );
        dispatchTestMocks.findLiveByOwner.mockReturnValue({
          id: "worktree-1",
          ownerKind: "session",
          ownerId: dispatchTestSessionKey,
        });
        const respond = await invokeSessionDispatch(
          makeDispatchTestContext({
            workerPlacementDispatchService: harness.service,
            workerSessionPlacementService: placements,
          }),
          { deviceId: "device-1" },
        );

        const placement = placements.get(dispatchTestSessionId);
        expect(placement).toMatchObject({
          state: "failed",
          recoveryError: expect.stringContaining(expectedMessage),
          terminalReason: expect.stringContaining(expectedMessage),
        });
        expect(placement?.recoveryError).not.toContain(rejectedMessage);
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: ErrorCodes.UNAVAILABLE,
            message: expect.stringContaining(expectedMessage),
          }),
        );
        expect(respond).not.toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ message: expect.stringContaining(rejectedMessage) }),
        );
      } finally {
        closeOpenClawStateDatabaseForTest();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
