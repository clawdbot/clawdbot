import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import * as sqliteQueries from "../../infra/kysely-sync.js";
import * as agentDatabase from "../../state/openclaw-agent-db.js";
import {
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  loadTranscriptEvents,
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  readRecentSessionTranscriptActiveEvents,
  waitForSessionTranscriptProjection,
} from "./session-accessor.sqlite-active-events.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const transactionInjection = vi.hoisted(() => ({ run: null as (() => void) | null }));

vi.mock("../../state/openclaw-agent-db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof agentDatabase>();
  return {
    ...actual,
    runOpenClawAgentWriteTransaction: <T>(
      run: Parameters<typeof actual.runOpenClawAgentWriteTransaction<T>>[0],
      options: Parameters<typeof actual.runOpenClawAgentWriteTransaction<T>>[1],
    ) => {
      const inject = transactionInjection.run;
      transactionInjection.run = null;
      inject?.();
      return actual.runOpenClawAgentWriteTransaction(run, options);
    },
  };
});

describe("reset boundary concurrency", () => {
  const tempDirs: string[] = [];
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = makeTempDir(tempDirs, "openclaw-reset-boundary-race-");
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    transactionInjection.run = null;
    agentDatabase.closeOpenClawAgentDatabasesForTest();
    cleanupTempDirs(tempDirs);
  });

  it("does not commit a reset after its caller closes during entry preparation", async () => {
    const sessionKey = "agent:main:closing-reset";
    const scope = { sessionKey, storePath };
    await upsertSessionEntryCore(scope, { sessionId: "current-reset", updatedAt: 10 });
    let current = true;
    const commitGuard = () => {
      if (!current) {
        throw new Error("reset caller closed");
      }
    };
    await expect(
      resetSessionEntryLifecycle({
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        commitGuard,
        buildNextEntry: () => {
          commitGuard();
          queueMicrotask(() => {
            current = false;
          });
          return { sessionId: "stale-reset", updatedAt: 20 };
        },
      }),
    ).rejects.toThrow("reset caller closed");
    expect(loadSessionEntry(scope)?.sessionId).toBe("current-reset");
  });

  it.each([
    {
      name: "single reset",
      reset: async (scope: { sessionId: string; sessionKey: string; storePath: string }) =>
        resetSessionEntryLifecycle({
          buildNextEntry: () => ({ sessionId: "next-single", updatedAt: 20 }),
          resetBoundary: { context: "preserve-tail", reason: "reset" },
          storePath: scope.storePath,
          target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
        }),
    },
    {
      name: "bulk lifecycle reset",
      reset: async (scope: { sessionId: string; sessionKey: string; storePath: string }) =>
        applySessionEntryLifecycleMutation({
          skipMaintenance: true,
          storePath: scope.storePath,
          upserts: [
            {
              entry: { sessionId: "next-bulk", updatedAt: 20 },
              resetBoundary: { context: "preserve-tail", reason: "reset" },
              sessionKey: scope.sessionKey,
            },
          ],
        }),
    },
  ])("parents the $name boundary without hydrating prior message bodies", async ({ reset }) => {
    const scope = {
      sessionId: "current-session",
      sessionKey: "agent:main:reset-race",
      storePath,
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    const body = "retained reset message body ".repeat(8_192);
    appendTranscriptMessageSync(scope, {
      eventId: "initial",
      message: { role: "user", content: body },
      parentId: null,
    });
    transactionInjection.run = () => {
      appendTranscriptMessageSync(scope, {
        eventId: "concurrent",
        message: { role: "user", content: "accepted concurrently" },
        parentId: "initial",
      });
    };

    const iterate = sqliteQueries.iterateSqliteQuerySync;
    let hydratedBodyRows = 0;
    const reads = vi.spyOn(sqliteQueries, "iterateSqliteQuerySync").mockImplementation(function* <
      Row,
    >(...args: Parameters<typeof sqliteQueries.iterateSqliteQuerySync<Row>>) {
      for (const row of iterate<Row>(...args)) {
        if (
          row !== null &&
          typeof row === "object" &&
          "event_json" in row &&
          typeof row.event_json === "string" &&
          row.event_json.includes(body)
        ) {
          hydratedBodyRows += 1;
        }
        yield row;
      }
    });
    try {
      await reset(scope);
    } finally {
      reads.mockRestore();
    }

    const raw = await loadTranscriptEvents(scope);
    expect(raw).toContainEqual(
      expect.objectContaining({
        id: "initial",
        message: expect.objectContaining({ role: "user", content: body }),
      }),
    );
    expect(hydratedBodyRows).toBe(0);
    const boundary = raw.find(
      (event) =>
        event !== null &&
        typeof event === "object" &&
        !Array.isArray(event) &&
        (event as { type?: unknown }).type === "reset",
    );
    expect(boundary).toMatchObject({ parentId: "concurrent" });
    await waitForSessionTranscriptProjection(scope);
    expect(
      readRecentSessionTranscriptActiveEvents(scope, 10).map(
        (event) => (event as { id?: unknown }).id,
      ),
    ).toContain("concurrent");

    agentDatabase.closeOpenClawAgentDatabasesForTest();
    await waitForSessionTranscriptProjection(scope);
    expect(
      readRecentSessionTranscriptActiveEvents(scope, 10).map(
        (event) => (event as { id?: unknown }).id,
      ),
    ).toContain("concurrent");
  });

  it("preserves navigation nulls and raw parser semantics in reset reads", async () => {
    const sessionId = "reset-projection";
    await upsertSessionEntryCore(
      { sessionKey: "agent:main:reset-projection", storePath },
      { sessionId, updatedAt: 10 },
    );
    const database = agentDatabase.openOpenClawAgentDatabase({
      agentId: "main",
      path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path,
    });
    const navigationEvents = [
      { type: "message", id: "user", timestamp: 1, message: { role: "user", content: "body" } },
      { type: "leaf", id: "empty", parentId: null, targetId: null },
      {
        type: "leaf",
        id: "selected",
        parentId: "empty",
        targetId: "user",
        appendParentId: null,
        appendMode: "side",
      },
      { type: "reset", id: "reset", parentId: "user", firstKeptEntryId: "user" },
    ] as const;
    const events = [
      ...navigationEvents,
      null,
      "opaque",
      ["opaque"],
      JSON.parse(`{"type":"opaque","body":${"[".repeat(1_001)}0${"]".repeat(1_001)}}`) as unknown,
    ];
    const insert = database.db.prepare(
      "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
    );
    events.forEach((event, seq) => insert.run(sessionId, seq, JSON.stringify(event), seq));

    const projected = loadTranscriptEventsFromDatabase(database, sessionId, {
      projection: "reset-boundary",
    });
    expect(projected[0]).toEqual({
      type: "message",
      id: "user",
      timestamp: 1,
      message: { role: "user" },
    });
    expect(projected[1]).toMatchObject(navigationEvents[1]);
    expect(projected[1]).not.toHaveProperty("appendParentId");
    expect(projected[2]).toMatchObject(navigationEvents[2]);
    expect(projected[3]).toMatchObject(navigationEvents[3]);
    expect(projected.slice(4)).toEqual(events.slice(4));
    expect(loadTranscriptEventsFromDatabase(database, sessionId)).toEqual(events);
    expect(loadTranscriptEventsFromDatabase(database, sessionId, { beforeEventSeq: 2 })).toEqual(
      events.slice(0, 2),
    );

    insert.run(sessionId, events.length, "{", events.length);
    for (const projection of [undefined, "reset-boundary"] as const) {
      expect(() => loadTranscriptEventsFromDatabase(database, sessionId, { projection })).toThrow(
        SyntaxError,
      );
    }
  });
});
