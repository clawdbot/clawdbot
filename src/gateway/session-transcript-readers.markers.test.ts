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
  type SessionTranscriptReadScope,
} from "./session-transcript-readers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
    events: unknown[],
  ): Promise<SessionTranscriptReadScope> {
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath,
    };
    await replaceTranscriptEvents(scope, events);
    return scope;
  }

  test.each([
    {
      name: "compaction",
      sessionId: "reader-compaction-boundary",
      markerId: "compaction-boundary",
      markerKind: "compaction",
      markerSummary: "compaction",
      markerText: "Compaction",
      hiddenMarkerId: undefined,
      events: (sessionId: string) => [
        { type: "session", version: 3, id: sessionId },
        {
          type: "message",
          id: "before-compaction",
          parentId: null,
          message: { role: "user", content: "before compaction" },
        },
        {
          type: "compaction",
          id: "compaction-boundary",
          parentId: "before-compaction",
          timestamp: "2026-08-11T18:00:00.000Z",
          summary: "summary",
          firstKeptEntryId: "before-compaction",
          tokensBefore: 100,
        },
        {
          type: "message",
          id: "after-compaction",
          parentId: "compaction-boundary",
          message: { role: "assistant", content: "after compaction" },
        },
      ],
      expected: ["before compaction", "compaction", "after compaction"],
    },
    {
      name: "reset",
      sessionId: "reader-reset-boundary",
      markerId: "reset-boundary",
      markerKind: "reset",
      markerSummary: "reset",
      markerText: "Reset",
      hiddenMarkerId: undefined,
      events: (sessionId: string) => [
        { type: "session", version: 3, id: sessionId },
        {
          type: "message",
          id: "old",
          parentId: null,
          message: { role: "user", content: "hidden old turn" },
        },
        {
          type: "message",
          id: "kept-user",
          parentId: "old",
          message: { role: "user", content: "kept question" },
        },
        {
          type: "message",
          id: "kept-assistant",
          parentId: "kept-user",
          message: { role: "assistant", content: "kept answer" },
        },
        {
          type: "reset",
          id: "reset-boundary",
          parentId: "kept-assistant",
          timestamp: "2026-08-11T18:00:00.000Z",
          reason: "reset",
          firstKeptEntryId: "kept-user",
        },
        {
          type: "message",
          id: "post-reset",
          parentId: "reset-boundary",
          message: { role: "assistant", content: "new answer" },
        },
      ],
      expected: ["kept question", "kept answer", "reset", "new answer"],
    },
    {
      name: "displayable custom message",
      sessionId: "reader-custom-message",
      markerId: "visible-custom",
      markerKind: undefined,
      markerSummary: "visible custom",
      markerText: undefined,
      hiddenMarkerId: "hidden-custom",
      events: (sessionId: string) => [
        { type: "session", version: 3, id: sessionId },
        {
          type: "reset",
          id: "custom-reset-boundary",
          parentId: null,
          timestamp: "2026-08-11T17:59:59.000Z",
          reason: "reset",
        },
        {
          type: "message",
          id: "before-custom",
          parentId: "custom-reset-boundary",
          message: { role: "user", content: "before custom" },
        },
        {
          type: "custom_message",
          id: "visible-custom",
          parentId: "before-custom",
          timestamp: "2026-08-11T18:00:00.000Z",
          customType: "visible-note",
          content: "visible custom",
          display: true,
          details: { source: "reader-test" },
        },
        {
          type: "custom_message",
          id: "hidden-custom",
          parentId: "visible-custom",
          timestamp: "2026-08-11T18:00:01.000Z",
          customType: "hidden-note",
          content: "hidden custom",
          display: false,
        },
        {
          type: "message",
          id: "after-custom",
          parentId: "hidden-custom",
          message: { role: "assistant", content: "after custom" },
        },
      ],
      expected: ["reset", "before custom", "visible custom", "after custom"],
    },
  ])("projects $name through every SQLite history read", async (fixture) => {
    const scope = await writeTranscript(fixture.sessionId, fixture.events(fixture.sessionId));
    const summarize = (messages: unknown[]) =>
      messages.map((message) => {
        const record = message as { content?: unknown; __openclaw?: { kind?: string } };
        return record["__openclaw"]?.kind ?? record.content;
      });

    const full = await readSessionMessagesAsync(scope, {
      mode: "full",
      reason: `${fixture.name} boundary projection test`,
    });
    const recent = await readRecentSessionMessagesWithStatsAsync(scope, {
      maxBytes: 16_384,
      maxLines: 10,
      maxMessages: 10,
    });
    const markerIndex = fixture.expected.indexOf(fixture.markerSummary);
    const page = await readSessionMessagesPageWithStatsAsync(scope, {
      maxMessages: 1,
      offset: fixture.expected.length - markerIndex - 1,
    });
    const byId = await readSessionMessageByIdAsync(scope, fixture.markerId);
    const hiddenById = fixture.hiddenMarkerId
      ? await readSessionMessageByIdAsync(scope, fixture.hiddenMarkerId)
      : undefined;
    const anchored = await readSessionMessagesAroundIdWithStatsAsync(scope, {
      messageId: fixture.markerId,
      maxMessages: 10,
    });

    expect(summarize(full)).toEqual(fixture.expected);
    expect(summarize(recent.messages)).toEqual(fixture.expected);
    expect(recent.totalMessages).toBe(fixture.expected.length);
    expect(summarize(page.messages)).toEqual([fixture.markerSummary]);
    expect(page.totalMessages).toBe(fixture.expected.length);
    expect(await readSessionMessageCountAsync(scope)).toBe(fixture.expected.length);
    const expectedMessage = fixture.markerKind
      ? {
          role: "system",
          content: [{ type: "text", text: fixture.markerText }],
          timestamp: Date.parse("2026-08-11T18:00:00.000Z"),
          __openclaw: {
            kind: fixture.markerKind,
            id: fixture.markerId,
            seq: markerIndex + 1,
          },
        }
      : {
          role: "custom",
          customType: "visible-note",
          content: "visible custom",
          display: true,
          details: { source: "reader-test" },
          timestamp: Date.parse("2026-08-11T18:00:00.000Z"),
          __openclaw: {
            id: fixture.markerId,
            seq: markerIndex + 1,
          },
        };
    expect(byId).toMatchObject({ found: true, message: expectedMessage, seq: markerIndex + 1 });
    if (fixture.hiddenMarkerId) {
      expect(hiddenById).toMatchObject({ found: false });
    }
    expect(anchored.found).toBe(true);
    expect(summarize(anchored.messages)).toEqual(fixture.expected);
    expect(anchored.totalMessages).toBe(fixture.expected.length);
  });
});
