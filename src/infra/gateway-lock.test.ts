// Tests gateway lock file ownership and stale-lock behavior.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as nativeSleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { acquireGatewayLock, GatewayLockError, readActiveGatewayLockPort } from "./gateway-lock.js";

type GatewayLock = NonNullable<Awaited<ReturnType<typeof acquireGatewayLock>>>;
type GatewayLockOptions = NonNullable<Parameters<typeof acquireGatewayLock>[0]>;

const fixtureRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-gateway-lock-" });
let fixtureRoot = "";
const realNow = Date.now.bind(Date);

function resolveTestLockDir() {
  return path.join(fixtureRoot, "__locks");
}

async function makeEnv() {
  const dir = await fixtureRootTracker.make("case");
  const configPath = path.join(dir, "openclaw.json");
  await fs.writeFile(configPath, "{}", "utf8");
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: dir,
    OPENCLAW_CONFIG_PATH: configPath,
  };
}

async function acquireForTest(
  env: NodeJS.ProcessEnv,
  opts: Omit<GatewayLockOptions, "env" | "allowInTests"> = {},
) {
  return await acquireGatewayLock({
    env,
    allowInTests: true,
    timeoutMs: 30,
    pollIntervalMs: 2,
    now: realNow,
    sleep: async (ms) => {
      await nativeSleep(ms);
    },
    lockDir: resolveTestLockDir(),
    ...opts,
  });
}

function expectGatewayLock(lock: Awaited<ReturnType<typeof acquireGatewayLock>>): GatewayLock {
  if (lock === null) {
    throw new Error("Expected gateway lock");
  }
  expect(typeof lock.release).toBe("function");
  return lock;
}

function resolveLockPath(env: NodeJS.ProcessEnv) {
  const stateDir = resolveStateDir(env);
  const configPath = resolveConfigPath(env, stateDir);
  const configHash = createHash("sha256").update(configPath).digest("hex").slice(0, 8);
  const canonicalStateDir = fsSync.realpathSync.native(path.resolve(stateDir));
  const stateHash = createHash("sha256").update(canonicalStateDir).digest("hex").slice(0, 8);
  const lockDir = resolveTestLockDir();
  return {
    lockPath: path.join(lockDir, `gateway.${configHash}.lock`),
    configPath,
    stateLockPath: path.join(lockDir, `gateway.state.${stateHash}.lock`),
  };
}

function createLockPayload(params: {
  configPath: string;
  startTime: number;
  createdAt?: string;
  port?: number;
  role?: "gateway" | "sqlite-maintenance";
}) {
  return {
    pid: process.pid,
    createdAt: params.createdAt ?? new Date().toISOString(),
    configPath: params.configPath,
    ...(params.port ? { port: params.port } : {}),
    ...(params.role ? { role: params.role } : {}),
    startTime: params.startTime,
  };
}

function mockProcStatRead(params: { onProcRead: () => string }) {
  const readFileSync = fsSync.readFileSync;
  return vi.spyOn(fsSync, "readFileSync").mockImplementation((filePath, encoding) => {
    if (filePath === `/proc/${process.pid}/stat`) {
      return params.onProcRead();
    }
    return readFileSync(filePath as never, encoding as never) as never;
  });
}

async function writeLockFile(
  env: NodeJS.ProcessEnv,
  params: { startTime: number; createdAt?: string } = { startTime: 111 },
) {
  const { lockPath, configPath } = resolveLockPath(env);
  const payload = createLockPayload({
    configPath,
    startTime: params.startTime,
    createdAt: params.createdAt,
  });
  await fs.writeFile(lockPath, JSON.stringify(payload), "utf8");
  return { lockPath, configPath };
}

function createEaccesProcStatSpy() {
  return mockProcStatRead({
    onProcRead: () => {
      throw new Error("EACCES");
    },
  });
}

function createPortProbeConnectionSpy(result: "connect" | "refused") {
  return vi.spyOn(net, "createConnection").mockImplementation(() => {
    const socket = new EventEmitter() as net.Socket;
    socket.destroy = vi.fn();
    setImmediate(() => {
      if (result === "connect") {
        socket.emit("connect");
        return;
      }
      socket.emit("error", Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }));
    });
    return socket;
  });
}

