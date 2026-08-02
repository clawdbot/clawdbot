// Session filesystem utility tests cover transcript reading, usage extraction,
// preview rows, message counts, title fields, and archive candidate resolution.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createNoisyPngBuffer } from "../../test/helpers/image-fixtures.js";
import {
  createFileBackedSessionManagerForTest,
  openFileBackedSessionManagerForTest,
} from "../../test/helpers/session-manager-file-fixture.js";
import { withEnv, withEnvAsync } from "../test-utils/env.js";
import { estimateStringChars, estimateTokensFromChars } from "../utils/cjk-chars.js";
import { projectChatDisplayMessages } from "./chat-display-projection.js";
import { createToolSummaryPreviewTranscriptLines } from "./session-preview.test-helpers.js";
import {
  ArchivedTranscriptReader,
  buildSessionPreviewItems,
  readLatestSessionUsageFromTranscriptAsync,
  resolveSessionTranscriptCandidates,
  type ReadRecentSessionMessagesOptions,
  type ReadSessionMessagesAsyncOptions,
} from "./session-utils.fs.js";

function filesystemReader(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
) {
  return new ArchivedTranscriptReader({ sessionId, storePath, sessionFile, agentId });
}

async function readSessionMessagesAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  opts: ReadSessionMessagesAsyncOptions,
  agentId?: string,
) {
  return (await filesystemReader(sessionId, storePath, sessionFile, agentId).read(opts)).messages;
}

async function readRecentSessionMessagesAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  opts: ReadRecentSessionMessagesOptions,
  agentId?: string,
) {
  return (
    await filesystemReader(sessionId, storePath, sessionFile, agentId).read({
      mode: "recent",
      ...opts,
    })
  ).messages;
}

async function readRecentSessionMessagesWithStatsAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  opts: ReadRecentSessionMessagesOptions,
  agentId?: string,
) {
  return await filesystemReader(sessionId, storePath, sessionFile, agentId).readRecentWithStats(
    opts,
  );
}

async function readSessionMessagesPageWithStatsAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  opts: { offset: number; maxMessages: number; allowResetArchiveFallback?: boolean },
  agentId?: string,
) {
  return await filesystemReader(sessionId, storePath, sessionFile, agentId).readPage(opts);
}

function buildSessionAssistantMessage(text: string, timestamp: number) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai",
    provider: "openai",
    model: "mock-1",
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
    stopReason: "stop" as const,
    timestamp,
  };
}

function registerTempSessionStore(
  prefix: string,
  assignPaths: (tmpDir: string, storePath: string) => void,
) {
  let dir = "";
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    assignPaths(dir, path.join(dir, "sessions.json"));
  });
  afterAll(() => {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

function writeTranscript(tmpDir: string, sessionId: string, lines: unknown[]): string {
  const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, lines.map((line) => JSON.stringify(line)).join("\n"), "utf-8");
  return transcriptPath;
}

function createTranscriptMessage(
  id: string,
  parentId: string | null | undefined,
  role: "user" | "assistant" | "toolResult",
  content: unknown,
  options: { message?: Record<string, unknown>; record?: Record<string, unknown> } = {},
) {
  return {
    type: "message",
    id,
    ...(parentId === undefined ? {} : { parentId }),
    ...options.record,
    message: { role, content, ...options.message },
  };
}

function writeResetArchive(
  tmpDir: string,
  sessionId: string,
  timestamp: string,
  lines: unknown[],
): string {
  const archivePath = path.join(tmpDir, `${sessionId}.jsonl.reset.${timestamp}`);
  fs.writeFileSync(archivePath, lines.map((line) => JSON.stringify(line)).join("\n"), "utf-8");
  return archivePath;
}

function installAsyncPositionalShortReadProxy(maxPerCall = 16) {
  const realOpen = fs.promises.open.bind(fs.promises);
  let shortReadCalls = 0;
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args: unknown[]) => {
    const handle = await realOpen(...(args as Parameters<typeof realOpen>));
    const realRead = handle.read.bind(handle);
    return new Proxy(handle, {
      get(target, prop, receiver) {
        if (prop !== "read") {
          return Reflect.get(target, prop, receiver);
        }
        return (buf: Buffer, offset: number, length: number, position: number | null) => {
          const cappedLength = position !== null ? maxPerCall : length;
          if (cappedLength < length) {
            shortReadCalls += 1;
          }
          return realRead(buf, offset, Math.min(length, cappedLength), position);
        };
      },
    });
  });
  return () => shortReadCalls;
}

function appendBlockedUserMessageWithSessionManager(params: {
  sessionFile: string;
  originalText?: string;
  redactedText: string;
  pluginId: string;
  idempotencyKey?: string;
}): string {
  const sessionManager = openFileBackedSessionManagerForTest(
    params.sessionFile,
    path.dirname(params.sessionFile),
  );
  return appendBlockedUserMessage(sessionManager, params);
}

function appendBlockedUserMessage(
  sessionManager: SessionManager,
  params: {
    originalText?: string;
    redactedText: string;
    pluginId: string;
    idempotencyKey?: string;
  },
): string {
  const messageId = sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: params.redactedText }],
    timestamp: Date.now(),
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    __openclaw: {
      beforeAgentRunBlocked: {
        blockedBy: params.pluginId,
        blockedAt: Date.now(),
      },
    },
  } as Parameters<typeof sessionManager.appendMessage>[0]);
  (
    sessionManager as unknown as {
      replacePersistedTranscript?: () => void;
    }
  ).replacePersistedTranscript?.();
  return messageId;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function expectMessageContents(messages: unknown[], expected: unknown[]) {
  expect(messages.map((message) => requireRecord(message, "message").content)).toEqual(expected);
}

function expectMessageFields(
  message: unknown,
  fields: { role?: string; content?: unknown; openclaw?: Record<string, unknown> },
) {
  const record = requireRecord(message, "message");
  if ("role" in fields) {
    expect(record.role).toBe(fields.role);
  }
  if ("content" in fields) {
    expect(record.content).toEqual(fields.content);
  }
  if (fields.openclaw) {
    const metadata = requireRecord(record["__openclaw"], "message metadata");
    for (const [key, value] of Object.entries(fields.openclaw)) {
      expect(metadata[key]).toEqual(value);
    }
  }
}

