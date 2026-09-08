import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { prepareAgentDeleteDatabases } from "../agents/agent-delete-databases.js";
import {
  withAgentDeletion,
  type AgentDeletionOperation,
} from "../agents/agent-lifecycle-registry.js";
import { purgeAgentSessionStoreEntries } from "../config/sessions/cleanup-service.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
import { beginAgentDeletionJournal, removeAgentDeletionJournal } from "./agent-deletion-journal.js";
import { assertNoOpenClawAgentDatabaseLeases } from "./openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabasesAsync,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseAsync,
} from "./openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-delete-cleanup-")));
  roots.push(root);
  const options = { agentId: "worker", env: { OPENCLAW_STATE_DIR: root } };
  const database = openOpenClawAgentDatabase(options);
  const scope = { ...options, sessionKey: "agent:worker:main" };
  const write = (sessionId: string) => replaceSessionEntrySync(scope, { sessionId, updatedAt: 1 });
  write("before");
  closeOpenClawAgentDatabaseByPath(database.path);
  const entry = {
    agentId: options.agentId,
    agentDir: path.dirname(database.path),
    workspaceDir: path.join(root, "workspace"),
    sessionsDir: path.join(root, "agents", options.agentId, "sessions"),
  };
  return {
    root,
    options,
    target: { agentId: options.agentId, path: database.path },
    entry,
    write,
    read: () => loadSessionEntryReadOnly(scope)?.sessionId,
    withDeletion: <T>(run: (deletion: AgentDeletionOperation) => Promise<T>) =>
      withAgentDeletion(options.agentId, async (begin) => run(begin(entry)), { env: options.env }),
  };
}

