// Tests named Gateway lock roles and active-port compatibility.
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as nativeSleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  acquireGatewayLock,
  GatewayLockError,
  readActiveGatewayLockIdentity,
  readActiveGatewayLockPort,
} from "./gateway-lock.js";

const fixtureRootTracker = createSuiteTempRootTracker({
  prefix: "openclaw-gateway-lock-workshop-",
});
let fixtureRoot = "";

describe("Gateway lock roles", () => {
  beforeAll(async () => {
    fixtureRoot = await fixtureRootTracker.setup();
  });

  afterAll(async () => {
    await fixtureRootTracker.cleanup();
    fixtureRoot = "";
  });

  it("keeps a live Workshop apply owner while Gateway startup races", async () => {
    const stateDir = await fixtureRootTracker.make("case");
    const lockDir = path.join(fixtureRoot, "__locks");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, "{}", "utf8");
    const env = {
      ...process.env,
      OPENCLAW_ALLOW_MULTI_GATEWAY: "1",
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
    };
    const readProcessCmdline = () => ["openclaw", "skills", "workshop", "apply", "proposal-id"];
    const lock = await acquireGatewayLock({
      allowInTests: true,
      env,
      lockDir,
      platform: "darwin",
      port: 18789,
      readProcessStartTime: () => null,
      role: "skill-workshop-apply",
      timeoutMs: 30,
    });
    expect(lock).not.toBeNull();
    if (!lock) {
      throw new Error("Expected Workshop Gateway lock");
    }

    try {
      expect(lock.lockPath).not.toBe(lock.stateLockPath);
      await expect(
        readActiveGatewayLockPort({
          env,
          lockDir,
          platform: "darwin",
          readProcessCmdline,
          readProcessStartTime: () => null,
        }),
      ).resolves.toBeUndefined();
      await expect(
        acquireGatewayLock({
          allowInTests: true,
          env,
          lockDir,
          platform: "darwin",
          port: 18789,
          pollIntervalMs: 2,
          readProcessCmdline,
          readProcessStartTime: () => null,
          sleep: nativeSleep,
          timeoutMs: 15,
        }),
      ).rejects.toBeInstanceOf(GatewayLockError);
    } finally {
      await lock.release();
    }
  });

  it("keeps an explicit Gateway role visible to active-port discovery", async () => {
    const stateDir = await fixtureRootTracker.make("gateway-role");
    const lockDir = path.join(fixtureRoot, "__locks");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, "{}", "utf8");
    const env = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
    };
    const lock = await acquireGatewayLock({
      allowInTests: true,
      env,
      lockDir,
      platform: "darwin",
      port: 28789,
      readProcessStartTime: () => null,
      timeoutMs: 30,
    });
    expect(lock).not.toBeNull();
    if (!lock) {
      throw new Error("Expected Gateway lock");
    }

    const payload = JSON.parse(await fs.readFile(lock.lockPath, "utf8")) as Record<string, unknown>;
    await fs.writeFile(lock.lockPath, JSON.stringify({ ...payload, role: "gateway" }), "utf8");
    try {
      await expect(
        readActiveGatewayLockPort({
          env,
          lockDir,
          platform: "darwin",
          readProcessCmdline: () => ["openclaw-gateway"],
          readProcessStartTime: () => null,
        }),
      ).resolves.toBe(28789);
    } finally {
      await lock.release();
    }
  });

  it("keeps agent-embedded ownership distinct from a running Gateway", async () => {
    const stateDir = await fixtureRootTracker.make("agent-embedded-role");
    const lockDir = path.join(fixtureRoot, "__locks");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, "{}", "utf8");
    const env = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
    };
    const readProcessCmdline = () => ["openclaw", "agent", "--local", "--message", "hello"];
    const lock = await acquireGatewayLock({
      allowInTests: true,
      env,
      lockDir,
      platform: "darwin",
      port: 28789,
      readProcessCmdline,
      readProcessStartTime: () => null,
      role: "agent-embedded",
      timeoutMs: 30,
    });
    expect(lock).not.toBeNull();
    if (!lock) {
      throw new Error("Expected embedded agent Gateway lock");
    }

    try {
      await expect(
        readActiveGatewayLockIdentity({
          env,
          lockDir,
          platform: "darwin",
          readProcessCmdline,
          readProcessStartTime: () => null,
        }),
      ).resolves.toBeUndefined();
      await expect(
        acquireGatewayLock({
          allowInTests: true,
          env,
          lockDir,
          platform: "darwin",
          pollIntervalMs: 2,
          readProcessCmdline,
          readProcessStartTime: () => null,
          sleep: nativeSleep,
          timeoutMs: 15,
        }),
      ).rejects.toThrow(
        `another embedded OpenClaw state writer is active (pid ${process.pid}); lock timeout after 15ms`,
      );
    } finally {
      await lock.release();
    }
  });
});
