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

  it("returns a transient identity without overwriting an invalid stored file", async () => {
    await withStateDirEnv("openclaw-identity-state-", async ({ stateDir }) => {
      const identityPath = path.join(stateDir, "identity", "device.json");
      await fs.mkdir(path.dirname(identityPath), { recursive: true });
      const before = [
        "{",
        '  "version": 1,',
        '  "deviceId": "broken",',
        '  "publicKeyPem": "not-a-valid-public-key",',
        '  "privateKeyPem": "not-a-valid-private-key"',
        "}",
        "",
      ].join("\n");
      await fs.writeFile(identityPath, before, "utf8");

      const regenerated = loadOrCreateDeviceIdentity();
      const stored = await fs.readFile(identityPath, "utf8");

      expect(regenerated.deviceId).not.toBe("broken");
      expect(stored).toBe(before);
    });
  });
});
