// Tests device bootstrap state creation and persistence.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../logging.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  clearDeviceBootstrapTokens,
  getBoundDeviceBootstrapProfile,
  getDeviceBootstrapTokenProfile,
  issueDeviceBootstrapToken,
  redeemDeviceBootstrapTokenProfile,
  restoreDeviceBootstrapToken,
  revokeDeviceBootstrapToken,
  verifyDeviceBootstrapToken,
} from "./device-bootstrap.js";
import { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem } from "./device-identity.js";
import {
  loadDeviceBootstrapTokenRecords,
  persistDeviceBootstrapTokenRecords,
} from "./device-pairing-store.js";

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-device-bootstrap-test-");

async function verifyBootstrapToken(
  baseDir: string,
  token: string,
  overrides: Partial<Parameters<typeof verifyDeviceBootstrapToken>[0]> = {},
) {
  return await verifyDeviceBootstrapToken({
    token,
    deviceId: "device-123",
    publicKey: "public-key-123",
    role: "node",
    scopes: [],
    baseDir,
    ...overrides,
  });
}

afterEach(async () => {
  vi.useRealTimers();
  resetLogger();
  setLoggerOverride(null);
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

describe("device bootstrap tokens", () => {
  it("issues bootstrap tokens and persists them with a ten-minute expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T12:00:00Z"));

    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(issued.expiresAtMs).toBe(Date.now() + 10 * 60 * 1000);
    expect(loadDeviceBootstrapTokenRecords(baseDir)[issued.token]).toMatchObject({
      token: issued.token,
      ts: Date.now(),
      issuedAtMs: Date.now(),
      profile: {
        roles: ["node", "operator"],
        scopes: [
          "operator.approvals",
          "operator.questions",
          "operator.read",
          "operator.talk.secrets",
          "operator.write",
        ],
      },
    });
  });

  it("rejects bootstrap token issuance when expiry would exceed the Date range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));

    const baseDir = await createTempDir();

    await expect(issueDeviceBootstrapToken({ baseDir })).rejects.toThrow(
      "Device bootstrap token expiry could not be resolved.",
    );
  });

  it("verifies valid bootstrap tokens and binds them to the first device identity", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    await expect(verifyBootstrapToken(baseDir, issued.token)).resolves.toEqual({ ok: true });
    await expect(verifyBootstrapToken(baseDir, issued.token)).resolves.toEqual({ ok: true });
    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        deviceId: "device-456",
        publicKey: "public-key-456",
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });

    const records = loadDeviceBootstrapTokenRecords(baseDir);
    expect(records[issued.token]?.token).toBe(issued.token);
    expect(records[issued.token]?.deviceId).toBe("device-123");
    expect(records[issued.token]?.publicKey).toBe("public-key-123");
  });

  it("rejects changing the requested profile while a bound use is pending", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      profile: {
        roles: ["operator"],
        scopes: ["operator.approvals", "operator.read", "operator.write"],
      },
    });

    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: ["operator.read"],
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: ["operator.write", "operator.approvals"],
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });
    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: ["operator.read"],
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      redeemDeviceBootstrapTokenProfile({
        baseDir,
        token: issued.token,
        role: "operator",
        scopes: ["operator.read"],
      }),
    ).resolves.toEqual({
      recorded: true,
      fullyRedeemed: false,
    });
    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: ["operator.write", "operator.approvals"],
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("loads the issued bootstrap profile for a valid token", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    await expect(getDeviceBootstrapTokenProfile({ baseDir, token: issued.token })).resolves.toEqual(
      {
        roles: ["node", "operator"],
        scopes: [
          "operator.approvals",
          "operator.questions",
          "operator.read",
          "operator.talk.secrets",
          "operator.write",
        ],
      },
    );
    await expect(getDeviceBootstrapTokenProfile({ baseDir, token: "invalid" })).resolves.toBeNull();
  });

  it("persists bootstrap profile purpose through binding", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      profile: {
        roles: ["operator"],
        scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
        purpose: "control-ui",
      },
    });

    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: ["operator.read"],
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      getBoundDeviceBootstrapProfile({
        baseDir,
        token: issued.token,
        deviceId: "device-123",
        publicKey: "public-key-123",
      }),
    ).resolves.toEqual({
      roles: ["operator"],
      scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
      purpose: "control-ui",
    });
  });

  it("persists bootstrap redemption state across verification reloads", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      profile: {
        roles: ["node"],
        scopes: [],
      },
    });

    await expect(verifyBootstrapToken(baseDir, issued.token)).resolves.toEqual({ ok: true });
    await expect(
      redeemDeviceBootstrapTokenProfile({
        baseDir,
        token: issued.token,
        role: "node",
        scopes: [],
      }),
    ).resolves.toEqual({
      recorded: true,
      fullyRedeemed: true,
    });

    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: ["operator.approvals", "operator.read", "operator.write", "operator.talk.secrets"],
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });
  });

  it("clears outstanding bootstrap tokens on demand", async () => {
    const baseDir = await createTempDir();
    const first = await issueDeviceBootstrapToken({ baseDir });
    const second = await issueDeviceBootstrapToken({ baseDir });

    await expect(clearDeviceBootstrapTokens({ baseDir })).resolves.toEqual({ removed: 2 });
    expect(loadDeviceBootstrapTokenRecords(baseDir)).toEqual({});

    await expect(verifyBootstrapToken(baseDir, first.token)).resolves.toEqual({
      ok: false,
      reason: "bootstrap_token_invalid",
    });

    await expect(verifyBootstrapToken(baseDir, second.token)).resolves.toEqual({
      ok: false,
      reason: "bootstrap_token_invalid",
    });
  });

  it("restores a revoked bootstrap token record after send failure recovery", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    await expect(verifyBootstrapToken(baseDir, issued.token)).resolves.toEqual({ ok: true });
    const revoked = await revokeDeviceBootstrapToken({ baseDir, token: issued.token });
    expect(revoked.removed).toBe(true);
    expect(revoked.record?.token).toBe(issued.token);

    if (!revoked.record) {
      throw new Error("expected revoked bootstrap token record");
    }
    await restoreDeviceBootstrapToken({ baseDir, record: revoked.record });
    await expect(verifyBootstrapToken(baseDir, issued.token)).resolves.toEqual({ ok: true });
  });

  it("revokes a specific bootstrap token", async () => {
    const baseDir = await createTempDir();
    const first = await issueDeviceBootstrapToken({ baseDir });
    const second = await issueDeviceBootstrapToken({ baseDir });

    const revoked = await revokeDeviceBootstrapToken({ baseDir, token: first.token });
    expect(revoked.removed).toBe(true);

    await expect(verifyBootstrapToken(baseDir, first.token)).resolves.toEqual({
      ok: false,
      reason: "bootstrap_token_invalid",
    });

    await expect(verifyBootstrapToken(baseDir, second.token)).resolves.toEqual({ ok: true });
  });

  it("keeps the token when required verification fields are blank", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "   ",
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });

    expect(loadDeviceBootstrapTokenRecords(baseDir)[issued.token]).toBeDefined();
  });

  it("rejects bootstrap verification when scopes exceed the issued profile", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: ["operator.admin"],
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });

    expect(loadDeviceBootstrapTokenRecords(baseDir)[issued.token]).toBeDefined();
  });

  it("allows operator scope subsets within an explicitly issued bootstrap profile", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      profile: {
        roles: ["operator"],
        scopes: ["operator.read"],
      },
    });

    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: ["operator.read"],
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects cross-role scope escalation (node role requesting operator scopes)", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "node",
        scopes: ["operator.read"],
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });

    expect(loadDeviceBootstrapTokenRecords(baseDir)[issued.token]).toBeDefined();
  });

  it("supports explicitly bound bootstrap profiles", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      profile: {
        roles: [" operator ", "operator"],
        scopes: ["operator.read", " operator.read "],
      },
    });

    expect(loadDeviceBootstrapTokenRecords(baseDir)[issued.token]?.profile).toEqual({
      roles: ["operator"],
      scopes: ["operator.read"],
    });

    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: ["operator.read"],
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("bounds explicitly issued bootstrap profiles to handoff scopes", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      profile: {
        roles: ["node", "operator"],
        scopes: [
          "node.exec",
          "operator.admin",
          "operator.approvals",
          "operator.pairing",
          "operator.read",
          "operator.talk.secrets",
          "operator.write",
        ],
      },
    });

    await expect(getDeviceBootstrapTokenProfile({ baseDir, token: issued.token })).resolves.toEqual(
      {
        roles: ["node", "operator"],
        scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
      },
    );
    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: ["operator.admin"],
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });
  });

  it("retains admin only for an explicitly full-mobile handoff profile", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      profile: {
        roles: ["node", "operator"],
        scopes: ["operator.admin", "operator.pairing", "operator.read"],
        purpose: "mobile-full",
      },
    });

    await expect(getDeviceBootstrapTokenProfile({ baseDir, token: issued.token })).resolves.toEqual(
      {
        roles: ["node", "operator"],
        scopes: ["operator.admin", "operator.read", "operator.write"],
        purpose: "mobile-full",
      },
    );
    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: ["operator.admin"],
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("logs when issued bootstrap profiles strip overbroad scopes", async () => {
    const baseDir = await createTempDir();
    const logPath = path.join(baseDir, "bootstrap.log");
    setLoggerOverride({ level: "warn", consoleLevel: "silent", file: logPath });

    await issueDeviceBootstrapToken({
      baseDir,
      profile: {
        roles: ["node", "operator"],
        scopes: ["node.exec", "operator.admin", "operator.read"],
      },
    });

    const content = await fs.readFile(logPath, "utf8");
    expect(content).toContain("bootstrap_token_scopes_stripped");
    expect(content).toContain("node.exec");
    expect(content).toContain("operator.admin");
    expect(content).toContain("operator.read");
  });

  it("bounds redeemed bootstrap profiles to handoff scopes", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      profile: {
        roles: ["operator"],
        scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
      },
    });

    await expect(
      redeemDeviceBootstrapTokenProfile({
        baseDir,
        token: issued.token,
        role: "operator",
        scopes: [
          "operator.admin",
          "operator.approvals",
          "operator.pairing",
          "operator.read",
          "operator.talk.secrets",
          "operator.write",
        ],
      }),
    ).resolves.toEqual({ recorded: true, fullyRedeemed: true });

    expect(loadDeviceBootstrapTokenRecords(baseDir)[issued.token]?.redeemedProfile).toEqual({
      roles: ["operator"],
      scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
    });
  });

  it("accepts trimmed bootstrap tokens and binds them", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    await expect(verifyBootstrapToken(baseDir, `  ${issued.token}  `)).resolves.toEqual({
      ok: true,
    });

    expect(loadDeviceBootstrapTokenRecords(baseDir)[issued.token]?.deviceId).toBe("device-123");
  });

  it("rejects blank or unknown tokens", async () => {
    const baseDir = await createTempDir();
    await issueDeviceBootstrapToken({ baseDir });

    await expect(verifyBootstrapToken(baseDir, "   ")).resolves.toEqual({
      ok: false,
      reason: "bootstrap_token_invalid",
    });

    await expect(
      verifyDeviceBootstrapToken({
        token: "missing-token",
        deviceId: "device-123",
        publicKey: "public-key-123",
        role: "node",
        scopes: [],
        baseDir,
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });
  });

  it("accepts equivalent public key encodings after binding the bootstrap token", async () => {
    const baseDir = await createTempDir();
    const identity = loadOrCreateDeviceIdentity(path.join(baseDir, "device.json"));
    const issued = await issueDeviceBootstrapToken({ baseDir });
    const rawPublicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);

    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        deviceId: identity.deviceId,
        publicKey: identity.publicKeyPem,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        deviceId: identity.deviceId,
        publicKey: rawPublicKey,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      getBoundDeviceBootstrapProfile({
        token: issued.token,
        deviceId: identity.deviceId,
        publicKey: rawPublicKey,
        baseDir,
      }),
    ).resolves.toEqual({
      roles: ["node", "operator"],
      scopes: [
        "operator.approvals",
        "operator.questions",
        "operator.read",
        "operator.talk.secrets",
        "operator.write",
      ],
    });
  });

  it("rejects a second device identity after the first verification binds the token", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    await expect(verifyBootstrapToken(baseDir, issued.token)).resolves.toEqual({ ok: true });
    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        deviceId: "device-456",
        publicKey: "public-key-456",
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });
  });

  it("fails closed for profileless records and prunes expired tokens", async () => {
    vi.useFakeTimers();
    const baseDir = await createTempDir();
    vi.setSystemTime(new Date("2026-03-14T12:00:00Z"));
    const tokenTtlMs = 10 * 60 * 1000;
    persistDeviceBootstrapTokenRecords(
      {
        "profileless-token": {
          token: "profileless-token",
          ts: Date.now(),
          issuedAtMs: Date.now(),
        },
        "expired-token": {
          token: "expired-token",
          ts: Date.now() - tokenTtlMs - 1,
          issuedAtMs: Date.now() - tokenTtlMs - 1,
        },
      },
      baseDir,
    );

    await expect(verifyBootstrapToken(baseDir, "profileless-token")).resolves.toEqual({
      ok: false,
      reason: "bootstrap_token_invalid",
    });
    await expect(verifyBootstrapToken(baseDir, "expired-token")).resolves.toEqual({
      ok: false,
      reason: "bootstrap_token_invalid",
    });
  });
});
