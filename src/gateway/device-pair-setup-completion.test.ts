import { afterEach, describe, expect, it, vi } from "vitest";
import { readDevicePairSetupCompletion } from "../infra/device-bootstrap.js";
import {
  persistDeviceBootstrapTokenRecords,
  persistDevicePairingStoreState,
} from "../infra/device-pairing-store.js";
import type { PairedDevice } from "../infra/device-pairing.types.js";
import {
  FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
} from "../shared/device-bootstrap-profile.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  broadcastSetupHandoffCompletion,
  confirmSetupHandoffDelivery,
  consumeSetupHandoff,
} from "./device-pair-setup-completion.js";
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
    persistDeviceBootstrapTokenRecords(
      {
        "bootstrap-secret": {
          token: "bootstrap-secret",
          setupId: "setup-exact",
          ts: Date.now(),
          deviceId: paired.deviceId,
          profile,
          issuedAtMs: Date.now(),
        },
      },
      baseDir,
    );
    const broadcast = vi.fn();

    const handoff = await consumeSetupHandoff({
      token: "bootstrap-secret",
      deviceId: paired.deviceId,
      baseDir,
      ts: 3,
    });
    expect(handoff).not.toBeNull();
    const confirmed = await confirmSetupHandoffDelivery({ handoff: handoff!, baseDir });
    expect(confirmed).not.toBeNull();
    broadcastSetupHandoffCompletion({ handoff: confirmed!, broadcast });
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

    persistDeviceBootstrapTokenRecords(
      {
        "bootstrap-secret": {
          token: "bootstrap-secret",
          setupId: "setup-dropped",
          ts: Date.now(),
          deviceId: "device-123",
          profile: FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
          issuedAtMs: Date.now(),
        },
      },
      baseDir,
    );
    const handoff = await consumeSetupHandoff({
      token: "bootstrap-secret",
      deviceId: "device-123",
      baseDir,
      ts: 3,
    });
    expect(handoff).not.toBeNull();
    const confirmed = await confirmSetupHandoffDelivery({ handoff: handoff!, baseDir });
    expect(confirmed).not.toBeNull();
    broadcastSetupHandoffCompletion({ handoff: confirmed!, broadcast });

    expect(slowSocket.send).not.toHaveBeenCalled();
    expect(slowSocket.close).not.toHaveBeenCalled();
    await expect(
      readDevicePairSetupCompletion({ baseDir, setupId: "setup-dropped" }),
    ).resolves.toMatchObject({
      setupId: "setup-dropped",
      deviceId: "device-123",
      access: "full",
      completedAtMs: 3,
      deliveryState: "confirmed",
    });
  });

  it("ignores generic bootstrap records without setup correlation", async () => {
    const baseDir = await tempDirs.make("openclaw-setup-completion-generic-");
    persistDeviceBootstrapTokenRecords(
      {
        generic: {
          token: "generic",
          ts: Date.now(),
          deviceId: "device-123",
          issuedAtMs: Date.now(),
        },
      },
      baseDir,
    );
    const broadcast = vi.fn();
    const handoff = await consumeSetupHandoff({
      token: "generic",
      deviceId: "device-123",
      baseDir,
    });
    expect(handoff).toMatchObject({ record: { token: "generic" } });
    broadcastSetupHandoffCompletion({ handoff: handoff!, broadcast });
    expect(broadcast).not.toHaveBeenCalled();
  });
});
