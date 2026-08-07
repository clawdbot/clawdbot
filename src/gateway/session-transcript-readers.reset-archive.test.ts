import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  persistSessionTranscriptTurn,
  replaceTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { readSessionMessagesAroundIdWithStatsAsync } from "./session-transcript-anchor-reader.js";
import {
  readRecentSessionMessagesWithStatsAsync,
  readSessionMessageByIdAsync,
  readSessionMessagesAsync,
  readSessionMessagesPageWithStatsAsync,
  readSessionMessagesWithSourceAsync,
  type SessionTranscriptReadScope,
} from "./session-transcript-readers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session transcript reset and archive readers", () => {
  let tempDir: string;
  let storePath: string;
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    tempDir = tempDirs.make("openclaw-transcript-reset-readers-");
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

  test("finds an anchored reset-archive message by historical session id", async () => {
    const sessionId = "reader-file-archive-anchor";
    const scope = await writeTranscript(sessionId, [
      { type: "session", version: 3, id: sessionId },
      {
        type: "message",
        id: "active-message",
        parentId: null,
        message: { role: "user", content: "active prompt" },
      },
    ]);
    fs.writeFileSync(
      path.join(tempDir, `${sessionId}.jsonl.reset.2026-07-12T17-00-00.000Z`),
      `${JSON.stringify({ type: "session", version: 3, id: sessionId })}\n${JSON.stringify({
        type: "message",
        id: "archived-message",
        parentId: null,
        message: { role: "user", content: "archived prompt" },
      })}\n`,
      "utf-8",
    );

    await expect(
      readSessionMessagesAroundIdWithStatsAsync(scope, {
        messageId: "archived-message",
        maxMessages: 1,
        allowResetArchiveFallback: true,
      }),
    ).resolves.toMatchObject({
      found: true,
      messages: [{ content: "archived prompt" }],
    });
  });

  test("keeps SQLite precedence by ignoring an obsolete active JSONL during archive fallback", async () => {
    const sessionId = "reader-reset-archive-only";
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath,
    };
    const line = (content: string) =>
      `${JSON.stringify({ type: "session", version: 1, id: sessionId })}\n${JSON.stringify({
        message: { role: "assistant", content },
      })}\n`;
    fs.writeFileSync(path.join(tempDir, `${sessionId}.jsonl`), line("obsolete live file"));
    fs.writeFileSync(
      path.join(tempDir, `${sessionId}.jsonl.reset.2026-07-12T18-00-00.000Z`),
      line("retained archive"),
    );

    await expect(
      readSessionMessagesAsync(scope, {
        mode: "full",
        reason: "archive-only fallback test",
        allowResetArchiveFallback: true,
      }),
    ).resolves.toMatchObject([{ content: "retained archive" }]);
    await expect(
      readSessionMessagesAsync(scope, {
        mode: "recent",
        maxMessages: 10,
        allowResetArchiveFallback: true,
      }),
    ).resolves.toMatchObject([{ content: "retained archive" }]);
    await expect(
      readRecentSessionMessagesWithStatsAsync(scope, {
        maxMessages: 10,
        allowResetArchiveFallback: true,
      }),
    ).resolves.toMatchObject({
      guardKind: "empty",
      guardLeafEntryId: null,
      messages: [{ content: "retained archive" }],
    });
    await expect(
      readSessionMessagesPageWithStatsAsync(scope, {
        maxMessages: 10,
        offset: 0,
        allowResetArchiveFallback: true,
      }),
    ).resolves.toMatchObject({
      guardKind: "empty",
      guardLeafEntryId: null,
      messages: [{ content: "retained archive" }],
    });
  });

  test("keeps reset-only active snapshots empty instead of falling back to archives", async () => {
    const sessionId = "reader-reset-only-active";
    const scope = await writeTranscript(sessionId, [
      { type: "session", version: 3, id: sessionId },
      {
        type: "message",
        id: "pre-reset",
        parentId: null,
        message: { role: "user", content: "hidden active prompt" },
      },
      {
        type: "reset",
        id: "reset-only",
        parentId: "pre-reset",
        timestamp: "2026-07-22T00:00:00.000Z",
        reason: "new",
      },
    ]);
    fs.writeFileSync(
      path.join(tempDir, `${sessionId}.jsonl.reset.2026-07-22T00-00-00.000Z`),
      `${JSON.stringify({ type: "session", version: 3, id: sessionId })}\n${JSON.stringify({
        type: "message",
        id: "archived-message",
        parentId: null,
        message: { role: "user", content: "archived prompt" },
      })}\n`,
      "utf-8",
    );

    await expect(
      readSessionMessagesAsync(scope, {
        mode: "full",
        reason: "reset-only full",
        allowResetArchiveFallback: true,
      }),
    ).resolves.toEqual([]);
    await expect(
      readSessionMessagesWithSourceAsync(scope, {
        mode: "full",
        reason: "reset-only source",
        allowResetArchiveFallback: true,
      }),
    ).resolves.toMatchObject({
      messages: [],
    });
    const archivedOnly = await readSessionMessagesWithSourceAsync(scope, {
      mode: "full",
      reason: "durable reference scan",
      transcriptSource: "all",
    });
    expect(archivedOnly).toMatchObject({
      messages: [{ content: "archived prompt" }],
    });
    expect(archivedOnly).not.toHaveProperty("transcriptPath");
    expect(archivedOnly).not.toHaveProperty("transcriptSource");
    await expect(
      readSessionMessagesAsync(scope, {
        mode: "recent",
        maxMessages: 10,
        allowResetArchiveFallback: true,
      }),
    ).resolves.toEqual([]);
    for (const snapshot of [
      await readRecentSessionMessagesWithStatsAsync(scope, {
        maxMessages: 10,
        allowResetArchiveFallback: true,
      }),
      await readSessionMessagesPageWithStatsAsync(scope, {
        maxMessages: 10,
        offset: 0,
        allowResetArchiveFallback: true,
      }),
    ]) {
      expect(snapshot).toMatchObject({
        guardKind: "identified",
        guardLeafEntryId: "reset-only",
        messages: [],
        totalMessages: 0,
      });
    }
    await expect(
      readSessionMessagesAroundIdWithStatsAsync(scope, {
        messageId: "archived-message",
        maxMessages: 1,
        allowResetArchiveFallback: true,
      }),
    ).resolves.toMatchObject({
      found: true,
      messages: [{ content: "archived prompt" }],
      transcriptSource: "reset-archive",
    });
    const archived = await readSessionMessageByIdAsync(scope, "archived-message", {
      allowResetArchiveFallback: true,
    });
    expect(archived).toMatchObject({ found: true, message: { content: "archived prompt" } });
    await persistSessionTranscriptTurn(
      { ...scope, sessionEntry: { sessionId, updatedAt: 1 } },
      {
        messages: [
          {
            eventId: "post-reset-active",
            parentId: "reset-only",
            message: { role: "assistant", content: "active answer" },
          },
        ],
        touchSessionEntry: false,
      },
    );
    const archivedAndActive = await readSessionMessagesWithSourceAsync(scope, {
      mode: "full",
      reason: "durable reference scan with active messages",
      transcriptSource: "all",
    });
    expect(archivedAndActive).toMatchObject({
      messages: [{ content: "archived prompt" }, { content: "active answer" }],
    });
    expect(archivedAndActive).not.toHaveProperty("transcriptPath");
    expect(archivedAndActive).not.toHaveProperty("transcriptSource");
  });

  test("keeps retained reset tails consistent across full, recent, and page readers", async () => {
    const sessionId = "reader-retained-reset-tail";
    const scope = await writeTranscript(sessionId, [
      { type: "session", version: 3, id: sessionId },
      {
        type: "message",
        id: "hidden",
        parentId: null,
        message: { role: "user", content: "hidden" },
      },
      {
        type: "message",
        id: "retained",
        parentId: "hidden",
        message: { role: "assistant", content: "retained" },
      },
      {
        type: "reset",
        id: "retained-reset",
        parentId: "retained",
        timestamp: "2026-07-22T00:00:00.000Z",
        reason: "new",
        firstKeptEntryId: "retained",
      },
    ]);

    await expect(
      readSessionMessagesAsync(scope, { mode: "full", reason: "retained reset full" }),
    ).resolves.toMatchObject([{ content: "retained" }]);
    for (const snapshot of [
      await readRecentSessionMessagesWithStatsAsync(scope, { maxMessages: 10 }),
      await readSessionMessagesPageWithStatsAsync(scope, { maxMessages: 10, offset: 0 }),
    ]) {
      expect(snapshot).toMatchObject({
        guardKind: "identified",
        guardLeafEntryId: "retained-reset",
        messages: [{ content: "retained" }],
        totalMessages: 1,
      });
    }
  });
});