async function writeRecentLockFile(env: NodeJS.ProcessEnv, startTime = 111) {
  await writeLockFile(env, {
    startTime,
    createdAt: new Date().toISOString(),
  });
}

describe("gateway lock", () => {
  beforeAll(async () => {
    fixtureRoot = await fixtureRootTracker.setup();
  });

  beforeEach(() => {
    // Other suites occasionally leave global spies behind (Date.now, setTimeout, etc.).
    // This test relies on fake timers advancing Date.now and setTimeout deterministically.
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await fixtureRootTracker.cleanup();
    fixtureRoot = "";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("blocks concurrent acquisition until release", async () => {
    // Fake timers can hang on Windows CI when combined with fs open loops.
    // Keep this test on real timers and use small timeouts.
    vi.useRealTimers();
    const env = await makeEnv();
    const lock = await acquireForTest(env, { timeoutMs: 50 });
    const acquiredLock = expectGatewayLock(lock);

    const pending = acquireForTest(env, {
      timeoutMs: 15,
      readProcessCmdline: () => ["openclaw", "gateway", "run"],
    });
    await expect(pending).rejects.toBeInstanceOf(GatewayLockError);

    await acquiredLock.release();
    const lock2 = await acquireForTest(env);
    await expectGatewayLock(lock2).release();
  });

  it("serializes different config paths that resolve to the same state directory", async () => {
    const stateDir = await fixtureRootTracker.make("shared-state");
    const configA = path.join(stateDir, "gateway-a.json");
    const configB = path.join(stateDir, "gateway-b.json");
    await fs.writeFile(configA, "{}", "utf8");
    await fs.writeFile(configB, "{}", "utf8");
    const envA = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: configA,
      OPENCLAW_STATE_DIR: stateDir,
    };
    const envB = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: configB,
      OPENCLAW_STATE_DIR: stateDir,
    };
    const lock = expectGatewayLock(
      await acquireForTest(envA, {
        platform: "darwin",
      }),
    );

    try {
      await expect(
        acquireForTest(envB, {
          platform: "darwin",
          readProcessCmdline: () => ["openclaw-gateway"],
          timeoutMs: 15,
        }),
      ).rejects.toBeInstanceOf(GatewayLockError);
    } finally {
      await lock.release();
    }
  });

  it.skipIf(process.platform === "win32")(
    "canonicalizes state-directory aliases before choosing the ownership lock",
    async () => {
      const stateDir = await fixtureRootTracker.make("canonical-state");
      const aliasRoot = await fixtureRootTracker.make("canonical-alias");
      const stateAlias = path.join(aliasRoot, "state-link");
      const configA = path.join(stateDir, "gateway-a.json");
      const configB = path.join(aliasRoot, "gateway-b.json");
      await fs.writeFile(configA, "{}", "utf8");
      await fs.writeFile(configB, "{}", "utf8");
      await fs.symlink(stateDir, stateAlias);
      const envA = {
        ...process.env,
        OPENCLAW_CONFIG_PATH: configA,
        OPENCLAW_STATE_DIR: stateDir,
      };
      const envB = {
        ...process.env,
        OPENCLAW_CONFIG_PATH: configB,
        OPENCLAW_STATE_DIR: stateAlias,
      };
      const lock = expectGatewayLock(await acquireForTest(envA, { platform: "darwin" }));

      try {
        await expect(
          acquireForTest(envB, {
            platform: "darwin",
            readProcessCmdline: () => ["openclaw-gateway"],
            timeoutMs: 15,
          }),
        ).rejects.toBeInstanceOf(GatewayLockError);
      } finally {
        await lock.release();
      }
    },
  );

  it("records and reads the active runtime port from a verified gateway lock", async () => {
    const env = await makeEnv();
    const lock = expectGatewayLock(
      await acquireForTest(env, {
        platform: "darwin",
        port: 48789,
        readProcessCmdline: () => ["openclaw-gateway"],
      }),
    );

    try {
      await expect(
        readActiveGatewayLockPort({
          env,
          lockDir: resolveTestLockDir(),
          platform: "darwin",
          readProcessCmdline: () => ["openclaw-gateway"],
        }),
      ).resolves.toBe(48789);
    } finally {
      await lock.release();
    }
  });

  it("reads the active runtime port from state ownership without a config lock", async () => {
    const env = {
      ...(await makeEnv()),
      OPENCLAW_ALLOW_MULTI_GATEWAY: "1",
      VITEST: "",
    };
    const lock = expectGatewayLock(
      await acquireForTest(env, {
        platform: "darwin",
        port: 48789,
        readProcessCmdline: () => ["openclaw-gateway"],
      }),
    );

    try {
      const { lockPath } = resolveLockPath(env);
      await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readActiveGatewayLockPort({
          env,
          lockDir: resolveTestLockDir(),
          platform: "darwin",
          readProcessCmdline: () => ["openclaw-gateway"],
        }),
      ).resolves.toBe(48789);
    } finally {
      await lock.release();
    }
  });

  it("reads the active runtime port across configs that share a state directory", async () => {
    const envA = await makeEnv();
    const configB = path.join(resolveStateDir(envA), "gateway-b.json");
    await fs.writeFile(configB, "{}", "utf8");
    const envB = { ...envA, OPENCLAW_CONFIG_PATH: configB };
    const lock = expectGatewayLock(
      await acquireForTest(envA, {
        platform: "darwin",
        port: 48789,
        readProcessCmdline: () => ["openclaw-gateway"],
      }),
    );

    try {
      const { lockPath } = resolveLockPath(envB);
      await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readActiveGatewayLockPort({
          env: envB,
          lockDir: resolveTestLockDir(),
          platform: "darwin",
          readProcessCmdline: () => ["openclaw-gateway"],
        }),
      ).resolves.toBe(48789);
    } finally {
      await lock.release();
    }
  });

  it("keeps a retitled gateway lock owned during concurrent acquisition", async () => {
    const env = await makeEnv();
    const lock = expectGatewayLock(await acquireForTest(env, { platform: "darwin", port: 48789 }));
    const connectSpy = createPortProbeConnectionSpy("refused");

    try {
      await expect(
        acquireForTest(env, {
          platform: "darwin",
          port: 48789,
          timeoutMs: 15,
          readProcessCmdline: () => ["openclaw-gateway"],
        }),
      ).rejects.toBeInstanceOf(GatewayLockError);
      expect(connectSpy).not.toHaveBeenCalled();
    } finally {
      await lock.release();
    }
  });

  it("keeps a verified owner when a second gateway requests a different unbound port", async () => {
    const env = await makeEnv();
    const lock = expectGatewayLock(
      await acquireForTest(env, {
        platform: "darwin",
        port: 18789,
      }),
    );
    const connectSpy = createPortProbeConnectionSpy("refused");

    try {
      await expect(
        acquireForTest(env, {
          platform: "darwin",
          port: 28789,
          timeoutMs: 15,
          readProcessCmdline: () => ["openclaw-gateway"],
        }),
      ).rejects.toBeInstanceOf(GatewayLockError);
      expect(connectSpy).not.toHaveBeenCalled();
    } finally {
      connectSpy.mockRestore();
      await lock.release();
    }
  });

  it("keeps a live SQLite maintenance owner when the requested gateway port is free", async () => {
    const env = await makeEnv();
    const lock = expectGatewayLock(
      await acquireForTest(env, {
        ...({ role: "sqlite-maintenance" } as GatewayLockOptions),
        platform: "darwin",
      }),
    );
    const connectSpy = createPortProbeConnectionSpy("refused");

    try {
      await expect(
        acquireForTest(env, {
          platform: "darwin",
          port: 18789,
          timeoutMs: 15,
          readProcessCmdline: () => ["openclaw", "doctor", "--state-sqlite", "compact"],
        }),
      ).rejects.toBeInstanceOf(GatewayLockError);
      expect(connectSpy).not.toHaveBeenCalled();
    } finally {
      connectSpy.mockRestore();
      await lock.release();
    }
  });

  it("ignores active-port metadata when the lock owner cannot be verified", async () => {
    const env = await makeEnv();
    const { lockPath, configPath } = resolveLockPath(env);
    const payload = createLockPayload({ configPath, startTime: 111, port: 48789 });
    await fs.writeFile(lockPath, JSON.stringify(payload), "utf8");

    await expect(
      readActiveGatewayLockPort({
        env,
        lockDir: resolveTestLockDir(),
        platform: "darwin",
        readProcessCmdline: () => null,
      }),
    ).resolves.toBeUndefined();
  });

  it("treats recycled linux pid as stale when start time mismatches", async () => {
    const env = await makeEnv();
    const { lockPath, configPath } = resolveLockPath(env);
    const payload = createLockPayload({ configPath, startTime: 111 });
    await fs.writeFile(lockPath, JSON.stringify(payload), "utf8");

    const lock = await acquireForTest(env, {
      timeoutMs: 80,
      pollIntervalMs: 5,
      platform: "linux",
      readProcessStartTime: () => 222,
    });
    const acquiredLock = expectGatewayLock(lock);

    await acquiredLock.release();
  });

  it("serializes concurrent stale-lock reclamation", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    const { configPath, stateLockPath } = resolveLockPath(env);
    await fs.mkdir(path.dirname(stateLockPath), { recursive: true });
    await fs.writeFile(
      stateLockPath,
      JSON.stringify(createLockPayload({ configPath, startTime: 111 })),
      "utf8",
    );

    const attempts = await Promise.allSettled([
      acquireForTest(env, {
        platform: "linux",
        readProcessStartTime: () => 222,
        timeoutMs: 80,
      }),
      acquireForTest(env, {
        platform: "linux",
        readProcessStartTime: () => 222,
        timeoutMs: 25,
      }),
    ]);
    const acquired = attempts.filter(
      (result): result is PromiseFulfilledResult<GatewayLock> =>
        result.status === "fulfilled" && result.value !== null,
    );
    const rejected = attempts.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(acquired).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(GatewayLockError);
    await expect(fs.access(stateLockPath)).resolves.toBeUndefined();

    const acquiredResult = acquired[0];
    if (!acquiredResult) {
      throw new Error("Expected one successful stale-lock contender");
    }
    await acquiredResult.value.release();
    const nextLock = expectGatewayLock(await acquireForTest(env));
    await nextLock.release();
  });

  it("keeps lock on linux when proc access fails unless stale", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    const { stateLockPath } = resolveLockPath(env);
    await writeLockFile(env);
    const spy = createEaccesProcStatSpy();

    const pending = acquireForTest(env, {
      timeoutMs: 15,
      staleMs: 10_000,
      platform: "linux",
      readProcessCmdline: () => null,
    });
    await expect(pending).rejects.toBeInstanceOf(GatewayLockError);
    await expect(fs.access(stateLockPath)).rejects.toMatchObject({ code: "ENOENT" });

    spy.mockRestore();
  });

  it("keeps a verified maintenance owner when process start identity is unavailable", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    const { lockPath, configPath } = resolveLockPath(env);
    await fs.writeFile(
      lockPath,
      JSON.stringify(
        createLockPayload({
          configPath,
          createdAt: "2000-01-01T00:00:00.000Z",
          role: "sqlite-maintenance",
          startTime: 111,
        }),
      ),
      "utf8",
    );
    const spy = createEaccesProcStatSpy();

    try {
      await expect(
        acquireForTest(env, {
          timeoutMs: 15,
          staleMs: 0,
          platform: "linux",
          readProcessCmdline: () => [
            "node",
            "/srv/openclaw/openclaw.mjs",
            "doctor",
            "--state-sqlite",
            "compact",
          ],
        }),
      ).rejects.toBeInstanceOf(GatewayLockError);
    } finally {
      spy.mockRestore();
    }
  });

  it("reclaims a maintenance lock when its live pid belongs to another process", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    const { lockPath, configPath } = resolveLockPath(env);
    await fs.writeFile(
      lockPath,
      JSON.stringify(
        createLockPayload({
          configPath,
          role: "sqlite-maintenance",
          startTime: 111,
        }),
      ),
      "utf8",
    );
    const spy = createEaccesProcStatSpy();

    try {
      const lock = await acquireForTest(env, {
        platform: "linux",
        readProcessCmdline: () => ["node", "worker.js"],
        timeoutMs: 80,
      });
      await expectGatewayLock(lock).release();
    } finally {
      spy.mockRestore();
    }
  });

  it("reclaims a Windows maintenance lock when the pid creation time changed", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    const { lockPath, configPath } = resolveLockPath(env);
    await fs.writeFile(
      lockPath,
      JSON.stringify(
        createLockPayload({
          configPath,
          role: "sqlite-maintenance",
          startTime: 111,
        }),
      ),
      "utf8",
    );

    const lock = await acquireForTest(env, {
      platform: "win32",
      readProcessCmdline: () => ["openclaw", "doctor", "--state-sqlite", "compact"],
      readProcessStartTime: () => 222,
      timeoutMs: 80,
    });
    await expectGatewayLock(lock).release();
  });

  it("keeps a Windows maintenance lock when the pid creation time matches", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    const { lockPath, configPath } = resolveLockPath(env);
    await fs.writeFile(
      lockPath,
      JSON.stringify(
        createLockPayload({
          configPath,
          createdAt: "2000-01-01T00:00:00.000Z",
          role: "sqlite-maintenance",
          startTime: 111,
        }),
      ),
      "utf8",
    );

    await expect(
      acquireForTest(env, {
        platform: "win32",
        readProcessCmdline: () => ["node", "worker.js"],
        readProcessStartTime: () => 111,
        staleMs: 0,
        timeoutMs: 15,
      }),
    ).rejects.toBeInstanceOf(GatewayLockError);
  });

  it("fails closed for a recent maintenance owner with unreadable process identity", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    const { lockPath, configPath } = resolveLockPath(env);
    await fs.writeFile(
      lockPath,
      JSON.stringify(
        createLockPayload({
          configPath,
          role: "sqlite-maintenance",
          startTime: 111,
        }),
      ),
      "utf8",
    );
    const spy = createEaccesProcStatSpy();

    try {
      await expect(
        acquireForTest(env, {
          platform: "linux",
          readProcessCmdline: () => null,
          staleMs: 10_000,
          timeoutMs: 15,
        }),
      ).rejects.toBeInstanceOf(GatewayLockError);
    } finally {
      spy.mockRestore();
    }
  });

  it("ages out an old maintenance owner with unreadable process identity", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    const { lockPath, configPath } = resolveLockPath(env);
    await fs.writeFile(
      lockPath,
      JSON.stringify(
        createLockPayload({
          configPath,
          createdAt: "2000-01-01T00:00:00.000Z",
          role: "sqlite-maintenance",
          startTime: 111,
        }),
      ),
      "utf8",
    );
    const spy = createEaccesProcStatSpy();

    try {
      const lock = await acquireForTest(env, {
        platform: "linux",
        readProcessCmdline: () => null,
        staleMs: 0,
        timeoutMs: 80,
      });
      await expectGatewayLock(lock).release();
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps lock when fs.stat fails until payload is stale", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    await writeLockFile(env);
    const procSpy = createEaccesProcStatSpy();
    const statSpy = vi
      .spyOn(fs, "stat")
      .mockRejectedValue(Object.assign(new Error("EPERM"), { code: "EPERM" }));

    const pending = acquireForTest(env, {
      timeoutMs: 20,
      staleMs: 10_000,
      platform: "linux",
      readProcessCmdline: () => null,
    });
    await expect(pending).rejects.toBeInstanceOf(GatewayLockError);

    procSpy.mockRestore();
    statSpy.mockRestore();
  });

  it("reclaims a lock when its live pid belongs to a non-gateway process", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    await writeRecentLockFile(env);

    const lock = await acquireForTest(env, {
      timeoutMs: 80,
      pollIntervalMs: 5,
      staleMs: 10_000,
      platform: "darwin",
      port: 18789,
      readProcessCmdline: () => ["node", "worker.js"],
    });
    await expectGatewayLock(lock).release();
  });

  it("keeps lock when configured port is busy and owner pid is alive", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    await writeRecentLockFile(env);
    const connectSpy = createPortProbeConnectionSpy("connect");
    try {
      const pending = acquireForTest(env, {
        timeoutMs: 20,
        pollIntervalMs: 2,
        staleMs: 10_000,
        platform: "darwin",
        port: 18789,
        readProcessCmdline: () => ["/usr/local/bin/openclaw", "gateway", "run"],
      });
      await expect(pending).rejects.toBeInstanceOf(GatewayLockError);
    } finally {
      connectSpy.mockRestore();
    }
  });

  it("bounds oversized lock polling intervals by the acquire timeout", async () => {
    const env = await makeEnv();
    await writeRecentLockFile(env);
    const sleepDelays: number[] = [];
    let now = 0;

    await expect(
      acquireGatewayLock({
        env,
        allowInTests: true,
        timeoutMs: 5,
        pollIntervalMs: Number.MAX_SAFE_INTEGER,
        staleMs: 10_000,
        platform: "darwin",
        now: () => now,
        sleep: async (ms) => {
          sleepDelays.push(ms);
          now = 10;
        },
        lockDir: resolveTestLockDir(),
        readProcessCmdline: () => ["/usr/local/bin/openclaw", "gateway", "run"],
      }),
    ).rejects.toBeInstanceOf(GatewayLockError);

    expect(sleepDelays).toEqual([5]);
  });

  it("keeps state ownership when the config singleton override is enabled", async () => {
    const env = await makeEnv();
    const { lockPath, stateLockPath } = resolveLockPath(env);
    const lock = expectGatewayLock(
      await acquireGatewayLock({
        allowInTests: true,
        env: { ...env, OPENCLAW_ALLOW_MULTI_GATEWAY: "1", VITEST: "" },
        lockDir: resolveTestLockDir(),
      }),
    );

    try {
      expect(lock.lockPath).toBe(stateLockPath);
      await expect(fs.access(stateLockPath)).resolves.toBeUndefined();
      await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        acquireGatewayLock({
          allowInTests: true,
          env,
          lockDir: resolveTestLockDir(),
          platform: "darwin",
          readProcessCmdline: () => ["openclaw-gateway"],
          timeoutMs: 15,
        }),
      ).rejects.toBeInstanceOf(GatewayLockError);
    } finally {
      await lock.release();
    }
  });

  it("returns null in test env unless allowInTests is set", async () => {
    const env = await makeEnv();
    const lock = await acquireGatewayLock({
      env: { ...env, VITEST: "1" },
      lockDir: resolveTestLockDir(),
    });
    expect(lock).toBeNull();
  });

  it("falls back instead of throwing when lock payload clock is outside Date range", async () => {
    const env = await makeEnv();
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-30T12:00:00Z"));
    const lock = expectGatewayLock(
      await acquireGatewayLock({
        env,
        allowInTests: true,
        timeoutMs: 30,
        pollIntervalMs: 2,
        now: () => 8_640_000_000_000_001,
        sleep: async () => {},
        lockDir: resolveTestLockDir(),
      }),
    );

    try {
      const payload = JSON.parse(await fs.readFile(lock.lockPath, "utf8")) as {
        createdAt?: string;
      };
      expect(payload.createdAt).toBe("2026-05-30T12:00:00.000Z");
    } finally {
      dateNowSpy.mockRestore();
      await lock.release();
    }
  });

  it("wraps unexpected fs errors as GatewayLockError", async () => {
    const env = await makeEnv();
    const openSpy = vi.spyOn(fs, "open").mockRejectedValueOnce(
      Object.assign(new Error("denied"), {
        code: "EACCES",
      }),
    );

    await expect(acquireForTest(env)).rejects.toBeInstanceOf(GatewayLockError);
    openSpy.mockRestore();
  });

  it("closes handle and removes lock file when writeFile fails after open succeeds", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    const { stateLockPath } = resolveLockPath(env);

    const writeError = Object.assign(new Error("ENOSPC: no space left on device"), {
      code: "ENOSPC",
    });
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const mockHandle = {
      writeFile: vi.fn().mockImplementation(async () => {
        await fs.writeFile(stateLockPath, "partial", "utf8");
        throw writeError;
      }),
      close,
    };

    const openSpy = vi.spyOn(fs, "open").mockResolvedValueOnce(mockHandle as never);

    await expect(acquireForTest(env)).rejects.toMatchObject({
      name: "GatewayLockError",
      cause: writeError,
    });

    expect(close).toHaveBeenCalledTimes(1);
    await expect(fs.access(stateLockPath)).rejects.toMatchObject({ code: "ENOENT" });

    openSpy.mockRestore();
  });

  it("clears stale lock on win32 when process cmdline is not a gateway", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    await writeRecentLockFile(env);

    const connectSpy = createPortProbeConnectionSpy("connect");

    const lock = await acquireForTest(env, {
      timeoutMs: 80,
      pollIntervalMs: 5,
      staleMs: 10_000,
      platform: "win32",
      port: 18789,
      readProcessCmdline: () => ["chrome.exe", "--no-sandbox"],
      readProcessStartTime: () => null,
    });
    await expectGatewayLock(lock).release();

    connectSpy.mockRestore();
  });

  it("keeps lock on win32 when process cmdline is a gateway", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    await writeRecentLockFile(env);

    const connectSpy = createPortProbeConnectionSpy("connect");

    const pending = acquireForTest(env, {
      timeoutMs: 20,
      pollIntervalMs: 2,
      staleMs: 10_000,
      platform: "win32",
      port: 18789,
      readProcessCmdline: () => [
        "C:\\Users\\me\\AppData\\Roaming\\npm\\openclaw.cmd",
        "gateway",
        "run",
      ],
      readProcessStartTime: () => null,
    });
    await expect(pending).rejects.toBeInstanceOf(GatewayLockError);

    connectSpy.mockRestore();
  });

  it("falls back to unknown on win32 when cmdline reader returns null", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    await writeRecentLockFile(env);

    const connectSpy = createPortProbeConnectionSpy("connect");

    const pending = acquireForTest(env, {
      timeoutMs: 20,
      pollIntervalMs: 2,
      staleMs: 10_000,
      platform: "win32",
      port: 18789,
      readProcessCmdline: () => null,
      readProcessStartTime: () => null,
    });
    await expect(pending).rejects.toBeInstanceOf(GatewayLockError);

    connectSpy.mockRestore();
  });

  it("clears stale lock on darwin when process cmdline is not a gateway", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    await writeRecentLockFile(env);

    const connectSpy = createPortProbeConnectionSpy("connect");

    const lock = await acquireForTest(env, {
      timeoutMs: 80,
      pollIntervalMs: 5,
      staleMs: 10_000,
      platform: "darwin",
      port: 18789,
      readProcessCmdline: () => ["/Applications/Safari.app/Contents/MacOS/Safari"],
    });
    await expectGatewayLock(lock).release();

    connectSpy.mockRestore();
  });

  it("keeps lock on darwin when process cmdline is a gateway", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    await writeRecentLockFile(env);

    const connectSpy = createPortProbeConnectionSpy("connect");

    const pending = acquireForTest(env, {
      timeoutMs: 20,
      pollIntervalMs: 2,
      staleMs: 10_000,
      platform: "darwin",
      port: 18789,
      readProcessCmdline: () => ["/usr/local/bin/openclaw", "gateway", "run", "--port", "18789"],
    });
    await expect(pending).rejects.toBeInstanceOf(GatewayLockError);

    connectSpy.mockRestore();
  });
});
