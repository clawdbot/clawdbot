import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { appendTranscriptEvent, persistSessionTranscriptTurn } from "./session-accessor.js";
import {
  readSessionTranscriptBoundedMessageTailPage,
  readSessionTranscriptMessageAnchorPage,
} from "./session-accessor.sqlite-active-events.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("SQLite transcript history anchors", () => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("reads hidden and visible anchors across a reset boundary", async () => {
    const stateDir = tempDirs.make("openclaw-history-anchor-");
    const scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      sessionId: "history-anchor-test",
      sessionKey: "agent:main:history-anchor-test",
    };
    await persistSessionTranscriptTurn(scope, {
      messages: [
        { eventId: "old", parentId: null, message: { role: "user", content: "old" } },
        {
          eventId: "kept-user",
          parentId: "old",
          message: { role: "user", content: "kept question" },
        },
        {
          eventId: "kept-tool",
          parentId: "kept-user",
          message: { role: "toolResult", content: `hidden tool ${"x".repeat(2_000)}` },
        },
        {
          eventId: "kept-assistant",
          parentId: "kept-tool",
          message: { role: "assistant", content: "kept answer" },
        },
      ],
      touchSessionEntry: false,
    });
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "reset-boundary",
      parentId: "kept-assistant",
      timestamp: "2026-07-22T00:00:00.000Z",
      reason: "new",
      firstKeptEntryId: "kept-user",
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "post-reset",
          parentId: "reset-boundary",
          message: { role: "user", content: "new turn" },
        },
      ],
      touchSessionEntry: false,
    });

    const boundedPage = readSessionTranscriptBoundedMessageTailPage(scope, {
      maxBytes: 8_192,
      maxMessages: 10,
      offset: 0,
    });
    expect(boundedPage.totalMessages).toBe(3);
    expect(boundedPage.events.map((entry) => (entry.event as { id?: unknown }).id)).toEqual([
      "kept-user",
      "kept-assistant",
      "post-reset",
    ]);

    const historicalAnchor = readSessionTranscriptMessageAnchorPage(scope, {
      maxMessages: 3,
      messageId: "old",
    });
    expect(historicalAnchor.found).toBe(true);
    expect(historicalAnchor.events.map((entry) => (entry.event as { id?: unknown }).id)).toEqual([
      "old",
      "kept-user",
      "kept-tool",
    ]);
    expect(historicalAnchor.totalMessages).toBe(5);
    expect(historicalAnchor.offset).toBe(2);

    const keptAnchor = readSessionTranscriptMessageAnchorPage(scope, {
      maxMessages: 3,
      messageId: "kept-user",
    });
    expect(keptAnchor.found).toBe(true);
    expect(keptAnchor.events.map((entry) => (entry.event as { id?: unknown }).id)).toEqual([
      "kept-user",
      "kept-assistant",
      "post-reset",
    ]);
    expect(keptAnchor.totalMessages).toBe(3);
    expect(keptAnchor.offset).toBe(0);

    const postResetAnchor = readSessionTranscriptMessageAnchorPage(scope, {
      maxMessages: 2,
      messageId: "post-reset",
    });
    expect(postResetAnchor.found).toBe(true);
    expect(postResetAnchor.events.map((entry) => (entry.event as { id?: unknown }).id)).toEqual([
      "kept-user",
      "kept-assistant",
      "post-reset",
    ]);
    expect(postResetAnchor.hasOverreadContext).toBe(true);
    expect(postResetAnchor.totalMessages).toBe(3);
    expect(postResetAnchor.offset).toBe(0);
  });
});
