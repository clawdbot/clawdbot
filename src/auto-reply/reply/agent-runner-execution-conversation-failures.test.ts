import { describe, expect, it, vi } from "vitest";
import { PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE } from "../../agents/failover/user-copy.js";
import type { TemplateContext } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createMockTypingSignaler,
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  GENERIC_RUN_FAILURE_TEXT,
  NON_DIRECT_FAILURE_SURFACE_CASES,
  createNonDirectFailureSessionCtx,
} from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();

describe("executeAgentTurn: conversation failures", () => {
  it.each(NON_DIRECT_FAILURE_SURFACE_CASES)(
    "keeps raw runner failure boilerplate out of $label chats",
    async (testCase) => {
      state.runEmbeddedAgentMock.mockRejectedValueOnce(
        new Error("openai/gpt-5.5 ended with an incomplete terminal response"),
      );

      const executeAgentTurn = await getExecuteAgentTurnForTest();
      const result = await executeAgentTurn(
        createMinimalRunAgentTurnParams({
          sessionCtx: createNonDirectFailureSessionCtx(testCase),
        }),
      );

      expect(result.kind).toBe("final");
      if (result.kind === "final") {
        expect(result.payload.text).toBe(SILENT_REPLY_TOKEN);
      }
    },
  );

  it.each(["group", "channel"] as const)(
    "surfaces raw runner failure copy in Discord %s chats when silentReply.group is set to disallow",
    async (chatType) => {
      state.runEmbeddedAgentMock.mockRejectedValueOnce(
        new Error("openai/gpt-5.5 ended with an incomplete terminal response"),
      );

      const followupRun = createFollowupRun();
      followupRun.run.config = {
        agents: {
          defaults: {
            silentReply: { group: "disallow" },
          },
        },
      };

      const executeAgentTurn = await getExecuteAgentTurnForTest();
      const result = await executeAgentTurn(
        createMinimalRunAgentTurnParams({
          followupRun,
          sessionCtx: {
            Provider: "discord",
            Surface: "discord",
            ChatType: chatType,
            GroupSubject: "agent group",
            GroupChannel: "#general",
            MessageSid: "msg",
          } as unknown as TemplateContext,
        }),
      );

      expect(result.kind).toBe("final");
      if (result.kind === "final") {
        expect(result.payload.text).not.toBe(SILENT_REPLY_TOKEN);
        expect(result.payload.text).toBe(GENERIC_RUN_FAILURE_TEXT);
      }
    },
  );

  it("surfaces raw runner failure copy when per-surface silentReply.group is set to disallow", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error("openai/gpt-5.5 ended with an incomplete terminal response"),
    );

    const followupRun = createFollowupRun();
    followupRun.run.config = {
      agents: {
        defaults: {
          silentReply: { group: "allow" },
        },
      },
      surfaces: {
        discord: {
          silentReply: { group: "disallow" },
        },
      },
    };

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        followupRun,
        sessionCtx: {
          Provider: "discord",
          Surface: "discord",
          ChatType: "group",
          GroupSubject: "agent group",
          GroupChannel: "#general",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
    );

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(GENERIC_RUN_FAILURE_TEXT);
    }
  });

  it("returns a session reset hint for Bedrock tool mismatch errors on external chat channels", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error(
        "The number of toolResult blocks at messages.186.content exceeds the number of toolUse blocks of previous turn.",
      ),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
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

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
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

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
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

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
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
