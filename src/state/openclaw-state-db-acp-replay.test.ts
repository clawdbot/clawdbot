import path from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { expectAcpReplayUtf8Accounting } from "../acp/event-ledger.test-support.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { isOpenClawStateSchemaFastPathEligible } from "./openclaw-state-db-fast-path.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";

function seedLegacyReplay(db: DatabaseSync) {
  const session = db.prepare(`INSERT INTO acp_replay_sessions
    (session_id, session_key, cwd, complete, created_at, updated_at, next_seq, estimated_bytes)
    VALUES (?, ?, ?, 1, 123, 456, 5, ?)`);
  const event = db.prepare(`INSERT INTO acp_replay_events
    (session_id, seq, at, session_key, run_id, update_json, estimated_bytes)
    VALUES (?, ?, 321, ?, ?, ?, ?)`);
  for (const [index, estimate] of [0, 17, 9000].entries()) {
    const id = `session-${index}-漢\0\ud800`;
    session.run(id, "key😀", "/é/e\u0301/台\0😀", estimate);
    for (let seq = 1; seq <= 3; seq++) {
      event.run(
        id,
        seq,
        "key😀\0",
        seq % 2 ? null : "run-\udc00",
        '{ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "漢😀\\u0000\\ud800" } }  ',
        estimate,
      );
    }
  }
  // Even already-correct event estimates must contribute to a repaired aggregate.
  event.run("session-0-漢\0\ud800", 4, "ascii", null, "{}", 56);
  db.exec(
    "UPDATE schema_meta SET app_version = 'synthetic-previous-build' WHERE meta_key = 'primary'",
  );
}

function canonicalReplay(db: DatabaseSync) {
  return {
    sessions: db
      .prepare(
        "SELECT session_id, session_key, cwd, complete, created_at, updated_at, next_seq FROM acp_replay_sessions ORDER BY session_id",
      )
      .all(),
    events: db
      .prepare(
        "SELECT session_id, seq, at, session_key, run_id, update_json FROM acp_replay_events ORDER BY session_id, seq",
      )
      .all(),
  };
}

function estimates(db: DatabaseSync) {
  return {
    sessions: db
      .prepare("SELECT estimated_bytes FROM acp_replay_sessions ORDER BY session_id")
      .all(),
    events: db
      .prepare("SELECT estimated_bytes FROM acp_replay_events ORDER BY session_id, seq")
      .all(),
    version: db.prepare("SELECT app_version FROM schema_meta WHERE meta_key = 'primary'").get(),
  };
}

describe("ACP replay accounting repair", () => {
  afterEach(() => closeOpenClawStateDatabaseForTest());

  it.each(["UTF-8", "UTF-16le"])(
    "repairs every derived total on app-version reopen without changing canonical %s rows",
    async (encoding) => {
      await withTestDir({ prefix: "openclaw-acp-repair-" }, async (dir) => {
        const options = { path: path.join(dir, "state.sqlite") };
        const seed = new DatabaseSync(options.path);
        seed.exec(
          `PRAGMA encoding = '${encoding}'; CREATE TABLE encoding_seed (id INTEGER); DROP TABLE encoding_seed;`,
        );
        seed.close();
        const initial = openOpenClawStateDatabase(options).db;
        seedLegacyReplay(initial);
        const before = canonicalReplay(initial);
        closeOpenClawStateDatabaseForTest();
        const repaired = openOpenClawStateDatabase(options).db;
        expectAcpReplayUtf8Accounting(repaired);
        expect(canonicalReplay(repaired)).toEqual(before);
        const repairedEstimates = estimates(repaired);
        closeOpenClawStateDatabaseForTest();

        const reopened = openOpenClawStateDatabase(options).db;
        expect(reopened.prepare("SELECT total_changes() AS count").get()?.count).toBe(0);
        expect(estimates(reopened)).toEqual(repairedEstimates);
        reopened.setAuthorizer((action, table, column) =>
          action === constants.SQLITE_READ &&
          table === "acp_replay_events" &&
          column === "update_json"
            ? constants.SQLITE_DENY
            : constants.SQLITE_OK,
        );
        try {
          expect(isOpenClawStateSchemaFastPathEligible(reopened, options.path)).toBe(true);
        } finally {
          reopened.setAuthorizer(null);
        }
      });
    },
  );

  it("rolls back event repairs and the release checkpoint when a later session repair fails, then doctor retries atomically", async () => {
    await withTestDir({ prefix: "openclaw-acp-repair-" }, async (dir) => {
      const options = { path: path.join(dir, "state.sqlite") };
      const initial = openOpenClawStateDatabase(options).db;
      seedLegacyReplay(initial);
      const before = canonicalReplay(initial);
      const oldEstimates = estimates(initial);
      initial.exec(`CREATE TRIGGER reject_acp_session_repair BEFORE UPDATE OF estimated_bytes ON acp_replay_sessions
        BEGIN SELECT RAISE(ABORT, 'synthetic ACP repair failure'); END`);
      closeOpenClawStateDatabaseForTest();
      const failed = repairOpenClawStateDatabaseSchema(options);
      expect(failed.warnings.join(" ")).toContain("synthetic ACP repair failure");
      const inspect = new DatabaseSync(options.path);
      try {
        expect(canonicalReplay(inspect)).toEqual(before);
        expect(estimates(inspect)).toEqual(oldEstimates);
        inspect.exec("DROP TRIGGER reject_acp_session_repair");
      } finally {
        inspect.close();
      }
      expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
      const repaired = openOpenClawStateDatabase(options).db;
      expectAcpReplayUtf8Accounting(repaired);
      expect(canonicalReplay(repaired)).toEqual(before);
    });
  });
});
