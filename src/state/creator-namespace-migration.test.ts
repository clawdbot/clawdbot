import { backup } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { loadCronStore, saveCronStore } from "../cron/store.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closeOpenClawAgentDatabasesForTest,
  ensureOpenClawAgentDatabaseSchema,
  openOpenClawAgentDatabase,
  withAgentDatabaseMaintenanceLease,
} from "./openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

describe("creator namespace upgrades", () => {
  it("qualifies only proven historical seams atomically and keeps a restorable backup", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const options = { agentId: "main", env: state.env };
      const cases = [
        ["operator", "profile"],
        ["run", "profile"],
        ["channel", "channel"],
        ["cron", "unknown"],
        ["spawn", "unknown"],
        ["talk", "unknown"],
        [undefined, "unknown"],
      ] as const;
      for (const [via] of cases) {
        await upsertSessionEntryCore(
          { ...options, sessionKey: `agent:main:${via ?? "unknown"}` },
          {
            sessionId: via ?? "unknown",
            updatedAt: 10,
            createdAt: 5,
            createdVia: via,
            createdActor: { type: "human", source: "unknown", id: "same-id", label: "Retain me" },
            sandbox: "required",
            visibility: "draft",
          },
        );
      }
      await upsertSessionEntryCore(
        { ...options, sessionKey: "agent:main:legacy" },
        {
          sessionId: "legacy",
          updatedAt: 10,
          createdVia: "operator",
        },
      );
      const initial = openOpenClawAgentDatabase(options);
      initial.db.exec(
        `UPDATE session_nodes SET entry_json = json_set(entry_json, '$.createdBy', json('{"id":"old-id","label":"Legacy label"}')) WHERE session_key = 'agent:main:legacy'`,
      );
      initial.db
        .exec(`UPDATE session_nodes SET entry_json = json_remove(entry_json, '$.createdActor.source');
        PRAGMA user_version = 18; UPDATE schema_meta SET schema_version = 18;`);
      const backupPath = state.path("before.sqlite");
      await backup(initial.db, backupPath);
      const databasePath = initial.path;
      closeOpenClawAgentDatabasesForTest();
      const db = openNodeSqliteDatabase(databasePath);
      const migrate = () =>
        ensureOpenClawAgentDatabaseSchema(db, { ...options, path: databasePath });
      try {
        expect(migrate).toThrow(/maintenance/);
        const execute = db.exec.bind(db);
        const fault = vi.spyOn(db, "exec").mockImplementation((sql) => {
          if (sql === "PRAGMA user_version = 19;") {
            throw new Error("injected commit failure");
          }
          return execute(sql);
        });
        try {
          await expect(
            withAgentDatabaseMaintenanceLease({ env: state.env }, async () => migrate()),
          ).rejects.toThrow(/injected/);
        } finally {
          fault.mockRestore();
        }
        expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(18);
        expect(
          db
            .prepare(
              "SELECT json_extract(entry_json, '$.createdActor.source') AS source FROM session_nodes",
            )
            .all()
            .every((row) => row.source === null),
        ).toBe(true);
        await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => migrate());
        expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(19);
        expect(
          db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get()
            ?.schema_version,
        ).toBe(19);
        expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        db.close();
      }
      for (const [via, source] of cases) {
        expect(
          loadSessionEntry({ ...options, sessionKey: `agent:main:${via ?? "unknown"}` }),
        ).toMatchObject({
          createdActor: { type: "human", source, id: "same-id", label: "Retain me" },
          sandbox: "required",
          visibility: "draft",
          createdAt: 5,
        });
      }
      expect(loadSessionEntry({ ...options, sessionKey: "agent:main:legacy" })).toMatchObject({
        createdActor: { type: "human", source: "unknown", id: "old-id", label: "Legacy label" },
      });
      const restored = openNodeSqliteDatabase(backupPath, { readOnly: true });
      try {
        expect(restored.prepare("PRAGMA user_version").get()?.user_version).toBe(18);
        expect(restored.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
        expect(restored.prepare("SELECT count(*) AS count FROM session_nodes").get()?.count).toBe(
          cases.length + 1,
        );
      } finally {
        restored.close();
      }
    });
  });

  it("retains historical cron attribution as unknown through the actual store upgrade", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.statePath("cron", "jobs.json");
      await saveCronStore(storePath, {
        version: 1,
        jobs: [
          {
            ...makeCronJob({}),
            createdActor: {
              type: "human",
              source: "profile",
              id: "same-id",
              label: "Retain me",
            },
          },
        ],
      });
      const initial = openOpenClawStateDatabase({ env: state.env });
      initial.db
        .exec(`UPDATE cron_jobs SET job_json = json_remove(job_json, '$.createdActor.source');
        PRAGMA user_version = 13; UPDATE schema_meta SET schema_version = 13;`);
      closeOpenClawStateDatabaseForTest();
      const reopened = openOpenClawStateDatabase({ env: state.env });
      expect(reopened.db.prepare("PRAGMA user_version").get()?.user_version).toBe(14);
      expect((await loadCronStore(storePath)).jobs[0]).toMatchObject({
        createdActor: {
          type: "human",
          source: "unknown",
          id: "same-id",
          label: "Retain me",
        },
      });
    });
  });
});
