// Coverage for terminal attempt trajectory status classification.
import { describe, expect, it } from "vitest";
import {
  NON_DELIVERABLE_TERMINAL_TURN_REASON,
  resolveAttemptTrajectoryTerminal,
  resolveTerminalAssistantTexts,
  type ResolveAttemptTrajectoryTerminalParams,
} from "./attempt-trajectory-status.js";

function baseParams(
  overrides: Partial<ResolveAttemptTrajectoryTerminalParams> = {},
): ResolveAttemptTrajectoryTerminalParams {
  // Default to a completed but non-deliverable attempt; tests opt in to each
  // kind of terminal progress.
  return {
    aborted: false,
    externalAbort: false,
    timedOut: false,
    assistantTexts: [],
    toolMetas: [],
    didSendViaMessagingTool: false,
    didSendDeterministicApprovalPrompt: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    successfulCronAdds: 0,
    synthesizedPayloadCount: 0,
    ...overrides,
  };
}

describe("attempt trajectory status", () => {
  it("marks a terminal turn without visible text, tools, or delivery as an error", () => {
    expect(resolveAttemptTrajectoryTerminal(baseParams())).toEqual({
      status: "error",
      terminalError: NON_DELIVERABLE_TERMINAL_TURN_REASON,
    });
  });

  it("keeps visible assistant text as success", () => {
    expect(
      resolveAttemptTrajectoryTerminal(baseParams({ assistantTexts: ["Visible answer."] })),
    ).toEqual({ status: "success" });
  });

  it("keeps committed messaging tool delivery as success even without assistant text", () => {
    expect(
      resolveAttemptTrajectoryTerminal(
        baseParams({
          didSendViaMessagingTool: true,
          messagingToolSentTargets: [{ channel: "telegram" }],
        }),
      ),
    ).toEqual({ status: "success" });
  });

  it("keeps accepted session spawns as terminal progress", () => {
    expect(
      resolveAttemptTrajectoryTerminal(
        baseParams({
          acceptedSessionSpawns: [
            {
              runId: "run-child",
              childSessionKey: "agent:claude:subagent:child",
            },
          ],
          lastAssistantStopReason: "toolUse",
        }),
      ),
    ).toEqual({ status: "success" });
  });

  it("does not treat an uncommitted messaging tool attempt as delivery", () => {
    expect(
      resolveAttemptTrajectoryTerminal(
        baseParams({
          didSendViaMessagingTool: true,
          messagingToolSentTexts: ["   "],
          messagingToolSentMediaUrls: ["   "],
        }),
      ),
    ).toEqual({
      status: "error",
      terminalError: NON_DELIVERABLE_TERMINAL_TURN_REASON,
    });
  });

  it("does not treat tool metadata alone as terminal progress", () => {
    expect(
      resolveAttemptTrajectoryTerminal(
        baseParams({
          toolMetas: [{ toolName: "read" }],
        }),
      ),
    ).toEqual({
      status: "error",
      terminalError: NON_DELIVERABLE_TERMINAL_TURN_REASON,
    });
  });

  it("keeps synthesized terminal payloads as success", () => {
    expect(resolveAttemptTrajectoryTerminal(baseParams({ synthesizedPayloadCount: 1 }))).toEqual({
      status: "success",
    });
  });

  it("keeps heartbeat responses as success", () => {
    expect(
      resolveAttemptTrajectoryTerminal(
        baseParams({
          heartbeatToolResponse: { notify: false, summary: "ok" },
        }),
      ),
    ).toEqual({
      status: "success",
    });
  });

  it("does not treat expected silent turns as non-deliverable failures", () => {
    expect(resolveAttemptTrajectoryTerminal(baseParams({ silentExpected: true }))).toEqual({
      status: "success",
    });
  });

  it("does not treat eligible empty silent replies as non-deliverable failures", () => {
    expect(
      resolveAttemptTrajectoryTerminal(baseParams({ emptyAssistantReplyIsSilent: true })),
    ).toEqual({
      status: "success",
    });
  });

  it("does not let the raw silent policy hide ineligible empty failures", () => {
    expect(
      resolveAttemptTrajectoryTerminal(baseParams({ emptyAssistantReplyIsSilent: false })),
    ).toEqual({
      status: "error",
      terminalError: NON_DELIVERABLE_TERMINAL_TURN_REASON,
    });
  });

  it("uses safe last-assistant fallback text for terminal delivery status", () => {
    expect(
      resolveTerminalAssistantTexts({
        assistantTexts: [],
        lastAssistantStopReason: "stop",
        lastAssistantVisibleText: "Fallback answer.",
      }),
    ).toEqual(["Fallback answer."]);
    expect(
      resolveTerminalAssistantTexts({
        assistantTexts: [],
        lastAssistantStopReason: "error",
        lastAssistantVisibleText: "Raw provider error",
      }),
    ).toEqual([]);
  });

  it("marks terminal tool-use attempts as non-deliverable without explicit delivery", () => {
    // Visible planning text before tool_use is not final delivery; the attempt
    // only succeeds if a committed delivery or async handoff occurred.
    expect(
      resolveAttemptTrajectoryTerminal(
        baseParams({
          assistantTexts: ["I will update that file."],
          toolMetas: [{ toolName: "write" }],
          lastAssistantStopReason: "toolUse",
        }),
      ),
    ).toEqual({
      status: "error",
      terminalError: NON_DELIVERABLE_TERMINAL_TURN_REASON,
    });
    expect(
      resolveAttemptTrajectoryTerminal(
        baseParams({
          assistantTexts: ["I sent the reply."],
          didSendViaMessagingTool: true,
          messagingToolSentTexts: ["sent"],
          lastAssistantStopReason: "toolUse",
        }),
      ),
    ).toEqual({ status: "success" });
  });

  it("marks internally aborted tool-use attempts without delivery as non-deliverable", () => {
    expect(
      resolveAttemptTrajectoryTerminal(
        baseParams({
          aborted: true,
          toolMetas: [{ toolName: "web_search" }],
          lastAssistantStopReason: "toolUse",
        }),
      ),
    ).toEqual({
      status: "error",
      terminalError: NON_DELIVERABLE_TERMINAL_TURN_REASON,
    });
  });

  it("keeps async-started media tool-use attempts as terminal progress", () => {
    expect(
      resolveAttemptTrajectoryTerminal(
        baseParams({
          toolMetas: [{ toolName: "image_generate", asyncStarted: true }],
          lastAssistantStopReason: "toolUse",
        }),
      ),
    ).toEqual({ status: "success" });
  });

  it("preserves prompt errors and interrupts", () => {
    expect(
      resolveAttemptTrajectoryTerminal(baseParams({ promptError: new Error("boom") })),
    ).toEqual({ status: "error" });
    expect(resolveAttemptTrajectoryTerminal(baseParams({ timedOut: true }))).toEqual({
      status: "interrupted",
    });
    expect(
      resolveAttemptTrajectoryTerminal(baseParams({ aborted: true, externalAbort: true })),
    ).toEqual({
      status: "interrupted",
    });
  });
});
