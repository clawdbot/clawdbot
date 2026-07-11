import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntry,
} from "../config/sessions/session-accessor.js";
import { appendSqliteTranscriptEvents } from "../config/sessions/session-accessor.sqlite.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/sqlite-marker.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  readLatestRecentSessionUsageFromTranscriptAsync,
  readLatestSessionUsageFromTranscriptAsync,
  readRecentSessionMessagesWithStats,
  readRecentSessionMessagesWithStatsAsync,
  readRecentSessionTranscriptLines,
  readRecentSessionUsageFromTranscript,
  readRecentSessionUsageFromTranscriptAsync,
  readSessionMessageByIdAsync,
  readSessionMessageCountAsync,
  readSessionMessagesAsync,
  readSessionMessagesPageWithStatsAsync,
  readSessionTitleFieldsFromTranscript,
  type SessionTranscriptReadScope,
} from "./session-transcript-readers.js";

describe("session transcript reader facade", () => {
  let tempDir: string;
  let storePath: string;
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-transcript-readers-"));
    storePath = path.join(tempDir, "sessions.json");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
  });

  afterEach(() => {
    envSnapshot.restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeTranscript(sessionId: string, events: unknown[]): SessionTranscriptReadScope {
    const transcriptPath = path.join(tempDir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      transcriptPath,
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf-8",
    );
    return { sessionFile: transcriptPath, sessionId, sessionKey: `agent:main:${sessionId}` };
  }

  test("reads active-branch messages and message ids through a scope", async () => {
    const scope = writeTranscript("reader-active-branch", [
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
  });

  test("reads recent tails with total counts through a scope", () => {
    const scope = writeTranscript("reader-recent-tail", [
      { type: "session", version: 1, id: "reader-recent-tail" },
      { message: { role: "user", content: "old" } },
      { message: { role: "assistant", content: "middle" } },
      { message: { role: "user", content: "recent" } },
      { message: { role: "assistant", content: "latest" } },
    ]);

    const messages = readRecentSessionMessagesWithStats(scope, {
      maxMessages: 2,
      maxBytes: 2048,
    });
    const tail = readRecentSessionTranscriptLines({ ...scope, maxLines: 3 });

    expect(messages.totalMessages).toBe(4);
    expect(messages.messages).toMatchObject([{ content: "recent" }, { content: "latest" }]);
    expect(tail?.totalLines).toBe(5);
    expect(tail?.lines.map((line) => JSON.parse(line).message?.content)).toEqual([
      "middle",
      "recent",
      "latest",
    ]);
  });

  test("reads title fields and recent usage through a scope", async () => {
    const scope = writeTranscript("reader-title-usage", [
      { type: "session", version: 1, id: "reader-title-usage" },
      { message: { role: "user", content: "derive this title" } },
      {
        message: {
          role: "assistant",
          content: "metered answer",
          provider: "openai",
          model: "gpt-5.5",
          usage: {
            input: 11,
            output: 7,
            contextUsage: { state: "unavailable" },
          },
        },
      },
    ]);

    expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
      firstUserMessage: "derive this title",
      lastMessagePreview: "metered answer",
    });
    await expect(readLatestSessionUsageFromTranscriptAsync(scope)).resolves.toMatchObject({
      inputTokens: 11,
      model: "gpt-5.5",
      modelProvider: "openai",
      outputTokens: 7,
    });
    await expect(
      readLatestRecentSessionUsageFromTranscriptAsync(scope, 4096),
    ).resolves.toMatchObject({
      inputTokens: 11,
      contextUsage: { state: "unavailable" },
      model: "gpt-5.5",
      modelProvider: "openai",
      outputTokens: 7,
    });
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
        {
          message: {
            role: "assistant",
            content: "sqlite answer",
            provider: "openai",
            model: "gpt-5.5",
            usage: { input: 3, output: 4, total: 7 },
          },
        },
        {
          message: {
            role: "assistant",
            content: "sqlite follow-up",
            provider: "openai",
            model: "gpt-5.5",
            usage: { input: 5, output: 6, total: 11 },
          },
        },
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
    ).resolves.toMatchObject([{ content: "sqlite follow-up", __openclaw: { seq: 4 } }]);
    await expect(readSessionMessageCountAsync(scope)).resolves.toBe(3);
    expect(
      readRecentSessionMessagesWithStats(scope, {
        maxMessages: 2,
        maxBytes: 4096,
      }).messages.map(
        (message) => (message as { __openclaw?: { seq?: number } })["__openclaw"]?.seq,
      ),
    ).toEqual([3, 4]);
    await expect(
      readRecentSessionMessagesWithStatsAsync(scope, {
        maxMessages: 2,
        maxBytes: 4096,
      }).then((result) =>
        result.messages.map(
          (message) => (message as { __openclaw?: { seq?: number } })["__openclaw"]?.seq,
        ),
      ),
    ).resolves.toEqual([3, 4]);
    expect(readSessionTitleFieldsFromTranscript(scope)).toEqual({
      firstUserMessage: "sqlite prompt",
      lastMessagePreview: "sqlite follow-up",
    });
    await expect(readLatestSessionUsageFromTranscriptAsync(scope)).resolves.toMatchObject({
      inputTokens: 8,
      model: "gpt-5.5",
      modelProvider: "openai",
      outputTokens: 10,
    });
    await expect(
      readLatestRecentSessionUsageFromTranscriptAsync(scope, 4096),
    ).resolves.toMatchObject({
      inputTokens: 5,
      model: "gpt-5.5",
      modelProvider: "openai",
      outputTokens: 6,
    });
  });

  test("uses SQLite marker identity when only sessionFile is provided", async () => {
    const sessionId = "reader-marker-only";
    const markerStorePath = path.join(
      tempDir,
      "agents",
      "marker-agent",
      "sessions",
      "sessions.json",
    );
    fs.mkdirSync(path.dirname(markerStorePath), { recursive: true });
    const marker = formatSqliteSessionFileMarker({
      agentId: "marker-agent",
      sessionId,
      storePath: markerStorePath,
    });
    await appendSqliteTranscriptEvents(
      {
        agentId: "marker-agent",
        sessionId,
        sessionKey: "agent:marker-agent:main",
        storePath: markerStorePath,
      },
      [
        {
          type: "message",
          id: "marker-message",
          parentId: null,
          message: { role: "user", content: "marker scoped prompt" },
        },
      ],
    );

    await expect(
      readSessionMessagesAsync(
        { sessionFile: marker, sessionId },
        { mode: "full", reason: "sqlite marker-only read test" },
      ),
    ).resolves.toMatchObject([{ content: "marker scoped prompt" }]);
    await expect(
      readSessionMessageByIdAsync({ sessionFile: marker, sessionId }, "marker-message"),
    ).resolves.toMatchObject({
      found: true,
      seq: 1,
    });
  });

  test("projects SQLite transcript reads to the active branch", async () => {
    const sessionId = "reader-sqlite-branch";
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath,
    };
    await appendSqliteTranscriptEvents(scope, [
      { type: "session", version: 1, id: sessionId },
      {
        type: "message",
        id: "root",
        parentId: null,
        message: { role: "user", content: "branch prompt" },
      },
      {
        type: "message",
        id: "inactive",
        parentId: "root",
        message: { role: "assistant", content: "stale branch" },
      },
      {
        type: "message",
        id: "active",
        parentId: "root",
        message: { role: "assistant", content: "active branch" },
      },
    ]);

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
    ).toEqual([2, 4]);
    await expect(readSessionMessageCountAsync(scope)).resolves.toBe(2);
  });

  test("bounds SQLite recent message and usage reads", async () => {
    const sessionId = "reader-sqlite-bounded-recent";
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath,
    };
    await persistSessionTranscriptTurn(scope, {
      messages: [
        { message: { role: "user", content: "old prompt" } },
        {
          message: {
            role: "assistant",
            content: `old answer ${"x".repeat(5000)}`,
            provider: "openai",
            model: "gpt-5.5",
            usage: { input: 100, output: 100 },
          },
        },
        { message: { role: "user", content: "recent prompt" } },
        {
          message: {
            role: "assistant",
            content: "recent answer",
            provider: "openai",
            model: "gpt-5.5",
            usage: { input: 5, output: 6 },
          },
        },
      ],
      touchSessionEntry: false,
    });

    const recentMessages = readRecentSessionMessagesWithStats(scope, {
      maxMessages: 2,
      maxBytes: 4096,
      maxLines: 2,
    }).messages;
    expect(recentMessages.map((message) => (message as { content?: string }).content)).toEqual([
      "recent prompt",
      "recent answer",
    ]);
    expect(
      recentMessages.map(
        (message) => (message as { __openclaw?: { seq?: number } })["__openclaw"]?.seq,
      ),
    ).toEqual([4, 5]);
    await expect(readRecentSessionUsageFromTranscriptAsync(scope, 1024)).resolves.toMatchObject({
      inputTokens: 5,
      outputTokens: 6,
    });
    expect(readRecentSessionUsageFromTranscript(scope, 1024)).toMatchObject({
      inputTokens: 5,
      outputTokens: 6,
    });
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
    ).toEqual([3, 4]);
  });

  test("ignores zero-usage SQLite delivery mirrors for latest usage", async () => {
    const sessionId = "reader-sqlite-delivery-mirror";
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath,
    };
    await persistSessionTranscriptTurn(scope, {
      cwd: tempDir,
      messages: [
        {
          message: {
            role: "assistant",
            content: "real model answer",
            provider: "openai",
            model: "gpt-5.5",
            usage: { input: 7, output: 8, total: 15 },
          },
        },
        {
          message: {
            role: "assistant",
            content: "delivered",
            provider: "openclaw",
            model: "delivery-mirror",
            usage: { input: 0, output: 0, total: 0, cost: { total: 0 } },
          },
        },
      ],
      touchSessionEntry: false,
    });

    await expect(
      readLatestRecentSessionUsageFromTranscriptAsync(scope, 4096),
    ).resolves.toMatchObject({
      inputTokens: 7,
      model: "gpt-5.5",
      modelProvider: "openai",
      outputTokens: 8,
    });
  });

  test("honors agent ids when no store path or session file is provided", async () => {
    const sessionId = "reader-agent-scope";
    await appendSqliteTranscriptEvents(
      { agentId: "agent-one", sessionId, sessionKey: "agent:agent-one:main" },
      [
        {
          type: "message",
          id: "agent-message",
          parentId: null,
          message: { role: "user", content: "agent scoped prompt" },
        },
      ],
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

  test("reads explicit transcript files without session store identity", async () => {
    const sessionId = "reader-explicit-file";
    const transcriptPath = path.join(tempDir, "explicit-file.jsonl");
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: "message",
        id: "explicit-message",
        parentId: null,
        message: { role: "user", content: "explicit prompt" },
      })}\n`,
      "utf-8",
    );
    const scope = { sessionFile: transcriptPath, sessionId };

    await expect(readSessionMessageCountAsync(scope)).resolves.toBe(1);
    await expect(readSessionMessageByIdAsync(scope, "explicit-message")).resolves.toMatchObject({
      found: true,
      seq: 1,
    });
    await expect(
      readSessionMessagesAsync(scope, { mode: "full", reason: "explicit file test" }),
    ).resolves.toMatchObject([{ content: "explicit prompt" }]);
  });
});
