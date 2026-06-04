// Covers default device identity path under state dir.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { loadOrCreateDeviceIdentity } from "./device-identity.js";

describe("device identity state dir defaults", () => {
  it("writes the default identity file under OPENCLAW_STATE_DIR", async () => {
    await withStateDirEnv("openclaw-identity-state-", async ({ stateDir }) => {
      const identity = loadOrCreateDeviceIdentity();
      const identityPath = path.join(stateDir, "identity", "device.json");
      const raw = JSON.parse(await fs.readFile(identityPath, "utf8")) as { deviceId?: string };
      expect(raw.deviceId).toBe(identity.deviceId);
    });
  });

  it("reuses the stored identity on subsequent loads", async () => {
    await withStateDirEnv("openclaw-identity-state-", async ({ stateDir }) => {
      const first = loadOrCreateDeviceIdentity();
      const second = loadOrCreateDeviceIdentity();
      const identityPath = path.join(stateDir, "identity", "device.json");
      const raw = JSON.parse(await fs.readFile(identityPath, "utf8")) as {
        deviceId?: string;
        publicKeyPem?: string;
      };

      expect(second).toEqual(first);
      expect(raw.deviceId).toBe(first.deviceId);
      expect(raw.publicKeyPem).toBe(first.publicKeyPem);
    });
  });

  it("repairs stored device IDs that no longer match the public key", async () => {
    await withStateDirEnv("openclaw-identity-state-", async ({ stateDir }) => {
      const original = loadOrCreateDeviceIdentity();
      const identityPath = path.join(stateDir, "identity", "device.json");
      const raw = JSON.parse(await fs.readFile(identityPath, "utf8")) as Record<string, unknown>;

      await fs.writeFile(
        identityPath,
        `${JSON.stringify({ ...raw, deviceId: "stale-device-id" }, null, 2)}\n`,
        "utf8",
      );

      const repaired = loadOrCreateDeviceIdentity();
      const stored = JSON.parse(await fs.readFile(identityPath, "utf8")) as { deviceId?: string };

      expect(repaired.deviceId).toBe(original.deviceId);
      expect(stored.deviceId).toBe(original.deviceId);
    });
  });

  it("regenerates the identity when the stored file is invalid", async () => {
    await withStateDirEnv("openclaw-identity-state-", async ({ stateDir }) => {
      const identityPath = path.join(stateDir, "identity", "device.json");
      await fs.mkdir(path.dirname(identityPath), { recursive: true });
      await fs.writeFile(identityPath, '{"version":1,"deviceId":"broken"}\n', "utf8");

      const regenerated = loadOrCreateDeviceIdentity();
      const stored = JSON.parse(await fs.readFile(identityPath, "utf8")) as {
        version?: number;
        deviceId?: string;
        publicKeyPem?: string;
        privateKeyPem?: string;
      };

      expect(stored.version).toBe(1);
      expect(stored.deviceId).toBe(regenerated.deviceId);
      expect(stored.publicKeyPem).toBe(regenerated.publicKeyPem);
      expect(stored.privateKeyPem).toBe(regenerated.privateKeyPem);
    });
  });
});
