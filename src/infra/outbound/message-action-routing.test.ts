// Covers plugin-dispatched message actions, target resolution, dry-run behavior,
// and plugin tool-result extraction.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type {
  ChannelMessageActionContext,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import {
  createAlwaysConfiguredPluginConfig,
  createGatewayActionPlugin,
  messageActionRunnerMocks as mocks,
  resetMessageActionRunnerMocks,
  runMessageAction,
  setMessageActionTestPlugin as setTestPlugin,
} from "./message-action-runner.test-helpers.js";

const requireRecord = createRequireRecord("record", "expected-non-array-record");
const requireLabeledRecord = createRequireRecord("record", "expected-label");

function readFirstPluginCall(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const [mockCall] = mock.mock.calls;
  const call = mockCall?.[0];
  return requireRecord(call);
}

function readPluginCall(
  mock: { mock: { calls: unknown[][] } },
  callIndex: number,
): Record<string, unknown> {
  const mockCall = mock.mock.calls[callIndex];
  const call = mockCall?.[0];
  return requireRecord(call);
}

function readLastPluginCall(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  return readPluginCall(mock, mock.mock.calls.length - 1);
}

function readRecordField(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key];
  return requireLabeledRecord(value, label);
}

function expectRecordFields(
  record: Record<string, unknown>,
  expected: Record<string, unknown>,
  label: string,
) {
  for (const [key, value] of Object.entries(expected)) {
    expect(record[key], `${label}.${key}`).toEqual(value);
  }
}

