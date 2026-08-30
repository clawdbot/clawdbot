import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { makeTerminalInput } from "./terminal-resolution.test-support.js";

vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

describe("source finalization terminal resolution", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deterministically discards a rejected final without payloads, text, or pending client tools", async () => {
    const assistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: "obsolete draft" }],
      stopReason: "toolUse",
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: ["obsolete draft"],
      beforeAgentFinalizeDiscarded: true,
      clientToolCalls: [{ name: "computer_use", params: { task: "stale" } }],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      currentAttemptCompletedAssistant: assistant,
    });

    const resolved = await resolveEmbeddedRunTerminal(
      makeTerminalInput({
        attempt,
        attemptAssistant: assistant,
        finalAssistantVisibleText: "obsolete draft",
        finalAssistantRawText: "obsolete draft",
      }),
    );

    expect(resolved.action).toBe("complete");
    if (resolved.action !== "complete") {
      return;
    }
    expect(resolved.result.payloads).toBeUndefined();
    expect(resolved.result.meta.finalAssistantVisibleText).toBeUndefined();
    expect(resolved.result.meta.finalAssistantRawText).toBeUndefined();
    expect(resolved.result.meta.pendingToolCalls).toBeUndefined();
    expect(resolved.result.meta.stopReason).toBeUndefined();
    expect(resolved.result.meta.intentionalTerminalCompletion).toBe("source-finalization-discard");
  });

  it.each([
    {
      name: "retries a completed client-tool candidate only for a tools-disabled source-local revision",
      text: "obsolete client action",
      stopReason: "toolUse" as const,
      clientToolCalls: [{ name: "computer_use", params: { task: "stale" } }],
      checksRecoveryOrder: false,
    },
    {
      name: "routes a visible source-local revision before generic empty-response recovery",
      text: "obsolete draft",
      stopReason: "stop" as const,
      clientToolCalls: undefined,
      checksRecoveryOrder: true,
    },
  ])("$name", async ({ text, stopReason, clientToolCalls, checksRecoveryOrder }) => {
    const assistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text }],
      stopReason,
    });
    const activateInternalPrompt = vi.fn();
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [text],
      beforeAgentFinalizeRevisionReason: "answer using the fresh room state",
      beforeAgentFinalizeRevisionDisableTools: true,
      ...(clientToolCalls ? { clientToolCalls } : {}),
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      currentAttemptCompletedAssistant: assistant,
    });
    const input = makeTerminalInput({
      attempt,
      attemptAssistant: assistant,
      activateInternalPrompt,
    });

    await expect(resolveEmbeddedRunTerminal(input)).resolves.toEqual({ action: "retry" });
    if (checksRecoveryOrder) {
      expect(input.retryState.beforeFinalizeRevisionAttempts).toBe(1);
      expect(input.retryState.emptyResponseAttempts).toBe(0);
    }
    expect(input.retryState.disableToolsForBeforeFinalizeRevision).toBe(true);
    expect(activateInternalPrompt).toHaveBeenCalledWith(
      expect.stringContaining("answer using the fresh room state"),
    );
  });
});
