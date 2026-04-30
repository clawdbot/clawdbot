import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../logging.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  clearDeviceBootstrapTokens,
  DEVICE_BOOTSTRAP_TOKEN_TTL_MS,
  getBoundDeviceBootstrapProfile,
  getDeviceBootstrapTokenProfile,
  issueDeviceBootstrapToken,
  redeemDeviceBootstrapTokenProfile,
  restoreDeviceBootstrapToken,
  revokeDeviceBootstrapToken,
  verifyDeviceBootstrapToken,
} from "./device-bootstrap.js";
import { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem } from "./device-identity.js";

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-device-bootstrap-test-");

function resolveBootstrapPath(baseDir: string): string {
  return path.join(baseDir, "devices", "bootstrap.json");
}

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
  await tempDirs.cleanup();
});

describe("device bootstrap tokens", () => {
  it("issues bootstrap tokens and persists them with an expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T12:00:00Z"));

    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(issued.expiresAtMs).toBe(Date.now() + DEVICE_BOOTSTRAP_TOKEN_TTL_MS);

    const raw = await fs.readFile(resolveBootstrapPath(baseDir), "utf8");
    const parsed = JSON.parse(raw) as Record<
      string,
      {
        token: string;
        ts: number;
        issuedAtMs: number;
        profile: { roles: string[]; scopes: string[] };
      }
    >;
    expect(parsed[issued.token]).toMatchObject({
      token: issued.token,
      ts: Date.now(),
      issuedAtMs: Date.now(),
      profile: {
        roles: ["node", "operator"],
        scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
      },
    });
  });

  it("verifies valid bootstrap tokens and binds them to the first device identity", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    await expect(verifyBootstrapToken(baseDir, issued.token)).resolves.toEqual({ ok: true });
    await expect(verifyBootstrapToken(baseDir, issued.token)).resolves.toEqual({ ok: true });

    const raw = await fs.readFile(resolveBootstrapPath(baseDir), "utf8");
    const parsed = JSON.parse(raw) as Record<
      string,
      {
        token: string;
        deviceId?: string;
        publicKey?: string;
      }
    >;
    expect(parsed[issued.token]).toMatchObject({
      token: issued.token,
      deviceId: "device-123",
      publicKey: "public-key-123",
    });
  });

  it("loads the issued bootstrap profile for a valid token", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    await expect(getDeviceBootstrapTokenProfile({ baseDir, token: issued.token })).resolves.toEqual(
      {
        roles: ["node", "operator"],
        scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
      },
    );
    await expect(getDeviceBootstrapTokenProfile({ baseDir, token: "invalid" })).resolves.toBeNull();
  });

  it("persists bootstrap redemption state across verification reloads", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

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
      fullyRedeemed: false,
    });

    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: ["operator.approvals", "operator.read", "operator.write", "operator.talk.secrets"],
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      redeemDeviceBootstrapTokenProfile({
        baseDir,
        token: issued.token,
        role: "operator",
        scopes: ["operator.approvals", "operator.read", "operator.write", "operator.talk.secrets"],
      }),
    ).resolves.toEqual({
      recorded: true,
      fullyRedeemed: true,
    });
  });

  it("clears outstanding bootstrap tokens on demand", async () => {
    const baseDir = await createTempDir();
    const first = await issueDeviceBootstrapToken({ baseDir });
    const second = await issueDeviceBootstrapToken({ baseDir });

    await expect(clearDeviceBootstrapTokens({ baseDir })).resolves.toEqual({ removed: 2 });
    await expect(fs.readFile(resolveBootstrapPath(baseDir), "utf8")).resolves.toBe("{}");

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

    await expect(
      revokeDeviceBootstrapToken({ baseDir, token: first.token }),
    ).resolves.toMatchObject({
      removed: true,
    });

    await expect(verifyBootstrapToken(baseDir, first.token)).resolves.toEqual({
      ok: false,
      reason: "bootstrap_token_invalid",
    });

    await expect(verifyBootstrapToken(baseDir, second.token)).resolves.toEqual({ ok: true });
  });

  it("verifies bootstrap tokens by the persisted map key and binds them", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });
    const issuedAtMs = Date.now();
    const bootstrapPath = path.join(baseDir, "devices", "bootstrap.json");
    await fs.writeFile(
      bootstrapPath,
      JSON.stringify(
        {
          "legacy-key": {
            token: issued.token,
            ts: issuedAtMs,
            issuedAtMs,
            profile: {
              roles: ["node", "operator"],
              scopes: [
                "operator.approvals",
                "operator.read",
                "operator.talk.secrets",
                "operator.write",
              ],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await expect(verifyBootstrapToken(baseDir, issued.token)).resolves.toEqual({ ok: true });

    const raw = await fs.readFile(bootstrapPath, "utf8");
    const parsed = JSON.parse(raw) as Record<
      string,
      { token: string; deviceId?: string; publicKey?: string }
    >;
    expect(parsed["legacy-key"]).toMatchObject({
      token: issued.token,
      deviceId: "device-123",
      publicKey: "public-key-123",
    });
  });

  it("keeps the token when required verification fields are blank", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "   ",
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });

    const raw = await fs.readFile(resolveBootstrapPath(baseDir), "utf8");
    expect(raw).toContain(issued.token);
  });

  it("rejects bootstrap verification when role or scopes exceed the issued profile", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

    await expect(
      verifyBootstrapToken(baseDir, issued.token, {
        role: "operator",
        scopes: ["operator.admin"],
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });

    const raw = await fs.readFile(resolveBootstrapPath(baseDir), "utf8");
    expect(raw).toContain(issued.token);
  });

  it("allows operator scope subsets within the issued bootstrap profile", async () => {
    const baseDir = await createTempDir();
    const issued = await issueDeviceBootstrapToken({ baseDir });

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

    const raw = await fs.readFile(resolveBootstrapPath(baseDir), "utf8");
    expect(raw).toContain(issued.token);
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

    const raw = await fs.readFile(resolveBootstrapPath(baseDir), "utf8");
    const parsed = JSON.parse(raw) as Record<
      string,
      { profile: { roles: string[]; scopes: string[] } }
    >;
    expect(parsed[issued.token]?.profile).toEqual({
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

    const raw = await fs.readFile(resolveBootstrapPath(baseDir), "utf8");
    const parsed = JSON.parse(raw) as Record<
      string,
      { redeemedProfile?: { roles?: string[]; scopes?: string[] } }
    >;
    expect(parsed[issued.token]?.redeemedProfile).toEqual({
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

    const raw = await fs.readFile(resolveBootstrapPath(baseDir), "utf8");
    const parsed = JSON.parse(raw) as Record<string, { deviceId?: string }>;
    expect(parsed[issued.token]?.deviceId).toBe("device-123");
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

  it("repairs malformed persisted state when issuing a new token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T12:00:00Z"));

    const baseDir = await createTempDir();
    const bootstrapPath = resolveBootstrapPath(baseDir);
    await fs.mkdir(path.dirname(bootstrapPath), { recursive: true });
    await fs.writeFile(bootstrapPath, "[1,2,3]\n", "utf8");

    const issued = await issueDeviceBootstrapToken({ baseDir });
    const raw = await fs.readFile(bootstrapPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, { token: string }>;

    expect(Object.keys(parsed)).toEqual([issued.token]);
    expect(parsed[issued.token]?.token).toBe(issued.token);
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
      scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
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

  it("fails closed for unbound legacy records and prunes expired tokens", async () => {
    vi.useFakeTimers();
    const baseDir = await createTempDir();
    const bootstrapPath = resolveBootstrapPath(baseDir);
    await fs.mkdir(path.dirname(bootstrapPath), { recursive: true });

    vi.setSystemTime(new Date("2026-03-14T12:00:00Z"));
    await fs.writeFile(
      bootstrapPath,
      `${JSON.stringify(
        {
          legacyToken: {
            token: "legacyToken",
            issuedAtMs: Date.now(),
          },
          expiredToken: {
            token: "expiredToken",
            issuedAtMs: Date.now() - DEVICE_BOOTSTRAP_TOKEN_TTL_MS - 1,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(verifyBootstrapToken(baseDir, "legacyToken")).resolves.toEqual({
      ok: false,
      reason: "bootstrap_token_invalid",
    });

    await expect(verifyBootstrapToken(baseDir, "expiredToken")).resolves.toEqual({
      ok: false,
      reason: "bootstrap_token_invalid",
    });
  });
});