describe("agent deletion database cleanup authority", () => {
  it.each(["settle", "replace", "rollback", "finish"] as const)(
    "rejects admission before index repair after its cleanup owner is retired by %s",
    async (retire) => {
      const f = fixture();
      const writer = openNodeSqliteDatabase(f.target.path);
      try {
        writer.exec("DROP INDEX idx_agent_cache_expiry");
      } finally {
        writer.close();
      }
      let operationCalled = false;
      await f.withDeletion(async (deletion) => {
        const checked = createDeferred();
        const resume = createDeferred();
        const check = integrityWorker.assertSqliteIntegrityInWorker;
        vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
          async (...args) => {
            await check(...args);
            checked.resolve();
            await resume.promise;
          },
        );
        let rejected: Promise<unknown> | undefined;
        const running = deletion.runDatabaseCleanup(f.target, async () => {
          rejected = expect(
            withOpenClawAgentDatabaseAsync(f.options, () => {
              operationCalled = true;
            }),
          ).rejects.toThrow(/no longer/);
          // A retained admission must not outlive a callback that did not await it.
          if (retire !== "settle") {
            await rejected;
          }
        });
        const settled =
          retire === "settle" ? running : expect(running).rejects.toThrow(/no longer/);
        try {
          await checked.promise;
          if (retire === "settle") {
            await running;
          } else if (retire === "replace") {
            beginAgentDeletionJournal(
              { ...f.entry, operationId: "replacement", deleteFiles: true },
              { env: f.options.env },
            );
          } else {
            deletion[retire]();
          }
        } finally {
          resume.resolve();
          await settled;
          await rejected;
        }
      });
      const reader = openNodeSqliteDatabase(f.target.path, { readOnly: true });
      try {
        expect(
          reader
            .prepare("SELECT name FROM sqlite_schema WHERE name='idx_agent_cache_expiry'")
            .get(),
        ).toBeUndefined();
      } finally {
        reader.close();
      }
      expect(operationCalled).toBe(false);
      expect(() =>
        assertNoOpenClawAgentDatabaseLeases("worker", { env: f.options.env }),
      ).not.toThrow();
    },
  );

  it("does not expose cleanup admission to a coalesced operation outside its scope", async () => {
    const f = fixture();
    await f.withDeletion(async (deletion) => {
      const checked = createDeferred();
      const resume = createDeferred();
      const releaseOwner = createDeferred();
      const check = integrityWorker.assertSqliteIntegrityInWorker;
      vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
        async (...args) => {
          await check(...args);
          checked.resolve();
          await resume.promise;
        },
      );
      const running = deletion.runDatabaseCleanup(f.target, () =>
        withOpenClawAgentDatabaseAsync(f.options, async () => {
          await releaseOwner.promise;
          f.write("owned");
        }),
      );
      try {
        await checked.promise;
        let outsideCalled = false;
        const rejected = expect(
          withOpenClawAgentDatabaseAsync(f.options, (database) => {
            outsideCalled = true;
            return database.db.isOpen;
          }),
        ).rejects.toThrow("active deletion cleanup");
        resume.resolve();
        await rejected;
        expect(outsideCalled).toBe(false);
      } finally {
        resume.resolve();
        releaseOwner.resolve();
        await running;
      }
    });
    expect(f.read()).toBe("owned");
  });

  it("rechecks a settled cleanup scope before an async operation on a borrowed survivor", async () => {
    const f = fixture();
    const options = { ...f.options, agentId: "kept", path: path.join(f.root, "shared.sqlite") };
    const kept = openOpenClawAgentDatabase(options);
    let operationCalled = false;
    await f.withDeletion(async (deletion) => {
      let rejected: Promise<unknown> | undefined;
      await deletion.runDatabaseCleanup({ agentId: "kept", path: kept.path }, async () => {
        rejected = expect(
          withOpenClawAgentDatabaseAsync(options, () => {
            operationCalled = true;
          }),
        ).rejects.toThrow("no longer active");
      });
      await rejected;
    });
    expect(operationCalled).toBe(false);
    expect(kept.db.isOpen).toBe(true);
    expect(openOpenClawAgentDatabase(options)).toBe(kept);
  });

  it("retries a settled shared-store close before admitting a fresh deletion cleanup", async () => {
    const f = fixture();
    const storePath = path.join(f.root, "shared.sqlite");
    const sharedOptions = { ...f.options, agentId: "kept", path: storePath };
    const cfg = {
      agents: { entries: { worker: {}, kept: {} } },
      session: { store: storePath },
    };
    openOpenClawAgentDatabase(sharedOptions);
    const workerScope = { ...f.options, storePath, sessionKey: "agent:worker:shared" };
    const keptScope = { ...workerScope, agentId: "kept", sessionKey: "agent:kept:shared" };
    replaceSessionEntrySync(workerScope, { sessionId: "remove", updatedAt: Date.now() });
    replaceSessionEntrySync(keptScope, { sessionId: "keep", updatedAt: Date.now() });
    closeOpenClawAgentDatabaseByPath(storePath, "kept");
    let retained: ReturnType<typeof openOpenClawAgentDatabase> | undefined;
    let closeCalls = 0;
    const runAttempt = (deletion: AgentDeletionOperation, injectFailure: boolean) => {
      prepareAgentDeleteDatabases(cfg, "worker", f.entry.agentDir, { env: f.options.env });
      return purgeAgentSessionStoreEntries(cfg, "worker", {
        env: f.options.env,
        runDatabaseCleanup: (target, run) =>
          deletion.runDatabaseCleanup(target, async () => {
            if (injectFailure && target.path === storePath) {
              retained = openOpenClawAgentDatabase(sharedOptions);
              const close = retained.db.close.bind(retained.db);
              vi.spyOn(retained.db, "close").mockImplementation(() => {
                closeCalls += 1;
                if (closeCalls === 1) {
                  throw new Error("one-time native close failure");
                }
                close();
              });
            }
            return await run();
          }),
      });
    };

    await expect(f.withDeletion((deletion) => runAttempt(deletion, true))).resolves.toBe(true);
    expect(closeCalls).toBe(1);
    expect(retained?.db.isOpen).toBe(true);
    expect(() => openOpenClawAgentDatabase(sharedOptions)).toThrow("active deletion cleanup");
    await expect(f.withDeletion((deletion) => runAttempt(deletion, false))).resolves.toBe(false);
    expect(closeCalls).toBe(2);
    expect(retained?.db.isOpen).toBe(false);
    expect(loadSessionEntryReadOnly(workerScope)).toBeUndefined();
    expect(loadSessionEntryReadOnly(keptScope)?.sessionId).toBe("keep");
    expect(openOpenClawAgentDatabase(sharedOptions).db.isOpen).toBe(true);
  });

  it("rejects cleanup settlement after awaited journal takeover", async () => {
    const f = fixture();
    await f.withDeletion(async (deletion) => {
      const opened = createDeferred();
      const release = createDeferred();
      const running = deletion.runDatabaseCleanup(f.target, async () => {
        openOpenClawAgentDatabase(f.options);
        opened.resolve();
        await release.promise;
      });
      const rejected = expect(running).rejects.toThrow("no longer owns");
      try {
        await opened.promise;
        beginAgentDeletionJournal(
          { ...f.entry, operationId: "replacement", deleteFiles: true },
          { env: f.options.env },
        );
      } finally {
        release.resolve();
      }
      await rejected;
      expect(f.read()).toBe("before");
      expect(getOpenClawAgentDatabaseIfOpen(f.options)).toBeUndefined();
    });
  });

  it.each([false, true])(
    "rolls back writes after precommit journal takeover (warm survivor: %s)",
    async (warmSurvivor) => {
      const f = fixture();
      const options = {
        ...f.options,
        agentId: warmSurvivor ? "kept" : f.options.agentId,
        path: warmSurvivor ? path.join(f.root, "shared.sqlite") : f.target.path,
      };
      const scope = { ...f.options, storePath: options.path, sessionKey: "agent:worker:main" };
      const write = (sessionId: string) =>
        replaceSessionEntrySync(scope, { sessionId, updatedAt: 1 });
      if (warmSurvivor) {
        openOpenClawAgentDatabase(options);
        write("before");
      }
      await f.withDeletion(async (deletion) => {
        await expect(
          deletion.runDatabaseCleanup(options, async () => {
            runOpenClawAgentWriteTransaction(() => {
              write("stale");
              beginAgentDeletionJournal(
                { ...f.entry, operationId: "replacement", deleteFiles: true },
                { env: f.options.env },
              );
            }, options);
          }),
        ).rejects.toThrow("no longer owns");
        expect(loadSessionEntryReadOnly(scope)?.sessionId).toBe("before");
      });
    },
  );

  it("keeps a cold cleanup handle private through awaits and closes it before settlement", async () => {
    const f = fixture();
    await f.withDeletion(async (deletion) => {
      const opened = createDeferred();
      const release = createDeferred();
      const late = createDeferred();
      let lateWrite: Promise<unknown> | undefined;
      const running = deletion.runDatabaseCleanup(f.target, async () => {
        const database = openOpenClawAgentDatabase(f.options);
        lateWrite = (async () => {
          await late.promise;
          expect(() => f.write("late")).toThrow("no longer active");
        })();
        opened.resolve();
        await release.promise;
        f.write("owned");
        return database;
      });
      try {
        await opened.promise;
        expect(() => openOpenClawAgentDatabase(f.options)).toThrow("active deletion cleanup");
        expect(() => getOpenClawAgentDatabaseIfOpen(f.options)).toThrow("active deletion cleanup");
        expect(() => f.write("ordinary")).toThrow("active deletion cleanup");
        const alias = path.join(f.root, "alias");
        fs.symlinkSync(
          path.dirname(f.target.path),
          alias,
          process.platform === "win32" ? "junction" : "dir",
        );
        expect(() =>
          openOpenClawAgentDatabase({
            ...f.options,
            path: path.join(alias, path.basename(f.target.path)),
          }),
        ).toThrow("active deletion cleanup");
        expect(f.read()).toBe("before");
      } finally {
        release.resolve();
        try {
          expect((await running).db.isOpen).toBe(false);
        } finally {
          late.resolve();
          await lateWrite;
        }
      }
      expect(f.read()).toBe("owned");
      expect(() =>
        assertNoOpenClawAgentDatabaseLeases("worker", { env: f.options.env }),
      ).not.toThrow();
    });
  });

  it.each(["replace", "rollback", "finish"] as const)(
    "rejects cleanup writes after its journal owner is retired by %s",
    async (retire) => {
      const f = fixture();
      await f.withDeletion(async (deletion) => {
        const opened = createDeferred();
        const release = createDeferred();
        let database: ReturnType<typeof openOpenClawAgentDatabase> | undefined;
        const running = deletion.runDatabaseCleanup(f.target, async () => {
          database = openOpenClawAgentDatabase(f.options);
          opened.resolve();
          await release.promise;
          expect(() => f.write("stale")).toThrow("no longer owns database cleanup");
          return database;
        });
        const rejected = expect(running).rejects.toThrow("no longer owns");
        try {
          await opened.promise;
          if (retire === "replace") {
            beginAgentDeletionJournal(
              { ...f.entry, operationId: "replacement", deleteFiles: true },
              { env: f.options.env },
            );
          } else {
            deletion[retire]();
          }
        } finally {
          release.resolve();
          await rejected;
          expect(database?.db.isOpen).toBe(false);
        }
        expect(f.read()).toBe("before");
      });
    },
  );

  it("binds the cleanup target to its state database, identity, and physical locator", async () => {
    const f = fixture();
    const other = fixture();
    await f.withDeletion(async (deletion) => {
      await deletion.runDatabaseCleanup(f.target, async () => {
        const database = openOpenClawAgentDatabase(f.options);
        expect(() =>
          openOpenClawAgentDatabase({ ...f.options, env: other.options.env, path: f.target.path }),
        ).toThrow("another state database");
        expect(() =>
          openOpenClawAgentDatabase({ ...f.options, agentId: "kept", path: f.target.path }),
        ).toThrow("already open for agent worker");
        expect(() =>
          openOpenClawAgentDatabase({ ...f.options, path: path.join(f.root, "unowned.sqlite") }),
        ).toThrow("unavailable while agent worker is deleted");
        expect(database.db.isOpen).toBe(true);
      });
      expect(f.read()).toBe("before");
      expect(other.read()).toBe("before");
    });
  });

  it.each([false, true])(
    "retains failed cleanup close ownership (operation also failed: %s)",
    async (failRun) => {
      const f = fixture();
      await f.withDeletion(async (deletion) => {
        let retained: ReturnType<typeof openOpenClawAgentDatabase> | undefined;
        const closeError = new Error("held native close");
        const runError = new Error("cleanup operation failed");
        const running = deletion.runDatabaseCleanup(f.target, async () => {
          retained = openOpenClawAgentDatabase(f.options);
          vi.spyOn(retained.db, "close").mockImplementationOnce(() => {
            throw closeError;
          });
          if (failRun) {
            throw runError;
          }
        });
        if (failRun) {
          await expect(running).rejects.toMatchObject({ errors: [runError, closeError] });
        } else {
          await expect(running).rejects.toBe(closeError);
        }
        expect(retained?.db.isOpen).toBe(true);
        expect(() => openOpenClawAgentDatabase(f.options)).toThrow("active deletion cleanup");
        expect(() => assertNoOpenClawAgentDatabaseLeases("worker", { env: f.options.env })).toThrow(
          "database is still open",
        );
        expect(closeOpenClawAgentDatabaseByPath(f.target.path, "worker")).toBe(true);
        await deletion.runDatabaseCleanup(f.target, async () => f.write("retried"));
        expect(f.read()).toBe("retried");
        expect(() =>
          assertNoOpenClawAgentDatabaseLeases("worker", { env: f.options.env }),
        ).not.toThrow();
      });
    },
  );

  it("never exempts a foreign deletion journal's overlapping path", async () => {
    const f = fixture();
    const foreign = beginAgentDeletionJournal(
      { ...f.entry, agentId: "kept", operationId: "foreign", deleteFiles: true },
      { env: f.options.env },
    );
    await f.withDeletion(async (deletion) => {
      await expect(
        deletion.runDatabaseCleanup(f.target, async () => f.write("blocked")),
      ).rejects.toThrow("agent kept deletion owns");
      expect(f.read()).toBe("before");
      removeAgentDeletionJournal("kept", foreign.operationId, { env: f.options.env });
      await deletion.runDatabaseCleanup(f.target, async () => f.write("retried"));
      expect(f.read()).toBe("retried");
    });
  });

  it.each([false, true])(
    "purges only target rows in a surviving shared store (cold: %s)",
    async (cold) => {
      const f = fixture();
      const storePath = path.join(f.root, "shared.sqlite");
      const sharedOptions = { ...f.options, agentId: "kept", path: storePath };
      const shared = openOpenClawAgentDatabase(sharedOptions);
      const workerScope = { ...f.options, storePath, sessionKey: "agent:worker:shared" };
      const keptScope = { ...workerScope, agentId: "kept", sessionKey: "agent:kept:shared" };
      replaceSessionEntrySync(workerScope, { sessionId: "remove", updatedAt: Date.now() });
      replaceSessionEntrySync(keptScope, { sessionId: "keep", updatedAt: Date.now() });
      if (cold) {
        closeOpenClawAgentDatabaseByPath(storePath);
      }
      await f.withDeletion(async (deletion) => {
        await expect(
          purgeAgentSessionStoreEntries(
            { agents: { entries: { worker: {}, kept: {} } }, session: { store: storePath } },
            "worker",
            { env: f.options.env, runDatabaseCleanup: deletion.runDatabaseCleanup },
          ),
        ).resolves.toBe(false);
        expect(loadSessionEntryReadOnly(workerScope)).toBeUndefined();
        expect(loadSessionEntryReadOnly(keptScope)?.sessionId).toBe("keep");
        expect(shared.db.isOpen).toBe(!cold);
        if (cold) {
          expect(getOpenClawAgentDatabaseIfOpen(sharedOptions)).toBeUndefined();
        }
      });
    },
  );
});
