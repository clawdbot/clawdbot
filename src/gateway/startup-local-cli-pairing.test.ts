import { afterEach, describe, expect, it } from "vitest";
import { loadDeviceAuthToken } from "../infra/device-auth-store.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { getPairedDevice, requestDevicePairing } from "../infra/device-pairing.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { READ_SCOPE } from "./operator-scopes.js";
import { ensureStartupLocalCliPairing } from "./startup-local-cli-pairing.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("startup local CLI pairing", () => {
  it("does not report a limited existing operator token as admin-ready", async () => {
    await withStateDirEnv("openclaw-startup-local-cli-pairing-", async () => {
      const identity = loadOrCreateDeviceIdentity();
      const request = await requestDevicePairing({
        deviceId: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        clientId: "openclaw-cli",
        clientMode: "cli",
        role: "operator",
        scopes: [READ_SCOPE],
        silent: true,
      });
      const approved = await approveDevicePairing(request.request.requestId, {
        callerScopes: [READ_SCOPE],
        approvedVia: "silent",
      });
      expect(approved?.status).toBe("approved");

      await expect(ensureStartupLocalCliPairing()).resolves.toBe("unavailable");
      expect(loadDeviceAuthToken({ deviceId: identity.deviceId, role: "operator" })).toBeNull();
      await expect(getPairedDevice(identity.deviceId)).resolves.toMatchObject({
        approvedScopes: [READ_SCOPE],
      });
    });
  });
});
