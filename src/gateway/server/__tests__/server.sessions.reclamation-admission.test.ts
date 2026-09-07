import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { WorkerOptions } from "node:worker_threads";
import { afterEach, expect, test, vi } from "vitest";
import { withTestTimeout } from "../../../../test/helpers/promise.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../../config/sessions/session-sqlite-target.js";
import { beginSessionWorkAdmission } from "../../../sessions/session-lifecycle-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { rpcReq, writeSessionStore } from "../../test-helpers.js";
import {
  loadSeededTranscriptEvents,
  seedLinearSessionTranscript,
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "../../test/server-sessions.test-helpers.js";

const reclamation = vi.hoisted(() => ({
  gate: undefined as SharedArrayBuffer | undefined,
  exits: [] as Promise<number>[],
  exitCodes: [] as number[],
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options: WorkerOptions = {}) {
        const gate = options.workerData?.operation === "reclaim" ? reclamation.gate : undefined;
        let workerOptions = options;
        if (gate) {
          // Hold the real Worker's native validation, with no fake database or
          // production hook. Both checks still execute on this same handle.
          const preload = `
            import { realpathSync } from 'node:fs';
            import { DatabaseSync } from 'node:sqlite';
            import { workerData } from 'node:worker_threads';
            const gate = new Int32Array(workerData.reclamationTestGate);
            const databasePath = realpathSync(workerData.plan.databaseOptions.path);
            const validated = new WeakSet();
            const prepare = DatabaseSync.prototype.prepare;
            DatabaseSync.prototype.prepare = function (sql) {
              const statement = prepare.call(this, sql);
              if (sql !== 'PRAGMA integrity_check;' && sql !== 'PRAGMA foreign_key_check;') {
                return statement;
              }
              const target = prepare.call(this, 'PRAGMA database_list').all().some(
                (row) => row.name === 'main' && row.file && realpathSync(row.file) === databasePath,
              );
              if (!target) return statement;
              const database = this;
              if (sql === 'PRAGMA integrity_check;') {
                const all = statement.all.bind(statement);
                statement.all = (...args) => {
                  Atomics.add(gate, 0, 1);
                  Atomics.notify(gate, 0);
                  if (Atomics.wait(gate, 1, 0, 15000) === 'timed-out') {
                    throw new Error('reclamation test gate was not released');
                  }
                  const result = all(...args);
                  validated.add(database);
                  Atomics.add(gate, 2, 1);
                  return result;
                };
              } else if (sql === 'PRAGMA foreign_key_check;') {
                const iterate = statement.iterate.bind(statement);
                statement.iterate = function* (...args) {
                  yield* iterate(...args);
                  if (validated.has(database)) Atomics.add(gate, 3, 1);
                };
              }
              return statement;
            };
          `;
          workerOptions = {
            ...options,
            workerData: { ...options.workerData, reclamationTestGate: gate },
            execArgv: [
              ...(options.execArgv ?? []),
              "--import",
              `data:text/javascript,${encodeURIComponent(preload)}`,
            ],
          };
        }
        super(filename, workerOptions);
        if (gate) {
          reclamation.exits.push(
            new Promise((resolve) => {
              this.once("exit", (code) => {
                reclamation.exitCodes.push(code);
                resolve(code);
              });
            }),
          );
        }
      }
    },
  };
});

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

