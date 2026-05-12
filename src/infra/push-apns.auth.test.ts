import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  normalizeApnsEnvironment,
  resolveApnsAuthConfigFromEnv,
  shouldClearStoredApnsRegistration,
  shouldInvalidateApnsRegistration,
} from "./push-apns.js";

const tempDirs = createTrackedTempDirs();

async function makeTempDir(): Promise<string> {
  return await tempDirs.make("openclaw-push-apns-auth-test-");
}

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("push APNs auth and helper coverage", () => {
  it("normalizes APNs environment values", () => {
    expect(normalizeApnsEnvironment("sandbox")).toBe("sandbox");
    expect(normalizeApnsEnvironment(" PRODUCTION ")).toBe("production");
    expect(normalizeApnsEnvironment("staging")).toBeNull();
    expect(normalizeApnsEnvironment(null)).toBeNull();
  });

  it("prefers inline APNs private key values and unescapes newlines", async () => {
    const resolved = await resolveApnsAuthConfigFromEnv({
      OPENCLAW_APNS_TEAM_ID: "TEAM123",
      OPENCLAW_APNS_KEY_ID: "KEY123",
      OPENCLAW_APNS_PRIVATE_KEY_P8:
        "-----BEGIN PRIVATE KEY-----\\nline-a\\nline-b\\n-----END PRIVATE KEY-----", // pragma: allowlist secret
      OPENCLAW_APNS_PRIVATE_KEY: "ignored",
    } as NodeJS.ProcessEnv);

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.teamId).toBe("TEAM123");
      expect(resolved.value.keyId).toBe("KEY123");
      expect(resolved.value.privateKey).toContain("\nline-a\n");
      expect(resolved.value.privateKey).not.toBe("ignored");
    }
  });

  it("falls back to OPENCLAW_APNS_PRIVATE_KEY when OPENCLAW_APNS_PRIVATE_KEY_P8 is blank", async () => {
    const resolved = await resolveApnsAuthConfigFromEnv({
      OPENCLAW_APNS_TEAM_ID: "TEAM123",
      OPENCLAW_APNS_KEY_ID: "KEY123",
      OPENCLAW_APNS_PRIVATE_KEY_P8: "   ",
      OPENCLAW_APNS_PRIVATE_KEY:
        "-----BEGIN PRIVATE KEY-----\\nline-c\\nline-d\\n-----END PRIVATE KEY-----", // pragma: allowlist secret
    } as NodeJS.ProcessEnv);

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.teamId).toBe("TEAM123");
      expect(resolved.value.keyId).toBe("KEY123");
      expect(resolved.value.privateKey).toBe(
        "-----BEGIN PRIVATE KEY-----\nline-c\nline-d\n-----END PRIVATE KEY-----",
      );
    }
  });

  it("reads APNs private keys from OPENCLAW_APNS_PRIVATE_KEY_PATH", async () => {
    const dir = await makeTempDir();
    const keyPath = path.join(dir, "apns-key.p8");
    await fs.writeFile(
      keyPath,
      "-----BEGIN PRIVATE KEY-----\\nline-e\\nline-f\\n-----END PRIVATE KEY-----\n",
      "utf8",
    );

    const resolved = await resolveApnsAuthConfigFromEnv({
      OPENCLAW_APNS_TEAM_ID: "TEAM123",
      OPENCLAW_APNS_KEY_ID: "KEY123",
      OPENCLAW_APNS_PRIVATE_KEY_PATH: keyPath,
    } as NodeJS.ProcessEnv);

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.teamId).toBe("TEAM123");
      expect(resolved.value.keyId).toBe("KEY123");
      expect(resolved.value.privateKey).toBe(
        "-----BEGIN PRIVATE KEY-----\nline-e\nline-f\n-----END PRIVATE KEY-----",
      );
    }
  });

  it("reports missing auth fields and path read failures", async () => {
    const dir = await makeTempDir();
    const missingPath = path.join(dir, "missing-key.p8");

    await expect(resolveApnsAuthConfigFromEnv({} as NodeJS.ProcessEnv)).resolves.toEqual({
      ok: false,
      error: "APNs auth missing: set OPENCLAW_APNS_TEAM_ID and OPENCLAW_APNS_KEY_ID",
    });

    const missingKey = await resolveApnsAuthConfigFromEnv({
      OPENCLAW_APNS_TEAM_ID: "TEAM123",
      OPENCLAW_APNS_KEY_ID: "KEY123",
      OPENCLAW_APNS_PRIVATE_KEY_PATH: missingPath,
    } as NodeJS.ProcessEnv);

    expect(missingKey.ok).toBe(false);
    if (!missingKey.ok) {
      expect(missingKey.error).toContain(
        `failed reading OPENCLAW_APNS_PRIVATE_KEY_PATH (${missingPath})`,
      );
    }
  });

  it("invalidates only real bad-token APNs failures", () => {
    expect(shouldInvalidateApnsRegistration({ status: 410, reason: "Unregistered" })).toBe(true);
    expect(shouldInvalidateApnsRegistration({ status: 400, reason: " BadDeviceToken " })).toBe(
      true,
    );
    expect(shouldInvalidateApnsRegistration({ status: 400, reason: "BadTopic" })).toBe(false);
    expect(shouldInvalidateApnsRegistration({ status: 429, reason: "BadDeviceToken" })).toBe(false);
  });

  it("clears only direct registrations without an environment override mismatch", () => {
    expect(
      shouldClearStoredApnsRegistration({
        registration: {
          nodeId: "ios-node-direct",
          transport: "direct",
          token: "ABCD1234ABCD1234ABCD1234ABCD1234",
          topic: "ai.openclaw.ios",
          environment: "sandbox",
          updatedAtMs: 1,
        },
        result: { status: 400, reason: "BadDeviceToken" },
      }),
    ).toBe(true);

    expect(
      shouldClearStoredApnsRegistration({
        registration: {
          nodeId: "ios-node-relay",
          transport: "relay",
          relayHandle: "relay-handle-123",
          sendGrant: "send-grant-123",
          installationId: "install-123",
          topic: "ai.openclaw.ios",
          environment: "production",
          distribution: "official",
          updatedAtMs: 1,
        },
        result: { status: 410, reason: "Unregistered" },
      }),
    ).toBe(false);

    expect(
      shouldClearStoredApnsRegistration({
        registration: {
          nodeId: "ios-node-direct",
          transport: "direct",
          token: "ABCD1234ABCD1234ABCD1234ABCD1234",
          topic: "ai.openclaw.ios",
          environment: "sandbox",
          updatedAtMs: 1,
        },
        result: { status: 400, reason: "BadDeviceToken" },
        overrideEnvironment: "production",
      }),
    ).toBe(false);
  });
});
