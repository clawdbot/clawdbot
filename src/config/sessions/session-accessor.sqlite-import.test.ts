import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTranscriptEventReader } from "../../commands/doctor-session-sqlite-readers.js";
import * as sqliteDirectories from "../../infra/sqlite-private-directory.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { loadExactSessionEntry } from "./session-accessor.sqlite-entry.js";
import {
  importSqliteSessionRows,
  importSqliteSessionRowsBatch,
} from "./session-accessor.sqlite-import.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";

function target(state: OpenClawTestState, id: string) {
  return {
    agentId: "main",
    env: state.env,
    sessionKey: `agent:main:${id}`,
    storePath: path.join(state.sessionsDir(), "sessions.json"),
    entry: { sessionId: id, updatedAt: 42 },
  };
}
const message = {
  type: "message",
  id: "one",
  parentId: null,
  message: { role: "user", content: "preserved" },
};
afterEach(() => vi.restoreAllMocks());

// Observe the real allocator on both POSIX and Windows without replacing its permission checks.
function observeStages() {
  const allocation = vi.spyOn(sqliteDirectories, "createPrivateSqliteTempDirectorySync");
  return () =>
    allocation.mock.results.flatMap((result, index) =>
      result.type === "return" && allocation.mock.calls[index]?.[1] === "openclaw-session-import-"
        ? [result.value]
        : [],
    );
}

it.each(["prepare", "append", "commit"])(
  "leaves canonical rows unchanged and removes private staging after %s failure",
  async (phase) => {
    await withOpenClawTestState({ label: "import-rollback" }, async (state) => {
      const first = target(state, "first");
      const second = target(state, "second");
      await importSqliteSessionRows({
        ...first,
        readTranscriptEvents: (append) => {
          append(message);
        },
      });
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const before = database.db.prepare("SELECT * FROM transcript_events").all();
      const entriesBefore = database.db.prepare("SELECT * FROM session_nodes").all();
      const stages = observeStages();
      const exec = database.db.exec.bind(database.db);
      if (phase === "append") {
        database.db.exec(`
          CREATE TRIGGER fail_second_import BEFORE INSERT ON transcript_events
          WHEN NEW.session_id = 'second'
          BEGIN SELECT RAISE(ABORT, 'injected append failure'); END;
        `);
      }
      if (phase === "commit") {
        vi.spyOn(database.db, "exec").mockImplementation((sql) => {
          if (sql === "COMMIT") {
            throw new Error("injected commit failure");
          }
          exec(sql);
        });
      }
      await expect(
        importSqliteSessionRowsBatch([
          {
            ...first,
            entry: { ...first.entry, updatedAt: 100 },
            readTranscriptEvents: (append) => {
              append({ ...message, id: "two", parentId: "one" });
            },
          },
          {
            ...second,
            readTranscriptEvents: (append) => {
              expect(database.db.isTransaction).toBe(false);
              expect(stages()).toHaveLength(1);
              if (process.platform !== "win32") {
                expect(fs.statSync(stages()[0]!).mode & 0o777).toBe(0o700);
                expect(
                  fs.statSync(path.join(stages()[0]!, "transcripts.sqlite")).mode & 0o777,
                ).toBe(0o600);
              }
              append(message);
              if (phase === "prepare") {
                throw new Error("injected prepare failure");
              }
            },
          },
        ]),
      ).rejects.toThrow(`injected ${phase} failure`);
      expect(database.db.isTransaction).toBe(false);
      expect(database.db.prepare("SELECT * FROM transcript_events").all()).toEqual(before);
      expect(database.db.prepare("SELECT * FROM session_nodes").all()).toEqual(entriesBefore);
      expect(stages().every((dir) => !fs.existsSync(dir))).toBe(true);
    });
  },
);

it("revalidates an earlier source after later batch readers finish", async () => {
  await withOpenClawTestState({ label: "import-source-change" }, async (state) => {
    const first = target(state, "first");
    const filename = await state.writeText(
      "source.jsonl",
      `${JSON.stringify({ type: "session", id: "first", version: 3 })}\n${JSON.stringify(message)}\n`,
    );
    const stages = observeStages();
    await expect(
      importSqliteSessionRowsBatch([
        { ...first, readTranscriptEvents: createTranscriptEventReader(filename, "first") },
        {
          ...target(state, "second"),
          readTranscriptEvents: () => {
            fs.appendFileSync(filename, "{}\n");
          },
        },
      ]),
    ).rejects.toThrow("Legacy transcript changed during import");
    expect(loadExactSessionEntry(first)).toBeUndefined();
    expect(stages().every((dir) => !fs.existsSync(dir))).toBe(true);
  });
});

