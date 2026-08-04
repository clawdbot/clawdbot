// Codex tests cover attempt results plugin behavior.
import { describe, expect, it } from "vitest";
import {
  buildCodexAppServerPromptTimeoutOutcome,
  collectTerminalAssistantText,
  isInvalidCodexImagePayloadError,
  resolveCodexAppServerReplayBlockedReason,
} from "./attempt-results.js";
import type { EmbeddedRunAttemptResult } from "./attempt-terminal.js";

function createResult(overrides: Partial<EmbeddedRunAttemptResult> = {}): EmbeddedRunAttemptResult {
  return {
    terminal: { kind: "ok" },
    sessionIdUsed: "session-1",
    messagesSnapshot: [],
    assistantTexts: [],
    toolMetas: [],
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    messagingToolSourceReplyPayloads: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: {
      hadPotentialSideEffects: false,
      replaySafe: true,
    },
    itemLifecycle: {
      startedCount: 0,
      completedCount: 0,
      activeCount: 0,
    },
    ...overrides,
  } as EmbeddedRunAttemptResult;
}

describe("Codex app-server attempt results", () => {
  it("formats terminal assistant text", () => {
    expect(
      collectTerminalAssistantText(
        createResult({
          assistantTexts: [" first ", "second"],
        }),
      ),
    ).toBe("first \n\nsecond");
  });

  it("builds timeout outcomes from completion and side-effect evidence", () => {
    expect(
      buildCodexAppServerPromptTimeoutOutcome({
        result: createResult(),
        turnCompletionIdleTimedOut: false,
      }),
    ).toBeUndefined();
    expect(
      buildCodexAppServerPromptTimeoutOutcome({
        result: createResult(),
        turnCompletionIdleTimedOut: true,
        turnWatchTimeoutKind: "progress",
      }),
    ).toBeUndefined();
    expect(
      buildCodexAppServerPromptTimeoutOutcome({
        result: createResult({
          assistantTexts: ["Salvaged answer."],
        }),
        turnCompletionIdleTimedOut: true,
        turnWatchTimeoutKind: "terminal",
      }),
    ).toBeUndefined();
    expect(
      buildCodexAppServerPromptTimeoutOutcome({
        result: createResult({
          itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
        }),
        turnCompletionIdleTimedOut: true,
        turnWatchTimeoutKind: "completion",
      }),
    ).toEqual({
      message:
        "Codex stopped before confirming the turn was complete. The response may be incomplete; retry if needed.",
    });
    expect(
      buildCodexAppServerPromptTimeoutOutcome({
        result: createResult({
          replayMetadata: {
            hadPotentialSideEffects: true,
            replaySafe: false,
          },
        }),
        turnCompletionIdleTimedOut: true,
        turnWatchTimeoutKind: "completion",
      }),
    ).toEqual({
      message:
        "Codex stopped before confirming the turn was complete. Some work may already have been performed; verify the current state before retrying.",
      replayInvalid: true,
      livenessState: "abandoned",
    });
    expect(
      buildCodexAppServerPromptTimeoutOutcome({
        result: createResult({
          assistantTexts: ["I am changing the data model now..."],
        }),
        turnCompletionIdleTimedOut: true,
        turnWatchTimeoutKind: "completion",
      }),
    ).toEqual({
      message:
        "Codex stopped before confirming the turn was complete. The response may be incomplete; retry if needed.",
      replayInvalid: true,
      livenessState: "abandoned",
    });
    expect(
      buildCodexAppServerPromptTimeoutOutcome({
        result: createResult({
          toolMetas: [{ toolName: "exec" }],
        }),
        turnCompletionIdleTimedOut: true,
        turnWatchTimeoutKind: "completion",
      }),
    ).toEqual({
      message:
        "Codex stopped before confirming the turn was complete. Some work may already have been performed; verify the current state before retrying.",
      replayInvalid: true,
      livenessState: "abandoned",
    });
  });

  it("builds an honest terminal-idle outcome instead of budget advice", () => {
    expect(
      buildCodexAppServerPromptTimeoutOutcome({
        result: createResult({}),
        turnCompletionIdleTimedOut: true,
        turnWatchTimeoutKind: "terminal",
      }),
    ).toEqual({
      message:
        "Codex stopped responding: no activity arrived for the turn's liveness window, so the turn was ended and the connection was replaced. Retry to continue on a fresh session.",
    });
    expect(
      buildCodexAppServerPromptTimeoutOutcome({
        result: createResult({ toolMetas: [{ toolName: "exec" }] }),
        turnCompletionIdleTimedOut: true,
        turnWatchTimeoutKind: "terminal",
      }),
    ).toMatchObject({
      replayInvalid: true,
      livenessState: "abandoned",
    });
  });

  it("classifies replay blocked reasons", () => {
    expect(resolveCodexAppServerReplayBlockedReason(createResult())).toBeUndefined();
    expect(
      resolveCodexAppServerReplayBlockedReason(
        createResult({
          replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        }),
      ),
    ).toBe("potential_side_effect");
    expect(
      resolveCodexAppServerReplayBlockedReason(
        createResult({
          assistantTexts: ["visible"],
        }),
      ),
    ).toBe("assistant_output");
    expect(
      resolveCodexAppServerReplayBlockedReason(
        createResult({
          toolMetas: [{ name: "exec" }] as never,
        }),
      ),
    ).toBe("tool_activity");
    expect(
      resolveCodexAppServerReplayBlockedReason(
        createResult({
          itemLifecycle: { startedCount: 1, completedCount: 0, activeCount: 1 },
        }),
      ),
    ).toBe("active_item");
  });

  it("recognizes invalid image payload errors without matching unsupported image input", () => {
    expect(isInvalidCodexImagePayloadError("invalid_image_url")).toBe(true);
    expect(isInvalidCodexImagePayloadError("malformed-base64 image payload")).toBe(true);
    expect(isInvalidCodexImagePayloadError("unsupported image input")).toBe(false);
  });
});
