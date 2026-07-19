import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireGatewayLock, GatewayLockError } from "../infra/gateway-lock.js";
import {
  DoctorSqliteMaintenanceLockUnavailableError,
  isDestructiveDoctorSessionSqliteMode,
  withDoctorSqliteMaintenanceLock,
} from "./doctor-sqlite-maintenance-lock.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(cleanup);
});

async function createLockFixture() {
  const root = tempDirs.make("openclaw-doctor-sqlite-lock-");
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const lockDir = path.join(root, "locks");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(configPath, "{}\n", "utf8");
  const env = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
    VITEST: "1",
  };
  return {
    env,
    lockDir,
    lockOptions: {
      lockDir,
      platform: "darwin" as const,
      pollIntervalMs: 2,
      readProcessCmdline: () => ["openclaw-gateway"],
      timeoutMs: 15,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("doctor SQLite maintenance lock", () => {
  it.each([
    ["inspect", false],
    ["dry-run", false],
    ["validate", false],
    ["import", true],
    ["compact", true],
    ["restore", true],
    ["recover", true],
  ] as const)("classifies %s mode as destructive=%s", (mode, expected) => {
    expect(isDestructiveDoctorSessionSqliteMode(mode)).toBe(expected);
  });

  it("refuses maintenance while a verified Gateway owns the state lock", async () => {
    const fixture = await createLockFixture();
    const gatewayLock = await acquireGatewayLock({
      allowInTests: true,
      env: fixture.env,
      lockDir: fixture.lockDir,
      platform: "darwin",
      port: 18789,
    });
    if (!gatewayLock) {
      throw new Error("expected Gateway lock");
    }
    const run = vi.fn();

    try {
      const result = withDoctorSqliteMaintenanceLock(
        {
          env: fixture.env,
          operation: "state SQLite compaction",
          run,
        },
        { lockOptions: fixture.lockOptions },
      );
      await expect(result).rejects.toBeInstanceOf(DoctorSqliteMaintenanceLockUnavailableError);
      await expect(result).rejects.toThrow(/Gateway or another SQLite maintenance command owns/);
      expect(run).not.toHaveBeenCalled();
    } finally {
      await gatewayLock.release();
    }
  });

  it("prevents Gateway startup until maintenance releases ownership", async () => {
    const fixture = await createLockFixture();
    let allowMaintenanceToFinish: (() => void) | undefined;
    const maintenanceMayFinish = new Promise<void>((resolve) => {
      allowMaintenanceToFinish = resolve;
    });
    let markMaintenanceStarted: (() => void) | undefined;
    const maintenanceStarted = new Promise<void>((resolve) => {
      markMaintenanceStarted = resolve;
    });
    const maintenance = withDoctorSqliteMaintenanceLock(
      {
        env: fixture.env,
        operation: "session SQLite compaction",
        run: async () => {
          markMaintenanceStarted?.();
          await maintenanceMayFinish;
          return "done";
        },
      },
      { lockOptions: fixture.lockOptions },
    );
    await maintenanceStarted;

    await expect(
      acquireGatewayLock({
        allowInTests: true,
        env: fixture.env,
        lockDir: fixture.lockDir,
        platform: "darwin",
        port: 18789,
        pollIntervalMs: 2,
        readProcessCmdline: () => ["openclaw", "doctor", "--session-sqlite", "compact"],
        timeoutMs: 15,
      }),
    ).rejects.toBeInstanceOf(GatewayLockError);

    allowMaintenanceToFinish?.();
    await expect(maintenance).resolves.toBe("done");

    const gatewayLock = await acquireGatewayLock({
      allowInTests: true,
      env: fixture.env,
      lockDir: fixture.lockDir,
      platform: "darwin",
      port: 18789,
      timeoutMs: 15,
    });
    if (!gatewayLock) {
      throw new Error("expected Gateway lock after maintenance release");
    }
    await gatewayLock.release();
  });

  it("releases ownership after maintenance fails", async () => {
    const fixture = await createLockFixture();

    await expect(
      withDoctorSqliteMaintenanceLock(
        {
          env: fixture.env,
          operation: "session SQLite restore",
          run: () => {
            throw new Error("restore failed");
          },
        },
        { lockOptions: fixture.lockOptions },
      ),
    ).rejects.toThrow("restore failed");

    const gatewayLock = await acquireGatewayLock({
      allowInTests: true,
      env: fixture.env,
      lockDir: fixture.lockDir,
      platform: "darwin",
      port: 18789,
      timeoutMs: 15,
    });
    if (!gatewayLock) {
      throw new Error("expected Gateway lock after failed maintenance");
    }
    await gatewayLock.release();
  });

  it("blocks maintenance when the Gateway used the multi-Gateway override", async () => {
    const fixture = await createLockFixture();
    const run = vi.fn();
    const gatewayLock = await acquireGatewayLock({
      allowInTests: true,
      env: { ...fixture.env, OPENCLAW_ALLOW_MULTI_GATEWAY: "1" },
      lockDir: fixture.lockDir,
      platform: "darwin",
      port: 18789,
      timeoutMs: 15,
    });
    if (!gatewayLock) {
      throw new Error("expected state ownership lock");
    }

    try {
      await expect(
        withDoctorSqliteMaintenanceLock(
          {
            env: fixture.env,
            operation: "state SQLite compaction",
            run,
          },
          { lockOptions: fixture.lockOptions },
        ),
      ).rejects.toThrow(/Gateway or another SQLite maintenance command owns/);
      expect(run).not.toHaveBeenCalled();
    } finally {
      await gatewayLock.release();
    }
  });

  it("uses the state ownership lock when maintenance inherits the multi-Gateway override", async () => {
    const fixture = await createLockFixture();

    await expect(
      withDoctorSqliteMaintenanceLock(
        {
          env: { ...fixture.env, OPENCLAW_ALLOW_MULTI_GATEWAY: "1" },
          operation: "state SQLite compaction",
          run: () => "done",
        },
        { lockOptions: fixture.lockOptions },
      ),
    ).resolves.toBe("done");
  });

  it("refuses explicit destructive targets outside the locked state directory", async () => {
    const fixture = await createLockFixture();
    const externalPath = path.join(
      tempDirs.make("openclaw-external-session-store-"),
      "sessions.json",
    );
    const run = vi.fn();

    await expect(
      withDoctorSqliteMaintenanceLock(
        {
          env: fixture.env,
          operation: "session SQLite compaction",
          protectedPaths: [externalPath],
          run,
        },
        { lockOptions: fixture.lockOptions },
      ),
    ).rejects.toThrow(/outside the active OpenClaw state directory/);
    expect(run).not.toHaveBeenCalled();

    const gatewayLock = await acquireGatewayLock({
      allowInTests: true,
      env: fixture.env,
      lockDir: fixture.lockDir,
      platform: "darwin",
      port: 18789,
      timeoutMs: 15,
    });
    if (!gatewayLock) {
      throw new Error("expected Gateway lock after ownership validation failure");
    }
    await gatewayLock.release();
  });

  it("refuses dangling in-state symlinks that resolve outside ownership", async () => {
    if (process.platform === "win32") {
      return;
    }
    const fixture = await createLockFixture();
    const sessionsDir = path.join(fixture.env.OPENCLAW_STATE_DIR, "agents", "main", "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    const outsideTarget = path.join(
      tempDirs.make("openclaw-dangling-session-target-"),
      "missing.json",
    );
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.symlink(outsideTarget, storePath);
    const run = vi.fn();

    await expect(
      withDoctorSqliteMaintenanceLock(
        {
          env: fixture.env,
          operation: "session SQLite import",
          protectedPaths: [storePath],
          run,
        },
        { lockOptions: fixture.lockOptions },
      ),
    ).rejects.toThrow(/outside the active OpenClaw state directory/);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses outside path aliases that resolve into the locked state directory", async () => {
    if (process.platform === "win32") {
      return;
    }
    const fixture = await createLockFixture();
    const externalAlias = path.join(
      path.dirname(fixture.env.OPENCLAW_STATE_DIR),
      "external-state-alias",
    );
    await fs.symlink(fixture.env.OPENCLAW_STATE_DIR, externalAlias, "dir");
    const storePath = path.join(externalAlias, "agents", "main", "sessions", "sessions.json");
    const run = vi.fn();

    await expect(
      withDoctorSqliteMaintenanceLock(
        {
          env: fixture.env,
          operation: "session SQLite import",
          protectedPaths: [storePath],
          run,
        },
        { lockOptions: fixture.lockOptions },
      ),
    ).rejects.toThrow(/outside the active OpenClaw state directory/);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses in-state hard links that can alias storage outside ownership", async () => {
    const fixture = await createLockFixture();
    const sessionsDir = path.join(fixture.env.OPENCLAW_STATE_DIR, "agents", "main", "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    const externalDir = path.join(path.dirname(fixture.env.OPENCLAW_STATE_DIR), "external-state");
    const externalPath = path.join(externalDir, "sessions.json");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.mkdir(externalDir, { recursive: true });
    await fs.writeFile(externalPath, "{}\n", "utf8");
    await fs.link(externalPath, storePath);
    const run = vi.fn();

    await expect(
      withDoctorSqliteMaintenanceLock(
        {
          env: fixture.env,
          operation: "session SQLite compaction",
          protectedPaths: [storePath],
          run,
        },
        { lockOptions: fixture.lockOptions },
      ),
    ).rejects.toThrow(/hard-linked path/);
    expect(run).not.toHaveBeenCalled();
    await expect(fs.readFile(externalPath, "utf8")).resolves.toBe("{}\n");
  });

  it("allows explicit destructive targets owned by the locked state directory", async () => {
    const fixture = await createLockFixture();
    const storePath = path.join(
      fixture.env.OPENCLAW_STATE_DIR,
      "agents",
      "main",
      "sessions",
      "sessions.json",
    );

    await expect(
      withDoctorSqliteMaintenanceLock(
        {
          env: fixture.env,
          operation: "session SQLite compaction",
          protectedPaths: [storePath],
          run: () => "done",
        },
        { lockOptions: fixture.lockOptions },
      ),
    ).resolves.toBe("done");
  });
});
