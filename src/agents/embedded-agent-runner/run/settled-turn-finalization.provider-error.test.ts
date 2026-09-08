import { describe, expect, it } from "vitest";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import {
  createSettledFinalizationTestInput,
  createSettledProviderFailureAttempt,
  projectSettledProviderFailureAttempt,
} from "./settled-turn-finalization.test-support.js";
import { prepareEmbeddedRunTerminal } from "./terminal-preparation.js";
import { resolveSettledTurnFinalizationRequest } from "./terminal-resolution.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

function createAssistantReportedProviderFailureAttempt(): EmbeddedRunAttemptResult {
  const base = createSettledProviderFailureAttempt({ terminal: { kind: "ok" } });
  const assistant = base.currentAttemptCompletedAssistant;
  if (!assistant) {
    throw new Error("Missing failed assistant");
  }
  assistant.errorMessage = "WebSocket error";
  assistant.errorCode = "ERR_WEBSOCKET_TRANSPORT";
  return projectSettledProviderFailureAttempt(base);
}

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

  it("finalizes a provider error reported through the completed assistant", () => {
    const attempt = createAssistantReportedProviderFailureAttempt();
    expect(attempt).toMatchObject({
      terminal: { kind: "ok" },
      settledTurnFinalizationContext: { source: "openclaw-transcript" },
    });
    const request = prepareRequest(attempt);
    expect(request.payloadsWithToolMedia).toEqual([expect.objectContaining({ isError: true })]);
    expect(resolveSettledTurnFinalizationRequest(request)).toContain(
      "Do not repeat completed tool calls",
    );
  });

  it.each(["earlier user turn", "current commentary substring"])(
    "does not attribute current output to %s",
    (source) => {
      const base = createSettledProviderFailureAttempt({
        assistantTexts: ["The note is already saved."],
      });
      const earlierAssistant = {
        ...base.lastAssistant!,
        stopReason: "stop" as const,
        content: [
          {
            type: "text" as const,
            text:
              source === "earlier user turn"
                ? "The note is already saved."
                : "The note is already saved. I will verify it.",
          },
        ],
      };
      base.messagesSnapshot.splice(source === "earlier user turn" ? 0 : 1, 0, earlierAssistant);
      base.terminal = {
        kind: "failed",
        source: "prompt",
        error: new Error("Stream ended without finish_reason"),
      };
      const attempt = projectSettledProviderFailureAttempt(base);
      expect(attempt.settledTurnFinalizationContext).toBeUndefined();
      expect(resolveSettledTurnFinalizationRequest(prepareRequest(attempt))).toBeNull();
    },
  );

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

  it.each(["provider refusal", "permanent WebSocket close"])(
    "preserves %s even with stale transient context",
    (failure) => {
      const attempt = createSettledProviderFailureAttempt();
      const assistant = attempt.currentAttemptCompletedAssistant;
      if (!assistant) {
        throw new Error("Missing failed assistant");
      }
      if (failure === "provider refusal") {
        assistant.diagnostics = [
          { type: "provider_refusal", timestamp: 0, details: { provider: "openai" } },
        ];
      } else {
        assistant.errorCode = "ERR_WEBSOCKET_NON_RETRYABLE_CLOSE";
      }
      const request = prepareRequest(attempt);
      expect(resolveSettledTurnFinalizationRequest(request)).toBeNull();
      expect(request.payloadsWithToolMedia).toEqual([
        expect.objectContaining({
          isError: true,
          text: expect.stringContaining(
            failure === "provider refusal" ? "refused this request" : "connection refused",
          ),
        }),
      ]);
    },
  );

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
