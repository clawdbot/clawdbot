// Session manager tests cover JSONL recovery behavior for interrupted or
// corrupted transcript writes.
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/sqlite-marker.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import * as Logger from "../../logger.js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../../shared/transcript-only-openclaw-assistant.js";
import { prepareSessionManagerForRun } from "../embedded-agent-runner/session-manager-init.js";
import { repairSessionFileIfNeeded } from "../session-file-repair.js";
import { loadSqliteMarkedSessionFile } from "./session-manager-file.js";
import {
  buildSessionContext,
  CURRENT_SESSION_VERSION,
  findMostRecentSession,
  loadEntriesFromFile,
  parseSessionEntries,
  SessionManager,
  type FileEntry,
  type SessionEntry,
  type SessionMessageEntry,
} from "./session-manager.js";

const tempPaths: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-manager-"));
  tempPaths.push(dir);
  return dir;
}

describe("SessionManager.open", () => {
  afterEach(async () => {
    await Promise.all(
      tempPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("opens SQLite markers without creating marker-named files and persists assistant replies", async () => {
    const dir = await makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "sqlite-session";
    const sessionKey = "agent:main:dashboard:sqlite";
    const marker = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    await upsertSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionFile: marker,
        sessionId,
        updatedAt: 10,
      },
    );
    await appendTranscriptMessage(
      { agentId: "main", sessionId, sessionKey, storePath },
      {
        cwd: dir,
        message: { role: "user", content: "question" },
      },
    );

    const sessionManager = SessionManager.open(marker, dir, dir);
    expect(sessionManager.buildSessionContext().messages).toEqual([
      expect.objectContaining({ content: "question", role: "user" }),
    ]);

    const assistantId = sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.5",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const thinkingChangeId = sessionManager.appendThinkingLevelChange("high");
    const modelChangeId = sessionManager.appendModelChange("openai", "gpt-5.5");
    const compactionId = sessionManager.appendCompaction("summary", "assistant-1", 42);

    await expect(fs.stat(path.join(process.cwd(), marker))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      loadTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }),
    ).resolves.toEqual([
      expect.objectContaining({ type: "session" }),
      expect.objectContaining({
        message: expect.objectContaining({ content: "question", role: "user" }),
        type: "message",
      }),
      expect.objectContaining({
        id: assistantId,
        parentId: expect.any(String),
        message: expect.objectContaining({
          content: [{ type: "text", text: "answer" }],
          role: "assistant",
        }),
        type: "message",
      }),
      expect.objectContaining({
        id: thinkingChangeId,
        thinkingLevel: "high",
        type: "thinking_level_change",
      }),
      expect.objectContaining({
        id: modelChangeId,
        modelId: "gpt-5.5",
        provider: "openai",
        type: "model_change",
      }),
      expect.objectContaining({
        firstKeptEntryId: "assistant-1",
        id: compactionId,
        summary: "summary",
        type: "compaction",
      }),
    ]);
    const reopened = SessionManager.open(marker, dir, dir);
    expect(reopened.getEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: thinkingChangeId, type: "thinking_level_change" }),
        expect.objectContaining({ id: modelChangeId, type: "model_change" }),
        expect.objectContaining({ id: compactionId, type: "compaction" }),
      ]),
    );
  });

  it("preserves root-to-leaf ordering across session branches", () => {
    const entries = [
      {
        type: "message",
        id: "root",
        parentId: null,
        timestamp: "2026-07-16T00:00:00.000Z",
        message: { role: "user", content: "root", timestamp: 1 },
      },
      {
        type: "message",
        id: "main-leaf",
        parentId: "root",
        timestamp: "2026-07-16T00:00:01.000Z",
        message: { role: "user", content: "main", timestamp: 2 },
      },
      {
        type: "message",
        id: "side-middle",
        parentId: "root",
        timestamp: "2026-07-16T00:00:02.000Z",
        message: { role: "user", content: "side middle", timestamp: 3 },
      },
      {
        type: "message",
        id: "side-leaf",
        parentId: "side-middle",
        timestamp: "2026-07-16T00:00:03.000Z",
        message: { role: "user", content: "side leaf", timestamp: 4 },
      },
    ] satisfies SessionMessageEntry[];
    const manager = SessionManager.inMemory();
    for (const entry of entries) {
      manager.appendMessage(entry.message);
      if (entry.id === "main-leaf") {
        manager.branch(manager.getBranch().at(0)!.id);
      }
    }

    expect(buildSessionContext(entries, "side-leaf").messages).toMatchObject([
      { content: "root" },
      { content: "side middle" },
      { content: "side leaf" },
    ]);
    expect(
      manager
        .getBranch()
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.message),
    ).toMatchObject([{ content: "root" }, { content: "side middle" }, { content: "side leaf" }]);
  });

  it("normalizes session names to one line", () => {
    const manager = SessionManager.inMemory();

    manager.appendSessionInfo("  first\nsecond\r\nthird  ");

    expect(manager.getSessionName()).toBe("first second third");
  });

  it("ignores opaque SQLite rows while resolving the session cwd", async () => {
    const dir = await makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "sqlite-opaque-header";
    const sessionKey = "agent:main:dashboard:sqlite-opaque-header";
    const marker = formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath });
    await upsertSessionEntry(
      { agentId: "main", sessionKey, storePath },
      { sessionFile: marker, sessionId, updatedAt: 10 },
    );

    const loaded = loadSqliteMarkedSessionFile(marker, () => [
      null as unknown as FileEntry,
      {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: sessionId,
        timestamp: "2026-07-14T00:00:00.000Z",
        cwd: dir,
      },
    ]);

    expect(loaded?.cwd).toBe(dir);
  });

  it("persists prompt-released leaf controls through SQLite markers", async () => {
    const dir = await makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "sqlite-prompt-release";
    const sessionKey = "agent:main:dashboard:sqlite-prompt-release";
    const marker = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await upsertSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionFile: marker,
        sessionId,
        updatedAt: 10,
      },
    );
    const user = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "user-message",
      message: { role: "user", content: "question" },
    });
    const assistant = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "base-answer",
      message: buildAssistantMessage("base answer"),
      parentId: user.messageId,
    });
    const sessionManager = SessionManager.open(marker, dir, dir);
    const sideEntry = {
      type: "message" as const,
      id: "side-delivery",
      parentId: assistant.messageId,
      timestamp: "2026-06-15T00:00:03.000Z",
      message: buildAssistantMessage("side delivery"),
    };
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: sideEntry.id,
      message: sideEntry.message,
      parentId: sideEntry.parentId,
    });

    const mergeResult = sessionManager.mergePromptReleasedSessionEntries([sideEntry], {
      persistLeaf: true,
    });

    expect(mergeResult?.publishedEntries).toEqual([{ kind: "id", id: expect.any(String) }]);
    const records = await loadTranscriptEvents(scope);
    expect(records.at(-1)).toMatchObject({
      type: "leaf",
      parentId: sideEntry.id,
      targetId: assistant.messageId,
      appendParentId: sideEntry.id,
      appendMode: "side",
    });
    await expect(fs.stat(path.join(process.cwd(), marker))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reloads SQLite markers through setSessionFile without switching to file paths", async () => {
    const dir = await makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "sqlite-marker-reload";
    const sessionKey = "agent:main:dashboard:sqlite-marker-reload";
    const marker = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await upsertSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionFile: marker,
        sessionId,
        updatedAt: 10,
      },
    );
    await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "user-message",
      message: { role: "user", content: "question before reload" },
    });

    const sessionManager = SessionManager.open(marker, dir, dir);
    sessionManager.setSessionFile(marker);
    expect(sessionManager.buildSessionContext().messages).toEqual([
      expect.objectContaining({ content: "question before reload", role: "user" }),
    ]);
    sessionManager.appendMessage(buildAssistantMessage("answer after reload"));

    await expect(fs.stat(path.join(process.cwd(), marker))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(loadTranscriptEvents(scope)).resolves.toEqual([
      expect.objectContaining({ type: "session" }),
      expect.objectContaining({
        message: expect.objectContaining({ content: "question before reload", role: "user" }),
        type: "message",
      }),
      expect.objectContaining({
        message: expect.objectContaining({
          content: [{ type: "text", text: "answer after reload" }],
          role: "assistant",
        }),
        type: "message",
      }),
    ]);
  });

  it("creates SQLite-backed branch sessions without rewriting the source transcript", async () => {
    const dir = await makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "sqlite-branch-source";
    const sessionKey = "agent:main:dashboard:sqlite-branch-source";
    const marker = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await upsertSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        channel: "dashboard",
        sessionFile: marker,
        sessionId,
        updatedAt: 10,
      },
    );
    const user = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "user-message",
      message: { role: "user", content: "question before branch" },
    });
    const assistant = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "assistant-message",
      message: buildAssistantMessage("answer before branch"),
      parentId: user.messageId,
    });

    const sessionManager = SessionManager.open(marker, dir, dir);
    const branchedMarker = sessionManager.createBranchedSession(assistant.messageId);
    const branchedSessionId = sessionManager.getSessionId();

    expect(branchedMarker).toContain(`sqlite:main:${branchedSessionId}:`);
    expect(branchedSessionId).not.toBe(sessionId);
    expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
      channel: "dashboard",
      sessionFile: branchedMarker,
      sessionId: branchedSessionId,
    });
    await expect(fs.stat(path.join(process.cwd(), branchedMarker!))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(loadTranscriptEvents({ agentId: "main", sessionId, storePath })).resolves.toEqual([
      expect.objectContaining({ id: sessionId, type: "session" }),
      expect.objectContaining({ id: user.messageId, type: "message" }),
      expect.objectContaining({ id: assistant.messageId, type: "message" }),
    ]);
    await expect(
      loadTranscriptEvents({
        agentId: "main",
        sessionId: branchedSessionId,
        sessionKey,
        storePath,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: branchedSessionId,
        parentSession: marker,
        type: "session",
      }),
      expect.objectContaining({ id: user.messageId, type: "message" }),
      expect.objectContaining({ id: assistant.messageId, type: "message" }),
    ]);
  });

  it("persists user turns when a SQLite marker has no external recorder", async () => {
    const dir = await makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "sqlite-direct-user-session";
    const sessionKey = "agent:main:voice:direct-user";
    const marker = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    await upsertSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionFile: marker,
        sessionId,
        updatedAt: 10,
      },
    );

    const sessionManager = SessionManager.open(marker, dir, dir);
    const userId = sessionManager.appendMessage({
      role: "user",
      content: "voice prompt",
      timestamp: Date.now(),
    });

    await expect(
      loadTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        id: userId,
        message: expect.objectContaining({ content: "voice prompt", role: "user" }),
        type: "message",
      }),
    );
  });

  it("rewrites SQLite transcript rows when removing trailing entries", async () => {
    const dir = await makeTempDir();
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "sqlite-remove-trailing-session";
    const sessionKey = "agent:main:dashboard:sqlite-remove-trailing";
    const marker = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await upsertSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionFile: marker,
        sessionId,
        updatedAt: 10,
      },
    );
    const user = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "user-message",
      message: { role: "user", content: "question" },
    });
    const baseAnswer = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "base-answer",
      message: buildAssistantMessage("base answer"),
      parentId: user.messageId,
    });
    const temporaryError = await appendTranscriptMessage(scope, {
      cwd: dir,
      eventId: "temporary-error",
      message: buildAssistantMessage("temporary error"),
      parentId: baseAnswer.messageId,
    });

    const sessionManager = SessionManager.open(marker, dir, dir);

    expect(
      sessionManager.removeTrailingEntries((entry) => entry.id === temporaryError.messageId),
    ).toBe(1);
    expect(sessionManager.getLeafId()).toBe(baseAnswer.messageId);
    const replacementId = sessionManager.appendMessage(buildAssistantMessage("replacement answer"));

    const records = await loadTranscriptEvents(scope);
    expect(
      records.map((record) =>
        record && typeof record === "object" && "id" in record ? record.id : undefined,
      ),
    ).not.toContain(temporaryError.messageId);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: replacementId,
          message: expect.objectContaining({
            content: [{ type: "text", text: "replacement answer" }],
            role: "assistant",
          }),
          parentId: baseAnswer.messageId,
          type: "message",
        }),
      ]),
    );
    await expect(fs.stat(path.join(process.cwd(), marker))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("recovers a corrupted first-line header without truncating later messages", async () => {
    // A damaged header should be repairable without treating valid later
    // message entries as disposable transcript state.
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const originalHeader = {
      type: "session",
      version: 3,
      id: "original-session",
      timestamp: "2026-05-27T00:00:00.000Z",
      cwd: "/srv/openclaw/main",
    };
    const userEntry = {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-05-27T00:00:01.000Z",
      message: { role: "user", content: "important question" },
    };
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-05-27T00:00:02.000Z",
      message: { role: "assistant", content: "important answer" },
    };
    const normalizedAssistantEntry = {
      ...assistantEntry,
      message: { role: "assistant", content: [{ type: "text", text: "important answer" }] },
    };
    const originalTranscript =
      [
        JSON.stringify(originalHeader).slice(0, 30),
        JSON.stringify(userEntry),
        JSON.stringify(assistantEntry),
      ].join("\n") + "\n";
    await fs.writeFile(sessionFile, originalTranscript, "utf8");
    if (process.platform !== "win32") {
      await fs.chmod(sessionFile, 0o600);
    }

    const sessionManager = SessionManager.open(sessionFile, dir, "/tmp/task-repo");

    expect(sessionManager.getEntries()).toEqual([userEntry, normalizedAssistantEntry]);
    expect(sessionManager.getChildren(userEntry.id)).toEqual([normalizedAssistantEntry]);
    expect(await fs.readFile(sessionFile, "utf8")).toContain("important question");
    expect(await fs.readFile(sessionFile, "utf8")).toContain("important answer");
    await expect(fs.readFile(sessionFile, "utf8")).resolves.not.toBe(originalTranscript);

    const backupFiles = (await fs.readdir(dir)).filter((file) => file.includes(".corrupt-"));
    expect(backupFiles).toHaveLength(1);
    // Keep an exact backup for audit/debugging before rewriting the live file.
    await expect(fs.readFile(path.join(dir, backupFiles[0] ?? ""), "utf8")).resolves.toBe(
      originalTranscript,
    );
    if (process.platform !== "win32") {
      const backupStat = await fs.stat(path.join(dir, backupFiles[0] ?? ""));
      expect(backupStat.mode & 0o777).toBe(0o600);
    }
  });

  it("does not duplicate the header after recovering a header-only corrupt file", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    await fs.writeFile(sessionFile, '{"type":"session","version":3,"id":"sess', "utf8");

    const sessionManager = SessionManager.open(sessionFile, dir, "/tmp/task-repo");
    sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      api: "messages",
      provider: "anthropic",
      model: "sonnet-4.6",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const entries = (await fs.readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });

    expect(entries.map((entry) => entry.type)).toEqual(["session", "message", "message"]);
    expect(entries.filter((entry) => entry.type === "session")).toHaveLength(1);
  });

  it("continues a valid recent session when the header exceeds the first read chunk", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "long-header-session.jsonl");
    const longCwd = `/tmp/${"deep/".repeat(120)}`;
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: "long-header-session",
      timestamp: "2026-06-18T00:00:00.000Z",
      cwd: longCwd,
    };
    const userEntry = {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-06-18T00:00:01.000Z",
      message: { role: "user", content: "resume me" },
    };
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(header)}\n${JSON.stringify(userEntry)}\n`,
      "utf8",
    );

    expect(Buffer.byteLength(JSON.stringify(header), "utf8")).toBeGreaterThan(512);
    expect(loadEntriesFromFile(sessionFile)).toHaveLength(2);
    expect(findMostRecentSession(dir)).toBe(sessionFile);
    expect(SessionManager.continueRecent(longCwd, dir).getSessionFile()).toBe(sessionFile);
  });

  it("does not continue a different cwd from a colliding session directory", async () => {
    const dir = await makeTempDir();
    const cwdA = "/home/alice/dev/client/app";
    const cwdB = "/home/alice/dev/client-app";
    const sessionA = path.join(dir, "session-a.jsonl");
    const sessionB = path.join(dir, "session-b.jsonl");
    const headerA = buildSessionHeader(cwdA, "session-a");
    const headerB = buildSessionHeader(cwdB, "session-b");

    await fs.writeFile(sessionA, `${JSON.stringify(headerA)}\n`, "utf8");
    await fs.writeFile(sessionB, `${JSON.stringify(headerB)}\n`, "utf8");
    await fs.utimes(
      sessionA,
      new Date("2026-06-18T00:00:00.000Z"),
      new Date("2026-06-18T00:00:00.000Z"),
    );
    await fs.utimes(
      sessionB,
      new Date("2026-06-18T00:00:01.000Z"),
      new Date("2026-06-18T00:00:01.000Z"),
    );

    expect(findMostRecentSession(dir)).toBe(sessionB);
    expect(findMostRecentSession(dir, cwdA)).toBe(sessionA);
    expect(SessionManager.continueRecent(cwdA, dir).getSessionFile()).toBe(sessionA);
    await expect(SessionManager.list(cwdA, dir)).resolves.toEqual([
      expect.objectContaining({ path: sessionA, cwd: cwdA }),
    ]);
  });

  it("skips oversized recent session headers instead of hiding valid sessions", async () => {
    const dir = await makeTempDir();
    const validSessionFile = path.join(dir, "valid-session.jsonl");
    const oversizedSessionFile = path.join(dir, "oversized-header-session.jsonl");
    const validHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: "valid-session",
      timestamp: "2026-06-18T00:00:00.000Z",
      cwd: "/tmp/task-repo",
    };
    const oversizedHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: "oversized-header-session",
      timestamp: "2026-06-18T00:00:01.000Z",
      cwd: `/tmp/${"deep/".repeat(14_000)}`,
    };

    await fs.writeFile(validSessionFile, `${JSON.stringify(validHeader)}\n`, "utf8");
    await fs.writeFile(oversizedSessionFile, `${JSON.stringify(oversizedHeader)}\n`, "utf8");
    await fs.utimes(
      validSessionFile,
      new Date("2026-06-18T00:00:00.000Z"),
      new Date("2026-06-18T00:00:00.000Z"),
    );
    await fs.utimes(
      oversizedSessionFile,
      new Date("2026-06-18T00:00:01.000Z"),
      new Date("2026-06-18T00:00:01.000Z"),
    );

    expect(Buffer.byteLength(JSON.stringify(oversizedHeader), "utf8")).toBeGreaterThan(64 * 1024);
    expect(findMostRecentSession(dir)).toBe(validSessionFile);
  });

  it("still migrates old transcript versions while bypassing the warm cache", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const legacyHeader = {
      type: "session",
      version: 2,
      id: "legacy-session",
      timestamp: "2026-06-04T00:00:00.000Z",
      cwd: dir,
    };
    const legacyEntry = {
      type: "message",
      id: "legacy-entry",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: {
        role: "hookMessage",
        content: "legacy hook content",
      },
    };
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(legacyHeader)}\n${JSON.stringify(legacyEntry)}\n`,
      "utf8",
    );

    const sessionManager = SessionManager.open(sessionFile, dir, dir);

    expect(sessionManager.getHeader()?.version).toBe(CURRENT_SESSION_VERSION);
    expect(sessionManager.getEntries()).toEqual([
      {
        ...legacyEntry,
        message: { ...legacyEntry.message, role: "custom" },
      },
    ]);
    const persistedEntries = (await fs.readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; version?: number; message?: unknown });
    expect(persistedEntries[0]).toMatchObject({
      type: "session",
      version: CURRENT_SESSION_VERSION,
    });
    expect(persistedEntries[1]).toMatchObject({
      type: "message",
      message: { role: "custom" },
    });
  });

  it("reuses current transcript entries across warm opens and appends without stale readback", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const firstEntry = buildMessageEntry(1, null);
    const secondMessage = buildAssistantMessage("message 2");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(firstEntry)}\n`,
      "utf8",
    );

    const originalParse = JSON.parse;
    let parseCount = 0;
    JSON.parse = function countedParse(...args: Parameters<typeof JSON.parse>) {
      parseCount += 1;
      return originalParse.apply(originalParse, args);
    } as typeof JSON.parse;

    try {
      expect(SessionManager.open(sessionFile, dir, dir).getEntries()).toEqual([firstEntry]);
      expect(parseCount).toBe(2);

      parseCount = 0;
      expect(SessionManager.open(sessionFile, dir, dir).getEntries()).toEqual([firstEntry]);
      expect(parseCount).toBe(0);

      const sessionManager = SessionManager.open(sessionFile, dir, dir);
      let trustedSnapshot = await readTrustedRepairSnapshot(sessionFile);
      let cacheAdvanceChecks = 0;
      let snapshotPublications = 0;
      await withOwnedSessionTranscriptWrites(
        {
          sessionFile,
          canAdvanceSessionEntryCache: (snapshot) => {
            cacheAdvanceChecks += 1;
            expect(snapshot).toEqual(trustedSnapshot);
            return true;
          },
          publishSessionFileSnapshot: (snapshot) => {
            snapshotPublications += 1;
            trustedSnapshot = snapshot;
            return true;
          },
          withSessionWriteLock: async (run) => await run(),
        },
        async () => {
          sessionManager.appendMessage(secondMessage);
          sessionManager.appendMessage(buildAssistantMessage("message 3"));
        },
      );
      expect(cacheAdvanceChecks).toBe(2);
      expect(snapshotPublications).toBe(2);
      const persistedEntries = (await fs.readFile(sessionFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => originalParse(line) as { type: string });
      expect(persistedEntries.map((entry) => entry.type)).toEqual([
        "session",
        "message",
        "message",
        "message",
      ]);

      parseCount = 0;
      const reopened = SessionManager.open(sessionFile, dir, dir);
      expect(reopened.getEntries().map((entry) => readMessageContent(entry))).toEqual([
        "message 1",
        "message 2",
        "message 3",
      ]);
      expect(parseCount).toBe(0);
    } finally {
      JSON.parse = originalParse;
    }
  });

  it("publishes owned snapshots when a safe append pushes the transcript over the cache limit", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "large-session.jsonl");
    const maxCachedSessionBytes = 32 * 1024 * 1024;
    const headerLine = JSON.stringify(buildSessionHeader(dir));
    const largeEntryBase = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: buildAssistantMessage(""),
    };
    const initialTranscriptWithContent = (content: string) =>
      `${headerLine}\n${JSON.stringify({
        ...largeEntryBase,
        message: buildAssistantMessage(content),
      })}\n`;
    let filler = "x".repeat(
      maxCachedSessionBytes - Buffer.byteLength(initialTranscriptWithContent(""), "utf8") - 16,
    );
    while (
      Buffer.byteLength(initialTranscriptWithContent(filler), "utf8") >
      maxCachedSessionBytes - 16
    ) {
      filler = filler.slice(0, -1024);
    }
    await fs.writeFile(sessionFile, initialTranscriptWithContent(filler), "utf8");

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    const publishSessionFileSnapshot = vi.fn(() => true);
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        canAdvanceSessionEntryCache: () => true,
        publishSessionFileSnapshot,
        withSessionWriteLock: async (run) => await run(),
      },
      async () => {
        sessionManager.appendMessage(buildAssistantMessage("small append"));
      },
    );

    expect(Buffer.byteLength(await fs.readFile(sessionFile, "utf8"), "utf8")).toBeGreaterThan(
      maxCachedSessionBytes,
    );
    expect(publishSessionFileSnapshot).toHaveBeenCalledTimes(1);
  });

  it("invalidates warm entries after an append outside the owned write context", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const firstEntry = buildMessageEntry(1, null);
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(firstEntry)}\n`,
      "utf8",
    );

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    sessionManager.appendMessage(buildAssistantMessage("message 2"));

    const originalParse = JSON.parse;
    let parseCount = 0;
    JSON.parse = function countedParse(...args: Parameters<typeof JSON.parse>) {
      parseCount += 1;
      return originalParse.apply(originalParse, args);
    } as typeof JSON.parse;

    try {
      expect(
        SessionManager.open(sessionFile, dir, dir)
          .getEntries()
          .map((entry) => readMessageContent(entry)),
      ).toEqual(["message 1", "message 2"]);
      expect(parseCount).toBeGreaterThanOrEqual(3);
    } finally {
      JSON.parse = originalParse;
    }
  });

  it("caches the persisted JSON shape for owned appends", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: buildAssistantMessage("message 1"),
    };
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(assistantEntry)}\n`,
      "utf8",
    );

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        canAdvanceSessionEntryCache: () => true,
        publishSessionFileSnapshot: () => true,
        withSessionWriteLock: async (run) => await run(),
      },
      async () => {
        sessionManager.appendCustomEntry("json-shape", {
          date: new Date("2026-06-15T00:00:00.000Z"),
          dropped: () => "not persisted",
          nan: Number.NaN,
        });
      },
    );

    const warmEntry = SessionManager.open(sessionFile, dir, dir)
      .getEntries()
      .find((entry) => entry.type === "custom");
    const freshEntry = loadEntriesFromFile(sessionFile).find((entry) => entry.type === "custom");
    expect(warmEntry).toEqual(freshEntry);
    expect(warmEntry).toMatchObject({
      data: {
        date: "2026-06-15T00:00:00.000Z",
        nan: null,
      },
    });
    expect((warmEntry as { data?: Record<string, unknown> }).data).not.toHaveProperty("dropped");
  });

  it("serializes owned appends once and caches those exact bytes", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: buildAssistantMessage("message 1"),
    };
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(assistantEntry)}\n`,
      "utf8",
    );

    let serializationCount = 0;
    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        canAdvanceSessionEntryCache: () => true,
        publishSessionFileSnapshot: () => true,
        withSessionWriteLock: async (run) => await run(),
      },
      async () => {
        sessionManager.appendCustomEntry("stateful-json", {
          value: {
            toJSON() {
              serializationCount += 1;
              return serializationCount === 1 ? "first" : "later";
            },
          },
        });
      },
    );

    const warmEntry = SessionManager.open(sessionFile, dir, dir)
      .getEntries()
      .find((entry) => entry.type === "custom");
    const freshEntry = loadEntriesFromFile(sessionFile).find((entry) => entry.type === "custom");
    expect(serializationCount).toBe(1);
    expect(warmEntry).toEqual(freshEntry);
    expect(warmEntry).toMatchObject({ data: { value: "first" } });
  });

  it("validates the transcript prefix after entries with custom serializers are serialized", async () => {
    const appenders: Array<{
      name: string;
      append: (manager: SessionManager, value: unknown) => void;
    }> = [
      {
        name: "custom",
        append: (manager, value) =>
          manager.appendCustomEntry("rewrite-during-serialization", {
            value,
          }),
      },
      {
        name: "custom_message",
        append: (manager, value) =>
          manager.appendCustomMessageEntry(
            "rewrite-during-serialization",
            "extension message",
            false,
            { value },
          ),
      },
      {
        name: "compaction",
        append: (manager, value) =>
          manager.appendCompaction("summary", "assistant-1", 1, { value }, true),
      },
      {
        name: "branch_summary",
        append: (manager, value) =>
          manager.branchWithSummary("assistant-1", "summary", { value }, true),
      },
      {
        name: "tool_result_details",
        append: (manager, value) =>
          manager.appendMessage({
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "test",
            content: [{ type: "text", text: "ok" }],
            details: { value },
            isError: false,
            timestamp: Date.now(),
          } as Parameters<SessionManager["appendMessage"]>[0]),
      },
    ];

    const serializerCases: Array<{
      name: string;
      createValue: (rewriteTranscript: () => void) => {
        value: unknown;
        cleanup?: () => void;
      };
    }> = [
      {
        name: "own_to_json",
        createValue: (rewriteTranscript) => ({
          value: {
            toJSON() {
              rewriteTranscript();
              return "persisted";
            },
          },
        }),
      },
      {
        name: "non_enumerable_array_index",
        createValue: (rewriteTranscript) => {
          const array = ["placeholder"];
          Object.defineProperty(array, "0", {
            configurable: true,
            enumerable: false,
            value: {
              toJSON() {
                rewriteTranscript();
                return "persisted";
              },
            },
          });
          return { value: array };
        },
      },
      {
        name: "bigint_to_json",
        createValue: (rewriteTranscript) => {
          const originalBigIntToJson = Object.getOwnPropertyDescriptor(BigInt.prototype, "toJSON");
          // eslint-disable-next-line no-extend-native -- JSON.stringify invokes BigInt.prototype.toJSON when present.
          Object.defineProperty(BigInt.prototype, "toJSON", {
            configurable: true,
            value() {
              rewriteTranscript();
              return "persisted";
            },
          });
          return {
            value: 1n,
            cleanup: () => {
              if (originalBigIntToJson) {
                // eslint-disable-next-line no-extend-native -- Restore the serializer installed for this case.
                Object.defineProperty(BigInt.prototype, "toJSON", originalBigIntToJson);
              } else {
                delete (BigInt.prototype as { toJSON?: unknown }).toJSON;
              }
            },
          };
        },
      },
    ];

    for (const { name, append } of appenders) {
      for (const serializerCase of serializerCases) {
        const dir = await makeTempDir();
        const sessionFile = path.join(dir, `${name}-${serializerCase.name}.jsonl`);
        const originalEntry = {
          type: "message",
          id: "assistant-1",
          parentId: null,
          timestamp: "2026-06-04T00:00:01.000Z",
          message: buildAssistantMessage("message 1"),
        };
        const replacementEntry = {
          ...originalEntry,
          message: buildAssistantMessage("changed 1"),
        };
        const headerLine = JSON.stringify(buildSessionHeader(dir));
        await fs.writeFile(
          sessionFile,
          `${headerLine}\n${JSON.stringify(originalEntry)}\n`,
          "utf8",
        );

        const sessionManager = SessionManager.open(sessionFile, dir, dir);
        let cacheAdvanceChecks = 0;
        const publishSessionFileSnapshot = vi.fn(() => true);
        const { value, cleanup } = serializerCase.createValue(() => {
          writeFileSync(
            sessionFile,
            `${headerLine}\n${JSON.stringify(replacementEntry)}\n`,
            "utf8",
          );
        });

        try {
          await withOwnedSessionTranscriptWrites(
            {
              sessionFile,
              canAdvanceSessionEntryCache: () => {
                cacheAdvanceChecks += 1;
                return true;
              },
              publishSessionFileSnapshot,
              withSessionWriteLock: async (run) => await run(),
            },
            async () => {
              append(sessionManager, value);
            },
          );
        } finally {
          cleanup?.();
        }

        expect(
          SessionManager.open(sessionFile, dir, dir)
            .getEntries()
            .filter((entry) => entry.type === "message")
            .map((entry) => readMessageContent(entry)),
        ).toEqual(name === "tool_result_details" ? ["changed 1", "ok"] : ["changed 1"]);
        expect(cacheAdvanceChecks, `${name}/${serializerCase.name}`).toBe(0);
        expect(publishSessionFileSnapshot, `${name}/${serializerCase.name}`).not.toHaveBeenCalled();
      }
    }
  });

  it("does not probe custom entry getters before serialization", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: buildAssistantMessage("message 1"),
    };
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(assistantEntry)}\n`,
      "utf8",
    );

    let accessCount = 0;
    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        canAdvanceSessionEntryCache: () => true,
        publishSessionFileSnapshot: () => true,
        withSessionWriteLock: async (run) => await run(),
      },
      async () => {
        sessionManager.appendCustomEntry("getter-data", {
          get cursor() {
            accessCount += 1;
            return `value ${accessCount}`;
          },
        });
      },
    );

    const freshEntry = loadEntriesFromFile(sessionFile).find((entry) => entry.type === "custom");
    expect(accessCount).toBe(1);
    expect(freshEntry).toMatchObject({ data: { cursor: "value 1" } });
  });

  it("invalidates custom function serializers before advancing the cache", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: buildAssistantMessage("message 1"),
    };
    const replacementEntry = {
      ...assistantEntry,
      message: buildAssistantMessage("changed 1"),
    };
    const headerLine = JSON.stringify(buildSessionHeader(dir));
    await fs.writeFile(sessionFile, `${headerLine}\n${JSON.stringify(assistantEntry)}\n`, "utf8");

    const serializer = Object.assign(function serialize() {}, {
      toJSON() {
        writeFileSync(sessionFile, `${headerLine}\n${JSON.stringify(replacementEntry)}\n`, "utf8");
        return "persisted";
      },
    });

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        canAdvanceSessionEntryCache: () => true,
        publishSessionFileSnapshot: () => true,
        withSessionWriteLock: async (run) => await run(),
      },
      async () => {
        sessionManager.appendCustomEntry("function-serializer", { value: serializer });
      },
    );

    const reopenedPrefix = SessionManager.open(sessionFile, dir, dir)
      .getEntries()
      .find((entry) => entry.id === "assistant-1");
    expect(reopenedPrefix ? readMessageContent(reopenedPrefix) : undefined).toBe("changed 1");
  });

  it("validates custom message detail hooks before advancing the cache", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: buildAssistantMessage("message 1"),
    };
    const replacementEntry = {
      ...assistantEntry,
      message: buildAssistantMessage("changed 1"),
    };
    const headerLine = JSON.stringify(buildSessionHeader(dir));
    await fs.writeFile(sessionFile, `${headerLine}\n${JSON.stringify(assistantEntry)}\n`, "utf8");

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        canAdvanceSessionEntryCache: () => true,
        publishSessionFileSnapshot: () => true,
        withSessionWriteLock: async (run) => await run(),
      },
      async () => {
        sessionManager.appendCustomMessageEntry("details-hook", "visible", false, {
          value: {
            toJSON() {
              writeFileSync(
                sessionFile,
                `${headerLine}\n${JSON.stringify(replacementEntry)}\n`,
                "utf8",
              );
              return "persisted";
            },
          },
        });
      },
    );

    expect(
      SessionManager.open(sessionFile, dir, dir)
        .getEntries()
        .filter((entry) => entry.type === "message")
        .map((entry) => readMessageContent(entry)),
    ).toEqual(["changed 1"]);
  });

  it("detects tool-result detail hooks before advancing the cache", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: buildAssistantMessage("message 1"),
    };
    const replacementEntry = {
      ...assistantEntry,
      message: buildAssistantMessage("changed 1"),
    };
    const headerLine = JSON.stringify(buildSessionHeader(dir));
    await fs.writeFile(sessionFile, `${headerLine}\n${JSON.stringify(assistantEntry)}\n`, "utf8");

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        canAdvanceSessionEntryCache: () => true,
        publishSessionFileSnapshot: () => true,
        withSessionWriteLock: async (run) => await run(),
      },
      async () => {
        sessionManager.appendMessage({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "custom",
          content: [{ type: "text", text: "unused" }],
          details: {
            value: {
              toJSON() {
                writeFileSync(
                  sessionFile,
                  `${headerLine}\n${JSON.stringify(replacementEntry)}\n`,
                  "utf8",
                );
                return "persisted";
              },
            },
          },
          isError: false,
          timestamp: Date.now(),
        });
      },
    );

    const reopenedPrefix = SessionManager.open(sessionFile, dir, dir)
      .getEntries()
      .find((entry) => entry.id === "assistant-1");
    expect(reopenedPrefix ? readMessageContent(reopenedPrefix) : undefined).toBe("changed 1");
  });

  it("does not warm-cache tool-result detail appends", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: buildAssistantMessage("message 1"),
    };
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(assistantEntry)}\n`,
      "utf8",
    );

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        canAdvanceSessionEntryCache: () => true,
        publishSessionFileSnapshot: () => true,
        withSessionWriteLock: async (run) => await run(),
      },
      async () => {
        sessionManager.appendMessage({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "custom",
          content: [{ type: "text", text: "unused" }],
          details: { source: "extension" },
          isError: false,
          timestamp: Date.now(),
        });
      },
    );

    const originalParse = JSON.parse;
    let parseCount = 0;
    JSON.parse = function countedParse(...args: Parameters<typeof JSON.parse>) {
      parseCount += 1;
      return originalParse.apply(originalParse, args);
    } as typeof JSON.parse;

    try {
      expect(SessionManager.open(sessionFile, dir, dir).getEntries()).toHaveLength(2);
      expect(parseCount).toBeGreaterThan(0);
    } finally {
      JSON.parse = originalParse;
    }
  });

  it("detects assistant tool-call hook writes before advancing the cache", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: buildAssistantMessage("message 1"),
    };
    const replacementEntry = {
      ...assistantEntry,
      message: buildAssistantMessage("changed 1"),
    };
    const headerLine = JSON.stringify(buildSessionHeader(dir));
    await fs.writeFile(sessionFile, `${headerLine}\n${JSON.stringify(assistantEntry)}\n`, "utf8");

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        canAdvanceSessionEntryCache: () => true,
        publishSessionFileSnapshot: () => true,
        withSessionWriteLock: async (run) => await run(),
      },
      async () => {
        sessionManager.appendMessage({
          ...buildAssistantMessage("unused"),
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "custom",
              arguments: {
                value: {
                  toJSON() {
                    writeFileSync(
                      sessionFile,
                      `${headerLine}\n${JSON.stringify(replacementEntry)}\n`,
                      "utf8",
                    );
                    return "persisted";
                  },
                },
              },
            },
          ],
          stopReason: "toolUse",
        });
      },
    );

    const reopenedPrefix = SessionManager.open(sessionFile, dir, dir)
      .getEntries()
      .find((entry) => entry.id === "assistant-1");
    expect(reopenedPrefix ? readMessageContent(reopenedPrefix) : undefined).toBe("changed 1");
  });

  it("invalidates incremental repair when append ownership cannot be proven", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: buildAssistantMessage("message 1"),
    };
    const headerLine = JSON.stringify(buildSessionHeader(dir));
    const assistantLine = JSON.stringify(assistantEntry);
    await fs.writeFile(sessionFile, `${headerLine}\n${assistantLine}\n`, "utf8");
    await repairSessionFileIfNeeded({
      sessionFile,
      trustedSnapshot: await readTrustedRepairSnapshot(sessionFile),
    });

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        canAdvanceSessionEntryCache: () => false,
        publishSessionFileSnapshot: () => true,
        withSessionWriteLock: async (run) => await run(),
      },
      async () => {
        sessionManager.appendCustomEntry("corrupt-prefix-during-serialization", {
          value: {
            toJSON() {
              writeFileSync(sessionFile, `${headerLine}\n!${assistantLine.slice(1)}\n`, "utf8");
              return "persisted";
            },
          },
        });
      },
    );

    await repairSessionFileIfNeeded({
      sessionFile,
      trustedSnapshot: await readTrustedRepairSnapshot(sessionFile),
    });
    const repairedEntries = (await fs.readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(repairedEntries.map((entry) => entry.type)).toEqual(["session", "custom"]);
  });

  it("separates an owned append from an unterminated transcript entry", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const firstEntry = buildMessageEntry(1, null);
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(firstEntry)}`,
      "utf8",
    );

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        canAdvanceSessionEntryCache: () => true,
        publishSessionFileSnapshot: () => true,
        withSessionWriteLock: async (run) => await run(),
      },
      async () => {
        sessionManager.appendMessage(buildAssistantMessage("message 2"));
      },
    );

    const content = await fs.readFile(sessionFile, "utf8");
    expect(content.endsWith("\n")).toBe(true);
    expect(content.trimEnd().split("\n")).toHaveLength(3);
    expect(
      loadEntriesFromFile(sessionFile)
        .filter((entry) => entry.type === "message")
        .map((entry) => readMessageContent(entry)),
    ).toEqual(["message 1", "message 2"]);
  });

  it("caches the persisted JSON shape after a deferred full write", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    let serializationCount = 0;
    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    sessionManager.appendCustomEntry("json-shape", {
      kept: "value",
      dropped: () => "not persisted",
      stateful: {
        toJSON() {
          serializationCount += 1;
          return serializationCount === 1 ? "first" : "later";
        },
      },
    });

    expect(() => {
      sessionManager.appendMessage(buildAssistantMessage("first assistant"));
    }).not.toThrow();

    const warmEntry = SessionManager.open(sessionFile, dir, dir)
      .getEntries()
      .find((entry) => entry.type === "custom");
    expect(serializationCount).toBe(1);
    expect(warmEntry).toMatchObject({ data: { kept: "value", stateful: "first" } });
    expect((warmEntry as { data?: Record<string, unknown> }).data).not.toHaveProperty("dropped");
  });

  it("keeps the exported file loader mutable and separate from warm SessionManager entries", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const firstEntry = buildMessageEntry(1, null);
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(firstEntry)}\n`,
      "utf8",
    );

    const loaded = loadEntriesFromFile(sessionFile);
    const messageEntry = loaded[1];
    if (!messageEntry || messageEntry.type !== "message") {
      throw new Error("expected message entry");
    }
    (messageEntry.message as { content: unknown }).content = "caller-owned mutation";

    expect(readMessageContent(messageEntry)).toBe("caller-owned mutation");
    expect(
      SessionManager.open(sessionFile, dir, dir)
        .getEntries()
        .map((entry) => readMessageContent(entry)),
    ).toEqual(["message 1"]);
  });

  it("invalidates the transcript entry cache when the file is externally replaced", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const firstEntry = buildMessageEntry(1, null);
    const replacementEntry = buildMessageEntry(2, null);
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(firstEntry)}\n`,
      "utf8",
    );

    expect(SessionManager.open(sessionFile, dir, dir).getEntries()).toEqual([firstEntry]);
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir, "replacement-session"))}\n${JSON.stringify(
        replacementEntry,
      )}\n`,
      "utf8",
    );

    const originalParse = JSON.parse;
    let parseCount = 0;
    JSON.parse = function countedParse(...args: Parameters<typeof JSON.parse>) {
      parseCount += 1;
      return originalParse.apply(originalParse, args);
    } as typeof JSON.parse;

    try {
      const reopened = SessionManager.open(sessionFile, dir, dir);
      expect(reopened.getSessionId()).toBe("replacement-session");
      expect(reopened.getEntries()).toEqual([replacementEntry]);
      expect(parseCount).toBeGreaterThanOrEqual(2);
    } finally {
      JSON.parse = originalParse;
    }
  });

  it("revalidates a transcript changed while the initial load is parsing", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const firstEntry = buildMessageEntry(1, null);
    const replacementEntry = buildMessageEntry(2, null);
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(firstEntry)}\n`,
      "utf8",
    );
    const replacementContent =
      `${JSON.stringify(buildSessionHeader(dir, "intermediate-session"))}\n` +
      `${JSON.stringify(replacementEntry)}\n`;
    const finalEntry = buildMessageEntry(3, null);
    const finalContent =
      `${JSON.stringify(buildSessionHeader(dir, "replacement-session"))}\n` +
      `${JSON.stringify(finalEntry)}\n`;

    const originalParse = JSON.parse;
    let replacementCount = 0;
    JSON.parse = function replaceDuringParse(...args: Parameters<typeof JSON.parse>) {
      const parsed = originalParse.apply(originalParse, args);
      if (replacementCount === 0) {
        replacementCount += 1;
        writeFileSync(sessionFile, replacementContent, "utf8");
      } else if (replacementCount === 1 && args[0].includes("intermediate-session")) {
        replacementCount += 1;
        writeFileSync(sessionFile, finalContent, "utf8");
      }
      return parsed;
    } as typeof JSON.parse;

    try {
      const reopened = SessionManager.open(sessionFile, dir, dir);
      expect(reopened.getSessionId()).toBe("replacement-session");
      expect(reopened.getEntries()).toEqual([finalEntry]);
    } finally {
      JSON.parse = originalParse;
    }
  });

  it("does not cache manager entries over a same-length external replacement", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const firstEntry = buildMessageEntry(1, null);
    const replacementEntry = {
      ...buildMessageEntry(2, null),
      id: firstEntry.id,
    };
    const header = buildSessionHeader(dir);
    const originalContent = `${JSON.stringify(header)}\n${JSON.stringify(firstEntry)}\n`;
    const replacementContent = `${JSON.stringify(header)}\n${JSON.stringify(replacementEntry)}\n`;
    expect(Buffer.byteLength(replacementContent)).toBe(Buffer.byteLength(originalContent));
    await fs.writeFile(sessionFile, originalContent, "utf8");

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await fs.writeFile(sessionFile, replacementContent, "utf8");
    sessionManager.syncSnapshotAfterHeaderRewrite();

    expect(
      SessionManager.open(sessionFile, dir, dir)
        .getEntries()
        .map((entry) => readMessageContent(entry)),
    ).toEqual(["message 2"]);
  });

  it("does not publish a header rewrite snapshot when the expected bytes do not match", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const header = buildSessionHeader(dir);
    const originalContent = `${JSON.stringify(header)}\n${JSON.stringify(buildMessageEntry(1, null))}\n`;
    const replacementContent = `${JSON.stringify(header)}\n${JSON.stringify(
      buildMessageEntry(2, null),
    )}\n`;
    await fs.writeFile(sessionFile, originalContent, "utf8");

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    const publishSessionFileSnapshot = vi.fn(() => true);
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        publishSessionFileSnapshot,
        withSessionWriteLock: async (run) => await run(),
      },
      async () => {
        await fs.writeFile(sessionFile, replacementContent, "utf8");
        sessionManager.syncSnapshotAfterHeaderRewrite(originalContent);
      },
    );

    expect(publishSessionFileSnapshot).not.toHaveBeenCalled();
    expect(
      SessionManager.open(sessionFile, dir, dir)
        .getEntries()
        .map((entry) => readMessageContent(entry)),
    ).toEqual(["message 2"]);
  });

  it("does not persist caller-side entry mutations into warm cache hits", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const firstEntry = buildMessageEntry(1, null);
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(firstEntry)}\n`,
      "utf8",
    );

    const opened = SessionManager.open(sessionFile, dir, dir);
    const returnedEntry = opened.getEntries()[0];
    if (!returnedEntry || returnedEntry.type !== "message") {
      throw new Error("expected message entry");
    }
    expect(() => {
      (returnedEntry.message as { content: unknown }).content = "mutated only in caller";
    }).toThrow(TypeError);

    const originalParse = JSON.parse;
    let parseCount = 0;
    JSON.parse = function countedParse(...args: Parameters<typeof JSON.parse>) {
      parseCount += 1;
      return originalParse.apply(originalParse, args);
    } as typeof JSON.parse;

    try {
      const reopened = SessionManager.open(sessionFile, dir, dir);
      expect(reopened.getEntries().map((entry) => readMessageContent(entry))).toEqual([
        "message 1",
      ]);
      expect(parseCount).toBe(0);
    } finally {
      JSON.parse = originalParse;
    }
  });

  it("keeps current-version entries immutable when the transcript exceeds the cache limit", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const hugeEntry = buildMessageEntry(1, null);
    if (hugeEntry.type !== "message") {
      throw new Error("expected message entry fixture");
    }
    (hugeEntry.message as { content: string }).content = "x".repeat(33 * 1024 * 1024);
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(hugeEntry)}\n`,
      "utf8",
    );

    const opened = SessionManager.open(sessionFile, dir, dir);
    const returnedEntry = opened.getEntries()[0];
    if (!returnedEntry || returnedEntry.type !== "message") {
      throw new Error("expected message entry");
    }

    expect(() => {
      (returnedEntry.message as { content: unknown }).content = "mutated";
    }).toThrow(TypeError);
  });

  it("invalidates the warm cache when another writer appends before this manager persists", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const firstEntry = buildMessageEntry(1, null);
    const externalEntry = buildMessageEntry(2, firstEntry.id);
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(firstEntry)}\n`,
      "utf8",
    );

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await fs.appendFile(sessionFile, `${JSON.stringify(externalEntry)}\n`, "utf8");
    sessionManager.appendMessage(buildAssistantMessage("message 3"));

    const originalParse = JSON.parse;
    let parseCount = 0;
    JSON.parse = function countedParse(...args: Parameters<typeof JSON.parse>) {
      parseCount += 1;
      return originalParse.apply(originalParse, args);
    } as typeof JSON.parse;

    try {
      const reopened = SessionManager.open(sessionFile, dir, dir);
      expect(reopened.getEntries().map((entry) => readMessageContent(entry))).toEqual([
        "message 1",
        "message 2",
        "message 3",
      ]);
      expect(parseCount).toBeGreaterThanOrEqual(4);
    } finally {
      JSON.parse = originalParse;
    }
  });

  it("lets prepareSessionManagerForRun normalize a warm-cached header without re-parsing", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: { role: "assistant", content: "carried context" },
    };
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir, "original-session"))}\n${JSON.stringify(
        assistantEntry,
      )}\n`,
      "utf8",
    );

    // Warm the process-level entry cache.
    expect(SessionManager.open(sessionFile, dir, dir).getSessionId()).toBe("original-session");

    const originalParse = JSON.parse;
    let parseCount = 0;
    JSON.parse = function countedParse(...args: Parameters<typeof JSON.parse>) {
      parseCount += 1;
      return originalParse.apply(originalParse, args);
    } as typeof JSON.parse;

    try {
      // Two warm hits off the same cache entry: must not re-parse the transcript.
      const sessionManager = SessionManager.open(sessionFile, dir, dir);
      const sibling = SessionManager.open(sessionFile, dir, dir);
      expect(parseCount).toBe(0);

      // The embedded runner normalizes the loaded header in place. With a shared
      // frozen cache entry this threw "Cannot assign to read only property".
      await expect(
        prepareSessionManagerForRun({
          sessionManager,
          sessionFile,
          hadSessionFile: true,
          sessionId: "run-session",
          cwd: "/tmp/task-repo",
        }),
      ).resolves.toBeUndefined();

      expect(sessionManager.getSessionId()).toBe("run-session");
      expect(sessionManager.getHeader()).toEqual(
        expect.objectContaining({ type: "session", id: "run-session", cwd: "/tmp/task-repo" }),
      );
      expect(sessionManager.getCwd()).toBe("/tmp/task-repo");

      // Each warm hit gets an independent mutable header clone, so normalizing
      // one manager's header must not bleed into the cached snapshot shared with
      // the sibling manager.
      expect(sibling.getHeader()).toEqual(
        expect.objectContaining({ type: "session", id: "original-session", cwd: dir }),
      );

      // The warm hits stayed parse-free. The required header rewrite parses
      // its two persisted lines once so the cache matches JSON round-tripping.
      expect(parseCount).toBe(2);
    } finally {
      JSON.parse = originalParse;
    }
  });

  it("preserves opaque transcript rows during embedded header normalization", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const metadata = { type: "metadata", payload: { source: "plugin" } };
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: { role: "assistant", content: "carried context" },
    };
    const normalizedAssistantEntry = {
      ...assistantEntry,
      message: { role: "assistant", content: [{ type: "text", text: "carried context" }] },
    };
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify(buildSessionHeader(dir, "original-session")),
        JSON.stringify(metadata),
        JSON.stringify(assistantEntry),
      ].join("\n") + "\n",
      "utf8",
    );

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await prepareSessionManagerForRun({
      sessionManager,
      sessionFile,
      hadSessionFile: true,
      sessionId: "run-session",
      cwd: "/tmp/task-repo",
    });

    const records = (await fs.readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(records).toContainEqual(metadata);
    expect(sessionManager.getEntries()).toEqual([normalizedAssistantEntry]);
  });

  it("bridges parent-linked opaque rows without exposing them as session entries", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const userEntry = {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: { role: "user", content: "question" },
    };
    const metadata = {
      type: "metadata",
      id: "metadata-1",
      parentId: userEntry.id,
      payload: { source: "plugin" },
    };
    await fs.writeFile(
      sessionFile,
      [buildSessionHeader(dir, "session-1"), userEntry, metadata]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf8",
    );

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    expect(sessionManager.getLeafEntry()).toEqual(userEntry);
    const assistantId = sessionManager.appendMessage(buildAssistantMessage("answer"));
    const assistantEntry = sessionManager.getEntry(assistantId);

    expect(assistantEntry).toEqual(expect.objectContaining({ parentId: userEntry.id }));
    const persistedAssistant = (await fs.readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id?: string; parentId?: string | null })
      .find((entry) => entry.id === assistantId);
    expect(persistedAssistant).toEqual(expect.objectContaining({ parentId: metadata.id }));
    expect(sessionManager.getEntries()).toEqual([userEntry, assistantEntry]);
    expect(sessionManager.getBranch()).toEqual([
      userEntry,
      expect.objectContaining({ id: assistantId, parentId: userEntry.id }),
    ]);
    expect(sessionManager.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "question" },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ]);

    sessionManager.branch(metadata.id);
    expect(sessionManager.getLeafId()).toBe(userEntry.id);
    sessionManager.branch(assistantId);
    const branchedFile = sessionManager.createBranchedSession(assistantId);
    expect(branchedFile).toBeDefined();
    const branchedRecords = (await fs.readFile(branchedFile!, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id?: string; parentId?: string | null });
    expect(branchedRecords).toContainEqual(metadata);
    expect(branchedRecords.find((record) => record.id === assistantId)?.parentId).toBe(metadata.id);
    expect(
      SessionManager.open(branchedFile!, dir, dir).buildSessionContext().messages,
    ).toMatchObject([
      { role: "user", content: "question" },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ]);
  });

  it("repairs compaction boundaries that point through opaque rows", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const userEntry = {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: { role: "user", content: "question" },
    };
    const metadata = {
      type: "metadata",
      id: "metadata-1",
      parentId: userEntry.id,
      payload: { source: "plugin" },
    };
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: metadata.id,
      timestamp: "2026-06-04T00:00:02.000Z",
      message: buildAssistantMessage("answer"),
    };
    const compactionEntry = {
      type: "compaction",
      id: "compaction-1",
      parentId: assistantEntry.id,
      timestamp: "2026-06-04T00:00:03.000Z",
      summary: "summary",
      firstKeptEntryId: metadata.id,
      tokensBefore: 200,
    };
    await fs.writeFile(
      sessionFile,
      [buildSessionHeader(dir, "session-1"), userEntry, metadata, assistantEntry, compactionEntry]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf8",
    );

    const sessionManager = SessionManager.open(sessionFile, dir, dir);

    expect(sessionManager.getEntry(compactionEntry.id)).toEqual(
      expect.objectContaining({ firstKeptEntryId: userEntry.id }),
    );
    expect(sessionManager.buildSessionContext().messages).toMatchObject([
      { role: "compactionSummary", summary: "summary" },
      { role: "user", content: "question" },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ]);
  });

  it("repairs opaque compaction boundaries on the active branch", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const opaqueRoot = { type: "metadata", id: "opaque-root", parentId: null };
    const branchAUser = {
      type: "message",
      id: "branch-a-user",
      parentId: opaqueRoot.id,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: { role: "user", content: "branch a" },
    };
    const branchBUser = {
      type: "message",
      id: "branch-b-user",
      parentId: opaqueRoot.id,
      timestamp: "2026-06-04T00:00:02.000Z",
      message: { role: "user", content: "branch b" },
    };
    const branchBAssistant = {
      type: "message",
      id: "branch-b-assistant",
      parentId: branchBUser.id,
      timestamp: "2026-06-04T00:00:03.000Z",
      message: buildAssistantMessage("branch b answer"),
    };
    const compactionEntry = {
      type: "compaction",
      id: "compaction-1",
      parentId: branchBAssistant.id,
      timestamp: "2026-06-04T00:00:04.000Z",
      summary: "summary",
      firstKeptEntryId: opaqueRoot.id,
      tokensBefore: 200,
    };
    await fs.writeFile(
      sessionFile,
      [
        buildSessionHeader(dir, "session-1"),
        opaqueRoot,
        branchAUser,
        branchBUser,
        branchBAssistant,
        compactionEntry,
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf8",
    );

    const sessionManager = SessionManager.open(sessionFile, dir, dir);

    expect(sessionManager.getEntry(compactionEntry.id)).toEqual(
      expect.objectContaining({ firstKeptEntryId: branchBUser.id }),
    );
    expect(sessionManager.buildSessionContext().messages).toMatchObject([
      { role: "compactionSummary", summary: "summary" },
      { role: "user", content: "branch b" },
      { role: "assistant", content: [{ type: "text", text: "branch b answer" }] },
    ]);
  });

  it("does not use session events as append parents", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const userEntry = {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: { role: "user", content: "question" },
    };
    const sessionEvent = {
      type: "session",
      id: "event-1",
      parentId: userEntry.id,
      sessionId: "external-session-event",
    };
    await fs.writeFile(
      sessionFile,
      [buildSessionHeader(dir, "session-1"), userEntry, sessionEvent]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf8",
    );

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    const assistantId = sessionManager.appendMessage(buildAssistantMessage("answer"));

    expect(sessionManager.getEntry(assistantId)).toEqual(
      expect.objectContaining({ parentId: userEntry.id }),
    );
    expect(sessionManager.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "question" },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ]);
  });

  it("repairs descendants linked through persisted leaf records", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const rootEntry = {
      type: "message",
      id: "root-user",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: { role: "user", content: "root question" },
    };
    const abandonedEntry = {
      type: "message",
      id: "abandoned-assistant",
      parentId: rootEntry.id,
      timestamp: "2026-06-04T00:00:02.000Z",
      message: buildAssistantMessage("abandoned answer"),
    };
    const leafEntry = {
      type: "leaf",
      id: "leaf-1",
      parentId: abandonedEntry.id,
      timestamp: "2026-06-04T00:00:03.000Z",
      targetId: rootEntry.id,
    };
    const replacementEntry = {
      type: "message",
      id: "replacement-assistant",
      parentId: leafEntry.id,
      timestamp: "2026-06-04T00:00:04.000Z",
      message: buildAssistantMessage("replacement answer"),
    };
    await fs.writeFile(
      sessionFile,
      [buildSessionHeader(dir, "session-1"), rootEntry, abandonedEntry, leafEntry, replacementEntry]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf8",
    );

    const reopened = SessionManager.open(sessionFile, dir, dir);
    expect(reopened.getEntry(replacementEntry.id)).toEqual(
      expect.objectContaining({ parentId: rootEntry.id }),
    );
    expect(reopened.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "root question" },
      { role: "assistant", content: [{ type: "text", text: "replacement answer" }] },
    ]);
  });

  it("preserves trailing opaque rows when cleanup removes the preceding entry", async () => {
    const dir = await makeTempDir();
    const sessionManager = SessionManager.create(dir, dir);
    sessionManager.appendMessage({ role: "user", content: "question", timestamp: 1 });
    const baseAnswerId = sessionManager.appendMessage(buildAssistantMessage("base answer"));
    const temporaryErrorId = sessionManager.appendMessage(buildAssistantMessage("temporary error"));
    const opaqueMetadata = { type: "metadata", payload: { source: "plugin" } };
    const globalMetadata = {
      type: "custom" as const,
      id: "plugin-state",
      parentId: temporaryErrorId,
      timestamp: "2026-06-04T00:00:04.000Z",
      customType: "plugin-state",
      data: { source: "plugin" },
    };
    const deliveryEntry = {
      type: "message" as const,
      id: "delivery-mirror",
      parentId: globalMetadata.id,
      timestamp: "2026-06-04T00:00:05.000Z",
      message: {
        ...buildAssistantMessage("mirrored delivery"),
        provider: "openclaw",
        model: "delivery-mirror",
      },
    };
    sessionManager.mergePromptReleasedSessionEntries([
      { type: "prompt_released_opaque", record: opaqueMetadata },
      globalMetadata,
      deliveryEntry,
    ]);

    expect(
      sessionManager.removeTrailingEntries((entry) => entry.id === temporaryErrorId, {
        preserveTrailing: (entry) =>
          entry.type === "custom" ||
          entry.type === "label" ||
          entry.type === "session_info" ||
          (entry.type === "message" && isTranscriptOnlyOpenClawAssistantMessage(entry.message)),
      }),
    ).toBe(1);
    expect(sessionManager.getLeafId()).toBe(baseAnswerId);
    const replacementId = sessionManager.appendMessage(buildAssistantMessage("replacement answer"));

    const sessionFile = sessionManager.getSessionFile();
    expect(sessionFile).toBeDefined();
    const records = (await fs.readFile(sessionFile!, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const metadataIndex = records.findIndex(
      (record) => JSON.stringify(record) === JSON.stringify(opaqueMetadata),
    );
    const globalMetadataIndex = records.findIndex((record) => record.id === globalMetadata.id);
    const deliveryIndex = records.findIndex((record) => record.id === deliveryEntry.id);
    const replacementIndex = records.findIndex((record) => record.id === replacementId);
    expect(metadataIndex).toBeGreaterThan(-1);
    expect(globalMetadataIndex).toBeGreaterThan(metadataIndex);
    expect(deliveryIndex).toBeGreaterThan(globalMetadataIndex);
    expect(replacementIndex).toBeGreaterThan(deliveryIndex);
    expect(records[globalMetadataIndex]?.parentId).toBe(baseAnswerId);
    expect(records[deliveryIndex]?.parentId).toBe(globalMetadata.id);
    expect(SessionManager.open(sessionFile!, dir, dir).buildSessionContext().messages).toHaveLength(
      3,
    );
  });

  it("keeps merged messages downstream of parent-linked opaque events", async () => {
    const dir = await makeTempDir();
    const sessionManager = SessionManager.create(dir, dir);
    sessionManager.appendMessage({ role: "user", content: "question", timestamp: 1 });
    const baseAnswerId = sessionManager.appendMessage(buildAssistantMessage("base answer"));
    const metadata = {
      type: "metadata",
      id: "plugin-metadata",
      parentId: baseAnswerId,
      payload: { source: "plugin" },
    };
    const deliveryEntry = {
      type: "message" as const,
      id: "plugin-delivery",
      parentId: baseAnswerId,
      timestamp: "2026-06-04T00:00:03.000Z",
      message: buildAssistantMessage("plugin delivery"),
    };

    sessionManager.mergePromptReleasedSessionEntries([
      { type: "prompt_released_opaque", record: metadata },
    ]);
    sessionManager.mergePromptReleasedSessionEntries([deliveryEntry]);
    (
      sessionManager as unknown as {
        replacePersistedTranscript: () => void;
      }
    ).replacePersistedTranscript();

    const sessionFile = sessionManager.getSessionFile();
    expect(sessionFile).toBeDefined();
    const records = (await fs.readFile(sessionFile!, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type?: string;
            id?: string;
            parentId?: string | null;
            targetId?: string | null;
          },
      );
    expect(records.find((record) => record.id === deliveryEntry.id)?.parentId).toBe(metadata.id);
    expect(records.at(-1)).toMatchObject({ type: "leaf", targetId: baseAnswerId });

    const reopened = SessionManager.open(sessionFile!, dir, dir);
    expect(reopened.getLeafId()).toBe(baseAnswerId);
    expect(JSON.stringify(reopened.buildSessionContext())).not.toContain("plugin delivery");
    expect(reopened.getBranch(deliveryEntry.id).map((entry) => entry.id)).toEqual([
      expect.any(String),
      baseAnswerId,
      deliveryEntry.id,
    ]);
    const branchedFile = reopened.createBranchedSession(deliveryEntry.id);
    expect(branchedFile).toBeDefined();
    const branchedRecords = (await fs.readFile(branchedFile!, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id?: string; parentId?: string | null });
    expect(branchedRecords).toContainEqual(metadata);
    expect(branchedRecords.find((record) => record.id === deliveryEntry.id)?.parentId).toBe(
      metadata.id,
    );
  });

  it("persists the active leaf immediately after merging prompt-released side rows", async () => {
    const dir = await makeTempDir();
    const sessionManager = SessionManager.create(dir, dir);
    sessionManager.appendMessage({ role: "user", content: "question", timestamp: 1 });
    const baseAnswerId = sessionManager.appendMessage(buildAssistantMessage("base answer"));
    const sideEntry = {
      type: "message" as const,
      id: "side-delivery",
      parentId: baseAnswerId,
      timestamp: "2026-06-15T00:00:03.000Z",
      message: buildAssistantMessage("side delivery"),
    };
    const sessionFile = sessionManager.getSessionFile();
    expect(sessionFile).toBeDefined();
    await fs.appendFile(sessionFile!, `${JSON.stringify(sideEntry)}\n`, "utf8");

    const mergeResult = sessionManager.mergePromptReleasedSessionEntries([sideEntry], {
      persistLeaf: true,
    });

    expect(mergeResult?.publishedEntries).toEqual([{ kind: "id", id: expect.any(String) }]);
    const records = (await fs.readFile(sessionFile!, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type?: string;
            id?: string;
            parentId?: string | null;
            targetId?: string | null;
            appendParentId?: string | null;
            appendMode?: string;
          },
      );
    expect(records.at(-1)).toMatchObject({
      type: "leaf",
      parentId: sideEntry.id,
      targetId: baseAnswerId,
      appendParentId: sideEntry.id,
      appendMode: "side",
    });

    const nextSideEntry = {
      ...sideEntry,
      id: "next-side-delivery",
      parentId: records.at(-1)?.appendParentId ?? records.at(-1)?.targetId ?? null,
      appendMode: "side" as const,
      timestamp: "2026-06-15T00:00:04.000Z",
      message: buildAssistantMessage("next side delivery"),
    };
    const reopenedForNextMerge = SessionManager.open(sessionFile!, dir, dir);
    await fs.appendFile(sessionFile!, `${JSON.stringify(nextSideEntry)}\n`, "utf8");
    reopenedForNextMerge.mergePromptReleasedSessionEntries([nextSideEntry], {
      persistLeaf: true,
    });

    const finalRecords = (await fs.readFile(sessionFile!, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type?: string;
            id?: string;
            parentId?: string | null;
            targetId?: string | null;
            appendParentId?: string | null;
            appendMode?: string;
          },
      );
    expect(finalRecords.find((record) => record.id === nextSideEntry.id)?.parentId).toBe(
      sideEntry.id,
    );
    expect(finalRecords.at(-1)).toMatchObject({
      type: "message",
      id: nextSideEntry.id,
      parentId: sideEntry.id,
      appendMode: "side",
    });

    const reopened = SessionManager.open(sessionFile!, dir, dir);
    expect(reopened.getLeafId()).toBe(baseAnswerId);
    expect(JSON.stringify(reopened.buildSessionContext())).not.toContain("side delivery");
    expect(
      reopened
        .getBranch(nextSideEntry.id)
        .map((entry) => entry.id)
        .slice(-2),
    ).toEqual([sideEntry.id, nextSideEntry.id]);

    const nextUserId = reopened.appendMessage({
      role: "user",
      content: "next question",
      timestamp: 3,
    });
    expect(
      reopened
        .getBranch(nextUserId)
        .map((entry) => entry.id)
        .slice(-2),
    ).toEqual([baseAnswerId, nextUserId]);
    expect(JSON.stringify(reopened.buildSessionContext())).not.toContain("side delivery");
  });

  it("accepts an unowned side leaf only when it preserves the active branch", async () => {
    const dir = await makeTempDir();
    const sessionManager = SessionManager.create(dir, dir);
    sessionManager.appendMessage({ role: "user", content: "question", timestamp: 1 });
    const activeLeafId = sessionManager.appendMessage(buildAssistantMessage("base answer"));
    const sideEntry = {
      type: "message" as const,
      id: "unowned-side-delivery",
      parentId: activeLeafId,
      timestamp: "2026-07-05T00:00:01.000Z",
      message: buildAssistantMessage("side delivery"),
    };

    sessionManager.mergePromptReleasedSessionEntries([
      sideEntry,
      {
        type: "prompt_released_opaque",
        preserveActiveLeaf: true,
        record: {
          type: "leaf",
          id: "unowned-side-leaf",
          parentId: sideEntry.id,
          timestamp: "2026-07-05T00:00:02.000Z",
          targetId: activeLeafId,
          appendParentId: sideEntry.id,
          appendMode: "side",
        },
      },
    ]);

    expect(sessionManager.getLeafId()).toBe(activeLeafId);
    expect(JSON.stringify(sessionManager.buildSessionContext())).not.toContain("side delivery");
  });

  it("rejects an unowned side leaf that moves the active branch before mutating state", async () => {
    const dir = await makeTempDir();
    const sessionManager = SessionManager.create(dir, dir);
    const olderLeafId = sessionManager.appendMessage({
      role: "user",
      content: "question",
      timestamp: 1,
    });
    const activeLeafId = sessionManager.appendMessage(buildAssistantMessage("base answer"));
    const entryCount = sessionManager.getEntries().length;
    const sideEntry = {
      type: "message" as const,
      id: "hostile-side-delivery",
      parentId: activeLeafId,
      timestamp: "2026-07-05T00:00:01.000Z",
      message: buildAssistantMessage("hostile side delivery"),
    };

    expect(() =>
      sessionManager.mergePromptReleasedSessionEntries([
        sideEntry,
        {
          type: "prompt_released_opaque",
          preserveActiveLeaf: true,
          record: {
            type: "leaf",
            id: "hostile-side-leaf",
            parentId: sideEntry.id,
            timestamp: "2026-07-05T00:00:02.000Z",
            targetId: olderLeafId,
            appendParentId: sideEntry.id,
            appendMode: "side",
          },
        },
      ]),
    ).toThrow("prompt-released side leaf changed the active branch");
    expect(sessionManager.getLeafId()).toBe(activeLeafId);
    expect(sessionManager.getEntries()).toHaveLength(entryCount);
  });

  it("rejects an unowned side leaf that resets a non-root side cursor", async () => {
    const dir = await makeTempDir();
    const sessionManager = SessionManager.create(dir, dir);
    sessionManager.appendMessage({ role: "user", content: "question", timestamp: 1 });
    const activeLeafId = sessionManager.appendMessage(buildAssistantMessage("base answer"));
    const entryCount = sessionManager.getEntries().length;
    const sideEntry = {
      type: "message" as const,
      id: "side-delivery-before-root-reset",
      parentId: activeLeafId,
      timestamp: "2026-07-05T00:00:01.000Z",
      message: buildAssistantMessage("side delivery"),
    };

    expect(() =>
      sessionManager.mergePromptReleasedSessionEntries([
        sideEntry,
        {
          type: "prompt_released_opaque",
          preserveActiveLeaf: true,
          record: {
            type: "leaf",
            id: "unowned-root-reset-leaf",
            parentId: sideEntry.id,
            timestamp: "2026-07-05T00:00:02.000Z",
            targetId: activeLeafId,
            appendParentId: null,
            appendMode: "side",
          },
        },
      ]),
    ).toThrow("prompt-released side leaf changed the active branch");
    expect(sessionManager.getLeafId()).toBe(activeLeafId);
    expect(sessionManager.getEntries()).toHaveLength(entryCount);
  });

  it("accepts an explicit root side cursor when it matches the current side branch", async () => {
    const dir = await makeTempDir();
    const sessionManager = SessionManager.create(dir, dir);
    sessionManager.appendMessage({ role: "user", content: "question", timestamp: 1 });
    const activeLeafId = sessionManager.appendMessage(buildAssistantMessage("base answer"));

    sessionManager.mergePromptReleasedSessionEntries([
      {
        type: "prompt_released_opaque",
        record: {
          type: "leaf",
          id: "owned-root-side-leaf",
          parentId: activeLeafId,
          timestamp: "2026-07-05T00:00:01.000Z",
          targetId: activeLeafId,
          appendParentId: null,
          appendMode: "side",
        },
      },
    ]);

    expect(() =>
      sessionManager.mergePromptReleasedSessionEntries([
        {
          type: "prompt_released_opaque",
          preserveActiveLeaf: true,
          record: {
            type: "leaf",
            id: "unowned-root-side-leaf",
            parentId: null,
            timestamp: "2026-07-05T00:00:02.000Z",
            targetId: activeLeafId,
            appendParentId: null,
            appendMode: "side",
          },
        },
      ]),
    ).not.toThrow();
    expect(sessionManager.getLeafId()).toBe(activeLeafId);
  });

  it("applies merged leaf controls across separate callbacks", async () => {
    const dir = await makeTempDir();
    const sessionManager = SessionManager.create(dir, dir);
    sessionManager.appendMessage({ role: "user", content: "question", timestamp: 1 });
    const baseAnswerId = sessionManager.appendMessage(buildAssistantMessage("base answer"));
    const metadata = {
      type: "metadata",
      id: "plugin-metadata",
      parentId: baseAnswerId,
      payload: { source: "plugin" },
    };
    const leafEntry = {
      type: "leaf",
      id: "plugin-leaf",
      parentId: metadata.id,
      timestamp: "2026-06-04T00:00:03.000Z",
      targetId: baseAnswerId,
    };
    const deliveryEntry = {
      type: "message" as const,
      id: "plugin-delivery",
      parentId: leafEntry.id,
      timestamp: "2026-06-04T00:00:04.000Z",
      message: buildAssistantMessage("plugin delivery"),
    };

    sessionManager.mergePromptReleasedSessionEntries([
      { type: "prompt_released_opaque", record: metadata },
    ]);
    sessionManager.mergePromptReleasedSessionEntries([
      { type: "prompt_released_opaque", record: leafEntry },
    ]);
    sessionManager.mergePromptReleasedSessionEntries([deliveryEntry]);
    (
      sessionManager as unknown as {
        replacePersistedTranscript: () => void;
      }
    ).replacePersistedTranscript();

    const sessionFile = sessionManager.getSessionFile();
    expect(sessionFile).toBeDefined();
    const records = (await fs.readFile(sessionFile!, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type?: string;
            id?: string;
            parentId?: string | null;
            targetId?: string | null;
          },
      );
    expect(records.find((record) => record.id === deliveryEntry.id)?.parentId).toBe(baseAnswerId);
    expect(records.at(-1)).toMatchObject({ type: "leaf", targetId: baseAnswerId });
    const reopened = SessionManager.open(sessionFile!, dir, dir);
    expect(reopened.getLeafId()).toBe(baseAnswerId);
    expect(JSON.stringify(reopened.buildSessionContext())).not.toContain("plugin delivery");
    expect(reopened.getBranch(deliveryEntry.id).map((entry) => entry.id)).toEqual([
      expect.any(String),
      baseAnswerId,
      deliveryEntry.id,
    ]);
  });

  it("round-trips a visible leaf with a distinct opaque append parent", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const baseAnswer = {
      type: "message",
      id: "base-answer",
      parentId: null,
      timestamp: "2026-06-15T00:00:01.000Z",
      message: buildAssistantMessage("base answer"),
    };
    const metadata = {
      type: "metadata",
      id: "plugin-metadata",
      parentId: null,
      payload: { source: "plugin" },
    };
    await fs.writeFile(
      sessionFile,
      [buildSessionHeader(dir, "session-1"), baseAnswer, metadata]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf-8",
    );

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    sessionManager.mergePromptReleasedSessionEntries([
      {
        type: "message",
        id: "side-delivery",
        parentId: baseAnswer.id,
        timestamp: "2026-06-15T00:00:02.000Z",
        message: buildAssistantMessage("side delivery"),
      },
    ]);
    (
      sessionManager as unknown as {
        replacePersistedTranscript: () => void;
      }
    ).replacePersistedTranscript();

    const rewritten = (await fs.readFile(sessionFile, "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rewritten.at(-1)).toMatchObject({
      type: "leaf",
      targetId: baseAnswer.id,
      appendParentId: metadata.id,
    });

    const reopened = SessionManager.open(sessionFile, dir, dir);
    expect(reopened.getLeafId()).toBe(baseAnswer.id);
    const nextId = reopened.appendMessage(buildAssistantMessage("active continuation"));
    const records = (await fs.readFile(sessionFile, "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id?: string; parentId?: string | null });
    expect(records.find((entry) => entry.id === nextId)?.parentId).toBe(metadata.id);
    expect(reopened.getBranch(nextId).map((entry) => entry.id)).toEqual([baseAnswer.id, nextId]);
    const branchedFile = reopened.createBranchedSession(nextId);
    expect(branchedFile).toBeDefined();
    const branchedRecords = (await fs.readFile(branchedFile!, "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id?: string; parentId?: string | null });
    expect(branchedRecords.find((entry) => entry.id === metadata.id)).toMatchObject({
      parentId: baseAnswer.id,
    });
    expect(branchedRecords.find((entry) => entry.id === nextId)).toMatchObject({
      parentId: metadata.id,
    });
  });

  it("reopens parentless canonical rows as one visible branch", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        buildSessionHeader(dir, "session-1"),
        {
          type: "message",
          id: "user-1",
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "user", content: "question", timestamp: 1 },
        },
        {
          type: "message",
          id: "assistant-1",
          timestamp: "2026-06-15T00:00:02.000Z",
          message: buildAssistantMessage("answer"),
        },
        {
          type: "leaf",
          id: "active-leaf",
          parentId: "assistant-1",
          timestamp: "2026-06-15T00:00:03.000Z",
          targetId: "assistant-1",
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf8",
    );

    const reopened = SessionManager.open(sessionFile, dir, dir);

    expect(reopened.getBranch().map((entry) => entry.id)).toEqual(["user-1", "assistant-1"]);
    expect(reopened.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "question" },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ]);
  });

  it("ignores persisted leaf controls with dangling references", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        buildSessionHeader(dir, "session-1"),
        {
          type: "message",
          id: "active-root",
          parentId: null,
          timestamp: "2026-06-15T00:00:01.000Z",
          message: buildAssistantMessage("active"),
        },
        {
          type: "metadata",
          id: "plugin-metadata",
          parentId: "active-root",
          payload: { source: "plugin" },
        },
        {
          type: "leaf",
          id: "missing-target",
          parentId: "plugin-metadata",
          timestamp: "2026-06-15T00:00:02.000Z",
          targetId: "missing",
        },
        {
          type: "leaf",
          id: "missing-append",
          parentId: "missing-target",
          timestamp: "2026-06-15T00:00:03.000Z",
          targetId: "active-root",
          appendParentId: "missing",
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf-8",
    );

    const reopened = SessionManager.open(sessionFile, dir, dir);
    expect(reopened.getLeafId()).toBe("active-root");
    const nextId = reopened.appendMessage(buildAssistantMessage("continued"));
    const records = (await fs.readFile(sessionFile, "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id?: string; parentId?: string | null });
    expect(records.find((entry) => entry.id === nextId)?.parentId).toBe("plugin-metadata");
    expect(reopened.buildSessionContext().messages).toMatchObject([
      { role: "assistant", content: [{ type: "text", text: "active" }] },
      { role: "assistant", content: [{ type: "text", text: "continued" }] },
    ]);
  });

  it("ignores dangling leaf controls merged while a prompt is released", async () => {
    const dir = await makeTempDir();
    const sessionManager = SessionManager.create(dir, dir);
    const baseAnswerId = sessionManager.appendMessage(buildAssistantMessage("base answer"));
    const metadata = {
      type: "metadata",
      id: "plugin-metadata",
      parentId: baseAnswerId,
      payload: { source: "plugin" },
    };
    sessionManager.mergePromptReleasedSessionEntries([
      { type: "prompt_released_opaque", record: metadata },
    ]);
    sessionManager.mergePromptReleasedSessionEntries([
      {
        type: "prompt_released_opaque",
        record: {
          type: "leaf",
          id: "missing-target",
          parentId: metadata.id,
          timestamp: "2026-06-15T00:00:02.000Z",
          targetId: "missing",
        },
      },
    ]);
    sessionManager.mergePromptReleasedSessionEntries([
      {
        type: "prompt_released_opaque",
        record: {
          type: "leaf",
          id: "missing-append",
          parentId: "missing-target",
          timestamp: "2026-06-15T00:00:03.000Z",
          targetId: baseAnswerId,
          appendParentId: "missing",
        },
      },
    ]);
    sessionManager.mergePromptReleasedSessionEntries([
      {
        type: "message",
        id: "side-delivery",
        parentId: baseAnswerId,
        timestamp: "2026-06-15T00:00:04.000Z",
        message: buildAssistantMessage("side delivery"),
      },
    ]);
    (
      sessionManager as unknown as {
        replacePersistedTranscript: () => void;
      }
    ).replacePersistedTranscript();

    expect(sessionManager.getLeafId()).toBe(baseAnswerId);
    const sessionFile = sessionManager.getSessionFile();
    expect(sessionFile).toBeDefined();
    const records = (await fs.readFile(sessionFile!, "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id?: string; parentId?: string | null });
    expect(records.find((entry) => entry.id === "side-delivery")?.parentId).toBe(metadata.id);
  });

  it("clears label timestamps when starting a replacement session", async () => {
    const dir = await makeTempDir();
    const sessionManager = SessionManager.create(dir, dir);
    const answerId = sessionManager.appendMessage(buildAssistantMessage("answer"));
    sessionManager.appendLabelChange(answerId, "saved");
    const state = sessionManager as unknown as {
      labelTimestampsById: Map<string, string>;
    };

    expect(state.labelTimestampsById.size).toBe(1);

    sessionManager.newSession();

    expect(state.labelTimestampsById.size).toBe(0);
  });

  it("removes leaf controls that target regenerated labels when branching", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const rootEntry = {
      type: "message",
      id: "root-user",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: { role: "user", content: "root question" },
    };
    const labelEntry = {
      type: "label",
      id: "label-1",
      parentId: rootEntry.id,
      timestamp: "2026-06-04T00:00:02.000Z",
      targetId: rootEntry.id,
      label: "selected",
    };
    const abandonedEntry = {
      type: "message",
      id: "abandoned-assistant",
      parentId: labelEntry.id,
      timestamp: "2026-06-04T00:00:03.000Z",
      message: buildAssistantMessage("abandoned answer"),
    };
    const leafEntry = {
      type: "leaf",
      id: "leaf-1",
      parentId: abandonedEntry.id,
      timestamp: "2026-06-04T00:00:04.000Z",
      targetId: labelEntry.id,
    };
    const replacementEntry = {
      type: "message",
      id: "replacement-assistant",
      parentId: leafEntry.id,
      timestamp: "2026-06-04T00:00:05.000Z",
      message: buildAssistantMessage("replacement answer"),
    };
    await fs.writeFile(
      sessionFile,
      [
        buildSessionHeader(dir, "session-1"),
        rootEntry,
        labelEntry,
        abandonedEntry,
        leafEntry,
        replacementEntry,
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf8",
    );

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    const branchedFile = sessionManager.createBranchedSession(replacementEntry.id);
    expect(branchedFile).toBeDefined();
    const branchedRecords = (await fs.readFile(branchedFile!, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(branchedRecords.some((record) => record.type === "leaf")).toBe(false);
    expect(branchedRecords.find((record) => record.id === replacementEntry.id)?.parentId).toBe(
      rootEntry.id,
    );
    expect(branchedRecords).toContainEqual(
      expect.objectContaining({
        type: "label",
        targetId: rootEntry.id,
        label: labelEntry.label,
      }),
    );
    expect(
      SessionManager.open(branchedFile!, dir, dir).buildSessionContext().messages,
    ).toMatchObject([
      { role: "user", content: "root question" },
      { role: "assistant", content: [{ type: "text", text: "replacement answer" }] },
    ]);
  });

  it("keeps the warm cache after prepareSessionManagerForRun rewrites then appends", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: { role: "assistant", content: "carried context" },
    };
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir, "original-session"))}\n${JSON.stringify(
        assistantEntry,
      )}\n`,
      "utf8",
    );

    // Warm the process-level entry cache, then open the manager the embedded
    // runner will normalize.
    expect(SessionManager.open(sessionFile, dir, dir).getSessionId()).toBe("original-session");
    const sessionManager = SessionManager.open(sessionFile, dir, dir);

    let trustedSnapshot = await readTrustedRepairSnapshot(sessionFile);
    let snapshotPublications = 0;
    await withOwnedSessionTranscriptWrites(
      {
        sessionFile,
        canAdvanceSessionEntryCache: (snapshot) => {
          expect(snapshot).toEqual(trustedSnapshot);
          return true;
        },
        publishSessionFileSnapshot: (snapshot) => {
          snapshotPublications += 1;
          trustedSnapshot = snapshot;
          return true;
        },
        withSessionWriteLock: async (run) => await run(),
      },
      async () => {
        await prepareSessionManagerForRun({
          sessionManager,
          sessionFile,
          hadSessionFile: true,
          sessionId: "run-session",
          cwd: dir,
        });
        // First append after the embedded header rewrite. Before the fix the
        // stale snapshot made this drop the warm cache.
        sessionManager.appendMessage(buildAssistantMessage("after rewrite"));
      },
    );
    expect(snapshotPublications).toBe(2);

    const originalParse = JSON.parse;
    let parseCount = 0;
    JSON.parse = function countedParse(...args: Parameters<typeof JSON.parse>) {
      parseCount += 1;
      return originalParse.apply(originalParse, args);
    } as typeof JSON.parse;

    try {
      const reopened = SessionManager.open(sessionFile, dir, dir);
      expect(reopened.getEntries().map((entry) => readMessageContent(entry))).toEqual([
        "carried context",
        "after rewrite",
      ]);
      // The next warm open must hit the cache instead of reparsing the whole
      // transcript that the embedded header rewrite produced.
      expect(parseCount).toBe(0);
    } finally {
      JSON.parse = originalParse;
    }
  });

  it("invalidates incremental repair state after a full header rewrite", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const firstEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: buildAssistantMessage("message 1"),
    };
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(firstEntry)}\n`,
      "utf8",
    );
    await repairSessionFileIfNeeded({ sessionFile });

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await prepareSessionManagerForRun({
      sessionManager,
      sessionFile,
      hadSessionFile: true,
      sessionId: "longer-rewritten-session-id",
      cwd: dir,
    });

    const originalParse = JSON.parse;
    let parseCount = 0;
    JSON.parse = function countedParse(...args: Parameters<typeof JSON.parse>) {
      parseCount += 1;
      return originalParse.apply(originalParse, args);
    } as typeof JSON.parse;
    try {
      await repairSessionFileIfNeeded({
        sessionFile,
        trustedSnapshot: await readTrustedRepairSnapshot(sessionFile),
      });
      expect(parseCount).toBeGreaterThanOrEqual(2);
    } finally {
      JSON.parse = originalParse;
    }
  });

  it("does not rewrite a warm transcript when its header already matches the run", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: { role: "assistant", content: "carried context" },
    };
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(assistantEntry)}\n`,
      "utf8",
    );
    await fs.utimes(sessionFile, new Date(1_000), new Date(1_000));
    const before = await fs.stat(sessionFile);
    const sessionManager = SessionManager.open(sessionFile, dir, dir);

    await prepareSessionManagerForRun({
      sessionManager,
      sessionFile,
      hadSessionFile: true,
      sessionId: "test-session",
      cwd: dir,
    });

    const after = await fs.stat(sessionFile);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});