describe("runMessageAction plugin dispatch", () => {
  beforeEach(() => {
    resetMessageActionRunnerMocks();
  });
  describe("alias-based plugin action dispatch", () => {
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({
        ok: true,
        params,
      }),
    );

    const actionHubPlugin: ChannelPlugin = {
      id: "actionhub",
      meta: {
        id: "actionhub",
        label: "Action Hub",
        selectionLabel: "Action Hub",
        docsPath: "/channels/actionhub",
        blurb: "Action Hub action dispatch test plugin.",
      },
      capabilities: { chatTypes: ["direct", "channel"] },
      config: createAlwaysConfiguredPluginConfig(),
      messaging: {
        targetPrefixes: ["actionhub", "actionhub-alias"],
        normalizeTarget: (raw) => raw.replace(/^actionhub-alias:/i, "actionhub:"),
        targetResolver: {
          looksLikeId: () => true,
        },
      },
      actions: {
        describeMessageTool: () => ({
          actions: [
            "pin",
            "unpin",
            "list-pins",
            "member-info",
            "channel-info",
            "edit",
            "thread-create",
            "thread-reply",
          ],
        }),
        messageActionTargetAliases: {
          edit: {
            aliases: ["messageId", "chatId", "chat_id", "channel_id"],
            deliveryTargetAliases: ["chatId", "chat_id", "channel_id"],
          },
          pin: {
            aliases: ["messageId", "chatId", "chat_id", "channel_id"],
            deliveryTargetAliases: ["chatId", "chat_id", "channel_id"],
          },
          unpin: {
            aliases: ["messageId", "chatId", "chat_id", "channel_id"],
            deliveryTargetAliases: ["chatId", "chat_id", "channel_id"],
          },
        },
        supportsAction: ({ action }) =>
          action === "pin" ||
          action === "unpin" ||
          action === "list-pins" ||
          action === "member-info" ||
          action === "channel-info" ||
          action === "edit" ||
          action === "thread-create" ||
          action === "thread-reply",
        handleAction,
      },
    };

    beforeEach(() => {
      setTestPlugin(actionHubPlugin, "actionhub");
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
      vi.unstubAllEnvs();
    });
    it.each([
      { action: "unpin" as const, alias: "chatId", messageId: "om_unpin" },
      { action: "edit" as const, alias: "chat_id", messageId: "om_edit" },
      { action: "pin" as const, alias: "channel_id", messageId: "om_pin" },
    ])("guards $alias delivery aliases for $action before plugin dispatch", async (testCase) => {
      const cfg = {
        channels: { actionhub: { enabled: true } },
        tools: { message: { crossContext: { allowWithinProvider: false } } },
      } as OpenClawConfig;
      const toolContext = {
        currentChannelProvider: "actionhub" as const,
        currentChannelId: "oc_current",
      };

      await expect(
        runMessageAction({
          cfg,
          action: testCase.action,
          params: {
            channel: "actionhub",
            messageId: testCase.messageId,
            [testCase.alias]: "oc_foreign",
          },
          toolContext,
          conversationReadOrigin: "direct-operator",
          dryRun: false,
        }),
      ).rejects.toThrow("Cross-context messaging denied");
      expect(handleAction).not.toHaveBeenCalled();

      await expect(
        runMessageAction({
          cfg,
          action: testCase.action,
          params: {
            channel: "actionhub",
            messageId: testCase.messageId,
            [testCase.alias]: "oc_current",
          },
          toolContext,
          conversationReadOrigin: "direct-operator",
          dryRun: false,
        }),
      ).resolves.toMatchObject({ kind: "action", action: testCase.action });
      expect(handleAction).toHaveBeenCalledOnce();
    });

    it("infers the trusted current target for resource-referenced edits", async () => {
      setTestPlugin(actionHubPlugin, "actionhub", "bundled");
      await runMessageAction({
        cfg: {
          channels: {
            actionhub: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "edit",
        params: {
          channel: "actionhub",
          messageId: "om_123",
          text: "updated",
        },
        toolContext: {
          currentChannelProvider: "actionhub",
          currentChannelId: "actionhub:current",
        },
        defaultAccountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        dryRun: false,
      });

      expectRecordFields(
        readRecordField(readLastPluginCall(handleAction), "params", "edit call params"),
        {
          messageId: "om_123",
          target: "actionhub:current",
          text: "updated",
          to: "actionhub:current",
        },
        "edit call params",
      );
    });

    it("uses capability authorization instead of ambient routing for local plugin actions", async () => {
      const cfg = {
        channels: {
          actionhub: {
            enabled: true,
          },
        },
      } as OpenClawConfig;

      await expect(
        runMessageAction({
          cfg,
          action: "pin",
          params: {
            channel: "actionhub",
            messageId: "om_123",
            target: "forged-current",
          },
          requesterAccountId: "forged-account",
          requesterSenderId: "forged-sender",
          toolContext: {
            currentChannelId: "forged-current",
            currentChannelProvider: "actionhub",
          },
          messageActionAuthorization: {},
          dryRun: false,
        }),
      ).rejects.toThrow("requires the exact current conversation and account");
      expect(handleAction).not.toHaveBeenCalled();

      await runMessageAction({
        cfg,
        action: "pin",
        params: {
          channel: "actionhub",
          messageId: "om_123",
          target: "trusted-current",
        },
        defaultAccountId: "trusted-account",
        requesterAccountId: "forged-account",
        requesterSenderId: "forged-sender",
        toolContext: {
          currentChannelId: "forged-current",
          currentChannelProvider: "actionhub",
        },
        messageActionAuthorization: {
          requesterAccountId: "trusted-account",
          requesterSenderId: "trusted-sender",
          toolContext: {
            currentChannelId: "trusted-current",
            currentChannelProvider: "actionhub",
          },
        },
        dryRun: false,
      });

      const trustedCall = readPluginCall(handleAction, 0);
      expectRecordFields(
        trustedCall,
        {
          requesterAccountId: "trusted-account",
          requesterSenderId: "trusted-sender",
        },
        "trusted plugin action call",
      );
      expectRecordFields(
        readRecordField(trustedCall, "toolContext", "trusted plugin tool context"),
        {
          currentChannelId: "trusted-current",
          currentChannelProvider: "actionhub",
        },
        "trusted plugin tool context",
      );
    });

    it("canonicalizes channelId-backed execution targets after host authorization", async () => {
      await runMessageAction({
        cfg: {
          channels: {
            actionhub: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "channel-info",
        params: {
          channel: "actionhub",
          target: "actionhub-alias:current",
        },
        defaultAccountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelId: "actionhub:current",
          currentChannelProvider: "actionhub",
          currentChatType: "channel",
        },
        dryRun: false,
      });

      const call = readFirstPluginCall(handleAction);
      expectRecordFields(
        readRecordField(call, "params", "normalized plugin params"),
        {
          target: "actionhub:current",
          channelId: "actionhub:current",
        },
        "normalized plugin params",
      );
    });

    it("canonicalizes the execution target only after host authorization", async () => {
      await runMessageAction({
        cfg: {
          channels: {
            actionhub: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "pin",
        params: {
          channel: "actionhub",
          target: "actionhub-alias:current",
          messageId: "om_123",
        },
        defaultAccountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelId: "actionhub:current",
          currentChannelProvider: "actionhub",
        },
        dryRun: false,
      });

      const call = readFirstPluginCall(handleAction);
      expectRecordFields(
        readRecordField(call, "params", "normalized plugin params"),
        {
          target: "actionhub:current",
          to: "actionhub:current",
        },
        "normalized plugin params",
      );
    });

    it("preserves a trusted canonical sibling for a typed external current target", async () => {
      await runMessageAction({
        cfg: {
          channels: {
            actionhub: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "pin",
        params: {
          channel: "actionhub",
          target: "channel:current",
          messageId: "om_123",
        },
        defaultAccountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelId: "actionhub:current",
          currentChannelProvider: "actionhub",
          currentChatType: "channel",
        },
        dryRun: false,
      });

      const call = readFirstPluginCall(handleAction);
      expectRecordFields(
        readRecordField(call, "params", "normalized plugin params"),
        {
          target: "actionhub:current",
          to: "actionhub:current",
        },
        "normalized plugin params",
      );
    });

    it("canonicalizes an external exact-current alias before legacy target resolution", async () => {
      const looksLikeId = vi.fn((raw: string) => !/^room:/i.test(raw));
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "actionhub",
            source: "test",
            origin: "config",
            plugin: {
              ...actionHubPlugin,
              messaging: {
                targetPrefixes: ["actionhub"],
                normalizeTarget: (raw: string) =>
                  raw.replace(/^room:/i, "actionhub:").replace(/^actionhub:/i, "actionhub:"),
                targetResolver: {
                  looksLikeId,
                },
              },
            },
          },
        ]),
      );

      await runMessageAction({
        cfg: {
          channels: {
            actionhub: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "pin",
        params: {
          channel: "actionhub",
          target: "room:current",
          messageId: "om_123",
        },
        defaultAccountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelId: "actionhub:current",
          currentChannelProvider: "actionhub",
          currentChatType: "group",
        },
        dryRun: false,
      });

      expect(looksLikeId).toHaveBeenCalledWith("actionhub:current", "actionhub:current");
      const call = readFirstPluginCall(handleAction);
      expectRecordFields(
        readRecordField(call, "params", "normalized plugin params"),
        {
          target: "actionhub:current",
          to: "actionhub:current",
        },
        "normalized plugin params",
      );
    });

    it("preserves no-context owner Discord admin actions through the shared runner", async () => {
      const handleDiscordAction = vi.fn(async (ctx: ChannelMessageActionContext) => {
        const currentProvider = ctx.toolContext?.currentChannelProvider?.trim().toLowerCase();
        if (ctx.action === "channel-delete" && currentProvider && currentProvider !== "discord") {
          throw new Error("Discord guild admin actions require a trusted Discord sender identity.");
        }
        if (ctx.action === "channel-delete" && !currentProvider && ctx.senderIsOwner !== true) {
          throw new Error("Discord guild admin actions require a trusted Discord sender identity.");
        }
        return jsonResult({ ok: true, action: ctx.action });
      });
      const discordPlugin: ChannelPlugin = {
        id: "discord",
        meta: {
          id: "discord",
          label: "Discord",
          selectionLabel: "Discord",
          docsPath: "/channels/discord",
          blurb: "Discord action dispatch test plugin.",
        },
        capabilities: { chatTypes: ["direct", "channel"] },
        config: createAlwaysConfiguredPluginConfig(),
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        actions: {
          describeMessageTool: () => ({ actions: ["channel-delete", "channel-info"] }),
          supportsAction: ({ action }) => action === "channel-delete" || action === "channel-info",
          requiresTrustedRequesterSender: ({ action, toolContext }) =>
            Boolean(toolContext) && action === "channel-delete",
          handleAction: handleDiscordAction,
        },
      };
      const cfg = {
        channels: {
          discord: {
            enabled: true,
          },
        },
      } as OpenClawConfig;

      setTestPlugin(discordPlugin, "discord", "bundled");

      await runMessageAction({
        cfg,
        action: "channel-delete",
        params: {
          channel: "discord",
          channelId: "channel-1",
        },
        senderIsOwner: true,
        dryRun: false,
      });

      expectRecordFields(
        readFirstPluginCall(handleDiscordAction),
        {
          action: "channel-delete",
          senderIsOwner: true,
        },
        "owner action call",
      );

      handleDiscordAction.mockClear();
      await expect(
        runMessageAction({
          cfg,
          action: "channel-delete",
          params: {
            channel: "discord",
            channelId: "channel-1",
          },
          toolContext: { currentChannelProvider: "telegram" },
          dryRun: false,
        }),
      ).rejects.toThrow("Trusted sender identity is required for discord:channel-delete");
      expect(handleDiscordAction).not.toHaveBeenCalled();

      await expect(
        runMessageAction({
          cfg,
          action: "channel-delete",
          params: {
            channel: "discord",
            channelId: "channel-1",
          },
          requesterSenderId: "telegram-user",
          toolContext: { currentChannelProvider: "telegram" },
          dryRun: false,
        }),
      ).rejects.toThrow("trusted Discord sender identity");
      expect(handleDiscordAction).toHaveBeenCalledOnce();

      handleDiscordAction.mockClear();
      await runMessageAction({
        cfg,
        action: "channel-info",
        params: {
          channel: "discord",
          channelId: "channel-1",
        },
        toolContext: { currentChannelProvider: "telegram" },
        dryRun: false,
      });
      expect(handleDiscordAction).toHaveBeenCalledOnce();
    });

    it("resolves authorized gateway-mode dry-run targets locally", async () => {
      const looksLikeId = vi.fn(() => true);
      const handleDryRunAction = vi.fn(async () => jsonResult({ ok: true, local: true }));
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat dry-run target test plugin.",
        actions: ["react"],
        capabilities: { chatTypes: ["direct"], reactions: true },
        messaging: {
          targetResolver: {
            looksLikeId,
          },
        },
        handleAction: handleDryRunAction,
      });
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "gatewaychat",
            source: "test",
            origin: "config",
            plugin: gatewayPlugin,
          },
        ]),
      );

      const result = await runMessageAction({
        cfg: {
          channels: {
            gatewaychat: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "react",
        params: {
          channel: "gatewaychat",
          target: "room:current",
          messageId: "message-1",
          emoji: "eyes",
        },
        defaultAccountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelId: "gatewaychat:current",
          currentChannelProvider: "gatewaychat",
          currentChatType: "group",
        },
        gateway: {
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
        },
        dryRun: true,
      });

      expect(result).toMatchObject({
        kind: "action",
        handledBy: "dry-run",
        dryRun: true,
      });
      expect(looksLikeId).toHaveBeenCalledOnce();
      expect(handleDryRunAction).not.toHaveBeenCalled();
      expect(mocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
    });
  });
});
