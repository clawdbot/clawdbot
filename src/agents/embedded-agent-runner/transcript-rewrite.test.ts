// Transcript rewrite tests cover in-memory and persisted branch rewrites for
// tool-result externalization, labels, and compaction markers.
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";

let rewriteTranscriptEntriesInSessionManager: typeof import("./transcript-rewrite.js").rewriteTranscriptEntriesInSessionManager;
let installSessionToolResultGuard: typeof import("../session-tool-result-guard.js").installSessionToolResultGuard;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
  ({ installSessionToolResultGuard } = await import("../session-tool-result-guard.js"));
  ({ rewriteTranscriptEntriesInSessionManager } = await import("./transcript-rewrite.js"));
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

  it.each(["unkeyed", "keyed suffix", "keyed replacement"])(
    "preserves original SQLite rows and the rewritten %s branch",
    async (variant) => {
      const dir = tempDirs.make("openclaw-transcript-rewrite-runtime-");
      const storePath = path.join(dir, "sessions.json");
      const sessionId = "runtime-sqlite-branch-rewrite";
      const sessionKey = "agent:main:test";
      const sessionFile = formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId,
        storePath,
      });
      const target = {
        agentId: "main",
        sessionId,
        sessionKey,
        storePath,
      };
      await replaceSessionEntry({ sessionKey, storePath }, {
        sessionFile,
        sessionId,
        updatedAt: 10,
      } as SessionEntry);
      const sessionManager = SessionManager.open(target, dir);
      const keyed = variant !== "unkeyed";
      appendSessionMessages(sessionManager, [
        asAppendMessage({ role: "user", content: "run tool", timestamp: 1 }),
        asAppendMessage(createToolResultReplacement("exec", "before rewrite", 2)),
        ...(keyed
          ? [
              asAppendMessage({
                role: "user",
                content: "keep this later turn",
                idempotencyKey: "rewrite-later-user",
                timestamp: 3,
              }),
            ]
          : []),
        asAppendMessage({
          role: "assistant",
          content: createTextContent("summarized"),
          timestamp: 4,
        }),
      ]);
      const originalBranch = sessionManager.getBranch();
      const originalRows = await loadTranscriptEvents(target);
      const replacementIndex = variant === "keyed replacement" ? 2 : 1;
      const originalEntry = originalBranch[replacementIndex];
      if (originalEntry?.type !== "message") {
        throw new Error("expected a persisted rewrite target");
      }
      let replacement = createToolResultReplacement("exec", "[runtime rewrite]", 2);
      if (variant === "keyed replacement") {
        if (originalEntry.message.role !== "user") {
          throw new Error("expected a keyed user replacement");
        }
        replacement = { ...originalEntry.message, content: "rewritten later turn" };
      }

      const result = rewriteTranscriptEntriesInSessionManager({
        sessionManager,
        replacements: [
          {
            entryId: originalEntry.id,
            message: replacement,
          },
        ],
      });

      expect(result.changed).toBe(true);
      const storedEvents = await loadTranscriptEvents(target);
      expect(storedEvents.slice(0, originalRows.length)).toEqual(originalRows);
      expect(storedEvents).toHaveLength(
        originalRows.length + originalBranch.length - replacementIndex,
      );
      const reopened = SessionManager.open(target, dir);
      const activeBranch = reopened.getBranch();
      expect(getBranchMessages(reopened)).toEqual(
        originalBranch.flatMap((entry, index) =>
          entry.type === "message"
            ? [index === replacementIndex ? replacement : entry.message]
            : [],
        ),
      );
      expect(activeBranch.slice(0, replacementIndex)).toEqual(
        originalBranch.slice(0, replacementIndex),
      );
      const originalIds = new Set(originalBranch.map((entry) => entry.id));
      for (const [index, entry] of activeBranch.entries()) {
        expect(entry.parentId).toBe(activeBranch[index - 1]?.id ?? null);
        if (index >= replacementIndex) {
          expect(originalIds.has(entry.id)).toBe(false);
        }
      }
      expect(reopened.getLeafId()).toBe(activeBranch.at(-1)?.id);
      if (keyed) {
        const activeKeyedEntry = activeBranch.find(
          (entry) =>
            entry.type === "message" &&
            "idempotencyKey" in entry.message &&
            entry.message.idempotencyKey === "rewrite-later-user",
        );
        if (!activeKeyedEntry || activeKeyedEntry.type !== "message") {
          throw new Error("expected active keyed replay entry");
        }
        const retry = await appendTranscriptMessage(target, { message: activeKeyedEntry.message });
        expect(retry).toMatchObject({
          appended: false,
          messageId: activeKeyedEntry.id,
        });
      }
    },
  );
});
