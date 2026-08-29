// Exercises Twitch's public plugin through the real message tool, delivery, and CLI projection.
import { afterEach, describe, expect, it, vi } from "vitest";
import { twitchPlugin } from "../extensions/twitch/api.js";
import { isDeliveredMessagingToolResult } from "../src/agents/embedded-agent-message-tool-source-reply.js";
import { installMessageToolOnlyTerminalHook } from "../src/agents/embedded-agent-runner/run/message-tool-terminal.js";
import type { Agent, AfterToolCallContext } from "../src/agents/runtime/index.js";
import { createMessageTool } from "../src/agents/tools/message-tool-execution.js";
import type { TrustedMessageAuditEvent } from "../src/audit/message-audit-events.js";
import { onTrustedMessageAuditEventForTest } from "../src/audit/message-audit-events.test-support.js";
import { formatMessageCliText } from "../src/commands/message-format.js";
import { loadUnfinishedDeliveries } from "../src/infra/outbound/delivery-queue-storage.js";
import { runMessageAction } from "../src/infra/outbound/message-action-runner.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import { onSessionTranscriptUpdate } from "../src/sessions/transcript-events.js";
import { createTestRegistry } from "../src/test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

afterEach(() => setActivePluginRegistry(createTestRegistry([])));

describe("Twitch message-tool delivery", () => {
  it.each([
    { name: "implicit source target and configured default account", explicit: false },
    { name: "explicit target and account override", explicit: true },
  ])("records a no-send for $name", async ({ explicit }) => {
    await withOpenClawTestState({ prefix: "twitch-message-no-send-" }, async (state) => {
      const accountId = explicit ? "other" : "secondary";
      const target = explicit ? "overridechannel" : "sourcechannel";
      const cfg = {
        channels: {
          twitch: {
            defaultAccount: "secondary",
            accounts: {
              [accountId]: {
                username: "fixture-bot",
                clientId: "fixture-client",
                accessToken: "fixture-token",
                channel: "sourcechannel",
              },
            },
          },
        },
      };
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "twitch", source: "test", plugin: twitchPlugin }]),
      );
      const runAction = vi.fn(runMessageAction);
      const tool = createMessageTool({
        config: cfg,
        agentId: "main",
        agentSessionKey: `agent:main:twitch:group:${target}`,
        currentChannelProvider: "twitch",
        currentMessagingTarget: `#${target}`,
        sourceReplyDeliveryMode: "message_tool_only",
        workspaceDir: state.workspaceDir,
        runMessageAction: runAction,
        getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
        resolveCommandSecretRefsViaGateway: async ({ config }) => ({
          resolvedConfig: config,
          diagnostics: [],
          targetStatesByPath: {},
          hadUnresolvedTargets: false,
        }),
      });
      const args = {
        action: "send",
        message: "---",
        ...(explicit ? { channel: "twitch", target: `#${target}`, accountId } : {}),
      };
      const audits: TrustedMessageAuditEvent[] = [];
      const transcriptUpdated = vi.fn();
      const unsubscribeAudit = onTrustedMessageAuditEventForTest((event) => audits.push(event));
      const unsubscribeTranscript = onSessionTranscriptUpdate(transcriptUpdated);
      try {
        // No client manager is installed: the real sanitizer must omit transport I/O.
        const result = await tool.execute("twitch-send", args);
        expect.soft(isDeliveredMessagingToolResult({ args, result })).toBe(false);
        expect.soft(result.details).toMatchObject({
          deliveryStatus: "suppressed",
          suppressionReason: "adapter_returned_no_send",
          messageDelivery: { status: "suppressed" },
        });
        const actionResult = await runAction.mock.results[0]?.value;
        expect.soft(actionResult).toMatchObject({ handledBy: "core", to: `#${target}` });
        expect
          .soft(formatMessageCliText(actionResult).join("\n"))
          .toContain("send suppressed: adapter_returned_no_send");
        expect.soft(transcriptUpdated).not.toHaveBeenCalled();
        expect.soft(audits).toContainEqual(
          expect.objectContaining({
            outcome: "suppressed",
            resultCount: 0,
            reasonCode: "no_visible_payload",
          }),
        );
        expect(await loadUnfinishedDeliveries(state.stateDir)).toEqual([]);

        const agent = {} as Agent;
        const delivered = vi.fn();
        installMessageToolOnlyTerminalHook({
          agent,
          config: cfg,
          currentProvider: "twitch",
          currentMessagingTarget: `#${target}`,
          sourceReplyDeliveryMode: "message_tool_only",
          onDeliveredSourceReply: delivered,
        });
        const toolCall = {
          type: "toolCall" as const,
          id: "twitch-send",
          name: "message",
          arguments: args,
        };
        const context: AfterToolCallContext = {
          toolCall,
          args,
          result,
          isError: false,
          context: { systemPrompt: "", messages: [], tools: [] },
          assistantMessage: {
            role: "assistant",
            content: [toolCall],
            api: "openai-responses",
            provider: "openai",
            model: "gpt-5.6-luna",
            stopReason: "toolUse",
            timestamp: 0,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
        };
        expect.soft((await agent.afterToolCall?.(context))?.terminate).not.toBe(true);
        expect.soft(delivered).not.toHaveBeenCalled();
      } finally {
        unsubscribeAudit();
        unsubscribeTranscript();
      }
    });
  });
});
