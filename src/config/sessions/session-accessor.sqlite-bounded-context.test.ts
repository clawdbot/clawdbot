import path from "node:path";
import { expect, it } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  readSessionTranscriptActiveStats,
  readSessionTranscriptBoundedActiveContextCore,
} from "./session-accessor.sqlite-active-events.js";
import { importSqliteSessionRows } from "./session-accessor.sqlite-import.js";
import {
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";

async function withBoundedContextScope(
  run: (scope: {
    agentId: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  }) => Promise<void>,
): Promise<void> {
  await withOpenClawTestState({ label: "bounded-transcript-context" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "bounded-context",
      sessionKey: "agent:main:bounded-context",
      storePath: path.join(state.sessionsDir("main"), "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await run(scope);
  });
}

it("reads only the newest bounded active context and accounts for its header", async () => {
  await withBoundedContextScope(async (scope) => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        { eventId: "old", parentId: null, message: { role: "user", content: "old" } },
        { eventId: "middle", parentId: "old", message: { role: "assistant", content: "middle" } },
        { eventId: "new", parentId: "middle", message: { role: "user", content: "new" } },
      ],
      touchSessionEntry: false,
    });

    const context = readSessionTranscriptBoundedActiveContextCore(scope, {
      maxBytes: 1024,
      maxEvents: 2,
    });

    expect(context.events.map((event) => (event as { id?: string }).id)).toEqual([
      scope.sessionId,
      "middle",
      "new",
    ]);
    expect(context.activeLeafEntryId).toBe("new");
    expect(context.totalEvents).toBe(3);
    expect(context.truncated).toBe(true);
    expect(context.serializedBytes).toBeLessThanOrEqual(1024);
    expect(context.serializedBytes).toBeGreaterThan(
      Buffer.byteLength(JSON.stringify(context.events.slice(1)), "utf8"),
    );
  });
});

it("reserves the transcript header inside the exact byte limit", async () => {
  await withBoundedContextScope(async (scope) => {
    await persistSessionTranscriptTurn(scope, {
      messages: [{ eventId: "new", parentId: null, message: { role: "user", content: "new" } }],
      touchSessionEntry: false,
    });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
    const header = database.db
      .prepare(
        "SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq ASC LIMIT 1",
      )
      .get(scope.sessionId) as { event_json: string };
    const headerBytes = Buffer.byteLength(header.event_json, "utf8") + 1;

    const context = readSessionTranscriptBoundedActiveContextCore(scope, {
      maxBytes: headerBytes,
      maxEvents: 10,
    });

    expect(context.events).toHaveLength(1);
    expect(context.events[0]).toMatchObject({ id: scope.sessionId, type: "session" });
    expect(context.serializedBytes).toBe(headerBytes);
    expect(context.truncated).toBe(true);
  });
});

it("selects the session header by type when a mirror row precedes it", async () => {
  await withBoundedContextScope(async (scope) => {
    const mirror = await appendTranscriptMessage(scope, {
      message: { role: "assistant", content: [{ type: "text", text: "New session started." }] },
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        { eventId: "new", parentId: mirror.messageId, message: { role: "user", content: "new" } },
      ],
      touchSessionEntry: false,
    });
    // Settle the projection first, then reproduce the file-era import row order (delivery
    // mirror ahead of the header), which current writers never emit, directly in the store.
    startSessionTranscriptIndexReconcile({
      agentId: scope.agentId,
      preferredSessionId: scope.sessionId,
    });
    await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
    database.db.exec("BEGIN; PRAGMA defer_foreign_keys = ON;");
    for (const [table, column] of [
      ["transcript_events", "seq"],
      ["transcript_event_identities", "seq"],
      ["session_transcript_active_events", "event_seq"],
    ] as const) {
      // Swap seq 0 (header) and seq 1 (mirror) through a spare slot.
      for (const [from, to] of [
        [0, 99],
        [1, 0],
        [99, 1],
      ] as const) {
        database.db
          .prepare(`UPDATE ${table} SET ${column} = ? WHERE session_id = ? AND ${column} = ?`)
          .run(to, scope.sessionId, from);
      }
    }
    database.db.exec("COMMIT;");
    const order = database.db
      .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq ASC")
      .all(scope.sessionId) as Array<{ event_json: string }>;
    expect(order.map((row) => JSON.parse(row.event_json).type)).toEqual([
      "message",
      "session",
      "message",
    ]);

    const context = readSessionTranscriptBoundedActiveContextCore(scope, {
      maxBytes: 4096,
      maxEvents: 10,
    });

    expect(context.events.map((event) => (event as { id?: string }).id)).toEqual([
      scope.sessionId,
      mirror.messageId,
      "new",
    ]);
    expect(context.events[0]).toMatchObject({ type: "session" });
  });
});

