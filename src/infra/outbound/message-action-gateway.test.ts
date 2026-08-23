// Covers plugin-dispatched message actions, target resolution, dry-run behavior,
// and plugin tool-result extraction.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import {
  createAlwaysConfiguredPluginConfig,
  createGatewayActionPlugin,
  createPollForwardingPlugin,
  messageActionRunnerMocks as mocks,
  resetMessageActionRunnerMocks,
  runMessageAction,
  setMessageActionTestPlugin as setTestPlugin,
} from "./message-action-runner.test-helpers.js";

const requireLabeledRecord = createRequireRecord("record", "expected-label");

function readMockCallArg(
  mock: { mock: { calls: unknown[][] } },
  label: string,
  callIndex = 0,
  argIndex = 0,
): Record<string, unknown> {
  const mockCall = mock.mock.calls[callIndex];
  const value = mockCall?.[argIndex];
  return requireLabeledRecord(value, label);
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
    it("routes gateway-executed plugin actions through gateway RPC instead of local dispatch", async () => {
      const handleActionEntry = vi.fn(async () =>
        jsonResult({
          ok: true,
          local: true,
        }),
      );
      const looksLikeId = vi.fn(() => true);
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat reaction test plugin.",
        actions: ["react"],
        capabilities: { chatTypes: ["direct"], reactions: true },
        messaging: {
          targetResolver: {
            looksLikeId,
          },
        },
        handleAction: handleActionEntry,
      });
      setTestPlugin(gatewayPlugin, "gatewaychat");
      mocks.callGatewayLeastPrivilege.mockResolvedValue({
        ok: true,
        added: "✅",
      });

      const resolveAgentRuntimeIdentityToken = vi.fn(async () => "agent-runtime-token");
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
          to: "+15551234567",
          chatJid: "+15551234567",
          messageId: "wamid.1",
          emoji: "✅",
        },
        requesterSenderId: "trusted-user",
        sessionKey: "agent:alpha:main",
        sessionId: "session-123",
        agentId: "alpha",
        inboundEventKind: "room_event",
        toolContext: {
          currentChannelProvider: "gatewaychat",
          currentMessageId: "wamid.1",
        },
        gateway: {
          resolveAgentRuntimeIdentityToken,
          clientName: "cli",
          mode: "cli",
        },
        dryRun: false,
      });

      const gatewayCall = readMockCallArg(
        mocks.callGatewayLeastPrivilege,
        "gateway least privilege call",
      );
      expectRecordFields(gatewayCall, { method: "message.action" }, "gateway call");
      expect(gatewayCall.agentRuntimeIdentityToken).toBe("agent-runtime-token");
      expect(resolveAgentRuntimeIdentityToken).toHaveBeenCalledTimes(1);
      const gatewayParams = readRecordField(gatewayCall, "params", "gateway call params");
      expect(gatewayParams).not.toHaveProperty("conversationReadOrigin");
      expectRecordFields(
        gatewayParams,
        {
          channel: "gatewaychat",
          action: "react",
          sessionKey: "agent:alpha:main",
          sessionId: "session-123",
          agentId: "alpha",
          inboundTurnKind: "room_event",
          idempotencyKey: "idem-gateway-action",
        },
        "gateway call params",
      );
      expect(gatewayParams).not.toHaveProperty("requesterAccountId");
      expect(gatewayParams).not.toHaveProperty("requesterSenderId");
      expect(gatewayParams).not.toHaveProperty("toolContext");
      expect(looksLikeId).not.toHaveBeenCalled();
      expect(handleActionEntry).not.toHaveBeenCalled();
      expectRecordFields(
        result,
        {
          kind: "action",
          channel: "gatewaychat",
          action: "react",
          handledBy: "plugin",
        },
        "result",
      );
      expectRecordFields(
        readRecordField(result, "payload", "result payload"),
        {
          ok: true,
          added: "✅",
        },
        "result payload",
      );
    });

    it("keeps blank backend requester provenance least-privileged", async () => {
      const handleActionEntry = vi.fn(async () => jsonResult({ ok: true, local: true }));
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat blank requester test plugin.",
        actions: ["react"],
        capabilities: { chatTypes: ["direct"], reactions: true },
        handleAction: handleActionEntry,
      });
      setTestPlugin(gatewayPlugin, "gatewaychat");
      mocks.callGatewayLeastPrivilege.mockResolvedValue({
        ok: true,
        added: "✅",
      });

      await runMessageAction({
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
          to: "+15551234567",
          chatJid: "+15551234567",
          messageId: "wamid.1",
          emoji: "✅",
        },
        requesterSenderId: "   ",
        gateway: {
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
        },
        dryRun: false,
      });

      const gatewayCall = readMockCallArg(
        mocks.callGatewayLeastPrivilege,
        "gateway least privilege call",
      );
      expectRecordFields(
        gatewayCall,
        {
          method: "message.action",
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
        },
        "gateway call",
      );
      expect(mocks.callGateway).not.toHaveBeenCalled();
      expect(handleActionEntry).not.toHaveBeenCalled();
    });

    it("keeps CLI gateway-executed actions least-privileged when they carry sender ownership", async () => {
      const handleActionEntry = vi.fn(async () => jsonResult({ ok: true, local: true }));
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat CLI reaction test plugin.",
        actions: ["react"],
        capabilities: { chatTypes: ["direct"], reactions: true },
        handleAction: handleActionEntry,
      });
      setTestPlugin(gatewayPlugin, "gatewaychat");
      mocks.callGatewayLeastPrivilege.mockResolvedValue({
        ok: true,
        added: "✅",
      });

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
          to: "+15551234567",
          chatJid: "+15551234567",
          messageId: "wamid.1",
          emoji: "✅",
        },
        senderIsOwner: true,
        gateway: {
          clientName: GATEWAY_CLIENT_NAMES.CLI,
          mode: GATEWAY_CLIENT_MODES.CLI,
        },
        dryRun: false,
      });

      const gatewayCall = readMockCallArg(
        mocks.callGatewayLeastPrivilege,
        "gateway least privilege call",
      );
      expectRecordFields(
        gatewayCall,
        {
          method: "message.action",
          clientName: GATEWAY_CLIENT_NAMES.CLI,
          mode: GATEWAY_CLIENT_MODES.CLI,
        },
        "gateway call",
      );
      const gatewayParams = readRecordField(gatewayCall, "params", "gateway call params");
      expectRecordFields(
        gatewayParams,
        {
          channel: "gatewaychat",
          action: "react",
          senderIsOwner: true,
        },
        "gateway call params",
      );
      expect(mocks.callGateway).not.toHaveBeenCalled();
      expect(handleActionEntry).not.toHaveBeenCalled();
      expectRecordFields(
        result,
        {
          kind: "action",
          channel: "gatewaychat",
          action: "react",
          handledBy: "plugin",
        },
        "result",
      );
    });

    it("ignores gateway url overrides for backend plugin actions", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat backend action test plugin.",
        actions: ["react"],
        capabilities: { chatTypes: ["direct"], reactions: true },
        handleAction: vi.fn(async () => jsonResult({ ok: true, local: true })),
      });
      setTestPlugin(gatewayPlugin, "gatewaychat");
      mocks.callGatewayLeastPrivilege.mockResolvedValue({
        ok: true,
        added: "ok",
      });

      await runMessageAction({
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
          to: "+15551234567",
          chatJid: "+15551234567",
          messageId: "wamid.1",
          emoji: "ok",
        },
        gateway: {
          url: "ws://127.0.0.1:18789",
          token: "configured-token",
          timeoutMs: 5000,
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
        },
        dryRun: false,
      });

      expectRecordFields(
        readMockCallArg(mocks.callGatewayLeastPrivilege, "gateway least privilege call"),
        {
          url: undefined,
          token: "configured-token",
          timeoutMs: 5000,
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
        },
        "gateway call",
      );
    });

    it("routes gateway-executed plugin sends through gateway RPC instead of local dispatch", async () => {
      const handleActionResult = vi.fn(async () => jsonResult({ ok: true, local: true }));
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat send test plugin.",
        actions: ["send"],
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        handleAction: handleActionResult,
      });
      setTestPlugin(gatewayPlugin, "gatewaychat");
      mocks.callGatewayLeastPrivilege.mockResolvedValue({
        ok: true,
        messageId: "gw-send-1",
      });
      const resolveAgentRuntimeIdentityToken = vi.fn(async () => "test-token-placeholder");

      const result = await runMessageAction({
        cfg: {
          channels: {
            gatewaychat: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "send",
        conversationReadOrigin: "direct-operator",
        sourceReplyDeliveryMode: "message_tool_only",
        sourceReplyFinal: true,
        params: {
          channel: "gatewaychat",
          target: "user-123",
          message: "hello from cli",
        },
        gateway: {
          resolveAgentRuntimeIdentityToken,
          clientName: "cli",
          mode: "cli",
        },
        dryRun: false,
      });

      const gatewayCall = readMockCallArg(
        mocks.callGatewayLeastPrivilege,
        "gateway least privilege call",
      );
      expectRecordFields(gatewayCall, { method: "message.action" }, "gateway call");
      const gatewayParams = readRecordField(gatewayCall, "params", "gateway call params");
      expectRecordFields(
        gatewayParams,
        {
          channel: "gatewaychat",
          action: "send",
          conversationReadOrigin: "direct-operator",
          idempotencyKey: "idem-gateway-action",
        },
        "gateway call params",
      );
      expect(gatewayParams).not.toHaveProperty("sourceReplyFinal");
      expect(resolveAgentRuntimeIdentityToken).toHaveBeenCalledWith({
        sourceReplyFinal: true,
      });
      expectRecordFields(
        readRecordField(gatewayParams, "params", "gateway message params"),
        {
          to: "user-123",
          message: "hello from cli",
        },
        "gateway message params",
      );
      expect(mocks.executeSendAction).not.toHaveBeenCalled();
      expect(handleActionResult).not.toHaveBeenCalled();
      expectRecordFields(
        result,
        {
          kind: "send",
          channel: "gatewaychat",
          action: "send",
          handledBy: "plugin",
        },
        "result",
      );
      expectRecordFields(
        readRecordField(result, "payload", "result payload"),
        {
          ok: true,
          messageId: "gw-send-1",
        },
        "result payload",
      );
    });

    it("makes required queue persistence bypass gateway plugin dispatch", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat durable send test plugin.",
        actions: ["send"],
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        handleAction: vi.fn(async () => jsonResult({ ok: true, local: true })),
      });
      setTestPlugin(gatewayPlugin, "gatewaychat");
      mocks.executeSendAction.mockResolvedValueOnce({
        handledBy: "core",
        payload: { ok: true, messageId: "core-send-1" },
        sendResult: {
          channel: "gatewaychat",
          to: "user-123",
          via: "direct",
          mediaUrl: null,
        },
      });

      const result = await runMessageAction({
        cfg: {
          channels: {
            gatewaychat: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "gatewaychat",
          target: "user-123",
          message: "durable hello",
        },
        gateway: {
          clientName: "cli",
          mode: "cli",
        },
        requireQueuePersistence: true,
        dryRun: false,
      });

      expect(mocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
      const executeCall = readMockCallArg(mocks.executeSendAction, "execute send call");
      expectRecordFields(
        readRecordField(executeCall, "ctx", "execute send context"),
        {
          forceCoreDelivery: true,
          requireQueuePersistence: true,
        },
        "execute send context",
      );
      expectRecordFields(result, { handledBy: "core" }, "result");
    });
  });
  describe("poll plugin forwarding", () => {
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({
        ok: true,
        forwarded: {
          to: params.to ?? null,
          pollQuestion: params.pollQuestion ?? null,
          pollOption: params.pollOption ?? null,
          pollDurationSeconds: params.pollDurationSeconds ?? null,
          pollPublic: params.pollPublic ?? null,
          threadId: params.threadId ?? null,
        },
      }),
    );

    const pollChatPlugin = createPollForwardingPlugin({
      pluginId: "pollchat",
      label: "Poll Chat",
      blurb: "Poll chat forwarding test plugin.",
      handleAction,
    });

    beforeEach(() => {
      setTestPlugin(pollChatPlugin, "pollchat");
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });
    it("routes gateway-executed plugin polls through gateway RPC instead of local dispatch", async () => {
      const handleActionLocal = vi.fn(async () => jsonResult({ ok: true, local: true }));
      const pollGatewayPlugin = createGatewayActionPlugin({
        pluginId: "pollchat",
        label: "Poll Chat",
        blurb: "Poll chat gateway forwarding test plugin.",
        actions: ["poll"],
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        handleAction: handleActionLocal,
      });
      setTestPlugin(pollGatewayPlugin, "pollchat");
      mocks.callGatewayLeastPrivilege.mockResolvedValue({
        ok: true,
        pollId: "gw-poll-1",
      });

      const result = await runMessageAction({
        cfg: {
          channels: {
            pollchat: {
              botToken: "tok",
            },
          },
        } as OpenClawConfig,
        action: "poll",
        params: {
          channel: "pollchat",
          target: "pollchat:123",
          pollQuestion: "Lunch?",
          pollOption: ["Pizza", "Sushi"],
        },
        gateway: {
          clientName: "cli",
          mode: "cli",
        },
        dryRun: false,
      });

      const gatewayCall = readMockCallArg(
        mocks.callGatewayLeastPrivilege,
        "gateway least privilege call",
      );
      expectRecordFields(gatewayCall, { method: "message.action" }, "gateway call");
      const gatewayParams = readRecordField(gatewayCall, "params", "gateway call params");
      expectRecordFields(
        gatewayParams,
        {
          channel: "pollchat",
          action: "poll",
          idempotencyKey: "idem-gateway-action",
        },
        "gateway call params",
      );
      expectRecordFields(
        readRecordField(gatewayParams, "params", "gateway poll params"),
        {
          to: "pollchat:123",
          pollQuestion: "Lunch?",
          pollOption: ["Pizza", "Sushi"],
        },
        "gateway poll params",
      );
      expect(mocks.executePollAction).not.toHaveBeenCalled();
      expect(handleActionLocal).not.toHaveBeenCalled();
      expectRecordFields(
        result,
        {
          kind: "poll",
          channel: "pollchat",
          action: "poll",
          handledBy: "plugin",
        },
        "result",
      );
      expectRecordFields(
        readRecordField(result, "payload", "result payload"),
        {
          ok: true,
          pollId: "gw-poll-1",
        },
        "result payload",
      );
    });
  });
});
