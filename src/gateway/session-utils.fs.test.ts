import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createToolSummaryPreviewTranscriptLines } from "./session-preview.test-helpers.js";
import { clearSessionTranscriptIndexCache } from "./session-transcript-index.fs.js";
import {
  archiveSessionTranscripts,
  readFirstUserMessageFromTranscript,
  readLastMessagePreviewFromTranscript,
  readLatestSessionUsageFromTranscript,
  readLatestSessionUsageFromTranscriptAsync,
  readLatestRecentSessionUsageFromTranscriptAsync,
  readRecentSessionUsageFromTranscriptAsync,
  readRecentSessionUsageFromTranscript,
  readRecentSessionMessagesAsync,
  readRecentSessionMessages,
  readRecentSessionMessagesWithStatsAsync,
  readRecentSessionMessagesWithStats,
  readRecentSessionTranscriptLines,
  readSessionMessageCountAsync,
  readSessionMessageCount,
  readSessionMessagesAsync,
  readSessionMessages,
  readSessionTitleFieldsFromTranscript,
  readSessionTitleFieldsFromTranscriptAsync,
  readSessionPreviewItemsFromTranscript,
  resolveSessionTranscriptCandidates,
} from "./session-utils.fs.js";

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

function appendBlockedUserMessageWithSessionManager(params: {
  sessionFile: string;
  originalText?: string;
  redactedText: string;
  pluginId: string;
  idempotencyKey?: string;
}): string {
  const sessionManager = SessionManager.open(params.sessionFile, path.dirname(params.sessionFile));
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
  (sessionManager as unknown as { _rewriteFile?: () => void })._rewriteFile?.();
  return messageId;
}

