import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  deriveDeviceIdFromPublicKey,
  loadDeviceIdentityIfPresent,
  loadOrCreateDeviceIdentity,
  normalizeDevicePublicKeyBase64Url,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
  verifyDeviceSignature,
} from "./device-identity.js";

async function withIdentity(
  run: (identity: ReturnType<typeof loadOrCreateDeviceIdentity>) => void,
) {
  await withTempDir("openclaw-device-identity-", async (dir) => {
    const identity = loadOrCreateDeviceIdentity(path.join(dir, "device.json"));
    run(identity);
  });
}

describe("device identity crypto helpers", () => {
  it("loads an existing identity without creating a missing file", async () => {
    await withTempDir("openclaw-device-identity-readonly-", async (dir) => {
      const identityPath = path.join(dir, "identity", "device.json");

      expect(loadDeviceIdentityIfPresent(identityPath)).toBeNull();
      expect(fs.existsSync(identityPath)).toBe(false);

      const created = loadOrCreateDeviceIdentity(identityPath);

      expect(loadDeviceIdentityIfPresent(identityPath)).toEqual(created);
    });
  });

  it("does not repair mismatched stored device ids in read-only mode", async () => {
    await withTempDir("openclaw-device-identity-readonly-", async (dir) => {
      const identityPath = path.join(dir, "identity", "device.json");
      loadOrCreateDeviceIdentity(identityPath);
      const stored = JSON.parse(fs.readFileSync(identityPath, "utf8")) as Record<string, unknown>;
      fs.writeFileSync(
        identityPath,
        `${JSON.stringify({ ...stored, deviceId: "mismatched" }, null, 2)}\n`,
        "utf8",
      );
      const before = fs.readFileSync(identityPath, "utf8");

      expect(loadDeviceIdentityIfPresent(identityPath)).toBeNull();
      expect(fs.readFileSync(identityPath, "utf8")).toBe(before);
    });
  });

  it("derives the same canonical raw key and device id from pem and encoded public keys", async () => {
    await withIdentity((identity) => {
      const publicKeyRaw = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
      const paddedBase64 = `${publicKeyRaw.replaceAll("-", "+").replaceAll("_", "/")}==`;

      expect(normalizeDevicePublicKeyBase64Url(identity.publicKeyPem)).toBe(publicKeyRaw);
      expect(normalizeDevicePublicKeyBase64Url(paddedBase64)).toBe(publicKeyRaw);
      expect(deriveDeviceIdFromPublicKey(identity.publicKeyPem)).toBe(identity.deviceId);
      expect(deriveDeviceIdFromPublicKey(publicKeyRaw)).toBe(identity.deviceId);
    });
  });

  it("signs payloads that verify against pem and raw public key forms", async () => {
    await withIdentity((identity) => {
      const payload = JSON.stringify({
        action: "system.run",
        ts: 1234,
      });
      const signature = signDevicePayload(identity.privateKeyPem, payload);
      const publicKeyRaw = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);

      expect(verifyDeviceSignature(identity.publicKeyPem, payload, signature)).toBe(true);
      expect(verifyDeviceSignature(publicKeyRaw, payload, signature)).toBe(true);
      expect(verifyDeviceSignature(publicKeyRaw, `${payload}!`, signature)).toBe(false);
    });
  });

  it("fails closed for invalid public keys and signatures", async () => {
    await withIdentity((identity) => {
      const payload = "hello";
      const signature = signDevicePayload(identity.privateKeyPem, payload);

      expect(normalizeDevicePublicKeyBase64Url("-----BEGIN PUBLIC KEY-----broken")).toBeNull();
      expect(deriveDeviceIdFromPublicKey("%%%")).toBeNull();
      expect(verifyDeviceSignature("%%%invalid%%%", payload, signature)).toBe(false);
      expect(verifyDeviceSignature(identity.publicKeyPem, payload, "%%%invalid%%%")).toBe(false);
    });
  });
});
