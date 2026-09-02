import { describe, expect, it } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  resolveIncompleteTurnPayloadText,
  resolveReplayInvalidFlag,
  resolveRunLivenessState,
  resolveSilentToolResultReplyPayload,
} from "./incomplete-turn-resolution.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

describe("incomplete-turn terminal metadata", () => {
  it("keeps the side-effect warning when the terminal error is a provider refusal", () => {
    const assistant = buildEmbeddedRunnerAssistant({
      provider: "anthropic",
      stopReason: "error",
      diagnostics: [
        {
          type: "provider_refusal",
          timestamp: 0,
          details: { provider: "anthropic", category: "cyber" },
        },
      ],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    });

    expect(
      resolveIncompleteTurnPayloadText({
        payloadCount: 0,
        aborted: false,
        externalAbort: false,
        timedOut: false,
        attempt,
      }),
    ).toBe(
      "⚠️ Agent couldn't generate a response. Note: some tool actions may have already been executed — please verify before retrying.",
    );
  });

  it("uses the current completed assistant instead of stale session tool-use evidence", () => {
    const staleAssistant = buildEmbeddedRunnerAssistant({ stopReason: "toolUse" });
    const currentAssistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: "Here is the final answer." }],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: ["Analysis...", "Here is the final answer."],
      toolMetas: [{ toolName: "update_plan" }],
      lastAssistant: staleAssistant,
      currentAttemptAssistant: currentAssistant,
    });

    expect(
      resolveIncompleteTurnPayloadText({
        payloadCount: 1,
        aborted: false,
        externalAbort: false,
        timedOut: false,
        attempt,
      }),
    ).toBeNull();
  });

  it("keeps completed tool-use evidence incomplete when the current transcript slice is absent", () => {
    const assistant = buildEmbeddedRunnerAssistant({ stopReason: "toolUse" });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: ["Let me update the file..."],
      toolMetas: [{ toolName: "write" }],
      lastAssistant: assistant,
      currentAttemptAssistant: undefined,
      currentAttemptCompletedAssistant: assistant,
    });

    expect(
      resolveIncompleteTurnPayloadText({
        payloadCount: 1,
        aborted: false,
        externalAbort: false,
        timedOut: false,
        attempt,
      }),
    ).toContain("couldn't generate a response");
  });

  it("emits a silent cron reply from the trailing current-attempt tool result", () => {
    const attempt = makeEmbeddedRunnerAttempt({
      toolMetas: [{ toolName: "exec" }],
      messagesSnapshot: [
        {
          role: "toolResult",
          content: [{ type: "text", text: "NO_REPLY" }],
          details: { aggregated: "NO_REPLY" },
        } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
        buildEmbeddedRunnerAssistant({}),
      ],
    });

    expect(
      resolveSilentToolResultReplyPayload({
        isCronTrigger: true,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toEqual({ text: "NO_REPLY" });
  });

  it("does not reuse an older silent tool result without current tool activity", () => {
    const attempt = makeEmbeddedRunnerAttempt({
      toolMetas: [],
      messagesSnapshot: [
        {
          role: "toolResult",
          content: [{ type: "text", text: "NO_REPLY" }],
        } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
        {
          role: "user",
          content: [{ type: "text", text: "Current cron prompt" }],
        } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
        buildEmbeddedRunnerAssistant({}),
      ],
    });

    expect(
      resolveSilentToolResultReplyPayload({
        isCronTrigger: true,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBeNull();
  });

  it("marks compaction-timeout retries as paused and replay-invalid", () => {
    const attempt = makeEmbeddedRunnerAttempt({
      terminal: { kind: "timeout", phase: "compaction", source: "runtime" },
    });

    expect(resolveReplayInvalidFlag({ attempt })).toBe(true);
    expect(
      resolveRunLivenessState({
        payloadCount: 0,
        aborted: true,
        timedOut: true,
        attempt,
      }),
    ).toBe("paused");
  });
});
