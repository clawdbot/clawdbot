/**
 * Tests externally owned state behavior in the detached managed-service update helper.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { claimOpenClawStateOwnership } from "../state/openclaw-state-ownership-operations.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { signalMockManagedUpdateHandoffReady } from "./update-managed-service-handoff.test-support.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

function createSpawnMock() {
  return Object.assign(new EventEmitter(), {
    pid: process.pid,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    unref: vi.fn(),
  });
}

async function waitForHandoffLine(output: Readable | null, expected: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer | string) => {
      if (!chunk.toString().includes(`${expected}\n`)) {
        return;
      }
      output?.removeListener("data", onData);
      resolve();
    };
    output?.on("data", onData);
    output?.once("end", () => reject(new Error(`helper exited before ${expected}`)));
  });
}

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessModule } =
    await import("../gateway/server-methods/node-child-process.test-support.js");
  return mockNodeChildProcessModule({
    spawn: spawnMock as unknown as typeof import("node:child_process").spawn,
  });
});

const tempDirs = new Set<string>();
const mockedHandoffLeaseCleanups = new Set<() => void>();
type GatewayRestartSentinelDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_sentinel">;

beforeEach(() => {
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
  for (const cleanup of mockedHandoffLeaseCleanups) {
    cleanup();
  }
  closeOpenClawStateDatabaseForTest();
  await Promise.all([...tempDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
  vi.resetModules();
});

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
  const revision =
    typeof (sentinel as { revision?: unknown }).revision === "number"
      ? (sentinel as { revision: number }).revision
      : Date.now();
  executeSqliteQuerySync(
    db,
    stateDb.insertInto("gateway_restart_sentinel").values({
      sentinel_key: record.kind === "revision-floor" ? "revision-floor" : "current",
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
      updated_at_ms: revision,
    }),
  );
}

function replaceRestartSentinelRow(env: NodeJS.ProcessEnv, sentinel: unknown): void {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  executeSqliteQuerySync(
    db,
    stateDb.deleteFrom("gateway_restart_sentinel").where("sentinel_key", "=", "current"),
  );
  writeRestartSentinelRow(env, sentinel);
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

async function runOwnershipHelper(params: {
  handoffId?: string;
  metaHandoffId?: string;
  prepareStateDatabase?: (env: NodeJS.ProcessEnv) => Promise<void> | void;
  sentinel?: unknown;
  deepStatePath?: boolean;
  commandDelayMs?: number;
  commandExitCode?: number;
  runnerFault?: "closed-stdin";
  whileHelperRunning?: (context: {
    env: NodeJS.ProcessEnv;
    logPath: string;
  }) => Promise<void> | void;
}) {
  const { spawn } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const { getFileLockProcessStartTime } = await import("../shared/pid-alive.js");
  const { startManagedServiceUpdateHandoff } = await import("./update-managed-service-handoff.js");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-ownership-test-"));
  tempDirs.add(tmpDir);
  let stateDir = tmpDir;
  while (
    params.deepStatePath &&
    resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }).length <= 260
  ) {
    stateDir = path.join(stateDir, `segment-${"x".repeat(24)}`);
  }
  const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;

  await startManagedServiceUpdateHandoff({
    root: tmpDir,
    timeoutMs: 1_800_000,
    restartDrainTimeoutMs: 300_000,
    parentPid: process.pid,
    execPath: "/usr/local/bin/node",
    argv1: "/opt/openclaw/openclaw.mjs",
    ...(params.handoffId ? { handoffId: params.handoffId } : {}),
    env,
    meta: {
      ...(params.metaHandoffId ? { handoffId: params.metaHandoffId } : {}),
      sessionKey: "agent:test:webchat:dm:user-123",
      continuationMessage: "continue after restart",
    },
  });
  const mockedLauncher = spawnMock.mock.results.at(-1)?.value as ReturnType<typeof createSpawnMock>;
  mockedLauncher.emit("exit", 0, null);

  const [, args, spawnOptions] = spawnMock.mock.calls.at(-1) as unknown as [
    string,
    string[],
    { env: NodeJS.ProcessEnv; detached?: boolean; cwd?: string },
  ];
  const helperScriptPath = args[0] ?? "";
  tempDirs.add(path.dirname(helperScriptPath));
  const helperParams = JSON.parse(await fs.readFile(args[1] ?? "", "utf8")) as Record<
    string,
    unknown
  >;
  await params.prepareStateDatabase?.(env);
  if (params.sentinel !== undefined) {
    writeRestartSentinelRow(env, params.sentinel);
  }
  const parent = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  const parentPid = parent.pid;
  const startIdentity = parentPid ? getFileLockProcessStartTime(parentPid) : null;
  if (!parentPid || startIdentity === null) {
    parent.kill("SIGKILL");
    throw new Error("expected a parent process with a stable start identity");
  }
  const helperParamsPath = path.join(tmpDir, "helper-params.json");
  const logPath = path.join(tmpDir, "handoff.log");
  const updaterPath = path.join(tmpDir, "updater-ran");
  const runnerClosedPath = path.join(tmpDir, "runner-closed-stdin");
  const preloadPath = path.join(tmpDir, "runner-fault-preload.cjs");
  if (params.runnerFault === "closed-stdin") {
    await fs.writeFile(
      preloadPath,
      `const fs = require("node:fs");
const childProcess = require("node:child_process");
const originalSpawn = childProcess.spawn;
const closedPath = ${JSON.stringify(runnerClosedPath)};
childProcess.spawn = function(command, args, options) {
  if (command !== process.execPath || args[0] !== "-e" ||
      !args[1].includes('process.stdin.once("data"')) {
    return originalSpawn.apply(this, arguments);
  }
  const runnerScript = 'const fs=require("node:fs");fs.closeSync(0);' +
    'fs.writeFileSync(' + JSON.stringify(closedPath) + ',String(process.pid));' +
    'setTimeout(() => process.exit(0),5000)';
  const child = originalSpawn.call(this, command, ["-e", runnerScript, args[2]], options);
  const deadline = Date.now() + 5000;
  const waitWord = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(closedPath) && Date.now() < deadline) {
    Atomics.wait(waitWord, 0, 0, 10);
  }
  if (!fs.existsSync(closedPath)) throw new Error("runner did not close stdin");
  return child;
};
`,
    );
  }
  await fs.writeFile(
    helperParamsPath,
    `${JSON.stringify(
      {
        ...helperParams,
        parentPid,
        parentStartIdentity: String(startIdentity),
        commandArgv: [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(updaterPath)},"ran");setTimeout(() => process.exit(${params.commandExitCode ?? 1}), ${params.commandDelayMs ?? 0})`,
        ],
        logPath,
        sensitivePaths: [],
      },
      null,
      2,
    )}\n`,
  );

  const helper = spawn(process.execPath, [helperScriptPath, helperParamsPath], {
    cwd: tmpDir,
    env: {
      ...spawnOptions.env,
      ...(params.runnerFault ? { NODE_OPTIONS: `--require ${preloadPath}` } : {}),
    },
    stdio: ["pipe", "pipe", params.runnerFault ? "pipe" : "ignore"],
  });
  const helperInput = helper.stdin;
  if (!helperInput) {
    throw new Error("expected the managed update helper to expose its control pipe");
  }
  let stderr = "";
  helper.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  const resultPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      helper.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  await waitForHandoffLine(helper.stdout, "OPENCLAW_UPDATE_HANDOFF_READY");
  const parked = waitForHandoffLine(helper.stdout, "parked");
  helperInput.write("park\n");
  await parked;
  const committed = waitForHandoffLine(helper.stdout, "committed");
  helperInput.write("commit\n");
  await committed;
  parent.stdin.end();
  await params.whileHelperRunning?.({ env, logPath });
  const result = await resultPromise;
  if (params.runnerFault) {
    const runnerPid = Number(await fs.readFile(runnerClosedPath, "utf8"));
    try {
      process.kill(runnerPid, "SIGKILL");
    } catch {}
  }
  return {
    result,
    env,
    logPath,
    stderr,
    updaterPath,
    leaseDatabasePath: String(helperParams.updateLeaseDatabasePath),
    leaseKey: String(helperParams.updateLeaseKey),
  };
}

describe("managed service update handoff state ownership and sentinel persistence", () => {
  it("refuses fallback writes to externally owned state without the supervisor marker", async () => {
    let before:
      | {
          bytes: Buffer;
          entries: string[];
          ctimeMs: number;
          ino: number;
          mode: number;
          mtimeMs: number;
        }
      | undefined;
    const { result, env, logPath } = await runOwnershipHelper({
      commandExitCode: 7,
      prepareStateDatabase: async (stateEnv) => {
        const externalEnv = { ...stateEnv, OPENCLAW_SUPERVISOR_MODE: "external" };
        claimOpenClawStateOwnership("gateway-supervisor", { env: externalEnv });
        closeOpenClawStateDatabaseForTest();
        const databasePath = resolveOpenClawStateSqlitePath(stateEnv);
        const stat = await fs.stat(databasePath);
        before = {
          bytes: await fs.readFile(databasePath),
          entries: (await fs.readdir(path.dirname(databasePath))).toSorted(),
          ctimeMs: stat.ctimeMs,
          ino: stat.ino,
          mode: stat.mode,
          mtimeMs: stat.mtimeMs,
        };
      },
    });

    expect(result).toEqual({ code: 7, signal: null });
    const databasePath = resolveOpenClawStateSqlitePath(env);
    const stat = await fs.stat(databasePath);
    expect({
      bytes: await fs.readFile(databasePath),
      entries: (await fs.readdir(path.dirname(databasePath))).toSorted(),
      ctimeMs: stat.ctimeMs,
      ino: stat.ino,
      mode: stat.mode,
      mtimeMs: stat.mtimeMs,
    }).toEqual(before);
    await expect(fs.readFile(logPath, "utf8")).resolves.toMatch(
      /gateway-supervisor.*OPENCLAW_SUPERVISOR_MODE=external/u,
    );
  });

  it("rechecks external ownership after waiting for the state write lock", async () => {
    const pendingSentinel = {
      version: 1 as const,
      revision: 100,
      payload: {
        kind: "update",
        status: "skipped",
        ts: 100,
        stats: {
          handoffId: "handoff-ownership-race",
          reason: "managed-service-handoff-started",
        },
      },
    };
    const ownership = {
      version: 1,
      mode: "external",
      managerId: "race-supervisor",
      claimedAt: Date.now(),
    };
    let claimant: import("node:sqlite").DatabaseSync | undefined;
    let claimantTransactionOpen = false;
    let beforeSentinelRow: unknown;
    let helperResult: Awaited<ReturnType<typeof runOwnershipHelper>> | undefined;
    try {
      helperResult = await runOwnershipHelper({
        commandExitCode: 7,
        handoffId: "handoff-ownership-race",
        metaHandoffId: "handoff-ownership-race",
        prepareStateDatabase: async (stateEnv) => {
          writeRestartSentinelRow(stateEnv, pendingSentinel);
          closeOpenClawStateDatabaseForTest();
          const sqlite = await import("node:sqlite");
          claimant = new sqlite.DatabaseSync(resolveOpenClawStateSqlitePath(stateEnv));
          claimant.exec("BEGIN IMMEDIATE;");
          claimantTransactionOpen = true;
          claimant
            .prepare(
              "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
            )
            .run("gateway.supervision", JSON.stringify(ownership), ownership.claimedAt);
          beforeSentinelRow = claimant
            .prepare("SELECT * FROM gateway_restart_sentinel WHERE sentinel_key = ?")
            .get("current");
        },
        whileHelperRunning: async ({ logPath }) => {
          await vi.waitFor(
            async () => {
              await expect(fs.readFile(logPath, "utf8")).resolves.toContain(
                "managed update command exited code=7",
              );
            },
            { interval: 5, timeout: 2_000 },
          );
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 100);
          });
          if (!claimant) {
            throw new Error("expected the ownership claimant transaction to remain open");
          }
          claimant.exec("COMMIT;");
          claimantTransactionOpen = false;
          claimant.close();
          claimant = undefined;
        },
      });
    } finally {
      if (claimantTransactionOpen) {
        try {
          claimant?.exec("ROLLBACK;");
        } catch {}
      }
      try {
        claimant?.close();
      } catch {}
    }

    if (!helperResult) {
      throw new Error("expected the detached helper to return a result");
    }
    expect(helperResult.result).toEqual({ code: 7, signal: null });
    const databasePath = resolveOpenClawStateSqlitePath(helperResult.env);
    const sqlite = await import("node:sqlite");
    const verifyDb = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      const ownershipRow = verifyDb
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
        .get("gateway.supervision") as { value_json?: unknown } | undefined;
      expect(ownershipRow?.value_json).toBe(JSON.stringify(ownership));
      expect(
        verifyDb
          .prepare("SELECT * FROM gateway_restart_sentinel WHERE sentinel_key = ?")
          .get("current"),
      ).toEqual(beforeSentinelRow);
    } finally {
      verifyDb.close();
    }
    await expect(fs.readFile(helperResult.logPath, "utf8")).resolves.toMatch(
      /race-supervisor.*OPENCLAW_SUPERVISOR_MODE=external/u,
    );
  });

  it("writes a fallback update failure when no restart sentinel row exists", async () => {
    const { result, env } = await runOwnershipHelper({
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
          reason: "managed-service-handoff-failed",
        },
      },
    });
    if (process.platform !== "win32") {
      const mode = (await fs.stat(resolveOpenClawStateSqlitePath(env))).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("reclaims the exact runner lease and records failure when its stdin closes before the update gate", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { result, env, stderr, updaterPath, leaseDatabasePath, leaseKey } =
      await runOwnershipHelper({
        handoffId: "handoff-runner-closed-stdin",
        metaHandoffId: "handoff-runner-closed-stdin",
        runnerFault: "closed-stdin",
      });

    expect(result).toEqual({ code: 1, signal: null });
    expect(stderr).not.toMatch(/Unhandled 'error' event|Error: write EPIPE/u);
    await expect(fs.access(updaterPath)).rejects.toMatchObject({ code: "ENOENT" });

    const leaseDatabase = new DatabaseSync(leaseDatabasePath, { readOnly: true });
    try {
      expect(
        leaseDatabase
          .prepare("SELECT owner FROM managed_update_handoffs WHERE install_root = ?")
          .get(leaseKey),
      ).toBeUndefined();
    } finally {
      leaseDatabase.close();
    }

    expect(readRestartSentinelPayload(env)).toMatchObject({
      payload: {
        kind: "update",
        status: "error",
        stats: {
          handoffId: "handoff-runner-closed-stdin",
          reason: expect.stringMatching(/^managed-service-handoff-(?:helper|spawn)-failed$/u),
        },
      },
    });
  });

  it.runIf(process.platform === "win32")(
    "writes fallback state through the detached helper beyond MAX_PATH",
    async () => {
      const { result, env } = await runOwnershipHelper({
        deepStatePath: true,
        handoffId: "handoff-windows-long-path",
        metaHandoffId: "handoff-windows-long-path",
      });
      const statePath = resolveOpenClawStateSqlitePath(env);
      expect(statePath.startsWith("\\\\?\\")).toBe(false);
      expect(statePath.length).toBeGreaterThan(260);
      expect(result).toEqual({ code: 1, signal: null });
      expect(readRestartSentinelPayload(env)).toMatchObject({
        payload: { status: "error" },
      });
    },
  );

  it("waits for a concurrent state writer before persisting the fallback failure", async () => {
    let lockReleased: Promise<void> | undefined;
    const { result, env } = await runOwnershipHelper({
      handoffId: "handoff-locked",
      metaHandoffId: "handoff-locked",
      prepareStateDatabase: async (stateEnv) => {
        openOpenClawStateDatabase({ env: stateEnv });
        closeOpenClawStateDatabaseForTest();
        const sqlite = await import("node:sqlite");
        const lock = new sqlite.DatabaseSync(resolveOpenClawStateSqlitePath(stateEnv));
        lock.exec("BEGIN IMMEDIATE;");
        lockReleased = new Promise((resolve) => {
          setTimeout(() => {
            lock.exec("COMMIT;");
            lock.close();
            resolve();
          }, 200);
        });
      },
    });
    await lockReleased;

    expect(result).toEqual({ code: 1, signal: null });
    expect(readRestartSentinelPayload(env)).toMatchObject({
      version: 1,
      payload: {
        status: "error",
        stats: {
          handoffId: "handoff-locked",
          reason: "managed-service-handoff-failed",
        },
      },
    });
  });

  it("repairs legacy restart sentinel columns before writing fallback failures", async () => {
    const { result, env } = await runOwnershipHelper({
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
          reason: "managed-service-handoff-failed",
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
    const { result, env } = await runOwnershipHelper({
      sentinel: unrelatedSentinel,
    });

    expect(result).toEqual({ code: 1, signal: null });
    expect(readRestartSentinelPayload(env)).toMatchObject(unrelatedSentinel);
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
    const { result, env } = await runOwnershipHelper({
      handoffId: "old-handoff",
      metaHandoffId: "old-handoff",
      sentinel: newerSentinel,
    });

    expect(result).toEqual({ code: 1, signal: null });
    expect(readRestartSentinelPayload(env)).toMatchObject(newerSentinel);
  });

  it("preserves a newer sentinel written while the detached helper is active", async () => {
    const oldSentinel = {
      version: 1,
      revision: 100,
      payload: {
        kind: "update",
        status: "skipped",
        ts: 100,
        stats: {
          handoffId: "old-handoff",
          reason: "managed-service-handoff-started",
        },
      },
    };
    const newerSentinel = {
      version: 1,
      revision: 200,
      payload: {
        kind: "restart",
        status: "ok",
        ts: 200,
      },
    };
    const { env } = await runOwnershipHelper({
      handoffId: "old-handoff",
      metaHandoffId: "old-handoff",
      sentinel: oldSentinel,
      commandDelayMs: 200,
      whileHelperRunning: async ({ env: stateEnv }) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
        replaceRestartSentinelRow(stateEnv, newerSentinel);
      },
    });

    expect(readRestartSentinelPayload(env)).toMatchObject({
      payload: newerSentinel.payload,
      revision: 200,
    });
  });

  it("advances the durable revision floor even when it is ahead of the clock", async () => {
    const futureRevision = Date.now() + 60_000;
    const { env } = await runOwnershipHelper({
      handoffId: "handoff-future-revision",
      metaHandoffId: "handoff-future-revision",
      sentinel: {
        version: 1,
        revision: futureRevision,
        payload: {
          kind: "revision-floor",
          status: "skipped",
          ts: 123,
          stats: {
            handoffId: "handoff-future-revision",
            reason: "managed-service-handoff-started",
          },
        },
      },
    });

    expect(readRestartSentinelPayload(env, "revision-floor")).toMatchObject({
      revision: futureRevision + 1,
    });
  });
});
