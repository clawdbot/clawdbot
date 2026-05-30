import type { EmbeddedRunAttemptResult } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import {
  buildCodexAppServerPromptTimeoutOutcome,
  collectTerminalAssistantText,
  isInvalidCodexImagePayloadError,
  resolveCodexAppServerReplayBlockedReason,
} from "./attempt-results.js";

function createResult(overrides: Partial<EmbeddedRunAttemptResult> = {}): EmbeddedRunAttemptResult {
  return {
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    timedOutDuringToolExecution: false,
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
      }),
    ).toBeUndefined();
    expect(
      buildCodexAppServerPromptTimeoutOutcome({
        result: createResult({
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        }),
        turnCompletionIdleTimedOut: true,
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
      }),
    ).toEqual({
      message:
        "Codex stopped before confirming the turn was complete. The response may be incomplete; retry if needed.",
    });
    expect(
      buildCodexAppServerPromptTimeoutOutcome({
        result: createResult({
          toolMetas: [{ toolName: "exec" }],
        }),
        turnCompletionIdleTimedOut: true,
      }),
    ).toEqual({
      message:
        "Codex stopped before confirming the turn was complete. The response may be incomplete; retry if needed.",
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