it("deduplicates existing and incoming bytes and identities, preserves aliases, and reruns idempotently", async () => {
  await withOpenClawTestState({ label: "import-dedupe" }, async (state) => {
    const params = {
      ...target(state, "dedupe"),
      sessionKey: "agent:main:ALIAS",
      preserveExactStoredKey: true,
    };
    const first = { ...message, timestamp: 10 };
    const second = { ...message, id: "two", parentId: "one", timestamp: 30 };
    const opaque = { custom: "no identity", timestamp: 25 };
    const readTranscriptEvents = (append: (event: unknown) => void) => {
      for (const event of [
        first,
        first,
        { ...first, timestamp: 20, message: { role: "user", content: "same id loses" } },
        opaque,
        opaque,
        second,
        { ...second, timestamp: 99 },
      ]) {
        append(event);
      }
    };
    const stages = observeStages();
    await importSqliteSessionRows({ ...params, readTranscriptEvents: (append) => append(first) });
    const db = openOpenClawAgentDatabase({ agentId: "main", env: state.env }).db;
    const generation = db.prepare("SELECT generation FROM transcript_rewrite_watermarks").get();
    expect(await importSqliteSessionRows({ ...params, readTranscriptEvents })).toMatchObject({
      transcriptEvents: 2,
      sessionKey: params.sessionKey,
    });
    expect(await importSqliteSessionRows({ ...params, readTranscriptEvents })).toMatchObject({
      transcriptEvents: 0,
    });
    expect(db.prepare("SELECT session_key FROM session_nodes").all()).toEqual([
      { session_key: params.sessionKey },
    ]);
    expect(
      db.prepare("SELECT seq, created_at, event_json FROM transcript_events ORDER BY seq").all(),
    ).toEqual(
      [first, opaque, second].map((event, seq) => ({
        seq,
        created_at: event.timestamp,
        event_json: JSON.stringify(event),
      })),
    );
    expect(
      db.prepare("SELECT event_id FROM transcript_event_identities ORDER BY seq").all(),
    ).toEqual([{ event_id: "one" }, { event_id: "two" }]);
    expect(db.prepare("SELECT updated_at FROM session_windows").get()).toEqual({ updated_at: 99 });
    expect(db.prepare("SELECT generation FROM transcript_rewrite_watermarks").get()).toEqual(
      generation,
    );
    expect(stages()).toHaveLength(3);
    expect(stages().every((dir) => !fs.existsSync(dir))).toBe(true);
  });
});

it("hands off exact SQLite bytes, duplicate IDs, timestamps and owner without append normalization", async () => {
  await withOpenClawTestState({ label: "import-exact" }, async (state) => {
    const params = target(state, "exact");
    const owner = { actor: { type: "human" as const, id: "owner" }, assignedAt: 40 };
    const rows = [
      { createdAt: 41, eventJson: '{ "type": "session", "id": "exact", "version": 3 }' },
      { createdAt: 43, eventJson: JSON.stringify(message, null, 2) },
      { createdAt: 45, eventJson: JSON.stringify(message) },
    ];
    await importSqliteSessionRows({
      ...params,
      entry: { ...params.entry, owner },
      readExactTranscriptRows: (append) => rows.forEach(append),
      transcriptMtimeMs: 50,
    });
    const db = openOpenClawAgentDatabase({ agentId: "main", env: state.env }).db;
    expect(
      db
        .prepare(
          "SELECT created_at AS createdAt, event_json AS eventJson FROM transcript_events ORDER BY seq",
        )
        .all(),
    ).toEqual(rows);
    expect(db.prepare("SELECT count(*) AS count FROM transcript_event_identities").get()).toEqual({
      count: 0,
    });
    expect(loadExactSessionEntry(params)?.entry.owner).toEqual(owner);
    expect(db.prepare("SELECT transcript_updated_at FROM session_windows").get()).toEqual({
      transcript_updated_at: 50,
    });
    expect(
      await importSqliteSessionRows({
        ...params,
        skipIfExists: true,
        readExactTranscriptRows: (append) => append({ createdAt: 99, eventJson: "{}" }),
      }),
    ).toMatchObject({ skippedExisting: true, transcriptEvents: 0 });
    expect(loadTranscriptEventsSync({ ...params, sessionId: "exact" })).toHaveLength(3);
  });
});

it("rejects batches spanning implicit agent stores before reading sources", async () => {
  await withOpenClawTestState({ label: "import-store-boundary" }, async (state) => {
    const read = vi.fn();
    await expect(
      importSqliteSessionRowsBatch(
        ["main", "ops"].map((agentId) => ({
          agentId,
          env: state.env,
          sessionKey: `agent:${agentId}:main`,
          entry: { sessionId: agentId, updatedAt: 1 },
          readTranscriptEvents: read,
        })),
      ),
    ).rejects.toThrow("spans multiple stores");
    expect(read).not.toHaveBeenCalled();
  });
});