function buildBasicSessionTranscript(
  sessionId: string,
  userText = "Hello world",
  assistantText = "Hi there",
): unknown[] {
  return [
    { type: "session", version: 1, id: sessionId },
    { message: { role: "user", content: userText } },
    { message: { role: "assistant", content: assistantText } },
  ];
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
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
    const metadata = requireRecord(record.__openclaw, "message metadata");
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

describe("readFirstUserMessageFromTranscript", () => {
  let tmpDir: string;
  let storePath: string;

  registerTempSessionStore("openclaw-session-fs-test-", (nextTmpDir, nextStorePath) => {
    tmpDir = nextTmpDir;
    storePath = nextStorePath;
  });

  test.each([
    {
      sessionId: "test-session-1",
      lines: [
        JSON.stringify({ type: "session", version: 1, id: "test-session-1" }),
        JSON.stringify({ message: { role: "user", content: "Hello world" } }),
        JSON.stringify({ message: { role: "assistant", content: "Hi there" } }),
      ],
      expected: "Hello world",
    },
    {
      sessionId: "test-session-2",
      lines: [
        JSON.stringify({ type: "session", version: 1, id: "test-session-2" }),
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: "Array message content" }],
          },
        }),
      ],
      expected: "Array message content",
    },
    {
      sessionId: "test-session-2b",
      lines: [
        JSON.stringify({ type: "session", version: 1, id: "test-session-2b" }),
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "input_text", text: "Input text content" }],
          },
        }),
      ],
      expected: "Input text content",
    },
  ] as const)("extracts first user text for $sessionId", ({ sessionId, lines, expected }) => {
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");
    const result = readFirstUserMessageFromTranscript(sessionId, storePath);
    expect(result, sessionId).toBe(expected);
  });
  test("skips non-user messages to find first user message", () => {
    const sessionId = "test-session-3";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ message: { role: "system", content: "System prompt" } }),
      JSON.stringify({ message: { role: "assistant", content: "Greeting" } }),
      JSON.stringify({ message: { role: "user", content: "First user question" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readFirstUserMessageFromTranscript(sessionId, storePath);
    expect(result).toBe("First user question");
  });

  test("skips inter-session user messages by default", () => {
    const sessionId = "test-session-inter-session";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({
        message: {
          role: "user",
          content: "Forwarded by session tool",
          provenance: { kind: "inter_session", sourceTool: "sessions_send" },
        },
      }),
      JSON.stringify({
        message: { role: "user", content: "Real user message" },
      }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readFirstUserMessageFromTranscript(sessionId, storePath);
    expect(result).toBe("Real user message");
  });

  test("returns null when no user messages exist", () => {
    const sessionId = "test-session-4";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ message: { role: "system", content: "System prompt" } }),
      JSON.stringify({ message: { role: "assistant", content: "Greeting" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readFirstUserMessageFromTranscript(sessionId, storePath);
    expect(result).toBeNull();
  });

  test("handles malformed JSON lines gracefully", () => {
    const sessionId = "test-session-5";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      "not valid json",
      JSON.stringify({ message: { role: "user", content: "Valid message" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readFirstUserMessageFromTranscript(sessionId, storePath);
    expect(result).toBe("Valid message");
  });

  test("returns null for empty content", () => {
    const sessionId = "test-session-8";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ message: { role: "user", content: "" } }),
      JSON.stringify({ message: { role: "user", content: "Second message" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readFirstUserMessageFromTranscript(sessionId, storePath);
    expect(result).toBe("Second message");
  });
});

describe("readLastMessagePreviewFromTranscript", () => {
  let tmpDir: string;
  let storePath: string;

  registerTempSessionStore("openclaw-session-fs-test-", (nextTmpDir, nextStorePath) => {
    tmpDir = nextTmpDir;
    storePath = nextStorePath;
  });

  test("returns null for empty file", () => {
    const sessionId = "test-last-empty";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, "", "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBeNull();
  });

  test.each([
    {
      sessionId: "test-last-user",
      lines: [
        JSON.stringify({ message: { role: "user", content: "First user" } }),
        JSON.stringify({ message: { role: "assistant", content: "First assistant" } }),
        JSON.stringify({ message: { role: "user", content: "Last user message" } }),
      ],
      expected: "Last user message",
    },
    {
      sessionId: "test-last-assistant",
      lines: [
        JSON.stringify({ message: { role: "user", content: "User question" } }),
        JSON.stringify({ message: { role: "assistant", content: "Final assistant reply" } }),
      ],
      expected: "Final assistant reply",
    },
  ] as const)(
    "returns the last user or assistant message from transcript for $sessionId",
    ({ sessionId, lines, expected }) => {
      const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
      fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");
      const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
      expect(result).toBe(expected);
    },
  );

  test("skips system messages to find last user/assistant", () => {
    const sessionId = "test-last-skip-system";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ message: { role: "user", content: "Real last" } }),
      JSON.stringify({ message: { role: "system", content: "System at end" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBe("Real last");
  });

  test("returns null when no user/assistant messages exist", () => {
    const sessionId = "test-last-no-match";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ message: { role: "system", content: "Only system" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBeNull();
  });

  test("handles malformed JSON lines gracefully (last preview)", () => {
    const sessionId = "test-last-malformed";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ message: { role: "user", content: "Valid first" } }),
      "not valid json at end",
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBe("Valid first");
  });

  test.each([
    {
      sessionId: "test-last-array",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Array content response" }],
      },
      expected: "Array content response",
    },
    {
      sessionId: "test-last-output-text",
      message: {
        role: "assistant",
        content: [{ type: "output_text", text: "Output text response" }],
      },
      expected: "Output text response",
    },
  ] as const)(
    "handles array/output_text content format for $sessionId",
    ({ sessionId, message, expected }) => {
      const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
      fs.writeFileSync(transcriptPath, JSON.stringify({ message }), "utf-8");
      const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
      expect(result, sessionId).toBe(expected);
    },
  );

  test("skips empty content to find previous message", () => {
    const sessionId = "test-last-skip-empty";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ message: { role: "assistant", content: "Has content" } }),
      JSON.stringify({ message: { role: "user", content: "" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBe("Has content");
  });

  test("reads from end of large file (16KB window)", () => {
    const sessionId = "test-last-large";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const padding = JSON.stringify({ message: { role: "user", content: "x".repeat(500) } });
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) {
      lines.push(padding);
    }
    lines.push(JSON.stringify({ message: { role: "assistant", content: "Last in large file" } }));
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBe("Last in large file");
  });

  test("handles valid UTF-8 content", () => {
    const sessionId = "test-last-utf8";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const validLine = JSON.stringify({
      message: { role: "user", content: "Valid UTF-8: 你好世界 🌍" },
    });
    fs.writeFileSync(transcriptPath, validLine, "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBe("Valid UTF-8: 你好世界 🌍");
  });

  test("strips inline directives from last preview text", () => {
    const sessionId = "test-last-strip-inline-directives";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({
        message: {
          role: "assistant",
          content: "Hello [[reply_to_current]] world [[audio_as_voice]]",
        },
      }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

    const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
    expect(result).toBe("Hello  world");
  });
});

describe("shared transcript read behaviors", () => {
  let tmpDir: string;
  let storePath: string;

  registerTempSessionStore("openclaw-session-fs-test-", (nextTmpDir, nextStorePath) => {
    tmpDir = nextTmpDir;
    storePath = nextStorePath;
  });

  test("returns null for missing transcript files", () => {
    expect(readFirstUserMessageFromTranscript("missing-session", storePath)).toBeNull();
    expect(readLastMessagePreviewFromTranscript("missing-session", storePath)).toBeNull();
  });

  test("uses sessionFile overrides when provided", () => {
    const sessionId = "test-shared-custom";
    const firstPath = path.join(tmpDir, "custom-first.jsonl");
    const lastPath = path.join(tmpDir, "custom-last.jsonl");

    fs.writeFileSync(
      firstPath,
      [
        JSON.stringify({ type: "session", version: 1, id: sessionId }),
        JSON.stringify({ message: { role: "user", content: "Custom file message" } }),
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      lastPath,
      JSON.stringify({ message: { role: "assistant", content: "Custom file last" } }),
      "utf-8",
    );

    expect(readFirstUserMessageFromTranscript(sessionId, storePath, firstPath)).toBe(
      "Custom file message",
    );
    expect(readLastMessagePreviewFromTranscript(sessionId, storePath, lastPath)).toBe(
      "Custom file last",
    );
  });

  test("trims whitespace in extracted previews", () => {
    const firstSessionId = "test-shared-first-trim";
    const lastSessionId = "test-shared-last-trim";

    fs.writeFileSync(
      path.join(tmpDir, `${firstSessionId}.jsonl`),
      JSON.stringify({ message: { role: "user", content: "  Padded message  " } }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tmpDir, `${lastSessionId}.jsonl`),
      JSON.stringify({ message: { role: "assistant", content: "  Padded response  " } }),
      "utf-8",
    );

    expect(readFirstUserMessageFromTranscript(firstSessionId, storePath)).toBe("Padded message");
    expect(readLastMessagePreviewFromTranscript(lastSessionId, storePath)).toBe("Padded response");
  });
});

describe("readSessionTitleFieldsFromTranscript cache", () => {
  let tmpDir: string;
  let storePath: string;

  registerTempSessionStore("openclaw-session-fs-test-", (nextTmpDir, nextStorePath) => {
    tmpDir = nextTmpDir;
    storePath = nextStorePath;
  });

  test("returns cached values without re-reading when unchanged", () => {
    const sessionId = "test-cache-1";
    writeTranscript(tmpDir, sessionId, buildBasicSessionTranscript(sessionId));

    const readSpy = vi.spyOn(fs, "readSync");

    const first = readSessionTitleFieldsFromTranscript(sessionId, storePath);
    const readsAfterFirst = readSpy.mock.calls.length;
    expect(readsAfterFirst).toBeGreaterThan(0);

    const second = readSessionTitleFieldsFromTranscript(sessionId, storePath);
    expect(second).toEqual(first);
    expect(readSpy.mock.calls.length).toBe(readsAfterFirst);
    readSpy.mockRestore();
  });

  test("invalidates cache when transcript changes", () => {
    const sessionId = "test-cache-2";
    const transcriptPath = writeTranscript(
      tmpDir,
      sessionId,
      buildBasicSessionTranscript(sessionId, "First", "Old"),
    );

    const readSpy = vi.spyOn(fs, "readSync");

    const first = readSessionTitleFieldsFromTranscript(sessionId, storePath);
    const readsAfterFirst = readSpy.mock.calls.length;
    expect(first.lastMessagePreview).toBe("Old");

    fs.appendFileSync(
      transcriptPath,
      `\n${JSON.stringify({ message: { role: "assistant", content: "New" } })}`,
      "utf-8",
    );

    const second = readSessionTitleFieldsFromTranscript(sessionId, storePath);
    expect(second.lastMessagePreview).toBe("New");
    expect(readSpy.mock.calls.length).toBeGreaterThan(readsAfterFirst);
    readSpy.mockRestore();
  });

  test("keeps async title extraction bounded like the sync path", async () => {
    const sessionId = "test-cache-async-bounded";
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 1, id: sessionId },
      ...Array.from({ length: 30 }, (_, index) => ({
        message: { role: "assistant", content: `filler ${index} ${"x".repeat(512)}` },
      })),
      { message: { role: "user", content: "late title should not require a full scan" } },
      { message: { role: "assistant", content: "tail preview" } },
    ]);

    await expect(readSessionTitleFieldsFromTranscriptAsync(sessionId, storePath)).resolves.toEqual({
      firstUserMessage: null,
      lastMessagePreview: "tail preview",
    });
  });
});

describe("readSessionMessages", () => {
  let tmpDir: string;
  let storePath: string;

  registerTempSessionStore("openclaw-session-fs-test-", (nextTmpDir, nextStorePath) => {
    tmpDir = nextTmpDir;
    storePath = nextStorePath;
  });

  test("includes synthetic compaction markers for compaction entries", () => {
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

    const out = readSessionMessages(sessionId, storePath);
    expect(out).toHaveLength(3);
    const marker = out[1] as {
      role: string;
      content?: Array<{ text?: string }>;
      __openclaw?: { kind?: string; id?: string };
      timestamp?: number;
    };
    expect(marker.role).toBe("system");
    expect(marker.content?.[0]?.text).toBe("Compaction");
    expect(marker.__openclaw?.kind).toBe("compaction");
    expect(marker.__openclaw?.id).toBe("comp-1");
    expect(typeof marker.timestamp).toBe("number");
  });

  test("reads recent messages from the transcript tail without loading the whole file", () => {
    const sessionId = "test-session-recent-tail";
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 1, id: sessionId },
      { message: { role: "user", content: "old" } },
      { message: { role: "assistant", content: "middle" } },
      { message: { role: "user", content: "recent" } },
      { message: { role: "assistant", content: "latest" } },
    ]);

    const out = readRecentSessionMessages(sessionId, storePath, undefined, {
      maxMessages: 2,
      maxBytes: 1024,
    });

    expect(out).toHaveLength(2);
    expectMessageFields(out[0], { role: "user", content: "recent", openclaw: { seq: 3 } });
    expectMessageFields(out[1], { role: "assistant", content: "latest", openclaw: { seq: 4 } });
  });

  test("bounds recent-message reads for large append-only transcripts", () => {
    const sessionId = "test-session-recent-large";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      ...Array.from({ length: 2500 }, (_, index) =>
        JSON.stringify({
          message: {
            role: index % 2 === 0 ? "user" : "assistant",
            content: `message ${index} ${"x".repeat(700)}`,
          },
        }),
      ),
      JSON.stringify({ message: { role: "assistant", content: "tail" } }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");
    const readFileSpy = vi.spyOn(fs, "readFileSync");

    try {
      const out = readRecentSessionMessages(sessionId, storePath, undefined, {
        maxMessages: 1,
        maxBytes: 64 * 1024,
      });
      expect(out).toHaveLength(1);
      expectMessageFields(out[0], { role: "assistant", content: "tail" });
      expect(readFileSpy).not.toHaveBeenCalled();
    } finally {
      readFileSpy.mockRestore();
    }
  });

  test("preserves real sequence metadata for bounded recent-message reads", () => {
    const sessionId = "test-session-recent-seq";
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 1, id: sessionId },
      { message: { role: "user", content: "old" } },
      { message: { role: "assistant", content: "middle" } },
      { message: { role: "user", content: "recent" } },
      { message: { role: "assistant", content: "latest" } },
    ]);

    const result = readRecentSessionMessagesWithStats(sessionId, storePath, undefined, {
      maxMessages: 2,
      maxBytes: 256,
    });

    expect(result.totalMessages).toBe(4);
    expect(result.messages).toHaveLength(2);
    expectMessageFields(result.messages[0], { content: "recent", openclaw: { seq: 3 } });
    expectMessageFields(result.messages[1], { content: "latest", openclaw: { seq: 4 } });
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

  test("honors byte caps for sync recent tree-message reads", () => {
    const sessionId = "test-session-recent-tree-byte-cap";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const hugeContent = "huge ".repeat(4096);
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: sessionId }),
      JSON.stringify({
        type: "message",
        id: "root",
        parentId: null,
        message: { role: "user", content: "root" },
      }),
      JSON.stringify({
        type: "message",
        id: "huge",
        parentId: "root",
        message: { role: "assistant", content: hugeContent },
      }),
      JSON.stringify({
        type: "message",
        id: "tail",
        parentId: "huge",
        message: { role: "assistant", content: "tail" },
      }),
    ];
    fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`, "utf-8");
    const readFileSpy = vi.spyOn(fs, "readFileSync");
    const sessionManagerOpenSpy = vi.spyOn(SessionManager, "open");

    try {
      const out = readRecentSessionMessages(sessionId, storePath, undefined, {
        maxMessages: 2,
        maxBytes: 2048,
      });

      expect(out).toHaveLength(1);
      expectMessageFields(out[0], { role: "assistant", content: "tail" });
      expect(JSON.stringify(out)).not.toContain("huge");
      expect(readFileSpy).not.toHaveBeenCalled();
      expect(sessionManagerOpenSpy).not.toHaveBeenCalled();
    } finally {
      readFileSpy.mockRestore();
      sessionManagerOpenSpy.mockRestore();
    }
  });

  test("counts transcript messages without loading the whole file", () => {
    const sessionId = "test-session-count-large";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      ...Array.from({ length: 2500 }, (_, index) =>
        JSON.stringify({ message: { role: "user", content: `message ${index}` } }),
      ),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");
    const readFileSpy = vi.spyOn(fs, "readFileSync");

    try {
      expect(readSessionMessageCount(sessionId, storePath)).toBe(2500);
      expect(readFileSpy).not.toHaveBeenCalled();
    } finally {
      readFileSpy.mockRestore();
    }
  });

  test("counts transcript messages asynchronously without loading the whole file", async () => {
    const sessionId = "test-session-count-large-async";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      ...Array.from({ length: 2500 }, (_, index) =>
        JSON.stringify({ message: { role: "user", content: `message ${index}` } }),
      ),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");
    const readFileSpy = vi.spyOn(fs, "readFileSync");

    try {
      expect(await readSessionMessageCountAsync(sessionId, storePath)).toBe(2500);
      expect(readFileSpy).not.toHaveBeenCalled();
    } finally {
      readFileSpy.mockRestore();
    }
  });

  test("reads active tree branch asynchronously without SessionManager.open", async () => {
    const sessionId = "test-session-tree-async";
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 3, id: sessionId },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        message: { role: "user", content: "root" },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        message: { role: "assistant", content: "active branch" },
      },
      {
        type: "message",
        id: "assistant-inactive",
        parentId: "user-1",
        message: { role: "assistant", content: "inactive branch" },
      },
      {
        type: "message",
        id: "user-2",
        parentId: "assistant-1",
        message: { role: "user", content: "latest active" },
      },
    ]);
    clearSessionTranscriptIndexCache();
    const sessionManagerOpenSpy = vi.spyOn(SessionManager, "open");
    const readFileSpy = vi.spyOn(fs, "readFileSync");

    try {
      const messages = await readSessionMessagesAsync(sessionId, storePath, undefined, {
        mode: "full",
        reason: "test active branch selection",
      });
      expect(messages.map((message) => (message as { content?: unknown }).content)).toEqual([
        "root",
        "active branch",
        "latest active",
      ]);
      expectMessageFields(messages[2], { openclaw: { id: "user-2", seq: 3 } });
      expect(sessionManagerOpenSpy).not.toHaveBeenCalled();
      expect(readFileSpy).not.toHaveBeenCalled();
    } finally {
      sessionManagerOpenSpy.mockRestore();
      readFileSpy.mockRestore();
    }
  });

  test("caches async transcript indexes by file stats", async () => {
    const sessionId = "test-session-index-cache";
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 1, id: sessionId },
      { message: { role: "user", content: "hello" } },
      { message: { role: "assistant", content: "hi" } },
    ]);
    clearSessionTranscriptIndexCache();
    expect(await readSessionMessageCountAsync(sessionId, storePath)).toBe(2);

    const openSpy = vi.spyOn(fs.promises, "open");
    try {
      expect(await readSessionMessageCountAsync(sessionId, storePath)).toBe(2);
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
    clearSessionTranscriptIndexCache();

    const openSpy = vi.spyOn(fs.promises, "open");
    try {
      await expect(
        Promise.all(
          Array.from({ length: 8 }, () => readSessionMessageCountAsync(sessionId, storePath)),
        ),
      ).resolves.toEqual(Array.from({ length: 8 }, () => 2));
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
    clearSessionTranscriptIndexCache();
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

  test("reads recent session usage asynchronously from the transcript tail", async () => {
    const sessionId = "test-session-async-recent-usage";
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 1, id: sessionId },
      { message: { role: "assistant", content: "older", usage: { input: 10, output: 1 } } },
      { message: { role: "assistant", content: "x".repeat(32 * 1024) } },
      { message: { role: "assistant", content: "latest", usage: { input: 42, output: 7 } } },
    ]);

    const usage = await readRecentSessionUsageFromTranscriptAsync(
      sessionId,
      storePath,
      undefined,
      undefined,
      2048,
    );

    expectUsageFields(usage, {
      inputTokens: 42,
      outputTokens: 7,
    });
  });

  test("reads latest recent session usage separately from tail aggregates", async () => {
    const sessionId = "test-session-async-latest-recent-usage";
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 1, id: sessionId },
      { message: { role: "assistant", content: "older", usage: { input: 50, output: 5 } } },
      { message: { role: "assistant", content: "latest", usage: { input: 70, output: 9 } } },
    ]);

    const aggregate = await readRecentSessionUsageFromTranscriptAsync(
      sessionId,
      storePath,
      undefined,
      undefined,
      2048,
    );
    const latest = await readLatestRecentSessionUsageFromTranscriptAsync(
      sessionId,
      storePath,
      undefined,
      undefined,
      2048,
    );

    expectUsageFields(aggregate, { inputTokens: 120, outputTokens: 14 });
    expectUsageFields(latest, { inputTokens: 70, outputTokens: 9 });
  });

  test("tails transcript lines for manual compaction without loading the whole file", () => {
    const sessionId = "test-session-line-tail";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      ...Array.from({ length: 10 }, (_, index) =>
        JSON.stringify({ message: { role: "user", content: `message ${index}` } }),
      ),
    ];
    fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`, "utf-8");
    const readFileSpy = vi.spyOn(fs, "readFileSync");

    try {
      const result = readRecentSessionTranscriptLines({
        sessionId,
        storePath,
        maxLines: 3,
      });
      expect(result?.totalLines).toBe(11);
      expect(result?.lines.map((line) => JSON.parse(line).message?.content)).toEqual([
        "message 7",
        "message 8",
        "message 9",
      ]);
      expect(readFileSpy).not.toHaveBeenCalled();
    } finally {
      readFileSpy.mockRestore();
    }
  });

  test("reads only the active branch when transcript rewrites abandon older entries", () => {
    const sessionId = "test-session-active-branch";
    const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        cwd: tmpDir,
        timestamp: "2026-04-27T00:00:00.000Z",
      },
      {
        type: "message",
        id: "original",
        parentId: null,
        timestamp: "2026-04-27T00:00:01.000Z",
        message: {
          role: "user",
          content: "Sender (untrusted metadata): webchat\n\noriginal wrapped prompt",
          timestamp: 1,
        },
      },
      {
        type: "message",
        id: "clean",
        parentId: null,
        timestamp: "2026-04-27T00:00:02.000Z",
        message: { role: "user", content: "clean prompt", timestamp: 2 },
      },
      {
        type: "message",
        id: "answer",
        parentId: "clean",
        timestamp: "2026-04-27T00:00:03.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "clean answer" }],
          api: "chat",
          provider: "openclaw",
          model: "test",
          usage: {},
          stopReason: "stop",
          timestamp: 3,
        },
      },
    ];
    fs.writeFileSync(sessionFile, lines.map((line) => JSON.stringify(line)).join("\n"), "utf-8");
    const rawTranscript = fs.readFileSync(sessionFile, "utf-8");
    expect(rawTranscript).toContain("original wrapped prompt");
    expect(rawTranscript).toContain("clean prompt");
    const sessionManagerOpenSpy = vi.spyOn(SessionManager, "open");

    try {
      const out = readSessionMessages(sessionId, storePath, sessionFile);
      expect(out).toHaveLength(2);
      expect(out).toHaveLength(2);
      expectMessageFields(out[0], { role: "user", content: "clean prompt", openclaw: { seq: 1 } });
      expectMessageFields(out[1], {
        role: "assistant",
        content: [{ type: "text", text: "clean answer" }],
        openclaw: { seq: 2 },
      });
      expect(JSON.stringify(out)).not.toContain("original wrapped prompt");
      expect(sessionManagerOpenSpy).not.toHaveBeenCalled();
    } finally {
      sessionManagerOpenSpy.mockRestore();
    }
  });

  test("keeps legacy messages when a mixed transcript lacks a complete branch tree", () => {
    const sessionId = "mixed-legacy-tree-session";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      { type: "session", version: 1, id: sessionId },
      { type: "message", id: "legacy-user", message: { role: "user", content: "legacy hello" } },
      {
        type: "message",
        id: "tree-assistant",
        parentId: "legacy-user",
        message: { role: "assistant", content: "tree hello" },
      },
    ];
    fs.writeFileSync(transcriptPath, lines.map((line) => JSON.stringify(line)).join("\n"), "utf-8");

    const out = readSessionMessages(sessionId, storePath);

    expect(out.map((message) => (message as { content?: unknown }).content)).toEqual([
      "legacy hello",
      "tree hello",
    ]);
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
    ({ sessionId, sessionFileParts, wrongStorePathParts, message }) => {
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

      const out = readSessionMessages(sessionId, wrongStorePath, sessionFile);
      expect(out).toHaveLength(1);
      expectMessageFields(out[0], message);
      expect((out[0] as { __openclaw?: { seq?: number } }).__openclaw?.seq).toBe(1);
    },
  );

  test("reads only the active SessionManager branch after a transcript rewrite", () => {
    const sessionId = "branched-session";
    const sessionManager = SessionManager.create(tmpDir, tmpDir);
    const decoratedPrompt = 'Sender (untrusted metadata):\n```json\n{"label":"ui"}\n```\n\nhello';
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

    const out = readSessionMessages(sessionId, storePath, sessionFile);

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

  test("keeps compaction markers when reading only the active SessionManager branch", () => {
    const sessionId = "branched-session-with-compaction";
    const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      {
        type: "session",
        version: 1,
        id: sessionId,
      },
      {
        type: "message",
        id: "user-old",
        parentId: null,
        message: { role: "user", content: "old prompt", timestamp: 1 },
      },
      {
        type: "message",
        id: "assistant-old",
        parentId: "user-old",
        message: { role: "assistant", content: "old answer", timestamp: 2 },
      },
      {
        type: "compaction",
        id: "comp-1",
        timestamp: "2026-02-07T00:00:00.000Z",
        summary: "Compacted history",
      },
      {
        type: "message",
        id: "user-active",
        parentId: null,
        message: { role: "user", content: "active prompt", timestamp: 3 },
      },
      {
        type: "message",
        id: "assistant-active",
        parentId: "user-active",
        message: { role: "assistant", content: "active answer", timestamp: 4 },
      },
    ];
    fs.writeFileSync(sessionFile, lines.map((line) => JSON.stringify(line)).join("\n"), "utf-8");

    const out = readSessionMessages(sessionId, storePath, sessionFile);

    expect(
      out.map((message) => ({
        role: (message as { role?: string }).role,
        content: (message as { content?: unknown }).content,
        kind: (message as { __openclaw?: { kind?: string } }).__openclaw?.kind,
      })),
    ).toEqual([
      { role: "system", content: [{ type: "text", text: "Compaction" }], kind: "compaction" },
      { role: "user", content: "active prompt", kind: undefined },
      { role: "assistant", content: "active answer", kind: undefined },
    ]);
  });

  test("keeps blocked hook messages on the current active branch", () => {
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
    const out = readSessionMessages(sessionId, storePath, sessionFile);
    expect(
      out.map((message) => ({
        role: (message as { role?: string }).role,
        text: (message as { content?: string | Array<{ text?: string }> }).content,
      })),
    ).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi" },
      { role: "user", text: [{ type: "text", text: "Blocked by HITL test hook." }] },
    ]);
    expect(JSON.stringify(out)).not.toContain("[hitl:block] hello");
    expect(JSON.stringify(out)).not.toContain("matched original");
  });

  test("keeps repeated blocked hook messages together in a new session", () => {
    const sessionKey = "agent:main:explicit:repeated-blocked-hook";
    const sessionManager = SessionManager.create(tmpDir, tmpDir);
    const sessionId = sessionManager.getSessionId();
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) {
      throw new Error("expected SessionManager.create to return a session file");
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

    appendBlockedUserMessageWithSessionManager({
      sessionFile,
      originalText: "[hitl:block] first",
      redactedText: "Blocked by HITL test hook.",
      pluginId: "hitl-test-hooks",
    });
    appendBlockedUserMessageWithSessionManager({
      sessionFile,
      originalText: "[hitl:block] second",
      redactedText: "Blocked again by HITL test hook.",
      pluginId: "hitl-test-hooks",
    });

    const out = readSessionMessages(sessionId, storePath, sessionFile);
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

describe("readSessionPreviewItemsFromTranscript", () => {
  let tmpDir: string;
  let storePath: string;

  registerTempSessionStore("openclaw-session-preview-test-", (nextTmpDir, nextStorePath) => {
    tmpDir = nextTmpDir;
    storePath = nextStorePath;
  });

  function writeTranscriptLines(sessionId: string, lines: string[]) {
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");
  }

  function readPreview(sessionId: string, maxItems = 3, maxChars = 120) {
    return readSessionPreviewItemsFromTranscript(
      sessionId,
      storePath,
      undefined,
      undefined,
      maxItems,
      maxChars,
    );
  }

  test("returns recent preview items with tool summary", () => {
    const sessionId = "preview-session";
    const lines = createToolSummaryPreviewTranscriptLines(sessionId);
    writeTranscriptLines(sessionId, lines);
    const result = readPreview(sessionId);

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
    writeTranscriptLines(sessionId, lines);
    const result = readPreview(sessionId);

    expect(result.map((item) => item.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(result[1]?.text).toContain("call");
    expect(result[1]?.text).toContain("camera");
    expect(result[1]?.text).toContain("read");
    // Preview text may not list every tool name; it should at least hint there were multiple calls.
    expect(result[1]?.text).toMatch(/\+\d+/);
  });

  test("truncates preview text to max chars", () => {
    const sessionId = "preview-truncate";
    const longText = "a".repeat(60);
    const lines = [JSON.stringify({ message: { role: "assistant", content: longText } })];
    writeTranscriptLines(sessionId, lines);
    const result = readPreview(sessionId, 1, 24);

    expect(result).toHaveLength(1);
    expect(result[0]?.text.length).toBe(24);
    expect(result[0]?.text.endsWith("...")).toBe(true);
  });

  test("strips inline directives from preview items", () => {
    const sessionId = "preview-strip-inline-directives";
    const lines = [
      JSON.stringify({
        message: {
          role: "assistant",
          content: "A [[reply_to:abc-123]] B [[audio_as_voice]]",
        },
      }),
    ];
    writeTranscriptLines(sessionId, lines);
    const result = readPreview(sessionId, 1, 120);

    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("A  B");
  });

  test("prefers final_answer text for assistant preview items", () => {
    const sessionId = "preview-final-answer";
    const lines = [
      JSON.stringify({
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "thinking like caveman",
              textSignature: JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" }),
            },
            {
              type: "text",
              text: "Actual final answer",
              textSignature: JSON.stringify({ v: 1, id: "msg_final", phase: "final_answer" }),
            },
          ],
        },
      }),
    ];
    writeTranscriptLines(sessionId, lines);
    const result = readPreview(sessionId, 1, 120);

    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("Actual final answer");
  });

  test("hides commentary-only assistant preview items", () => {
    const sessionId = "preview-commentary-only";
    const lines = [
      JSON.stringify({
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "thinking like caveman",
              textSignature: JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" }),
            },
          ],
        },
      }),
    ];
    writeTranscriptLines(sessionId, lines);
    const result = readPreview(sessionId, 1, 120);

    expect(result).toHaveLength(0);
  });
});