afterEach(() => {
  reclamation.gate = undefined;
  reclamation.exits = [];
  reclamation.exitCodes = [];
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function holdReclamationValidation() {
  const gate = new Int32Array(new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT));
  reclamation.gate = gate.buffer;
  const pending: Promise<unknown>[] = [];
  const release = () => {
    Atomics.store(gate, 1, 1);
    Atomics.notify(gate, 1);
  };
  return {
    gate,
    release,
    own<T>(operation: Promise<T>): Promise<T> {
      pending.push(operation);
      void operation.catch(() => {});
      return operation;
    },
    async entered(operation: Promise<unknown>) {
      // RPCs retain their own timeout; an early response must not masquerade as
      // a held native check. The direct lifecycle sibling supplies the same bound.
      const waiting = new AbortController();
      const held = (async () => {
        while (Atomics.load(gate, 0) === 0) {
          if (waiting.signal.aborted) {
            return undefined;
          }
          await yieldToEventLoop();
        }
        return "held";
      })();
      try {
        const result = await Promise.race([held, operation]);
        expect(result).toBe("held");
        expect(Atomics.load(gate, 0)).toBeGreaterThan(0);
      } finally {
        waiting.abort();
        await held;
      }
    },
    async close() {
      release();
      await Promise.allSettled(pending);
      await Promise.all(reclamation.exits);
    },
  };
}

test("sessions.delete admits unrelated same-store patches during Worker validation", async () => {
  const targetKey = "agent:main:validation-delete";
  const unrelatedKey = "agent:main:validation-patch";
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      [targetKey]: sessionStoreEntry("validation-delete"),
      [unrelatedKey]: sessionStoreEntry("validation-patch"),
    },
    storePath,
  });
  const { ws } = await openClient();
  const validation = holdReclamationValidation();
  const { gate } = validation;
  try {
    expect(await rpcReq(ws, "sessions.patch", { key: unrelatedKey, label: "warm" })).toMatchObject({
      ok: true,
    });
    const deletion = validation.own(rpcReq(ws, "sessions.delete", { key: targetKey }));
    await validation.entered(deletion);
    expect(loadSessionEntry({ sessionKey: targetKey, storePath })?.sessionId).toBe(
      "validation-delete",
    );

    let admissionSettled = false;
    const assertTargetExists = () => {
      if (!loadSessionEntry({ sessionKey: targetKey, storePath })) {
        throw new Error("deleted session cannot accept new work");
      }
    };
    const admission = validation.own(
      beginSessionWorkAdmission({
        scope: storePath,
        identities: [targetKey, "validation-delete"],
        assertAllowed: assertTargetExists,
        revalidateAllowed: assertTargetExists,
      }).then(
        (lease) => {
          lease.release();
          admissionSettled = true;
          return "admitted";
        },
        (error: unknown) => {
          admissionSettled = true;
          return error instanceof Error ? error.message : String(error);
        },
      ),
    );
    const patch = validation.own(
      rpcReq(ws, "sessions.patch", { key: unrelatedKey, label: "progressed" }),
    );
    await expect(
      withTestTimeout(patch, 2_000, "unrelated same-store patch waited for reclamation validation"),
    ).resolves.toMatchObject({ ok: true });
    expect(loadSessionEntry({ sessionKey: unrelatedKey, storePath })?.label).toBe("progressed");
    expect(admissionSettled).toBe(false);
    expect(Atomics.load(gate, 2)).toBe(0);

    validation.release();
    await expect(deletion).resolves.toMatchObject({ ok: true, payload: { deleted: true } });
    await expect(admission).resolves.toBe("deleted session cannot accept new work");
    expect(loadSessionEntry({ sessionKey: targetKey, storePath })).toBeUndefined();
    expect(Atomics.load(gate, 2)).toBeGreaterThan(0);
    expect(Atomics.load(gate, 3)).toBeGreaterThan(0);
    expect(reclamation.exitCodes).toEqual([0]);
  } finally {
    await validation.close();
    ws.close();
  }
});

test("sessions.delete rejects revoked authority before repairing the same database", async () => {
  const sessionKey = "agent:main:validation-revoked";
  const sessionId = "validation-revoked";
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) }, storePath });
  const transcriptScope = { agentId: "main", sessionKey, sessionId, storePath };
  await seedLinearSessionTranscript({ ...transcriptScope, contents: ["retained transcript"] });
  const originalEntry = loadSessionEntry(transcriptScope);
  const originalTranscript = await loadSeededTranscriptEvents(transcriptScope);
  const databaseOptions = {
    agentId: "main",
    path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
  };
  const database = openOpenClawAgentDatabase(databaseOptions);
  const stateDatabase = openOpenClawStateDatabase();
  const readLeases = () =>
    stateDatabase.db
      .prepare("SELECT lease_id FROM agent_database_leases WHERE path = ? ORDER BY lease_id")
      .all(database.path);
  const originalLeases = readLeases();
  expect(originalLeases).toHaveLength(1);
  // A late commit guard can roll back deletion but cannot undo an earlier
  // database-open repair. Keep the original cached handle warm throughout.
  database.db.exec("DROP INDEX idx_agent_cache_expiry");
  const readRepairIndex = () =>
    database.db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = ?")
      .get("idx_agent_cache_expiry");
  expect(readRepairIndex()).toBeUndefined();
  const validation = holdReclamationValidation();
  let authorized = true;
  let guardCalls = 0;
  try {
    const deletion = validation.own(
      deleteSessionEntryLifecycle({
        archiveTranscript: true,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        commitGuard: () => {
          guardCalls += 1;
          if (!authorized) {
            throw new Error("caller authority revoked during Worker validation");
          }
        },
      }),
    );
    await validation.entered(
      withTestTimeout(deletion, 10_000, "reclamation Worker did not enter native validation"),
    );
    expect(openOpenClawAgentDatabase(databaseOptions)).toBe(database);
    expect(database.db.isOpen).toBe(true);
    expect(readLeases()).toHaveLength(originalLeases.length + 1);
    const callsBeforeRevocation = guardCalls;
    authorized = false;
    validation.release();

    await expect(deletion).rejects.toThrow("caller authority revoked during Worker validation");
    expect(guardCalls).toBeGreaterThan(callsBeforeRevocation);
    expect(openOpenClawAgentDatabase(databaseOptions)).toBe(database);
    expect(loadSessionEntry(transcriptScope)).toEqual(originalEntry);
    await expect(loadSeededTranscriptEvents(transcriptScope)).resolves.toEqual(originalTranscript);
    expect(Atomics.load(validation.gate, 2)).toBeGreaterThan(0);
    expect(Atomics.load(validation.gate, 3)).toBeGreaterThan(0);
    expect(reclamation.exitCodes).toHaveLength(1);
    expect(readLeases()).toEqual(originalLeases);
    expect(readRepairIndex()).toBeUndefined();
  } finally {
    await validation.close();
  }
});
