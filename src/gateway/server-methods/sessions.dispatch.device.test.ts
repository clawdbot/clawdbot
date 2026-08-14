import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { bindDeviceWorkerAvailability } from "../worker-environments/device-provider.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import type { WorkerEnvironmentServiceContract } from "../worker-environments/service-contract.js";
import {
  dispatchTestSessionId,
  dispatchTestSessionKey,
  getDispatchTestMocks,
  invokeSessionDispatch,
  makeDispatchTestContext,
  makeSessionTarget,
} from "./sessions-dispatch.test-support.js";

const dispatchTestMocks = getDispatchTestMocks();

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
    const workerEnvironmentService = {} as WorkerEnvironmentServiceContract;
    bindDeviceWorkerAvailability(workerEnvironmentService, async () => true);
    const respond = await invokeSessionDispatch(
      makeDispatchTestContext({
        workerEnvironmentService,
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

  it("rejects a device target without a connected session-capable pairing", async () => {
    const dispatch = vi.fn();
    const workerEnvironmentService = {} as WorkerEnvironmentServiceContract;
    bindDeviceWorkerAvailability(workerEnvironmentService, async () => false);
    const respond = await invokeSessionDispatch(
      makeDispatchTestContext({
        workerEnvironmentService,
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
      }),
      { deviceId: "device-1" },
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
        message: expect.stringContaining("reconnect or reprovision"),
      }),
    );
  });
});
