import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  persistSessionTranscriptTurn,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import { waitForSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { readSessionMessagesAroundIdWithStatsAsync } from "./session-transcript-anchor-reader.js";
import {
  readSessionMessageByIdAsync,
  readSessionMessageCountAsync,
  readSessionMessagesAsync,
  readSessionMessagesPageWithStatsAsync,
  readLatestSessionUsageFromTranscriptAsync,
  visitSessionMessagesAsync,
  type SessionTranscriptReadScope,
} from "./session-transcript-readers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session transcript reader facade", () => {
  let tempDir: string;
  let storePath: string;
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    tempDir = tempDirs.make("openclaw-transcript-readers-");
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

  function markProjectionNeedsRebuild(sessionId: string): void {
    openOpenClawAgentDatabase({
      agentId: "main",
      path: path.join(tempDir, "openclaw-agent.sqlite"),
    })
      .db.prepare(
        "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
      )
      .run(sessionId);
  }

  test("reads active-branch messages and message ids through a scope", async () => {
    const scope = await writeTranscript("reader-active-branch", [
      { type: "session", version: 3, id: "reader-active-branch" },
      {
        type: "message",
        id: "root",
        parentId: null,
        message: { role: "user", content: "root prompt" },
      },
      {
        type: "message",
        id: "inactive",
        parentId: "root",
        message: { role: "assistant", content: "stale answer" },
      },
      {
        type: "message",
        id: "active",
        parentId: "root",
        message: { role: "assistant", content: "active answer" },
      },
    ]);

    await expect(
      readSessionMessagesAsync(scope, { mode: "full", reason: "facade active branch test" }),
    ).resolves.toMatchObject([{ content: "root prompt" }, { content: "active answer" }]);
    const visited: Array<{ message: unknown; seq: number }> = [];
    await expect(
      visitSessionMessagesAsync(scope, (message, seq) => visited.push({ message, seq })),
    ).resolves.toBe(2);
    expect(visited).toEqual([
      { message: { role: "user", content: "root prompt" }, seq: 1 },
      { message: { role: "assistant", content: "active answer" }, seq: 2 },
    ]);
    await expect(readSessionMessageCountAsync(scope)).resolves.toBe(2);
    await expect(readSessionMessageByIdAsync(scope, "active")).resolves.toMatchObject({
      found: true,
      oversized: false,
      seq: 2,
    });
    await expect(
      readSessionMessagesAroundIdWithStatsAsync(scope, {
        messageId: "active",
        maxMessages: 1,
      }),
    ).resolves.toMatchObject({
      found: true,
      hasOverreadContext: true,
      messages: [{ content: "root prompt" }, { content: "active answer" }],
      offset: 0,
      totalMessages: 2,
    });
  });

  test.each(["visitor", "parse"] as const)(
    "acquires messages incrementally and releases the cursor after %s failure",
    async (failure) => {
      const sessionId = `reader-stream-${failure}`;
      const scope = await writeTranscript(sessionId, [
        { type: "session", version: 3, id: sessionId },
        {
          type: "message",
          id: "first",
          parentId: null,
          message: { role: "user", content: "first prompt" },
        },
        {
          type: "message",
          id: "later",
          parentId: "first",
          message: { role: "assistant", content: "later answer" },
        },
      ]);
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        path: path.join(tempDir, "openclaw-agent.sqlite"),
      });
      // Keep the ready projection, but poison a later payload: an early abort must never parse it.
      database.db
        .prepare(
          `UPDATE transcript_events SET event_json = '{malformed'
           WHERE session_id = ? AND seq = (
             SELECT MAX(seq) FROM transcript_events WHERE session_id = ?
           )`,
        )
        .run(sessionId, sessionId);
      const stopped = new Error("visitor stopped");
      const visited: Array<{ message: unknown; seq: number }> = [];
      const traversal = visitSessionMessagesAsync(scope, (message, seq) => {
        expect(database.db.isTransaction).toBe(true);
        visited.push({ message, seq });
        if (failure === "visitor") {
          throw stopped;
        }
      });
      if (failure === "visitor") {
        await expect(traversal).rejects.toBe(stopped);
      } else {
        await expect(traversal).rejects.toBeInstanceOf(SyntaxError);
      }
      expect(visited).toEqual([{ message: { role: "user", content: "first prompt" }, seq: 1 }]);
      expect(database.db.isTransaction).toBe(false);
      // A surviving read cursor prevents checkpointing even after transaction rollback.
      expect(database.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({
        busy: 0,
      });
    },
  );

  test("preserves Date.parse semantics for numeric-looking record timestamps", async () => {
    const scope = await writeTranscript("reader-numeric-looking-timestamps", [
      { type: "session", version: 3, id: "reader-numeric-looking-timestamps" },
      {
        type: "message",
        id: "numeric-zero",
        parentId: null,
        timestamp: "0",
        message: { role: "user", content: "zero" },
      },
      {
        type: "message",
        id: "numeric-year",
        parentId: "numeric-zero",
        timestamp: "2026",
        message: { role: "assistant", content: "year" },
      },
    ]);

    await expect(
      readSessionMessagesAsync(scope, { mode: "full", reason: "timestamp contract test" }),
    ).resolves.toMatchObject([
      { __openclaw: { recordTimestampMs: Date.parse("0") } },
      { __openclaw: { recordTimestampMs: Date.parse("2026") } },
    ]);
  });

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
  });

  test("does not fall back to stored custom transcript paths after SQLite migration", async () => {
    const sessionId = "reader-legacy-custom-path";
    const sessionKey = `agent:main:telegram:group:1:topic:9`;
    const transcriptPath = path.join(tempDir, "legacy", "custom-topic.jsonl");
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({ type: "session", version: 1, id: sessionId })}\n${JSON.stringify({
        type: "message",
        id: "u1",
        message: { role: "user", content: "legacy prompt" },
      })}\n${JSON.stringify({
        type: "message",
        id: "a1",
        message: { role: "assistant", content: "legacy answer" },
      })}\n`,
      "utf-8",
    );
    await upsertSessionEntryCore(
      { sessionKey, storePath },
      {
        sessionId,
        sessionFile: transcriptPath,
        updatedAt: 10,
      },
    );

    await expect(
      readSessionMessagesAsync(
        { agentId: "main", sessionId, sessionKey, storePath },
        { mode: "full", reason: "no legacy fallback test" },
      ),
    ).resolves.toEqual([]);
  });

  test("reads SQLite-only transcript rows without a JSONL mirror", async () => {
    const sessionId = "reader-sqlite-only";
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath,
    };
    await persistSessionTranscriptTurn(scope, {
      cwd: tempDir,
      messages: [
        { message: { role: "user", content: "sqlite prompt" } },
        { message: { role: "assistant", content: "sqlite answer" } },
        { message: { role: "assistant", content: "sqlite follow-up" } },
      ],
      touchSessionEntry: false,
    });

    expect(fs.existsSync(path.join(tempDir, `${sessionId}.jsonl`))).toBe(false);
    await expect(
      readSessionMessagesAsync(scope, { mode: "full", reason: "sqlite reader facade test" }),
    ).resolves.toMatchObject([
      { content: "sqlite prompt" },
      { content: "sqlite answer" },
      { content: "sqlite follow-up" },
    ]);
    await expect(
      readSessionMessagesAsync(scope, { mode: "recent", maxMessages: 1 }),
    ).resolves.toMatchObject([{ content: "sqlite follow-up", __openclaw: { seq: 3 } }]);
    await expect(readSessionMessageCountAsync(scope)).resolves.toBe(3);
  });

  test("uses an explicit JSONL artifact when the store path is a placeholder", async () => {
    const sessionId = "reader-artifact-placeholder-store";
    const transcriptPath = path.join(tempDir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({ type: "session", version: 1, id: sessionId })}\n${JSON.stringify({
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          usage: { input: 12, output: 3, cost: { total: 0.001 } },
        },
      })}\n`,
      "utf-8",
    );

    await expect(
      readLatestSessionUsageFromTranscriptAsync({
        agentId: "main",
        sessionId,
        sessionKey: `agent:main:${sessionId}`,
        sessionFile: transcriptPath,
        storePath: "(multiple)",
      }),
    ).resolves.toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
    });
  });

  test("keeps a canonical session key on SQLite when the store path is a placeholder", async () => {
    const sessionId = "reader-placeholder-sqlite-key";
    const sessionKey = `agent:main:${sessionId}`;
    const defaultStorePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey, storePath: defaultStorePath },
      {
        messages: [
          {
            message: {
              role: "assistant",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              usage: { input: 15, output: 4, cost: { total: 0.001 } },
            },
          },
        ],
        updateMode: "file-only",
      },
    );

    await expect(
      readLatestSessionUsageFromTranscriptAsync({
        sessionId,
        sessionKey,
        sessionFile: sessionKey,
        storePath: "(multiple)",
      }),
    ).resolves.toMatchObject({
      inputTokens: 15,
      outputTokens: 4,
    });
  });

  test("promotes SQLite message idempotency into transcript metadata", async () => {
    const sessionId = "reader-sqlite-idempotency";
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath,
    };
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "sqlite-user-message",
          message: {
            role: "user",
            content: "stable bubble",
            idempotencyKey: "initial-send:user",
          },
        },
      ],
      touchSessionEntry: false,
    });

    await expect(
      readSessionMessagesAsync(scope, {
        mode: "full",
        reason: "sqlite idempotency metadata parity test",
      }),
    ).resolves.toMatchObject([
      {
        idempotencyKey: "initial-send:user",
        __openclaw: {
          id: "sqlite-user-message",
          idempotencyKey: "initial-send:user",
          seq: 1,
        },
      },
    ]);
  });

  test("uses structured SQLite identity", async () => {
    const sessionId = "reader-marker-only";
    const markerStorePath = path.join(
      tempDir,
      "agents",
      "marker-agent",
      "sessions",
      "sessions.json",
    );
    const writeScope = {
      agentId: "marker-agent",
      sessionId,
      sessionKey: "agent:marker-agent:main",
      storePath: markerStorePath,
    };
    await persistSessionTranscriptTurn(writeScope, {
      messages: [
        {
          eventId: "marker-message",
          message: { role: "user", content: "marker scoped prompt" },
        },
      ],
      touchSessionEntry: false,
    });
    await expect(
      readSessionMessagesAsync(writeScope, { mode: "full", reason: "sqlite identity read test" }),
    ).resolves.toMatchObject([{ content: "marker scoped prompt" }]);
    await expect(readSessionMessageByIdAsync(writeScope, "marker-message")).resolves.toMatchObject({
      found: true,
      seq: 1,
    });
  });

  test("waits for an in-flight SQLite projection before counting messages", async () => {
    const sessionId = "reader-sqlite-rebuilding-count";
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath,
    };
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "root",
          parentId: null,
          message: { role: "user", content: "cross-client prompt" },
        },
        {
          eventId: "reply",
          parentId: "root",
          message: { role: "assistant", content: "cross-client reply" },
        },
      ],
      touchSessionEntry: false,
    });
    markProjectionNeedsRebuild(sessionId);

    const visited: unknown[] = [];
    await expect(
      visitSessionMessagesAsync(scope, (message) => visited.push(message)),
    ).rejects.toBeInstanceOf(SessionTranscriptProjectionUnavailableError);
    expect(visited).toEqual([]);
    await expect(readSessionMessageCountAsync(scope)).resolves.toBe(2);
  });

  test("projects SQLite transcript reads to the active branch", async () => {
    const sessionId = "reader-sqlite-branch";
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath,
    };
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "root",
          parentId: null,
          message: { role: "user", content: "branch prompt" },
        },
        {
          eventId: "inactive",
          parentId: "root",
          message: { role: "assistant", content: "stale branch" },
        },
        {
          eventId: "active",
          parentId: "root",
          message: { role: "assistant", content: "active branch" },
        },
      ],
      touchSessionEntry: false,
    });
    await waitForSessionTranscriptIndexReconcile({
      agentId: "main",
      path: path.join(tempDir, "openclaw-agent.sqlite"),
    });

    const messages = await readSessionMessagesAsync(scope, {
      mode: "full",
      reason: "sqlite branch facade test",
    });

    expect(messages).toMatchObject([{ content: "branch prompt" }, { content: "active branch" }]);
    expect(
      messages.map((message) => (message as { __openclaw?: { id?: string } })["__openclaw"]?.id),
    ).toEqual(["root", "active"]);
    expect(
      messages.map((message) => (message as { __openclaw?: { seq?: number } })["__openclaw"]?.seq),
    ).toEqual([1, 2]);
    await expect(readSessionMessageCountAsync(scope)).resolves.toBe(2);
  });

  test("pages SQLite transcript messages through the reader facade", async () => {
    const sessionId = "reader-sqlite-page";
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath,
    };
    await persistSessionTranscriptTurn(scope, {
      messages: [
        { message: { role: "user", content: "first" } },
        { message: { role: "assistant", content: "second" } },
        { message: { role: "user", content: "third" } },
        { message: { role: "assistant", content: "fourth" } },
      ],
      touchSessionEntry: false,
    });

    const page = await readSessionMessagesPageWithStatsAsync(scope, {
      maxMessages: 2,
      offset: 1,
    });

    expect(page.totalMessages).toBe(4);
    expect(page.messages.map((message) => (message as { content?: string }).content)).toEqual([
      "second",
      "third",
    ]);
    expect(
      page.messages.map(
        (message) => (message as { __openclaw?: { seq?: number } })["__openclaw"]?.seq,
      ),
    ).toEqual([2, 3]);
  });

  test("honors agent ids when no store path or session file is provided", async () => {
    const sessionId = "reader-agent-scope";
    await persistSessionTranscriptTurn(
      { agentId: "agent-one", sessionId, sessionKey: "agent:agent-one:main" },
      {
        messages: [
          {
            eventId: "agent-message",
            message: { role: "user", content: "agent scoped prompt" },
          },
        ],
        touchSessionEntry: false,
      },
    );
    const scope = { agentId: "agent-one", sessionId };

    await expect(readSessionMessageCountAsync(scope)).resolves.toBe(1);
    await expect(readSessionMessageByIdAsync(scope, "agent-message")).resolves.toMatchObject({
      found: true,
      seq: 1,
    });
    await expect(
      readSessionMessagesAsync(scope, { mode: "full", reason: "facade agent scope test" }),
    ).resolves.toMatchObject([{ content: "agent scoped prompt" }]);
  });
});
