import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  clearApnsRegistration,
  clearApnsRegistrationIfCurrent,
  loadApnsRegistration,
  registerApnsRegistration,
  registerApnsToken,
} from "./push-apns.js";

const tempDirs = createTrackedTempDirs();

async function makeTempDir(): Promise<string> {
  return await tempDirs.make("openclaw-push-apns-store-test-");
}

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("push APNs registration store", () => {
  it("stores and reloads direct APNs registrations", async () => {
    const baseDir = await makeTempDir();
    const saved = await registerApnsToken({
      nodeId: "ios-node-1",
      token: "ABCD1234ABCD1234ABCD1234ABCD1234",
      topic: "ai.openclaw.ios",
      environment: "sandbox",
      baseDir,
    });

    const loaded = await loadApnsRegistration("ios-node-1", baseDir);
    expect(loaded).toEqual(saved);
  });

  it("stores relay-backed registrations without a raw token", async () => {
    const baseDir = await makeTempDir();
    const saved = await registerApnsRegistration({
      nodeId: "ios-node-relay",
      transport: "relay",
      relayHandle: "relay-handle-123",
      sendGrant: "send-grant-123",
      installationId: "install-123",
      topic: "ai.openclaw.ios",
      environment: "production",
      distribution: "official",
      tokenDebugSuffix: " abcd-1234 ",
      baseDir,
    });

    const loaded = await loadApnsRegistration("ios-node-relay", baseDir);
    expect(saved.transport).toBe("relay");
    expect(loaded).toEqual(saved);
    expect(loaded && "token" in loaded).toBe(false);
  });

  it("normalizes legacy direct records from disk and ignores invalid entries", async () => {
    const baseDir = await makeTempDir();
    const statePath = path.join(baseDir, "push", "apns-registrations.json");
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      `${JSON.stringify(
        {
          registrationsByNodeId: {
            " ios-node-legacy ": {
              nodeId: " ios-node-legacy ",
              token: "<ABCD1234ABCD1234ABCD1234ABCD1234>",
              topic: " ai.openclaw.ios ",
              environment: " PRODUCTION ",
              updatedAtMs: 3,
            },
            "   ": {
              nodeId: " ios-node-fallback ",
              token: "<ABCD1234ABCD1234ABCD1234ABCD1234>",
              topic: " ai.openclaw.ios ",
              updatedAtMs: 2,
            },
            "ios-node-bad-relay": {
              transport: "relay",
              nodeId: "ios-node-bad-relay",
              relayHandle: "relay-handle-123",
              sendGrant: "send-grant-123",
              installationId: "install-123",
              topic: "ai.openclaw.ios",
              environment: "production",
              distribution: "beta",
              updatedAtMs: 1,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(loadApnsRegistration("ios-node-legacy", baseDir)).resolves.toEqual({
      nodeId: "ios-node-legacy",
      transport: "direct",
      token: "abcd1234abcd1234abcd1234abcd1234",
      topic: "ai.openclaw.ios",
      environment: "production",
      updatedAtMs: 3,
    });
    await expect(loadApnsRegistration("ios-node-fallback", baseDir)).resolves.toEqual({
      nodeId: "ios-node-fallback",
      transport: "direct",
      token: "abcd1234abcd1234abcd1234abcd1234",
      topic: "ai.openclaw.ios",
      environment: "sandbox",
      updatedAtMs: 2,
    });
    await expect(loadApnsRegistration("ios-node-bad-relay", baseDir)).resolves.toBeNull();
  });

  it("falls back cleanly for malformed or missing registration state", async () => {
    const baseDir = await makeTempDir();
    const statePath = path.join(baseDir, "push", "apns-registrations.json");
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, "[]", "utf8");

    await expect(loadApnsRegistration("ios-node-missing", baseDir)).resolves.toBeNull();
    await expect(loadApnsRegistration("   ", baseDir)).resolves.toBeNull();
    await expect(clearApnsRegistration("   ", baseDir)).resolves.toBe(false);
    await expect(clearApnsRegistration("ios-node-missing", baseDir)).resolves.toBe(false);
  });

  it("rejects invalid direct and relay registration inputs", async () => {
    const baseDir = await makeTempDir();
    const oversized = "x".repeat(257);

    await expect(
      registerApnsToken({
        nodeId: "ios-node-1",
        token: "not-a-token",
        topic: "ai.openclaw.ios",
        baseDir,
      }),
    ).rejects.toThrow("invalid APNs token");
    await expect(
      registerApnsToken({
        nodeId: "n".repeat(257),
        token: "ABCD1234ABCD1234ABCD1234ABCD1234",
        topic: "ai.openclaw.ios",
        baseDir,
      }),
    ).rejects.toThrow("nodeId required");
    await expect(
      registerApnsToken({
        nodeId: "ios-node-1",
        token: "A".repeat(513),
        topic: "ai.openclaw.ios",
        baseDir,
      }),
    ).rejects.toThrow("invalid APNs token");
    await expect(
      registerApnsToken({
        nodeId: "ios-node-1",
        token: "ABCD1234ABCD1234ABCD1234ABCD1234",
        topic: "a".repeat(256),
        baseDir,
      }),
    ).rejects.toThrow("topic required");
    await expect(
      registerApnsRegistration({
        nodeId: "ios-node-relay",
        transport: "relay",
        relayHandle: "relay-handle-123",
        sendGrant: "send-grant-123",
        installationId: "install-123",
        topic: "ai.openclaw.ios",
        environment: "staging",
        distribution: "official",
        baseDir,
      }),
    ).rejects.toThrow("relay registrations must use production environment");
    await expect(
      registerApnsRegistration({
        nodeId: "ios-node-relay",
        transport: "relay",
        relayHandle: "relay-handle-123",
        sendGrant: "send-grant-123",
        installationId: "install-123",
        topic: "ai.openclaw.ios",
        environment: "production",
        distribution: "beta",
        baseDir,
      }),
    ).rejects.toThrow("relay registrations must use official distribution");
    await expect(
      registerApnsRegistration({
        nodeId: "ios-node-relay",
        transport: "relay",
        relayHandle: oversized,
        sendGrant: "send-grant-123",
        installationId: "install-123",
        topic: "ai.openclaw.ios",
        environment: "production",
        distribution: "official",
        baseDir,
      }),
    ).rejects.toThrow("relayHandle too long");
    await expect(
      registerApnsRegistration({
        nodeId: "ios-node-relay",
        transport: "relay",
        relayHandle: "relay-handle-123",
        sendGrant: "send-grant-123",
        installationId: oversized,
        topic: "ai.openclaw.ios",
        environment: "production",
        distribution: "official",
        baseDir,
      }),
    ).rejects.toThrow("installationId too long");
    await expect(
      registerApnsRegistration({
        nodeId: "ios-node-relay",
        transport: "relay",
        relayHandle: "relay-handle-123",
        sendGrant: "x".repeat(1025),
        installationId: "install-123",
        topic: "ai.openclaw.ios",
        environment: "production",
        distribution: "official",
        baseDir,
      }),
    ).rejects.toThrow("sendGrant too long");
  });

  it("persists with a trailing newline and clears registrations", async () => {
    const baseDir = await makeTempDir();
    await registerApnsToken({
      nodeId: "ios-node-1",
      token: "ABCD1234ABCD1234ABCD1234ABCD1234",
      topic: "ai.openclaw.ios",
      baseDir,
    });

    const statePath = path.join(baseDir, "push", "apns-registrations.json");
    await expect(fs.readFile(statePath, "utf8")).resolves.toMatch(/\n$/);
    await expect(clearApnsRegistration("ios-node-1", baseDir)).resolves.toBe(true);
    await expect(loadApnsRegistration("ios-node-1", baseDir)).resolves.toBeNull();
  });

  it("only clears a registration when the stored entry still matches", async () => {
    vi.useFakeTimers();
    try {
      const baseDir = await makeTempDir();
      vi.setSystemTime(new Date("2026-03-11T00:00:00Z"));
      const stale = await registerApnsToken({
        nodeId: "ios-node-1",
        token: "ABCD1234ABCD1234ABCD1234ABCD1234",
        topic: "ai.openclaw.ios",
        environment: "sandbox",
        baseDir,
      });

      vi.setSystemTime(new Date("2026-03-11T00:00:01Z"));
      const fresh = await registerApnsToken({
        nodeId: "ios-node-1",
        token: "ABCD1234ABCD1234ABCD1234ABCD1234",
        topic: "ai.openclaw.ios",
        environment: "sandbox",
        baseDir,
      });

      await expect(
        clearApnsRegistrationIfCurrent({
          nodeId: "ios-node-1",
          registration: stale,
          baseDir,
        }),
      ).resolves.toBe(false);
      await expect(loadApnsRegistration("ios-node-1", baseDir)).resolves.toEqual(fresh);
    } finally {
      vi.useRealTimers();
    }
  });
});
