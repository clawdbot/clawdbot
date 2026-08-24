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

  it("keeps stale session tool-use evidence incomplete without a current assistant", () => {
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: ["Let me update the file..."],
      toolMetas: [{ toolName: "write" }],
      lastAssistant: buildEmbeddedRunnerAssistant({ stopReason: "toolUse" }),
      currentAttemptAssistant: undefined,
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
