import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSessionWriteLockModuleMock } from "../../test-utils/session-write-lock-module-mock.js";

const acquireSessionWriteLockReleaseMock = vi.hoisted(() => vi.fn(async () => {}));
const acquireSessionWriteLockMock = vi.hoisted(() =>
  vi.fn(async (_params?: unknown) => ({ release: acquireSessionWriteLockReleaseMock })),
);

vi.mock("../session-write-lock.js", () =>
  buildSessionWriteLockModuleMock(
    () => vi.importActual<typeof import("../session-write-lock.js")>("../session-write-lock.js"),
    (params) => acquireSessionWriteLockMock(params),
  ),
);

let rewriteTranscriptEntriesInSessionFile: typeof import("./transcript-rewrite.js").rewriteTranscriptEntriesInSessionFile;
let rewriteTranscriptEntriesInSessionManager: typeof import("./transcript-rewrite.js").rewriteTranscriptEntriesInSessionManager;
let onSessionTranscriptUpdate: typeof import("../../sessions/transcript-events.js").onSessionTranscriptUpdate;
let installSessionToolResultGuard: typeof import("../session-tool-result-guard.js").installSessionToolResultGuard;

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];

function asAppendMessage(message: unknown): AppendMessage {
  return message as AppendMessage;
}

function getBranchMessages(sessionManager: SessionManager): AgentMessage[] {
  return sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
}

function appendSessionMessages(
  sessionManager: SessionManager,
  messages: AppendMessage[],
): string[] {
  return messages.map((message) => sessionManager.appendMessage(message));
}

function createTextContent(text: string) {
  return [{ type: "text", text }];
}

function createReadRewriteSession(options?: { tailAssistantText?: string }) {
  const sessionManager = SessionManager.inMemory();
  const entryIds = appendSessionMessages(sessionManager, [
    asAppendMessage({
      role: "user",
      content: "read file",
      timestamp: 1,
    }),
    asAppendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      timestamp: 2,
    }),
    asAppendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: createTextContent("x".repeat(8_000)),
      isError: false,
      timestamp: 3,
    }),
    asAppendMessage({
      role: "assistant",
      content: createTextContent(options?.tailAssistantText ?? "summarized"),
      timestamp: 4,
    }),
  ]);
  return {
    sessionManager,
    toolResultEntryId: entryIds[2],
    tailAssistantEntryId: entryIds[3],
  };
}

function createExecRewriteSession() {
  const sessionManager = SessionManager.inMemory();
  const entryIds = appendSessionMessages(sessionManager, [
    asAppendMessage({
      role: "user",
      content: "run tool",
      timestamp: 1,
    }),
    asAppendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "exec",
      content: createTextContent("before rewrite"),
      isError: false,
      timestamp: 2,
    }),
    asAppendMessage({
      role: "assistant",
      content: createTextContent("summarized"),
      timestamp: 3,
    }),
  ]);
  return {
    sessionManager,
    toolResultEntryId: entryIds[1],
  };
}

function createToolResultReplacement(toolName: string, text: string, timestamp: number) {
  return {
    role: "toolResult",
    toolCallId: "call_1",
    toolName,
    content: createTextContent(text),
    isError: false,
    timestamp,
  } as AgentMessage;
}

function findAssistantEntryByText(sessionManager: SessionManager, text: string) {
  return sessionManager
    .getBranch()
    .find(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        Array.isArray(entry.message.content) &&
        entry.message.content.some((part) => part.type === "text" && part.text === text),
    );
}

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

