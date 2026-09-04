import { describe, expect, it } from "vitest";
import {
  PROVIDER_FAILURE_WITH_OUTPUT_ERROR_CODE,
  PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE,
} from "../../../llm/types.js";
import { makeEmbeddedRunnerAttempt } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { emptyAssistant, makeTerminalInput } from "./terminal-resolution.test-support.js";

describe("terminal refusal resolution", () => {
  it.each(["none", "prior turn", "current attempt"])(
    "resolves server compaction with a refusal in %s",
    async (refusalOwner) => {
      const refusal = emptyAssistant({
        provider: "anthropic",
        api: "anthropic-messages",
        model: "claude-sonnet-4-6",
        stopReason: "error",
        diagnostics: [
          {
            type: "provider_refusal",
            timestamp: 0,
            details: { provider: "anthropic", category: "cyber" },
          },
        ],
      });
      const assistant = emptyAssistant({
        ...refusal,
        stopReason: refusalOwner === "current attempt" ? "error" : "stop",
        diagnostics: refusalOwner === "current attempt" ? refusal.diagnostics : undefined,
        providerReplay: {
          v: 1,
          type: "anthropic-compaction",
          data: "summary",
          provider: "anthropic",
          api: "anthropic-messages",
          model: "claude-sonnet-4-6",
          baseUrlHash: "route-a",
        },
      });
      const attempt = makeEmbeddedRunnerAttempt({
        assistantTexts: [],
        lastAssistant: refusalOwner === "prior turn" ? refusal : assistant,
        currentAttemptAssistant: assistant,
        currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      });
      const input = makeTerminalInput({
        attempt,
        attemptAssistant: assistant,
        maxEmptyResponseRetryAttempts: 0,
      });

      const resolved = await resolveEmbeddedRunTerminal(input);

      if (refusalOwner === "current attempt") {
        expect(resolved).toMatchObject({
          action: "complete",
          result: {
            meta: { error: { kind: "incomplete_turn", fallbackSafe: false } },
            payloads: [
              {
                isError: true,
                text: "The provider refused this request (category: cyber). Revise the request and try again.",
              },
            ],
          },
        });
        expect(input.retryState.compactionContinuationAttempts).toBe(0);
        expect(input.armPostCompactionGuard).not.toHaveBeenCalled();
      } else {
        expect(resolved).toEqual({ action: "retry" });
        expect(input.retryState.compactionContinuationAttempts).toBe(1);
        expect(input.armPostCompactionGuard).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([PROVIDER_FAILURE_WITH_OUTPUT_ERROR_CODE, PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE])(
    "does not retry terminal provider outcome %s after compaction",
    async (errorCode) => {
      const assistant = emptyAssistant({
        stopReason: "error",
        errorCode,
        providerReplay: {
          v: 1,
          type: "anthropic-compaction",
          data: "summary",
          provider: "anthropic",
          api: "anthropic-messages",
          model: "claude-sonnet-4-6",
          baseUrlHash: "route-a",
        },
      });
      const attempt = makeEmbeddedRunnerAttempt({
        assistantTexts: [],
        currentAttemptAssistant: assistant,
        currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      });
      const input = makeTerminalInput({
        attempt,
        attemptAssistant: assistant,
        maxEmptyResponseRetryAttempts: 0,
      });

      const resolved = await resolveEmbeddedRunTerminal(input);

      expect(resolved).toMatchObject({
        action: "complete",
        result: { meta: { error: { kind: "incomplete_turn", fallbackSafe: false } } },
      });
      expect(input.armPostCompactionGuard).not.toHaveBeenCalled();
    },
  );

  it("keeps the current incomplete turn fallback-safe after a prior-turn refusal", async () => {
    const assistant = emptyAssistant({ stopReason: "length" });
    const priorRefusal = emptyAssistant({
      stopReason: "error",
      diagnostics: [{ type: "provider_refusal", timestamp: 0, details: { provider: "openai" } }],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: priorRefusal,
      currentAttemptAssistant: assistant,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    const input = makeTerminalInput({
      attempt,
      attemptAssistant: assistant,
      maxEmptyResponseRetryAttempts: 0,
    });

    const resolved = await resolveEmbeddedRunTerminal(input);

    expect(resolved).toMatchObject({
      action: "complete",
      result: { meta: { error: { kind: "incomplete_turn", fallbackSafe: true } } },
    });
    expect(input.armPostCompactionGuard).not.toHaveBeenCalled();
  });
});
