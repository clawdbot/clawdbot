// Agent database cache tests cover bounded process-local SQLite handle ownership.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  disposeOpenClawAgentDatabaseByPath,
  isOpenClawAgentDatabaseOpen,
  listOpenClawAgentDatabasesForTest,
  listOpenClawRegisteredAgentDatabases,
  OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

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
