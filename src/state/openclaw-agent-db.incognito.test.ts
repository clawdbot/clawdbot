import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { withOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabases,
  closeOpenClawAgentDatabasesForTest,
  IncognitoAgentDatabasePathCollisionError,
  listOpenClawRegisteredAgentDatabases,
  listOpenIncognitoAgentDatabases,
  openOpenClawAgentDatabase,
  readOpenIncognitoAgentDatabaseGeneration,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

describe("incognito agent database", () => {
  it("does not allocate an in-memory database for a read-only miss", () => {
    const stateDir = fs.realpathSync(
      fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "openclaw-incognito-read-miss-")),
    );
    tempDirs.push(stateDir);
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sentinel = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
    const before = listOpenIncognitoAgentDatabases();

    expect(
      withOpenClawAgentDatabaseReadOnly(() => "unreachable", {
        agentId: "main",
        env,
        path: sentinel,
      }),
    ).toEqual({ found: false, reason: "database-missing" });
    expect(listOpenIncognitoAgentDatabases()).toEqual(before);
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it("refuses a file at the reserved sentinel path before opening in memory", () => {
    const stateDir = fs.realpathSync(
      fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "openclaw-incognito-collision-")),
    );
    tempDirs.push(stateDir);
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sentinel = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, "operator data", "utf8");

    let collision: unknown;
    try {
      openOpenClawAgentDatabase({ agentId: "main", env, path: sentinel });
    } catch (error) {
      collision = error;
    }
    expect(collision).toBeInstanceOf(IncognitoAgentDatabasePathCollisionError);
    expect(collision).toMatchObject({
      name: "IncognitoAgentDatabasePathCollisionError",
      path: sentinel,
      message: expect.stringContaining("move or rename the file"),
    });

    fs.rmSync(sentinel);
    const database = openOpenClawAgentDatabase({ agentId: "main", env, path: sentinel });
    expect(database.db.prepare("SELECT count(*) AS count FROM session_nodes").get()).toEqual({
      count: 0,
    });
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it("boots the canonical schema in one cached memory handle without touching its sentinel path", () => {
    const stateDir = fs.realpathSync(
      fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "openclaw-incognito-db-")),
    );
    tempDirs.push(stateDir);
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sentinel = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
    const beforeGeneration = readOpenIncognitoAgentDatabaseGeneration();

    const first = openOpenClawAgentDatabase({ agentId: "main", env, path: sentinel });
    const openedGeneration = readOpenIncognitoAgentDatabaseGeneration();
    const reopened = openOpenClawAgentDatabase({ agentId: "main", env, path: sentinel });

    expect(openedGeneration).toBeGreaterThan(beforeGeneration);
    expect(readOpenIncognitoAgentDatabaseGeneration()).toBe(openedGeneration);
    expect(reopened).toBe(first);
    expect(listOpenIncognitoAgentDatabases()).toEqual([{ agentId: "main", storePath: sentinel }]);
    expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([]);
    expect(
      withOpenClawAgentDatabaseReadOnly((database) => database.db === first.db, {
        agentId: "main",
        env,
        path: sentinel,
      }),
    ).toEqual({ found: true, value: true });
    expect(
      first.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'session_nodes'")
        .get(),
    ).toEqual({ name: "session_nodes" });
    expect(first.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    expect(() =>
      withOpenClawAgentDatabaseReadOnly(
        ({ db }) => db.prepare("SELECT * FROM missing_readonly_table").all(),
        { agentId: "main", env, path: sentinel },
      ),
    ).toThrow(/no such table: missing_readonly_table/);
    expect(first.db.isOpen).toBe(true);
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(fs.existsSync(path.dirname(sentinel))).toBe(false);

    expect(closeOpenClawAgentDatabaseByPath(sentinel)).toBe(true);
    const closedGeneration = readOpenIncognitoAgentDatabaseGeneration();
    expect(closedGeneration).toBeGreaterThan(openedGeneration);
    expect(closeOpenClawAgentDatabaseByPath(sentinel)).toBe(false);
    expect(readOpenIncognitoAgentDatabaseGeneration()).toBe(closedGeneration);
  });

  it("advances once when close-all removes incognito membership", () => {
    const stateDir = fs.realpathSync(
      fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "openclaw-incognito-close-all-")),
    );
    tempDirs.push(stateDir);
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sentinel = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
    openOpenClawAgentDatabase({ agentId: "main", env, path: sentinel });
    const openedGeneration = readOpenIncognitoAgentDatabaseGeneration();

    closeOpenClawAgentDatabases();
    const closedGeneration = readOpenIncognitoAgentDatabaseGeneration();
    expect(closedGeneration).toBeGreaterThan(openedGeneration);

    closeOpenClawAgentDatabases();
    expect(readOpenIncognitoAgentDatabaseGeneration()).toBe(closedGeneration);
  });
});
