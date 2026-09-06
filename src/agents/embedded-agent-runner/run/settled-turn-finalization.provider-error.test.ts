import { describe, expect, it } from "vitest";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import {
  createSettledFinalizationTestInput,
  createSettledProviderFailureAttempt,
} from "./settled-turn-finalization.test-support.js";
import { prepareEmbeddedRunTerminal } from "./terminal-preparation.js";
import { resolveSettledTurnFinalizationRequest } from "./terminal-resolution.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

function prepareRequest(
  attempt = createSettledProviderFailureAttempt(),
  trigger: "user" | "cron" = "user",
): Parameters<typeof resolveSettledTurnFinalizationRequest>[0] {
  const { initial, terminalBase, finalization } = createSettledFinalizationTestInput(
    attempt,
    createTestAdmittedRunContext("run-settled"),
  );
  terminalBase.runParams.trigger = trigger;
  const prepared = prepareEmbeddedRunTerminal({ ...terminalBase, ...initial });
  return {
    runParams: terminalBase.runParams,
    attempt,
    activeErrorContext: terminalBase.activeErrorContext,
    modelApi: finalization.modelApi,
    executionContract: finalization.executionContract,
    payloadsWithToolMedia: prepared.payloadsWithToolMedia,
    recoveredFinalAssistantPayloadsAfterPromptTimeout:
      prepared.recoveredFinalAssistantPayloadsAfterPromptTimeout,
    terminalState: initial.terminalState,
    hasTerminalToolPresentation: false,
    settledTurnFinalizationAvailable: true,
  };
}

describe("prepared provider errors after settled tools", () => {
  it("does not mistake the generated provider error for an authored answer", () => {
    const request = prepareRequest();
    expect(request.payloadsWithToolMedia).toEqual([
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("connection refused"),
      }),
    ]);
    expect(resolveSettledTurnFinalizationRequest(request)).toContain(
      "Do not repeat completed tool calls",
    );
  });

  it.each([
    { name: "missing recovery context", change: { settledTurnFinalizationContext: undefined } },
    {
      name: "authored assistant output",
      change: { assistantTexts: ["The note is already saved."] },
    },
    { name: "intentional silence", change: { assistantTexts: ["NO_REPLY"] } },
    {
      name: "unfinished tool",
      change: { itemLifecycle: { startedCount: 1, completedCount: 0, activeCount: 1 } },
    },
    {
      name: "asynchronous tool",
      change: { toolMetas: [{ toolName: "write", asyncStarted: true }] },
    },
    {
      name: "delivered reply",
      change: { didSendViaMessagingTool: true, messagingToolSentTexts: ["Note saved."] },
    },
    { name: "delivered media", change: { hasToolMediaBlockReply: true } },
    { name: "pending media", change: { toolMediaUrls: ["/tmp/note.png"] } },
    { name: "cancellation", change: { terminal: { kind: "aborted", source: "external" } } },
  ] satisfies Array<{ name: string; change: Partial<EmbeddedRunAttemptResult> }>)(
    "preserves $name instead of finalizing",
    ({ change }) => {
      const request = prepareRequest(createSettledProviderFailureAttempt(change));
      expect(resolveSettledTurnFinalizationRequest(request)).toBeNull();
    },
  );

  it("preserves a structured provider refusal even with stale transient context", () => {
    const attempt = createSettledProviderFailureAttempt();
    const assistant = attempt.currentAttemptCompletedAssistant;
    if (!assistant) {
      throw new Error("Missing failed assistant");
    }
    assistant.diagnostics = [
      { type: "provider_refusal", timestamp: 0, details: { provider: "openai" } },
    ];
    const request = prepareRequest(attempt);
    expect(resolveSettledTurnFinalizationRequest(request)).toBeNull();
    expect(request.payloadsWithToolMedia).toEqual([
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("refused this request"),
      }),
    ]);
  });

  it("preserves a cron tool-authored silent outcome after discounting the error", () => {
    const attempt = createSettledProviderFailureAttempt();
    const result = attempt.messagesSnapshot.find((message) => message.role === "toolResult");
    if (!result || result.role !== "toolResult") {
      throw new Error("Missing settled tool result");
    }
    result.content = [{ type: "text", text: "NO_REPLY" }];
    expect(resolveSettledTurnFinalizationRequest(prepareRequest(attempt, "cron"))).toBeNull();
  });

  it.each(["unmarked error", "structured tool error", "tool presentation"])(
    "preserves %s alongside the generated provider error",
    (kind) => {
      const request = prepareRequest();
      if (kind === "tool presentation") {
        request.hasTerminalToolPresentation = true;
      } else {
        request.payloadsWithToolMedia?.push({
          text: "Explicit error",
          isError: true,
          ...(kind === "structured tool error" ? { channelData: { explicit: true } } : {}),
        });
      }
      expect(resolveSettledTurnFinalizationRequest(request)).toBeNull();
    },
  );
});
