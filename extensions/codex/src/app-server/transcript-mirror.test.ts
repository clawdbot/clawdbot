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
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  castAgentMessage,
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexThread } from "./protocol.js";
import { readCodexMirroredSessionHistoryMessages } from "./session-history.js";
import {
  buildCodexUserPromptMessage,
  codexTranscriptMirrorRuntime,
  importCodexThreadHistoryToTranscript,
  projectBoundedCodexThreadHistory,
} from "./transcript-mirror.js";
import { attachCodexMirrorIdentity } from "./upstream-prompt-provenance.js";

const mirrorCodexAppServerTranscript = codexTranscriptMirrorRuntime.mirror;
const mirrorTranscriptBestEffort = codexTranscriptMirrorRuntime.mirrorBestEffort;

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

// Mirrors transcript-mirror.ts's content fingerprint exactly so test
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

function readEventMessages(events: unknown[]): Array<{ role?: string; text?: string }> {
  return events
    .map((event) =>
      event && typeof event === "object" ? (event as { message?: unknown }).message : undefined,
    )
    .filter((message): message is { role?: string; content?: unknown } =>
      Boolean(message && typeof message === "object"),
    )
    .map((message) => {
      const content = Array.isArray(message.content)
        ? message.content.find((part): part is { text: string } =>
            Boolean(part && typeof part === "object" && typeof part.text === "string"),
          )?.text
        : typeof message.content === "string"
          ? message.content
          : undefined;
      return { role: message.role, text: content };
    });
}

async function createSqliteMirrorTarget(prefix: string, options: { sessionId?: string } = {}) {
  const root = await makeRoot(prefix);
  const agentId = "main";
  const sessionId = options.sessionId ?? "session-1";
  const sessionKey = `agent:${agentId}:${sessionId}`;
  const storePath = path.join(root, "openclaw-agent.sqlite");
  await upsertSessionEntry({
    agentId,
    sessionKey,
    storePath,
    entry: {
      sessionFile: `sqlite:${agentId}:${sessionId}:${storePath}`,
      sessionId,
      updatedAt: 1,
    },
  });
  return {
    agentId,
    sessionId,
    sessionKey,
    storePath,
    bogusSessionFile: path.join(root, "should-not-be-created.jsonl"),
  };
}