it("selects the session header when an exact migrated transcript has no identity rows", async () => {
  await withOpenClawTestState({ label: "bounded-transcript-exact-import" }, async (state) => {
    const scope = {
      agentId: "ops",
      env: state.env,
      sessionId: "exact-import-session",
      sessionKey: "agent:ops:main",
      storePath: path.join(state.sessionsDir("ops"), "sessions.json"),
    };
    await importSqliteSessionRows({
      ...scope,
      entry: { sessionId: scope.sessionId, updatedAt: 1 },
      readExactTranscriptRows: (append) => {
        append({
          createdAt: 1,
          eventJson: JSON.stringify({ type: "session", version: 3, id: scope.sessionId }),
        });
        append({
          createdAt: 2,
          eventJson: JSON.stringify({
            type: "message",
            id: "message-1",
            parentId: null,
            message: { role: "user", content: "hello" },
          }),
        });
      },
    });

    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    const identityCount = database.db
      .prepare("SELECT COUNT(*) AS count FROM transcript_event_identities WHERE session_id = ?")
      .get(scope.sessionId) as { count: number };
    expect(identityCount.count).toBe(0);

    const context = readSessionTranscriptBoundedActiveContextCore(scope, {
      maxBytes: 4096,
      maxEvents: 10,
    });

    expect(context.events.map((event) => (event as { id?: string }).id)).toEqual([
      scope.sessionId,
      "message-1",
    ]);
    expect(context.events[0]).toMatchObject({ type: "session", version: 3 });
  });
});

it("retains the latest compaction boundary before a truncated tail", async () => {
  await withBoundedContextScope(async (scope) => {
    await persistSessionTranscriptTurn(scope, {
      messages: [{ eventId: "old", parentId: null, message: { role: "user", content: "old" } }],
      touchSessionEntry: false,
    });
    await appendTranscriptEvent(scope, {
      type: "compaction",
      id: "summary",
      parentId: "old",
      timestamp: "2026-08-25T00:00:00.000Z",
      summary: "earlier work",
      firstKeptEntryId: "old",
      tokensBefore: 100,
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        { eventId: "middle", parentId: "summary", message: { role: "user", content: "middle" } },
        { eventId: "new", parentId: "middle", message: { role: "assistant", content: "new" } },
      ],
      touchSessionEntry: false,
    });

    const context = readSessionTranscriptBoundedActiveContextCore(scope, {
      maxBytes: 2048,
      maxEvents: 1,
    });

    expect(context.events.map((event) => (event as { id?: string }).id)).toEqual([
      scope.sessionId,
      "summary",
      "new",
    ]);
    expect(context.events.at(-1)).toMatchObject({ parentId: "summary" });
    expect(context.boundaryCount).toBe(1);
  });
});

it("counts the retained tail instead of compacted transcript bytes", async () => {
  await withBoundedContextScope(async (scope) => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "discarded-old",
          parentId: null,
          message: { role: "user", content: `discarded ${"x".repeat(20_000)}` },
        },
        {
          eventId: "kept-user",
          parentId: "discarded-old",
          message: { role: "user", content: `kept ${"k".repeat(3_000)}` },
        },
        {
          eventId: "kept-assistant",
          parentId: "kept-user",
          message: { role: "assistant", content: "kept answer" },
        },
      ],
      touchSessionEntry: false,
    });
    await appendTranscriptEvent(scope, {
      type: "compaction",
      id: "compaction-boundary",
      parentId: "kept-assistant",
      timestamp: "2026-08-15T00:00:00.000Z",
      summary: `earlier ${"s".repeat(4_000)}`,
      firstKeptEntryId: "kept-user",
      tokensBefore: 10_000,
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "post-compaction",
          parentId: "compaction-boundary",
          message: { role: "user", content: "fresh turn" },
        },
      ],
      touchSessionEntry: false,
    });

    const stats = readSessionTranscriptActiveStats(scope);
    expect(stats.eventCount).toBe(4);
    expect(stats.sizeBytes).toBeGreaterThan(7_000);
    expect(stats.sizeBytes).toBeLessThan(12_000);
  });
});
