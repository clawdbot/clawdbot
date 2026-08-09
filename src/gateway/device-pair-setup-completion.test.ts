import { afterEach, describe, expect, it, vi } from "vitest";
import { readDevicePairSetupCompletion } from "../infra/device-bootstrap.js";
import { persistDevicePairingStoreState } from "../infra/device-pairing-store.js";
import type { DeviceBootstrapTokenRecord, PairedDevice } from "../infra/device-pairing.types.js";
import {
  FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
} from "../shared/device-bootstrap-profile.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { settleSetupCompletion } from "./device-pair-setup-completion.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

describe("device pair setup completion", () => {
  it.each([
    ["full", FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE],
    ["limited", PAIRING_SETUP_BOOTSTRAP_PROFILE],
    ["node", NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE],
  ] as const)("broadcasts authoritative %s completion metadata", async (access, profile) => {
    const baseDir = await tempDirs.make(`openclaw-setup-completion-${access}-`);
    const paired: PairedDevice = {
      deviceId: "device-123",
      publicKey: "public-key-123",
      displayName: "Client name",
      operatorLabel: "Operator name",
      createdAtMs: 1,
      approvedAtMs: 2,
    };
    persistDevicePairingStoreState(
      { pendingById: {}, pairedByDeviceId: { [paired.deviceId]: paired } },
      baseDir,
      "paired",
    );
    const record: DeviceBootstrapTokenRecord = {
      token: "bootstrap-secret",
      setupId: "setup-exact",
      ts: 1,
      profile,
      issuedAtMs: 1,
    };
    const broadcast = vi.fn();

    await expect(
      settleSetupCompletion({
        record,
        deviceId: paired.deviceId,
        broadcast,
        baseDir,
        ts: 3,
      }),
    ).resolves.toBeUndefined();
    expect(broadcast).toHaveBeenCalledWith(
      "device.pair.setup.completed",
      {
        setupId: "setup-exact",
        deviceId: paired.deviceId,
        deviceName: "Operator name",
        access,
        ts: 3,
      },
      { dropIfSlow: true },
    );
    expect(JSON.stringify(broadcast.mock.calls)).not.toContain("bootstrap-secret");
  });

  // The regression this whole recovery path exists for: a buffered operator
  // socket silently loses the only success frame, so the recorded completion
  // has to survive it or the operator sees expiry after a successful pairing.
  it("keeps the completion recoverable when a slow subscriber drops the frame", async () => {
    const baseDir = await tempDirs.make("openclaw-setup-completion-slow-");
    const slowSocket = {
      bufferedAmount: MAX_BUFFERED_BYTES + 1,
      send: vi.fn(),
      close: vi.fn(),
    };
    const clients = new Set<GatewayWsClient>([
      {
        socket: slowSocket as unknown as GatewayWsClient["socket"],
        connect: { role: "operator", scopes: ["operator.pairing"] } as GatewayWsClient["connect"],
        connId: "c-pairing-slow",
        usesSharedGatewayAuth: false,
      },
    ]);
    const { broadcast } = createGatewayBroadcaster({ clients });

    await settleSetupCompletion({
      record: {
        token: "bootstrap-secret",
        setupId: "setup-dropped",
        ts: 1,
        profile: FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
        issuedAtMs: 1,
      },
      deviceId: "device-123",
      broadcast,
      baseDir,
      ts: 3,
    });

    expect(slowSocket.send).not.toHaveBeenCalled();
    expect(slowSocket.close).not.toHaveBeenCalled();
    await expect(
      readDevicePairSetupCompletion({ baseDir, setupId: "setup-dropped" }),
    ).resolves.toMatchObject({
      setupId: "setup-dropped",
      deviceId: "device-123",
      access: "full",
      completedAtMs: 3,
    });
  });

  it("records the completion even when the broadcast itself fails", async () => {
    const baseDir = await tempDirs.make("openclaw-setup-completion-broadcast-fail-");
    const broadcast = vi.fn(() => {
      throw new Error("socket fanout failed");
    });

    await expect(
      settleSetupCompletion({
        record: {
          token: "bootstrap-secret",
          setupId: "setup-broadcast-fail",
          ts: 1,
          profile: PAIRING_SETUP_BOOTSTRAP_PROFILE,
          issuedAtMs: 1,
        },
        deviceId: "device-123",
        broadcast,
        baseDir,
        ts: 4,
      }),
    ).rejects.toThrow("socket fanout failed");
    await expect(
      readDevicePairSetupCompletion({ baseDir, setupId: "setup-broadcast-fail" }),
    ).resolves.toMatchObject({ setupId: "setup-broadcast-fail", access: "limited" });
  });

  it("ignores generic bootstrap records without setup correlation", async () => {
    const broadcast = vi.fn();
    await expect(
      settleSetupCompletion({
        record: { token: "generic", ts: 1, issuedAtMs: 1 },
        deviceId: "device-123",
        broadcast,
      }),
    ).resolves.toBeUndefined();
    expect(broadcast).not.toHaveBeenCalled();
  });
});