async function readMirrorEvents(target: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<unknown[]> {
  return await readSessionTranscriptEvents(target);
}

async function readMirrorRaw(target: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<string> {
  return (await readMirrorEvents(target)).map((event) => JSON.stringify(event)).join("\n");
}

async function readMirrorMessages(target: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<Array<{ role?: string; text?: string }>> {
  return readEventMessages(await readMirrorEvents(target));
}

describe("importCodexThreadHistoryToTranscript", () => {
  it("imports only bounded user-visible conversation items with stable identities", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-history-", {
      sessionId: "session-history",
    });
    const sessionFile = `sqlite:${target.agentId}:${target.sessionId}:${target.storePath}`;
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
        storePath: target.storePath,
        sessionId: "session-history",
        sessionKey: target.sessionKey,
        agentId: target.agentId,
      }),
    ).resolves.toEqual({ importedMessages: 2, omittedMessages: 0 });

    const events = await readMirrorEvents(target);
    const raw = events.map((event) => JSON.stringify(event)).join("\n");
    const messages = (events as Array<{ message?: AgentMessage; type?: string }>)
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
        sessionKey: target.sessionKey,
        agentId: target.agentId,
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
    const target = await createSqliteMirrorTarget("openclaw-codex-bounded-history-", {
      sessionId: "session-bounded-history",
    });
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
      storePath: target.storePath,
      sessionId: "session-bounded-history",
      sessionKey: target.sessionKey,
      agentId: target.agentId,
    };

    await expect(importCodexThreadHistoryToTranscript(importParams)).resolves.toEqual({
      importedMessages: 200,
      omittedMessages: 5,
    });
    await expect(importCodexThreadHistoryToTranscript(importParams)).resolves.toEqual({
      importedMessages: 200,
      omittedMessages: 5,
    });

    const events = await readMirrorEvents(target);
    const messages = (events as Array<{ message?: AgentMessage; type?: string }>)
      .filter((event) => event.type === "message")
      .map((event) => event.message);
    expect(messages).toHaveLength(200);
    expect(messages[0]).toMatchObject({ content: "message-5" });
    expect(messages.at(-1)).toMatchObject({ content: "message-204" });
  });

  it("assigns canonical assistant attribution and numeric fallback timestamps", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-fallback-history-", {
      sessionId: "session-fallback-history",
    });
    const sessionFile = `sqlite:${target.agentId}:${target.sessionId}:${target.storePath}`;
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
      storePath: target.storePath,
      sessionId: "session-fallback-history",
      sessionKey: target.sessionKey,
      agentId: target.agentId,
    });

    const history = await readCodexMirroredSessionHistoryMessages({
      sessionFile,
      sessionId: "session-fallback-history",
      sessionKey: target.sessionKey,
      agentId: target.agentId,
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
  it("hides current memory-maintenance messages without hiding replayed turns", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (event) => {
            const { display: _display, ...message } = (
              event as { message: Record<string, unknown> }
            ).message;
            return { message: castAgentMessage(message) };
          },
        },
      ]),
    );
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-memory-");
    const messages = [
      attachCodexMirrorIdentity(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "ordinary prior reply" }],
          timestamp: Date.now(),
        }),
        "turn-prior:assistant",
      ),
      attachCodexMirrorIdentity(
        makeAgentUserMessage({
          content: [{ type: "text", text: "Pre-compaction memory flush" }],
          timestamp: Date.now() + 1,
        }),
        "turn-memory:prompt",
      ),
      attachCodexMirrorIdentity(
        makeAgentAssistantMessage({
          content: [{ type: "toolCall", id: "call-1", name: "write", arguments: {} }],
          timestamp: Date.now() + 2,
        }),
        "turn-memory:tool-call:call-1",
      ),
      attachCodexMirrorIdentity(
        castAgentMessage({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "write",
          content: [{ type: "toolResult", toolCallId: "call-1", content: "saved" }],
          timestamp: Date.now() + 3,
        }),
        "turn-memory:tool-result:call-1",
      ),
      attachCodexMirrorIdentity(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "NO_REPLY" }],
          timestamp: Date.now() + 4,
        }),
        "turn-memory:assistant",
      ),
    ];
    for (const message of messages.slice(1)) {
      Object.assign(message, { display: false });
    }

    await mirrorCodexAppServerTranscript({
      ...target,
      messages,
      idempotencyScope: "codex-app-server:memory",
    });

    const persistedMessages = (await readMirrorEvents(target))
      .map((event) =>
        event && typeof event === "object" ? (event as { message?: unknown }).message : undefined,
      )
      .filter((message): message is Record<string, unknown> =>
        Boolean(message && typeof message === "object"),
      );
    expect(persistedMessages).toHaveLength(messages.length);
    expect(persistedMessages[0]).not.toHaveProperty("display", false);
    expect(persistedMessages.slice(1).every((message) => message.display === false)).toBe(true);
  });

  it("mirrors user, assistant, and tool result messages by SQLite identity", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-basic-");
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
      content: [{ type: "toolResult", toolCallId: "call-1", content: "read output" }],
      timestamp: Date.now() + 2,
    }) as MirroredAgentMessage;

    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userMessage, assistantMessage, toolResultMessage],
      idempotencyScope: "scope-1",
    });

    const raw = await readMirrorRaw(target);
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
    await expect(fs.readFile(target.bogusSessionFile, "utf8")).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
  });

  it("preserves gateway user-turn identity across Codex transcript mirroring", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-user-identity-");
    const userMessage = castAgentMessage({
      ...makeAgentUserMessage({
        content: [{ type: "text", text: "client prompt" }],
        timestamp: Date.now(),
      }),
      idempotencyKey: "client-run:user",
    }) as MirroredAgentMessage;

    const first = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });
    const second = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });

    const raw = await readMirrorRaw(target);
    expect(raw).toContain('"idempotencyKey":"client-run:user"');
    expect(raw).toContain('"mirrorOrigin":"codex-app-server"');
    expect(raw).not.toContain('"idempotencyKey":"codex-app-server:thread-1:');
    expect(first.userMessagesPresent).toHaveLength(1);
    expect(second.userMessagesPresent).toHaveLength(1);
    expect(
      (await readMirrorMessages(target)).filter((message) => message.role === "user"),
    ).toHaveLength(1);
  });

  it("emits message-bearing updates for newly appended mirrored messages only", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-live-updates-");
    const userMessage = attachCodexMirrorIdentity(
      makeAgentUserMessage({
        content: [{ type: "text", text: "show me live" }],
        timestamp: Date.now(),
      }),
      "turn-1:prompt",
    );

    const firstMirror = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });
    const secondMirror = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });

    const updates = publishSessionTranscriptUpdateByIdentityMock.mock.calls.map(
      ([update]) => update as Record<string, unknown> & { update?: Record<string, unknown> },
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.sessionKey).toBe(target.sessionKey);
    expect(updates[0]?.storePath).toBe(target.storePath);
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

  it("emits stable sequence numbers for multi-message mirror batches", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-seq-");

    await mirrorCodexAppServerTranscript({
      ...target,
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

  it("keeps assistant ownership when live update publication fails", async () => {
    publishSessionTranscriptUpdateByIdentityMock.mockRejectedValueOnce(new Error("publish failed"));
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-publish-failure-");
    const assistantMessage = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "durably persisted" }],
        timestamp: Date.now(),
      }),
      "turn-1:assistant",
    );

    const result = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [assistantMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });

    expect(result.assistantMirrorIdentitiesOwned).toEqual(["turn-1:assistant"]);
    expect(await readMirrorRaw(target)).toContain('"role":"assistant"');
  });

  it("rejects mirror writes without a runtime session identity", async () => {
    await expect(
      mirrorCodexAppServerTranscript({
        sessionId: "session-1",
        messages: [
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "no identity" }],
            timestamp: Date.now(),
          }),
        ],
      }),
    ).rejects.toThrow("runtime session identity");
  });

  it("deduplicates app-server turn mirrors by idempotency scope", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-dedupe-");
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
      ...target,
      messages: [...messages],
      idempotencyScope: "scope-1",
    });
    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [...messages],
      idempotencyScope: "scope-1",
    });

    expect((await readMirrorMessages(target)).filter((message) => message.role)).toHaveLength(2);
  });

  it("reports final assistant ownership for new and idempotent mirrors", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-assistant-owned-");
    const assistantMessage = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "owned once" }],
        timestamp: Date.now(),
      }),
      "turn-1:assistant",
    );

    const firstMirror = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [assistantMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });
    const secondMirror = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [assistantMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });

    expect(firstMirror.assistantMirrorIdentitiesOwned).toEqual(["turn-1:assistant"]);
    expect(secondMirror.assistantMirrorIdentitiesOwned).toEqual(["turn-1:assistant"]);
    expect(
      (await readMirrorMessages(target)).filter((message) => message.role === "assistant"),
    ).toHaveLength(1);
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
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-hook-");
    const sourceMessage = makeAgentAssistantMessage({
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });

    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [sourceMessage],
      idempotencyScope: "scope-1",
    });

    const raw = await readMirrorRaw(target);
    expect(raw).toContain('"content":[{"type":"text","text":"hello [hooked]"}]');
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
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-duplicates-");
    const sourceMessage = makeAgentUserMessage({
      content: [{ type: "text", text: "secret prompt" }],
      timestamp: Date.now(),
    });

    const first = await mirrorCodexAppServerTranscript({
      ...target,
      messages: [sourceMessage],
      idempotencyScope: "scope-1",
    });
    const second = await mirrorCodexAppServerTranscript({
      ...target,
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
    expect(
      (await readMirrorMessages(target)).filter((message) => message.role === "user"),
    ).toHaveLength(1);
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
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-key-hook-");
    const sourceMessage = makeAgentAssistantMessage({
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });

    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [sourceMessage],
      idempotencyScope: "scope-1",
    });

    const raw = await readMirrorRaw(target);
    expect(raw).toContain(
      `"idempotencyKey":"scope-1:assistant:${expectedFingerprint(sourceMessage)}"`,
    );
    expect(raw).not.toContain("hook-rewritten-key");
  });

  it("respects before_message_write blocking decisions", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_message_write", handler: () => ({ block: true }) },
      ]),
    );
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-blocked-");

    const result = await mirrorCodexAppServerTranscript({
      ...target,
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
    expect(await readMirrorMessages(target)).toEqual([]);
  });

  it("leaves the assistant unowned when transcript persistence fails", async () => {
    const root = await makeRoot("openclaw-codex-transcript-failure-");
    const assistantMessage = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "needs fallback persistence" }],
        timestamp: Date.now(),
      }),
      "turn-1:assistant",
    );

    const mirrorOutcome = await mirrorTranscriptBestEffort({
      params: {
        sessionId: "session-1",
        suppressNextUserMessagePersistence: true,
      } as unknown as Parameters<typeof mirrorTranscriptBestEffort>[0]["params"],
      result: {
        messagesSnapshot: [assistantMessage],
      } as Parameters<typeof mirrorTranscriptBestEffort>[0]["result"],
      notifyUserMessagePersisted: () => undefined,
      cwd: root,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(mirrorOutcome).toEqual({ assistantTranscriptOwned: false, mirroredMessages: [] });
  });

  it("does not attest a stale idempotency hit with the same mirror identity", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-stale-identity-");
    const staleMessage = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "stale answer" }],
        timestamp: Date.now(),
      }),
      "turn-1:assistant",
    );
    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [staleMessage],
      idempotencyScope: "codex-app-server:thread-1",
    });
    const currentMessage = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "current answer" }],
        timestamp: Date.now() + 1,
      }),
      "turn-1:assistant",
    );

    const mirrorOutcome = await mirrorTranscriptBestEffort({
      params: {
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        sessionTarget: target,
        suppressNextUserMessagePersistence: true,
      } as unknown as Parameters<typeof mirrorTranscriptBestEffort>[0]["params"],
      result: {
        messagesSnapshot: [currentMessage],
      } as Parameters<typeof mirrorTranscriptBestEffort>[0]["result"],
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      notifyUserMessagePersisted: () => undefined,
      cwd: target.storePath,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(mirrorOutcome.assistantTranscriptOwned).toBe(true);
    expect(mirrorOutcome.mirroredMessages).toEqual([]);
  });

  it("attests the exact persisted payload after a message-write hook transforms it", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: () => ({
            message: castAgentMessage({
              role: "assistant",
              content: [{ type: "text", text: "[redacted by hook]" }],
            }),
          }),
        },
      ]),
    );
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-attested-hook-");
    const sourceMessage = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "sensitive answer" }],
        timestamp: Date.now(),
      }),
      "turn-1:assistant",
    );

    const mirrorOutcome = await mirrorTranscriptBestEffort({
      params: {
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        sessionTarget: target,
        suppressNextUserMessagePersistence: true,
      } as unknown as Parameters<typeof mirrorTranscriptBestEffort>[0]["params"],
      result: {
        messagesSnapshot: [sourceMessage],
      } as Parameters<typeof mirrorTranscriptBestEffort>[0]["result"],
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      notifyUserMessagePersisted: () => undefined,
      cwd: target.storePath,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(mirrorOutcome.assistantTranscriptOwned).toBe(true);
    expect(mirrorOutcome.assistantTranscriptIdempotencyKey).toBe(
      "codex-app-server:thread-1:turn-1:assistant",
    );
    expect(mirrorOutcome.mirroredMessages).toMatchObject([
      { role: "assistant", content: [{ type: "text", text: "[redacted by hook]" }] },
    ]);
    expect(JSON.stringify(mirrorOutcome.mirroredMessages)).not.toContain("sensitive answer");
  });

  it("dedupes mirrored messages despite snapshot positional shifts", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-shift-");
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
      ...target,
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
      ...target,
      messages: [userMessage, reasoningMessage, assistantMessage],
      idempotencyScope: "codex-app-server:thread-X",
    });

    expect((await readMirrorMessages(target)).map((m) => m.text)).toEqual([
      "hello",
      "hi there",
      "[Codex reasoning] thinking",
    ]);
  });

  it("keeps repeated same-content turns distinct", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-repeat-");
    const userTurn1 = attachCodexMirrorIdentity(
      makeAgentUserMessage({ content: [{ type: "text", text: "yes" }], timestamp: Date.now() }),
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
      makeAgentUserMessage({ content: [{ type: "text", text: "yes" }], timestamp: Date.now() + 2 }),
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
      ...target,
      messages: [userTurn1, assistantTurn1],
      idempotencyScope: "codex-app-server:thread-X",
    });
    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userTurn2, assistantTurn2],
      idempotencyScope: "codex-app-server:thread-X",
    });

    expect(await readMirrorMessages(target)).toEqual([
      { role: "user", text: "yes" },
      { role: "assistant", text: "ok 1" },
      { role: "user", text: "yes" },
      { role: "assistant", text: "ok 2" },
    ]);
  });

  it("dedupes prior-turn entries re-emitted into a later turn's snapshot", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-reemit-");
    const userTurn1 = attachCodexMirrorIdentity(
      makeAgentUserMessage({ content: [{ type: "text", text: "msg1" }], timestamp: Date.now() }),
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
      ...target,
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
    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userTurn1, assistantTurn1, userTurn2, assistantTurn2],
      idempotencyScope: "codex-app-server:thread-X",
    });

    expect(await readMirrorMessages(target)).toEqual([
      { role: "user", text: "msg1" },
      { role: "assistant", text: "reply1" },
      { role: "user", text: "msg2" },
      { role: "assistant", text: "reply2" },
    ]);
  });

  it("uses the role+content fingerprint when no identity is attached", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-fingerprint-");
    const userMessage = makeAgentUserMessage({
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });
    const assistantMessage = makeAgentAssistantMessage({
      content: [{ type: "text", text: "hi there" }],
      timestamp: Date.now() + 1,
    });

    await mirrorCodexAppServerTranscript({
      ...target,
      messages: [userMessage, assistantMessage],
      idempotencyScope: "scope-1",
    });

    const raw = await readMirrorRaw(target);
    expect(raw).toContain(`"idempotencyKey":"scope-1:user:${expectedFingerprint(userMessage)}"`);
    expect(raw).toContain(
      `"idempotencyKey":"scope-1:assistant:${expectedFingerprint(assistantMessage)}"`,
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
