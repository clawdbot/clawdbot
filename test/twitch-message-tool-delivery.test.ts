// Exercises Twitch's public plugin through the real message tool, delivery, and CLI projection.
import { afterEach, describe, expect, it, vi } from "vitest";
import { twitchPlugin } from "../extensions/twitch/api.js";
import { isDeliveredMessagingToolResult } from "../src/agents/embedded-agent-message-tool-source-reply.js";
import { installMessageToolOnlyTerminalHook } from "../src/agents/embedded-agent-runner/run/message-tool-terminal.js";
import type { Agent, AfterToolCallContext } from "../src/agents/runtime/index.js";
import { createMessageTool } from "../src/agents/tools/message-tool-execution.js";
import type { TrustedMessageAuditEvent } from "../src/audit/message-audit-events.js";
import { onTrustedMessageAuditEventForTest } from "../src/audit/message-audit-events.test-support.js";
import { buildThreadingToolContext } from "../src/auto-reply/reply/agent-runner-utils.js";
import { formatMessageCliText } from "../src/commands/message-format.js";
import { loadUnfinishedDeliveries } from "../src/infra/outbound/delivery-queue-storage.js";
import { runMessageAction } from "../src/infra/outbound/message-action-runner.js";
import { sendMessage } from "../src/infra/outbound/message.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import { onSessionTranscriptUpdate } from "../src/sessions/transcript-events.js";
import { createTestRegistry } from "../src/test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

afterEach(() => setActivePluginRegistry(createTestRegistry([])));

const manager = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock("../extensions/twitch/src/client-manager-registry.js", () => ({
  getClientManager: () => manager,
  removeClientManager: vi.fn(),
}));

