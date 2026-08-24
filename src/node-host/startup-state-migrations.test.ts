import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadDeviceAuthToken } from "../infra/device-auth-store.js";
import { generateStoredDeviceIdentity } from "../infra/device-identity-store.js";
import { loadDeviceIdentityIfPresent } from "../infra/device-identity.js";
import { resolveExecApprovalsPath } from "../infra/exec-approvals-config.js";
import { loadExecApprovals } from "../infra/exec-approvals-store.js";
import { testing as execApprovalsStoreTesting } from "../infra/exec-approvals-store.test-support.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { runStartupMigrations } from "./startup-state-migrations.js";

describe("node-host startup state migrations", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  const log = {
    info: vi.fn<(message: string) => void>(),
    warn: vi.fn<(message: string) => void>(),
  };
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      execApprovalsStoreTesting.reset();
      envSnapshot.restore();
      cleanup();
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function useStateDir(): { env: NodeJS.ProcessEnv; stateDir: string } {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-node-host-migrations-"));
    return {
      env: { ...process.env, HOME: stateDir, OPENCLAW_STATE_DIR: stateDir },
      stateDir,
    };
  }

  async function writeDeviceAuth(stateDir: string): Promise<string> {
    const sourcePath = path.join(stateDir, "identity", "device-auth.json");
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.writeFile(
      sourcePath,
      JSON.stringify({
        version: 1,
        deviceId: "device-1",
        tokens: {
          operator: {
            token: "legacy-token",
            scopes: ["operator.write"],
            updatedAtMs: 10,
          },
        },
      }),
    );
    return sourcePath;
  }

  async function writeDeviceIdentity(stateDir: string): Promise<{
    deviceId: string;
    sourcePath: string;
  }> {
    const identity = generateStoredDeviceIdentity(1_700_000_000_000);
    const sourcePath = path.join(stateDir, "identity", "device.json");
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.writeFile(sourcePath, JSON.stringify({ version: 1, ...identity }));
    return { deviceId: identity.deviceId, sourcePath };
  }

  async function writeExecApprovals(env: NodeJS.ProcessEnv): Promise<string> {
    const sourcePath = resolveExecApprovalsPath(env);
    await fsp.writeFile(
      sourcePath,
      `${JSON.stringify({
        version: 1,
        defaults: { security: "deny" },
        agents: {},
      })}\n`,
    );
    return sourcePath;
  }

  it("migrates device auth before the runtime gate reads it", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeDeviceAuth(stateDir);

    await runStartupMigrations({ env, log });

    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toMatchObject({
      token: "legacy-token",
      scopes: ["operator.read", "operator.write"],
    });
    expect(log.info).toHaveBeenCalledWith("Migrated 1 device-auth token to SQLite.");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("migrates legacy exec approvals into the canonical store", async () => {
    const { env, stateDir } = useStateDir();
    const sourcePath = await writeExecApprovals(env);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    execApprovalsStoreTesting.reset();

    await runStartupMigrations({ env, log });

    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(loadExecApprovals().defaults?.security).toBe("deny");
    expect(log.info).toHaveBeenCalledWith(
      "Imported legacy exec approvals into shared SQLite state.",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("migrates a legacy device identity", async () => {
    const { env, stateDir } = useStateDir();
    const { deviceId, sourcePath } = await writeDeviceIdentity(stateDir);

    await runStartupMigrations({ env, log });

    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(loadDeviceIdentityIfPresent({ env })?.deviceId).toBe(deviceId);
    expect(log.info).toHaveBeenCalledWith("Migrated primary device identity to SQLite.");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("reports a recreated divergent identity as a notice while preserving the canonical identity", async () => {
    const { env, stateDir } = useStateDir();
    const { deviceId } = await writeDeviceIdentity(stateDir);
    await runStartupMigrations({ env, log });
    vi.clearAllMocks();

    const { sourcePath } = await writeDeviceIdentity(stateDir);
    await runStartupMigrations({ env, log });

    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(loadDeviceIdentityIfPresent({ env })?.deviceId).toBe(deviceId);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("canonical SQLite identity remains authoritative"),
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("preserves a pending native device identity claim and continues", async () => {
    const { env, stateDir } = useStateDir();
    const { sourcePath } = await writeDeviceIdentity(stateDir);
    const nativeClaimPath = `${sourcePath}.native-importing`;
    await fsp.rename(sourcePath, nativeClaimPath);

    await expect(runStartupMigrations({ env, log })).resolves.toBeUndefined();

    expect(fs.existsSync(nativeClaimPath)).toBe(true);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      "Native device identity import is pending; restart the native app before running Doctor.",
    );
  });

  it("warns and leaves every legacy file untouched when the state lock is held", async () => {
    const { env, stateDir } = useStateDir();
    const deviceAuthPath = await writeDeviceAuth(stateDir);
    const { sourcePath: deviceIdentityPath } = await writeDeviceIdentity(stateDir);
    const execApprovalsPath = await writeExecApprovals(env);
    const gatewayLock = await acquireGatewayLock({
      allowInTests: true,
      env,
      pollIntervalMs: 10,
      port: 18_792,
      timeoutMs: 100,
    });
    if (!gatewayLock) {
      throw new Error("expected test Gateway lock");
    }

    try {
      await expect(runStartupMigrations({ env, log })).resolves.toBeUndefined();
    } finally {
      await gatewayLock.release();
    }

    expect(fs.existsSync(deviceAuthPath)).toBe(true);
    expect(fs.existsSync(deviceIdentityPath)).toBe(true);
    expect(fs.existsSync(execApprovalsPath)).toBe(true);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(3);
  });

  it("is silent when no retired state is present", async () => {
    const { env } = useStateDir();

    await runStartupMigrations({ env, log });

    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
