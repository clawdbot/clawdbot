import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../../../llm/types.js";
import {
  shouldContinueTransientAssistantError,
  TRANSIENT_TRANSPORT_CONTINUATION_INSTRUCTION,
} from "./assistant-failure.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

function assistant(): AssistantMessage {
  return {
    role: "assistant",
    stopReason: "error",
    provider: "openai",
    model: "qwen3.6-27b-fp8",
    errorMessage: "terminated",
    content: [{ type: "text", text: "Let me run a proper permissions check:" }],
  } as unknown as AssistantMessage;
}

function attempt(overrides: Partial<EmbeddedRunAttemptResult> = {}): EmbeddedRunAttemptResult {
  return {
    assistantTexts: ["Let me run a proper permissions check:"],
    clientToolCalls: undefined,
    yieldDetected: false,
    didSendDeterministicApprovalPrompt: false,
    heartbeatToolResponse: undefined,
    toolMediaUrls: [],
    toolAudioAsVoice: false,
    toolTrustedLocalMedia: false,
    hasToolMediaBlockReply: false,
    didDeliverSourceReplyViaMessageTool: false,
    messagingToolSourceReplyPayloads: [],
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    acceptedSessionSpawns: [],
    successfulCronAdds: 0,
    toolMetas: [],
    ...overrides,
  } as unknown as EmbeddedRunAttemptResult;
}

function eligibleParams(
  overrides: {
    attempt?: EmbeddedRunAttemptResult;
    assistant?: AssistantMessage;
    timedOut?: boolean;
  } = {},
) {
  return {
    attempt: overrides.attempt ?? attempt(),
    assistant: overrides.assistant ?? assistant(),
    failoverReason: "timeout" as const,
    authFailure: false,
    rateLimitFailure: false,
    billingFailure: false,
    cloudCodeAssistFormatError: false,
    imageDimensionError: false,
    terminalInterrupted: false,
    promptError: undefined,
    timedOut: overrides.timedOut ?? false,
    externalAbort: false,
    signalOwnedInterruption: false,
  };
}

describe("transient assistant stream recovery", () => {
  it("continues from partial progress after a transport termination", () => {
    expect(shouldContinueTransientAssistantError(eligibleParams())).toBe(true);
    expect(TRANSIENT_TRANSPORT_CONTINUATION_INSTRUCTION).toContain(
      "Continue from the persisted transcript",
    );
  });

  it("does not continue after committed delivery or a real run timeout", () => {
    expect(
      shouldContinueTransientAssistantError(
        eligibleParams({
          attempt: attempt({ messagingToolSentTexts: ["Already delivered."] }),
        }),
      ),
    ).toBe(false);
    expect(shouldContinueTransientAssistantError(eligibleParams({ timedOut: true }))).toBe(false);
  });
});