function expectUsageFields(usage: unknown, fields: Record<string, unknown>) {
  const record = requireRecord(usage, "usage");
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

describe("readSessionMessages", () => {
  let tmpDir: string;
  let storePath: string;

  registerTempSessionStore("openclaw-session-fs-test-", (nextTmpDir, nextStorePath) => {
    tmpDir = nextTmpDir;
    storePath = nextStorePath;
  });

  test("includes synthetic compaction markers for compaction entries", async () => {
    const sessionId = "test-session-compaction";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ message: { role: "user", content: "Hello" } }),
      JSON.stringify({
        type: "compaction",
        id: "comp-1",
        timestamp: "2026-02-07T00:00:00.000Z",
        summary: "Compacted history",
        firstKeptEntryId: "x",
        tokensBefore: 123,
      }),
      JSON.stringify({ message: { role: "assistant", content: "World" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const out = await readSessionMessagesAsync(sessionId, storePath, undefined, {
      mode: "full",
      reason: "test",
    });
    expect(out).toHaveLength(3);
    const marker = out[1] as {
      role: string;
      content?: Array<{ text?: string }>;
      __openclaw?: { kind?: string; id?: string };
      timestamp?: number;
    };
    expect(marker.role).toBe("system");
    expect(marker.content?.[0]?.text).toBe("Compaction");
    expect(marker["__openclaw"]?.kind).toBe("compaction");
    expect(marker["__openclaw"]?.id).toBe("comp-1");
    expect(typeof marker.timestamp).toBe("number");
  });

  test("preserves real sequence metadata for async bounded recent-message reads", async () => {
    const sessionId = "test-session-recent-seq-async";
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 1, id: sessionId },
      { message: { role: "user", content: "old" } },
      { message: { role: "assistant", content: "middle" } },
      { message: { role: "user", content: "recent" } },
      { message: { role: "assistant", content: "latest" } },
    ]);
    const readFileSpy = vi.spyOn(fs, "readFileSync");

    try {
      const result = await readRecentSessionMessagesWithStatsAsync(
        sessionId,
        storePath,
        undefined,
        {
          maxMessages: 2,
          maxBytes: 256,
        },
      );

      expect(result.totalMessages).toBe(4);
      expect(result.messages).toHaveLength(2);
      expectMessageFields(result.messages[0], { content: "recent", openclaw: { seq: 3 } });
      expectMessageFields(result.messages[1], { content: "latest", openclaw: { seq: 4 } });
      expect(readFileSpy).not.toHaveBeenCalled();
    } finally {
      readFileSpy.mockRestore();
    }
  });

  test("returns no recent messages for a zero-sized page while preserving the total", async () => {
    const sessionId = "test-session-recent-zero";
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 1, id: sessionId },
      { message: { role: "user", content: "old" } },
      { message: { role: "assistant", content: "latest" } },
    ]);

    await expect(
      readRecentSessionMessagesWithStatsAsync(sessionId, storePath, undefined, {
        maxMessages: 0,
      }),
    ).resolves.toMatchObject({ messages: [], totalMessages: 2 });
  });

  test("forwards the outer JSONL record timestamp to __openclaw.recordTimestampMs (#85648)", async () => {
    const sessionId = "test-session-record-timestamp";
    const t1 = "2026-05-16T16:00:31.000Z";
    const t2 = "2026-05-23T04:02:33.000Z";
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 1, id: sessionId },
      { timestamp: t1, message: { role: "user", content: "old turn" } },
      { timestamp: t2, message: { role: "assistant", content: "fresh turn" } },
    ]);
    const result = await readRecentSessionMessagesAsync(sessionId, storePath, undefined, {
      maxMessages: 5,
      maxBytes: 2048,
    });
    expect(result).toHaveLength(2);
    expectMessageFields(result[0], {
      content: "old turn",
      openclaw: { recordTimestampMs: Date.parse(t1) },
    });
    expectMessageFields(result[1], {
      content: "fresh turn",
      openclaw: { recordTimestampMs: Date.parse(t2) },
    });
  });

  test("surfaces persisted user idempotency keys in __openclaw metadata (#79844)", async () => {
    const sessionId = "test-session-idempotency-key";
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 1, id: sessionId },
      {
        id: "entry-user-1",
        message: {
          role: "user",
          content: "pending optimistic turn",
          idempotencyKey: "client-turn-1",
        },
      },
    ]);

    const result = await readRecentSessionMessagesAsync(sessionId, storePath, undefined, {
      maxMessages: 5,
      maxBytes: 2048,
    });

    expect(result).toHaveLength(1);
    expectMessageFields(result[0], {
      content: "pending optimistic turn",
      openclaw: { id: "entry-user-1", idempotencyKey: "client-turn-1" },
    });
  });

  test("honors byte caps for async recent-message reads", async () => {
    const sessionId = "test-session-recent-async-byte-cap";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const hugeContent = "huge ".repeat(4096);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ message: { role: "user", content: "old" } }),
      JSON.stringify({ message: { role: "assistant", content: hugeContent } }),
      JSON.stringify({ message: { role: "assistant", content: "tail" } }),
    ];
    fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`, "utf-8");
    const readFileSpy = vi.spyOn(fs, "readFileSync");

    try {
      const out = await readRecentSessionMessagesAsync(sessionId, storePath, undefined, {
        maxMessages: 2,
        maxBytes: 2048,
      });

      expect(out).toHaveLength(1);
      expectMessageFields(out[0], { role: "assistant", content: "tail" });
      expect(JSON.stringify(out)).not.toContain("huge");
      expect(readFileSpy).not.toHaveBeenCalled();
    } finally {
      readFileSpy.mockRestore();
    }
  });

  test("reads active tree branch asynchronously without SessionManager.open", async () => {
    const sessionId = "test-session-tree-async";
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 3, id: sessionId },
      createTranscriptMessage("user-1", null, "user", "root"),
      createTranscriptMessage("assistant-1", "user-1", "assistant", "active branch"),
      createTranscriptMessage("assistant-inactive", "user-1", "assistant", "inactive branch"),
      createTranscriptMessage("user-2", "assistant-1", "user", "latest active"),
      createTranscriptMessage("delivery-side-branch", "user-2", "assistant", "side delivery"),
      { type: "leaf", id: "active-leaf", parentId: "delivery-side-branch", targetId: "user-2" },
      { type: "metadata", id: "opaque-after-leaf", parentId: "delivery-side-branch" },
    ]);
    const sessionManagerOpenSpy = vi.spyOn(SessionManager, "open");
    const readFileSpy = vi.spyOn(fs, "readFileSync");

    try {
      const messages = await readSessionMessagesAsync(sessionId, storePath, undefined, {
        mode: "full",
        reason: "test active branch selection",
      });
      expectMessageContents(messages, ["root", "active branch", "latest active"]);
      const recentMessages = await readRecentSessionMessagesAsync(sessionId, storePath, undefined, {
        maxMessages: 10,
      });
      expectMessageContents(recentMessages, ["root", "active branch", "latest active"]);
      expectMessageFields(messages[2], { openclaw: { id: "user-2", seq: 3 } });
      expect(sessionManagerOpenSpy).not.toHaveBeenCalled();
      expect(readFileSpy).not.toHaveBeenCalled();
    } finally {
      sessionManagerOpenSpy.mockRestore();
      readFileSpy.mockRestore();
    }
  });

  test("applies reset kept-tail projection to file-backed history", async () => {
    const sessionId = "test-session-reset-boundary";
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 3, id: sessionId },
      createTranscriptMessage("old", null, "user", "old"),
      createTranscriptMessage("kept-user", "old", "user", "kept question"),
      createTranscriptMessage("kept-tool", "kept-user", "toolResult", "hidden tool"),
      createTranscriptMessage("kept-assistant", "kept-tool", "assistant", "kept answer"),
      {
        type: "reset",
        id: "reset-boundary",
        parentId: "kept-assistant",
        timestamp: "2026-07-22T00:00:00.000Z",
        reason: "new",
        firstKeptEntryId: "kept-user",
      },
      createTranscriptMessage("post-reset", "reset-boundary", "user", "new turn"),
    ]);

    const messages = await readSessionMessagesAsync(sessionId, storePath, undefined, {
      mode: "full",
      reason: "test reset boundary",
    });

    expectMessageContents(messages, ["kept question", "kept answer", "new turn"]);
  });

  test("keeps parentless linear history after a leaf control", async () => {
    const sessionId = "test-linear-with-opaque-link";
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 3, id: sessionId },
      createTranscriptMessage("linear-user", undefined, "user", "linear root"),
      createTranscriptMessage("linear-assistant", undefined, "assistant", "linear answer"),
      { type: "metadata", id: "linear-metadata", parentId: "linear-assistant" },
      createTranscriptMessage("side-assistant", "linear-assistant", "assistant", "side answer"),
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "side-assistant",
        targetId: "linear-assistant",
        appendParentId: "linear-metadata",
      },
    ]);

    const messages = await readSessionMessagesAsync(sessionId, storePath, undefined, {
      mode: "full",
      reason: "test parentless leaf selection",
    });

    expectMessageContents(messages, ["linear root", "linear answer"]);
    expectMessageContents(
      await readRecentSessionMessagesAsync(sessionId, storePath, undefined, { maxMessages: 10 }),
      ["linear root", "linear answer"],
    );
  });

  test("falls back to the latest reset archive when the active transcript is missing", async () => {
    const sessionId = "test-session-reset-archive-fallback";
    writeResetArchive(tmpDir, sessionId, "2026-02-16T22-26-33.000Z", [
      { type: "session", version: 1, id: sessionId },
      { message: { role: "assistant", content: "older archive" } },
    ]);
    writeResetArchive(tmpDir, sessionId, "2026-02-16T22-26-34.000Z", [
      { type: "session", version: 1, id: sessionId },
      { message: { role: "user", content: "restored prompt" } },
      { message: { role: "assistant", content: "restored archive" } },
    ]);

    const fullMessages = await readSessionMessagesAsync(sessionId, storePath, undefined, {
      mode: "full",
      reason: "test reset archive fallback",
      allowResetArchiveFallback: true,
    });
    expect(fullMessages.map((message) => (message as { content?: unknown }).content)).toEqual([
      "restored prompt",
      "restored archive",
    ]);
    const recent = await readRecentSessionMessagesWithStatsAsync(sessionId, storePath, undefined, {
      maxMessages: 1,
      maxBytes: 2048,
      allowResetArchiveFallback: true,
    });
    expect(recent.transcriptSource).toBe("reset-archive");
    expect(recent.totalMessages).toBe(2);
    expect(recent.messages).toHaveLength(1);
    expectMessageFields(recent.messages[0], {
      role: "assistant",
      content: "restored archive",
      openclaw: { seq: 2 },
    });
  });

  test("uses the active transcript if it appears during reset archive discovery", async () => {
    const sessionId = "test-session-reset-archive-active-race";
    writeResetArchive(tmpDir, sessionId, "2026-02-16T22-26-34.000Z", [
      { type: "session", version: 1, id: sessionId },
      { message: { role: "assistant", content: "stale archive" } },
    ]);

    const originalReaddir = fs.promises.readdir.bind(fs.promises);
    let wroteActiveTranscript = false;
    const readdirSpy = vi.spyOn(fs.promises, "readdir").mockImplementation((async (
      ...args: unknown[]
    ) => {
      const result = await (originalReaddir as (...readdirArgs: unknown[]) => Promise<unknown>)(
        ...args,
      );
      if (!wroteActiveTranscript) {
        wroteActiveTranscript = true;
        writeTranscript(tmpDir, sessionId, [
          { type: "session", version: 1, id: sessionId },
          { message: { role: "assistant", content: "active transcript" } },
        ]);
      }
      return result;
    }) as typeof fs.promises.readdir);

    try {
      const fullMessages = await readSessionMessagesAsync(sessionId, storePath, undefined, {
        mode: "full",
        reason: "test active transcript race",
        allowResetArchiveFallback: true,
      });

      expect(readdirSpy).toHaveBeenCalled();
      expect(fullMessages.map((message) => (message as { content?: unknown }).content)).toEqual([
        "active transcript",
      ]);
    } finally {
      readdirSpy.mockRestore();
    }
  });

  test("caches reset archive discovery for repeated missing-active reads", async () => {
    const sessionId = "test-session-reset-archive-cache";
    writeResetArchive(tmpDir, sessionId, "2026-02-16T22-26-34.000Z", [
      { type: "session", version: 1, id: sessionId },
      { message: { role: "assistant", content: "cached archive" } },
    ]);

    const readdirSpy = vi.spyOn(fs.promises, "readdir");
    try {
      const firstMessages = await readSessionMessagesAsync(sessionId, storePath, undefined, {
        mode: "full",
        reason: "test first cached archive read",
        allowResetArchiveFallback: true,
      });
      const readdirCallsAfterFirstRead = readdirSpy.mock.calls.length;

      const secondMessages = await readSessionMessagesAsync(sessionId, storePath, undefined, {
        mode: "full",
        reason: "test second cached archive read",
        allowResetArchiveFallback: true,
      });

      expect(readdirCallsAfterFirstRead).toBeGreaterThan(0);
      expect(readdirSpy.mock.calls).toHaveLength(readdirCallsAfterFirstRead);
      expect(firstMessages.map((message) => (message as { content?: unknown }).content)).toEqual([
        "cached archive",
      ]);
      expect(secondMessages.map((message) => (message as { content?: unknown }).content)).toEqual([
        "cached archive",
      ]);
    } finally {
      readdirSpy.mockRestore();
    }
  });

  test("chooses the newest reset archive across candidate roots", async () => {
    const sessionId = "test-session-reset-archive-cross-root";
    writeResetArchive(tmpDir, sessionId, "2026-02-16T22-26-33.000Z", [
      { type: "session", version: 1, id: sessionId },
      { message: { role: "assistant", content: "older store archive" } },
    ]);
    const legacySessionsDir = path.join(tmpDir, ".openclaw", "sessions");
    fs.mkdirSync(legacySessionsDir, { recursive: true });
    writeResetArchive(legacySessionsDir, sessionId, "2026-02-16T22-26-34.000Z", [
      { type: "session", version: 1, id: sessionId },
      { message: { role: "assistant", content: "newer legacy archive" } },
    ]);
    await withEnvAsync({ OPENCLAW_HOME: tmpDir }, async () => {
      const fullMessages = await readSessionMessagesAsync(sessionId, storePath, undefined, {
        mode: "full",
        reason: "test cross-root reset archive fallback",
        allowResetArchiveFallback: true,
      });

      expect(fullMessages.map((message) => (message as { content?: unknown }).content)).toEqual([
        "newer legacy archive",
      ]);
    });
  });

  test("does not use stale generated session archives for reset archive fallback", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const staleSessionId = "00000000-0000-4000-8000-000000000002";
    const staleSessionFile = path.join(tmpDir, `${staleSessionId}.jsonl`);
    writeResetArchive(tmpDir, staleSessionId, "2026-02-16T22-26-35.000Z", [
      { type: "session", version: 1, id: staleSessionId },
      { message: { role: "assistant", content: "wrong stale archive" } },
    ]);
    writeResetArchive(tmpDir, sessionId, "2026-02-16T22-26-34.000Z", [
      { type: "session", version: 1, id: sessionId },
      { message: { role: "assistant", content: "current archive" } },
    ]);

    const fullMessages = await readSessionMessagesAsync(sessionId, storePath, staleSessionFile, {
      mode: "full",
      reason: "test stale archive fallback rejection",
      allowResetArchiveFallback: true,
    });

    expect(fullMessages.map((message) => (message as { content?: unknown }).content)).toEqual([
      "current archive",
    ]);
  });

  test("accepts stale generated session archives when the header matches the current session", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000006";
    const staleSessionId = "00000000-0000-4000-8000-000000000007";
    const staleSessionFile = `${staleSessionId}.jsonl`;
    writeResetArchive(tmpDir, staleSessionId, "2026-02-16T22-26-35.000Z", [
      { type: "session", version: 1, id: sessionId },
      { message: { role: "assistant", content: "valid stale-name archive" } },
    ]);

    const fullMessages = await readSessionMessagesAsync(sessionId, storePath, staleSessionFile, {
      mode: "full",
      reason: "test stale generated archive header recovery",
      allowResetArchiveFallback: true,
    });

    expect(fullMessages.map((message) => (message as { content?: unknown }).content)).toEqual([
      "valid stale-name archive",
    ]);
  });

  test("preserves explicit transcript variant priority for reset archive fallback", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000003";
    const topicSessionFile = "custom-topic-alpha.jsonl";
    writeResetArchive(tmpDir, sessionId, "2026-02-16T22-26-35.000Z", [
      { type: "session", version: 1, id: sessionId },
      { message: { role: "assistant", content: "newer canonical archive" } },
    ]);
    writeResetArchive(tmpDir, "custom-topic-alpha", "2026-02-16T22-26-34.000Z", [
      { type: "session", version: 1, id: sessionId },
      { message: { role: "assistant", content: "preferred topic archive" } },
    ]);

    const fullMessages = await readSessionMessagesAsync(sessionId, storePath, topicSessionFile, {
      mode: "full",
      reason: "test explicit archive variant priority",
      allowResetArchiveFallback: true,
    });

    expect(fullMessages.map((message) => (message as { content?: unknown }).content)).toEqual([
      "preferred topic archive",
    ]);
  });

  test("rejects custom reset archives from a previous session id", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000004";
    const previousSessionId = "00000000-0000-4000-8000-000000000005";
    const sessionFile = "shared-topic.jsonl";
    writeResetArchive(tmpDir, "shared-topic", "2026-02-16T22-26-36.000Z", [
      { type: "session", version: 1, id: previousSessionId },
      { message: { role: "assistant", content: "previous session archive" } },
    ]);

    const fullMessages = await readSessionMessagesAsync(sessionId, storePath, sessionFile, {
      mode: "full",
      reason: "test previous custom archive rejection",
      allowResetArchiveFallback: true,
    });
    expect(fullMessages).toEqual([]);

    const recent = await readRecentSessionMessagesWithStatsAsync(
      sessionId,
      storePath,
      sessionFile,
      {
        maxMessages: 1,
        maxBytes: 2048,
        allowResetArchiveFallback: true,
      },
    );
    expect(recent).toEqual({ messages: [], totalMessages: 0 });
  });

  test("revalidates a custom archive header after same-path replacement", async () => {
    const sessionId = "00000000-0000-4000-8000-00000000000a";
    const previousSessionId = "00000000-0000-4000-8000-00000000000b";
    const sessionFile = "shared-topic-replaced.jsonl";
    const archivePath = writeResetArchive(
      tmpDir,
      "shared-topic-replaced",
      "2026-02-16T22-26-36.000Z",
      [
        { type: "session", version: 1, id: sessionId },
        { message: { role: "assistant", content: "matching archive" } },
      ],
    );
    const read = () =>
      readSessionMessagesAsync(sessionId, storePath, sessionFile, {
        mode: "full",
        reason: "same-path archive replacement test",
        allowResetArchiveFallback: true,
      });

    await expect(read()).resolves.toHaveLength(1);
    fs.writeFileSync(
      archivePath,
      [
        { type: "session", version: 1, id: previousSessionId },
        { message: { role: "assistant", content: "replaced archive" } },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );
    await expect(read()).resolves.toEqual([]);
  });

  test("uses the newest custom reset archive whose header matches the session", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000008";
    const previousSessionId = "00000000-0000-4000-8000-000000000009";
    const sessionFile = "shared-topic-valid-latest.jsonl";
    writeResetArchive(tmpDir, "shared-topic-valid-latest", "2026-02-16T22-26-35.000Z", [
      { type: "session", version: 1, id: sessionId },
      { message: { role: "assistant", content: "older valid archive" } },
    ]);
    writeResetArchive(tmpDir, "shared-topic-valid-latest", "2026-02-16T22-26-36.000Z", [
      { type: "session", version: 1, id: previousSessionId },
      { message: { role: "assistant", content: "newer invalid archive" } },
    ]);

    const getShortReadCalls = installAsyncPositionalShortReadProxy(16);
    try {
      const fullMessages = await readSessionMessagesAsync(sessionId, storePath, sessionFile, {
        mode: "full",
        reason: "test newest valid custom archive",
        allowResetArchiveFallback: true,
      });

      expect(fullMessages.map((message) => (message as { content?: unknown }).content)).toEqual([
        "older valid archive",
      ]);
      expect(getShortReadCalls()).toBeGreaterThan(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  test("keeps async rows when imported parent links are incomplete without leaf control", async () => {
    const sessionId = "test-session-tree-async-incomplete-parent";
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 3, id: sessionId },
      createTranscriptMessage("legacy-user", undefined, "user", "legacy prompt"),
      createTranscriptMessage("tree-assistant", "legacy-user", "assistant", "tree reply"),
      createTranscriptMessage(
        "orphan-tail",
        "missing-imported-parent",
        "assistant",
        "reachable orphan tail",
      ),
    ]);

    const messages = await readSessionMessagesAsync(sessionId, storePath, undefined, {
      mode: "full",
      reason: "test imported partial tree selection",
    });

    expectMessageContents(messages, ["legacy prompt", "tree reply", "reachable orphan tail"]);
    expectMessageFields(messages[0], { openclaw: { id: "legacy-user", seq: 1 } });
    expectMessageFields(messages[1], { openclaw: { id: "tree-assistant", seq: 2 } });
    expectMessageFields(messages[2], { openclaw: { id: "orphan-tail", seq: 3 } });
  });

  test("keeps legacy async parents when tree transcripts reference pre-v3 rows", async () => {
    const sessionId = "test-session-tree-async-legacy-parent";
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 1, id: sessionId },
      createTranscriptMessage("legacy-user", undefined, "user", "legacy hello"),
      createTranscriptMessage("tree-assistant", "legacy-user", "assistant", "tree hello"),
    ]);

    const messages = await readSessionMessagesAsync(sessionId, storePath, undefined, {
      mode: "full",
      reason: "test legacy parent active tree selection",
    });

    expectMessageContents(messages, ["legacy hello", "tree hello"]);
    expectMessageFields(messages[0], { openclaw: { id: "legacy-user", seq: 1 } });
    expectMessageFields(messages[1], { openclaw: { id: "tree-assistant", seq: 2 } });
  });

  test("caches async transcript indexes by file stats", async () => {
    const sessionId = "test-session-index-cache";
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 1, id: sessionId },
      { message: { role: "user", content: "hello" } },
      { message: { role: "assistant", content: "hi" } },
    ]);
    const read = () =>
      filesystemReader(sessionId, storePath).read({ mode: "full", reason: "index cache test" });
    expect((await read()).messages).toHaveLength(2);

    const openSpy = vi.spyOn(fs, "createReadStream");
    try {
      expect((await read()).messages).toHaveLength(2);
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });

  test("shares concurrent async transcript index builds", async () => {
    const sessionId = "test-session-index-cache-concurrent";
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 1, id: sessionId },
      { message: { role: "user", content: "hello" } },
      { message: { role: "assistant", content: "hi" } },
    ]);

    const openSpy = vi.spyOn(fs, "createReadStream");
    try {
      const snapshots = await Promise.all(
        Array.from({ length: 8 }, () =>
          filesystemReader(sessionId, storePath).read({
            mode: "full",
            reason: "concurrent index cache test",
          }),
        ),
      );
      expect(snapshots.map((snapshot) => snapshot.messages.length)).toEqual(
        Array.from({ length: 8 }, () => 2),
      );
      expect(openSpy).toHaveBeenCalledTimes(1);
    } finally {
      openSpy.mockRestore();
    }
  });

  test("readSessionMessagesAsync recent mode honors byte caps", async () => {
    const sessionId = "test-session-async-recent-mode";
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 1, id: sessionId },
      { message: { role: "user", content: "older" } },
      { message: { role: "assistant", content: "x".repeat(32 * 1024) } },
      { message: { role: "user", content: "latest" } },
    ]);
    const openSpy = vi.spyOn(fs.promises, "open");

    try {
      const messages = await readSessionMessagesAsync(sessionId, storePath, undefined, {
        mode: "recent",
        maxMessages: 1,
        maxBytes: 2048,
      });
      expect(messages).toHaveLength(1);
      expectMessageFields(messages[0], { role: "user", content: "latest" });
      expect(JSON.stringify(messages)).not.toContain("older");
      expect(openSpy).toHaveBeenCalledTimes(1);
    } finally {
      openSpy.mockRestore();
    }
  });

  test("reads only the active branch when transcript rewrites abandon older entries", async () => {
    const sessionId = "test-session-active-branch";
    const recordTimestamp = (second: number) => ({
      record: { timestamp: `2026-04-27T00:00:0${second}.000Z` },
      message: { timestamp: second },
    });
    const sessionFile = writeTranscript(tmpDir, sessionId, [
      {
        type: "session",
        version: 3,
        id: sessionId,
        cwd: tmpDir,
        timestamp: "2026-04-27T00:00:00.000Z",
      },
      createTranscriptMessage(
        "original",
        null,
        "user",
        "Sender: webchat\n\noriginal wrapped prompt",
        recordTimestamp(1),
      ),
      createTranscriptMessage("clean", null, "user", "clean prompt", recordTimestamp(2)),
      createTranscriptMessage(
        "answer",
        "clean",
        "assistant",
        [{ type: "text", text: "clean answer" }],
        {
          record: recordTimestamp(3).record,
          message: {
            ...recordTimestamp(3).message,
            api: "chat",
            provider: "openclaw",
            model: "test",
            usage: {},
            stopReason: "stop",
          },
        },
      ),
      createTranscriptMessage(
        "delivery-side-branch",
        "answer",
        "assistant",
        "side delivery",
        recordTimestamp(4),
      ),
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "delivery-side-branch",
        timestamp: "2026-04-27T00:00:05.000Z",
        targetId: "answer",
      },
    ]);
    const rawTranscript = fs.readFileSync(sessionFile, "utf-8");
    expect(rawTranscript).toContain("original wrapped prompt");
    expect(rawTranscript).toContain("clean prompt");
    const sessionManagerOpenSpy = vi.spyOn(SessionManager, "open");

    try {
      const out = await readSessionMessagesAsync(sessionId, storePath, sessionFile, {
        mode: "full",
        reason: "test",
      });
      expect(out).toHaveLength(2);
      expectMessageFields(out[0], { role: "user", content: "clean prompt", openclaw: { seq: 1 } });
      expectMessageFields(out[1], {
        role: "assistant",
        content: [{ type: "text", text: "clean answer" }],
        openclaw: { seq: 2 },
      });
      expect(JSON.stringify(out)).not.toContain("original wrapped prompt");
      expect(JSON.stringify(out)).not.toContain("side delivery");
      expect(sessionManagerOpenSpy).not.toHaveBeenCalled();
    } finally {
      sessionManagerOpenSpy.mockRestore();
    }
  });

  test.each([
    {
      sessionId: "cross-agent-default-root",
      sessionFileParts: ["agents", "ops", "sessions", "cross-agent-default-root.jsonl"],
      wrongStorePathParts: ["agents", "main", "sessions", "sessions.json"],
      message: { role: "user", content: "from-ops" },
    },
    {
      sessionId: "cross-agent-custom-root",
      sessionFileParts: ["custom", "agents", "ops", "sessions", "cross-agent-custom-root.jsonl"],
      wrongStorePathParts: ["custom", "agents", "main", "sessions", "sessions.json"],
      message: { role: "assistant", content: "from-custom-ops" },
    },
  ] as const)(
    "reads cross-agent absolute sessionFile across store-root layouts for $sessionId",
    async ({ sessionId, sessionFileParts, wrongStorePathParts, message }) => {
      const sessionFile = path.join(tmpDir, ...sessionFileParts);
      const wrongStorePath = path.join(tmpDir, ...wrongStorePathParts);
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(
        sessionFile,
        [
          JSON.stringify({ type: "session", version: 1, id: sessionId }),
          JSON.stringify({ message }),
        ].join("\n"),
        "utf-8",
      );

      const out = await readSessionMessagesAsync(sessionId, wrongStorePath, sessionFile, {
        mode: "full",
        reason: "test",
      });
      expect(out).toHaveLength(1);
      expectMessageFields(out[0], message);
      expect((out[0] as { __openclaw?: { seq?: number } })["__openclaw"]?.seq).toBe(1);
    },
  );

  test("reads only the active SessionManager branch after a transcript rewrite", async () => {
    const sessionId = "branched-session";
    const sessionManager = createFileBackedSessionManagerForTest(tmpDir, tmpDir);
    const decoratedPrompt = 'Sender:\n```json\n{"label":"ui"}\n```\n\nhello';
    const visiblePrompt = "hello";
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: decoratedPrompt }],
      timestamp: 1,
    });
    sessionManager.appendMessage(buildSessionAssistantMessage("old answer", 2));

    const decoratedUser = sessionManager
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "user");
    expect(decoratedUser?.type).toBe("message");
    if (decoratedUser?.parentId) {
      sessionManager.branch(decoratedUser.parentId);
    } else {
      sessionManager.resetLeaf();
    }
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: visiblePrompt }],
      timestamp: 1,
    });
    sessionManager.appendMessage(buildSessionAssistantMessage("old answer", 2));

    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) {
      throw new Error("expected SessionManager to expose a session file");
    }

    const out = await readSessionMessagesAsync(sessionId, storePath, sessionFile, {
      mode: "full",
      reason: "test",
    });

    expect(
      out.map((message) => ({
        role: (message as { role?: string }).role,
        content: (message as { content?: unknown }).content,
      })),
    ).toEqual([
      { role: "user", content: [{ type: "text", text: visiblePrompt }] },
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
    ]);
  });

  test("keeps compaction markers when reading only the active SessionManager branch", async () => {
    const sessionId = "branched-session-with-compaction";
    const sessionFile = writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 1, id: sessionId },
      createTranscriptMessage("user-old", null, "user", "old prompt", {
        message: { timestamp: 1 },
      }),
      createTranscriptMessage("assistant-old", "user-old", "assistant", "old answer", {
        message: { timestamp: 2 },
      }),
      {
        type: "compaction",
        id: "comp-1",
        timestamp: "2026-02-07T00:00:00.000Z",
        summary: "Compacted history",
      },
      createTranscriptMessage("user-active", null, "user", "active prompt", {
        message: { timestamp: 3 },
      }),
      createTranscriptMessage("assistant-active", "user-active", "assistant", "active answer", {
        message: { timestamp: 4 },
      }),
    ]);

    const out = await readSessionMessagesAsync(sessionId, storePath, sessionFile, {
      mode: "full",
      reason: "test",
    });

    expect(
      out.map((message) => ({
        role: (message as { role?: string }).role,
        content: (message as { content?: unknown }).content,
        kind: (message as { __openclaw?: { kind?: string } })["__openclaw"]?.kind,
      })),
    ).toEqual([
      { role: "system", content: [{ type: "text", text: "Compaction" }], kind: "compaction" },
      { role: "user", content: "active prompt", kind: undefined },
      { role: "assistant", content: "active answer", kind: undefined },
    ]);
  });

  test("keeps active-branch compaction markers reachable through pagination", async () => {
    const sessionId = "paginated-branch-with-compaction";
    const sessionFile = writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 3, id: sessionId },
      createTranscriptMessage("old-user", null, "user", "old prompt"),
      createTranscriptMessage("old-assistant", "old-user", "assistant", "old answer"),
      {
        type: "compaction",
        id: "comp-1",
        timestamp: "2026-02-07T00:00:00.000Z",
        summary: "Compacted history",
      },
      createTranscriptMessage("active-user", null, "user", "active prompt"),
      createTranscriptMessage("active-assistant", "active-user", "assistant", "active answer"),
      createTranscriptMessage("side-branch", "active-assistant", "assistant", "side branch"),
      { type: "leaf", id: "active-leaf", parentId: "side-branch", targetId: "active-assistant" },
    ]);
    const newest = await readSessionMessagesPageWithStatsAsync(sessionId, storePath, sessionFile, {
      offset: 0,
      maxMessages: 2,
    });
    const oldest = await readSessionMessagesPageWithStatsAsync(sessionId, storePath, sessionFile, {
      offset: 2,
      maxMessages: 1,
    });

    expect(newest.totalMessages).toBe(3);
    expectMessageFields(newest.messages[0], { content: "active prompt", openclaw: { seq: 2 } });
    expectMessageFields(newest.messages[1], { content: "active answer", openclaw: { seq: 3 } });
    expect(oldest.totalMessages).toBe(3);
    expectMessageFields(oldest.messages[0], {
      role: "system",
      content: [{ type: "text", text: "Compaction" }],
      openclaw: { kind: "compaction", id: "comp-1", seq: 1 },
    });
  });

  test("keeps blocked hook messages on the current active branch", async () => {
    const sessionId = "blocked-hook-branch-session";
    const sessionKey = "agent:main:explicit:blocked-hook-branch";
    const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          sessionFile,
        },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      sessionFile,
      [
        { type: "session", version: 1, id: sessionId },
        {
          type: "message",
          id: "user-1",
          parentId: null,
          message: { role: "user", content: "hello", timestamp: 1 },
        },
        {
          type: "message",
          id: "assistant-1",
          parentId: "user-1",
          message: { role: "assistant", content: "hi", timestamp: 2 },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
      "utf-8",
    );

    const messageId = appendBlockedUserMessageWithSessionManager({
      sessionFile,
      originalText: "[hitl:block] hello",
      redactedText: "Blocked by HITL test hook.",
      pluginId: "hitl-test-hooks",
    });

    expect(messageId).toBeTypeOf("string");
    expect(messageId.length).toBeGreaterThan(0);
    const out = await readSessionMessagesAsync(sessionId, storePath, sessionFile, {
      mode: "full",
      reason: "test",
    });
    expect(
      out.map((message) => ({
        role: (message as { role?: string }).role,
        text: (message as { content?: string | Array<{ text?: string }> }).content,
      })),
    ).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: [{ type: "text", text: "hi" }] },
      { role: "user", text: [{ type: "text", text: "Blocked by HITL test hook." }] },
    ]);
    expect(JSON.stringify(out)).not.toContain("[hitl:block] hello");
    expect(JSON.stringify(out)).not.toContain("matched original");
  });

  test("keeps repeated blocked hook messages together in a new session", async () => {
    const sessionKey = "agent:main:explicit:repeated-blocked-hook";
    const sessionManager = createFileBackedSessionManagerForTest(tmpDir, tmpDir);
    const sessionId = sessionManager.getSessionId();
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) {
      throw new Error("expected a file-backed session manager");
    }
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          sessionFile,
        },
      }),
      "utf-8",
    );

    appendBlockedUserMessage(sessionManager, {
      originalText: "[hitl:block] first",
      redactedText: "Blocked by HITL test hook.",
      pluginId: "hitl-test-hooks",
    });
    appendBlockedUserMessage(sessionManager, {
      originalText: "[hitl:block] second",
      redactedText: "Blocked again by HITL test hook.",
      pluginId: "hitl-test-hooks",
    });

    const out = await readSessionMessagesAsync(sessionId, storePath, sessionFile, {
      mode: "full",
      reason: "test",
    });
    expect(
      out.map((message) => ({
        role: (message as { role?: string }).role,
        text: (message as { content?: Array<{ text?: string }> }).content?.[0]?.text,
      })),
    ).toEqual([
      { role: "user", text: "Blocked by HITL test hook." },
      { role: "user", text: "Blocked again by HITL test hook." },
    ]);
    expect(JSON.stringify(out)).not.toContain("[hitl:block] first");
    expect(JSON.stringify(out)).not.toContain("[hitl:block] second");
    expect(JSON.stringify(out)).not.toContain("matched original");
  });
});

describe("buildSessionPreviewItems", () => {
  function readPreview(lines: string[], maxItems = 3, maxChars = 120) {
    const messages = lines.flatMap((line) => {
      const record = JSON.parse(line) as { message?: unknown };
      return record.message === undefined ? [] : [record.message];
    });
    return buildSessionPreviewItems(messages, maxItems, maxChars);
  }

  test("returns recent preview items with tool summary", () => {
    const sessionId = "preview-session";
    const lines = createToolSummaryPreviewTranscriptLines(sessionId);
    const result = readPreview(lines);

    expect(result.map((item) => item.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(result[1]?.text).toContain("call weather");
  });

  test("detects tool calls from tool_use/tool_call blocks and toolName field", () => {
    const sessionId = "preview-session-tools";
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ message: { role: "assistant", content: "Hi" } }),
      JSON.stringify({
        message: {
          role: "assistant",
          toolName: "camera",
          content: [
            { type: "tool_use", name: "read" },
            { type: "tool_call", name: "write" },
          ],
        },
      }),
      JSON.stringify({ message: { role: "assistant", content: "Done" } }),
    ];
    const result = readPreview(lines);

    expect(result.map((item) => item.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(result[1]?.text).toContain("call");
    expect(result[1]?.text).toContain("camera");
    expect(result[1]?.text).toContain("read");
    // Preview text may not list every tool name; it should at least hint there were multiple calls.
    expect(result[1]?.text).toMatch(/\+\d+/);
  });

  const commentaryText = {
    type: "text",
    text: "thinking like caveman",
    textSignature: JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" }),
  };

  test.each([
    {
      name: "truncates preview text to max chars",
      content: "a".repeat(60),
      maxChars: 24,
      expected: [{ role: "assistant", text: `${"a".repeat(21)}...` }],
    },
    {
      name: "keeps preview text valid when the limit bisects an emoji",
      content: `${"t".repeat(196)}🚀xyz`,
      maxChars: 200,
      expected: [{ role: "assistant", text: `${"t".repeat(196)}...` }],
    },
    {
      name: "strips inline directives from preview items",
      content: "A [[reply_to:abc-123]] B [[audio_as_voice]]",
      maxChars: 120,
      expected: [{ role: "assistant", text: "A  B" }],
    },
    {
      name: "prefers final_answer text for assistant preview items",
      content: [
        commentaryText,
        {
          type: "text",
          text: "Actual final answer",
          textSignature: JSON.stringify({ v: 1, id: "msg_final", phase: "final_answer" }),
        },
      ],
      maxChars: 120,
      expected: [{ role: "assistant", text: "Actual final answer" }],
    },
    {
      name: "hides commentary-only assistant preview items",
      content: [commentaryText],
      maxChars: 120,
      expected: [],
    },
  ])("$name", ({ content, maxChars, expected }) => {
    const line = JSON.stringify({ message: { role: "assistant", content } });
    expect(readPreview([line], 1, maxChars)).toEqual(expected);
  });
});

describe("readLatestSessionUsageFromTranscript", () => {
  let tmpDir: string;
  let storePath: string;

  registerTempSessionStore("openclaw-session-usage-test-", (nextTmpDir, nextStorePath) => {
    tmpDir = nextTmpDir;
    storePath = nextStorePath;
  });

  test("aggregates assistant usage asynchronously without readFileSync", async () => {
    const sessionId = "usage-aggregate-async";
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 1, id: sessionId },
      {
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          usage: {
            input: 1_800,
            output: 400,
            cacheRead: 600,
            cost: { total: 0.0055 },
          },
        },
      },
      {
        message: {
          role: "assistant",
          usage: {
            input: 2_400,
            output: 250,
            cacheRead: 900,
            cost: { total: 0.006 },
          },
        },
      },
    ]);
    const readFileSpy = vi.spyOn(fs, "readFileSync");

    try {
      const snapshot = await readLatestSessionUsageFromTranscriptAsync(sessionId, storePath);
      expectUsageFields(snapshot, {
        modelProvider: "anthropic",
        model: "claude-sonnet-4-6",
        inputTokens: 4200,
        outputTokens: 650,
        cacheRead: 1500,
        totalTokens: 3300,
        totalTokensFresh: true,
      });
      expect(snapshot?.costUsd).toBeCloseTo(0.0115, 8);
      expect(readFileSpy).not.toHaveBeenCalled();
    } finally {
      readFileSpy.mockRestore();
    }
  });

  test("estimates transcript context when local model telemetry is missing", async () => {
    const sessionId = "usage-local-missing-telemetry";
    const userText = "local prompt ".repeat(200);
    const assistantText = "local response ".repeat(120);
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 1, id: sessionId },
      { message: { role: "user", content: userText } },
      {
        message: {
          role: "assistant",
          provider: "openai-completions",
          model: "local-llama",
          content: [{ type: "text", text: assistantText }],
        },
      },
    ]);
    const expectedTotalTokens = estimateTokensFromChars(
      estimateStringChars(userText) + estimateStringChars(assistantText),
    );

    expectUsageFields(await readLatestSessionUsageFromTranscriptAsync(sessionId, storePath), {
      modelProvider: "openai-completions",
      model: "local-llama",
      totalTokens: expectedTotalTokens,
      totalTokensFresh: true,
    });
  });
});

describe("resolveSessionTranscriptCandidates", () => {
  test("fallback candidate uses OPENCLAW_HOME instead of os.homedir()", () => {
    withEnv({ OPENCLAW_HOME: "/srv/openclaw-home", HOME: "/home/other" }, () => {
      const candidates = resolveSessionTranscriptCandidates("sess-1", undefined);
      const fallback = candidates[candidates.length - 1];
      expect(fallback).toBe(
        path.join(path.resolve("/srv/openclaw-home"), ".openclaw", "sessions", "sess-1.jsonl"),
      );
    });
  });
});

describe("resolveSessionTranscriptCandidates safety", () => {
  test.each([
    {
      storePath: "/tmp/openclaw/agents/main/sessions/sessions.json",
      sessionFile: "/tmp/openclaw/agents/ops/sessions/sess-safe.jsonl",
    },
    {
      storePath: "/srv/custom/agents/main/sessions/sessions.json",
      sessionFile: "/srv/custom/agents/ops/sessions/sess-safe.jsonl",
    },
  ] as const)(
    "keeps cross-agent absolute sessionFile candidate for $storePath",
    ({ storePath, sessionFile }) => {
      const candidates = resolveSessionTranscriptCandidates("sess-safe", storePath, sessionFile);
      expect(candidates.map((value) => path.resolve(value))).toContain(path.resolve(sessionFile));
    },
  );

  test("drops unsafe session IDs instead of producing traversal paths", () => {
    const candidates = resolveSessionTranscriptCandidates(
      "../etc/passwd",
      "/tmp/openclaw/agents/main/sessions/sessions.json",
    );

    expect(candidates).toStrictEqual([]);
  });

  test("drops unsafe sessionFile candidates and keeps safe fallbacks", () => {
    const storePath = "/tmp/openclaw/agents/main/sessions/sessions.json";
    const candidates = resolveSessionTranscriptCandidates(
      "sess-safe",
      storePath,
      "../../etc/passwd",
    );
    const normalizedCandidates = candidates.map((value) => path.resolve(value));
    const expectedFallback = path.resolve(path.dirname(storePath), "sess-safe.jsonl");

    expect(candidates.every((candidate) => !candidate.includes("etc/passwd"))).toBe(true);
    expect(normalizedCandidates).toContain(expectedFallback);
  });

  test("prefers the current sessionId transcript before a stale sessionFile candidate", () => {
    const storePath = "/tmp/openclaw/agents/main/sessions/sessions.json";
    const candidates = resolveSessionTranscriptCandidates(
      "11111111-1111-4111-8111-111111111111",
      storePath,
      "/tmp/openclaw/agents/main/sessions/22222222-2222-4222-8222-222222222222.jsonl",
    );

    expect(candidates[0]).toBe(
      path.resolve("/tmp/openclaw/agents/main/sessions/11111111-1111-4111-8111-111111111111.jsonl"),
    );
    expect(candidates).toContain(
      path.resolve("/tmp/openclaw/agents/main/sessions/22222222-2222-4222-8222-222222222222.jsonl"),
    );
  });

  test.each([
    { name: "explicit custom sessionFile", filename: "custom-transcript.jsonl" },
    { name: "custom topic-like transcript paths", filename: "custom-topic-notes.jsonl" },
    {
      name: "forked transcript paths",
      filename: "2026-03-23T16-30-00-000Z_11111111-1111-4111-8111-111111111111.jsonl",
    },
    {
      name: "timestamped custom transcript paths",
      filename: "2026-03-23T16-30-00-000Z_notes.jsonl",
    },
  ])("keeps $name ahead of synthesized fallback", ({ filename }) => {
    const storePath = "/tmp/openclaw/agents/main/sessions/sessions.json";
    const sessionFile = path.join(path.dirname(storePath), filename);
    const candidates = resolveSessionTranscriptCandidates(
      "11111111-1111-4111-8111-111111111111",
      storePath,
      sessionFile,
    );
    expect(candidates[0]).toBe(path.resolve(sessionFile));
  });

  test("still treats generated topic transcripts from another session as stale", () => {
    const storePath = "/tmp/openclaw/agents/main/sessions/sessions.json";
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const staleSessionFile =
      "/tmp/openclaw/agents/main/sessions/22222222-2222-4222-8222-222222222222-topic-thread.jsonl";
    const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, staleSessionFile);

    expect(candidates[0]).toBe(
      path.resolve("/tmp/openclaw/agents/main/sessions/11111111-1111-4111-8111-111111111111.jsonl"),
    );
    expect(candidates).toContain(path.resolve(staleSessionFile));
  });
});

describe("oversized transcript line guards", () => {
  let tmpDir: string;
  let storePath: string;

  registerTempSessionStore("openclaw-session-fs-oversized-", (nextTmpDir, nextStorePath) => {
    tmpDir = nextTmpDir;
    storePath = nextStorePath;
  });

  test("readRecentSessionMessagesAsync replaces oversized JSONL lines with placeholders", async () => {
    const sessionId = "test-oversized-recent";
    const oversizedContent = "x".repeat(300 * 1024);
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 1, id: sessionId },
      { message: { role: "user", content: "start" } },
      { message: { role: "assistant", content: oversizedContent } },
      { message: { role: "user", content: "after oversized" } },
    ]);

    const out = await readRecentSessionMessagesAsync(sessionId, storePath, undefined, {
      maxMessages: 10,
    });

    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(oversizedContent);
    expect(serialized).toContain("[chat.history omitted: message too large]");
    expect(serialized).toContain("after oversized");
  });

  test.each([
    {
      name: "native image data",
      image: (data: string) => ({ type: "image", mimeType: "image/png", data }),
    },
    {
      name: "native image data before type",
      image: (data: string) => ({ data, mimeType: "image/png", type: "image" }),
    },
    {
      name: "Anthropic image source",
      image: (data: string) => ({
        type: "image",
        source: { type: "base64", media_type: "image/png", data },
      }),
    },
    {
      name: "Anthropic image source before type",
      image: (data: string) => ({
        source: { type: "base64", media_type: "image/png", data },
        type: "image",
      }),
    },
    {
      name: "Anthropic image source before cache control and type",
      image: (data: string) => ({
        source: { type: "base64", media_type: "image/png", data },
        cache_control: { type: "ephemeral" },
        type: "image",
      }),
    },
    {
      name: "native and Anthropic image payloads together",
      image: (data: string) => ({
        type: "image",
        data,
        source: { type: "base64", media_type: "image/png", data },
      }),
    },
  ])("preserves recoverable reset-archive text around oversized $name", async ({ name, image }) => {
    const sessionId = `test-oversized-archive-${name.replaceAll(" ", "-")}`;
    const png = createNoisyPngBuffer(320, 320);
    const encoded = png.toString("base64");
    writeResetArchive(tmpDir, sessionId, "2026-07-12T18-00-00.000Z", [
      { type: "session", version: 3, id: sessionId },
      createTranscriptMessage("archived-image", null, "user", [
        { type: "text", text: "keep prefix text" },
        image(encoded),
        { type: "text", text: "keep suffix text" },
      ]),
    ]);

    const messages = projectChatDisplayMessages(
      await readRecentSessionMessagesAsync(sessionId, storePath, undefined, {
        maxMessages: 10,
        allowResetArchiveFallback: true,
        resetArchiveOnly: true,
      }),
    );

    expect(messages).toMatchObject([
      {
        role: "user",
        content: [
          { type: "text", text: "keep prefix text" },
          { type: "image", omitted: true, bytes: png.length },
          { type: "text", text: "keep suffix text" },
        ],
        __openclaw: { id: "archived-image" },
      },
    ]);
    expect(JSON.stringify(messages)).not.toContain(encoded);
    if (name.includes("cache control")) {
      expect(JSON.stringify(messages)).toContain('"cache_control":{"type":"ephemeral"}');
    }

    const singleMessage = await filesystemReader(sessionId, storePath).readById("archived-image", {
      allowResetArchiveFallback: true,
      resetArchiveOnly: true,
    });
    expect(singleMessage).toMatchObject({
      found: true,
      oversized: false,
      message: {
        role: "user",
        content: [
          { type: "text", text: "keep prefix text" },
          { type: "image", omitted: true, bytes: png.length },
          { type: "text", text: "keep suffix text" },
        ],
      },
    });
  });

  test("omits every image even when its data is distant from its type", async () => {
    const sessionId = "test-oversized-distant-image";
    const privateImage = Buffer.from("private-image-payload");
    const privateEncoded = privateImage.toString("base64");
    const largeImage = createNoisyPngBuffer(320, 320);
    const largeEncoded = largeImage.toString("base64");
    writeResetArchive(tmpDir, sessionId, "2026-07-12T18-00-00.000Z", [
      { type: "session", version: 3, id: sessionId },
      createTranscriptMessage("distant-image", null, "user", [
        { type: "text", text: "keep prefix text" },
        {
          type: "image",
          metadata: { caption: "x".repeat(70 * 1024) },
          data: privateEncoded,
        },
        { type: "image", data: largeEncoded },
        { type: "text", text: "keep suffix text" },
      ]),
    ]);

    const reader = filesystemReader(sessionId, storePath);
    const messages = await reader.read({
      mode: "recent",
      maxMessages: 10,
      allowResetArchiveFallback: true,
      resetArchiveOnly: true,
    });
    const singleMessage = await reader.readById("distant-image", {
      allowResetArchiveFallback: true,
      resetArchiveOnly: true,
    });

    for (const message of [messages.messages[0], singleMessage.message]) {
      expect(message).toMatchObject({
        content: [
          { type: "text", text: "keep prefix text" },
          { type: "image", omitted: true, bytes: privateImage.length },
          { type: "image", omitted: true, bytes: largeImage.length },
          { type: "text", text: "keep suffix text" },
        ],
      });
      expect(JSON.stringify(message)).not.toContain(privateEncoded);
      expect(JSON.stringify(message)).not.toContain(largeEncoded);
    }
    expect(singleMessage).toMatchObject({ found: true, oversized: false });
  });

  test("preserves image metadata data while omitting the actual image payload", async () => {
    const sessionId = "test-oversized-image-metadata";
    const image = createNoisyPngBuffer(320, 320);
    const encoded = image.toString("base64");
    const metadata = { data: Buffer.from("notes").toString("base64") };
    writeResetArchive(tmpDir, sessionId, "2026-07-12T18-00-00.000Z", [
      { type: "session", version: 3, id: sessionId },
      createTranscriptMessage("image-metadata", null, "user", [
        { type: "text", text: "keep prefix text" },
        { type: "image", metadata, data: encoded },
        { type: "text", text: "keep suffix text" },
      ]),
    ]);

    const messages = await readRecentSessionMessagesAsync(sessionId, storePath, undefined, {
      maxMessages: 10,
      allowResetArchiveFallback: true,
      resetArchiveOnly: true,
    });

    expect(messages).toMatchObject([
      {
        content: [
          { type: "text", text: "keep prefix text" },
          { type: "image", metadata, omitted: true, bytes: image.length },
          { type: "text", text: "keep suffix text" },
        ],
      },
    ]);
    expect(JSON.stringify(messages)).not.toContain(encoded);
  });

  test.each([
    {
      name: "text document",
      document: { type: "document", source: { type: "text", data: "notes" } },
    },
    {
      name: "base64 PDF document",
      document: {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: Buffer.from("%PDF-1.4\nexample").toString("base64"),
        },
      },
    },
  ])("preserves a $name preceding an oversized image", async ({ name, document }) => {
    const sessionId = `test-oversized-mixed-${name.replaceAll(" ", "-")}`;
    const png = createNoisyPngBuffer(320, 320);
    const encoded = png.toString("base64");
    writeResetArchive(tmpDir, sessionId, "2026-07-12T18-00-00.000Z", [
      { type: "session", version: 3, id: sessionId },
      createTranscriptMessage("archived-mixed", null, "user", [
        document,
        { type: "text", text: "keep prefix text" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: encoded } },
        { type: "text", text: "keep suffix text" },
      ]),
    ]);

    const messages = projectChatDisplayMessages(
      await readRecentSessionMessagesAsync(sessionId, storePath, undefined, {
        maxMessages: 10,
        allowResetArchiveFallback: true,
        resetArchiveOnly: true,
      }),
    );

    expect(messages).toMatchObject([
      {
        role: "user",
        content: [
          document,
          { type: "text", text: "keep prefix text" },
          { type: "image", omitted: true, bytes: png.length },
          { type: "text", text: "keep suffix text" },
        ],
      },
    ]);
    expect(JSON.stringify(messages)).not.toContain(encoded);
  });

  test("keeps oversized fallback when recovered JSON numbers expand after parsing", async () => {
    const sessionId = "test-oversized-expanded-json";
    const encoded = createNoisyPngBuffer(320, 320).toString("base64");
    const archivePath = writeResetArchive(tmpDir, sessionId, "2026-07-12T18-00-00.000Z", [
      { type: "session", version: 3, id: sessionId },
      createTranscriptMessage(
        "expanded-json",
        null,
        "user",
        [
          { type: "text", text: "keep prefix text" },
          { type: "image", data: encoded },
        ],
        { message: { compactNumbers: "__OPENCLAW_COMPACT_NUMBERS__" } },
      ),
    ]);
    const compactNumbers = Array.from({ length: 13_000 }, () => "1e20").join(",");
    const archive = fs.readFileSync(archivePath, "utf8");
    fs.writeFileSync(
      archivePath,
      archive.replace('"__OPENCLAW_COMPACT_NUMBERS__"', `[${compactNumbers}]`),
      "utf8",
    );

    const messages = await readRecentSessionMessagesAsync(sessionId, storePath, undefined, {
      maxMessages: 10,
      allowResetArchiveFallback: true,
      resetArchiveOnly: true,
    });

    expect(messages).toMatchObject([
      {
        content: [{ type: "text", text: "[chat.history omitted: message too large]" }],
        __openclaw: { id: "expanded-json", truncated: true, reason: "oversized" },
      },
    ]);
    expect(
      await filesystemReader(sessionId, storePath).readById("expanded-json", {
        allowResetArchiveFallback: true,
        resetArchiveOnly: true,
      }),
    ).toMatchObject({ found: true, oversized: true });
  });

  test("rejects JSON-escaped transcript recovery marker collisions", async () => {
    const sessionId = "test-oversized-escaped-marker";
    const encoded = createNoisyPngBuffer(320, 320).toString("base64");
    const archivePath = writeResetArchive(tmpDir, sessionId, "2026-07-12T18-00-00.000Z", [
      { type: "session", version: 3, id: sessionId },
      createTranscriptMessage("escaped-marker", null, "user", [
        { type: "text", text: "__MARKER_SPOOF__" },
        { type: "image", data: encoded },
      ]),
    ]);
    const archive = fs.readFileSync(archivePath, "utf8");
    fs.writeFileSync(
      archivePath,
      archive.replace('"__MARKER_SPOOF__"', '"\\u005f_openclaw_omitted_image_0__"'),
      "utf8",
    );

    const messages = await readRecentSessionMessagesAsync(sessionId, storePath, undefined, {
      maxMessages: 10,
      allowResetArchiveFallback: true,
      resetArchiveOnly: true,
    });

    expect(messages).toMatchObject([
      {
        content: [{ type: "text", text: "[chat.history omitted: message too large]" }],
        __openclaw: { id: "escaped-marker", truncated: true, reason: "oversized" },
      },
    ]);
    expect(
      await filesystemReader(sessionId, storePath).readById("escaped-marker", {
        allowResetArchiveFallback: true,
        resetArchiveOnly: true,
      }),
    ).toMatchObject({ found: true, oversized: true });
  });

  test.each([
    {
      name: "unrelated oversized data",
      content: (data: string) => [{ type: "document", source: { type: "base64", data } }],
    },
    {
      name: "unrelated oversized image metadata",
      content: (data: string) => [{ type: "image", metadata: { data } }],
    },
    {
      name: "URL image source with oversized data",
      content: (data: string) => [
        { type: "image", source: { type: "url", url: "https://example.invalid/image", data } },
      ],
    },
    {
      name: "malformed image base64",
      content: (data: string) => [{ type: "image", data: `${data.slice(0, -1)}!` }],
    },
    {
      name: "oversized non-image residual",
      content: (data: string) => [
        { type: "image", data },
        { type: "text", text: "x".repeat(300 * 1024) },
      ],
    },
    {
      name: "oversized unrelated data after a small image",
      content: (data: string) => [
        { type: "image", data: "aGVsbG8=" },
        { type: "document", data },
      ],
    },
    {
      name: "too many image candidates",
      content: (data: string) => [
        ...Array.from({ length: 33 }, () => ({ type: "image", data: "aGVsbG8=" })),
        { type: "image", data },
      ],
    },
  ])("keeps the existing oversized fallback for $name", async ({ name, content }) => {
    const sessionId = `test-oversized-adversarial-${name.replaceAll(" ", "-")}`;
    const encoded = createNoisyPngBuffer(320, 320).toString("base64");
    writeResetArchive(tmpDir, sessionId, "2026-07-12T18-00-00.000Z", [
      { type: "session", version: 3, id: sessionId },
      createTranscriptMessage("adversarial-image", null, "user", content(encoded)),
    ]);

    const messages = await readRecentSessionMessagesAsync(sessionId, storePath, undefined, {
      maxMessages: 10,
      allowResetArchiveFallback: true,
      resetArchiveOnly: true,
    });

    expect(messages).toMatchObject([
      {
        role: "user",
        content: [{ type: "text", text: "[chat.history omitted: message too large]" }],
        __openclaw: { id: "adversarial-image", truncated: true, reason: "oversized" },
      },
    ]);
    expect(JSON.stringify(messages)).not.toContain(encoded);
    expect(
      await filesystemReader(sessionId, storePath).readById("adversarial-image", {
        allowResetArchiveFallback: true,
        resetArchiveOnly: true,
      }),
    ).toMatchObject({ found: true, oversized: true });
  });

  test("readRecentSessionMessagesAsync keeps oversized active-tree leaves", async () => {
    const sessionId = "test-oversized-tree-tail";
    const oversizedContent = "z".repeat(300 * 1024);
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 3, id: sessionId },
      createTranscriptMessage("root", null, "user", "root"),
      createTranscriptMessage("oversized-leaf", "root", "assistant", oversizedContent),
    ]);

    const out = await readRecentSessionMessagesAsync(sessionId, storePath, undefined, {
      maxMessages: 10,
    });

    const serialized = JSON.stringify(out);
    expect(serialized).toContain("root");
    expect(serialized).toContain("oversized-leaf");
    expect(serialized).not.toContain(oversizedContent);
    expect(serialized).toContain("[chat.history omitted: message too large]");
  });

  test.each([
    {
      name: "recent reads stay bounded when a leaf target is outside the tail window",
      sessionId: "test-leaf-target-before-tail-window",
      sideRecords: [
        createTranscriptMessage("side-delivery", "active-root", "assistant", "x".repeat(16 * 1024)),
      ],
    },
    {
      name: "bounded recent reads do not expose a compact inactive side message",
      sessionId: "test-compact-side-before-bounded-leaf-target",
      sideRecords: [
        {
          type: "metadata",
          id: "large-padding",
          parentId: "active-root",
          payload: { padding: "x".repeat(16 * 1024) },
        },
        createTranscriptMessage(
          "side-delivery",
          "active-root",
          "assistant",
          "compact side delivery",
        ),
      ],
    },
  ])("$name", async ({ sessionId, sideRecords }) => {
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 3, id: sessionId },
      createTranscriptMessage("active-root", null, "user", "active root"),
      ...sideRecords,
      { type: "leaf", id: "active-leaf", parentId: "side-delivery", targetId: "active-root" },
    ]);
    const readFileSpy = vi.spyOn(fs, "readFileSync");
    try {
      await expect(
        readRecentSessionMessagesAsync(sessionId, storePath, undefined, {
          maxMessages: 10,
          maxBytes: 1024,
          maxLines: 10,
        }),
      ).resolves.toEqual([]);
      expect(readFileSpy).not.toHaveBeenCalled();
    } finally {
      readFileSpy.mockRestore();
    }
  });

  test("oversized line metadata extraction preserves id and parentId", async () => {
    const sessionId = "test-oversized-metadata-extract";
    const timestamp = "2026-05-16T16:00:33.000Z";
    const oversizedContent = "w".repeat(300 * 1024);
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 3, id: sessionId },
      createTranscriptMessage("root-msg", null, "user", "root"),
      createTranscriptMessage("oversized-child", "root-msg", "assistant", oversizedContent, {
        record: { timestamp },
        message: { idempotencyKey: "oversized-key" },
      }),
    ]);

    const out = await readRecentSessionMessagesAsync(sessionId, storePath, undefined, {
      maxMessages: 10,
    });

    // The oversized line's id and parentId are extracted by regex from the
    // prefix bytes. parentId drives active-tree selection; id is attached
    // to the __openclaw metadata. Both must be correct for the record to
    // appear in the right position.
    expect(out).toHaveLength(2); // root-msg + oversized-child
    const oversized = out[1] as Record<string, unknown>;
    expect(oversized.role).toBe("assistant");
    // id is preserved in __openclaw transcript metadata
    const meta = (oversized as Record<string, Record<string, unknown>>)["__openclaw"];
    expect(meta?.id).toBe("oversized-child");
    expect(meta?.idempotencyKey).toBe("oversized-key");
    expect(meta?.recordTimestampMs).toBe(Date.parse(timestamp));
    // parentId extraction is proven by the record being included:
    // if parentId was not extracted, the tree would orphan this node.

    // The oversized content must NOT appear in the output.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(oversizedContent);
  });

  test("readSessionMessagesAsync keeps id-less oversized message placeholders", async () => {
    const sessionId = "test-oversized-idless-async";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const oversizedContent = "w".repeat(300 * 1024);
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        message: { role: "assistant", content: oversizedContent },
      })}\n`,
      "utf-8",
    );

    const out = await readSessionMessagesAsync(sessionId, storePath, undefined, {
      mode: "full",
      reason: "test",
    });

    expect(out).toHaveLength(1);
    const serialized = JSON.stringify(out);
    expect(serialized).toContain("[chat.history omitted: message too large]");
    expect(serialized).not.toContain(oversizedContent);
  });
});

