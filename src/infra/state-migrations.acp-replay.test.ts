// Covers fail-closed doctor import of the retired ACP replay JSON ledger.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteAcpEventLedger } from "../acp/event-ledger.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  detectLegacyAcpReplayLedger,
  migrateLegacyAcpReplayLedger,
} from "./state-migrations.acp-replay.js";

function legacyStore() {
  return {
    version: 1,
    sessions: {
      "session-1": {
        sessionId: "session-1",
        sessionKey: "agent:main:work",
        cwd: "/work",
        complete: true,
        createdAt: 1_000,
        updatedAt: 1_000,
        nextSeq: 2,
        events: [
          {
            seq: 1,
            at: 1_000,
            sessionId: "session-1",
            sessionKey: "agent:main:work",
            runId: "run-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Answer" },
            },
          },
        ],
      },
    },
  };
}

async function writeLegacyStore(stateDir: string, value: unknown = legacyStore()): Promise<string> {
  const sourcePath = path.join(stateDir, "acp", "event-ledger.json");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, JSON.stringify(value), "utf8");
  return sourcePath;
}

describe("legacy ACP replay doctor migration", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("detects legacy state only for explicit doctor repair", async () => {
    await withTempDir({ prefix: "openclaw-acp-replay-migration-" }, async (stateDir) => {
      await writeLegacyStore(stateDir);
      expect(detectLegacyAcpReplayLedger({ stateDir }).hasLegacy).toBe(false);
      expect(
        detectLegacyAcpReplayLedger({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy,
      ).toBe(true);
    });
  });

  it("imports, verifies, and removes the retired JSON ledger", async () => {
    await withTempDir({ prefix: "openclaw-acp-replay-migration-" }, async (stateDir) => {
      const sourcePath = await writeLegacyStore(stateDir);
      const result = await migrateLegacyAcpReplayLedger({
        detected: detectLegacyAcpReplayLedger({
          stateDir,
          doctorOnlyStateMigrations: true,
        }),
        stateDir,
      });

      expect(result).toEqual({
        changes: [
          "Migrated 1 ACP replay session(s) and 1 event(s) → shared SQLite state",
          `Removed retired ACP replay ledger ${sourcePath}`,
        ],
        warnings: [],
      });
      await expect(fs.stat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
      const replay = await createSqliteAcpEventLedger({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      }).readReplay({ sessionId: "session-1", sessionKey: "agent:main:work" });
      expect(replay.complete).toBe(true);
      expect(replay.events[0]?.update).toEqual({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Answer" },
      });
      const db = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      }).db;
      const aggregate = db
        .prepare("SELECT estimated_bytes AS total FROM acp_replay_sessions WHERE session_id = ?")
        .get("session-1") as { total: number | bigint };
      const groundTruth = db
        .prepare(
          `SELECT length(s.session_id) + length(s.session_key) + length(s.cwd) + 32
                + COALESCE(SUM(length(e.session_id) + length(e.session_key) + length(e.update_json)
                    + COALESCE(length(e.run_id), 0) + 32), 0) AS total
             FROM acp_replay_sessions s
             LEFT JOIN acp_replay_events e ON e.session_id = s.session_id
            WHERE s.session_id = ?
            GROUP BY s.session_id`,
        )
        .get("session-1") as { total: number | bigint };
      expect(Number(aggregate.total)).toBe(Number(groundTruth.total));
    });
  });

  it("resumes a claimed source without deleting a replacement ledger", async () => {
    await withTempDir({ prefix: "openclaw-acp-replay-migration-" }, async (stateDir) => {
      const sourcePath = await writeLegacyStore(stateDir);
      const claimPath = `${sourcePath}.doctor-import`;
      await fs.rename(sourcePath, claimPath);
      const replacement = legacyStore();
      const replacementSession = replacement.sessions["session-1"];
      await writeLegacyStore(stateDir, {
        ...replacement,
        sessions: {
          "session-2": {
            ...replacementSession,
            sessionId: "session-2",
            events: replacementSession.events.map((event) => {
              const next = structuredClone(event);
              next.sessionId = "session-2";
              return next;
            }),
          },
        },
      });

      const first = await migrateLegacyAcpReplayLedger({
        detected: detectLegacyAcpReplayLedger({
          stateDir,
          doctorOnlyStateMigrations: true,
        }),
        stateDir,
      });

      expect(first.warnings).toEqual([
        `A newer ACP replay ledger remains at ${sourcePath}; rerun doctor to migrate it`,
      ]);
      await expect(fs.stat(claimPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(sourcePath)).resolves.toBeDefined();

      const second = await migrateLegacyAcpReplayLedger({
        detected: detectLegacyAcpReplayLedger({
          stateDir,
          doctorOnlyStateMigrations: true,
        }),
        stateDir,
      });
      expect(second.warnings).toEqual([]);
      await expect(fs.stat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
      const db = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      }).db;
      const rows = db
        .prepare("SELECT session_id FROM acp_replay_sessions ORDER BY session_id")
        .all() as Array<{ session_id: string }>;
      expect(rows.map((row) => row.session_id)).toEqual(["session-1", "session-2"]);
    });
  });

  it("retains malformed state without partially importing it", async () => {
    await withTempDir({ prefix: "openclaw-acp-replay-migration-" }, async (stateDir) => {
      const sourcePath = await writeLegacyStore(stateDir, {
        ...legacyStore(),
        sessions: { broken: { sessionId: "broken" } },
      });
      const result = await migrateLegacyAcpReplayLedger({
        detected: detectLegacyAcpReplayLedger({
          stateDir,
          doctorOnlyStateMigrations: true,
        }),
        stateDir,
      });

      expect(result.changes).toEqual([]);
      expect(result.warnings[0]).toContain("legacy ACP replay session broken is invalid");
      await expect(fs.stat(sourcePath)).resolves.toBeDefined();
      await expect(
        createSqliteAcpEventLedger({
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        }).readReplayBySessionId({ sessionId: "broken" }),
      ).resolves.toEqual({ complete: false, events: [] });
    });
  });

  it("removes a retry source when its prior import already exists", async () => {
    await withTempDir({ prefix: "openclaw-acp-replay-migration-" }, async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const ledger = createSqliteAcpEventLedger({ env, now: () => 1_000 });
      await ledger.startSession({
        sessionId: "session-1",
        sessionKey: "agent:main:work",
        cwd: "/work",
        complete: true,
      });
      await ledger.recordUpdate({
        sessionId: "session-1",
        sessionKey: "agent:main:work",
        runId: "run-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Answer" },
        },
      });
      const db = openOpenClawStateDatabase({ env }).db;
      db.exec(`
        UPDATE acp_replay_events SET estimated_bytes = 0;
        UPDATE acp_replay_sessions SET estimated_bytes = 0;
      `);
      const sourcePath = await writeLegacyStore(stateDir);

      const result = await migrateLegacyAcpReplayLedger({
        detected: detectLegacyAcpReplayLedger({
          stateDir,
          doctorOnlyStateMigrations: true,
        }),
        stateDir,
      });

      expect(result.warnings).toEqual([]);
      expect(result.changes).toContain(
        "Kept 1 existing ACP replay session(s) from shared SQLite state",
      );
      await expect(fs.stat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(ledger.readReplayBySessionId({ sessionId: "session-1" })).resolves.toMatchObject(
        { complete: true, sessionKey: "agent:main:work" },
      );
      expect(
        Number(
          (
            db
              .prepare(
                "SELECT estimated_bytes AS total FROM acp_replay_sessions WHERE session_id = ?",
              )
              .get("session-1") as { total: number | bigint }
          ).total,
        ),
      ).toBeGreaterThan(0);
    });
  });

  it("retains a conflicting retry source instead of discarding changed events", async () => {
    await withTempDir({ prefix: "openclaw-acp-replay-migration-" }, async (stateDir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const ledger = createSqliteAcpEventLedger({ env, now: () => 2_000 });
      await ledger.startSession({
        sessionId: "session-1",
        sessionKey: "agent:main:canonical",
        cwd: "/current",
        complete: true,
      });
      const store = legacyStore();
      const original = store.sessions["session-1"];
      const sourcePath = await writeLegacyStore(stateDir, {
        ...store,
        sessions: {
          "new-session": {
            ...structuredClone(original),
            sessionId: "new-session",
            events: original.events.map((event) => ({
              ...structuredClone(event),
              sessionId: "new-session",
            })),
          },
          "session-1": original,
        },
      });

      const result = await migrateLegacyAcpReplayLedger({
        detected: detectLegacyAcpReplayLedger({
          stateDir,
          doctorOnlyStateMigrations: true,
        }),
        stateDir,
      });

      expect(result.changes).toEqual([]);
      expect(result.warnings[0]).toContain(
        "canonical ACP replay session session-1 conflicts with the legacy source",
      );
      await expect(fs.stat(sourcePath)).resolves.toBeDefined();
      await expect(ledger.readReplayBySessionId({ sessionId: "session-1" })).resolves.toMatchObject(
        { complete: true, sessionKey: "agent:main:canonical" },
      );
      await expect(ledger.readReplayBySessionId({ sessionId: "new-session" })).resolves.toEqual({
        complete: false,
        events: [],
      });
    });
  });

  it("retains a source containing an impossible zero event sequence", async () => {
    await withTempDir({ prefix: "openclaw-acp-replay-migration-" }, async (stateDir) => {
      const store = legacyStore();
      store.sessions["session-1"].events[0]!.seq = 0;
      const sourcePath = await writeLegacyStore(stateDir, store);

      const result = await migrateLegacyAcpReplayLedger({
        detected: detectLegacyAcpReplayLedger({
          stateDir,
          doctorOnlyStateMigrations: true,
        }),
        stateDir,
      });

      expect(result.changes).toEqual([]);
      expect(result.warnings[0]).toContain("contains an invalid event");
      await expect(fs.stat(sourcePath)).resolves.toBeDefined();
    });
  });

  it("runtime ignores the retired JSON ledger until doctor imports it", async () => {
    await withTempDir({ prefix: "openclaw-acp-replay-migration-" }, async (stateDir) => {
      await writeLegacyStore(stateDir);
      await expect(
        createSqliteAcpEventLedger({
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        }).readReplayBySessionId({ sessionId: "session-1" }),
      ).resolves.toEqual({ complete: false, events: [] });
    });
  });
});
