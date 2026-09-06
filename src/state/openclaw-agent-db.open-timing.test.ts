import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import * as sqlite from "../infra/node-sqlite.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
import * as wal from "../infra/sqlite-wal.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as permissions from "./openclaw-agent-db-permissions.js";
import * as registry from "./openclaw-agent-db-registry.js";
import * as schema from "./openclaw-agent-db-schema.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  withOpenClawAgentDatabaseAsync,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const logger = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (name: string) => {
      const original = actual.createSubsystemLogger(name);
      return name === "state/agent-db" ? { ...original, warn: logger.warn } : original;
    },
  };
});

const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
  logger.warn.mockClear();
});

function createTimedOpen(validationMs: number) {
  const options = {
    agentId: "timing-test",
    env: { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "openclaw-agent-open-timing-") },
  };
  const pathname = resolveOpenClawAgentSqlitePath(options);
  let elapsedMs = 0;
  const advance = (durationMs: number) => {
    elapsedMs += durationMs;
  };
  const wallStartedAt = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => wallStartedAt + Math.floor(elapsedMs));
  vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);

  // Real operations advance a controlled clock at their existing owner boundaries.
  const open = sqlite.openNodeSqliteDatabase;
  vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const database = open(...args);
    if (args[0] === pathname) {
      advance(50);
    }
    return database;
  });
  const ensurePermissions = permissions.ensureOpenClawAgentDatabasePermissions;
  vi.spyOn(permissions, "ensureOpenClawAgentDatabasePermissions").mockImplementation((...args) => {
    ensurePermissions(...args);
    advance(10);
  });
  const validate = schema.agentDatabaseIntegrityBeforeMutationSteps;
  vi.spyOn(schema, "agentDatabaseIntegrityBeforeMutationSteps").mockImplementation(function* (
    ...args
  ) {
    const result = yield* validate(...args);
    advance(validationMs);
    return result;
  });
  const configure = wal.configureSqliteConnectionPragmas;
  vi.spyOn(wal, "configureSqliteConnectionPragmas").mockImplementation((...args) => {
    const result = configure(...args);
    if (args[1]?.databasePath === pathname) {
      advance(80);
    }
    return result;
  });
  const ensureSchema = schema.ensureOpenClawAgentSchema;
  vi.spyOn(schema, "ensureOpenClawAgentSchema").mockImplementation((...args) => {
    ensureSchema(...args);
    advance(90);
  });
  const register = registry.registerOpenClawAgentDatabase;
  vi.spyOn(registry, "registerOpenClawAgentDatabase").mockImplementation((...args) => {
    const result = register(...args);
    advance(70);
    return result;
  });
  return { options, pathname, advance };
}

describe("agent database open timings", () => {
  it("reports completed phases at the slow threshold and skips live cache hits", () => {
    const { options, pathname, advance } = createTimedOpen(690);
    const database = openOpenClawAgentDatabase(options);
    expect(database.db.isOpen).toBe(true);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("slow OpenClaw agent database open", {
      agentId: options.agentId,
      elapsedMs: 1_000,
      path: pathname,
      pid: process.pid,
      threadId,
      isMainThread,
      thresholdMs: 1_000,
      phaseDurationsMs: {
        open: 60,
        validation: 690,
        configuration: 80,
        schema: 90,
        registration: 80,
      },
    });
    logger.warn.mockClear();
    advance(5_000);
    expect(openOpenClawAgentDatabase(options)).toBe(database);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("keeps opens below the existing threshold quiet", () => {
    const { options } = createTimedOpen(689.75);
    expect(openOpenClawAgentDatabase(options).db.isOpen).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("measures a validated reopen without charging skipped schema or registration work", () => {
    const { options, pathname } = createTimedOpen(1_000);
    openOpenClawAgentDatabase(options);
    closeOpenClawAgentDatabaseByPath(pathname);
    logger.warn.mockClear();
    expect(openOpenClawAgentDatabase(options).db.isOpen).toBe(true);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("slow OpenClaw agent database open", {
      agentId: options.agentId,
      elapsedMs: 1_150,
      path: pathname,
      pid: process.pid,
      threadId,
      isMainThread,
      thresholdMs: 1_000,
      phaseDurationsMs: {
        open: 60,
        validation: 1_000,
        configuration: 80,
        schema: 0,
        registration: 10,
      },
    });
  });

  it("includes asynchronous admission waiting once for coalesced callers", async () => {
    const { options, pathname, advance } = createTimedOpen(0);
    openOpenClawAgentDatabase(options);
    closeOpenClawAgentDatabasesForTest();
    logger.warn.mockClear();
    const nativeFinished = createDeferredCore();
    const release = createDeferredCore();
    const check = integrityWorker.assertSqliteIntegrityInWorker;
    const worker = vi
      .spyOn(integrityWorker, "assertSqliteIntegrityInWorker")
      .mockImplementation(async (...args) => {
        try {
          await check(...args);
        } catch (error) {
          nativeFinished.reject(error);
          throw error;
        }
        nativeFinished.resolve();
        await release.promise;
      });
    const databases: Array<ReturnType<typeof openOpenClawAgentDatabase>> = [];
    const collect = (database: ReturnType<typeof openOpenClawAgentDatabase>) => {
      databases.push(database);
    };
    const outcomes = Promise.allSettled([
      withOpenClawAgentDatabaseAsync(options, collect),
      withOpenClawAgentDatabaseAsync(options, collect),
    ]);
    try {
      await nativeFinished.promise;
      advance(1_000);
      expect(databases).toHaveLength(0);
      expect(logger.warn).not.toHaveBeenCalled();
      release.resolve();
      expect(await outcomes).toEqual([
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined },
      ]);
      expect(worker).toHaveBeenCalledOnce();
      expect(databases).toHaveLength(2);
      expect(databases[1]).toBe(databases[0]);
      expect(databases[0]?.db.isOpen).toBe(true);
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith("slow OpenClaw agent database open", {
        agentId: options.agentId,
        elapsedMs: 1_310,
        path: pathname,
        pid: process.pid,
        threadId,
        isMainThread,
        thresholdMs: 1_000,
        phaseDurationsMs: {
          open: 60,
          validation: 1_000,
          configuration: 80,
          schema: 90,
          registration: 80,
        },
      });
    } finally {
      release.resolve();
      await outcomes;
    }
  });
});
