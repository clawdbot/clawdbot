import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntry,
} from "../config/sessions/session-accessor.js";
import { waitForSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/sqlite-marker.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { readSessionMessagesAroundIdWithStatsAsync } from "./session-transcript-anchor-reader.js";
import {
  readSessionMessageByIdAsync,
  readSessionMessageCountAsync,
  readSessionMessagesAsync,
  readSessionMessagesPageWithStatsAsync,
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
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
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
    const scope = writeTranscript(sessionId, [
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

  test("does not reuse the current session file for a historical anchor", async () => {
    const currentSessionId = "reader-current-collision";
    const historicalSessionId = "reader-historical-collision";
    const currentSessionFile = path.join(tempDir, `${currentSessionId}.jsonl`);
    fs.writeFileSync(
      currentSessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: currentSessionId })}\n${JSON.stringify({
        type: "message",
        id: "shared-message",
        parentId: null,
        message: { role: "user", content: "current collision" },
      })}\n`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tempDir, `${historicalSessionId}.jsonl.reset.2026-07-12T17-00-00.000Z`),
      `${JSON.stringify({ type: "session", version: 3, id: historicalSessionId })}\n${JSON.stringify(
        {
          type: "message",
          id: "shared-message",
          parentId: null,
          message: { role: "user", content: "historical collision" },
        },
      )}\n`,
      "utf-8",
    );

    await expect(
      readSessionMessagesAroundIdWithStatsAsync(
        {
          agentId: "main",
          sessionId: historicalSessionId,
          sessionKey: "agent:main:main",
          storePath,
          sessionEntry: { sessionId: currentSessionId, sessionFile: currentSessionFile },
        },
        {
          messageId: "shared-message",
          maxMessages: 1,
          allowResetArchiveFallback: true,
        },
      ),
    ).resolves.toMatchObject({
      found: true,
      messages: [{ content: "historical collision" }],
    });
  });

  test("keeps an explicit historical session file over a mismatched current entry", async () => {
    const historicalSessionId = "reader-explicit-historical";
    const historicalSessionFile = path.join(tempDir, "explicit-historical.jsonl");
    fs.writeFileSync(
      historicalSessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: historicalSessionId })}\n${JSON.stringify(
        {
          type: "message",
          id: "historical-message",
          parentId: null,
          message: { role: "user", content: "explicit historical" },
        },
      )}\n`,
      "utf-8",
    );

    await expect(
      readSessionMessagesAroundIdWithStatsAsync(
        {
          sessionFile: historicalSessionFile,
          sessionId: historicalSessionId,
          sessionEntry: {
            sessionId: "reader-current-entry",
            sessionFile: path.join(tempDir, "reader-current-entry.jsonl"),
          },
        },
        {
          messageId: "historical-message",
          maxMessages: 1,
          allowResetArchiveFallback: true,
        },
      ),
    ).resolves.toMatchObject({
      found: true,
      messages: [{ content: "explicit historical" }],
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

  test("uses SQLite marker identity when only sessionFile is provided", async () => {
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
    const marker = formatSqliteSessionFileMarker({
      agentId: "marker-agent",
      sessionId,
      storePath: markerStorePath,
    });

    await expect(
      readSessionMessagesAsync(
        { sessionFile: marker, sessionId },
        { mode: "full", reason: "sqlite marker-only read test" },
      ),
    ).resolves.toMatchObject([{ content: "marker scoped prompt" }]);
    await expect(
      readSessionMessageByIdAsync({ sessionFile: marker, sessionId }, "marker-message"),
    ).resolves.toMatchObject({ found: true, seq: 1 });
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
