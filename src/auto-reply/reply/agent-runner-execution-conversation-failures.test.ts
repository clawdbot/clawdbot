import { describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import {
  setupAgentRunnerExecutionTestState,
  getRunAgentTurnWithFallback,
  createMockTypingSignaler,
  createFollowupRun,
} from "./agent-runner-execution.test-support.js";
import { PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE } from "./provider-request-error-classifier.js";

const state = setupAgentRunnerExecutionTestState();

describe("runAgentTurnWithFallback: conversation failures", () => {
  it("returns a session reset hint for Bedrock tool mismatch errors on external chat channels", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error(
        "The number of toolResult blocks at messages.186.content exceeds the number of toolUse blocks of previous turn.",
      ),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE);
    }
  });

  it("returns a provider conversation-state error for OpenAI missing custom tool output errors on external chat channels", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error("Custom tool call output is missing for call id: call_live_123."),
    );

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "slack",
        ChannelId: "channel-1",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE);
    }
  });

  it("does not auto-reset role-ordering provider conversation-state errors", async () => {
    const resetSessionAfterRoleOrderingConflict = vi.fn(async () => true);
    state.runEmbeddedAgentMock.mockRejectedValueOnce(new Error("400 Incorrect role information"));

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "telegram",
        ChatId: "chat-1",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(resetSessionAfterRoleOrderingConflict).not.toHaveBeenCalled();
    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE);
    }
  });

  it("keeps actionable provider errors on internal control surfaces", async () => {
    state.isInternalMessageChannelMock.mockReturnValue(true);
    const providerError = "provider failed with actionable details";
    state.runEmbeddedAgentMock.mockRejectedValueOnce(new Error(providerError));

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "chat",
        Surface: "chat",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain(providerError);
      expect(result.payload.text).toContain("openclaw logs --follow");
      expect(result.payload.text).toMatch(/terminal/i);
    }
  });
});
