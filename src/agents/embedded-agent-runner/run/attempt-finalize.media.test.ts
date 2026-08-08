import { describe, expect, it, vi } from "vitest";
import {
  castAgentMessage,
  makeAgentAssistantMessage,
} from "../../test-helpers/agent-message-fixtures.js";
import { finalizeEmbeddedAttempt } from "./attempt-finalize.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

describe("finalizeEmbeddedAttempt trajectory capture", () => {
  type AssistantStopReason = NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>["stopReason"];

  const assistant = (stopReason: AssistantStopReason) =>
    makeAgentAssistantMessage({
      stopReason,
      content: [{ type: "text", text: "attempt fallback" }],
      ...(stopReason === "error" ? { errorMessage: "provider failed" } : {}),
    });

  const captureTrajectory = (overrides: Partial<EmbeddedRunAttemptResult>) => {
    const recordEvent = vi.fn();
    const result = {
      terminal: { kind: "ok" },
      assistantTexts: [],
      toolMetas: [],
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      currentAttemptAssistant: assistant("stop"),
      ...overrides,
    } as EmbeddedRunAttemptResult;
    finalizeEmbeddedAttempt({
      result,
      trajectoryRecorder: { recordEvent, flush: async () => undefined },
      synthesizedPayloadCount: 0,
      emptyAssistantReplyIsSilent: false,
      hasTerminalOutput: false,
    });
    return Object.fromEntries(recordEvent.mock.calls) as Record<string, Record<string, unknown>>;
  };

  type TerminalCaseOptions = {
    texts?: string[];
    last?: AssistantStopReason;
    completed?: AssistantStopReason;
    yielded?: boolean;
  };
  type TerminalCase = readonly [
    name: string,
    terminal: EmbeddedRunAttemptResult["terminal"],
    currentStopReason: AssistantStopReason,
    expectedStopReason: string | undefined,
    expectedFinalStatus: "success" | "error" | "interrupted",
    options?: TerminalCaseOptions,
  ];

  const cases: TerminalCase[] = [
    ["current over stale", { kind: "ok" }, "stop", "stop", "success", { last: "aborted" }],
    ["normal completion", { kind: "ok" }, "length", "stop", "success", { completed: "stop" }],
    ["length truncation", { kind: "ok" }, "length", "length", "error"],
    [
      "prompt timeout",
      { kind: "timeout", phase: "prompt", source: "runtime" },
      "stop",
      undefined,
      "interrupted",
    ],
    ["external abort", { kind: "aborted", source: "external" }, "stop", "aborted", "interrupted"],
    ["partial provider error", { kind: "ok" }, "error", "error", "error", { texts: ["x"] }],
    [
      "prompt error",
      { kind: "failed", source: "prompt", error: new Error("prompt failed") },
      "error",
      undefined,
      "error",
    ],
    [
      "yield over completed assistant",
      { kind: "ok" },
      "length",
      "aborted",
      "interrupted",
      { last: "aborted", completed: "stop", yielded: true },
    ],
  ];

  it.each(cases)(
    "%s",
    (_name, terminal, currentStopReason, expectedStopReason, expectedFinalStatus, options = {}) => {
      const events = captureTrajectory({
        terminal,
        assistantTexts: options.texts ?? [],
        lastAssistant: assistant(options.last ?? "toolUse"),
        currentAttemptAssistant: assistant(currentStopReason),
        currentAttemptCompletedAssistant: options.completed
          ? assistant(options.completed)
          : undefined,
        yieldDetected: options.yielded,
      });

      expect(events["model.completed"]).toHaveProperty("stopReason", expectedStopReason);
      expect(events["trace.artifacts"]).toHaveProperty("stopReason", expectedStopReason);
      expect(events["trace.artifacts"]).toHaveProperty("finalStatus", expectedFinalStatus);
    },
  );

  it("records canonical message snapshots without reprojecting them", () => {
    const events = captureTrajectory({
      messagesSnapshot: [
        castAgentMessage({
          role: "user",
          content: "inspect",
          __openclaw: {
            media: [{ path: "/media/canonical.png", contentType: "image/png" }],
          },
        }),
      ],
    });
    const captured = (
      events["model.completed"]?.messagesSnapshot as Array<Record<string, unknown>> | undefined
    )?.[0];

    expect(captured).not.toHaveProperty("MediaPath");
    expect(captured).not.toHaveProperty("MediaType");
    expect(captured?.["__openclaw"]).toMatchObject({
      media: [{ path: "/media/canonical.png", contentType: "image/png" }],
    });
  });
});
