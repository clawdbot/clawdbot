// Covers paired device churn and token role behavior.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  approveDevicePairing,
  getPairedDevice,
  listDevicePairing,
  requestDevicePairing,
  type PairedDevice,
} from "./device-pairing.js";

const DEVICE_ID = "device-cli";
const PUBLIC_KEY = "public-key-cli";
const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-device-pairing-churn-" });

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}

function expectScopesToContain(scopes: string[] | undefined, expected: readonly string[]) {
  expect(scopes).toEqual(expect.arrayContaining([...expected]));
}

function readOperatorTokenScopes(device: PairedDevice | null): string[] {
  return requireValue(device, "expected paired device").tokens?.operator?.scopes ?? [];
}

async function makeDevicePairingDir(): Promise<string> {
  return await suiteRootTracker.make("case");
}

async function approveInitialPairing(baseDir: string, scopes: string[]) {
  const request = await requestDevicePairing(
    {
      deviceId: DEVICE_ID,
      publicKey: PUBLIC_KEY,
      role: "operator",
      scopes,
    },
    baseDir,
  );
  await approveDevicePairing(request.request.requestId, { callerScopes: scopes }, baseDir);
  return request;
}

describe("device pairing requestId churn", () => {
  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  test("supersedes a stale read repair request when a devices-first flow reconnects to approve the repair", async () => {
    const baseDir = await makeDevicePairingDir();

    await approveInitialPairing(baseDir, ["operator.pairing"]);

    const pairedAfterDevices = await getPairedDevice(DEVICE_ID, baseDir);
    expect(pairedAfterDevices?.approvedScopes).toEqual(["operator.pairing"]);
    expect(readOperatorTokenScopes(pairedAfterDevices)).toEqual(["operator.pairing"]);

    const readRepair = await requestDevicePairing(
      {
        deviceId: DEVICE_ID,
        publicKey: PUBLIC_KEY,
        role: "operator",
        scopes: ["operator.read"],
      },
      baseDir,
    );
    expect(readRepair.request.isRepair).toBe(true);
    expect(readRepair.request.scopes).toEqual(["operator.read"]);
    expect((await listDevicePairing(baseDir)).pending).toHaveLength(1);

    // `openclaw devices approve <requestId>` reconnects with the caller scopes
    // needed by the gateway. That reconnect supersedes the earlier repair request.
    const approveReconnect = await requestDevicePairing(
      {
        deviceId: DEVICE_ID,
        publicKey: PUBLIC_KEY,
        role: "operator",
        scopes: ["operator.pairing", "operator.read"],
      },
      baseDir,
    );

    expect(approveReconnect.created).toBe(true);
    expect(approveReconnect.request.requestId).not.toBe(readRepair.request.requestId);
    expect(approveReconnect.superseded).toEqual([
      { requestId: readRepair.request.requestId, deviceId: DEVICE_ID },
    ]);

    const staleApprove = await approveDevicePairing(
      readRepair.request.requestId,
      { callerScopes: ["operator.pairing", "operator.read"] },
      baseDir,
    );
    expect(staleApprove).toBeNull();

    const pairedAfterStaleApprove = await getPairedDevice(DEVICE_ID, baseDir);
    expect(pairedAfterStaleApprove?.approvedScopes).toEqual(["operator.pairing"]);
    expect(readOperatorTokenScopes(pairedAfterStaleApprove)).toEqual(["operator.pairing"]);
    expect(pairedAfterStaleApprove?.publicKey).toBe(PUBLIC_KEY);

    const pairingList = await listDevicePairing(baseDir);
    expect(pairingList.pending).toHaveLength(1);
    const pending = requireValue(pairingList.pending[0], "expected replacement pending request");
    expect(pending.requestId).toBe(approveReconnect.request.requestId);
    expect(pending.deviceId).toBe(DEVICE_ID);
    expect(pending.publicKey).toBe(PUBLIC_KEY);
    expect(pending.role).toBe("operator");
    expectScopesToContain(pending.scopes, ["operator.pairing", "operator.read"]);
  });

  test("keeps the requestId when a reconnect re-requests a subset of a pending request", async () => {
    const baseDir = await makeDevicePairingDir();

    // A TUI connect files a broad scope-upgrade request the owner sees in
    // `devices list`.
    const broad = await requestDevicePairing(
      {
        deviceId: DEVICE_ID,
        publicKey: PUBLIC_KEY,
        role: "operator",
        scopes: ["operator.admin", "operator.pairing", "operator.read", "operator.write"],
      },
      baseDir,
    );
    expect(broad.created).toBe(true);

    // `openclaw devices approve <id>` reconnects as a CLI probe that only needs
    // `operator.pairing`. That subset re-request must not mint a new id, or the
    // id the owner copied would fail to approve with "unknown requestId".
    const subsetReconnect = await requestDevicePairing(
      {
        deviceId: DEVICE_ID,
        publicKey: PUBLIC_KEY,
        role: "operator",
        scopes: ["operator.pairing"],
      },
      baseDir,
    );

    expect(subsetReconnect.created).toBe(false);
    expect(subsetReconnect.request.requestId).toBe(broad.request.requestId);
    // The broader pending scopes the owner already saw are preserved.
    expectScopesToContain(subsetReconnect.request.scopes, [
      "operator.admin",
      "operator.pairing",
      "operator.read",
      "operator.write",
    ]);

    const pairingList = await listDevicePairing(baseDir);
    expect(pairingList.pending).toHaveLength(1);
    expect(pairingList.pending[0]?.requestId).toBe(broad.request.requestId);

    // The originally-listed id remains approvable.
    const approved = await approveDevicePairing(
      broad.request.requestId,
      { callerScopes: ["operator.admin"] },
      baseDir,
    );
    expect(approved?.status).toBe("approved");
  });

  test("keeps the requestId when operator.admin covers a pairing reconnect", async () => {
    const baseDir = await makeDevicePairingDir();

    const adminRequest = await requestDevicePairing(
      {
        deviceId: DEVICE_ID,
        publicKey: PUBLIC_KEY,
        role: "operator",
        scopes: ["operator.admin"],
      },
      baseDir,
    );

    const pairingReconnect = await requestDevicePairing(
      {
        deviceId: DEVICE_ID,
        publicKey: PUBLIC_KEY,
        role: "operator",
        scopes: ["operator.pairing"],
      },
      baseDir,
    );

    expect(pairingReconnect.created).toBe(false);
    expect(pairingReconnect.request.requestId).toBe(adminRequest.request.requestId);
    expect(pairingReconnect.request.scopes).toEqual(["operator.admin"]);
  });

  test("supports cron-first progressive operator escalation from read to pairing to admin", async () => {
    const baseDir = await makeDevicePairingDir();

    await approveInitialPairing(baseDir, ["operator.read"]);

    const pairedAfterCron = await getPairedDevice(DEVICE_ID, baseDir);
    expect(pairedAfterCron?.approvedScopes).toEqual(["operator.read"]);
    expect(readOperatorTokenScopes(pairedAfterCron)).toEqual(["operator.read"]);

    const pairingRepair = await requestDevicePairing(
      {
        deviceId: DEVICE_ID,
        publicKey: PUBLIC_KEY,
        role: "operator",
        scopes: ["operator.pairing"],
      },
      baseDir,
    );

    const pairingApproved = await approveDevicePairing(
      pairingRepair.request.requestId,
      { callerScopes: ["operator.read", "operator.pairing"] },
      baseDir,
    );
    expect(pairingApproved?.status).toBe("approved");
    expect((await listDevicePairing(baseDir)).pending).toHaveLength(0);

    const pairedAfterPairing = await getPairedDevice(DEVICE_ID, baseDir);
    expectScopesToContain(pairedAfterPairing?.approvedScopes, [
      "operator.read",
      "operator.pairing",
    ]);
    expect(readOperatorTokenScopes(pairedAfterPairing)).toEqual(
      normalizeDeviceAuthScopes(["operator.read", "operator.pairing"]),
    );

    const adminRepair = await requestDevicePairing(
      {
        deviceId: DEVICE_ID,
        publicKey: PUBLIC_KEY,
        role: "operator",
        scopes: ["operator.admin"],
      },
      baseDir,
    );

    const adminApproved = await approveDevicePairing(
      adminRepair.request.requestId,
      { callerScopes: ["operator.admin"] },
      baseDir,
    );
    expect(adminApproved?.status).toBe("approved");
    expect((await listDevicePairing(baseDir)).pending).toHaveLength(0);

    const pairedAfterAdmin = await getPairedDevice(DEVICE_ID, baseDir);
    expectScopesToContain(pairedAfterAdmin?.approvedScopes, [
      "operator.admin",
      "operator.pairing",
      "operator.read",
    ]);
    expect(readOperatorTokenScopes(pairedAfterAdmin)).toEqual(
      normalizeDeviceAuthScopes(["operator.admin", "operator.pairing", "operator.read"]),
    );
  });
});
