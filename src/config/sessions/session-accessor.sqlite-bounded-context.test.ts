import path from "node:path";
import { expect, it } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  persistSessionTranscriptTurn,
  readSessionTranscriptBoundedActiveContextCore,
  upsertSessionEntryCore,
} from "./session-accessor.js";

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