describe("Twitch message-tool delivery", () => {
  it.each([
    {
      name: "explicit current-source reply",
      explicit: true,
      sameSource: true,
      message: "Hello source!",
      expected: "Hello source!",
    },
    {
      name: "bare channel name",
      explicit: true,
      bareTarget: true,
      message: "Hello Twitch!",
      expected: "Hello Twitch!",
    },
    { name: "implicit no-send", explicit: false, message: "---", expected: "" },
    { name: "explicit no-send", explicit: true, message: "---", expected: "" },
    {
      name: "single implicit account",
      explicit: false,
      singleAccount: true,
      message: "Hello Twitch!",
      expected: "Hello Twitch!",
    },
    {
      name: "long Markdown",
      explicit: false,
      message: `**${"a".repeat(499)}😀b**`,
      expected: `${"a".repeat(499)}😀b`,
    },
    {
      name: "implicit source configured default",
      explicit: false,
      message: "**Hello** Twitch!",
      expected: "Hello Twitch!",
    },
    {
      name: "explicit target override",
      explicit: true,
      message: "**Hello** Twitch!",
      expected: "Hello Twitch!",
    },
    {
      name: "literal markdown code",
      explicit: false,
      message: "Use `*literal*` here",
      expected: "Use *literal* here",
    },
    { name: "literal horizontal rule", explicit: false, message: "`---`", expected: "---" },
    {
      name: "escaped emphasis",
      explicit: true,
      message: String.raw`Use \*literal\* here`,
      expected: "Use *literal* here",
    },
  ])(
    "sends $name",
    async ({ explicit, message, expected, singleAccount, bareTarget, sameSource }) => {
      await withOpenClawTestState({ prefix: "twitch-message-delivery-" }, async (state) => {
        manager.sendMessage.mockReset();
        const accountId = singleAccount
          ? "default"
          : explicit && !sameSource
            ? "other"
            : "secondary";
        const target = explicit && !sameSource ? "overridechannel" : "sourcechannel";
        const account = {
          username: "fixture-bot",
          clientId: "fixture-client",
          accessToken: "fixture-token",
          channel: "sourcechannel",
        };
        const cfg = {
          channels: {
            twitch: singleAccount
              ? account
              : {
                  defaultAccount: "secondary",
                  accounts: { secondary: account, [accountId]: account },
                },
          },
        };
        const sent = expected.length > 0;
        const custodyAtSend: Awaited<ReturnType<typeof loadUnfinishedDeliveries>>[] = [];
        manager.sendMessage.mockImplementation(async () => {
          custodyAtSend.push(await loadUnfinishedDeliveries(state.stateDir));
          return { ok: true, messageId: "fixture-sent-1" };
        });
        setActivePluginRegistry(
          createTestRegistry([{ pluginId: "twitch", source: "test", plugin: twitchPlugin }]),
        );
        const sessionKey = "agent:main:twitch:group:sourcechannel";
        const sourceAccountId = singleAccount ? "default" : "secondary";
        const sourceTarget = "twitch:channel:sourcechannel";
        const toolContext = buildThreadingToolContext({
          sessionCtx: { Provider: "twitch", To: sourceTarget, AccountId: sourceAccountId },
          config: cfg,
          hasRepliedRef: undefined,
        });
        const runAction = vi.fn(runMessageAction);
        const tool = createMessageTool({
          config: cfg,
          agentId: "main",
          agentSessionKey: sessionKey,
          ...toolContext,
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
        expect(tool.parameters).toMatchObject({
          properties: { action: { enum: expect.arrayContaining(["send"]) } },
        });
        const args = {
          action: "send",
          message,
          ...(explicit
            ? {
                channel: "twitch",
                target: sameSource ? sourceTarget : bareTarget ? target : `#${target}`,
                accountId,
              }
            : {}),
        };
        const audits: TrustedMessageAuditEvent[] = [];
        const transcriptUpdated = vi.fn();
        const unsubscribeAudit = onTrustedMessageAuditEventForTest((event) => audits.push(event));
        const unsubscribeTranscript = onSessionTranscriptUpdate(transcriptUpdated);
        try {
          const result = await tool.execute("twitch-send", args);
          expect.soft(manager.sendMessage).toHaveBeenCalledTimes(sent ? 1 : 0);
          if (sent) {
            expect
              .soft(manager.sendMessage)
              .toHaveBeenCalledWith(account, target, expected, cfg, accountId);
            expect.soft(custodyAtSend).toEqual([
              [
                expect.objectContaining({
                  channel: "twitch",
                  ...(explicit ? { accountId } : {}),
                  to: target,
                  recoveryState: "send_attempt_started",
                }),
              ],
            ]);
            expect.soft(result.details).toMatchObject({
              deliveryStatus: "sent",
              messageDelivery: { status: "settled", primaryPlatformMessageId: "fixture-sent-1" },
              result: {
                messageId: "fixture-sent-1",
                receipt: { platformMessageIds: ["fixture-sent-1"] },
              },
            });
            expect.soft(transcriptUpdated).toHaveBeenCalledTimes(1);
          } else {
            expect.soft(result.details).toMatchObject({
              deliveryStatus: "suppressed",
              suppressionReason: "adapter_returned_no_send",
              messageDelivery: { status: "suppressed" },
            });
            expect.soft(transcriptUpdated).not.toHaveBeenCalled();
          }
          expect.soft(isDeliveredMessagingToolResult({ args, result })).toBe(sent);
          const actionResult = await runAction.mock.results[0]?.value;
          expect.soft(actionResult).toMatchObject({ handledBy: "core", to: target });
          const output = formatMessageCliText(actionResult).join("\n");
          expect
            .soft(output)
            .toContain(sent ? "fixture-sent-1" : "send suppressed: adapter_returned_no_send");
          expect
            .soft(
              audits.filter((event) => event.outcome === "sent" || event.outcome === "suppressed"),
            )
            .toEqual([
              expect.objectContaining(
                sent
                  ? { outcome: "sent", resultCount: 1 }
                  : { outcome: "suppressed", resultCount: 0, reasonCode: "no_visible_payload" },
              ),
            ]);
          expect(await loadUnfinishedDeliveries(state.stateDir)).toEqual([]);

          const agent = {} as Agent;
          const delivered = vi.fn();
          installMessageToolOnlyTerminalHook({
            agent,
            config: cfg,
            currentProvider: "twitch",
            currentAccountId: sourceAccountId,
            currentChannelId: toolContext.currentChannelId,
            currentMessagingTarget: toolContext.currentMessagingTarget,
            sessionKey,
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
          expect
            .soft((await agent.afterToolCall?.(context))?.terminate)
            .toBe(sent && (!explicit || sameSource) ? true : undefined);
          expect.soft(delivered).toHaveBeenCalledTimes(sent && (!explicit || sameSource) ? 1 : 0);
        } finally {
          unsubscribeAudit();
          unsubscribeTranscript();
        }
      });
    },
  );
});

describe("Twitch core send defaults and failures", () => {
  it.each([undefined, "other"])("uses the configured channel for account %s", async (accountId) => {
    await withOpenClawTestState({ prefix: "twitch-default-send-" }, async (state) => {
      const account = {
        username: "fixture-bot",
        clientId: "fixture-client",
        accessToken: "fixture-token",
        channel: "sourcechannel",
      };
      const cfg = {
        channels: {
          twitch: {
            defaultAccount: "secondary",
            accounts: { secondary: account, other: { ...account, channel: "otherchannel" } },
          },
        },
      };
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "twitch", source: "test", plugin: twitchPlugin }]),
      );
      manager.sendMessage.mockReset().mockResolvedValue({ ok: true, messageId: "default-send-1" });
      const result = await sendMessage({
        cfg,
        channel: "twitch",
        to: "",
        accountId,
        content: "**Hello** Twitch!",
        queuePolicy: "best_effort",
      });
      expect(result).toMatchObject({
        deliveryStatus: "sent",
        result: { messageId: "default-send-1" },
      });
      expect(manager.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ username: "fixture-bot" }),
        accountId ? "otherchannel" : "sourcechannel",
        "Hello Twitch!",
        cfg,
        accountId ?? "secondary",
      );
      expect(await loadUnfinishedDeliveries(state.stateDir)).toEqual([]);
    });
  });

  it("keeps transport failures actionable instead of reporting delivery", async () => {
    await withOpenClawTestState({ prefix: "twitch-send-error-" }, async () => {
      const cfg = {
        channels: {
          twitch: {
            username: "fixture-bot",
            clientId: "fixture-client",
            accessToken: "fixture-token",
            channel: "sourcechannel",
          },
        },
      };
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "twitch", source: "test", plugin: twitchPlugin }]),
      );
      manager.sendMessage
        .mockReset()
        .mockResolvedValue({ ok: false, error: "fixture transport disconnected" });
      await expect(
        runMessageAction({
          cfg,
          action: "send",
          params: { channel: "twitch", to: "#sourcechannel", message: "Hello Twitch!" },
        }),
      ).rejects.toThrow("fixture transport disconnected");
      expect(manager.sendMessage).toHaveBeenCalledOnce();
    });
  });
});
