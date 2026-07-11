// Codex tests cover transcript mirror plugin behavior.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  castAgentMessage,
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexThread } from "./protocol.js";
import { readCodexMirroredSessionHistoryMessages } from "./session-history.js";
import {
  attachCodexMirrorIdentity,
  buildCodexUserPromptMessage,
  importCodexThreadHistoryToTranscript,
  mirrorCodexAppServerTranscript,
  mirrorTranscriptBestEffort,
  projectBoundedCodexThreadHistory,
} from "./transcript-mirror.js";

const publishSessionTranscriptUpdateByIdentityMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-runtime")>();
  return {
    ...actual,
    publishSessionTranscriptUpdateByIdentity: publishSessionTranscriptUpdateByIdentityMock,
  };
});

type MirroredAgentMessage = Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }>;

// Mirrors transcript-mirror.ts's fallback fingerprint exactly so test
// expectations stay in sync without exposing the helper publicly.
function expectedFingerprint(message: MirroredAgentMessage): string {
  const payload = JSON.stringify({ role: message.role, content: message.content });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function messageContent(message: AgentMessage | undefined) {
  if (!message || !("content" in message)) {
    throw new Error("expected transcript message content");
  }
  return message.content;
}

const tempDirs: string[] = [];

afterEach(async () => {
  resetGlobalHookRunner();
  publishSessionTranscriptUpdateByIdentityMock.mockReset();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function createTempSessionFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-transcript-"));
  tempDirs.push(dir);
  return path.join(dir, "session.jsonl");
}

async function initializeSessionTranscript(sessionFile: string, sessionId: string): Promise<void> {
  await fs.writeFile(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    })}\n`,
    "utf8",
  );
}

async function makeRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

describe("buildCodexUserPromptMessage", () => {
  it("uses the prepared user transcript message for app-server prompt mirrors", () => {
    const message = buildCodexUserPromptMessage({
      prompt: "[Mon 2026-05-25 19:14 GMT+1] What is in this image?",
      messageChannel: "webchat",
      userTurnTranscriptRecorder: {
        message: {
          role: "user",
          content: "What is in this image?",
          timestamp: 1779732875151,
          MediaPath: "/tmp/image.png",
          MediaPaths: ["/tmp/image.png"],
          MediaType: "image/png",
          MediaTypes: ["image/png"],
        },
      },
    } as unknown as Parameters<typeof buildCodexUserPromptMessage>[0]);

    expect(message).toMatchObject({
      role: "user",
      content: "What is in this image?",
      timestamp: 1779732875151,
      sourceChannel: "webchat",
      MediaPath: "/tmp/image.png",
      MediaPaths: ["/tmp/image.png"],
      MediaType: "image/png",
      MediaTypes: ["image/png"],
    });
  });
});

function parseJsonLines<T>(raw: string): T[] {
  const records: T[] = [];
  for (const line of raw.trim().split("\n")) {
    if (line.length > 0) {
      records.push(JSON.parse(line) as T);
    }
  }
  return records;
}

describe("importCodexThreadHistoryToTranscript", () => {
  it("imports only bounded user-visible conversation items with stable identities", async () => {
    const sessionFile = await createTempSessionFile();
    await initializeSessionTranscript(sessionFile, "session-history");
    const thread = {
      id: "thread-history",
      cwd: "/workspace/project",
      turns: [
        {
          id: "turn-1",
          status: "completed",
          startedAt: 1_700_000_000,
          completedAt: 1_700_000_001,
          items: [
            {
              id: "user-1",
              type: "userMessage",
              content: [
                { type: "text", text: "Review this image" },
                { type: "image", url: "data:image/png;base64,private" },
              ],
            },
            {
              id: "reasoning-1",
              type: "reasoning",
              summary: ["private reasoning"],
              content: ["private chain of thought"],
            },
            {
              id: "command-1",
              type: "commandExecution",
              command: "print-secret",
              aggregatedOutput: "private tool output",
            },
            {
              id: "assistant-1",
              type: "agentMessage",
              text: "The visible answer",
              phase: "final_answer",
            },
          ],
        },
      ],
    } as unknown as CodexThread;

    const rawProjection = projectBoundedCodexThreadHistory({
      thread,
      throughTurnId: "turn-1",
      importedAt: 1_800_000_000_000,
    });
    expect(rawProjection.responseItems).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Review this image\n[Image attachment]" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "The visible answer" }],
        phase: "final_answer",
      },
    ]);
    expect(JSON.stringify(rawProjection.responseItems)).not.toContain("private");
    expect(JSON.stringify(rawProjection.responseItems)).not.toContain("data:image");

    await expect(
      importCodexThreadHistoryToTranscript({
        thread,
        throughTurnId: "turn-1",
        sessionFile,
        sessionId: "session-history",
        sessionKey: "agent:main:dashboard:history",
      }),
    ).resolves.toEqual({ importedMessages: 2, omittedMessages: 0 });

    const raw = await fs.readFile(sessionFile, "utf8");
    const messages = parseJsonLines<{ message?: AgentMessage; type?: string }>(raw)
      .filter((event) => event.type === "message")
      .map((event) => event.message);
    expect(messages).toMatchObject([
      {
        role: "user",
        content: "Review this image\n[Image attachment]",
        timestamp: 1_700_000_000_000,
        idempotencyKey: "codex-app-server:thread-history:history:turn-1:user-1",
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "The visible answer" }],
        api: "openai-chatgpt-responses",
        provider: "openai",
        model: "native-history",
        stopReason: "stop",
        timestamp: 1_700_000_001_003,
        idempotencyKey: "codex-app-server:thread-history:history:turn-1:assistant-1",
      },
    ]);
    expect(raw).not.toContain("private reasoning");
    expect(raw).not.toContain("private chain of thought");
    expect(raw).not.toContain("private tool output");
    expect(raw).not.toContain("data:image");
    await expect(
      readCodexMirroredSessionHistoryMessages({
        sessionFile,
        sessionId: "session-history",
        sessionKey: "agent:main:dashboard:history",
      }),
    ).resolves.toMatchObject([
      { role: "user", content: "Review this image\n[Image attachment]" },
      {
        role: "assistant",
        content: [{ type: "text", text: "The visible answer" }],
        api: "openai-chatgpt-responses",
        provider: "openai",
        model: "native-history",
        stopReason: "stop",
      },
    ]);
  });

  it("keeps the newest 200 visible messages and deduplicates a retried import", async () => {
    const sessionFile = await createTempSessionFile();
    await initializeSessionTranscript(sessionFile, "session-bounded-history");
    const thread = {
      id: "thread-bounded-history",
      turns: Array.from({ length: 205 }, (_, index) => ({
        id: `turn-${index}`,
        status: "completed",
        startedAt: 1_700_000_000 + index,
        completedAt: 1_700_000_000 + index,
        items: [
          {
            id: `user-${index}`,
            type: "userMessage",
            content: [{ type: "text", text: `message-${index}` }],
          },
        ],
      })),
    } as unknown as CodexThread;
    const importParams = {
      thread,
      throughTurnId: "turn-204",
      sessionFile,
      sessionId: "session-bounded-history",
      sessionKey: "agent:main:dashboard:bounded-history",
    };

    await expect(importCodexThreadHistoryToTranscript(importParams)).resolves.toEqual({
      importedMessages: 200,
      omittedMessages: 5,
    });
    await expect(importCodexThreadHistoryToTranscript(importParams)).resolves.toEqual({
      importedMessages: 200,
      omittedMessages: 5,
    });

    const raw = await fs.readFile(sessionFile, "utf8");
    const messages = parseJsonLines<{ message?: AgentMessage; type?: string }>(raw)
      .filter((event) => event.type === "message")
      .map((event) => event.message);
    expect(messages).toHaveLength(200);
    expect(messages[0]).toMatchObject({ content: "message-5" });
    expect(messages.at(-1)).toMatchObject({ content: "message-204" });
  });

  it("assigns canonical assistant attribution and numeric fallback timestamps", async () => {
    const sessionFile = await createTempSessionFile();
    await initializeSessionTranscript(sessionFile, "session-fallback-history");
    const thread = {
      id: "thread-fallback-history",
      modelProvider: "source-provider",
      turns: [
        {
          id: "turn-without-time",
          status: "completed",
          items: [
            {
              id: "user-without-time",
              type: "userMessage",
              content: [{ type: "text", text: "Earlier prompt" }],
            },
            {
              id: "assistant-without-time",
              type: "agentMessage",
              text: "Earlier answer",
            },
          ],
        },
      ],
    } as unknown as CodexThread;

    await importCodexThreadHistoryToTranscript({
      thread,
      throughTurnId: "turn-without-time",
      sessionFile,
      sessionId: "session-fallback-history",
      sessionKey: "agent:main:dashboard:fallback-history",
    });

    const history = await readCodexMirroredSessionHistoryMessages({
      sessionFile,
      sessionId: "session-fallback-history",
      sessionKey: "agent:main:dashboard:fallback-history",
    });
    expect(history).toMatchObject([
      { role: "user", content: "Earlier prompt", timestamp: expect.any(Number) },
      {
        role: "assistant",
        content: [{ type: "text", text: "Earlier answer" }],
        api: "openai-chatgpt-responses",
        provider: "source-provider",
        model: "native-history",
        usage: { totalTokens: 0 },
        stopReason: "stop",
        timestamp: expect.any(Number),
      },
    ]);
  });
});

describe("projectBoundedCodexThreadHistory", () => {
  const thread = {
    id: "thread-prefix",
    createdAt: 1_700_000_000,
    turns: [
      {
        id: "turn-a",
        status: "completed",
        startedAt: 1_700_000_001,
        completedAt: 1_700_000_002,
        items: [
          {
            id: "user-a",
            type: "userMessage",
            content: [{ type: "text", text: "First question" }],
          },
          {
            id: "assistant-a",
            type: "agentMessage",
            text: "First answer",
            phase: "commentary",
          },
        ],
      },
      {
        id: "turn-b",
        status: "completed",
        startedAt: 1_700_000_003,
        completedAt: 1_700_000_004,
        items: [
          {
            id: "user-b",
            type: "userMessage",
            content: [{ type: "text", text: "Second question" }],
          },
          {
            id: "assistant-b",
            type: "agentMessage",
            text: "Second answer",
            phase: "final_answer",
          },
        ],
      },
      {
        id: "turn-active",
        status: "inProgress",
        items: [
          {
            id: "active-secret",
            type: "agentMessage",
            text: "Do not import the active tail",
          },
        ],
      },
      {
        id: "turn-failed",
        status: "failed",
        items: [
          {
            id: "failed-secret",
            type: "agentMessage",
            text: "Do not import the failed tail",
          },
        ],
      },
    ],
  } as unknown as CodexThread;

  it("uses one inclusive completed-turn prefix for transcript and Responses API projection", () => {
    const projection = projectBoundedCodexThreadHistory({
      thread,
      throughTurnId: "turn-b",
      importedAt: 1_800_000_000_000,
      modelProvider: "native-provider",
    });

    expect(projection).toMatchObject({ importedMessages: 4, omittedMessages: 0 });
    expect(projection.transcriptMessages.map(messageContent)).toEqual([
      "First question",
      [{ type: "text", text: "First answer" }],
      "Second question",
      [{ type: "text", text: "Second answer" }],
    ]);
    expect(projection.transcriptMessages[1]).toMatchObject({
      role: "assistant",
      api: "openai-chatgpt-responses",
      provider: "native-provider",
      model: "native-history",
    });
    expect(projection.responseItems).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "First question" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "First answer" }],
        phase: "commentary",
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Second question" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Second answer" }],
        phase: "final_answer",
      },
    ]);
    expect(JSON.stringify(projection)).not.toContain("active tail");
    expect(JSON.stringify(projection)).not.toContain("failed tail");
  });

  it("accepts terminal boundaries", () => {
    for (const status of ["completed", "interrupted", "failed"]) {
      const terminalThread = {
        ...thread,
        turns: [
          ...(thread.turns?.slice(0, 2) ?? []),
          {
            id: `turn-${status}`,
            status,
            items: [
              {
                id: `assistant-${status}`,
                type: "agentMessage",
                text: `${status} answer`,
              },
            ],
          },
        ],
      } as unknown as CodexThread;
      const projection = projectBoundedCodexThreadHistory({
        thread: terminalThread,
        throughTurnId: `turn-${status}`,
        importedAt: 1_800_000_000_000,
      });
      expect(messageContent(projection.transcriptMessages.at(-1))).toEqual([
        { type: "text", text: `${status} answer` },
      ]);
    }
  });

  it("enforces UTF-8 byte limits without splitting multibyte text", () => {
    const oversizedText = `prefix-${"🙂".repeat(20_000)}-suffix`;
    const oversizedThread = {
      id: "thread-byte-bounds",
      turns: Array.from({ length: 9 }, (_, index) => ({
        id: `turn-${index}`,
        status: "completed",
        items: [
          {
            id: `user-${index}`,
            type: "userMessage",
            content: [{ type: "text", text: `${index}:${oversizedText}` }],
          },
        ],
      })),
    } as unknown as CodexThread;

    const projection = projectBoundedCodexThreadHistory({
      thread: oversizedThread,
      throughTurnId: "turn-8",
      importedAt: 1_800_000_000_000,
    });
    const texts = projection.transcriptMessages.map((message) => {
      const content = messageContent(message);
      return typeof content === "string" ? content : "";
    });

    expect(projection).toMatchObject({ importedMessages: 8, omittedMessages: 1 });
    expect(texts[0]).toMatch(/^1:prefix-/u);
    expect(texts.every((text) => Buffer.byteLength(text, "utf8") <= 64 * 1024)).toBe(true);
    expect(
      texts.reduce((bytes, text) => bytes + Buffer.byteLength(text, "utf8"), 0),
    ).toBeLessThanOrEqual(512 * 1024);
    expect(texts.every((text) => !text.includes("�"))).toBe(true);
    expect(
      texts.every((text) => text.endsWith("[Message truncated during Codex history import.]")),
    ).toBe(true);
  });

  it("rejects a non-terminal or missing boundary and projects no history without one", () => {
    expect(() =>
      projectBoundedCodexThreadHistory({
        thread,
        throughTurnId: "turn-active",
        importedAt: 1_800_000_000_000,
      }),
    ).toThrow("Codex history boundary turn is not terminal: turn-active");
    expect(() =>
      projectBoundedCodexThreadHistory({
        thread,
        throughTurnId: "turn-missing",
        importedAt: 1_800_000_000_000,
      }),
    ).toThrow("Codex history boundary turn not found: turn-missing");
    expect(
      projectBoundedCodexThreadHistory({
        thread,
        throughTurnId: null,
        importedAt: 1_800_000_000_000,
      }),
    ).toEqual({
      importedMessages: 0,
      omittedMessages: 0,
      responseItems: [],
      transcriptMessages: [],
    });
  });
});

describe("mirrorCodexAppServerTranscript", () => {
  it("mirrors user, assistant, and tool result messages into the embedded-agent transcript", async () => {
    const sessionFile = await createTempSessionFile();
    const userMessage = makeAgentUserMessage({
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });
    const assistantMessage = makeAgentAssistantMessage({
      content: [{ type: "text", text: "hi there" }],
      timestamp: Date.now() + 1,
    });
    const toolResultMessage = castAgentMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [
        {
          type: "toolResult",
          toolCallId: "call-1",
          content: "read output",
        },
      ],
      timestamp: Date.now() + 2,
    }) as MirroredAgentMessage;

    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionId: "session-1",
      sessionKey: "session-1",
      messages: [userMessage, assistantMessage, toolResultMessage],
      idempotencyScope: "scope-1",
    });

    const raw = await fs.readFile(sessionFile, "utf8");
    expect(raw).toContain('"role":"user"');
    expect(raw).toContain('"content":[{"type":"text","text":"hello"}]');
    expect(raw).toContain('"role":"assistant"');
    expect(raw).toContain('"content":[{"type":"text","text":"hi there"}]');
    expect(raw).toContain('"role":"toolResult"');
    expect(raw).toContain('"toolCallId":"call-1"');
    expect(raw).toContain('"content":"read output"');
    expect(raw).toContain(`"idempotencyKey":"scope-1:user:${expectedFingerprint(userMessage)}"`);
    expect(raw).toContain(
      `"idempotencyKey":"scope-1:assistant:${expectedFingerprint(assistantMessage)}"`,
    );
    expect(raw).toContain(
      `"idempotencyKey":"scope-1:toolResult:${expectedFingerprint(toolResultMessage)}"`,
    );
  });

  it("preserves gateway user-turn identity across Codex transcript mirroring", async () => {
    const sessionFile = await createTempSessionFile();
    const userMessage = castAgentMessage({
      ...makeAgentUserMessage({
        content: [{ type: "text", text: "client prompt" }],
        timestamp: Date.now(),
      }),
      idempotencyKey: "client-run:user",
    }) as MirroredAgentMessage;

    const first = await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      messages: [userMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });
    const second = await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      messages: [userMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });

    const raw = await fs.readFile(sessionFile, "utf8");
    expect(raw).toContain('"idempotencyKey":"client-run:user"');
    expect(raw).toContain('"mirrorOrigin":"codex-app-server"');
    expect(raw).not.toContain('"idempotencyKey":"codex-app-server:thread-1:');
    expect(first.userMessagesPresent).toHaveLength(1);
    expect(second.userMessagesPresent).toHaveLength(1);
    expect(
      parseJsonLines<{ message?: { role?: string } }>(raw).filter(
        (record) => record.message?.role === "user",
      ),
    ).toHaveLength(1);
  });

  it("emits message-bearing updates for newly appended mirrored messages only", async () => {
    const sessionFile = await createTempSessionFile();
    const userMessage = attachCodexMirrorIdentity(
      makeAgentUserMessage({
        content: [{ type: "text", text: "show me live" }],
        timestamp: Date.now(),
      }),
      "turn-1:prompt",
    );

    const firstMirror = await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      messages: [userMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });
    const secondMirror = await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      messages: [userMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });

    const updates = publishSessionTranscriptUpdateByIdentityMock.mock.calls.map(
      ([update]) => update as Record<string, unknown> & { update?: Record<string, unknown> },
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.sessionFile).toBe(sessionFile);
    expect(updates[0]?.sessionKey).toBe("agent:main:main");
    expect(updates[0]?.update?.messageId).toEqual(expect.any(String));
    expect(updates[0]?.update?.message).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "show me live" }],
      idempotencyKey: "codex-app-server:thread-1:turn-1:prompt",
    });
    expect(updates[0]?.update?.messageSeq).toBe(1);
    expect(firstMirror.userMessagesPresent).toHaveLength(1);
    expect(firstMirror.userMessagesPresent[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "show me live" }],
      idempotencyKey: "codex-app-server:thread-1:turn-1:prompt",
    });
    expect(secondMirror.userMessagesPresent).toHaveLength(1);
    expect(secondMirror.userMessagesPresent[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "show me live" }],
      idempotencyKey: "codex-app-server:thread-1:turn-1:prompt",
    });
  });

  it("reports final assistant ownership for new and idempotent mirrors", async () => {
    const sessionFile = await createTempSessionFile();
    const assistantMessage = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "owned once" }],
        timestamp: Date.now(),
      }),
      "turn-1:assistant",
    );

    const firstMirror = await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      messages: [assistantMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });
    const secondMirror = await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      messages: [assistantMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });

    expect(firstMirror.assistantMirrorIdentitiesOwned).toEqual(["turn-1:assistant"]);
    expect(secondMirror.assistantMirrorIdentitiesOwned).toEqual(["turn-1:assistant"]);
    const records = parseJsonLines<{ type?: string; message?: { role?: string } }>(
      await fs.readFile(sessionFile, "utf8"),
    );
    expect(records.filter((record) => record.message?.role === "assistant")).toHaveLength(1);
  });

  it("keeps assistant ownership when live update publication fails", async () => {
    publishSessionTranscriptUpdateByIdentityMock.mockRejectedValueOnce(new Error("publish failed"));
    const sessionFile = await createTempSessionFile();
    const assistantMessage = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "durably persisted" }],
        timestamp: Date.now(),
      }),
      "turn-1:assistant",
    );

    const result = await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      messages: [assistantMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });

    expect(result.assistantMirrorIdentitiesOwned).toEqual(["turn-1:assistant"]);
    expect(await fs.readFile(sessionFile, "utf8")).toContain('"role":"assistant"');
  });

  it("leaves the assistant unowned when transcript persistence fails", async () => {
    const root = await makeRoot("openclaw-codex-transcript-failure-");
    const invalidParent = path.join(root, "not-a-directory");
    await fs.writeFile(invalidParent, "file blocks transcript directory creation", "utf8");
    const assistantMessage = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "needs fallback persistence" }],
        timestamp: Date.now(),
      }),
      "turn-1:assistant",
    );

    const assistantTranscriptOwned = await mirrorTranscriptBestEffort({
      params: {
        sessionFile: path.join(invalidParent, "session.jsonl"),
        sessionId: "session-1",
        suppressNextUserMessagePersistence: true,
      } as Parameters<typeof mirrorTranscriptBestEffort>[0]["params"],
      result: {
        messagesSnapshot: [assistantMessage],
      } as Parameters<typeof mirrorTranscriptBestEffort>[0]["result"],
      notifyUserMessagePersisted: vi.fn(),
      cwd: root,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(assistantTranscriptOwned).toBe(false);
  });

  it("emits stable sequence numbers for multi-message mirror batches", async () => {
    const sessionFile = await createTempSessionFile();

    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      messages: [
        attachCodexMirrorIdentity(
          makeAgentUserMessage({
            content: [{ type: "text", text: "first" }],
            timestamp: Date.now(),
          }),
          "turn-1:prompt",
        ),
        attachCodexMirrorIdentity(
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "second" }],
            timestamp: Date.now() + 1,
          }),
          "turn-1:assistant",
        ),
      ],
      idempotencyScope: "codex-app-server:thread-1",
    });

    const updates = publishSessionTranscriptUpdateByIdentityMock.mock.calls.map(
      ([update]) => update as Record<string, unknown> & { update?: Record<string, unknown> },
    );
    expect(updates.map((update) => update.update?.messageSeq)).toEqual([1, 2]);
    expect(
      updates.map((update) => {
        const message = update.update?.message as { role?: string } | undefined;
        return message?.role;
      }),
    ).toEqual(["user", "assistant"]);
  });

  it("creates the transcript directory on first mirror", async () => {
    const root = await makeRoot("openclaw-codex-transcript-missing-dir-");
    const sessionFile = path.join(root, "nested", "sessions", "session.jsonl");

    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionId: "session-1",
      sessionKey: "session-1",
      messages: [
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "first mirror" }],
          timestamp: Date.now(),
        }),
      ],
      idempotencyScope: "scope-1",
    });

    const raw = await fs.readFile(sessionFile, "utf8");
    expect(raw).toContain('"role":"assistant"');
    expect(raw).toContain('"content":[{"type":"text","text":"first mirror"}]');
  });

  it("deduplicates app-server turn mirrors by idempotency scope", async () => {
    const sessionFile = await createTempSessionFile();
    const messages = [
      makeAgentUserMessage({
        content: [{ type: "text", text: "hello" }],
        timestamp: Date.now(),
      }),
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "hi there" }],
        timestamp: Date.now() + 1,
      }),
    ] as const;

    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionId: "session-1",
      sessionKey: "session-1",
      messages: [...messages],
      idempotencyScope: "scope-1",
    });
    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionId: "session-1",
      sessionKey: "session-1",
      messages: [...messages],
      idempotencyScope: "scope-1",
    });

    const records = parseJsonLines<{ type?: string; message?: { role?: string } }>(
      await fs.readFile(sessionFile, "utf8"),
    );
    expect(records.slice(1)).toHaveLength(2);
  });

  it("runs before_message_write before appending mirrored transcript messages", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (event) => ({
            message: castAgentMessage({
              ...((event as { message: unknown }).message as Record<string, unknown>),
              content: [{ type: "text", text: "hello [hooked]" }],
            }),
          }),
        },
      ]),
    );
    const sessionFile = await createTempSessionFile();
    const sourceMessage = makeAgentAssistantMessage({
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });

    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionId: "session-1",
      sessionKey: "session-1",
      messages: [sourceMessage],
      idempotencyScope: "scope-1",
    });

    const raw = await fs.readFile(sessionFile, "utf8");
    expect(raw).toContain('"content":[{"type":"text","text":"hello [hooked]"}]');
    // The idempotency fingerprint is derived from the pre-hook message so a
    // hook rewrite cannot bypass dedupe by reshaping content on every retry.
    expect(raw).toContain(
      `"idempotencyKey":"scope-1:assistant:${expectedFingerprint(sourceMessage)}"`,
    );
  });

  it("returns the persisted user message for duplicate mirror hits", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (event) => ({
            message: castAgentMessage({
              ...((event as { message: unknown }).message as Record<string, unknown>),
              content: [{ type: "text", text: "[redacted by hook]" }],
            }),
          }),
        },
      ]),
    );
    const sessionFile = await createTempSessionFile();
    const sourceMessage = makeAgentUserMessage({
      content: [{ type: "text", text: "secret prompt" }],
      timestamp: Date.now(),
    });

    const first = await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionId: "session-1",
      sessionKey: "session-1",
      messages: [sourceMessage],
      idempotencyScope: "scope-1",
    });
    const second = await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionId: "session-1",
      sessionKey: "session-1",
      messages: [sourceMessage],
      idempotencyScope: "scope-1",
    });

    expect(first.userMessagesPresent[0]?.content).toEqual([
      { type: "text", text: "[redacted by hook]" },
    ]);
    expect(second.userMessagesPresent[0]?.content).toEqual([
      { type: "text", text: "[redacted by hook]" },
    ]);
    expect(JSON.stringify(second.userMessagesPresent)).not.toContain("secret prompt");
    const records = parseJsonLines<{ type?: string; message?: { role?: string } }>(
      await fs.readFile(sessionFile, "utf8"),
    );
    expect(records.filter((record) => record.message?.role === "user")).toHaveLength(1);
  });

  it("preserves the computed idempotency key when hooks rewrite message keys", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (event) => ({
            message: castAgentMessage({
              ...((event as { message: unknown }).message as Record<string, unknown>),
              idempotencyKey: "hook-rewritten-key",
            }),
          }),
        },
      ]),
    );
    const sessionFile = await createTempSessionFile();
    const sourceMessage = makeAgentAssistantMessage({
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });

    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionId: "session-1",
      sessionKey: "session-1",
      messages: [sourceMessage],
      idempotencyScope: "scope-1",
    });

    const raw = await fs.readFile(sessionFile, "utf8");
    expect(raw).toContain(
      `"idempotencyKey":"scope-1:assistant:${expectedFingerprint(sourceMessage)}"`,
    );
    expect(raw).not.toContain("hook-rewritten-key");
  });

  it("respects before_message_write blocking decisions", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: () => ({ block: true }),
        },
      ]),
    );
    const sessionFile = await createTempSessionFile();

    const result = await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionId: "session-1",
      sessionKey: "session-1",
      messages: [
        attachCodexMirrorIdentity(
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "should not persist" }],
            timestamp: Date.now(),
          }),
          "turn-1:assistant",
        ),
      ],
      idempotencyScope: "scope-1",
    });

    expect(result.assistantMirrorIdentitiesOwned).toEqual(["turn-1:assistant"]);
    await expect(fs.readFile(sessionFile, "utf8")).rejects.toHaveProperty("code", "ENOENT");
  });

  it("migrates small linear transcripts before mirroring", async () => {
    const sessionFile = await createTempSessionFile();
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "linear-codex-session",
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
        }),
        JSON.stringify({
          type: "message",
          id: "legacy-user",
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "legacy user" },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionId: "session-1",
      sessionKey: "session-1",
      messages: [
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "mirrored assistant" }],
          timestamp: Date.now(),
        }),
      ],
      idempotencyScope: "scope-1",
    });

    const records = (await fs.readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type?: string;
            id?: string;
            parentId?: string | null;
            message?: { role?: string };
          },
      )
      .filter((record) => record.type === "message");

    expect(records[0]?.id).toBe("legacy-user");
    expect(records[0]?.parentId).toBeNull();
    expect(records[1]?.parentId).toBe("legacy-user");
  });

  // Helpers for the identity-based regression tests below.
  //
  // The mirror dedupe key is now `${idempotencyScope}:${identity}`, where
  // `identity` is either an explicit `attachCodexMirrorIdentity` tag (the
  // production path; event-projector emits `${turnId}:${kind}`) or the
  // role/content fingerprint fallback (legacy callers).
  type FileMessage = {
    type?: string;
    message?: { role?: string; content?: Array<{ text?: string }> };
  };
  function readFileMessages(raw: string): Array<{ role?: string; text?: string }> {
    return parseJsonLines<FileMessage>(raw)
      .filter((record) => record.type === "message")
      .map((record) => ({
        role: record.message?.role,
        text: record.message?.content?.[0]?.text,
      }));
  }

  // Regression for #77012 (within-turn snapshot reordering). When mirror is
  // invoked twice under the same scope/turn but the second snapshot inserts
  // a reasoning record between the user prompt and the assistant reply,
  // every assistant-role record after the inserted slot shifts. With the
  // previous `:role:index` key, the second call's reasoning record collided
  // with the first call's assistant key (both `:assistant:1`) — the
  // legitimately-new reasoning entry was silently dropped, and the
  // assistant content was re-appended under `:assistant:2`, producing a
  // duplicate assistant entry. The identity-based key (event-projector
  // tags `${turnId}:reasoning` and `${turnId}:assistant`) makes each kind
  // its own dedupe slot.
  it("dedupes mirrored messages despite snapshot positional shifts", async () => {
    const sessionFile = await createTempSessionFile();
    const userMessage = attachCodexMirrorIdentity(
      makeAgentUserMessage({
        content: [{ type: "text", text: "hello" }],
        timestamp: Date.now(),
      }),
      "turn-1:prompt",
    );
    const assistantMessage = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "hi there" }],
        timestamp: Date.now() + 1,
      }),
      "turn-1:assistant",
    );

    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionId: "session-1",
      sessionKey: "session-1",
      messages: [userMessage, assistantMessage],
      idempotencyScope: "codex-app-server:thread-X",
    });
    const reasoningMessage = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "[Codex reasoning] thinking" }],
        timestamp: Date.now() + 2,
      }),
      "turn-1:reasoning",
    );
    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionId: "session-1",
      sessionKey: "session-1",
      messages: [userMessage, reasoningMessage, assistantMessage],
      idempotencyScope: "codex-app-server:thread-X",
    });

    const messageTexts = readFileMessages(await fs.readFile(sessionFile, "utf8")).map(
      (m) => m.text,
    );
    expect(messageTexts).toEqual(["hello", "hi there", "[Codex reasoning] thinking"]);
  });

  // Two distinct turns where the user types the same thing must not collapse:
  // each entry carries its own `${turnId}:${kind}` identity so the dedupe
  // key differs even when role+content match. (Prior content-fingerprint-only
  // designs would have collapsed the second user turn here.)
  it("keeps repeated same-content turns distinct", async () => {
    const sessionFile = await createTempSessionFile();
    const userTurn1 = attachCodexMirrorIdentity(
      makeAgentUserMessage({
        content: [{ type: "text", text: "yes" }],
        timestamp: Date.now(),
      }),
      "turn-1:prompt",
    );
    const assistantTurn1 = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "ok 1" }],
        timestamp: Date.now() + 1,
      }),
      "turn-1:assistant",
    );
    const userTurn2 = attachCodexMirrorIdentity(
      makeAgentUserMessage({
        content: [{ type: "text", text: "yes" }],
        timestamp: Date.now() + 2,
      }),
      "turn-2:prompt",
    );
    const assistantTurn2 = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "ok 2" }],
        timestamp: Date.now() + 3,
      }),
      "turn-2:assistant",
    );

    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionId: "session-1",
      sessionKey: "session-1",
      messages: [userTurn1, assistantTurn1],
      idempotencyScope: "codex-app-server:thread-X",
    });
    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionId: "session-1",
      sessionKey: "session-1",
      messages: [userTurn2, assistantTurn2],
      idempotencyScope: "codex-app-server:thread-X",
    });

    expect(readFileMessages(await fs.readFile(sessionFile, "utf8"))).toEqual([
      { role: "user", text: "yes" },
      { role: "assistant", text: "ok 1" },
      { role: "user", text: "yes" },
      { role: "assistant", text: "ok 2" },
    ]);
  });

  // Cross-turn re-emit: an entry first written under turn 1 may be re-emitted
  // as part of a later turn's snapshot (e.g. a context-engine flow that
  // bundles prior history). Because every entry carries its own original
  // `${turnId}:${kind}` identity, the re-emitted entries collide with their
  // existing on-disk keys and become true no-ops — instead of being
  // appended again on a sibling branch (the on-disk symptom in #77012).
  it("dedupes prior-turn entries re-emitted into a later turn's snapshot", async () => {
    const sessionFile = await createTempSessionFile();
    const userTurn1 = attachCodexMirrorIdentity(
      makeAgentUserMessage({
        content: [{ type: "text", text: "msg1" }],
        timestamp: Date.now(),
      }),
      "turn-1:prompt",
    );
    const assistantTurn1 = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "reply1" }],
        timestamp: Date.now() + 1,
      }),
      "turn-1:assistant",
    );
    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionId: "session-1",
      sessionKey: "session-1",
      messages: [userTurn1, assistantTurn1],
      idempotencyScope: "codex-app-server:thread-X",
    });

    const userTurn2 = attachCodexMirrorIdentity(
      makeAgentUserMessage({
        content: [{ type: "text", text: "msg2" }],
        timestamp: Date.now() + 2,
      }),
      "turn-2:prompt",
    );
    const assistantTurn2 = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "reply2" }],
        timestamp: Date.now() + 3,
      }),
      "turn-2:assistant",
    );
    // Buggy upstream: snapshot for turn 2 also includes the just-completed
    // turn 1's entries (with their original identities preserved).
    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionId: "session-1",
      sessionKey: "session-1",
      messages: [userTurn1, assistantTurn1, userTurn2, assistantTurn2],
      idempotencyScope: "codex-app-server:thread-X",
    });

    expect(readFileMessages(await fs.readFile(sessionFile, "utf8"))).toEqual([
      { role: "user", text: "msg1" },
      { role: "assistant", text: "reply1" },
      { role: "user", text: "msg2" },
      { role: "assistant", text: "reply2" },
    ]);
  });

  // Backward-compat: callers that do not tag messages with a mirror identity
  // (e.g. third-party harnesses or tests routed through the legacy path)
  // still get the role/content fingerprint key. Distinct turns are then
  // distinguished by the caller's idempotency scope.
  it("falls back to the role+content fingerprint when no identity is attached", async () => {
    const sessionFile = await createTempSessionFile();
    const userMessage = makeAgentUserMessage({
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });
    const assistantMessage = makeAgentAssistantMessage({
      content: [{ type: "text", text: "hi there" }],
      timestamp: Date.now() + 1,
    });

    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionId: "session-1",
      sessionKey: "session-1",
      messages: [userMessage, assistantMessage],
      idempotencyScope: "scope-1",
    });

    const raw = await fs.readFile(sessionFile, "utf8");
    expect(raw).toContain(`"idempotencyKey":"scope-1:user:${expectedFingerprint(userMessage)}"`);
    expect(raw).toContain(
      `"idempotencyKey":"scope-1:assistant:${expectedFingerprint(assistantMessage)}"`,
    );
  });
});