describe("readLatestSessionUsageFromTranscript", () => {
  let tmpDir: string;
  let storePath: string;

  registerTempSessionStore("openclaw-session-usage-test-", (nextTmpDir, nextStorePath) => {
    tmpDir = nextTmpDir;
    storePath = nextStorePath;
  });

  test("returns the latest assistant usage snapshot and skips delivery mirrors", () => {
    const sessionId = "usage-session";
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 1, id: sessionId },
      {
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.4",
          usage: {
            input: 1200,
            output: 300,
            cacheRead: 50,
            cost: { total: 0.0042 },
          },
        },
      },
      {
        message: {
          role: "assistant",
          provider: "openclaw",
          model: "delivery-mirror",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      },
    ]);

    expect(readLatestSessionUsageFromTranscript(sessionId, storePath)).toEqual({
      modelProvider: "openai",
      model: "gpt-5.4",
      inputTokens: 1200,
      outputTokens: 300,
      cacheRead: 50,
      totalTokens: 1250,
      totalTokensFresh: true,
      costUsd: 0.0042,
    });
  });

  test("aggregates assistant usage across the full transcript and keeps the latest context snapshot", () => {
    const sessionId = "usage-aggregate";
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

    const snapshot = readLatestSessionUsageFromTranscript(sessionId, storePath);
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

  test("reads earlier assistant usage outside the old tail window", () => {
    const sessionId = "usage-full-transcript";
    const filler = "x".repeat(20_000);
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 1, id: sessionId },
      {
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.4",
          usage: {
            input: 1_000,
            output: 200,
            cacheRead: 100,
            cost: { total: 0.0042 },
          },
        },
      },
      ...Array.from({ length: 80 }, () => ({ message: { role: "user", content: filler } })),
      {
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.4",
          usage: {
            input: 500,
            output: 150,
            cacheRead: 50,
            cost: { total: 0.0021 },
          },
        },
      },
    ]);

    const snapshot = readLatestSessionUsageFromTranscript(sessionId, storePath);
    expectUsageFields(snapshot, {
      modelProvider: "openai",
      model: "gpt-5.4",
      inputTokens: 1500,
      outputTokens: 350,
      cacheRead: 150,
      totalTokens: 550,
      totalTokensFresh: true,
    });
    expect(snapshot?.costUsd).toBeCloseTo(0.0063, 8);
  });

  test("bounds recent usage reads for bulk session listing", () => {
    const sessionId = "usage-recent-large";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      ...Array.from({ length: 2500 }, (_, index) =>
        JSON.stringify({
          message: { role: "user", content: `filler ${index} ${"x".repeat(700)}` },
        }),
      ),
      JSON.stringify({
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.4",
          usage: {
            input: 900,
            output: 100,
            cost: { total: 0.003 },
          },
        },
      }),
    ];
    fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");
    const readFileSpy = vi.spyOn(fs, "readFileSync");

    try {
      expectUsageFields(
        readRecentSessionUsageFromTranscript(sessionId, storePath, undefined, undefined, 64 * 1024),
        {
          modelProvider: "openai",
          model: "gpt-5.4",
          inputTokens: 900,
          outputTokens: 100,
          totalTokens: 900,
        },
      );
      expect(readFileSpy).not.toHaveBeenCalled();
    } finally {
      readFileSpy.mockRestore();
    }
  });

  test("returns null when the transcript has no assistant usage snapshot", () => {
    const sessionId = "usage-empty";
    writeTranscript(tmpDir, sessionId, [
      { type: "session", version: 1, id: sessionId },
      { message: { role: "user", content: "hello" } },
      { message: { role: "assistant", content: "hi" } },
    ]);

    expect(readLatestSessionUsageFromTranscript(sessionId, storePath)).toBeNull();
  });
});