describe("short read resilience", () => {
  let tmpDir: string;
  let storePath: string;

  registerTempSessionStore("openclaw-short-read-test-", (nextTmpDir, nextStorePath) => {
    tmpDir = nextTmpDir;
    storePath = nextStorePath;
  });

  test("readRecentSessionMessagesAsync survives 16-byte tail read caps", async () => {
    const sessionId = "test-short-read-recent";
    const lines = [
      { type: "session", version: 1, id: sessionId },
      ...Array.from({ length: 30 }, (_, i) => ({
        message: {
          role: i % 2 ? "assistant" : "user",
          content: `message ${i}: ${"data ".repeat(80)}`,
        },
      })),
    ];
    writeTranscript(tmpDir, sessionId, lines);

    const expected = await readRecentSessionMessagesAsync(sessionId, storePath, undefined, {
      maxMessages: 20,
      maxBytes: 8192,
    });
    const getShortReadCalls = installAsyncPositionalShortReadProxy(16);
    try {
      const actual = await readRecentSessionMessagesAsync(sessionId, storePath, undefined, {
        maxMessages: 20,
        maxBytes: 8192,
      });
      expect(actual).toEqual(expected);
      expect(getShortReadCalls()).toBeGreaterThan(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  test("readRecentSessionMessagesAsync honors maxBytes under short reads", async () => {
    const sessionId = "test-short-read-byte-cap";
    const lines = [
      { type: "session", version: 1, id: sessionId },
      ...Array.from({ length: 20 }, (_, i) => ({
        message: {
          role: i % 2 ? "assistant" : "user",
          content: `line ${String(i).padStart(2, "0")}: ${"payload ".repeat(30)}`,
        },
      })),
    ];
    writeTranscript(tmpDir, sessionId, lines);

    const normal = await readRecentSessionMessagesAsync(sessionId, storePath, undefined, {
      maxMessages: 20,
      maxBytes: 4096,
    });

    const getShortReadCalls = installAsyncPositionalShortReadProxy(64);
    try {
      const short = await readRecentSessionMessagesAsync(sessionId, storePath, undefined, {
        maxMessages: 20,
        maxBytes: 4096,
      });
      expect(short).toEqual(normal);
      expect(getShortReadCalls()).toBeGreaterThan(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
