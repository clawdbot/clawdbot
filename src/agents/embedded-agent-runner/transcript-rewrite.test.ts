// Transcript rewrite tests cover in-memory and persisted JSONL rewrites for
// tool-result externalization, labels, compaction markers, and write locks.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/sqlite-marker.js";
import type { SessionEntry } from "../../config/sessions/types.js";
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

let rewriteTranscriptEntriesInSessionManager: typeof import("./transcript-rewrite.js").rewriteTranscriptEntriesInSessionManager;
let rewriteTranscriptEntriesInRuntimeTranscript: typeof import("./transcript-rewrite.js").rewriteTranscriptEntriesInRuntimeTranscript;
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
  // Read rewrite fixtures include a suffix assistant turn so branch rewrites
  // must re-append downstream entries after replacing the tool result.
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
  // Fail with a labeled invariant instead of letting optional entries produce
  // weak assertions later in transcript-branch tests.
  if (value === undefined) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

beforeAll(async () => {
  ({ onSessionTranscriptUpdate } = await import("../../sessions/transcript-events.js"));
  ({ installSessionToolResultGuard } = await import("../session-tool-result-guard.js"));
  ({ rewriteTranscriptEntriesInRuntimeTranscript, rewriteTranscriptEntriesInSessionManager } =
    await import("./transcript-rewrite.js"));
});

beforeEach(() => {
  acquireSessionWriteLockMock.mockClear();
  acquireSessionWriteLockReleaseMock.mockClear();
});

describe("rewriteTranscriptEntriesInSessionManager", () => {
  it("branches from the first replaced message and re-appends the remaining suffix", () => {
    const { sessionManager, toolResultEntryId } = createReadRewriteSession();

    const result = expectDefined(
      rewriteTranscriptEntriesInSessionManager({
        sessionManager,
        replacements: [
          {
            entryId: expectDefined(toolResultEntryId, "toolResultEntryId test invariant"),
            message: createToolResultReplacement("read", "[externalized file_123]", 3),
          },
        ],
      }),
      "rewriteTranscriptEntriesInSessionManager({ sessionManager, replacemen... test invariant",
    );

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

    const result = expectDefined(
      rewriteTranscriptEntriesInSessionManager({
        sessionManager,
        replacements: [
          {
            entryId: expectDefined(toolResultEntryId, "toolResultEntryId test invariant"),
            message: createToolResultReplacement("read", "[externalized file_123]", 3),
          },
        ],
      }),
      "rewriteTranscriptEntriesInSessionManager({ sessionManager, replacemen... test invariant",
    );

    expect(result.changed).toBe(true);
    const rewrittenSummaryEntry = requireValue(
      findAssistantEntryByText(sessionManager, "summarized"),
      "rewritten summary entry",
    );
    expect(sessionManager.getLabel(rewrittenSummaryEntry.id)).toBe("bookmark");
    expect(sessionManager.getBranch().map((entry) => entry.type)).toContain("label");
  });

  it("remaps compaction keep markers when rewritten entries change ids", () => {
    // Re-appending entries changes ids; compaction records must follow the new
    // first-kept entry or future branch reconstruction points at stale ids.
    const {
      sessionManager,
      toolResultEntryId,
      tailAssistantEntryId: keptAssistantEntryId,
    } = createReadRewriteSession({ tailAssistantText: "keep me" });
    sessionManager.appendCompaction(
      "summary",
      expectDefined(keptAssistantEntryId, "keptAssistantEntryId test invariant"),
      123,
    );

    const result = expectDefined(
      rewriteTranscriptEntriesInSessionManager({
        sessionManager,
        replacements: [
          {
            entryId: expectDefined(toolResultEntryId, "toolResultEntryId test invariant"),
            message: createToolResultReplacement("read", "[externalized file_123]", 3),
          },
        ],
      }),
      "rewriteTranscriptEntriesInSessionManager({ sessionManager, replacemen... test invariant",
    );

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

    const result = expectDefined(
      rewriteTranscriptEntriesInSessionManager({
        sessionManager,
        replacements: [
          {
            entryId: expectDefined(toolResultEntryId, "toolResultEntryId test invariant"),
            message: createToolResultReplacement("exec", "[exact replacement]", 2),
          },
        ],
      }),
      "rewriteTranscriptEntriesInSessionManager({ sessionManager, replacemen... test invariant",
    );

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

describe("rewriteTranscriptEntriesInRuntimeTranscript", () => {
  it("does not create session metadata for missing runtime transcripts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-rewrite-runtime-"));
    const storePath = path.join(dir, "sessions.json");
    await fs.writeFile(storePath, "{}\n", "utf8");

    const result = await rewriteTranscriptEntriesInRuntimeTranscript({
      scope: {
        agentId: "main",
        sessionId: "missing-session",
        sessionKey: "agent:main:missing",
        storePath,
      },
      request: { replacements: [] },
    });

    expect(result.changed).toBe(false);
    expect(await fs.readFile(storePath, "utf8")).toBe("{}\n");
  });

  it("rewrites runtime transcripts through scoped session identity", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-rewrite-runtime-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "runtime-sqlite-rewrite";
    const sessionFile = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: "agent:main:test",
      storePath,
    };
    await replaceSessionEntry({ sessionKey: "agent:main:test", storePath }, {
      sessionFile,
      sessionId,
      updatedAt: 10,
    } as SessionEntry);
    await appendTranscriptMessage(scope, {
      message: {
        role: "user",
        content: "run tool",
        timestamp: 1,
      },
    });
    const toolResult = await appendTranscriptMessage(scope, {
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "exec",
        content: createTextContent("before rewrite"),
        isError: false,
        timestamp: 2,
      },
    });
    await appendTranscriptMessage(scope, {
      message: {
        role: "assistant",
        content: createTextContent("summarized"),
        timestamp: 3,
      },
    });
    const toolResultEntryId = toolResult.messageId;
    const listener = vi.fn();
    const cleanup = onSessionTranscriptUpdate(listener);

    try {
      const result = await rewriteTranscriptEntriesInRuntimeTranscript({
        scope: {
          agentId: "main",
          sessionId,
          sessionKey: "agent:main:test",
          storePath,
        },
        request: {
          replacements: [
            {
              entryId: toolResultEntryId,
              message: createToolResultReplacement("exec", "[runtime rewrite]", 2),
            },
          ],
        },
      });

      expect(result.changed).toBe(true);
      expect(acquireSessionWriteLockMock).not.toHaveBeenCalled();
      expect(acquireSessionWriteLockReleaseMock).not.toHaveBeenCalled();
      expect(listener).toHaveBeenCalledWith({
        agentId: "main",
        sessionId,
        sessionKey: "agent:main:test",
        target: {
          agentId: "main",
          sessionId,
          sessionKey: "agent:main:test",
        },
      });

      const branchMessages = (await loadTranscriptEvents(scope))
        .filter(
          (entry): entry is { message: AgentMessage; type: "message" } =>
            typeof entry === "object" &&
            entry !== null &&
            "message" in entry &&
            "type" in entry &&
            entry.type === "message",
        )
        .map((entry) => entry.message);
      expect(branchMessages.map((message) => message.role)).toEqual([
        "user",
        "toolResult",
        "assistant",
      ]);
      expect((branchMessages[1] as Extract<AgentMessage, { role: "toolResult" }>).content).toEqual([
        { type: "text", text: "[runtime rewrite]" },
      ]);
    } finally {
      cleanup();
    }
  });
});