describe("resolveSessionTranscriptCandidates", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("fallback candidate uses OPENCLAW_HOME instead of os.homedir()", () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");

    const candidates = resolveSessionTranscriptCandidates("sess-1", undefined);
    const fallback = candidates[candidates.length - 1];
    expect(fallback).toBe(
      path.join(path.resolve("/srv/openclaw-home"), ".openclaw", "sessions", "sess-1.jsonl"),
    );
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

  test("keeps explicit custom sessionFile ahead of synthesized fallback", () => {
    const storePath = "/tmp/openclaw/agents/main/sessions/sessions.json";
    const sessionFile = "/tmp/openclaw/agents/main/sessions/custom-transcript.jsonl";
    const candidates = resolveSessionTranscriptCandidates(
      "11111111-1111-4111-8111-111111111111",
      storePath,
      sessionFile,
    );

    expect(candidates[0]).toBe(path.resolve(sessionFile));
  });

  test("keeps custom topic-like transcript paths ahead of synthesized fallback", () => {
    const storePath = "/tmp/openclaw/agents/main/sessions/sessions.json";
    const sessionFile = "/tmp/openclaw/agents/main/sessions/custom-topic-notes.jsonl";
    const candidates = resolveSessionTranscriptCandidates(
      "11111111-1111-4111-8111-111111111111",
      storePath,
      sessionFile,
    );

    expect(candidates[0]).toBe(path.resolve(sessionFile));
  });

  test("keeps forked transcript paths ahead of synthesized fallback", () => {
    const storePath = "/tmp/openclaw/agents/main/sessions/sessions.json";
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const sessionFile =
      "/tmp/openclaw/agents/main/sessions/2026-03-23T16-30-00-000Z_11111111-1111-4111-8111-111111111111.jsonl";
    const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile);

    expect(candidates[0]).toBe(path.resolve(sessionFile));
  });

  test("keeps timestamped custom transcript paths ahead of synthesized fallback", () => {
    const storePath = "/tmp/openclaw/agents/main/sessions/sessions.json";
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const sessionFile = "/tmp/openclaw/agents/main/sessions/2026-03-23T16-30-00-000Z_notes.jsonl";
    const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile);

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

describe("archiveSessionTranscripts", () => {
  let tmpDir: string;
  let storePath: string;

  registerTempSessionStore("openclaw-archive-test-", (nextTmpDir, nextStorePath) => {
    tmpDir = nextTmpDir;
    storePath = nextStorePath;
  });

  beforeAll(() => {
    vi.stubEnv("OPENCLAW_HOME", tmpDir);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  test.each([
    {
      sessionId: "sess-archive-1",
      transcriptFileName: "sess-archive-1.jsonl",
      buildArgs: () => ({ sessionId: "sess-archive-1", storePath, reason: "reset" as const }),
    },
    {
      sessionId: "sess-archive-2",
      transcriptFileName: "custom-transcript.jsonl",
      buildArgs: () => ({
        sessionId: "sess-archive-2",
        storePath: undefined,
        sessionFile: path.join(tmpDir, "custom-transcript.jsonl"),
        reason: "reset" as const,
      }),
    },
  ] as const)(
    "archives transcript from default and explicit sessionFile path for $sessionId",
    ({ transcriptFileName, buildArgs }) => {
      const transcriptPath = path.join(tmpDir, transcriptFileName);
      const args = buildArgs();
      fs.writeFileSync(transcriptPath, '{"type":"session"}\n', "utf-8");
      const archived = archiveSessionTranscripts(args);
      expect(archived).toHaveLength(1);
      expect(archived[0]).toContain(".reset.");
      expect(fs.existsSync(transcriptPath)).toBe(false);
      expect(fs.existsSync(archived[0])).toBe(true);
    },
  );

  test("returns empty array when no transcript files exist", () => {
    const archived = archiveSessionTranscripts({
      sessionId: "nonexistent-session",
      storePath,
      reason: "reset",
    });

    expect(archived).toStrictEqual([]);
  });

  test("skips files that do not exist and archives only existing ones", () => {
    const sessionId = "sess-archive-3";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, '{"type":"session"}\n', "utf-8");

    const archived = archiveSessionTranscripts({
      sessionId,
      storePath,
      sessionFile: "/nonexistent/path/file.jsonl",
      reason: "deleted",
    });

    expect(archived).toHaveLength(1);
    expect(archived[0]).toContain(".deleted.");
    expect(fs.existsSync(transcriptPath)).toBe(false);
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
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const oversizedContent = "x".repeat(300 * 1024);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({ message: { role: "user", content: "start" } }),
      JSON.stringify({ message: { role: "assistant", content: oversizedContent } }),
      JSON.stringify({ message: { role: "user", content: "after oversized" } }),
    ];
    fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`, "utf-8");

    const out = await readRecentSessionMessagesAsync(sessionId, storePath, undefined, {
      maxMessages: 10,
    });

    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(oversizedContent);
    expect(serialized).toContain("[chat.history omitted: message too large]");
    expect(serialized).toContain("after oversized");
  });

  test("readRecentSessionMessagesAsync keeps oversized active-tree leaves", async () => {
    const sessionId = "test-oversized-tree-tail";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const oversizedContent = "z".repeat(300 * 1024);
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: sessionId }),
      JSON.stringify({
        type: "message",
        id: "root",
        parentId: null,
        message: { role: "user", content: "root" },
      }),
      JSON.stringify({
        type: "message",
        id: "oversized-leaf",
        parentId: "root",
        message: { role: "assistant", content: oversizedContent },
      }),
    ];
    fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`, "utf-8");

    const out = await readRecentSessionMessagesAsync(sessionId, storePath, undefined, {
      maxMessages: 10,
    });

    const serialized = JSON.stringify(out);
    expect(serialized).toContain("root");
    expect(serialized).toContain("oversized-leaf");
    expect(serialized).not.toContain(oversizedContent);
    expect(serialized).toContain("[chat.history omitted: message too large]");
  });

  test("readRecentSessionUsageFromTranscriptAsync skips oversized lines", async () => {
    const sessionId = "test-oversized-usage";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const oversizedContent = "y".repeat(300 * 1024);
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: sessionId }),
      JSON.stringify({
        message: {
          role: "assistant",
          content: oversizedContent,
          usage: { input: 9999, output: 9999 },
          provider: "oversized-provider",
          model: "oversized-model",
        },
      }),
      JSON.stringify({
        message: {
          role: "assistant",
          content: "normal",
          usage: { input: 100, output: 50 },
          provider: "test-provider",
          model: "test-model",
        },
      }),
    ];
    fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`, "utf-8");

    const usage = await readRecentSessionUsageFromTranscriptAsync(
      sessionId,
      storePath,
      undefined,
      undefined,
      512 * 1024,
    );

    expectUsageFields(usage, { modelProvider: "test-provider" });
  });

  test("readSessionTitleFieldsFromTranscriptAsync delegates to bounded sync reader", async () => {
    const sessionId = "test-async-title-bounded";
    writeTranscript(
      tmpDir,
      sessionId,
      buildBasicSessionTranscript(sessionId, "User says hi", "Bot says hello"),
    );

    const syncResult = readSessionTitleFieldsFromTranscript(sessionId, storePath);
    const asyncResult = await readSessionTitleFieldsFromTranscriptAsync(sessionId, storePath);

    expect(asyncResult).toEqual(syncResult);
    expect(asyncResult.firstUserMessage).toBe("User says hi");
    expect(asyncResult.lastMessagePreview).toBe("Bot says hello");
  });
});
