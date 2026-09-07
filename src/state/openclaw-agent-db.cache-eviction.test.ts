// Agent database cache tests cover bounded process-local SQLite handle ownership.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createDeferredCore } from "../shared/deferred.js";
import { releaseOpenClawAgentDatabaseLease } from "./openclaw-agent-db-lease.js";
import { retainOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly.js";
import {
  borrowOpenClawAgentDatabase,
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  disposeOpenClawAgentDatabaseByPath,
  isOpenClawAgentDatabaseOpen,
  listOpenClawAgentDatabasesForTest,
  listOpenClawRegisteredAgentDatabases,
  OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseAsync,
} from "./openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const BASE_AGENT_IDS = Array.from(
  { length: OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP },
  (_, index) => `fixture-${index}`,
);
const BASE_AGENT_ID_SET = new Set(BASE_AGENT_IDS);

let fixtureEnv: NodeJS.ProcessEnv | undefined;
let fixtureStateDir: string | undefined;
let baseDatabases: ReturnType<typeof openOpenClawAgentDatabase>[] = [];

function requireFixtureEnv(): NodeJS.ProcessEnv {
  if (!fixtureEnv) {
    throw new Error("agent database cache fixture was not initialized");
  }
  return fixtureEnv;
}

function restoreBaseCache(): void {
  const env = requireFixtureEnv();
  for (const database of listOpenClawAgentDatabasesForTest()) {
    if (!BASE_AGENT_ID_SET.has(database.agentId)) {
      closeOpenClawAgentDatabaseByPath(database.path);
    }
  }
  baseDatabases = BASE_AGENT_IDS.map((agentId) => openOpenClawAgentDatabase({ agentId, env }));
}

function closeFirstBaseHandle(): void {
  const first = baseDatabases[0];
  if (!first || !closeOpenClawAgentDatabaseByPath(first.path)) {
    throw new Error("first base agent database was not open");
  }
}

function evictAfterRefreshingBaseHandles(evictorAgentId: string, env: NodeJS.ProcessEnv): void {
  for (const database of baseDatabases.slice(1)) {
    openOpenClawAgentDatabase({ agentId: database.agentId, env });
  }
  openOpenClawAgentDatabase({ agentId: evictorAgentId, env });
}

beforeAll(() => {
  closeOpenClawAgentDatabasesForTest();
  fixtureStateDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-db-cache-")),
  );
  fixtureEnv = { OPENCLAW_STATE_DIR: fixtureStateDir };
  restoreBaseCache();
});

beforeEach(() => {
  // Reopen only the base handle evicted by the previous case, then refresh cache order by hits.
  restoreBaseCache();
});

afterAll(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  if (fixtureStateDir) {
    fs.rmSync(fixtureStateDir, { force: true, recursive: true });
  }
});

