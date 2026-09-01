import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  listSessionPendingInputs,
  stageSessionPendingInput,
} from "../config/sessions/session-accessor.pending-inputs.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { ensureSessionPendingInputsSchema } from "./openclaw-agent-pending-inputs-schema.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { tableHasColumn, tableExists } from "./openclaw-state-db-schema-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawAgentDatabasesForTest());

describe("pending input additive schema", () => {
  it("leaves old stores table-free on reads and preserves accepted input through older-reader use and reopen", async () => {
    const options = {
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-input-schema-") },
    };
    const scope = {
      ...options,
      sessionKey: "agent:main:pending-schema",
      sessionId: "pending-schema-session",
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const filename = openOpenClawAgentDatabase(options).path;
    closeOpenClawAgentDatabasesForTest();
    const previous = new DatabaseSync(filename);
    previous.exec("DROP TABLE session_pending_inputs");
    const version = previous.prepare("PRAGMA user_version").get();
    const metadata = previous
      .prepare("SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary'")
      .get();
    previous.close();
    expect(listSessionPendingInputs(scope)).toEqual({ items: [], total: 0 });
    const candidate = openOpenClawAgentDatabase(options);
    expect(
      candidate.db
        .prepare("SELECT 1 FROM sqlite_schema WHERE name = 'session_pending_inputs'")
        .get(),
    ).toBeUndefined();
    const receipt = await stageSessionPendingInput(scope, {
      runId: "schema-run",
      message: {
        role: "user",
        content: "Retain this accepted input",
        timestamp: 1,
        idempotencyKey: "schema-run:user",
      },
      assertCurrent: () => {},
    });
    receipt!.finish("interrupted");
    ensureSessionPendingInputsSchema(candidate.db);
    closeOpenClawAgentDatabasesForTest();
    const older = new DatabaseSync(filename);
    const previousSql = OPENCLAW_AGENT_SCHEMA_SQL.slice(
      0,
      OPENCLAW_AGENT_SCHEMA_SQL.indexOf("CREATE TABLE IF NOT EXISTS session_pending_inputs ("),
    );
    assertSqliteSchemaContains(older, filename, previousSql);
    older
      .prepare("UPDATE schema_meta SET updated_at = updated_at WHERE meta_key = 'primary'")
      .run();
    expect(older.prepare("PRAGMA user_version").get()).toEqual(version);
    expect(
      older
        .prepare("SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual(metadata);
    older.close();
    expect(listSessionPendingInputs(scope)).toMatchObject({
      total: 1,
      items: [{ state: "interrupted", message: { content: "Retain this accepted input" } }],
    });
    expect(openOpenClawAgentDatabase(options).db.prepare("PRAGMA user_version").get()).toEqual(
      version,
    );
  });

  it("rejects a drifted optional table rather than treating it as absent", () => {
    const options = {
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-input-schema-drift-") },
    };
    const filename = openOpenClawAgentDatabase(options).path;
    closeOpenClawAgentDatabasesForTest();
    const drifted = new DatabaseSync(filename);
    drifted.exec(
      "DROP TABLE session_pending_inputs; CREATE TABLE session_pending_inputs (input_id TEXT NOT NULL PRIMARY KEY) STRICT",
    );
    drifted.close();
    expect(() => openOpenClawAgentDatabase(options)).toThrow(/session_pending_inputs|schema/u);
  });

  it.each(["open", "doctor", "first-use"] as const)(
    "adds consumption to an existing same-version store through %s without changing accepted bytes or version markers",
    async (path) => {
      const options = {
        agentId: "main",
        env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-input-column-") },
      };
      const scope = { ...options, sessionKey: "agent:main:column", sessionId: "column-session" };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const receipt = await stageSessionPendingInput(scope, {
        runId: "column-run",
        message: {
          role: "user",
          content: "Retain exact input",
          timestamp: 1,
          idempotencyKey: "column-run:user",
        },
        assertCurrent: () => {},
      });
      receipt!.finish("interrupted");
      const filename = openOpenClawAgentDatabase(options).path;
      closeOpenClawAgentDatabasesForTest();
      const old = new DatabaseSync(filename);
      old.exec("ALTER TABLE session_pending_inputs DROP COLUMN consumed_event_id");
      const version = old.prepare("PRAGMA user_version").get();
      const metadata = old.prepare("SELECT * FROM schema_meta").all();
      const original = old.prepare("SELECT message_json FROM session_pending_inputs").get();
      old.close();
      expect(listSessionPendingInputs(scope)).toMatchObject({
        total: 1,
        items: [{ state: "interrupted", message: receipt!.message }],
      });
      if (path === "open") {
        openOpenClawAgentDatabase(options);
        closeOpenClawAgentDatabasesForTest();
      } else {
        const current = new DatabaseSync(filename);
        if (path === "doctor") {
          ensureOpenClawAgentDatabaseSchema(current, options);
        } else {
          ensureSessionPendingInputsSchema(current);
        }
        current.close();
      }
      const reopened = new DatabaseSync(filename, { readOnly: true });
      try {
        expect(reopened.prepare("PRAGMA user_version").get()).toEqual(version);
        expect(reopened.prepare("SELECT * FROM schema_meta").all()).toEqual(metadata);
        expect(reopened.prepare("SELECT message_json FROM session_pending_inputs").get()).toEqual(
          original,
        );
        expect(
          reopened.prepare("SELECT consumed_event_id FROM session_pending_inputs").get(),
        ).toEqual({ consumed_event_id: null });
      } finally {
        reopened.close();
      }
    },
  );

  it.each([false, true])(
    "retries first-use DDL after rollback on the same connection (existing table: %s)",
    (existing) => {
      const database = new DatabaseSync(":memory:");
      try {
        database.exec(OPENCLAW_AGENT_SCHEMA_SQL.replace("  consumed_event_id TEXT,\n", ""));
        database.exec("PRAGMA user_version = 19");
        if (!existing) {
          database.exec("DROP TABLE session_pending_inputs");
        }
        const before = database.prepare("PRAGMA schema_version").get();
        expect(() =>
          runSqliteImmediateTransactionSync(database, () => {
            ensureSessionPendingInputsSchema(database);
            throw new Error("abort first use");
          }),
        ).toThrow("abort first use");
        expect(database.prepare("PRAGMA schema_version").get()).toEqual(before);
        expect(tableExists(database, "session_pending_inputs")).toBe(existing);
        expect(tableHasColumn(database, "session_pending_inputs", "consumed_event_id")).toBe(false);
        ensureSessionPendingInputsSchema(database);
        expect(tableHasColumn(database, "session_pending_inputs", "consumed_event_id")).toBe(true);
        const after = database.prepare("PRAGMA schema_version").get();
        ensureSessionPendingInputsSchema(database);
        expect(database.prepare("PRAGMA schema_version").get()).toEqual(after);
        expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 19 });
      } finally {
        database.close();
      }
    },
  );
});
