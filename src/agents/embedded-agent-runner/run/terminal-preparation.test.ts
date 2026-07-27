import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { createUsageAccumulator } from "../usage-accumulator.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

vi.mock("./payloads.js", () => ({
  buildEmbeddedRunPayloads: () => [],
}));
vi.mock("./run-attempt-result.js", () => ({
  buildTraceToolSummary: () => undefined,
}));
vi.mock("./tool-media-payloads.js", () => ({
  mergeAttemptToolMediaPayloads: ({ payloads }: { payloads?: unknown[] }) => payloads,
}));

function assistantMessage(stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    api: "responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    role: "assistant",
    content: [
      {
        type: "text",
        text: "provider error details",
        textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
      },
    ],
    timestamp: 0,
    stopReason,
    ...(stopReason === "error" ? { errorMessage: "provider failed" } : {}),
  };
}

function attemptResult(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  const assistant = assistantMessage("error");
  return {
    terminal: { kind: "ok" },
    sessionIdUsed: "session-1",
    messagesSnapshot: [assistant],
    assistantTexts: ["provider error details"],
    toolMetas: [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptCompletedAssistant: assistant,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    ...overrides,
  };
}

describe("prepareEmbeddedRunTerminal", () => {
  it.each(["error", "aborted"] as const)(
    "does not use %s assistant text as final terminal text",
    async (stopReason) => {
      const { prepareEmbeddedRunTerminal } = await import("./terminal-preparation.js");
      const assistant = assistantMessage(stopReason);
      const prepared = prepareEmbeddedRunTerminal({
        runParams: {
          sessionId: "session-1",
          runId: "run-1",
          workspaceDir: "/tmp/openclaw-test",
          prompt: "hi",
          trigger: "user",
          timeoutMs: 60_000,
        },
        attempt: attemptResult({
          lastAssistant: assistant,
          currentAttemptAssistant: assistant,
          currentAttemptCompletedAssistant: assistant,
        }),
        currentAttemptCompletedAssistant: assistant,
        provider: "openai",
        model: "gpt-5.4",
        activeErrorContext: { provider: "openai", model: "gpt-5.4" },
        authProfileStore: { version: 1, profiles: {} },
        sessionIdUsed: "session-1",
        outerContextTokenMeta: {},
        usageAccumulator: createUsageAccumulator(),
        contextRecoveryState: createEmbeddedRunContextRecoveryState(),
        resolvedToolResultFormat: "markdown",
        terminalState: {
          outcome:
            stopReason === "aborted"
              ? { reason: "aborted", status: "error", stopReason }
              : { reason: "failed", status: "error", stopReason, error: "provider failed" },
          signalOwnedInterruption: false,
        },
      });

      expect(prepared.finalAssistantVisibleText).toBeUndefined();
      expect(prepared.finalAssistantRawText).toBeUndefined();
    },
  );
});