function requireString(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

beforeAll(async () => {
  ({ onSessionTranscriptUpdate } = await import("../../sessions/transcript-events.js"));
  ({ installSessionToolResultGuard } = await import("../session-tool-result-guard.js"));
  ({ rewriteTranscriptEntriesInSessionFile, rewriteTranscriptEntriesInSessionManager } =
    await import("./transcript-rewrite.js"));
});

beforeEach(() => {
  acquireSessionWriteLockMock.mockClear();
  acquireSessionWriteLockReleaseMock.mockClear();
});

describe("rewriteTranscriptEntriesInSessionManager", () => {
  it("branches from the first replaced message and re-appends the remaining suffix", () => {
    const { sessionManager, toolResultEntryId } = createReadRewriteSession();

    const result = rewriteTranscriptEntriesInSessionManager({
      sessionManager,
      replacements: [
        {
          entryId: toolResultEntryId,
          message: createToolResultReplacement("read", "[externalized file_123]", 3),
        },
      ],
    });

    expect(result.changed).toBe(true);
    expect(result.rewrittenEntries).toBe(1);
    expect(result.bytesFreed).toBeGreaterThan(0);

    const branchMessages = getBranchMessages(sessionManager);
    expect(branchMessages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    const rewrittenToolResult = branchMessages[2] as Extract<AgentMessage, { role: "toolResult" }>;
    expect(rewrittenToolResult.content).toEqual([
      { type: "text", text: "[externalized file_123]" },
    ]);
  });

  it("preserves active-branch labels after rewritten entries are re-appended", () => {
    const { sessionManager, toolResultEntryId } = createReadRewriteSession();
    const summaryEntry = requireValue(
      findAssistantEntryByText(sessionManager, "summarized"),
      "summary entry",
    );
    sessionManager.appendLabelChange(summaryEntry.id, "bookmark");

    const result = rewriteTranscriptEntriesInSessionManager({
      sessionManager,
      replacements: [
        {
          entryId: toolResultEntryId,
          message: createToolResultReplacement("read", "[externalized file_123]", 3),
        },
      ],
    });

    expect(result.changed).toBe(true);
    const rewrittenSummaryEntry = requireValue(
      findAssistantEntryByText(sessionManager, "summarized"),
      "rewritten summary entry",
    );
    expect(sessionManager.getLabel(rewrittenSummaryEntry.id)).toBe("bookmark");
    expect(sessionManager.getBranch().map((entry) => entry.type)).toContain("label");
  });

  it("remaps compaction keep markers when rewritten entries change ids", () => {
    const {
      sessionManager,
      toolResultEntryId,
      tailAssistantEntryId: keptAssistantEntryId,
    } = createReadRewriteSession({ tailAssistantText: "keep me" });
    sessionManager.appendCompaction("summary", keptAssistantEntryId, 123);

    const result = rewriteTranscriptEntriesInSessionManager({
      sessionManager,
      replacements: [
        {
          entryId: toolResultEntryId,
          message: createToolResultReplacement("read", "[externalized file_123]", 3),
        },
      ],
    });

    expect(result.changed).toBe(true);
    const branch = sessionManager.getBranch();
    const keptAssistantEntry = branch.find(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        Array.isArray(entry.message.content) &&
        entry.message.content.some((part) => part.type === "text" && part.text === "keep me"),
    );
    const compactionEntry = branch.find((entry) => entry.type === "compaction");

    const keptAssistant = requireValue(keptAssistantEntry, "kept assistant entry");
    const compaction = requireValue(compactionEntry, "compaction entry");
    if (compaction.type !== "compaction") {
      throw new Error("expected compaction entry");
    }
    expect(compaction.firstKeptEntryId).toBe(keptAssistant.id);
    expect(compaction.firstKeptEntryId).not.toBe(keptAssistantEntryId);
  });

  it("bypasses persistence hooks when replaying rewritten messages", () => {
    const { sessionManager, toolResultEntryId } = createExecRewriteSession();
    installSessionToolResultGuard(sessionManager, {
      transformToolResultForPersistence: (message) => ({
        ...(message as Extract<AgentMessage, { role: "toolResult" }>),
        content: [{ type: "text", text: "[hook transformed]" }],
      }),
      beforeMessageWriteHook: ({ message }) =>
        message.role === "assistant" ? { block: true } : undefined,
    });

    const result = rewriteTranscriptEntriesInSessionManager({
      sessionManager,
      replacements: [
        {
          entryId: toolResultEntryId,
          message: createToolResultReplacement("exec", "[exact replacement]", 2),
        },
      ],
    });

    expect(result.changed).toBe(true);
    const branchMessages = getBranchMessages(sessionManager);
    expect(branchMessages.map((message) => message.role)).toEqual([
      "user",
      "toolResult",
      "assistant",
    ]);
    expect((branchMessages[1] as Extract<AgentMessage, { role: "toolResult" }>).content).toEqual([
      { type: "text", text: "[exact replacement]" },
    ]);
    const replayedAssistant = branchMessages[2];
    if (!replayedAssistant || replayedAssistant.role !== "assistant") {
      throw new Error("expected rewritten suffix to replay the assistant summary");
    }
    expect(replayedAssistant.content).toEqual([{ type: "text", text: "summarized" }]);
  });
});

describe("rewriteTranscriptEntriesInSessionFile", () => {
  it("emits transcript updates when the active branch changes without opening a manager", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-rewrite-"));
    const sessionManager = SessionManager.create(dir, dir);
    const entryIds = appendSessionMessages(sessionManager, [
      asAppendMessage({
        role: "user",
        content: "run tool",
        timestamp: 1,
      }),
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "exec",
        content: createTextContent("before rewrite"),
        isError: false,
        timestamp: 2,
      }),
      asAppendMessage({
        role: "assistant",
        content: createTextContent("summarized"),
        timestamp: 3,
      }),
    ]);
    const sessionFile = requireString(sessionManager.getSessionFile(), "persisted session file");
    const toolResultEntryId = entryIds[1];

    const openSpy = vi.spyOn(SessionManager, "open").mockImplementation(() => {
      throw new Error("SessionManager.open should not be used for file rewrites");
    });
    const listener = vi.fn();
    const cleanup = onSessionTranscriptUpdate(listener);

    try {
      const result = await rewriteTranscriptEntriesInSessionFile({
        sessionFile,
        sessionKey: "agent:main:test",
        request: {
          replacements: [
            {
              entryId: toolResultEntryId,
              message: createToolResultReplacement("exec", "[file_ref:file_abc]", 2),
            },
          ],
        },
      });

      expect(result.changed).toBe(true);
      expect(acquireSessionWriteLockMock).toHaveBeenCalledWith({
        sessionFile,
        staleMs: 1_800_000,
        timeoutMs: 60_000,
        maxHoldMs: 300_000,
      });
      expect(acquireSessionWriteLockReleaseMock).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({ sessionFile, sessionKey: "agent:main:test" });

      openSpy.mockRestore();
      const rewrittenSession = SessionManager.open(sessionFile);
      const rewrittenToolResult = getBranchMessages(rewrittenSession)[1] as Extract<
        AgentMessage,
        { role: "toolResult" }
      >;
      expect(rewrittenToolResult.content).toEqual([{ type: "text", text: "[file_ref:file_abc]" }]);
    } finally {
      cleanup();
      openSpy.mockRestore();
    }
  });
});
