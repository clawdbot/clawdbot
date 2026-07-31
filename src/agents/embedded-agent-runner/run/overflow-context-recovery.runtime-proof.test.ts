import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import type { ToolResultMessage, UserMessage } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../../../config/io.js";
import { formatSqliteSessionFileMarker } from "../../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { SessionEntry as SessionStoreEntry } from "../../../config/sessions/types.js";
import { onInternalSessionTranscriptUpdate } from "../../../sessions/transcript-events.js";
import type { ToolResultPromptProjectionState } from "../session-prompt-state.js";
import { recoverEmbeddedRunOverflow } from "./overflow-context-recovery.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

const COMPACTION_DELAY_MS = 250;

let tmpDir: string | undefined;

afterEach(async () => {
  resetConfigRuntimeState();
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

function makeUserMessage(text: string): UserMessage {
  return {
    role: "user",
    content: text,
    timestamp: 1,
  };
}

function makeToolResult(text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "call_runtime_proof",
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 2,
  };
}

function getToolResultText(message: ToolResultMessage): string {
  const firstBlock = message.content[0];
  return firstBlock && "text" in firstBlock ? firstBlock.text : "";
}

describe("PR #81190 current-main runtime proof", () => {
  it("truncates append-only tool results before compaction", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pr81190-proof-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const sessionId = "runtime-proof-pr-81190";
    const sessionKey = "agent:main:runtime-proof-pr-81190";
    const sessionFile = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    setRuntimeConfigSnapshot({ session: { store: storePath } });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await replaceSessionEntry({ sessionKey, storePath }, {
      sessionFile,
      sessionId,
      updatedAt: 10,
    } as SessionStoreEntry);
    await appendTranscriptMessage(scope, { message: makeUserMessage("continue") });
    const original = makeToolResult("oversized tool output ".repeat(10_000));
    const persisted = await appendTranscriptMessage(scope, { message: original });

    const events: string[] = [];
    const stopListening = onInternalSessionTranscriptUpdate(() => {
      events.push("transcript:update");
    });
    const projectionState: ToolResultPromptProjectionState = {
      replacements: new Map(),
      frozen: new Set(),
      ambiguousBaseKeys: new Set(),
      sourceTextByKey: new Map(),
    };
    const promptError = new Error("Context window exceeded for this request");
    const attempt = {
      terminal: { kind: "failed", source: "prompt", error: promptError },
      messagesSnapshot: [original],
    } as EmbeddedRunAttemptResult;
    const startedAt = performance.now();

    const result = await recoverEmbeddedRunOverflow({
      runParams: {
        runId: "run-runtime-proof-pr-81190",
        sessionId,
        sessionKey,
        config: {},
        workspaceDir: tmpDir,
        prompt: "continue",
        timeoutMs: 5_000,
      },
      state: {
        autoCompactionCount: 0,
        lastCompactionTokensAfter: undefined,
        lastContextBudgetStatus: undefined,
        overflowCompactionAttempts: 0,
        timeoutCompactionAttempts: 0,
        toolResultTruncationAttempted: false,
      },
      contextEngine: {
        info: { id: "runtime-proof", name: "Runtime proof" },
        ingest: async () => ({ ingested: true }),
        assemble: async ({
          messages,
        }: {
          messages: EmbeddedRunAttemptResult["messagesSnapshot"];
        }) => ({
          messages,
          estimatedTokens: 0,
        }),
        compact: async () => {
          events.push("compact:start");
          await new Promise<void>((resolve) => {
            setTimeout(resolve, COMPACTION_DELAY_MS);
          });
          events.push("compact:end");
          return { ok: false, compacted: false, reason: "injected proof no-op" };
        },
      },
      contextTokenBudget: 8_000,
      genericCompactionRecoveryAllowed: true,
      aborted: false,
      signalOwnedInterruption: false,
      promptError,
      attempt,
      toolResultPromptProjectionState: projectionState,
      attemptCompactionCount: 0,
      runtimeAuthPlan: {},
      resolvedSessionKey: sessionKey,
      sessionAgentId: "main",
      agentDir: tmpDir,
      workspaceDir: tmpDir,
      provider: "openai",
      modelId: "gpt-runtime-proof",
      harnessRuntime: "embedded",
      thinkLevel: "off",
      authProfileIdSource: "auto",
      resolveContextEnginePluginId: () => undefined,
      buildRuntimeSettings: () => ({}),
      onCompactionHookMessages: async () => {},
      runOwnsCompactionBeforeHook: async () => {
        events.push("hook:before");
      },
      runOwnsCompactionAfterHook: async () => {
        events.push("hook:after");
      },
      adoptCompactionTranscript: async () => undefined,
      getActiveSession: () => ({
        id: sessionId,
        file: sessionFile,
        target: scope,
      }),
      prepareCurrentTranscriptRetry: () => {
        events.push("retry:current");
      },
      prepareCompactedTranscriptRetry: async () => {
        events.push("retry:compacted");
      },
      armPostCompactionGuard: () => {
        events.push("guard:armed");
      },
    } as unknown as Parameters<typeof recoverEmbeddedRunOverflow>[0]);
    const elapsedMs = performance.now() - startedAt;
    stopListening();

    console.info(
      JSON.stringify({
        elapsedMs: Math.round(elapsedMs),
        eventOrder: events,
        result,
      }),
    );
    expect(result).toEqual({ action: "retry" });
    expect(events).toEqual(["transcript:update", "retry:compacted"]);
    expect(events).not.toContain("compact:start");

    const storedEvents = await loadTranscriptEvents(scope);
    const originalEvent = storedEvents.find(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "id" in entry &&
        entry.id === persisted.messageId,
    ) as { message?: ToolResultMessage } | undefined;
    expect(originalEvent?.message).toEqual(original);

    const activeToolResult = SessionManager.open(scope)
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "toolResult");
    expect(activeToolResult?.type).toBe("message");
    if (activeToolResult?.type !== "message" || activeToolResult.message.role !== "toolResult") {
      throw new Error("active tool result missing after recovery");
    }
    const activeText = getToolResultText(activeToolResult.message);
    expect(activeText).toContain("truncated");
    expect(activeText.length).toBeLessThan(getToolResultText(original).length);

    console.info(
      JSON.stringify({
        mainBehavior: "truncation-before-compaction",
        elapsedMs: Math.round(elapsedMs),
        eventOrder: events,
        compactionCalls: events.filter((event) => event === "compact:start").length,
        originalChars: getToolResultText(original).length,
        activeChars: activeText.length,
        originalRowUnchanged: true,
        result,
      }),
    );
  });
});
