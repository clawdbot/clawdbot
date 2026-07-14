/**
 * Tests managed-service update handoff behavior exposed by gateway methods.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { SUPERVISOR_HINT_ENV_VARS } from "./supervisor-markers.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "./update-control-plane-sentinel.js";
import {
  cleanupStaleManagedServiceUpdateHandoffs,
  MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX,
} from "./update-managed-service-handoff-cleanup.js";

const { forceKillChildProcessTreeMock, spawnMock } = vi.hoisted(() => ({
  forceKillChildProcessTreeMock: vi.fn(),
  spawnMock: vi.fn(),
}));

function createSpawnMock(params?: { pid?: number }) {
  const child = Object.assign(new EventEmitter(), {
    pid: params?.pid ?? 24680,
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    unref: vi.fn(),
  });
  return child;
}

function signalHandoffReady(child: ReturnType<typeof createSpawnMock>): void {
  child.stdout.write("OPENCLAW_UPDATE_HANDOFF_READY\n");
}

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
  spawnMock.mockImplementation(() => {
    const child = createSpawnMock();
    process.nextTick(() => {
      signalHandoffReady(child);
    });
    return child;
  });
});

afterEach(async () => {
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
  await Promise.all([...tempDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function writeRestartSentinelRow(env: NodeJS.ProcessEnv, sentinel: unknown): void {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const payload =
    sentinel && typeof sentinel === "object" && (sentinel as { version?: unknown }).version === 1
      ? (sentinel as { payload?: unknown }).payload
      : null;
  if (!payload || typeof payload !== "object") {
    throw new Error("expected versioned restart sentinel payload");
  }
  const record = payload as {
    kind?: unknown;
    status?: unknown;
    ts?: unknown;
    sessionKey?: unknown;
    threadId?: unknown;
    deliveryContext?: { channel?: unknown; to?: unknown; accountId?: unknown };
    message?: unknown;
    continuation?: unknown;
    doctorHint?: unknown;
    stats?: unknown;
  };
  executeSqliteQuerySync(
    db,
    stateDb.insertInto("gateway_restart_sentinel").values({
      sentinel_key: "current",
      version: 1,
      kind: typeof record.kind === "string" ? record.kind : "update",
      status: typeof record.status === "string" ? record.status : "skipped",
      ts: typeof record.ts === "number" ? record.ts : Date.now(),
      session_key: typeof record.sessionKey === "string" ? record.sessionKey : null,
      thread_id: typeof record.threadId === "string" ? record.threadId : null,
      delivery_channel:
        typeof record.deliveryContext?.channel === "string" ? record.deliveryContext.channel : null,
      delivery_to:
        typeof record.deliveryContext?.to === "string" ? record.deliveryContext.to : null,
      delivery_account_id:
        typeof record.deliveryContext?.accountId === "string"
          ? record.deliveryContext.accountId
          : null,
      message: typeof record.message === "string" ? record.message : null,
      continuation_json: record.continuation ? JSON.stringify(record.continuation) : null,
      doctor_hint: typeof record.doctorHint === "string" ? record.doctorHint : null,
      stats_json: record.stats ? JSON.stringify(record.stats) : null,
      payload_json: JSON.stringify(payload),
      updated_at_ms: Date.now(),
    }),
  );
}

function readRestartSentinelPayload(env: NodeJS.ProcessEnv): unknown {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("gateway_restart_sentinel")
      .select(["version", "payload_json"])
      .where("sentinel_key", "=", "current"),
  );
  return row ? { version: row.version, payload: JSON.parse(row.payload_json) } : null;
}

async function runHelperWithExistingSentinel(params: {
  handoffId?: string;
  metaHandoffId?: string;
  prepareStateDatabase?: (env: NodeJS.ProcessEnv) => Promise<void> | void;
  sentinel?: unknown;
}) {
  const { execFile } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const { startManagedServiceUpdateHandoff } = await import("./update-managed-service-handoff.js");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-helper-test-"));
  tempDirs.add(tmpDir);

  await startManagedServiceUpdateHandoff({
    root: tmpDir,
    timeoutMs: 1_800_000,
    restartDrainTimeoutMs: 300_000,
    restartDelayMs: 500,
    parentPid: process.pid,
    execPath: "/usr/local/bin/node",
    argv1: "/opt/openclaw/openclaw.mjs",
    ...(params.handoffId ? { handoffId: params.handoffId } : {}),
    env: {},
    meta: {
      ...(params.metaHandoffId ? { handoffId: params.metaHandoffId } : {}),
      sessionKey: "agent:test:webchat:dm:user-123",
      continuationMessage: "continue after restart",
    },
  });

  const [, args] = spawnMock.mock.calls.at(-1) as unknown as [
    string,
    string[],
    { env: NodeJS.ProcessEnv; detached?: boolean; cwd?: string },
  ];
  const helperScriptPath = args[0] ?? "";
  tempDirs.add(path.dirname(helperScriptPath));
  const helperParams = JSON.parse(await fs.readFile(args[1] ?? "", "utf-8")) as Record<
    string,
    unknown
  >;
  const env = { OPENCLAW_STATE_DIR: tmpDir } as NodeJS.ProcessEnv;
  await params.prepareStateDatabase?.(env);
  if (params.sentinel !== undefined) {
    writeRestartSentinelRow(env, params.sentinel);
  }
  const helperParamsPath = path.join(tmpDir, "helper-params.json");
  await fs.writeFile(
    helperParamsPath,
    `${JSON.stringify(
      {
        ...helperParams,
        parentPid: process.pid,
        parentExitTimeoutMs: 1,
        stateDatabasePath: resolveOpenClawStateSqlitePath(env),
        logPath: path.join(tmpDir, "handoff.log"),
        sensitivePaths: [],
      },
      null,
      2,
    )}\n`,
  );

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      execFile(process.execPath, [helperScriptPath, helperParamsPath], (err) => {
        const childError = err as (NodeJS.ErrnoException & { signal?: NodeJS.Signals }) | null;
        resolve({
          code: typeof childError?.code === "number" ? childError.code : 0,
          signal: childError?.signal ?? null,
        });
      });
    },
  );

  return { result, env };
}

async function createLegacyRestartSentinelTable(env: NodeJS.ProcessEnv): Promise<void> {
  const sqlite = await import("node:sqlite");
  const stateDatabasePath = resolveOpenClawStateSqlitePath(env);
  await fs.mkdir(path.dirname(stateDatabasePath), { recursive: true });
  const db = new sqlite.DatabaseSync(stateDatabasePath);
  try {
    db.exec(`
      CREATE TABLE gateway_restart_sentinel (
        sentinel_key TEXT NOT NULL PRIMARY KEY,
        version INTEGER NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        ts INTEGER NOT NULL,
        session_key TEXT,
        thread_id TEXT,
        payload_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
    `);
  } finally {
    db.close();
  }
}

async function spawnExitedPid(): Promise<number> {
  const { spawn } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid ?? 0;
    child.once("exit", () => resolve(pid));
  });
}

async function runHelperWithCommand(params: {
  commandArgv: string[];
  parentPid?: number;
  parentExitTimeoutMs?: number | null;
  serviceRecovery?: Record<string, unknown>;
  pathPrepend?: string;
}): Promise<{ code: number }> {
  const { execFile } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const { startManagedServiceUpdateHandoff } = await import("./update-managed-service-handoff.js");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-recovery-test-"));
  tempDirs.add(tmpDir);

  await startManagedServiceUpdateHandoff({
    root: tmpDir,
    timeoutMs: 1_800_000,
    restartDrainTimeoutMs: 300_000,
    restartDelayMs: 0,
    parentPid: process.pid,
    execPath: "/usr/local/bin/node",
    argv1: "/opt/openclaw/openclaw.mjs",
    env: {},
    meta: { sessionKey: "agent:test:webchat:dm:user-123" },
  });

  const [, args] = spawnMock.mock.calls.at(-1) as unknown as [string, string[]];
  const helperScriptPath = args[0] ?? "";
  tempDirs.add(path.dirname(helperScriptPath));
  const baseParams = JSON.parse(await fs.readFile(args[1] ?? "", "utf-8")) as Record<
    string,
    unknown
  >;

  const helperParamsPath = path.join(tmpDir, "helper-params.json");
  await fs.writeFile(
    helperParamsPath,
    `${JSON.stringify(
      {
        ...baseParams,
        parentPid: params.parentPid ?? (await spawnExitedPid()),
        parentExitTimeoutMs:
          params.parentExitTimeoutMs === undefined ? 5000 : params.parentExitTimeoutMs,
        cwd: tmpDir,
        commandArgv: params.commandArgv,
        stateDatabasePath: resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: tmpDir }),
        logPath: path.join(tmpDir, "handoff.log"),
        sensitivePaths: [],
        ...(params.serviceRecovery ? { serviceRecovery: params.serviceRecovery } : {}),
      },
      null,
      2,
    )}\n`,
  );

  const childEnv = {
    ...process.env,
    ...(params.pathPrepend
      ? { PATH: `${params.pathPrepend}${path.delimiter}${process.env.PATH ?? ""}` }
      : {}),
  };
  return await new Promise<{ code: number }>((resolve) => {
    execFile(process.execPath, [helperScriptPath, helperParamsPath], { env: childEnv }, (err) => {
      const childError = err as NodeJS.ErrnoException | null;
      resolve({ code: typeof childError?.code === "number" ? childError.code : 0 });
    });
  });
}

async function writeFakeSystemctl(): Promise<{ binDir: string; recordPath: string }> {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-recovery-bin-"));
  tempDirs.add(binDir);
  const recordPath = path.join(binDir, "systemctl-calls.log");
  await fs.writeFile(
    path.join(binDir, "systemctl"),
    `#!/bin/sh\necho "$@" >> '${recordPath}'\nexit 0\n`,
    { mode: 0o755 },
  );
  return { binDir, recordPath };
}

async function writeFakeLaunchctl(): Promise<{ binDir: string; recordPath: string }> {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-launchctl-bin-"));
  tempDirs.add(binDir);
  const recordPath = path.join(binDir, "launchctl-calls.log");
  const countPath = path.join(binDir, "launchctl-kickstart-count");
  await fs.writeFile(
    path.join(binDir, "launchctl"),
    `#!/bin/sh
echo "$@" >> '${recordPath}'
if [ "$1" = "kickstart" ]; then
  count=0
  if [ -f '${countPath}' ]; then
    count=$(cat '${countPath}')
  fi
  count=$((count + 1))
  echo "$count" > '${countPath}'
  [ "$count" -gt 1 ]
  exit $?
fi
[ "$1" = "enable" ] && exit 0
[ "$1" = "bootstrap" ] && exit 1
exit 1
`,
    { mode: 0o755 },
  );
  return { binDir, recordPath };
}

describe("managed service update handoff", () => {
  it("reports started only after the detached helper signals readiness", async () => {
    const child = createSpawnMock();
    spawnMock.mockReturnValueOnce(child);
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");

    const resultPromise = startManagedServiceUpdateHandoff({
      root: "/tmp/openclaw",
      restartDrainTimeoutMs: 300_000,
      parentPid: 12345,
      execPath: "/usr/local/bin/node",
      argv1: "/opt/openclaw/openclaw.mjs",
      meta: {},
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

    const pending = Symbol("pending");
    await expect(
      Promise.race([
        resultPromise,
        new Promise((resolve) => {
          setImmediate(() => resolve(pending));
        }),
      ]),
    ).resolves.toBe(pending);

    signalHandoffReady(child);
    await expect(resultPromise).resolves.toMatchObject({ status: "started", pid: 24680 });
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.stdout.destroyed).toBe(true);
  });

  it("rejects failed helper spawns and removes the sensitive handoff directory", async () => {
    const child = createSpawnMock();
    spawnMock.mockReturnValueOnce(child);
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");

    const resultPromise = startManagedServiceUpdateHandoff({
      root: "/tmp/openclaw",
      restartDrainTimeoutMs: 300_000,
      parentPid: 12345,
      execPath: "/definitely/missing/openclaw-node",
      argv1: "/opt/openclaw/openclaw.mjs",
      meta: { sessionKey: "agent:test:webchat:dm:user-123" },
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const [, args] = spawnMock.mock.calls[0] as unknown as [string, string[]];
    const handoffDir = path.dirname(args[0] ?? "");
    tempDirs.add(handoffDir);

    child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));

    await expect(resultPromise).rejects.toMatchObject({ code: "ENOENT" });
    expect(child.unref).not.toHaveBeenCalled();
    await expect(pathExists(handoffDir)).resolves.toBe(false);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.stdout.destroyed).toBe(true);
  });

  it("rejects a systemd-run launcher that exits before the helper is ready", async () => {
    const child = createSpawnMock();
    spawnMock.mockReturnValueOnce(child);
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-systemd-run-bin-"));
    tempDirs.add(binDir);
    await fs.writeFile(path.join(binDir, "systemd-run"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");

    const resultPromise = startManagedServiceUpdateHandoff({
      root: "/tmp/openclaw",
      restartDrainTimeoutMs: 300_000,
      parentPid: 12345,
      execPath: "/usr/local/bin/node",
      argv1: "/opt/openclaw/openclaw.mjs",
      supervisor: "systemd",
      env: { PATH: binDir, OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service" },
      meta: {},
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const [, args] = spawnMock.mock.calls[0] as unknown as [string, string[]];
    const handoffDir = path.dirname(args.at(-2) ?? "");
    tempDirs.add(handoffDir);

    child.emit("exit", 1, null);

    await expect(resultPromise).rejects.toThrow(
      "managed update handoff exited before signaling readiness (code=1, signal=null)",
    );
    expect(child.unref).not.toHaveBeenCalled();
    await expect(pathExists(handoffDir)).resolves.toBe(false);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.stdout.destroyed).toBe(true);
  });

  it("terminates a detached helper that misses the readiness deadline", async () => {
    vi.useFakeTimers();
    const child = createSpawnMock();
    spawnMock.mockReturnValueOnce(child);
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");

    const resultPromise = startManagedServiceUpdateHandoff({
      root: "/tmp/openclaw",
      restartDrainTimeoutMs: undefined,
      parentPid: 12345,
      execPath: "/usr/local/bin/node",
      argv1: "/opt/openclaw/openclaw.mjs",
      meta: {},
    });
    const rejection = resultPromise.catch((err: unknown) => err);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const [, args] = spawnMock.mock.calls[0] as unknown as [string, string[]];
    const handoffDir = path.dirname(args[0] ?? "");
    tempDirs.add(handoffDir);

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(rejection).resolves.toMatchObject({
      message: "managed update handoff did not signal readiness within 30 seconds",
    });
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
      root: "/tmp/openclaw",
      timeoutMs: 1_800_000,
      restartDrainTimeoutMs: 300_000,
      restartDelayMs: 500,
      parentPid: 12345,
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
      root: "/tmp/openclaw",
      timeoutMs: 1_800_000,
      restartDrainTimeoutMs: 300_000,
      restartDelayMs: 500,
      parentPid: 12345,
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

  it("serializes extended-stable into the detached CLI command", async () => {
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");

    const result = await startManagedServiceUpdateHandoff({
      root: "/tmp/openclaw",
      restartDrainTimeoutMs: 300_000,
      channel: "extended-stable",
      parentPid: 12345,
      execPath: "/usr/local/bin/node",
      argv1: "/opt/openclaw/openclaw.mjs",
      meta: {},
    });

    const spawnCall = spawnMock.mock.calls[0] as unknown as [string, string[]] | undefined;
    const args = spawnCall?.[1];
    const paramsPath = args?.[1];
    if (!paramsPath) {
      throw new Error("expected managed-service handoff params path");
    }
    tempDirs.add(path.dirname(paramsPath));
    const helperParams = JSON.parse(await fs.readFile(paramsPath, "utf-8")) as {
      commandArgv?: string[];
    };
    expect(helperParams.commandArgv).toEqual([
      "/usr/local/bin/node",
      "/opt/openclaw/openclaw.mjs",
      "update",
      "--yes",
      "--json",
      "--channel",
      "extended-stable",
    ]);
    expect(result.command).toContain("--channel extended-stable");
  });

  it("starts the managed gateway service when the update command fails after handoff", async () => {
    const { binDir, recordPath } = await writeFakeSystemctl();
    const result = await runHelperWithCommand({
      commandArgv: [process.execPath, "-e", "process.exit(7)"],
      serviceRecovery: { kind: "systemd", unit: "openclaw-gateway.service" },
      pathPrepend: binDir,
    });

    expect(result.code).toBe(7);
    await expect(fs.readFile(recordPath, "utf-8")).resolves.toBe(
      "--user start openclaw-gateway.service\n",
    );
  });

  it("leaves the gateway service alone when the update command succeeds", async () => {
    const { binDir, recordPath } = await writeFakeSystemctl();
    const result = await runHelperWithCommand({
      commandArgv: [process.execPath, "-e", "process.exit(0)"],
      serviceRecovery: { kind: "systemd", unit: "openclaw-gateway.service" },
      pathPrepend: binDir,
    });

    expect(result.code).toBe(0);
    await expect(pathExists(recordPath)).resolves.toBe(false);
  });

  it("retries launchd start when bootstrap reports an already-loaded label", async () => {
    const { binDir, recordPath } = await writeFakeLaunchctl();
    const result = await runHelperWithCommand({
      commandArgv: [process.execPath, "-e", "process.exit(7)"],
      serviceRecovery: {
        kind: "launchd",
        uid: 501,
        label: "com.example.openclaw",
        plistPath: "/Users/test/Library/LaunchAgents/com.example.openclaw.plist",
      },
      pathPrepend: binDir,
    });

    expect(result.code).toBe(7);
    await expect(fs.readFile(recordPath, "utf-8")).resolves.toBe(
      [
        "kickstart gui/501/com.example.openclaw",
        "enable gui/501/com.example.openclaw",
        "bootstrap gui/501 /Users/test/Library/LaunchAgents/com.example.openclaw.plist",
        "kickstart gui/501/com.example.openclaw",
        "",
      ].join("\n"),
    );
  });

  it("passes a gateway service recovery descriptor for each supervisor", async () => {
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");
    const cases = [
      {
        supervisor: "launchd" as const,
        env: { OPENCLAW_LAUNCHD_LABEL: "com.example.openclaw.test", HOME: "/Users/test" },
        expected: {
          kind: "launchd",
          uid: typeof process.getuid === "function" ? process.getuid() : 501,
          label: "com.example.openclaw.test",
          plistPath: "/Users/test/Library/LaunchAgents/com.example.openclaw.test.plist",
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
        root: "/tmp/openclaw",
        timeoutMs: 1_800_000,
        restartDrainTimeoutMs: 300_000,
        restartDelayMs: 500,
        parentPid: 12345,
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
    }
  });

  it("writes a fallback update failure when no restart sentinel row exists", async () => {
    const { result, env } = await runHelperWithExistingSentinel({
      handoffId: "handoff-123",
      metaHandoffId: "handoff-123",
    });

    expect(result).toEqual({ code: 1, signal: null });
    expect(readRestartSentinelPayload(env)).toMatchObject({
      version: 1,
      payload: {
        kind: "update",
        status: "error",
        sessionKey: "agent:test:webchat:dm:user-123",
        stats: {
          handoffId: "handoff-123",
          reason: "managed-service-handoff-parent-timeout",
        },
      },
    });
    if (process.platform !== "win32") {
      const mode = (await fs.stat(resolveOpenClawStateSqlitePath(env))).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("repairs legacy restart sentinel columns before writing fallback failures", async () => {
    const { result, env } = await runHelperWithExistingSentinel({
      handoffId: "handoff-123",
      metaHandoffId: "handoff-123",
      prepareStateDatabase: createLegacyRestartSentinelTable,
    });

    expect(result).toEqual({ code: 1, signal: null });
    expect(readRestartSentinelPayload(env)).toMatchObject({
      version: 1,
      payload: {
        kind: "update",
        status: "error",
        stats: {
          reason: "managed-service-handoff-parent-timeout",
        },
      },
    });
  });

  it("does not overwrite a restart sentinel owned by another startup task", async () => {
    const unrelatedSentinel = {
      version: 1,
      payload: {
        kind: "config",
        status: "skipped",
        message: "preserve this restart task",
        stats: { reason: "config-restart-pending" },
      },
    };
    const { result, env } = await runHelperWithExistingSentinel({
      sentinel: unrelatedSentinel,
    });

    expect(result).toEqual({ code: 1, signal: null });
    expect(readRestartSentinelPayload(env)).toEqual(unrelatedSentinel);
  });

  it("does not overwrite a newer pending update handoff sentinel", async () => {
    const newerSentinel = {
      version: 1,
      payload: {
        kind: "update",
        status: "skipped",
        message: "new handoff still pending",
        stats: {
          mode: "npm",
          handoffId: "newer-handoff",
          reason: "managed-service-handoff-started",
          steps: [],
          durationMs: 0,
        },
      },
    };
    const { result, env } = await runHelperWithExistingSentinel({
      handoffId: "old-handoff",
      metaHandoffId: "old-handoff",
      sentinel: newerSentinel,
    });

    expect(result).toEqual({ code: 1, signal: null });
    expect(readRestartSentinelPayload(env)).toEqual(newerSentinel);
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

  it("waits for the configured restart drain and shutdown reserve (#99666)", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-timeout-test-"));
    tempDirs.add(tmpDir);

    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");
    await startManagedServiceUpdateHandoff({
      root: tmpDir,
      timeoutMs: 1_800_000,
      restartDrainTimeoutMs: 60_000,
      restartDelayMs: 2_000,
      parentPid: process.pid,
      execPath: "/usr/local/bin/node",
      argv1: "/opt/openclaw/openclaw.mjs",
      env: {},
      meta: { sessionKey: "agent:test:webchat:dm:user-123" },
    });

    const [, args] = spawnMock.mock.calls.at(-1) as unknown as [string, string[]];
    const helperParams = JSON.parse(await fs.readFile(args[1] ?? "", "utf-8")) as Record<
      string,
      unknown
    >;

    expect(helperParams.parentExitTimeoutMs).toBe(92_000);
  });

  it("waits indefinitely when restart draining has no deadline", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-handoff-default-timeout-test-"),
    );
    tempDirs.add(tmpDir);

    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");
    await startManagedServiceUpdateHandoff({
      root: tmpDir,
      restartDrainTimeoutMs: undefined,
      restartDelayMs: 0,
      parentPid: process.pid,
      execPath: "/usr/local/bin/node",
      argv1: "/opt/openclaw/openclaw.mjs",
      env: {},
      meta: { sessionKey: "agent:test:webchat:dm:user-123" },
    });

    const [, args] = spawnMock.mock.calls.at(-1) as unknown as [string, string[]];
    const helperParams = JSON.parse(await fs.readFile(args[1] ?? "", "utf-8")) as Record<
      string,
      unknown
    >;

    expect(helperParams.parentExitTimeoutMs).toBeNull();
  });

  it("runs the handoff after an indefinitely awaited parent exits", async () => {
    const { spawn } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const parent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 750)"], {
      stdio: "ignore",
    });

    try {
      const result = await runHelperWithCommand({
        commandArgv: [process.execPath, "-e", ""],
        parentPid: parent.pid,
        parentExitTimeoutMs: null,
      });
      expect(result.code).toBe(0);
    } finally {
      parent.kill();
    }
  });
});
