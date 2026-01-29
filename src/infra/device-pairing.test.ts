import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  approveDevicePairing,
  getPairedDevice,
  requestDevicePairing,
  rotateDeviceToken,
} from "./device-pairing.js";

describe("device pairing tokens", () => {
  test("preserves existing token scopes when rotating without scopes", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "moltbot-device-pairing-"));
    const request = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "operator",
        scopes: ["operator.admin"],
      },
      baseDir,
    );
    await approveDevicePairing(request.request.requestId, baseDir);

    await rotateDeviceToken({
      deviceId: "device-1",
      role: "operator",
      scopes: ["operator.read"],
      baseDir,
    });
    let paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.read"]);
    expect(paired?.scopes).toEqual(["operator.read"]);

    await rotateDeviceToken({
      deviceId: "device-1",
      role: "operator",
      baseDir,
    });
    paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.read"]);
  });

  test("updates silent flag when local connection retries existing pending request", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "moltbot-device-pairing-"));

    // First request from non-local connection (silent: false)
    const firstRequest = await requestDevicePairing(
      {
        deviceId: "device-2",
        publicKey: "public-key-2",
        role: "operator",
        scopes: [],
        silent: false,
      },
      baseDir,
    );
    expect(firstRequest.created).toBe(true);
    expect(firstRequest.request.silent).toBe(false);

    // Second request from local connection (silent: true) for same device
    const secondRequest = await requestDevicePairing(
      {
        deviceId: "device-2",
        publicKey: "public-key-2",
        role: "operator",
        scopes: [],
        silent: true,
      },
      baseDir,
    );
    expect(secondRequest.created).toBe(false);
    expect(secondRequest.request.silent).toBe(true);
    expect(secondRequest.request.requestId).toBe(firstRequest.request.requestId);
  });
});
