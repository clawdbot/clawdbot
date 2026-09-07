// Context accounting excludes display-only activity without changing durable history.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  appendTranscriptEvent,
  loadTranscriptEventsSync,
  persistSessionTranscriptTurn,
  readTranscriptStatsSync,
} from "./session-accessor.js";
import {
  readRecentSessionTranscriptActiveEvents,
  readSessionTranscriptActiveStats,
  readSessionTranscriptMessageEventPage,
} from "./session-accessor.sqlite-active-events.js";
import { reconcileSessionTranscriptIndexes } from "./session-transcript-reconcile.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const readSessionTranscriptMessageEventCount = (
  scope: Parameters<typeof readSessionTranscriptMessageEventPage>[0],
): number =>
  readSessionTranscriptMessageEventPage(scope, { maxMessages: 0, offset: 0 }).totalMessages;

describe("SQLite transcript context accounting", () => {
  let scope: {
    agentId: string;
    env: NodeJS.ProcessEnv;
    sessionId: string;
    sessionKey: string;
  };

  beforeEach(() => {
    const stateDir = tempDirs.make("openclaw-context-accounting-");
    scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      sessionId: "context-accounting-test",
      sessionKey: "agent:main:context-accounting-test",
    };
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it.each(["append", "rebuild"])(
    "keeps usage and bootstrap facts inside the bounded context tail after %s despite display activity",
    async (mode) => {
      await appendTranscriptEvent(scope, {
        type: "custom",
        id: "bootstrap",
        parentId: null,
        customType: "bootstrap-completed",
        data: {},
      });
      await persistSessionTranscriptTurn(scope, {
        messages: [
          {
            eventId: "usage",
            parentId: "bootstrap",
            message: {
              role: "assistant",
              content: "answer",
              usage: { input: 86_000, output: 2_000 },
            },
          },
          ...Array.from({ length: 513 }, (_, index) => ({
            eventId: `display-${index}`,
            parentId: index === 0 ? "usage" : `display-${index - 1}`,
            message: {
              role: "custom",
              customType: "tool-activity",
              display: true,
              excludeFromContext: true,
              content: "completed",
            },
          })),
        ],
        touchSessionEntry: false,
      });

      if (mode === "rebuild") {
        openOpenClawAgentDatabase(scope)
          .db.prepare(
            "UPDATE session_transcript_active_events SET context_eligible = NULL WHERE session_id = ?",
          )
          .run(scope.sessionId);
        expect(await reconcileSessionTranscriptIndexes(scope)).toEqual({ reconciledSessions: 1 });
      }
      const tail = readRecentSessionTranscriptActiveEvents(scope, 2);
      expect(tail.map((event) => (event as { id: string }).id)).toEqual(["bootstrap", "usage"]);
      expect(tail[1]).toMatchObject({ message: { usage: { input: 86_000, output: 2_000 } } });
      expect(readTranscriptStatsSync(scope).eventCount).toBeGreaterThan(513);
    },
  );

  it.each(["unbounded", "reset", "compaction"] as const)(
    "does not count display-only activity toward %s context pressure",
    async (boundary) => {
      const activity = {
        role: "custom",
        customType: "tool-activity",
        display: true,
        excludeFromContext: true,
        content: "",
        details: { output: "x".repeat(32_000) },
        timestamp: 1,
      };
      await persistSessionTranscriptTurn(scope, {
        messages: [
          { eventId: "kept-user", parentId: null, message: { role: "user", content: "question" } },
          { eventId: "display-prefix", parentId: "kept-user", message: activity },
          {
            eventId: "kept-assistant",
            parentId: "display-prefix",
            message: { role: "assistant", content: "answer" },
          },
        ],
        touchSessionEntry: false,
      });
      if (boundary !== "unbounded") {
        await appendTranscriptEvent(scope, {
          type: boundary,
          id: "boundary",
          parentId: "kept-assistant",
          timestamp: "2026-08-28T00:00:00.000Z",
          firstKeptEntryId: "kept-user",
          ...(boundary === "compaction"
            ? { summary: "summary", tokensBefore: 100 }
            : { reason: "reset" }),
        });
      }
      const contextIds = new Set([
        "kept-user",
        "kept-assistant",
        ...(boundary === "compaction" ? ["boundary"] : []),
      ]);
      const contextEvents = loadTranscriptEventsSync(scope).filter((event) =>
        contextIds.has((event as { id: string }).id),
      );
      const expected = {
        eventCount: contextEvents.length,
        sizeBytes: contextEvents.reduce<number>(
          (total, event) => total + Buffer.byteLength(JSON.stringify(event), "utf8") + 1,
          0,
        ),
      };
      expect(readSessionTranscriptActiveStats(scope)).toEqual(expected);
      const physicalBefore = readTranscriptStatsSync(scope);
      const historyBefore = readSessionTranscriptMessageEventCount(scope);
      await persistSessionTranscriptTurn(scope, {
        messages: [{ eventId: "display-tail", message: activity }],
        touchSessionEntry: false,
      });

      expect(readSessionTranscriptActiveStats(scope)).toEqual(expected);
      expect(readTranscriptStatsSync(scope).sizeBytes).toBeGreaterThan(
        physicalBefore.sizeBytes + 32_000,
      );
      expect(readSessionTranscriptMessageEventCount(scope)).toBe(historyBefore + 1);
    },
  );
});
