/**
 * Tests managed-service update handoff behavior exposed by gateway methods.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFileLockProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import { writeRestartSentinel } from "./restart-sentinel.js";
import { SUPERVISOR_HINT_ENV_VARS } from "./supervisor-markers.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "./update-control-plane-sentinel.js";
import {
  cleanupStaleManagedServiceUpdateHandoffs,
  MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX,
} from "./update-managed-service-handoff-cleanup.js";
import {
  createManagedServiceLaunchdClockPreload,
  createManagedServiceManagerFixtureScript,
  createManagedServiceUpdateCommandFixture,
  registerManagedLaunchdHandoffRestorationTests,
  registerManagedSystemdHandoffConvergenceTests,
  waitForHandoffResponse,
  type ManagedServiceCommandTiming,
  type ManagedServiceManagerBoundaryOptions,
  type ManagedServiceManagerBoundaryResult,
} from "./update-managed-service-handoff-lifecycle.test-support.js";
import { signalMockManagedUpdateHandoffReady } from "./update-managed-service-handoff.test-support.js";

const { forceKillChildProcessTreeMock, spawnMock } = vi.hoisted(() => ({
  forceKillChildProcessTreeMock: vi.fn(),
  spawnMock: vi.fn(),
}));
const MOCK_INSTALL_ROOT = path.join(os.tmpdir(), `openclaw-handoff-lifecycle-${process.pid}`);

function createSpawnMock(params?: { pid?: number }) {
  const child = Object.assign(new EventEmitter(), {
    pid: params?.pid ?? process.pid,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    unref: vi.fn(),
  });
  return child;
}

const mockedHandoffLeaseCleanups = new Set<() => void>();

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessModule } =
    await import("../gateway/server-methods/node-child-process.test-support.js");
  return mockNodeChildProcessModule({
    spawn: spawnMock as unknown as typeof import("node:child_process").spawn,
  });
});

vi.mock("../process/child-process-tree.js", async () => {
  const actual = await vi.importActual<typeof import("../process/child-process-tree.js")>(
    "../process/child-process-tree.js",
  );
  return { ...actual, forceKillChildProcessTree: forceKillChildProcessTreeMock };
});

const tempDirs = new Set<string>();
type GatewayRestartSentinelDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_sentinel">;

beforeEach(() => {
  forceKillChildProcessTreeMock.mockReset();
  spawnMock.mockReset();
  spawnMock.mockImplementation((_command: string, args: string[]) => {
    const child = createSpawnMock();
    process.nextTick(() => {
      signalMockManagedUpdateHandoffReady({
        child,
        paramsPath: args.at(-1) ?? "",
        cleanups: mockedHandoffLeaseCleanups,
      });
    });
    return child;
  });
});

afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of mockedHandoffLeaseCleanups) {
    cleanup();
  }
  closeOpenClawStateDatabaseForTest();
  await Promise.all([...tempDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
  vi.resetModules();
});

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function readRestartSentinelPayload(env: NodeJS.ProcessEnv, key = "current"): unknown {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("gateway_restart_sentinel")
      .select(["version", "payload_json", "updated_at_ms"])
      .where("sentinel_key", "=", key),
  );
  return row
    ? { version: row.version, payload: JSON.parse(row.payload_json), revision: row.updated_at_ms }
    : null;
}

async function runManagedServiceManagerBoundary(
  kind: "systemd" | "launchd",
  options?: ManagedServiceManagerBoundaryOptions,
): Promise<ManagedServiceManagerBoundaryResult> {
  const { spawn } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const { startManagedServiceUpdateHandoff } = await import("./update-managed-service-handoff.js");
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-${kind}-manager-boundary-`)),
  );
  tempDirs.add(root);
  const commandsPath = path.join(root, "manager-commands.log");
  const statePath = path.join(root, "manager-state.json");
  const updaterPath = path.join(root, "updater-ran");
  const commandTimingsPath = path.join(root, "manager-command-timings.jsonl");
  const parent = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  const parentPid = parent.pid;
  const parentStartIdentity = parentPid ? getFileLockProcessStartTime(parentPid) : null;
  if (!parentPid || parentStartIdentity === null) {
    parent.kill("SIGKILL");
    throw new Error("expected the managed Gateway parent to have a stable process identity");
  }
  await fs.writeFile(
    path.join(root, kind === "systemd" ? "systemctl" : "launchctl"),
    createManagedServiceManagerFixtureScript({
      kind,
      parentPid,
      statePath,
      commandsPath,
      options,
    }),
    {
      mode: 0o755,
    },
  );
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: root,
    PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  let helper: import("node:child_process").ChildProcess | undefined;
  try {
    await startManagedServiceUpdateHandoff({
      root,
      restartDrainTimeoutMs: 300_000,
      parentPid,
      execPath: process.execPath,
      argv1: process.argv[1],
      handoffId: `${kind}-boundary`,
      env,
      meta: { handoffId: `${kind}-boundary` },
    });
    const [, generatedArgs] = spawnMock.mock.calls.at(-1) as [string, string[]];
    const scriptPath = generatedArgs[0];
    const generatedParamsPath = generatedArgs[1];
    if (!scriptPath || !generatedParamsPath) {
      throw new Error("expected generated managed handoff script and parameters");
    }
    const generated = JSON.parse(await fs.readFile(generatedParamsPath, "utf8")) as Record<
      string,
      unknown
    >;
    const mockedChild = spawnMock.mock.results.at(-1)?.value as ReturnType<typeof createSpawnMock>;
    mockedChild.emit("exit", 0, null);
    tempDirs.add(path.dirname(scriptPath));
    const paramsPath = path.join(root, "manager-helper.json");
    await fs.writeFile(
      paramsPath,
      JSON.stringify({
        ...generated,
        parentPid,
        parentStartIdentity: String(parentStartIdentity),
        ...(options?.parentExitTimeoutMs === undefined
          ? {}
          : {
              parentExitDeadlineAt: Date.now() + options.parentExitTimeoutMs,
              parentExitTimeoutMs: options.parentExitTimeoutMs,
            }),
        ...(options?.overdueCommit ? { parentExitDeadlineAt: Date.now() - 1 } : {}),
        ...(options?.systemdHandoffDeadlineMs === undefined
          ? {}
          : { parentExitDeadlineAt: Date.now() + options.systemdHandoffDeadlineMs }),
        ...createManagedServiceUpdateCommandFixture({
          kind,
          root,
          statePath,
          updaterPath,
          stateDatabasePath: String(generated.stateDatabasePath),
          options,
        }),
        ...(options?.recoveryHang ? { recoveryTimeoutMs: 1000 } : {}),
        sensitivePaths: [],
      }),
    );
    if (options?.recoverySentinel) {
      await writeRestartSentinel(
        {
          kind: "update",
          status: "error",
          ts: Date.now(),
          stats: { reason: "build failed", handoffId: `${kind}-boundary`, steps: [] },
        },
        env,
      );
    }
    let helperEnv: NodeJS.ProcessEnv = env;
    if (options?.launchdTeardown?.clockEachCommandMs) {
      const preloadPath = path.join(root, "launchd-clock-preload.cjs");
      await fs.writeFile(
        preloadPath,
        createManagedServiceLaunchdClockPreload({
          commandTimingsPath,
          clockEachCommandMs: options.launchdTeardown.clockEachCommandMs,
        }),
      );
      helperEnv = { ...env, NODE_OPTIONS: `--require ${preloadPath}` };
    }
    const runningHelper = spawn(process.execPath, [scriptPath, paramsPath], {
      env: helperEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    helper = runningHelper;
    let stdout = "";
    runningHelper.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    let stderr = "";
    runningHelper.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const completion = new Promise<number | null>((resolve, reject) => {
      runningHelper.once("error", reject);
      runningHelper.once("close", resolve);
    });
    await waitForHandoffResponse(runningHelper.stdout, "OPENCLAW_UPDATE_HANDOFF_READY");

    const databasePath = String(generated.updateLeaseDatabasePath);
    const owner = String(generated.updateLeaseOwner);
    const readLease = (): Record<string, unknown> | null => {
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const row = db
          .prepare(
            "SELECT payload_json FROM managed_update_handoffs WHERE install_root = ? AND owner = ?",
          )
          .get(root, owner) as { payload_json: string } | undefined;
        return row ? (JSON.parse(row.payload_json) as Record<string, unknown>) : null;
      } finally {
        db.close();
      }
    };
    expect(readLease()).toEqual({
      version: 1,
      pid: runningHelper.pid,
      startIdentity: expect.any(String),
    });
    await expect(pathExists(commandsPath)).resolves.toBe(false);
    if (options?.parentExitTimeoutMs !== undefined) {
      const timeout = options.parentExitTimeoutMs + (options.launchdTeardown ? 8_000 : 3_000);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        expect(
          await Promise.race([
            completion,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error("managed helper did not restore the stalled parent")),
                timeout,
              );
            }),
          ]),
          stderr,
        ).toBe(0);
      } finally {
        clearTimeout(timer);
      }
      expect(parent.signalCode).toBe("SIGKILL");
      expect(stdout).not.toContain("committed\n");
      await expect(pathExists(updaterPath)).resolves.toBe(false);
    } else if (options?.launchdFault === "wrong-parent") {
      const cancelled = waitForHandoffResponse(runningHelper.stdout, "cancelled");
      runningHelper.stdin?.write("park\n");
      await cancelled;
      expect(await completion, stderr).toBe(0);
      expect(parent.exitCode).toBeNull();
      expect(parent.signalCode).toBeNull();
      await expect(pathExists(updaterPath)).resolves.toBe(false);
    } else if (options?.overdueCommit) {
      const cancelled = waitForHandoffResponse(runningHelper.stdout, "cancelled");
      runningHelper.stdin?.write("park\n");
      await cancelled;
      expect(await completion, stderr).toBe(0);
      expect(parent.exitCode).toBeNull();
      expect(parent.signalCode).toBeNull();
      await expect(pathExists(updaterPath)).resolves.toBe(false);
    } else {
      const parked = waitForHandoffResponse(runningHelper.stdout, "parked");
      runningHelper.stdin?.write("park\n");
      await parked;
      expect(parent.exitCode).toBeNull();
      await expect(pathExists(updaterPath)).resolves.toBe(false);
      if (options?.cancelAfterPark) {
        const restoring = waitForHandoffResponse(runningHelper.stdout, "restore-after-exit");
        runningHelper.stdin?.write("cancel\n");
        await restoring;
        expect(stdout).not.toContain("committed\n");
        parent.stdin?.end();
        expect(await completion, stderr).toBe(0);
        await expect(pathExists(updaterPath)).resolves.toBe(false);
      } else {
        const committed = waitForHandoffResponse(runningHelper.stdout, "committed");
        runningHelper.stdin?.write("commit\n");
        await committed;
        parent.stdin?.end();
        const code = await completion;
        const helperLog = await fs.readFile(String(generated.logPath), "utf8").catch(() => "");
        expect(code, `${stderr}\n${helperLog}`).toBe(
          options?.systemdHandoffFailure || options?.updaterSignal || options?.updaterExitCode !== 0
            ? 1
            : 0,
        );
        await expect(pathExists(updaterPath)).resolves.toBe(!options?.systemdHandoffFailure);
      }
    }
    expect(readLease()).toBeNull();
    return {
      commands: (await fs.readFile(commandsPath, "utf8")).trim().split("\n"),
      parentSignal: parent.signalCode,
      state: JSON.parse(await fs.readFile(statePath, "utf8")) as Record<string, unknown>,
      sentinel: readRestartSentinelPayload({ OPENCLAW_STATE_DIR: root }),
      commandTimings: (await fs.readFile(commandTimingsPath, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ManagedServiceCommandTiming),
    };
  } finally {
    parent.stdin?.end();
    if (helper && helper.exitCode === null && helper.signalCode === null) {
      helper.kill("SIGKILL");
    }
  }
}

describe("managed service update handoff", () => {
  const itUnix = it.runIf(process.platform !== "win32");

  it("rejects failed helper spawns and removes the sensitive handoff directory", async () => {
    const child = createSpawnMock();
    // Fire after spawn installs readiness listeners; preparation has no one-second deadline.
    spawnMock.mockImplementationOnce(() => {
      process.nextTick(() => {
        child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
      });
      return child;
    });
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");

    const resultPromise = startManagedServiceUpdateHandoff({
      root: MOCK_INSTALL_ROOT,
      restartDrainTimeoutMs: 300_000,
      parentPid: process.pid,
      execPath: "/definitely/missing/openclaw-node",
      argv1: "/opt/openclaw/openclaw.mjs",
      meta: { sessionKey: "agent:test:webchat:dm:user-123" },
    });
    await expect(resultPromise).rejects.toMatchObject({ code: "ENOENT" });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0] as unknown as [string, string[]];
    const handoffDir = path.dirname(args[0] ?? "");
    tempDirs.add(handoffDir);

    expect(child.unref).not.toHaveBeenCalled();
    await expect(pathExists(handoffDir)).resolves.toBe(false);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.stdout.destroyed).toBe(true);
  });

  it("rejects a systemd-run launcher that exits before the helper is ready", async () => {
    const child = createSpawnMock();
    spawnMock.mockImplementationOnce(() => {
      process.nextTick(() => child.emit("exit", 1, null));
      return child;
    });
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-systemd-run-bin-"));
    tempDirs.add(binDir);
    await fs.writeFile(path.join(binDir, "systemd-run"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");

    const resultPromise = startManagedServiceUpdateHandoff({
      root: MOCK_INSTALL_ROOT,
      restartDrainTimeoutMs: 300_000,
      parentPid: process.pid,
      execPath: "/usr/local/bin/node",
      argv1: "/opt/openclaw/openclaw.mjs",
      supervisor: "systemd",
      env: { PATH: binDir, OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service" },
      meta: {},
    });
    await expect(resultPromise).rejects.toThrow(
      "managed update handoff exited before signaling readiness (code=1, signal=null)",
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0] as unknown as [string, string[]];
    const handoffDir = path.dirname(args.at(-2) ?? "");
    tempDirs.add(handoffDir);

    expect(child.unref).not.toHaveBeenCalled();
    await expect(pathExists(handoffDir)).resolves.toBe(false);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.stdout.destroyed).toBe(true);
  });

  it("terminates a detached helper that misses the readiness deadline", async () => {
    vi.useFakeTimers();
    const child = createSpawnMock();
    spawnMock.mockImplementationOnce(() => {
      // The readiness timer is armed after spawn returns, not during filesystem preparation.
      process.nextTick(() => vi.advanceTimersByTime(30_000));
      return child;
    });
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");

    const resultPromise = startManagedServiceUpdateHandoff({
      root: MOCK_INSTALL_ROOT,
      restartDrainTimeoutMs: 300_000,
      parentPid: process.pid,
      execPath: "/usr/local/bin/node",
      argv1: "/opt/openclaw/openclaw.mjs",
      meta: {},
    });
    await expect(resultPromise).rejects.toMatchObject({
      message: "managed update handoff did not signal readiness within 30 seconds",
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0] as unknown as [string, string[]];
    const handoffDir = path.dirname(args[0] ?? "");
    tempDirs.add(handoffDir);

    expect(forceKillChildProcessTreeMock).toHaveBeenCalledExactlyOnceWith(child);
    expect(child.unref).not.toHaveBeenCalled();
    await expect(pathExists(handoffDir)).resolves.toBe(false);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.stdout.destroyed).toBe(true);
  });

  it("strips supervisor hints while preserving service identity for the CLI handoff", async () => {
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");
    const serviceIdentityEnv = {
      OPENCLAW_LAUNCHD_LABEL: "com.example.openclaw.test",
      OPENCLAW_SYSTEMD_UNIT: "openclaw-test.service",
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Test Gateway",
    } satisfies NodeJS.ProcessEnv;
    const supervisorEnv = Object.fromEntries(
      SUPERVISOR_HINT_ENV_VARS.map((key) => [key, "supervised"]),
    ) as NodeJS.ProcessEnv;

    const result = await startManagedServiceUpdateHandoff({
      root: MOCK_INSTALL_ROOT,
      timeoutMs: 1_800_000,
      restartDrainTimeoutMs: 300_000,
      restartDelayMs: 500,
      parentPid: process.pid,
      execPath: "/usr/local/bin/node",
      argv1: "/opt/openclaw/openclaw.mjs",
      env: {
        ...supervisorEnv,
        ...serviceIdentityEnv,
        KEEP_ME: "1",
      },
      meta: {
        sessionKey: "agent:test:webchat:dm:user-123",
        continuationMessage: "continue after restart",
      },
    });

    expect(result.status).toBe("started");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args, options] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    tempDirs.add(path.dirname(args[0] ?? result.logPath));
    const helperParams = JSON.parse(await fs.readFile(args[1] ?? "", "utf-8")) as {
      metaPath?: string;
    };
    expect(options.env.KEEP_ME).toBe("1");
    for (const [key, value] of Object.entries(serviceIdentityEnv)) {
      expect(options.env[key]).toBe(value);
    }
    for (const key of SUPERVISOR_HINT_ENV_VARS.filter(
      (envKey) => !(envKey in serviceIdentityEnv),
    )) {
      expect(options.env[key]).toBeUndefined();
    }
    expect(options.env.OPENCLAW_UPDATE_RUN_HANDOFF).toBe("1");
    expect(options.env[CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]).toBe(helperParams.metaPath);
  });

  it("launches systemd handoffs through a transient user scope", async () => {
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-systemd-run-bin-"));
    tempDirs.add(binDir);
    const systemdRunPath = path.join(binDir, "systemd-run");
    await fs.writeFile(systemdRunPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const result = await startManagedServiceUpdateHandoff({
      root: MOCK_INSTALL_ROOT,
      timeoutMs: 1_800_000,
      restartDrainTimeoutMs: 300_000,
      restartDelayMs: 500,
      parentPid: process.pid,
      execPath: "/usr/local/bin/node",
      argv1: "/opt/openclaw/openclaw.mjs",
      handoffId: "handoff-123",
      channel: "beta",
      supervisor: "systemd",
      env: {
        PATH: binDir,
        OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service",
        INVOCATION_ID: "gateway-invocation",
        KEEP_ME: "1",
      },
      meta: {
        handoffId: "handoff-123",
        sessionKey: "agent:test:webchat:dm:user-123",
        continuationMessage: "continue after restart",
      },
    });

    expect(result.status).toBe("started");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv; detached?: boolean; cwd?: string },
    ];
    expect(command).toBe(systemdRunPath);
    expect(args.slice(0, 4)).toEqual([
      "--user",
      "--scope",
      "--collect",
      "--unit=openclaw-update-handoff-123.scope",
    ]);
    expect(args.slice(4, 7)).toEqual([
      "/usr/local/bin/node",
      expect.stringMatching(/handoff\.cjs$/u),
      expect.stringMatching(/handoff\.json$/u),
    ]);
    tempDirs.add(path.dirname(args[5] ?? result.logPath));
    const helperParams = JSON.parse(await fs.readFile(args[6] ?? "", "utf-8")) as {
      commandArgv?: string[];
      handoffId?: string;
      serviceRecovery?: unknown;
    };
    expect(helperParams.serviceRecovery).toEqual({
      kind: "systemd",
      unit: "openclaw-gateway.service",
    });
    expect(helperParams.commandArgv).toEqual([
      "/usr/local/bin/node",
      "/opt/openclaw/openclaw.mjs",
      "update",
      "--yes",
      "--json",
      "--channel",
      "beta",
      "--timeout",
      "1800",
    ]);
    expect(helperParams.handoffId).toBe("handoff-123");
    expect(options.detached).toBe(true);
    expect(options.env.OPENCLAW_SYSTEMD_UNIT).toBe("openclaw-gateway.service");
    expect(options.env.INVOCATION_ID).toBeUndefined();
    expect(options.env.KEEP_ME).toBe("1");
    expect(options.env.OPENCLAW_UPDATE_RUN_HANDOFF).toBe("1");
  });

  itUnix("parks and restores the exact user-systemd service from its detached helper", async () => {
    const { commands, sentinel, state } = await runManagedServiceManagerBoundary("systemd");
    const verbs = commands.map((command) =>
      command.split(" ").find((part) => ["show", "stop", "reset-failed", "start"].includes(part)),
    );

    expect(verbs).toEqual(["show", "stop", "show", "reset-failed", "start", "show"]);
    expect(commands.every((command) => command.startsWith("--user "))).toBe(true);
    expect(commands[0]).toContain(
      "--property=Id,LoadState,ActiveState,MainPID,ExecMainStartTimestampMonotonic,InvocationID",
    );
    expect(commands[1]).toContain("stop openclaw-gateway.service");
    expect(state).toMatchObject({ parked: true, reset: true, restored: true });
    expect(state.guardedRestart).toEqual(["gateway", "restart", "--preserve-definition", "--json"]);
    expect(sentinel).toMatchObject({
      payload: {
        status: "error",
        stats: {
          reason: "managed-service-handoff-failed",
          steps: expect.arrayContaining([
            expect.objectContaining({ name: "service-restore", log: { exitCode: 0 } }),
          ]),
        },
      },
    });
  });

  registerManagedSystemdHandoffConvergenceTests(runManagedServiceManagerBoundary, itUnix, expect);

  itUnix.each([
    { kind: "systemd", updaterExitCode: 1 },
    { kind: "launchd", updaterExitCode: 1 },
    { kind: "systemd", updaterExitCode: 78 },
    { kind: "launchd", updaterExitCode: 78 },
    { kind: "systemd", updaterSignal: "SIGKILL" },
    { kind: "launchd", updaterSignal: "SIGKILL" },
  ] as const)(
    "keeps $kind parked after an unverified updater failure ($updaterExitCode, $updaterSignal)",
    async ({ kind, ...options }) => {
      const { commands, sentinel, state } = await runManagedServiceManagerBoundary(kind, options);

      expect(state.parked).toBe(true);
      expect(state.restored).toBeUndefined();
      expect(
        commands.some((command) => /(?:^| )(?:start|enable|bootstrap|kickstart) /.test(command)),
      ).toBe(false);
      expect(sentinel).toMatchObject({
        payload: {
          status: "error",
          stats: { reason: "managed-service-handoff-failed", steps: [] },
        },
      });
    },
  );

  itUnix.each(["systemd", "launchd"] as const)(
    "does not treat the former negative recovery exit as permission to restart %s",
    async (kind) => {
      const { commands, sentinel, state } = await runManagedServiceManagerBoundary(kind, {
        updaterExitCode: 79,
      });

      expect(state.parked).toBe(true);
      expect(state.restored).toBeUndefined();
      expect(
        commands.some((command) => /(?:^| )(?:start|enable|bootstrap|kickstart) /.test(command)),
      ).toBe(false);
      expect(sentinel).toMatchObject({
        payload: {
          status: "error",
          stats: { reason: "managed-service-handoff-failed", steps: [] },
        },
      });
    },
  );

  itUnix.each(["systemd", "launchd"] as const)(
    "keeps %s parked when the installed CLI refuses a verified recovery restart",
    async (kind) => {
      const { commands, sentinel, state } = await runManagedServiceManagerBoundary(kind, {
        recoveryExitCode: 1,
      });
      expect(state.guardedRestart).toEqual([
        "gateway",
        "restart",
        "--preserve-definition",
        "--json",
      ]);
      expect(state.restored).toBeUndefined();
      expect(
        commands.some((command) => /(?:^| )(?:start|enable|bootstrap|kickstart) /.test(command)),
      ).toBe(false);
      expect(sentinel).toMatchObject({
        payload: {
          status: "error",
          stats: {
            reason: "managed-service-handoff-failed",
            steps: [expect.objectContaining({ name: "service-restore", log: { exitCode: 1 } })],
          },
        },
      });
    },
  );

  itUnix("bounds a stalled recovery command and terminates its descendants", async () => {
    const { state, sentinel } = await runManagedServiceManagerBoundary("systemd", {
      recoveryHang: true,
    });
    expect(state.guardedRestart).toEqual(["gateway", "restart", "--preserve-definition", "--json"]);
    expect(state.restored).toBeUndefined();
    expect(typeof state.recoveryDescendantPid).toBe("number");
    await expect.poll(() => isPidAlive(Number(state.recoveryDescendantPid))).toBe(false);
    expect(sentinel).toMatchObject({
      payload: {
        status: "error",
        stats: {
          reason: "managed-service-handoff-failed",
          steps: [expect.objectContaining({ name: "service-restore", log: { exitCode: 1 } })],
        },
      },
    });
  });

  itUnix.each([
    { recoverySentinel: "retained", recoveryExitCode: 0 },
    { recoverySentinel: "retained", recoveryExitCode: 1 },
    { recoverySentinel: "consumed", recoveryExitCode: 0 },
    { recoverySentinel: "replaced", recoveryExitCode: 0 },
  ] as const)(
    "preserves the updater notification when recovery leaves it $recoverySentinel (exit $recoveryExitCode)",
    async (options) => {
      const { sentinel, state } = await runManagedServiceManagerBoundary("systemd", options);
      expect(state.sentinelAtRecovery).toMatchObject({
        status: "error",
        stats: { reason: "build failed", handoffId: "systemd-boundary", steps: [] },
      });
      if (options.recoverySentinel === "consumed") {
        expect(sentinel).toBeNull();
      } else {
        expect(sentinel).toMatchObject({
          payload: {
            status: "error",
            stats: {
              reason:
                options.recoverySentinel === "replaced" ? "newer update failure" : "build failed",
              steps:
                options.recoverySentinel === "replaced"
                  ? []
                  : [
                      expect.objectContaining({
                        name: "service-restore",
                        log: { exitCode: options.recoveryExitCode },
                      }),
                    ],
            },
          },
        });
      }
    },
  );

  itUnix("rejects an overdue commit before its delayed deadline callback executes", async () => {
    const { commands, parentSignal, sentinel, state } = await runManagedServiceManagerBoundary(
      "systemd",
      { overdueCommit: true },
    );

    expect(parentSignal).toBeNull();
    expect(
      commands.filter((command) => command.includes("stop openclaw-gateway.service")),
    ).toHaveLength(0);
    expect(
      commands.filter((command) => command.includes("start openclaw-gateway.service")),
    ).toHaveLength(0);
    expect(state).toEqual({});
    expect(sentinel).toMatchObject({
      payload: {
        status: "error",
        stats: { reason: "managed-service-handoff-cancelled", steps: [] },
      },
    });
  });

  itUnix.each([
    ["cannot restart", "start-failed", { startFailed: true }],
    ["reports a dead replacement PID", "dead-restored-pid", { restored: true }],
  ] as const)(
    "records one durable failure when the canonical systemd service %s",
    async (_label, systemdFault, expectedState) => {
      const { commands, parentSignal, sentinel, state } = await runManagedServiceManagerBoundary(
        "systemd",
        { cancelAfterPark: true, systemdFault },
      );

      expect(parentSignal).toBeNull();
      expect(commands.filter((command) => command.includes("reset-failed"))).toHaveLength(1);
      expect(
        commands.filter((command) => command.includes("start openclaw-gateway.service")),
      ).toHaveLength(1);
      expect(state).toMatchObject({ parked: true, reset: true, ...expectedState });
      expect(sentinel).toMatchObject({
        payload: {
          status: "error",
          stats: {
            reason: "managed-service-handoff-restore-failed",
            steps: expect.arrayContaining([
              expect.objectContaining({ name: "service-restore", log: { exitCode: 1 } }),
            ]),
          },
        },
      });
    },
  );

  registerManagedLaunchdHandoffRestorationTests(runManagedServiceManagerBoundary, itUnix, expect);

  it("passes a gateway service recovery descriptor for each supervisor", async () => {
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");
    const cases = [
      {
        supervisor: "launchd" as const,
        env: { OPENCLAW_LAUNCHD_LABEL: "test.gateway", HOME: "/Users/test" },
        expected: {
          kind: "launchd",
          uid: typeof process.getuid === "function" ? process.getuid() : 501,
          label: "test.gateway",
          plistPath: path.posix.join(
            "/Users/test",
            "Library",
            "LaunchAgents",
            "test.gateway.plist",
          ),
        },
      },
      {
        supervisor: "schtasks" as const,
        env: { OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Test Gateway" },
        expected: { kind: "schtasks", taskName: "OpenClaw Test Gateway" },
      },
    ];

    for (const testCase of cases) {
      const result = await startManagedServiceUpdateHandoff({
        root: MOCK_INSTALL_ROOT,
        timeoutMs: 1_800_000,
        restartDrainTimeoutMs: 300_000,
        restartDelayMs: 500,
        parentPid: process.pid,
        execPath: "/usr/local/bin/node",
        argv1: "/opt/openclaw/openclaw.mjs",
        supervisor: testCase.supervisor,
        env: testCase.env,
        meta: { sessionKey: "agent:test:webchat:dm:user-123" },
      });
      expect(result.status).toBe("started");
      const [, args] = spawnMock.mock.calls.at(-1) as unknown as [string, string[]];
      tempDirs.add(path.dirname(args[0] ?? ""));
      const helperParams = JSON.parse(await fs.readFile(args[1] ?? "", "utf-8")) as {
        serviceRecovery?: unknown;
      };
      expect(helperParams.serviceRecovery).toEqual(testCase.expected);
      const child = spawnMock.mock.results.at(-1)?.value as
        | ReturnType<typeof createSpawnMock>
        | undefined;
      child?.emit("exit", 0, null);
    }
  });

  it("sweeps stale handoff temp directories while keeping fresh handoff logs", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-cleanup-test-"));
    tempDirs.add(tmpDir);
    const staleDir = path.join(tmpDir, `${MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX}stale`);
    const freshDir = path.join(tmpDir, `${MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX}fresh`);
    const unrelatedDir = path.join(tmpDir, "openclaw-other-temp");
    await fs.mkdir(staleDir, { recursive: true });
    await fs.mkdir(freshDir, { recursive: true });
    await fs.mkdir(unrelatedDir, { recursive: true });
    const now = Date.now();
    const staleTime = new Date(now - 25 * 60 * 60_000);
    await fs.utimes(staleDir, staleTime, staleTime);

    await expect(
      cleanupStaleManagedServiceUpdateHandoffs({
        tmpDir,
        nowMs: now,
        ttlMs: 24 * 60 * 60_000,
      }),
    ).resolves.toBe(1);

    await expect(pathExists(staleDir)).resolves.toBe(false);
    await expect(pathExists(freshDir)).resolves.toBe(true);
    await expect(pathExists(unrelatedDir)).resolves.toBe(true);
  });
});
