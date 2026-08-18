import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { NODE_RUNNER_UPDATE_REQUIRED_ISSUE } from "../../infra/node-runner-inventory.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { bindDeviceWorkerAvailability } from "./device-provider.js";
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

  it("provisions, syncs, and activates a local-install device environment", async () => {
    const harness = createHarness(placementStore);
    bindDeviceWorkerAvailability(harness.environments, async () => ({ available: true }));
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
        installKind: "bundle",
      },
      sharedHost: true,
      tunnelStatus: "stopped",
    });
    const request = {
      ...REQUEST,
      profileId: "device:device-1",
      deviceId: "device-1",
      inheritedProfile: {
        providerId: "device",
        profileSnapshot: { install: "bundle" as const, settings: { device: "device-1" } },
      },
    };

    await expect(harness.service.dispatch(request)).resolves.toMatchObject({
      state: "active",
      workerBundleHash: "a".repeat(64),
      remoteWorkspaceDir: "/worker/workspace",
    });

    expect(harness.environments.createFromProfileSnapshot).toHaveBeenCalledWith(
      { profileId: request.profileId, ...request.inheritedProfile },
      expect.stringMatching(/^session-dispatch:/u),
      undefined,
      REQUEST.executionMode,
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
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(harness.placements.current()).toMatchObject({ state: "active" });
  });

  it("records an unavailable device dispatch as a durable failed placement", async () => {
    const harness = createHarness(placementStore);
    bindDeviceWorkerAvailability(harness.environments, async () => ({
      available: false,
      issue: NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
    }));
    const states: string[] = [];
    const request = {
      ...REQUEST,
      profileId: "device:offline-device",
      deviceId: "offline-device",
      inheritedProfile: {
        providerId: "device",
        profileSnapshot: {
          install: "bundle" as const,
          settings: { device: "offline-device" },
        },
      },
    };

    await expect(
      harness.service.dispatch(request, (placement) => states.push(placement.state)),
    ).rejects.toThrow(
      "device worker node offline-device requires an update before it can host sessions; run openclaw update, then reconnect it (for a headless node, run openclaw node restart)",
    );

    expect(states).toEqual(["requested", "failed"]);
    expect(harness.environments.createFromProfileSnapshot).not.toHaveBeenCalled();
    expect(createWorkerSessionPlacementStore({ database }).get(REQUEST.sessionId)).toMatchObject({
      state: "failed",
      environmentId: null,
      recoveryError: expect.stringContaining("run openclaw update"),
      terminalReason: expect.stringContaining("run openclaw node restart"),
      terminalAtMs: 1_000,
    });
  });

  it("adopts an offline paired-device placement without eagerly starting its tunnel", async () => {
    const harness = createHarness(placementStore);
    await harness.environments.attachSession({
      environmentId: harness.ready.environmentId,
      ownerEpoch: harness.ready.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    harness.placements.seedActive(harness.attached.ownerEpoch);
    harness.markEnvironmentNodeDeviceId("offline-device");
    harness.log.length = 0;

    await harness.service.reconcile();

    expect(harness.log).toEqual(["environment:reconcile", "workspace", "placement:adopted"]);
    expect(harness.placements.current()).toMatchObject({ state: "active" });
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });
});
