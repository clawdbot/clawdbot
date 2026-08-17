import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { appendTranscriptEvent, persistSessionTranscriptTurn } from "./session-accessor.js";
import { readRecentSessionTranscriptHistoryEvents } from "./session-accessor.sqlite-history-events.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("SQLite transcript history events", () => {
  let scope: {
    agentId: string;
    env: NodeJS.ProcessEnv;
    sessionId: string;
    sessionKey: string;
  };

  beforeEach(() => {
    scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("openclaw-history-events-") },
      sessionId: "history-events-test",
      sessionKey: "agent:main:history-events-test",
    };
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("retains an oversized newest history row without parsing excluded older payloads", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [{ eventId: "older", parentId: null, message: { role: "user", content: "older" } }],
      touchSessionEntry: false,
    });
    await appendTranscriptEvent(scope, {
      type: "compaction",
      id: "excluded-boundary",
      parentId: "older",
      timestamp: "2026-08-15T00:00:00.000Z",
      summary: "excluded",
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "oversized-newest",
          parentId: "excluded-boundary",
          message: { role: "assistant", content: "x".repeat(16_384) },
        },
      ],
      touchSessionEntry: false,
    });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    database.db
      .prepare(
        `UPDATE transcript_events
         SET event_json = '{'
         WHERE session_id = ? AND seq IN (
           SELECT seq FROM transcript_event_identities
           WHERE session_id = ? AND event_id IN ('older', 'excluded-boundary')
         )`,
      )
      .run(scope.sessionId, scope.sessionId);

    const page = readRecentSessionTranscriptHistoryEvents(scope, {
      maxBytes: 1024,
      maxLines: 3,
      maxMessages: 3,
    });

    expect(page.totalMessages).toBe(3);
    expect(page.events.map(({ event }) => (event as { id?: unknown }).id)).toEqual([
      "oversized-newest",
    ]);
    expect(page.events.map(({ seq }) => seq)).toEqual([3]);
  });
});
