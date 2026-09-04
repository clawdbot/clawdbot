import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { readSessionMessagesAroundIdWithStatsAsync } from "./session-transcript-anchor-reader.js";
import {
  readRecentSessionMessagesWithStatsAsync,
  readSessionMessageByIdAsync,
  readSessionMessageCountAsync,
  readSessionMessagesAsync,
  readSessionMessagesPageWithStatsAsync,
  visitSessionMessagesAsync,
  type SessionTranscriptReadScope,
} from "./session-transcript-readers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const timestamp = "2026-08-11T18:00:00.000Z";

function message(id: string, content: string, role: "user" | "assistant" | "toolResult" = "user") {
  return { type: "message" as const, id, message: { role, content } };
}

function compaction(id: string, firstKeptEntryId: string) {
  return {
    type: "compaction" as const,
    id,
    timestamp,
    summary: `${id} summary`,
    firstKeptEntryId,
    tokensBefore: 100,
  };
}

function reset(id: string, firstKeptEntryId?: string) {
  return { type: "reset" as const, id, timestamp, reason: "reset", firstKeptEntryId };
}

function messageIds(messages: unknown[]) {
  return messages.map((entry) => (entry as { __openclaw: { id: string } })["__openclaw"].id);
}

describe("session transcript reader marker projection", () => {
  let tempDir: string;
  let storePath: string;
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    tempDir = tempDirs.make("openclaw-transcript-markers-");
    storePath = path.join(tempDir, "sessions.json");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
  });

  async function writeTranscript(
    sessionId: string,
    events: Array<{ id: string }>,
  ): Promise<SessionTranscriptReadScope> {
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath,
    };
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: sessionId },
      ...events.map((event, index) => ({ ...event, parentId: events[index - 1]?.id ?? null })),
    ]);
    return scope;
  }

  test.each([
    {
      name: "compaction",
      events: [
        message("before", "before compaction"),
        compaction("summary", "before"),
        message("after", "after compaction", "assistant"),
      ],
      expectedIds: ["before", "summary", "after"],
    },
    {
      name: "reset",
      events: [
        message("old", "hidden old turn"),
        message("kept-user", "kept question"),
        message("kept-assistant", "kept answer", "assistant"),
        reset("reset", "kept-user"),
        message("post-reset", "new answer", "assistant"),
      ],
      expectedIds: ["kept-user", "kept-assistant", "reset", "post-reset"],
    },
    {
      name: "reset-then-compaction",
      events: [
        message("old", "hidden old turn"),
        compaction("old-summary", "old"),
        reset("reset"),
        message("fresh", "fresh user"),
        compaction("fresh-summary", "fresh"),
      ],
      expectedIds: ["reset", "fresh", "fresh-summary"],
    },
    {
      name: "empty-reset-adjacent-compactions",
      events: [
        message("old", "hidden old turn"),
        compaction("old-summary", "old"),
        reset("reset"),
        compaction("fresh-summary", "reset"),
        compaction("newest-summary", "reset"),
      ],
      expectedIds: ["reset", "fresh-summary", "newest-summary"],
    },
    {
      name: "kept-reset-adjacent-compactions",
      events: [
        message("old", "hidden old turn"),
        compaction("old-summary", "old"),
        message("kept-user", "kept question"),
        message("orphan-tool", "hidden orphan result", "toolResult"),
        message("kept-assistant", "kept answer", "assistant"),
        reset("reset", "kept-user"),
        compaction("fresh-summary", "kept-user"),
        compaction("newest-summary", "kept-user"),
      ],
      expectedIds: ["kept-user", "kept-assistant", "reset", "fresh-summary", "newest-summary"],
    },
    {
      name: "repeated-resets",
      events: [
        message("old", "hidden old turn"),
        compaction("old-summary", "old"),
        reset("old-reset"),
        message("middle", "hidden middle turn"),
        compaction("middle-summary", "middle"),
        reset("reset"),
        message("fresh", "fresh user"),
        compaction("fresh-summary", "fresh"),
        compaction("newest-summary", "fresh"),
        message("after", "after compactions", "assistant"),
      ],
      expectedIds: ["reset", "fresh", "fresh-summary", "newest-summary", "after"],
    },
  ])("projects $name boundaries through every SQLite history read", async (fixture) => {
    const scope = await writeTranscript(`reader-${fixture.name}`, fixture.events);
    const full = await readSessionMessagesAsync(scope, {
      mode: "full",
      reason: `${fixture.name} boundary projection test`,
    });
    const recent = await readRecentSessionMessagesWithStatsAsync(scope, {
      maxBytes: 16_384,
      maxLines: 2,
      maxMessages: 2,
    });

    expect(messageIds(full)).toEqual(fixture.expectedIds);
    const expectedVisits: Array<{ message: unknown; seq: number }> = [];
    let messageSeq = 0;
    for (const event of fixture.events) {
      if (event.type === "message") {
        messageSeq += 1;
        if (fixture.expectedIds.includes(event.id)) {
          expectedVisits.push({ message: event.message, seq: messageSeq });
        }
      }
    }
    const visited: Array<{ message: unknown; seq: number }> = [];
    await expect(
      visitSessionMessagesAsync(scope, (entryMessage, seq) =>
        visited.push({ message: entryMessage, seq }),
      ),
    ).resolves.toBe(expectedVisits.length);
    expect(visited).toEqual(expectedVisits);
    expect(messageIds(recent.messages)).toEqual(fixture.expectedIds.slice(-2));
    expect(recent.totalMessages).toBe(fixture.expectedIds.length);
    expect(await readSessionMessageCountAsync(scope)).toBe(fixture.expectedIds.length);
    for (const [index, id] of fixture.expectedIds.entries()) {
      const page = await readSessionMessagesPageWithStatsAsync(scope, {
        maxMessages: 1,
        offset: fixture.expectedIds.length - index - 1,
      });
      const byId = await readSessionMessageByIdAsync(scope, id);
      const anchored = await readSessionMessagesAroundIdWithStatsAsync(scope, {
        messageId: id,
        maxMessages: 10,
      });
      expect(messageIds(page.messages)).toEqual([id]);
      expect(page.totalMessages).toBe(fixture.expectedIds.length);
      expect(byId).toMatchObject({ found: true, seq: index + 1 });
      expect(byId.message).toMatchObject({ __openclaw: { id, seq: index + 1 } });
      const entry = fixture.events.find((event) => event.id === id)!;
      expect(byId.message).toMatchObject(
        entry.type === "message"
          ? entry.message
          : {
              role: "system",
              content: [
                { type: "text", text: entry.type === "compaction" ? "Compaction" : "Reset" },
              ],
              timestamp: Date.parse(timestamp),
              __openclaw: { kind: entry.type },
            },
      );
      expect(anchored.found).toBe(true);
      expect(messageIds(anchored.messages)).toEqual(fixture.expectedIds);
      expect(anchored.totalMessages).toBe(fixture.expectedIds.length);
    }
    for (const { id } of fixture.events.filter(
      (event) => !fixture.expectedIds.includes(event.id),
    )) {
      expect(await readSessionMessageByIdAsync(scope, id)).toMatchObject({ found: false });
      expect(
        await readSessionMessagesAroundIdWithStatsAsync(scope, { messageId: id, maxMessages: 10 }),
      ).toMatchObject({ found: false, messages: [], totalMessages: fixture.expectedIds.length });
    }
  });
});
