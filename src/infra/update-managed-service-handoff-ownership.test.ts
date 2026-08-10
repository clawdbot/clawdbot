/**
 * Tests externally owned state behavior in the detached managed-service update helper.
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
import { claimOpenClawStateOwnership } from "../state/openclaw-state-ownership-operations.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

function createSpawnMock() {
  return Object.assign(new EventEmitter(), {
    pid: 24680,
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    unref: vi.fn(),
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
type GatewayRestartSentinelDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_sentinel">;

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    const child = createSpawnMock();
    process.nextTick(() => {
      child.stdout.write("OPENCLAW_UPDATE_HANDOFF_READY\n");
    });
    return child;
  });
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await Promise.all([...tempDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
  vi.resetModules();
});

function writeRestartSentinelRow(
  env: NodeJS.ProcessEnv,
  sentinel: {
    version: 1;
    revision: number;
    payload: {
      kind: string;
      status: string;
      ts: number;
      stats: Record<string, unknown>;
    };
  },
): void {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  executeSqliteQuerySync(
    db,
    stateDb.insertInto("gateway_restart_sentinel").values({
      sentinel_key: "current",
      version: sentinel.version,
      kind: sentinel.payload.kind,
      status: sentinel.payload.status,
      ts: sentinel.payload.ts,
      session_key: null,
      thread_id: null,
      delivery_channel: null,
      delivery_to: null,
      delivery_account_id: null,
      message: null,
      continuation_json: null,
      doctor_hint: null,
      stats_json: JSON.stringify(sentinel.payload.stats),
      payload_json: JSON.stringify(sentinel.payload),
      updated_at_ms: sentinel.revision,
    }),
  );
}

async function runOwnershipHelper(params: {
  handoffId?: string;
  metaHandoffId?: string;
  prepareStateDatabase: (env: NodeJS.ProcessEnv) => Promise<void> | void;
  whileHelperRunning?: (context: { logPath: string }) => Promise<void> | void;
}) {
  const { execFile } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const { startManagedServiceUpdateHandoff } = await import("./update-managed-service-handoff.js");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-ownership-test-"));
  tempDirs.add(tmpDir);
  const env = { OPENCLAW_STATE_DIR: tmpDir } as NodeJS.ProcessEnv;

  await startManagedServiceUpdateHandoff({
    root: tmpDir,
    timeoutMs: 1_800_000,
    restartDrainTimeoutMs: 300_000,
    restartDelayMs: 500,
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
  await params.prepareStateDatabase(env);
  const helperParamsPath = path.join(tmpDir, "helper-params.json");
  const logPath = path.join(tmpDir, "handoff.log");
  await fs.writeFile(
    helperParamsPath,
    `${JSON.stringify(
      {
        ...helperParams,
        parentPid: process.pid,
        parentExitTimeoutMs: 1,
        logPath,
        sensitivePaths: [],
      },
      null,
      2,
    )}\n`,
  );

  const resultPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      execFile(
        process.execPath,
        [helperScriptPath, helperParamsPath],
        { cwd: tmpDir, env: spawnOptions.env },
        (err) => {
          const childError = err as (NodeJS.ErrnoException & { signal?: NodeJS.Signals }) | null;
          resolve({
            code: typeof childError?.code === "number" ? childError.code : 0,
            signal: childError?.signal ?? null,
          });
        },
      );
    },
  );
  await params.whileHelperRunning?.({ logPath });
  return { result: await resultPromise, env, logPath };
}

describe("managed service update handoff external ownership", () => {
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

    expect(result).toEqual({ code: 1, signal: null });
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
                "did not exit before handoff timeout",
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
    expect(helperResult.result).toEqual({ code: 1, signal: null });
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
});