describe("openclaw agent database handle cache", () => {
  it("rechecks idle cache capacity after concurrent native admissions", async () => {
    const env = requireFixtureEnv();
    closeFirstBaseHandle();
    const opened = await Promise.all(
      ["async-first", "async-second"].map((agentId) =>
        withOpenClawAgentDatabaseAsync({ agentId, env }, (database) => database),
      ),
    );
    expect(opened.every((database) => database.db.isOpen)).toBe(true);
    expect(listOpenClawAgentDatabasesForTest()).toHaveLength(OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP);
  });

  it("retains concurrent admissions through adoption and the transaction's borrower handoff", async () => {
    const env = requireFixtureEnv();
    closeFirstBaseHandle();
    const baseBorrows = baseDatabases
      .slice(1)
      .map(({ agentId }) => borrowOpenClawAgentDatabase({ agentId, env }));
    const entered = createDeferredCore();
    const proceed = createDeferredCore();
    const transferred: ReturnType<typeof borrowOpenClawAgentDatabase>[] = [];
    let operations = 0;
    const admitted = ["adoption-first", "adoption-second"].map((agentId) => {
      const options = { agentId, env };
      return withOpenClawAgentDatabaseAsync(options, async (database) => {
        if (++operations === 2) {
          entered.resolve();
        }
        await (async () => await proceed.promise)();
        expect(database.db.isOpen).toBe(true);
        return runOpenClawAgentWriteTransaction((current) => {
          expect(current.db).toBe(database.db);
          transferred.push(borrowOpenClawAgentDatabase(options));
          return database;
        }, options);
      });
    });
    const finished = Promise.all(admitted);
    try {
      await Promise.race([entered.promise, finished]);
      openOpenClawAgentDatabase({ agentId: "adoption-pressure", env });
      proceed.resolve();
      const databases = await finished;
      expect(databases.every((database) => database.db.isOpen)).toBe(true);
      expect(listOpenClawAgentDatabasesForTest()).toHaveLength(
        OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP + 2,
      );
      for (const borrowed of transferred) {
        borrowed.release();
      }
      openOpenClawAgentDatabase({ agentId: "after-adoption", env });
      expect(databases.every((database) => !database.db.isOpen)).toBe(true);
    } finally {
      proceed.resolve();
      await Promise.allSettled(admitted);
      for (const borrowed of [...transferred, ...baseBorrows]) {
        borrowed.release();
      }
    }
  });

  it.each([false, true])(
    "releases a cached operation's borrow after settlement (throws=%s)",
    async (throws) => {
      const env = requireFixtureEnv();
      const target = baseDatabases[0]!;
      const retained = baseDatabases
        .slice(1)
        .map(({ agentId }) => borrowOpenClawAgentDatabase({ agentId, env }));
      const entered = createDeferredCore();
      const proceed = createDeferredCore();
      const result = withOpenClawAgentDatabaseAsync(
        { agentId: target.agentId, env },
        async (database) => {
          entered.resolve();
          await (async () => await proceed.promise)();
          expect(database).toBe(target);
          expect(database.db.isOpen).toBe(true);
          if (throws) {
            throw new Error("synthetic operation failure");
          }
          return database.agentId;
        },
      );
      const settled = throws
        ? expect(result).rejects.toThrow("synthetic operation failure")
        : expect(result).resolves.toBe(target.agentId);
      try {
        await entered.promise;
        openOpenClawAgentDatabase({ agentId: "cached-operation-pressure", env });
        expect(target.db.isOpen).toBe(true);
        proceed.resolve();
        await settled;
        openOpenClawAgentDatabase({ agentId: "after-cached-operation", env });
        expect(target.db.isOpen).toBe(false);
      } finally {
        proceed.resolve();
        await Promise.allSettled([result]);
        for (const borrowed of retained) {
          borrowed.release();
        }
      }
    },
  );

  it("does not invoke an admitted operation after explicit disposal revokes its handle", async () => {
    const env = requireFixtureEnv();
    const target = baseDatabases[0]!;
    const operation = vi.fn();
    const result = withOpenClawAgentDatabaseAsync({ agentId: target.agentId, env }, operation);
    closeOpenClawAgentDatabaseByPath(target.path);
    await expect(result).rejects.toThrow(/closed|revoked/);
    expect(operation).not.toHaveBeenCalled();
  });

  it("keeps only the capped number of open handles", () => {
    const env = requireFixtureEnv();
    const databases = [
      ...baseDatabases,
      openOpenClawAgentDatabase({ agentId: "cap-overflow", env }),
    ];
    const leastRecentlyUsed = databases[0]!;

    expect(databases.filter((database) => database.db.isOpen)).toHaveLength(
      OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP,
    );
    expect(isOpenClawAgentDatabaseOpen(leastRecentlyUsed.path)).toBe(false);
    expect(leastRecentlyUsed.db.isOpen).toBe(false);
  });

  it("refreshes cache-hit recency before evicting the true LRU handle", () => {
    const env = requireFixtureEnv();
    const recentlyUsed = baseDatabases[0]!;
    const leastRecentlyUsed = baseDatabases[1]!;

    expect(openOpenClawAgentDatabase({ agentId: recentlyUsed.agentId, env })).toBe(recentlyUsed);
    openOpenClawAgentDatabase({ agentId: "recency-newest", env });

    expect(recentlyUsed.db.isOpen).toBe(true);
    expect(isOpenClawAgentDatabaseOpen(recentlyUsed.path)).toBe(true);
    expect(leastRecentlyUsed.db.isOpen).toBe(false);
    expect(isOpenClawAgentDatabaseOpen(leastRecentlyUsed.path)).toBe(false);
  });

  it("releases an evicted lease in its acquisition store after its environment changes", () => {
    const env = requireFixtureEnv();
    const stateDir = env.OPENCLAW_STATE_DIR;
    const nextStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lease-eviction-"));
    const evicted = baseDatabases[0]!;
    const { db: state } = openOpenClawStateDatabase({ env });
    const leases = () =>
      state.prepare("SELECT lease_id FROM agent_database_leases WHERE path = ?").all(evicted.path);
    const acquiredLeases = leases();
    expect(acquiredLeases).toHaveLength(1);
    try {
      env.OPENCLAW_STATE_DIR = nextStateDir;
      openOpenClawAgentDatabase({
        agentId: "lease-owner-evictor",
        env: { OPENCLAW_STATE_DIR: stateDir },
      });
      expect(evicted.db.isOpen).toBe(false);
      expect(leases()).toEqual([]);
      expect(fs.readdirSync(nextStateDir)).toEqual([]);
    } finally {
      env.OPENCLAW_STATE_DIR = stateDir;
      // A failing regression must not leave its original UUID in the shared fixture.
      for (const lease of acquiredLeases) {
        releaseOpenClawAgentDatabaseLease(String(lease.lease_id), { env });
      }
      closeOpenClawStateDatabaseForTest();
      fs.rmSync(nextStateDir, { recursive: true, force: true });
    }
  });

  it("never evicts an LRU handle with an open transaction", () => {
    const env = requireFixtureEnv();
    const transactionOwner = baseDatabases[0]!;
    transactionOwner.db.exec("BEGIN IMMEDIATE");
    try {
      const leastRecentlyUsed = baseDatabases[1]!;
      openOpenClawAgentDatabase({ agentId: "transaction-newest", env });

      expect(transactionOwner.db.isOpen).toBe(true);
      expect(transactionOwner.db.isTransaction).toBe(true);
      expect(isOpenClawAgentDatabaseOpen(transactionOwner.path)).toBe(true);
      expect(leastRecentlyUsed.db.isOpen).toBe(false);
      expect(isOpenClawAgentDatabaseOpen(leastRecentlyUsed.path)).toBe(false);
    } finally {
      transactionOwner.db.exec("ROLLBACK");
    }
  });

  it("pins a completion's exact database until its claim is released", () => {
    const env = requireFixtureEnv();
    const first = baseDatabases[0]!;
    const retained = retainOpenClawAgentDatabaseReadOnly({ agentId: first.agentId, env });
    if (!retained.found) {
      throw new Error("expected the cached database");
    }
    const { claim } = retained;
    try {
      evictAfterRefreshingBaseHandles("completion-pinned", env);
      expect(claim.isCurrent()).toBe(true);
      expect(first.db.isOpen).toBe(true);
      claim.release();
      evictAfterRefreshingBaseHandles("completion-released", env);
      expect(first.db.isOpen).toBe(false);
      expect(claim.isCurrent()).toBe(false);
    } finally {
      claim.release();
    }
  });

  it("retries lease cleanup for a closed retained handle before evicting unrelated agents", () => {
    const env = requireFixtureEnv();
    const first = baseDatabases[0]!;
    const borrowed = borrowOpenClawAgentDatabase({ agentId: first.agentId, env });
    const { db: state } = openOpenClawStateDatabase({ env });
    state.exec(`CREATE TEMP TRIGGER fail_agent_lease_release BEFORE DELETE ON agent_database_leases
      BEGIN SELECT RAISE(ABORT, 'blocked lease release'); END`);
    try {
      expect(() => closeOpenClawAgentDatabaseByPath(first.path)).toThrow("blocked lease release");
      expect(borrowed.db.isOpen).toBe(false);
      state.exec("DROP TRIGGER fail_agent_lease_release");

      evictAfterRefreshingBaseHandles("lease-recovery", env);
      expect(listOpenClawAgentDatabasesForTest()).toHaveLength(OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP);
      expect(
        state
          .prepare("SELECT lease_id FROM agent_database_leases WHERE agent_id = ?")
          .all(first.agentId),
      ).toEqual([]);
    } finally {
      state.exec("DROP TRIGGER IF EXISTS fail_agent_lease_release");
      borrowed.release();
      closeOpenClawAgentDatabaseByPath(first.path);
    }
  });

  it("reopens an evicted database without losing durable rows", () => {
    const env = requireFixtureEnv();
    const evicted = baseDatabases[0]!;
    evicted.db
      .prepare(
        "INSERT INTO auth_profile_state (state_key, state_json, updated_at) VALUES (?, ?, ?)",
      )
      .run("cache-eviction", JSON.stringify({ preserved: true }), 42);

    openOpenClawAgentDatabase({ agentId: "durability-evictor", env });
    expect(evicted.db.isOpen).toBe(false);

    const { DatabaseSync } = requireNodeSqlite();
    const divergent = new DatabaseSync(evicted.path);
    try {
      divergent.exec("ALTER TABLE session_nodes DROP COLUMN project_id;");
    } finally {
      divergent.close();
    }

    const reopened = openOpenClawAgentDatabase({ agentId: evicted.agentId, env });
    expect(reopened).not.toBe(evicted);
    expect(
      reopened.db
        .prepare("PRAGMA table_info(session_nodes)")
        .all()
        .some((row) => (row as { name?: unknown }).name === "project_id"),
    ).toBe(true);
    expect(
      reopened.db
        .prepare("SELECT state_json, updated_at FROM auth_profile_state WHERE state_key = ?")
        .get("cache-eviction"),
    ).toEqual({ state_json: JSON.stringify({ preserved: true }), updated_at: 42 });
  });

  it("registers a first open without refreshing registry metadata after eviction", () => {
    const env = requireFixtureEnv();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      closeFirstBaseHandle();
      const evicted = openOpenClawAgentDatabase({ agentId: "evicted", env });
      expect(
        listOpenClawRegisteredAgentDatabases({ env }).find(
          (entry) => entry.agentId === "evicted" && entry.path === evicted.path,
        ),
      ).toMatchObject({ lastSeenAt: 1_000 });

      nowSpy.mockReturnValue(2_000);
      evictAfterRefreshingBaseHandles("registry-evictor", env);
      expect(evicted.db.isOpen).toBe(false);

      openOpenClawAgentDatabase({ agentId: "evicted", env });
      expect(
        listOpenClawRegisteredAgentDatabases({ env }).find(
          (entry) => entry.agentId === "evicted" && entry.path === evicted.path,
        ),
      ).toMatchObject({ lastSeenAt: 1_000 });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("validates ownership when an evicted path is requested for another agent", () => {
    const env = requireFixtureEnv();
    closeFirstBaseHandle();
    const evicted = openOpenClawAgentDatabase({ agentId: "worker-a", env });
    evictAfterRefreshingBaseHandles("ownership-evictor", env);
    expect(evicted.db.isOpen).toBe(false);

    expect(() =>
      openOpenClawAgentDatabase({ agentId: "worker-b", env, path: evicted.path }),
    ).toThrow(/belongs to agent worker-a/);
  });

  it("revalidates and registers a database after explicit disposal", () => {
    const env = requireFixtureEnv();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const disposed = openOpenClawAgentDatabase({ agentId: "disposed", env });
      expect(
        listOpenClawRegisteredAgentDatabases({ env }).find(
          (entry) => entry.agentId === "disposed" && entry.path === disposed.path,
        ),
      ).toMatchObject({ lastSeenAt: 1_000 });

      expect(disposeOpenClawAgentDatabaseByPath(disposed.path, { env })).toBe(true);
      expect(
        listOpenClawRegisteredAgentDatabases({ env }).some(
          (entry) => entry.agentId === "disposed" && entry.path === disposed.path,
        ),
      ).toBe(false);

      nowSpy.mockReturnValue(2_000);
      openOpenClawAgentDatabase({ agentId: "disposed", env, path: disposed.path });
      expect(
        listOpenClawRegisteredAgentDatabases({ env }).find(
          (entry) => entry.agentId === "disposed" && entry.path === disposed.path,
        ),
      ).toMatchObject({ lastSeenAt: 2_000 });
    } finally {
      nowSpy.mockRestore();
    }
  });
});