describe("parseSessionEntries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses valid JSONL lines without logging warnings", () => {
    const warnSpy = vi.spyOn(Logger, "logWarn").mockImplementation(() => {});
    const content = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "message", id: "m1" }),
    ].join("\n");

    const entries = parseSessionEntries(content);

    expect(entries).toHaveLength(2);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("logs a warning and skips malformed JSONL lines while preserving valid entries", () => {
    const warnSpy = vi.spyOn(Logger, "logWarn").mockImplementation(() => {});
    const content = [
      JSON.stringify({ type: "session", id: "s1" }),
      "not valid json {{{",
      JSON.stringify({ type: "message", id: "m1" }),
    ].join("\n");

    const entries = parseSessionEntries(content);

    expect(entries).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("parseJsonlEntries: skipped 1 malformed JSONL line"),
    );
  });

  it("reports the correct skip count for multiple malformed lines", () => {
    const warnSpy = vi.spyOn(Logger, "logWarn").mockImplementation(() => {});
    const content = [
      "bad line 1",
      JSON.stringify({ type: "session", id: "s1" }),
      "bad line 2",
      "bad line 3",
    ].join("\n");

    const entries = parseSessionEntries(content);

    expect(entries).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("parseJsonlEntries: skipped 3 malformed JSONL line"),
    );
  });

  it("skips empty lines without counting them as malformed", () => {
    const warnSpy = vi.spyOn(Logger, "logWarn").mockImplementation(() => {});
    const content = [
      "",
      JSON.stringify({ type: "session", id: "s1" }),
      "",
      JSON.stringify({ type: "message", id: "m1" }),
      "",
    ].join("\n");

    const entries = parseSessionEntries(content);

    expect(entries).toHaveLength(2);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("parseJsonlEntries logs warning for malformed lines via loadEntriesFromFile", async () => {
    const warnSpy = vi.spyOn(Logger, "logWarn").mockImplementation(() => {});
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const header = buildSessionHeader(dir);
    const content = [
      JSON.stringify(header),
      "not valid json {{{",
      JSON.stringify(buildMessageEntry(1, null)),
    ].join("\n");
    await fs.writeFile(sessionFile, content, "utf8");

    const entries = loadEntriesFromFile(sessionFile);

    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(warnSpy).toHaveBeenCalled();
    expect(
      warnSpy.mock.calls.some((call) =>
        call[0].includes("parseJsonlEntries: skipped 1 malformed JSONL line"),
      ),
    ).toBe(true);
  });

  it("buildSessionInfo logs warning for malformed lines via SessionManager.list", async () => {
    const warnSpy = vi.spyOn(Logger, "logWarn").mockImplementation(() => {});
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const header = buildSessionHeader(dir);
    const content = [
      JSON.stringify(header),
      "not valid json {{{",
      JSON.stringify(buildMessageEntry(1, null)),
    ].join("\n");
    await fs.writeFile(sessionFile, content, "utf8");

    const sessions = await SessionManager.list(dir, dir);

    expect(sessions).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
    expect(
      warnSpy.mock.calls.some((call) =>
        call[0].includes("buildSessionInfo: skipped 1 malformed JSONL line"),
      ),
    ).toBe(true);
  });

  it("buildSessionInfo does not log warning for clean session listing", async () => {
    const warnSpy = vi.spyOn(Logger, "logWarn").mockImplementation(() => {});
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const header = buildSessionHeader(dir);
    const content = [JSON.stringify(header), JSON.stringify(buildMessageEntry(1, null))].join("\n");
    await fs.writeFile(sessionFile, content, "utf8");

    const sessions = await SessionManager.list(dir, dir);

    expect(sessions).toHaveLength(1);
    // buildSessionInfo must not log any warning for a clean listing.
    const buildSessionInfoCalls = warnSpy.mock.calls.filter((call) =>
      call[0].includes("buildSessionInfo"),
    );
    expect(buildSessionInfoCalls).toHaveLength(0);
  });
});

function readMessageContent(entry: SessionEntry): unknown {
  const content = (entry as { message: { content: unknown } }).message.content;
  if (Array.isArray(content)) {
    return content.map((part) => (part as { text?: string }).text ?? "").join("");
  }
  return content;
}

async function readTrustedRepairSnapshot(sessionFile: string) {
  const stat = await fs.stat(sessionFile, { bigint: true });
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function buildAssistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "messages" as const,
    provider: "anthropic" as const,
    model: "sonnet-4.6" as const,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

function buildSessionHeader(cwd: string, id = "test-session") {
  return {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id,
    timestamp: "2026-06-04T00:00:00.000Z",
    cwd,
  };
}

function buildMessageEntry(index: number, parentId: string | null): SessionEntry {
  return {
    type: "message",
    id: `entry-${index}`,
    parentId,
    timestamp: `2026-06-04T00:00:0${index}.000Z`,
    message: { role: "user", content: `message ${index}`, timestamp: index },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
