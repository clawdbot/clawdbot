import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { beginAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import { purgeAgentSessionStoreEntries } from "../config/sessions/cleanup-service.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { assertNoOpenClawAgentDatabaseLeases } from "./openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
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
    begin: () => beginAgentDeletion(entry, { env: options.env }),
  };
}

describe("agent deletion database cleanup authority", () => {
  it("keeps a cold cleanup handle private through awaits and closes it before settlement", async () => {
    const f = fixture();
    const deletion = f.begin();
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

  it.each(["replace", "rollback", "finish"] as const)(
    "rejects cleanup writes after its journal owner is retired by %s",
    async (retire) => {
      const f = fixture();
      const deletion = f.begin();
      const opened = createDeferred();
      const release = createDeferred();
      const running = deletion.runDatabaseCleanup(f.target, async () => {
        const database = openOpenClawAgentDatabase(f.options);
        opened.resolve();
        await release.promise;
        expect(() => f.write("stale")).toThrow("no longer owns database cleanup");
        return database;
      });
      try {
        await opened.promise;
        if (retire === "replace") {
          f.begin();
        } else {
          deletion[retire]();
        }
      } finally {
        release.resolve();
        expect((await running).db.isOpen).toBe(false);
      }
      expect(f.read()).toBe("before");
    },
  );

  it("binds the cleanup target to its state database, identity, and physical locator", async () => {
    const f = fixture();
    const other = fixture();
    const deletion = f.begin();
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

  it.each([false, true])(
    "retains failed cleanup close ownership (operation also failed: %s)",
    async (failRun) => {
      const f = fixture();
      const deletion = f.begin();
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
    },
  );

  it("never exempts a foreign deletion journal's overlapping path", async () => {
    const f = fixture();
    const foreign = beginAgentDeletion({ ...f.entry, agentId: "kept" }, { env: f.options.env });
    const deletion = f.begin();
    await expect(
      deletion.runDatabaseCleanup(f.target, async () => f.write("blocked")),
    ).rejects.toThrow("agent kept deletion owns");
    expect(f.read()).toBe("before");
    foreign.rollback();
    await deletion.runDatabaseCleanup(f.target, async () => f.write("retried"));
    expect(f.read()).toBe("retried");
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
      const deletion = f.begin();
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
    },
  );
});
