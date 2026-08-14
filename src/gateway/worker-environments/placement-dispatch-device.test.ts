import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { REQUEST, type PlacementStore } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("device worker placement dispatch", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let placementStore: PlacementStore;

  beforeEach(() => {
    root = tempDirs.make("openclaw-device-dispatch-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placementStore = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("provisions the environment and surfaces the honest transport gate", async () => {
    const harness = createHarness(placementStore);
    const transportError = Object.assign(
      new Error("device-runner-transport-unimplemented: launch is pending"),
      { code: "device-runner-transport-unimplemented" },
    );
    vi.mocked(harness.environments.createFromProfileSnapshot).mockResolvedValue({
      ...harness.ready,
      providerId: "device",
      profileId: "device:device-1",
      profileSnapshot: { install: "bundle", settings: { device: "device-1" } },
      leaseId: "device-lease-1",
      sshEndpoint: null,
      bootstrapReceipt: {
        bundleHash: "a".repeat(64),
        openclawVersion: "2026.8.12",
        protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
        installKind: "local",
      },
      sharedHost: true,
      tunnelStatus: "stopped",
    });
    vi.mocked(harness.environments.startTunnel).mockRejectedValue(transportError);
    const request = {
      ...REQUEST,
      profileId: "device:device-1",
      deviceId: "device-1",
      inheritedProfile: {
        providerId: "device",
        profileSnapshot: { install: "bundle" as const, settings: { device: "device-1" } },
      },
    };

    await expect(harness.service.dispatch(request)).rejects.toMatchObject({
      code: "device-runner-transport-unimplemented",
    });

    expect(harness.environments.createFromProfileSnapshot).toHaveBeenCalledWith(
      { profileId: request.profileId, ...request.inheritedProfile },
      expect.stringMatching(/^session-dispatch:/u),
    );
    expect(harness.environments.startTunnel).toHaveBeenCalledWith({
      environmentId: harness.ready.environmentId,
      ownerEpoch: expect.any(Number),
    });
    expect(harness.environments.attachSession).toHaveBeenCalledWith({
      environmentId: harness.ready.environmentId,
      ownerEpoch: harness.ready.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    expect(harness.environments.destroy).toHaveBeenCalledWith(harness.ready.environmentId);
    expect(harness.placements.current()).toMatchObject({
      state: "failed",
      recoveryError: expect.stringContaining("device-runner-transport-unimplemented"),
    });
  });
});
