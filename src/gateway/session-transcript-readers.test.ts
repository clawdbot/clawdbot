import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import {
  persistSessionTranscriptTurn,
  replaceTranscriptEvents,
  upsertSessionEntry,
} from "../config/sessions/session-accessor.js";
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
  type SessionTranscriptReadScope,
} from "./session-transcript-readers.js";
import {
  readSessionTitleFieldsFromTranscript,
  readSessionTitleFieldsFromTranscriptBatch,
} from "./session-transcript-title-reader.js";

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    readSessionTranscriptMessageEventPage: vi.fn(actual.readSessionTranscriptMessageEventPage),
    readSessionTranscriptMessageEvents: vi.fn(actual.readSessionTranscriptMessageEvents),
    readSessionTranscriptTitleProbeBatch: vi.fn(actual.readSessionTranscriptTitleProbeBatch),
    readSessionTranscriptWatermark: vi.fn(actual.readSessionTranscriptWatermark),
    readSessionTranscriptWatermarkBatch: vi.fn(actual.readSessionTranscriptWatermarkBatch),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session transcript reader facade", () => {
  let tempDir: string;
  let storePath: string;
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
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

  async function writeSqliteMessages(
    sessionId: string,
    messages: Array<{ content: unknown; provenance?: unknown; role: string }>,
  ): Promise<SessionTranscriptReadScope> {
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath,
    };
    await persistSessionTranscriptTurn(scope, {
      messages: messages.map((message) => ({ message })),
      touchSessionEntry: false,
    });
    return scope;
  }

  function extractReferenceText(message: unknown): string | null {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return null;
    }
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      return content.trim() || null;
    }
    if (!Array.isArray(content)) {
      return null;
    }
    const text = content
      .map((entry) =>
        entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string"
          ? (entry as { text: string }).text
          : "",
      )
      .filter((part) => part.trim())
      .join("\n")
      .trim();
    return text || null;
  }

  async function readFullScanTitleFields(scope: SessionTranscriptReadScope) {
    const messages = await readSessionMessagesAsync(scope, {
      mode: "full",
      reason: "title probe parity reference",
    });
    const firstUser = messages.find(
      (message) =>
        message &&
        typeof message === "object" &&
        !Array.isArray(message) &&
        (message as { role?: unknown }).role === "user" &&
        (message as { provenance?: { kind?: unknown } }).provenance?.kind !== "inter_session",
    );
    return {
      firstUserMessage: firstUser ? extractReferenceText(firstUser) : null,
      lastMessagePreview: messages.toReversed().map(extractReferenceText).find(Boolean) ?? null,
    };
  }

  function boundedPageEventReadCount(): number {
    return vi
      .mocked(sessionAccessor.readSessionTranscriptMessageEventPage)
      .mock.results.reduce(
        (total, result) => total + (result.type === "return" ? result.value.events.length : 0),
        0,
      );
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
    await upsertSessionEntry(
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

  test("keeps bounded title fields at full-scan parity", async () => {
    const scope = await writeSqliteMessages(
      "reader-title-parity",
      Array.from({ length: 105 }, (_, index) => {
        if (index === 60) {
          return { role: "user", content: "late prompt" };
        }
        if (index === 102) {
          return { role: "assistant", content: "last visible" };
        }
        return { role: "assistant", content: index > 102 ? " " : `reply ${String(index)}` };
      }),
    );
    const reference = await readFullScanTitleFields(scope);
    expect(reference).toEqual({
      firstUserMessage: "late prompt",
      lastMessagePreview: "last visible",
    });
    vi.clearAllMocks();

    expect(readSessionTitleFieldsFromTranscript(scope)).toEqual(reference);
    expect(sessionAccessor.readSessionTranscriptMessageEvents).not.toHaveBeenCalled();
  });

  test("falls back to the canonical visible window for reset transcripts", async () => {
    const sessionId = "reader-title-reset-window";
    const scope = await writeTranscript(sessionId, [
      { type: "session", version: 3, id: sessionId },
      {
        type: "message",
        id: "old",
        parentId: null,
        message: { role: "user", content: "hidden old prompt" },
      },
      {
        type: "message",
        id: "kept-user",
        parentId: "old",
        message: { role: "user", content: "kept prompt" },
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
        firstKeptEntryId: "kept-user",
      },
      {
        type: "message",
        id: "post-reset",
        parentId: "reset-boundary",
        message: { role: "assistant", content: "newest answer" },
      },
    ]);
    expect(readSessionTitleFieldsFromTranscriptBatch([scope])).toEqual([
      { firstUserMessage: "kept prompt", lastMessagePreview: "newest answer" },
    ]);
  });

  test("bounds title probe reads independently of transcript length", async () => {
    const probeReadCount = async (sessionId: string, messageCount: number) => {
      const scope = await writeSqliteMessages(
        sessionId,
        Array.from({ length: messageCount }, () => ({ role: "assistant", content: " " })),
      );
      vi.clearAllMocks();

      expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
        firstUserMessage: null,
        lastMessagePreview: null,
      });
      expect(sessionAccessor.readSessionTranscriptMessageEvents).not.toHaveBeenCalled();
      expect(
        vi
          .mocked(sessionAccessor.readSessionTranscriptMessageEventPage)
          .mock.calls.map(([, options]) => options.maxMessages),
      ).toEqual([20, 80, 20, 80]);
      return boundedPageEventReadCount();
    };

    await expect(probeReadCount("reader-title-bounded-101", 101)).resolves.toBe(200);
    await expect(probeReadCount("reader-title-bounded-201", 201)).resolves.toBe(200);
  });

  test("reuses cached SQLite title fields while the transcript watermark is unchanged", async () => {
    const scope = await writeSqliteMessages("reader-title-cache-warm", [
      { role: "user", content: "cached prompt" },
      { role: "assistant", content: "cached reply" },
    ]);
    expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
      firstUserMessage: "cached prompt",
      lastMessagePreview: "cached reply",
    });
    vi.clearAllMocks();

    expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
      firstUserMessage: "cached prompt",
      lastMessagePreview: "cached reply",
    });
    expect(sessionAccessor.readSessionTranscriptMessageEventPage).not.toHaveBeenCalled();
  });

  test("skips batch title probes while every cached transcript watermark is unchanged", async () => {
    const scope = await writeSqliteMessages("reader-title-batch-cache-warm", [
      { role: "user", content: "cached batch prompt" },
      { role: "assistant", content: "cached batch reply" },
    ]);
    expect(readSessionTitleFieldsFromTranscriptBatch([scope])).toEqual([
      { firstUserMessage: "cached batch prompt", lastMessagePreview: "cached batch reply" },
    ]);
    vi.clearAllMocks();

    expect(readSessionTitleFieldsFromTranscriptBatch([scope])).toEqual([
      { firstUserMessage: "cached batch prompt", lastMessagePreview: "cached batch reply" },
    ]);
    expect(sessionAccessor.readSessionTranscriptWatermarkBatch).toHaveBeenCalledOnce();
    expect(sessionAccessor.readSessionTranscriptWatermark).not.toHaveBeenCalled();
    expect(sessionAccessor.readSessionTranscriptTitleProbeBatch).not.toHaveBeenCalled();
    expect(sessionAccessor.readSessionTranscriptMessageEventPage).not.toHaveBeenCalled();
  });

  test("resolves SQLite store ownership once for a multi-row transcript batch", async () => {
    const scopes: SessionTranscriptReadScope[] = [];
    for (let index = 0; index < 30; index += 1) {
      scopes.push(
        await writeSqliteMessages(`reader-title-target-batch-${index}`, [
          { role: "user", content: `prompt ${index}` },
          { role: "assistant", content: `reply ${index}` },
        ]),
      );
    }
    const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare");
    try {
      expect(sessionAccessor.readSessionTranscriptTitleProbeBatch(scopes)).toHaveLength(30);
      const titleSchemaReads = prepareSpy.mock.calls.filter(([sql]) =>
        sql.toLowerCase().includes("pragma user_version"),
      );
      expect(titleSchemaReads).toHaveLength(1);

      prepareSpy.mockClear();
      expect(sessionAccessor.readSessionTranscriptWatermarkBatch(scopes)).toHaveLength(30);
      const watermarkSchemaReads = prepareSpy.mock.calls.filter(([sql]) =>
        sql.toLowerCase().includes("pragma user_version"),
      );
      expect(watermarkSchemaReads).toHaveLength(1);
    } finally {
      prepareSpy.mockRestore();
    }
  });

  test("reprobes cached batch title fields after an append advances max seq", async () => {
    const sessionId = "reader-title-batch-cache-append";
    const scope = await writeSqliteMessages(sessionId, [
      { role: "user", content: "batch append prompt" },
      { role: "assistant", content: "first batch reply" },
    ]);
    expect(readSessionTitleFieldsFromTranscriptBatch([scope])[0]?.lastMessagePreview).toBe(
      "first batch reply",
    );
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey: `agent:main:${sessionId}`, storePath },
      {
        messages: [{ message: { role: "assistant", content: "appended batch reply" } }],
        touchSessionEntry: false,
      },
    );
    vi.clearAllMocks();

    expect(readSessionTitleFieldsFromTranscriptBatch([scope])[0]?.lastMessagePreview).toBe(
      "appended batch reply",
    );
    expect(sessionAccessor.readSessionTranscriptWatermarkBatch).toHaveBeenCalledOnce();
    expect(sessionAccessor.readSessionTranscriptWatermark).not.toHaveBeenCalled();
    expect(sessionAccessor.readSessionTranscriptTitleProbeBatch).toHaveBeenCalledOnce();
    expect(sessionAccessor.readSessionTranscriptMessageEventPage).not.toHaveBeenCalled();
  });

  test("invalidates cached SQLite title fields after an append advances max seq", async () => {
    const sessionId = "reader-title-cache-append";
    const scope = await writeSqliteMessages(sessionId, [
      { role: "user", content: "append prompt" },
      { role: "assistant", content: "first reply" },
    ]);
    expect(readSessionTitleFieldsFromTranscript(scope).lastMessagePreview).toBe("first reply");
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey: `agent:main:${sessionId}`, storePath },
      {
        messages: [{ message: { role: "assistant", content: "appended reply" } }],
        touchSessionEntry: false,
      },
    );
    vi.clearAllMocks();

    expect(readSessionTitleFieldsFromTranscript(scope).lastMessagePreview).toBe("appended reply");
    expect(sessionAccessor.readSessionTranscriptMessageEventPage).toHaveBeenCalled();
  });

  test("invalidates cached SQLite title fields after the rewrite generation changes", async () => {
    const sessionId = "reader-title-cache-generation";
    const scope = await writeSqliteMessages(sessionId, [
      { role: "user", content: "generation prompt" },
      { role: "assistant", content: "generation reply" },
    ]);
    expect(readSessionTitleFieldsFromTranscript(scope).firstUserMessage).toBe("generation prompt");
    openOpenClawAgentDatabase({
      agentId: "main",
      path: path.join(tempDir, "openclaw-agent.sqlite"),
    })
      .db.prepare("UPDATE transcript_rewrite_watermarks SET generation = ? WHERE session_id = ?")
      .run("f".repeat(32), sessionId);
    vi.clearAllMocks();

    expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
      firstUserMessage: "generation prompt",
      lastMessagePreview: "generation reply",
    });
    expect(sessionAccessor.readSessionTranscriptMessageEventPage).toHaveBeenCalled();
  });

  test("returns missing title fields when the bounded head and tail caps miss", async () => {
    const scope = await writeSqliteMessages(
      "reader-title-cap-miss",
      Array.from({ length: 201 }, (_, index) =>
        index === 100
          ? { role: "user", content: "outside both probes" }
          : { role: "assistant", content: " " },
      ),
    );
    vi.clearAllMocks();

    expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
      firstUserMessage: null,
      lastMessagePreview: null,
    });
    expect(sessionAccessor.readSessionTranscriptMessageEvents).not.toHaveBeenCalled();
    expect(boundedPageEventReadCount()).toBe(200);
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
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      path: path.join(tempDir, "openclaw-agent.sqlite"),
    });
    database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(sessionId);

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
