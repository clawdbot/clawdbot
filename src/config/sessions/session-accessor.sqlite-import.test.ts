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
import { listSessionBranches } from "./session-accessor.js";
import { loadExactSessionEntry } from "./session-accessor.sqlite-entry.js";
import {
  importSqliteSessionRows,
  importSqliteSessionRowsBatch,
} from "./session-accessor.sqlite-import.js";
import {
  hasSessionTranscriptMessage,
  loadTranscriptEventsSync,
} from "./session-accessor.sqlite-read.js";

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
    const rejected = { ...second, timestamp: 99 };
    const opaque = { custom: "no identity", timestamp: 25 };
    const readTranscriptEvents = (append: (event: unknown) => void) => {
      for (const event of [
        first,
        first,
        { ...first, timestamp: 20, message: { role: "user", content: "same id loses" } },
        opaque,
        opaque,
        second,
        rejected,
        { ...second, timestamp: 50 },
        rejected,
      ]) {
        append(event);
      }
    };
    const stages = observeStages();
    await importSqliteSessionRows({ ...params, readTranscriptEvents: (append) => append(first) });
    const db = openOpenClawAgentDatabase({ agentId: "main", env: state.env }).db;
    db.prepare("UPDATE session_windows SET created_at = 7 WHERE session_id = ?").run(
      params.entry.sessionId,
    );
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
    expect(db.prepare("SELECT created_at, updated_at FROM session_windows").get()).toEqual({
      created_at: 7,
      updated_at: 99,
    });
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
    const firstMessage = { ...message, timestamp: "2026-08-30T00:00:01.000Z" };
    const canonicalMessage = {
      ...message,
      timestamp: "2026-08-30T00:00:02.000Z",
      message: { role: "user", content: "canonical duplicate" },
    };
    const rows = [
      { createdAt: 41, eventJson: '{ "type": "session", "id": "exact", "version": 3 }' },
      { createdAt: 43, eventJson: JSON.stringify(firstMessage, null, 2) },
      { createdAt: 45, eventJson: JSON.stringify(canonicalMessage) },
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
    await expect(hasSessionTranscriptMessage({ ...params, sessionId: "exact" })).resolves.toBe(
      true,
    );
    await expect(listSessionBranches(params)).resolves.toEqual({
      status: "ok",
      branches: Array.from({ length: 2 }, () => ({
        leafEntryId: "one",
        headline: "canonical duplicate",
        messageCount: 1,
        updatedAt: canonicalMessage.timestamp,
        active: true,
      })),
    });
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

it.each(["implicit", "leaf", "root", "opaque"])(
  "repairs an original-only prompt rewrite branch in staging (leaf control=%s)",
  async (mode) => {
    const leafControl = mode !== "implicit";
    await withOpenClawTestState({ label: "import-branch-repair" }, async (state) => {
      const scope = target(state, "repair");
      const events = [
        {
          type: "session",
          version: 3,
          id: "repair",
          timestamp: "2026-08-30T00:00:00Z",
          cwd: "/fixture",
        },
        {
          type: "message",
          id: "original",
          ...(leafControl ? { parentId: null } : {}),
          message: {
            role: "user",
            content:
              "hello\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nretired context\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
          },
        },
        {
          type: "message",
          id: "visible",
          ...(leafControl ? { parentId: null } : {}),
          message: { role: "user", content: "hello" },
        },
        ...(mode === "opaque" ? [{ type: "metadata", id: "append-root", parentId: null }] : []),
        ...(leafControl
          ? [
              {
                type: "leaf",
                id: "selection",
                parentId: "visible",
                targetId: "visible",
                ...(mode === "root"
                  ? { appendParentId: null }
                  : mode === "opaque"
                    ? { appendParentId: "append-root" }
                    : {}),
              },
            ]
          : []),
      ];
      const result = await importSqliteSessionRows({
        ...scope,
        repairLegacyTranscript: true,
        readTranscriptEvents: (append) => {
          for (const event of events) {
            append(event);
          }
        },
      });
      expect(result.recovery).toMatchObject({ complete: mode !== "opaque", repaired: true });
      const persisted = loadTranscriptEventsSync({ ...scope, sessionId: "repair" });
      expect(persisted).toEqual(
        [
          "repair",
          "visible",
          ...(mode === "opaque" ? ["append-root"] : []),
          ...(leafControl ? ["selection"] : []),
        ].map((id) => expect.objectContaining({ id })),
      );
      if (mode === "root" || mode === "opaque") {
        expect(persisted.at(-1)).toMatchObject({
          targetId: "visible",
          appendParentId: mode === "root" ? null : "append-root",
        });
      }
    });
  },
);

it.each([
  {
    kind: "indexed",
    repeated: {
      type: "message",
      id: "repeated",
      parentId: "root",
      message: { role: "assistant", content: "same replay" },
    },
  },
  {
    kind: "leaf",
    repeated: {
      type: "leaf",
      id: "repeated",
      parentId: "root",
      targetId: "root",
    },
  },
])("repairs an identical repeated $kind event and reruns idempotently", async ({ repeated }) => {
  await withOpenClawTestState({ label: "import-identical-replay" }, async (state) => {
    const scope = target(state, "identical-replay");
    const events = [
      {
        type: "session",
        version: 3,
        id: "identical-replay",
        timestamp: "2026-08-30T00:00:00Z",
        cwd: "/fixture",
      },
      {
        type: "message",
        id: "root",
        parentId: null,
        message: { role: "user", content: "root" },
      },
      repeated,
      repeated,
    ];
    const readTranscriptEvents = (append: (event: unknown) => void) => {
      for (const event of events) {
        append(event);
      }
    };

    const imported = await importSqliteSessionRows({
      ...scope,
      repairLegacyTranscript: true,
      readTranscriptEvents,
    });
    expect(imported).toMatchObject({
      recovery: { complete: true, events: 3, repaired: true },
      transcriptEvents: 3,
    });
    expect(
      loadTranscriptEventsSync({ ...scope, sessionId: "identical-replay" }).map(
        (event) => (event as { id?: string }).id,
      ),
    ).toEqual(["identical-replay", "root", "repeated"]);

    await expect(
      importSqliteSessionRows({
        ...scope,
        repairLegacyTranscript: true,
        readTranscriptEvents,
      }),
    ).resolves.toMatchObject({
      recovery: { complete: true, events: 3, repaired: true },
      transcriptEvents: 0,
    });
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    expect(
      database.db
        .prepare(
          "SELECT event_id, COUNT(*) AS count FROM transcript_event_identities GROUP BY event_id ORDER BY event_id",
        )
        .all(),
    ).toEqual([
      { event_id: "identical-replay", count: 1 },
      { event_id: "repeated", count: 1 },
      { event_id: "root", count: 1 },
    ]);
  });
});
