import { afterEach, describe, expect, it } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { recordAcpParentStreamEvents } from "./acp-parent-stream-store.sqlite.js";
import { listAcpParentStreamEventsForTest } from "./acp-parent-stream-store.sqlite.test-support.js";

describe("ACP parent stream SQLite store", () => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
  });

  it("orders run events and removes them with the child session", async () => {
    await withTempDir({ prefix: "openclaw-acp-parent-stream-" }, async (stateDir) => {
      const options = {
        agentId: "codex",
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      };
      runOpenClawAgentWriteTransaction((database) => {
        const db = getNodeSqliteKysely<
          Pick<OpenClawAgentKyselyDatabase, "session_nodes" | "session_windows">
        >(database.db);
        executeSqliteQuerySync(
          database.db,
          db.insertInto("session_nodes").values({
            session_key: "agent:codex:acp:child",
            current_session_id: "session-1",
            entry_json: "{}",
            updated_at: 1,
          }),
        );
        executeSqliteQuerySync(
          database.db,
          db.insertInto("session_windows").values({
            session_id: "session-1",
            session_key: "agent:codex:acp:child",
            session_scope: "conversation",
            created_at: 1,
            updated_at: 1,
          }),
        );
      }, options);

      recordAcpParentStreamEvents({
        ...options,
        sessionId: "session-1",
        runId: "run-1",
        events: [
          { createdAt: 10, event: { kind: "assistant_delta", delta: "one" } },
          { createdAt: 11, event: { kind: "lifecycle", phase: "end" } },
        ],
      });

      expect(
        listAcpParentStreamEventsForTest({ ...options, sessionId: "session-1", runId: "run-1" }),
      ).toEqual([
        { kind: "assistant_delta", delta: "one" },
        { kind: "lifecycle", phase: "end" },
      ]);

      runOpenClawAgentWriteTransaction((database) => {
        const db = getNodeSqliteKysely<Pick<OpenClawAgentKyselyDatabase, "session_windows">>(
          database.db,
        );
        executeSqliteQuerySync(
          database.db,
          db.deleteFrom("session_windows").where("session_id", "=", "session-1"),
        );
      }, options);
      expect(
        listAcpParentStreamEventsForTest({ ...options, sessionId: "session-1", runId: "run-1" }),
      ).toEqual([]);
    });
  });

  it("drops unserializable events without blocking later diagnostics", async () => {
    await withTempDir({ prefix: "openclaw-acp-parent-stream-invalid-" }, async (stateDir) => {
      const options = {
        agentId: "codex",
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      };
      runOpenClawAgentWriteTransaction((database) => {
        const db = getNodeSqliteKysely<
          Pick<OpenClawAgentKyselyDatabase, "session_nodes" | "session_windows">
        >(database.db);
        executeSqliteQuerySync(
          database.db,
          db.insertInto("session_nodes").values({
            session_key: "agent:codex:acp:invalid",
            current_session_id: "session-1",
            entry_json: "{}",
            updated_at: 1,
          }),
        );
        executeSqliteQuerySync(
          database.db,
          db.insertInto("session_windows").values({
            session_id: "session-1",
            session_key: "agent:codex:acp:invalid",
            session_scope: "conversation",
            created_at: 1,
            updated_at: 1,
          }),
        );
      }, options);
      const circular: Record<string, unknown> = { kind: "circular" };
      circular.self = circular;

      recordAcpParentStreamEvents({
        ...options,
        sessionId: "session-1",
        runId: "run-1",
        events: [
          { createdAt: 10, event: { toJSON: () => undefined } },
          { createdAt: 11, event: circular },
          { createdAt: 12, event: { kind: "lifecycle", phase: "end" } },
        ],
      });

      expect(
        listAcpParentStreamEventsForTest({ ...options, sessionId: "session-1", runId: "run-1" }),
      ).toEqual([{ kind: "lifecycle", phase: "end" }]);
    });
  });
});
