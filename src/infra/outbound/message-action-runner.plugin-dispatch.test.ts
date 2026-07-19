// Covers plugin-dispatched message actions, target resolution, dry-run behavior,
// and plugin tool-result extraction.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import type {
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
} from "../../interactive/payload.js";
import { extractToolPayload } from "../../plugin-sdk/tool-payload.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { runMessageAction } from "./message-action-runner.js";

type ChannelActionHandler = NonNullable<NonNullable<ChannelPlugin["actions"]>["handleAction"]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readFirstPluginCall(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const [mockCall] = mock.mock.calls;
  const call = mockCall?.[0];
  if (!isRecord(call)) {
    throw new Error("expected plugin action call");
  }
  return call;
}

function readPluginCall(
  mock: { mock: { calls: unknown[][] } },
  callIndex: number,
): Record<string, unknown> {
  const mockCall = mock.mock.calls[callIndex];
  const call = mockCall?.[0];
  if (!isRecord(call)) {
    throw new Error(`expected plugin action call ${callIndex}`);
  }
  return call;
}

function readLastPluginCall(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  return readPluginCall(mock, mock.mock.calls.length - 1);
}

function readMockCallArg(
  mock: { mock: { calls: unknown[][] } },
  label: string,
  callIndex = 0,
  argIndex = 0,
): Record<string, unknown> {
  const mockCall = mock.mock.calls[callIndex];
  const value = mockCall?.[argIndex];
  if (!isRecord(value)) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

function readMediaAccess(call: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(call.mediaAccess)) {
    throw new Error("expected plugin mediaAccess");
  }
  return call.mediaAccess;
}

function readRecordField(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`expected ${label}`);
  }
  return value;
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

const mocks = vi.hoisted(() => ({
  resolveOutboundChannelPlugin: vi.fn(),
  executeSendAction: vi.fn(),
  executePollAction: vi.fn(),
  hasCorePresentationDelivery: vi.fn(),
  materializeMessagePresentationFallback: vi.fn(),
  callGateway: vi.fn(),
  callGatewayLeastPrivilege: vi.fn(),
  isGatewayTransportError: vi.fn(),
  randomIdempotencyKey: vi.fn(() => "idem-gateway-action"),
  maybeApplyTtsToPayload: vi.fn(async (params: { payload: unknown }) => params.payload),
  prepareOutboundMirrorRoute: vi.fn(),
  beginTerminalSourceReplyDelivery: vi.fn(),
  cancelTerminalSourceReplyDelivery: vi.fn(),
  isDeliveredCurrentSourceReply: vi.fn(() => false),
  reconcileTerminalSourceReplyDelivery: vi.fn(),
}));

vi.mock("./channel-resolution.js", () => ({
  resolveOutboundChannelPlugin: mocks.resolveOutboundChannelPlugin,
  resetOutboundChannelResolutionStateForTest: vi.fn(),
}));

vi.mock("./outbound-send-service.js", () => ({
  executeSendAction: mocks.executeSendAction,
  executePollAction: mocks.executePollAction,
  hasCorePresentationDelivery: mocks.hasCorePresentationDelivery,
  materializeMessagePresentationFallback: mocks.materializeMessagePresentationFallback,
}));

vi.mock("./message.gateway.runtime.js", () => ({
  callGateway: mocks.callGateway,
  callGatewayLeastPrivilege: mocks.callGatewayLeastPrivilege,
  isGatewayTransportError: mocks.isGatewayTransportError,
  randomIdempotencyKey: mocks.randomIdempotencyKey,
}));

vi.mock("./source-reply-mirror.js", () => ({
  beginTerminalSourceReplyDelivery: mocks.beginTerminalSourceReplyDelivery,
  cancelTerminalSourceReplyDelivery: mocks.cancelTerminalSourceReplyDelivery,
  isDeliveredCurrentSourceReply: mocks.isDeliveredCurrentSourceReply,
  reconcileTerminalSourceReplyDelivery: mocks.reconcileTerminalSourceReplyDelivery,
}));

vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: mocks.maybeApplyTtsToPayload,
}));

vi.mock("./outbound-session.js", () => ({
  ensureOutboundSessionEntry: vi.fn(async () => undefined),
  resolveOutboundSessionRoute: vi.fn(async () => null),
}));

vi.mock("../../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) =>
    id === "actionhub"
      ? {
          actions: {
            messageActionTargetAliases: {
              pin: { aliases: ["messageId"] },
              unpin: { aliases: ["messageId"] },
              "list-pins": { aliases: ["chatId"] },
            },
          },
        }
      : undefined,
}));

vi.mock("./message-action-threading.js", async () => {
  const { createOutboundThreadingMock } =
    await import("./message-action-threading.test-helpers.js");
  const threading = createOutboundThreadingMock();
  mocks.prepareOutboundMirrorRoute.mockImplementation(threading.prepareOutboundMirrorRoute);
  return {
    ...threading,
    prepareOutboundMirrorRoute: mocks.prepareOutboundMirrorRoute,
  };
});

function createAlwaysConfiguredPluginConfig(account: Record<string, unknown> = { enabled: true }) {
  return {
    listAccountIds: () => ["default"],
    resolveAccount: () => account,
    isConfigured: () => true,
  };
}

function createPollForwardingPlugin(params: {
  pluginId: string;
  label: string;
  blurb: string;
  handleAction: ChannelActionHandler;
}): ChannelPlugin {
  return {
    id: params.pluginId,
    meta: {
      id: params.pluginId,
      label: params.label,
      selectionLabel: params.label,
      docsPath: `/channels/${params.pluginId}`,
      blurb: params.blurb,
    },
    capabilities: { chatTypes: ["direct"] },
    config: createAlwaysConfiguredPluginConfig(),
    messaging: {
      targetResolver: {
        looksLikeId: () => true,
      },
    },
    actions: {
      describeMessageTool: () => ({ actions: ["poll"] }),
      supportsAction: ({ action }) => action === "poll",
      handleAction: params.handleAction,
    },
  };
}

function createGatewayActionPlugin(params: {
  pluginId: string;
  label: string;
  blurb: string;
  actions: ChannelMessageActionName[];
  gatewayActions?: ChannelMessageActionName[];
  capabilities?: ChannelPlugin["capabilities"];
  messaging?: ChannelPlugin["messaging"];
  threading?: ChannelPlugin["threading"];
  handleAction: ChannelActionHandler;
}): ChannelPlugin {
  const actions = new Set(params.actions);
  const gatewayActions = new Set(params.gatewayActions ?? params.actions);
  return {
    id: params.pluginId,
    meta: {
      id: params.pluginId,
      label: params.label,
      selectionLabel: params.label,
      docsPath: `/channels/${params.pluginId}`,
      blurb: params.blurb,
    },
    capabilities: params.capabilities ?? { chatTypes: ["direct"] },
    config: createAlwaysConfiguredPluginConfig(),
    messaging: params.messaging,
    threading: params.threading,
    actions: {
      describeMessageTool: () => ({ actions: params.actions }),
      supportsAction: ({ action }) => actions.has(action),
      resolveExecutionMode: ({ action }) => (gatewayActions.has(action) ? "gateway" : "local"),
      handleAction: params.handleAction,
    },
  };
}

async function executePluginAction(params: {
  action: "send" | "poll";
  ctx: Pick<
    ChannelMessageActionContext,
    | "channel"
    | "cfg"
    | "params"
    | "mediaAccess"
    | "accountId"
    | "gateway"
    | "toolContext"
    | "inboundEventKind"
  > & {
    dryRun: boolean;
    agentId?: string;
  };
}) {
  const handled = await dispatchChannelMessageAction({
    channel: params.ctx.channel,
    action: params.action,
    cfg: params.ctx.cfg,
    params: params.ctx.params,
    mediaAccess: params.ctx.mediaAccess,
    mediaLocalRoots: params.ctx.mediaAccess?.localRoots ?? [],
    mediaReadFile:
      typeof params.ctx.mediaAccess?.readFile === "function"
        ? params.ctx.mediaAccess.readFile
        : undefined,
    accountId: params.ctx.accountId ?? undefined,
    gateway: params.ctx.gateway,
    toolContext: params.ctx.toolContext,
    inboundEventKind: params.ctx.inboundEventKind,
    dryRun: params.ctx.dryRun,
    agentId: params.ctx.agentId,
  });
  if (!handled) {
    throw new Error(`expected plugin to handle ${params.action}`);
  }
  return {
    handledBy: "plugin" as const,
    payload: extractToolPayload(handled),
    toolResult: handled,
  };
}

describe("runMessageAction plugin dispatch", () => {
  beforeEach(() => {
    mocks.resolveOutboundChannelPlugin.mockReset();
    mocks.resolveOutboundChannelPlugin.mockImplementation(
      ({ channel }: { channel: string }) =>
        getActivePluginRegistry()?.channels.find((entry) => entry?.plugin?.id === channel)?.plugin,
    );
    mocks.executeSendAction.mockReset();
    mocks.executeSendAction.mockImplementation(
      async ({ ctx }: { ctx: Parameters<typeof executePluginAction>[0]["ctx"] }) =>
        await executePluginAction({ action: "send", ctx }),
    );
    mocks.executePollAction.mockReset();
    mocks.executePollAction.mockImplementation(
      async ({ ctx }: { ctx: Parameters<typeof executePluginAction>[0]["ctx"] }) =>
        await executePluginAction({ action: "poll", ctx }),
    );
    mocks.hasCorePresentationDelivery.mockReset();
    mocks.hasCorePresentationDelivery.mockImplementation(
      (outbound?: { sendPayload?: unknown; sendText?: unknown; sendFormattedText?: unknown }) =>
        Boolean(outbound?.sendPayload || outbound?.sendText || outbound?.sendFormattedText),
    );
    mocks.materializeMessagePresentationFallback.mockReset();
    mocks.materializeMessagePresentationFallback.mockImplementation(
      (params: { payload: { presentation?: unknown; text?: string }; text?: string }) => {
        const presentation = normalizeMessagePresentation(params.payload.presentation);
        const text = (params.text ?? params.payload.text ?? "").trim();
        if (!presentation) {
          return text;
        }
        const fallback = renderMessagePresentationFallbackText({ presentation });
        return !fallback || text.includes(fallback)
          ? text
          : [text, fallback].filter(Boolean).join("\n\n");
      },
    );
    mocks.callGateway.mockReset();
    mocks.callGatewayLeastPrivilege.mockReset();
    mocks.isGatewayTransportError.mockReset();
    mocks.isGatewayTransportError.mockImplementation(
      (value: unknown) =>
        value instanceof Error && (value as { kind?: unknown }).kind === "timeout",
    );
    mocks.randomIdempotencyKey.mockClear();
    mocks.maybeApplyTtsToPayload.mockReset();
    mocks.maybeApplyTtsToPayload.mockImplementation(
      async (params: { payload: unknown }) => params.payload,
    );
    mocks.prepareOutboundMirrorRoute.mockClear();
    mocks.beginTerminalSourceReplyDelivery.mockReset();
    mocks.cancelTerminalSourceReplyDelivery.mockReset();
    mocks.reconcileTerminalSourceReplyDelivery.mockReset();
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
          actions: ["pin", "list-pins", "member-info", "channel-info", "edit"],
        }),
        messageActionTargetAliases: {
          edit: { aliases: ["messageId"], deliveryTargetAliases: [] },
        },
        supportsAction: ({ action }) =>
          action === "pin" ||
          action === "list-pins" ||
          action === "member-info" ||
          action === "channel-info" ||
          action === "edit",
        handleAction,
      },
    };

    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "actionhub",
            source: "test",
            plugin: actionHubPlugin,
          },
        ]),
      );
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
      vi.unstubAllEnvs();
    });

    it("dispatches messageId/chatId-based plugin actions through the shared runner", async () => {
      const resolveAgentRuntimeIdentityToken = vi.fn(async () => "unused-agent-runtime-token");
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
          messageId: "om_123",
        },
        gateway: {
          resolveAgentRuntimeIdentityToken,
          clientName: "gateway-client",
          mode: "backend",
        },
        conversationReadOrigin: "direct-operator",
        dryRun: false,
      });

      await runMessageAction({
        cfg: {
          channels: {
            actionhub: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "list-pins",
        params: {
          channel: "actionhub",
          chatId: "oc_123",
        },
        conversationReadOrigin: "direct-operator",
        dryRun: false,
      });

      const pinCall = readPluginCall(handleAction, 0);
      expectRecordFields(
        pinCall,
        { action: "pin", conversationReadOrigin: "direct-operator" },
        "pin call",
      );
      expectRecordFields(
        readRecordField(pinCall, "params", "pin call params"),
        { messageId: "om_123" },
        "pin call params",
      );
      const listPinsCall = readPluginCall(handleAction, 1);
      expectRecordFields(listPinsCall, { action: "list-pins" }, "list pins call");
      expectRecordFields(
        readRecordField(listPinsCall, "params", "list pins call params"),
        { chatId: "oc_123" },
        "list pins call params",
      );
      expect(resolveAgentRuntimeIdentityToken).not.toHaveBeenCalled();
    });

    it("infers the trusted current target for resource-referenced edits", async () => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "actionhub",
            source: "test",
            origin: "bundled",
            plugin: actionHubPlugin,
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

    it("rejects unsupported read actions before conversation authorization", async () => {
      await expect(
        runMessageAction({
          cfg: {
            channels: {
              actionhub: {
                enabled: true,
              },
            },
          } as OpenClawConfig,
          action: "react",
          params: {
            channel: "actionhub",
            target: "other-conversation",
            messageId: "om_123",
            emoji: "eyes",
          },
          conversationReadOrigin: "delegated",
          dryRun: false,
        }),
      ).rejects.toThrow("Message action react not supported for channel actionhub.");
      expect(handleAction).not.toHaveBeenCalled();
    });

    it("routes execution context ids into plugin handleAction", async () => {
      const stateDir = path.join("/tmp", "openclaw-plugin-dispatch-media-roots");
      const expectedWorkspaceRoot = path.resolve(stateDir, "workspace-alpha");

      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
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
            messageId: "om_123",
          },
          defaultAccountId: "ops",
          requesterAccountId: "ops",
          requesterSenderId: "trusted-user",
          conversationReadOrigin: "direct-operator",
          sessionKey: "agent:alpha:main",
          sessionId: "session-123",
          agentId: "alpha",
          inboundEventKind: "room_event",
          toolContext: {
            currentChannelId: "oc_123",
            currentChannelProvider: "actionhub",
            currentThreadTs: "thread-456",
            currentMessageId: "msg-789",
          },
          dryRun: false,
        });

        const call = readLastPluginCall(handleAction);
        expectRecordFields(
          call,
          {
            action: "pin",
            accountId: "ops",
            requesterAccountId: "ops",
            requesterSenderId: "trusted-user",
            conversationReadOrigin: "direct-operator",
            sessionKey: "agent:alpha:main",
            sessionId: "session-123",
            inboundEventKind: "room_event",
            agentId: "alpha",
          },
          "plugin action call",
        );
        expect(Array.isArray(call.mediaLocalRoots)).toBe(true);
        expect((call.mediaLocalRoots as unknown[]).includes(expectedWorkspaceRoot)).toBe(true);
        expectRecordFields(
          readRecordField(call, "toolContext", "plugin tool context"),
          {
            currentChannelId: "oc_123",
            currentChannelProvider: "actionhub",
            currentThreadTs: "thread-456",
            currentMessageId: "msg-789",
          },
          "plugin tool context",
        );
      });
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

      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "discord",
            source: "test",
            origin: "bundled",
            plugin: discordPlugin,
          },
        ]),
      );

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

    it("routes gateway-executed plugin actions through gateway RPC instead of local dispatch", async () => {
      const handleActionEntry = vi.fn(async () =>
        jsonResult({
          ok: true,
          local: true,
        }),
      );
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat reaction test plugin.",
        actions: ["react"],
        capabilities: { chatTypes: ["direct"], reactions: true },
        handleAction: handleActionEntry,
      });
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "gatewaychat",
            source: "test",
            plugin: gatewayPlugin,
          },
        ]),
      );
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
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "gatewaychat",
            source: "test",
            plugin: gatewayPlugin,
          },
        ]),
      );
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
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "gatewaychat",
            source: "test",
            plugin: gatewayPlugin,
          },
        ]),
      );
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
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "gatewaychat",
            source: "test",
            plugin: gatewayPlugin,
          },
        ]),
      );
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
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "gatewaychat",
            source: "test",
            plugin: gatewayPlugin,
          },
        ]),
      );
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
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "gatewaychat", source: "test", plugin: gatewayPlugin }]),
      );
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

    it("owns terminal source-reply receipts before dispatching to a remote gateway", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat remote source reply test plugin.",
        actions: ["send"],
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        handleAction: vi.fn(async () => jsonResult({ ok: true, local: true })),
      });
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "gatewaychat",
            source: "test",
            plugin: gatewayPlugin,
          },
        ]),
      );
      const receipt = {
        sessionId: "session-1",
        sessionKey: "agent:main:gatewaychat:direct:user-123",
        sourceTurnId: "source-turn-1",
        storePath: "/tmp/sessions.json",
        toolCallId: "message-call-1",
      };
      mocks.beginTerminalSourceReplyDelivery.mockResolvedValue(receipt);
      mocks.reconcileTerminalSourceReplyDelivery.mockResolvedValue("delivered");
      const deliveredPayload = { ok: true, messageId: "gw-send-1" };
      mocks.callGatewayLeastPrivilege.mockResolvedValue(deliveredPayload);
      const resolveAgentRuntimeIdentityToken = vi.fn(async () => undefined);

      await runMessageAction({
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
          message: "terminal answer",
        },
        messageActionAuthorization: {
          toolContext: {
            currentChannelProvider: "gatewaychat",
            currentChannelId: "user-123",
            currentSourceTurnId: "source-turn-1",
          },
        },
        sourceReplyDeliveryMode: "message_tool_only",
        sourceReplyFinal: true,
        sourceReplyToolCallId: "message-call-1",
        sessionKey: receipt.sessionKey,
        sessionId: receipt.sessionId,
        agentId: "main",
        gateway: {
          resolveAgentRuntimeIdentityToken,
          terminalSourceReplyReceiptOwner: "caller",
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
        },
        dryRun: false,
      });

      expect(mocks.beginTerminalSourceReplyDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "send",
          channel: "gatewaychat",
          idempotencyKey: "idem-gateway-action",
          sessionId: receipt.sessionId,
          sessionKey: receipt.sessionKey,
          sourceReplyFinal: true,
          toolCallId: receipt.toolCallId,
          toolContext: expect.objectContaining({ currentSourceTurnId: "source-turn-1" }),
        }),
      );
      expect(mocks.beginTerminalSourceReplyDelivery.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.callGatewayLeastPrivilege.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      expect(resolveAgentRuntimeIdentityToken).toHaveBeenCalledWith({
        sourceReplyFinal: true,
        sourceReplyToolCallId: "message-call-1",
      });
      expect(mocks.reconcileTerminalSourceReplyDelivery).toHaveBeenCalledWith({
        deliveredPayload,
        mirror: expect.objectContaining({
          idempotencyKey: "idem-gateway-action",
          sourceReplyFinal: true,
          toolCallId: "message-call-1",
        }),
        receipt,
      });
    });

    it("allows claimless remote terminal dispatch when no receipt applies", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat missing receipt test plugin.",
        actions: ["send"],
        messaging: { targetResolver: { looksLikeId: () => true } },
        handleAction: vi.fn(async () => jsonResult({ ok: true, local: true })),
      });
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "gatewaychat", source: "test", plugin: gatewayPlugin }]),
      );
      mocks.beginTerminalSourceReplyDelivery.mockResolvedValue(undefined);
      mocks.reconcileTerminalSourceReplyDelivery.mockResolvedValue("not-applicable");
      mocks.callGatewayLeastPrivilege.mockResolvedValue({
        ok: true,
        messageId: "gw-send-claimless",
      });

      await runMessageAction({
        cfg: { channels: { gatewaychat: { enabled: true } } } as OpenClawConfig,
        action: "send",
        params: { channel: "gatewaychat", target: "user-123", message: "terminal answer" },
        sourceReplyFinal: true,
        sourceReplyToolCallId: "message-call-1",
        gateway: {
          terminalSourceReplyReceiptOwner: "caller",
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
        },
        dryRun: false,
      });

      expect(mocks.callGatewayLeastPrivilege).toHaveBeenCalledOnce();
      expect(mocks.reconcileTerminalSourceReplyDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ receipt: undefined }),
      );
    });

    it("cancels caller receipts after confirmed gateway request rejection", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat rejected request test plugin.",
        actions: ["send"],
        messaging: { targetResolver: { looksLikeId: () => true } },
        handleAction: vi.fn(async () => jsonResult({ ok: true, local: true })),
      });
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "gatewaychat", source: "test", plugin: gatewayPlugin }]),
      );
      const receipt = {
        sessionId: "session-1",
        sessionKey: "agent:main:gatewaychat:direct:user-123",
        sourceTurnId: "source-turn-1",
        storePath: "/tmp/sessions.json",
        toolCallId: "message-call-1",
      };
      mocks.beginTerminalSourceReplyDelivery.mockResolvedValue(receipt);
      const rejection = Object.assign(new Error("unsupported message action"), {
        name: "GatewayClientRequestError",
        gatewayCode: "FORBIDDEN",
        retryable: false,
      });
      mocks.callGatewayLeastPrivilege.mockRejectedValue(rejection);

      await expect(
        runMessageAction({
          cfg: { channels: { gatewaychat: { enabled: true } } } as OpenClawConfig,
          action: "send",
          params: { channel: "gatewaychat", target: "user-123", message: "terminal answer" },
          sourceReplyFinal: true,
          sourceReplyToolCallId: receipt.toolCallId,
          gateway: {
            terminalSourceReplyReceiptOwner: "caller",
            clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
            mode: GATEWAY_CLIENT_MODES.BACKEND,
          },
          dryRun: false,
        }),
      ).rejects.toBe(rejection);
      expect(mocks.cancelTerminalSourceReplyDelivery).toHaveBeenCalledWith(receipt);
      expect(mocks.reconcileTerminalSourceReplyDelivery).not.toHaveBeenCalled();
    });

    it("cancels caller receipts after structured gateway startup rejection", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat startup rejection test plugin.",
        actions: ["send"],
        messaging: { targetResolver: { looksLikeId: () => true } },
        handleAction: vi.fn(async () => jsonResult({ ok: true, local: true })),
      });
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "gatewaychat", source: "test", plugin: gatewayPlugin }]),
      );
      const receipt = {
        sessionId: "session-1",
        sessionKey: "agent:main:gatewaychat:direct:user-123",
        sourceTurnId: "source-turn-1",
        storePath: "/tmp/sessions.json",
        toolCallId: "message-call-1",
      };
      mocks.beginTerminalSourceReplyDelivery.mockResolvedValue(receipt);
      const rejection = Object.assign(new Error("gateway is still starting"), {
        name: "GatewayClientRequestError",
        gatewayCode: "UNAVAILABLE",
        details: { method: "message.action", reason: "gateway-starting" },
        retryable: true,
      });
      mocks.callGatewayLeastPrivilege.mockRejectedValue(rejection);

      await expect(
        runMessageAction({
          cfg: { channels: { gatewaychat: { enabled: true } } } as OpenClawConfig,
          action: "send",
          params: { channel: "gatewaychat", target: "user-123", message: "terminal answer" },
          sourceReplyFinal: true,
          sourceReplyToolCallId: receipt.toolCallId,
          gateway: {
            terminalSourceReplyReceiptOwner: "caller",
            clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
            mode: GATEWAY_CLIENT_MODES.BACKEND,
          },
          dryRun: false,
        }),
      ).rejects.toBe(rejection);
      expect(mocks.cancelTerminalSourceReplyDelivery).toHaveBeenCalledWith(receipt);
    });

    it("keeps caller receipts pending after unstructured provider unavailability", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat provider failure test plugin.",
        actions: ["send"],
        messaging: { targetResolver: { looksLikeId: () => true } },
        handleAction: vi.fn(async () => jsonResult({ ok: true, local: true })),
      });
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "gatewaychat", source: "test", plugin: gatewayPlugin }]),
      );
      mocks.beginTerminalSourceReplyDelivery.mockResolvedValue({
        sessionId: "session-1",
        sessionKey: "agent:main:gatewaychat:direct:user-123",
        sourceTurnId: "source-turn-1",
        storePath: "/tmp/sessions.json",
        toolCallId: "message-call-1",
      });
      const rejection = Object.assign(new Error("provider failed"), {
        name: "GatewayClientRequestError",
        gatewayCode: "UNAVAILABLE",
        retryable: false,
      });
      mocks.callGatewayLeastPrivilege.mockRejectedValue(rejection);

      await expect(
        runMessageAction({
          cfg: { channels: { gatewaychat: { enabled: true } } } as OpenClawConfig,
          action: "send",
          params: { channel: "gatewaychat", target: "user-123", message: "terminal answer" },
          sourceReplyFinal: true,
          sourceReplyToolCallId: "message-call-1",
          gateway: {
            terminalSourceReplyReceiptOwner: "caller",
            clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
            mode: GATEWAY_CLIENT_MODES.BACKEND,
          },
          dryRun: false,
        }),
      ).rejects.toBe(rejection);
      expect(mocks.cancelTerminalSourceReplyDelivery).not.toHaveBeenCalled();
    });

    it("keeps caller receipts pending when reattach ends in a confirmed rejection", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat ambiguous reattach rejection test plugin.",
        actions: ["send"],
        messaging: { targetResolver: { looksLikeId: () => true } },
        handleAction: vi.fn(async () => jsonResult({ ok: true, local: true })),
      });
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "gatewaychat", source: "test", plugin: gatewayPlugin }]),
      );
      const receipt = {
        sessionId: "session-1",
        sessionKey: "agent:main:gatewaychat:direct:user-123",
        sourceTurnId: "source-turn-1",
        storePath: "/tmp/sessions.json",
        toolCallId: "message-call-1",
      };
      mocks.beginTerminalSourceReplyDelivery.mockResolvedValue(receipt);
      const timeout = Object.assign(new Error("gateway timeout"), {
        name: "GatewayTransportError",
        kind: "timeout",
      });
      const rejection = Object.assign(new Error("gateway is still starting"), {
        name: "GatewayClientRequestError",
        gatewayCode: "UNAVAILABLE",
        details: { method: "message.action", reason: "gateway-starting" },
        retryable: true,
      });
      mocks.callGatewayLeastPrivilege
        .mockRejectedValueOnce(timeout)
        .mockRejectedValueOnce(rejection);

      await expect(
        runMessageAction({
          cfg: { channels: { gatewaychat: { enabled: true } } } as OpenClawConfig,
          action: "send",
          params: { channel: "gatewaychat", target: "user-123", message: "terminal answer" },
          sourceReplyFinal: true,
          sourceReplyToolCallId: receipt.toolCallId,
          gateway: {
            terminalSourceReplyReceiptOwner: "caller",
            clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
            mode: GATEWAY_CLIENT_MODES.BACKEND,
          },
          dryRun: false,
        }),
      ).rejects.toBe(rejection);

      expect(mocks.callGatewayLeastPrivilege).toHaveBeenCalledTimes(2);
      expect(mocks.cancelTerminalSourceReplyDelivery).not.toHaveBeenCalled();
      expect(mocks.reconcileTerminalSourceReplyDelivery).not.toHaveBeenCalled();
    });

    it("preserves caller receipts when reattach returns an explicit failure", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat ambiguous reattach result test plugin.",
        actions: ["send"],
        messaging: { targetResolver: { looksLikeId: () => true } },
        handleAction: vi.fn(async () => jsonResult({ ok: true, local: true })),
      });
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "gatewaychat", source: "test", plugin: gatewayPlugin }]),
      );
      const receipt = {
        sessionId: "session-1",
        sessionKey: "agent:main:gatewaychat:direct:user-123",
        sourceTurnId: "source-turn-1",
        storePath: "/tmp/sessions.json",
        toolCallId: "message-call-1",
      };
      mocks.beginTerminalSourceReplyDelivery.mockResolvedValue(receipt);
      const timeout = Object.assign(new Error("gateway timeout"), {
        name: "GatewayTransportError",
        kind: "timeout",
      });
      const failedPayload = { ok: false, status: "failed" };
      mocks.callGatewayLeastPrivilege
        .mockRejectedValueOnce(timeout)
        .mockResolvedValueOnce(failedPayload);

      await runMessageAction({
        cfg: { channels: { gatewaychat: { enabled: true } } } as OpenClawConfig,
        action: "send",
        params: { channel: "gatewaychat", target: "user-123", message: "terminal answer" },
        sourceReplyFinal: true,
        sourceReplyToolCallId: receipt.toolCallId,
        gateway: {
          terminalSourceReplyReceiptOwner: "caller",
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          mode: GATEWAY_CLIENT_MODES.BACKEND,
        },
        dryRun: false,
      });

      expect(mocks.callGatewayLeastPrivilege).toHaveBeenCalledTimes(2);
      expect(mocks.reconcileTerminalSourceReplyDelivery).toHaveBeenCalledWith({
        deliveredPayload: failedPayload,
        mirror: expect.objectContaining({ toolCallId: receipt.toolCallId }),
        preservePendingOnExplicitFailure: true,
        receipt,
      });
      expect(mocks.cancelTerminalSourceReplyDelivery).not.toHaveBeenCalled();
    });

    it("runs terminal gateway identity preflight before arming the caller receipt", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat identity preflight test plugin.",
        actions: ["send"],
        messaging: { targetResolver: { looksLikeId: () => true } },
        handleAction: vi.fn(async () => jsonResult({ ok: true, local: true })),
      });
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "gatewaychat", source: "test", plugin: gatewayPlugin }]),
      );
      const rejection = new Error("terminal source reply requires an active turn capability");
      const resolveAgentRuntimeIdentityToken = vi.fn(async () => {
        throw rejection;
      });

      await expect(
        runMessageAction({
          cfg: { channels: { gatewaychat: { enabled: true } } } as OpenClawConfig,
          action: "send",
          params: { channel: "gatewaychat", target: "user-123", message: "terminal answer" },
          sourceReplyFinal: true,
          sourceReplyToolCallId: "message-call-1",
          gateway: {
            resolveAgentRuntimeIdentityToken,
            terminalSourceReplyReceiptOwner: "caller",
            clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
            mode: GATEWAY_CLIENT_MODES.BACKEND,
          },
          dryRun: false,
        }),
      ).rejects.toBe(rejection);
      expect(mocks.beginTerminalSourceReplyDelivery).not.toHaveBeenCalled();
      expect(mocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
    });

    it("keeps caller receipts pending after an ambiguous gateway timeout", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat ambiguous timeout test plugin.",
        actions: ["send"],
        messaging: { targetResolver: { looksLikeId: () => true } },
        handleAction: vi.fn(async () => jsonResult({ ok: true, local: true })),
      });
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "gatewaychat", source: "test", plugin: gatewayPlugin }]),
      );
      const receipt = {
        sessionId: "session-1",
        sessionKey: "agent:main:gatewaychat:direct:user-123",
        sourceTurnId: "source-turn-1",
        storePath: "/tmp/sessions.json",
        toolCallId: "message-call-1",
      };
      mocks.beginTerminalSourceReplyDelivery.mockResolvedValue(receipt);
      const timeout = Object.assign(new Error("gateway timeout"), { kind: "timeout" });
      mocks.callGatewayLeastPrivilege.mockRejectedValue(timeout);

      await expect(
        runMessageAction({
          cfg: { channels: { gatewaychat: { enabled: true } } } as OpenClawConfig,
          action: "send",
          params: { channel: "gatewaychat", target: "user-123", message: "terminal answer" },
          sourceReplyFinal: true,
          sourceReplyToolCallId: receipt.toolCallId,
          gateway: {
            terminalSourceReplyReceiptOwner: "caller",
            clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
            mode: GATEWAY_CLIENT_MODES.BACKEND,
          },
          dryRun: false,
        }),
      ).rejects.toBe(timeout);
      expect(mocks.callGatewayLeastPrivilege).toHaveBeenCalledTimes(2);
      expect(mocks.cancelTerminalSourceReplyDelivery).not.toHaveBeenCalled();
    });

    it("reattaches a timed-out gateway send once with the original idempotency key", async () => {
      const handleActionResult = vi.fn(async () => jsonResult({ ok: true, local: true }));
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat timeout reconciliation test plugin.",
        actions: ["send"],
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        handleAction: handleActionResult,
      });
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "gatewaychat",
            source: "test",
            plugin: gatewayPlugin,
          },
        ]),
      );
      const timeout = Object.assign(new Error("gateway timeout after 30000ms"), {
        name: "GatewayTransportError",
        kind: "timeout",
      });
      mocks.callGatewayLeastPrivilege
        .mockRejectedValueOnce(timeout)
        .mockResolvedValueOnce({ ok: true, messageId: "gw-send-late" });
      const controller = new AbortController();

      const actionInput = {
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
          message: "hello from agent",
        },
        gateway: {
          clientName: "cli",
          mode: "cli",
          timeoutMs: 120_000,
        },
        dryRun: false,
      } satisfies Parameters<typeof runMessageAction>[0];
      const result = await runMessageAction({ ...actionInput, abortSignal: controller.signal });

      expect(mocks.callGatewayLeastPrivilege).toHaveBeenCalledTimes(2);
      const firstCall = readMockCallArg(
        mocks.callGatewayLeastPrivilege,
        "first gateway least privilege call",
      );
      const secondCall = readMockCallArg(
        mocks.callGatewayLeastPrivilege,
        "second gateway least privilege call",
        1,
      );
      expect(firstCall.timeoutMs).toBe(30_000);
      expect(secondCall).toMatchObject({
        ...firstCall,
        timeoutMs: null,
        signal: expect.any(AbortSignal),
      });
      expect(secondCall.signal).toBeInstanceOf(AbortSignal);
      expect(secondCall.signal).not.toBe(firstCall.signal);
      const gatewayParams = readRecordField(firstCall, "params", "gateway call params");
      expectRecordFields(
        gatewayParams,
        {
          channel: "gatewaychat",
          action: "send",
          idempotencyKey: "idem-gateway-action",
        },
        "gateway call params",
      );
      expect(handleActionResult).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        kind: "send",
        channel: "gatewaychat",
        action: "send",
        handledBy: "plugin",
        payload: { ok: true, messageId: "gw-send-late" },
      });

      mocks.callGatewayLeastPrivilege.mockReset();
      mocks.callGatewayLeastPrivilege
        .mockRejectedValueOnce(timeout)
        .mockResolvedValueOnce({ ok: true, messageId: "gw-send-bounded" });

      const boundedResult = await runMessageAction(actionInput);

      expect(mocks.callGatewayLeastPrivilege).toHaveBeenCalledTimes(2);
      const boundedReconciliationCall = readMockCallArg(
        mocks.callGatewayLeastPrivilege,
        "bounded gateway reconciliation call",
        1,
      );
      expect(boundedReconciliationCall).toMatchObject({ timeoutMs: 60_000, signal: undefined });
      const boundedParams = readRecordField(
        boundedReconciliationCall,
        "params",
        "bounded gateway reconciliation params",
      );
      expect(boundedParams.idempotencyKey).toBe("idem-gateway-action");
      expect(boundedResult).toMatchObject({
        kind: "send",
        payload: { ok: true, messageId: "gw-send-bounded" },
      });
    });

    it("does not reconnect a timed-out gateway send after cancellation", async () => {
      const handleActionResult = vi.fn(async () => jsonResult({ ok: true, local: true }));
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat cancellation test plugin.",
        actions: ["send"],
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        handleAction: handleActionResult,
      });
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "gatewaychat",
            source: "test",
            plugin: gatewayPlugin,
          },
        ]),
      );
      const controller = new AbortController();
      const timeout = Object.assign(new Error("gateway timeout after 30000ms"), {
        name: "GatewayTransportError",
        kind: "timeout",
      });
      mocks.callGatewayLeastPrivilege
        .mockRejectedValueOnce(timeout)
        .mockImplementationOnce(async (call: { signal?: AbortSignal }) => {
          controller.abort();
          expect(call.signal?.aborted).toBe(true);
          throw Object.assign(new Error("gateway request aborted"), { name: "AbortError" });
        });

      await expect(
        runMessageAction({
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
            message: "hello from agent",
          },
          gateway: {
            clientName: "cli",
            mode: "cli",
          },
          abortSignal: controller.signal,
          dryRun: false,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });

      expect(mocks.callGatewayLeastPrivilege).toHaveBeenCalledTimes(2);
      expect(handleActionResult).not.toHaveBeenCalled();
    });

    it("preserves gateway send receipts in broadcast results", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat broadcast test plugin.",
        actions: ["send"],
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        handleAction: vi.fn(async () => jsonResult({ ok: true })),
      });
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "gatewaychat",
            source: "test",
            plugin: gatewayPlugin,
          },
        ]),
      );
      mocks.callGatewayLeastPrivilege.mockResolvedValue({
        ok: true,
        messageId: "gw-broadcast-1",
      });

      const result = await runMessageAction({
        cfg: {
          channels: {
            gatewaychat: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "broadcast",
        params: {
          channel: "gatewaychat",
          targets: ["user-123"],
          message: "hello from broadcast",
        },
        gateway: {
          clientName: "cli",
          mode: "cli",
        },
      });

      expect(result).toMatchObject({
        kind: "broadcast",
        payload: {
          results: [
            {
              channel: "gatewaychat",
              to: "user-123",
              ok: true,
              payload: {
                ok: true,
                messageId: "gw-broadcast-1",
              },
            },
          ],
        },
      });
      expect(mocks.executeSendAction).not.toHaveBeenCalled();
    });

    it("preserves partial-delivery evidence from failed broadcast sends", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat partial broadcast test plugin.",
        actions: ["send"],
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        handleAction: vi.fn(async () => jsonResult({ ok: true })),
      });
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "gatewaychat",
            source: "test",
            plugin: gatewayPlugin,
          },
        ]),
      );
      mocks.callGatewayLeastPrivilege.mockRejectedValue(
        Object.assign(new Error("second payload failed"), { sentBeforeError: true }),
      );

      const result = await runMessageAction({
        cfg: {
          channels: {
            gatewaychat: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "broadcast",
        params: {
          channel: "gatewaychat",
          targets: ["user-123"],
          message: "hello from broadcast",
        },
        gateway: {
          clientName: "cli",
          mode: "cli",
        },
      });

      expect(result).toMatchObject({
        kind: "broadcast",
        payload: {
          results: [
            {
              channel: "gatewaychat",
              to: "user-123",
              ok: false,
              sentBeforeError: true,
              error: "second payload failed",
            },
          ],
        },
      });
    });

    it("preserves buffer-only send bytes for gateway-side materialization", async () => {
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
        handleAction: vi.fn(async () => jsonResult({ ok: true })),
      });
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "gatewaychat",
            source: "test",
            plugin: gatewayPlugin,
          },
        ]),
      );
      mocks.callGatewayLeastPrivilege.mockResolvedValue({
        ok: true,
        messageId: "gw-send-buffer",
      });

      await runMessageAction({
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
          buffer: Buffer.from("gateway bytes").toString("base64"),
          filename: "gateway.txt",
          contentType: "text/plain",
        },
        gateway: {
          clientName: "cli",
          mode: "cli",
        },
      });

      const gatewayCall = readMockCallArg(
        mocks.callGatewayLeastPrivilege,
        "gateway least privilege call",
      );
      const gatewayParams = readRecordField(gatewayCall, "params", "gateway call params");
      expectRecordFields(
        readRecordField(gatewayParams, "params", "gateway message params"),
        {
          to: "user-123",
          media: "buffer://message-send/attachment",
          mediaUrl: "buffer://message-send/attachment",
          mediaUrls: ["buffer://message-send/attachment"],
          buffer: Buffer.from("gateway bytes").toString("base64"),
          filename: "gateway.txt",
          contentType: "text/plain",
        },
        "gateway message params",
      );
      expect(mocks.executeSendAction).not.toHaveBeenCalled();
    });

    it("preserves buffer-only send bytes for gateway delivery-mode channels", async () => {
      const gatewayDeliveryPlugin: ChannelPlugin = {
        id: "gatewaydeliver",
        meta: {
          id: "gatewaydeliver",
          label: "Gateway Deliver",
          selectionLabel: "Gateway Deliver",
          docsPath: "/channels/gatewaydeliver",
          blurb: "Gateway delivery-mode send test plugin.",
        },
        capabilities: { chatTypes: ["direct"] },
        config: createAlwaysConfiguredPluginConfig(),
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        outbound: { deliveryMode: "gateway" },
      };
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "gatewaydeliver",
            source: "test",
            plugin: gatewayDeliveryPlugin,
          },
        ]),
      );
      mocks.executeSendAction.mockResolvedValueOnce({
        handledBy: "core",
        payload: { ok: true },
        sendResult: {
          channel: "gatewaydeliver",
          to: "user-123",
          via: "gateway",
          mediaUrl: "buffer://message-send/attachment",
        },
      });

      await runMessageAction({
        cfg: {
          channels: {
            gatewaydeliver: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "gatewaydeliver",
          target: "user-123",
          buffer: Buffer.from("gateway delivery bytes").toString("base64"),
          filename: "delivery.txt",
          contentType: "text/plain",
        },
        gateway: {
          clientName: "cli",
          mode: "cli",
        },
      });

      const executeCall = readMockCallArg(mocks.executeSendAction, "execute send call");
      expectRecordFields(
        executeCall,
        {
          mediaUrl: "buffer://message-send/attachment",
          mediaUrls: ["buffer://message-send/attachment"],
          buffer: Buffer.from("gateway delivery bytes").toString("base64"),
          filename: "delivery.txt",
          contentType: "text/plain",
        },
        "execute send call",
      );
    });

    it("applies TTS before gateway-executed plugin sends", async () => {
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
        handleAction: vi.fn(async () => jsonResult({ ok: true, local: true })),
      });
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "gatewaychat",
            source: "test",
            plugin: gatewayPlugin,
          },
        ]),
      );
      mocks.callGatewayLeastPrivilege.mockResolvedValue({
        ok: true,
        messageId: "gw-send-tts",
      });
      mocks.maybeApplyTtsToPayload.mockResolvedValueOnce({
        mediaUrl: "file:///tmp/openclaw-voice.ogg",
        audioAsVoice: true,
        spokenText: "hello there",
      });

      await runMessageAction({
        cfg: {
          channels: {
            gatewaychat: {
              enabled: true,
            },
          },
          messages: {
            tts: {
              auto: "tagged",
            },
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "gatewaychat",
          target: "user-123",
          message: "[[tts:text]]hello there[[/tts:text]]",
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
      const gatewayParams = readRecordField(gatewayCall, "params", "gateway call params");
      expectRecordFields(
        readRecordField(gatewayParams, "params", "gateway message params"),
        {
          message: "",
          media: "file:///tmp/openclaw-voice.ogg",
          mediaUrl: "file:///tmp/openclaw-voice.ogg",
          asVoice: true,
          audioAsVoice: true,
        },
        "gateway message params",
      );
      expect(mocks.executeSendAction).not.toHaveBeenCalled();
    });

    it("applies TTS before local plugin send fallback dispatch", async () => {
      const handleActionValue = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
        jsonResult({ ok: true, params }),
      );
      const localPlugin = createGatewayActionPlugin({
        pluginId: "localchat",
        label: "Local Chat",
        blurb: "Local Chat send test plugin.",
        actions: ["send"],
        gatewayActions: [],
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        handleAction: handleActionValue,
      });
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "localchat",
            source: "test",
            plugin: localPlugin,
          },
        ]),
      );
      mocks.maybeApplyTtsToPayload.mockResolvedValueOnce({
        mediaUrl: "file:///tmp/openclaw-voice.ogg",
        audioAsVoice: true,
        spokenText: "hello there",
      });

      await runMessageAction({
        cfg: {
          channels: {
            localchat: {
              enabled: true,
            },
          },
          messages: {
            tts: {
              auto: "tagged",
            },
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "localchat",
          target: "user-123",
          message: "[[tts:text]]hello there[[/tts:text]]",
        },
        dryRun: false,
      });

      const call = readFirstPluginCall(handleActionValue);
      expectRecordFields(
        readRecordField(call, "params", "local plugin params"),
        {
          message: "",
          media: "file:///tmp/openclaw-voice.ogg",
          mediaUrl: "file:///tmp/openclaw-voice.ogg",
          asVoice: true,
          audioAsVoice: true,
        },
        "local plugin params",
      );
    });

    it("uses requester session channel policy for host-media reads", async () => {
      const handlePolicyCheckedAction = vi.fn(async ({ mediaAccess }) =>
        jsonResult({
          ok: true,
          hasHostReadCapability: typeof mediaAccess?.readFile === "function",
        }),
      );
      const policyPlugin: ChannelPlugin = {
        id: "policydest",
        meta: {
          id: "policydest",
          label: "Policy Destination",
          selectionLabel: "Policy Destination",
          docsPath: "/channels/policydest",
          blurb: "Policy destination test plugin.",
        },
        capabilities: { chatTypes: ["direct", "channel"], media: true },
        config: createAlwaysConfiguredPluginConfig(),
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        actions: {
          describeMessageTool: () => ({ actions: ["send"] }),
          supportsAction: ({ action }) => action === "send",
          handleAction: handlePolicyCheckedAction,
        },
      };

      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "policydest",
            source: "test",
            plugin: policyPlugin,
          },
        ]),
      );

      await runMessageAction({
        cfg: {
          tools: { allow: ["read"] },
          channels: {
            policydest: {
              enabled: true,
            },
            requestchat: {
              groups: {
                ops: {
                  toolsBySender: {
                    "id:trusted-user": {
                      deny: ["read"],
                    },
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "policydest",
          target: "oc_123",
          message: "hello",
          media: "/tmp/host.png",
        },
        requesterSenderId: "trusted-user",
        sessionKey: "agent:alpha:requestchat:group:ops",
        dryRun: false,
      });

      const mediaAccess = readMediaAccess(readFirstPluginCall(handlePolicyCheckedAction));
      expect(mediaAccess.readFile).toBeUndefined();
    });

    it("uses requester username policy for host-media reads", async () => {
      const handlePolicyCheckedAction = vi.fn(async ({ mediaAccess }) =>
        jsonResult({
          ok: true,
          hasHostReadCapability: typeof mediaAccess?.readFile === "function",
        }),
      );
      const policyPlugin: ChannelPlugin = {
        id: "policydest",
        meta: {
          id: "policydest",
          label: "Policy Destination",
          selectionLabel: "Policy Destination",
          docsPath: "/channels/policydest",
          blurb: "Policy destination username test plugin.",
        },
        capabilities: { chatTypes: ["direct", "channel"], media: true },
        config: createAlwaysConfiguredPluginConfig(),
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        actions: {
          describeMessageTool: () => ({ actions: ["send"] }),
          supportsAction: ({ action }) => action === "send",
          handleAction: handlePolicyCheckedAction,
        },
      };

      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "policydest",
            source: "test",
            plugin: policyPlugin,
          },
        ]),
      );

      await runMessageAction({
        cfg: {
          tools: { allow: ["read"] },
          channels: {
            policydest: {
              enabled: true,
            },
            requestchat: {
              groups: {
                ops: {
                  toolsBySender: {
                    "username:alice_u": {
                      deny: ["read"],
                    },
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "policydest",
          target: "oc_123",
          message: "hello",
          media: "/tmp/host.png",
        },
        requesterSenderUsername: "alice_u",
        sessionKey: "agent:alpha:requestchat:group:ops",
        dryRun: false,
      });

      const mediaAccess = readMediaAccess(readFirstPluginCall(handlePolicyCheckedAction));
      expect(mediaAccess.readFile).toBeUndefined();
    });

    it("uses requester account policy for host-media reads when destination account differs", async () => {
      const handlePolicyCheckedAction = vi.fn(async ({ mediaAccess }) =>
        jsonResult({
          ok: true,
          hasHostReadCapability: typeof mediaAccess?.readFile === "function",
        }),
      );
      const policyPlugin: ChannelPlugin = {
        id: "policydest",
        meta: {
          id: "policydest",
          label: "Policy Destination",
          selectionLabel: "Policy Destination",
          docsPath: "/channels/policydest",
          blurb: "Policy destination account test plugin.",
        },
        capabilities: { chatTypes: ["direct", "channel"], media: true },
        config: createAlwaysConfiguredPluginConfig(),
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        actions: {
          describeMessageTool: () => ({ actions: ["send"] }),
          supportsAction: ({ action }) => action === "send",
          handleAction: handlePolicyCheckedAction,
        },
      };

      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "policydest",
            source: "test",
            plugin: policyPlugin,
          },
        ]),
      );

      await runMessageAction({
        cfg: {
          tools: { allow: ["read"] },
          channels: {
            policydest: {
              enabled: true,
            },
            requestchat: {
              accounts: {
                source: {
                  groups: {
                    ops: {
                      toolsBySender: {
                        "id:trusted-user": {
                          deny: ["read"],
                        },
                      },
                    },
                  },
                },
                destination: {
                  groups: {
                    ops: {
                      toolsBySender: {
                        "id:trusted-user": {
                          allow: ["read"],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "policydest",
          accountId: "destination",
          target: "oc_123",
          message: "hello",
          media: "/tmp/host.png",
        },
        requesterAccountId: "source",
        requesterSenderId: "trusted-user",
        sessionKey: "agent:alpha:requestchat:group:ops",
        dryRun: false,
      });

      const pluginCall = readFirstPluginCall(handlePolicyCheckedAction);
      expect(pluginCall.accountId).toBe("destination");
      const mediaAccess = readMediaAccess(pluginCall);
      expect(mediaAccess.readFile).toBeUndefined();
    });

    it("falls back to the resolved account policy when requester account is unavailable", async () => {
      const handlePolicyCheckedAction = vi.fn(async ({ mediaAccess }) =>
        jsonResult({
          ok: true,
          hasHostReadCapability: typeof mediaAccess?.readFile === "function",
        }),
      );
      const policyPlugin: ChannelPlugin = {
        id: "policychat",
        meta: {
          id: "policychat",
          label: "Policy Chat",
          selectionLabel: "Policy Chat",
          docsPath: "/channels/policychat",
          blurb: "Policy chat account fallback test plugin.",
        },
        capabilities: { chatTypes: ["direct", "channel"], media: true },
        config: createAlwaysConfiguredPluginConfig(),
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        actions: {
          describeMessageTool: () => ({ actions: ["send"] }),
          supportsAction: ({ action }) => action === "send",
          handleAction: handlePolicyCheckedAction,
        },
      };

      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "policychat",
            source: "test",
            plugin: policyPlugin,
          },
        ]),
      );

      await runMessageAction({
        cfg: {
          tools: { allow: ["read"] },
          channels: {
            policychat: {
              enabled: true,
              accounts: {
                source: {
                  groups: {
                    ops: {
                      toolsBySender: {
                        "id:trusted-user": {
                          deny: ["read"],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "policychat",
          accountId: "source",
          target: "group:ops",
          message: "hello",
          media: "/tmp/host.png",
        },
        requesterSenderId: "trusted-user",
        sessionKey: "agent:alpha:policychat:group:ops",
        dryRun: false,
      });

      const pluginCall = readFirstPluginCall(handlePolicyCheckedAction);
      expect(pluginCall.accountId).toBe("source");
      const mediaAccess = readMediaAccess(pluginCall);
      expect(mediaAccess.readFile).toBeUndefined();
    });
  });

  describe("threaded plugin actions", () => {
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({ ok: true, params }),
    );
    const cfg = { channels: { forumchat: { enabled: true } } } as OpenClawConfig;
    const threading: ChannelPlugin["threading"] = {
      resolveAutoThreadId: ({ toolContext, to }) =>
        toolContext?.currentChannelId === to ? toolContext.currentThreadTs : undefined,
    };
    const createThreadedPlugin = (executionMode: "local" | "gateway") =>
      createGatewayActionPlugin({
        pluginId: "forumchat",
        label: "Forum Chat",
        blurb: "Forum chat threaded action dispatch test plugin.",
        actions: ["sticker"],
        gatewayActions: executionMode === "gateway" ? ["sticker"] : [],
        capabilities: { chatTypes: ["channel"] },
        threading,
        handleAction,
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
      });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it.each(["local", "gateway"] as const)(
      "applies auto threadId before %s plugin dispatch",
      async (executionMode) => {
        setActivePluginRegistry(
          createTestRegistry([
            {
              pluginId: "forumchat",
              source: "test",
              plugin: createThreadedPlugin(executionMode),
            },
          ]),
        );
        mocks.callGatewayLeastPrivilege.mockResolvedValue({ ok: true });

        await runMessageAction({
          cfg,
          action: "sticker",
          params: {
            channel: "forumchat",
            target: "forum:123",
            stickerName: "wave",
          },
          toolContext: {
            currentChannelProvider: "forumchat",
            currentChannelId: "forum:123",
            currentThreadTs: "42",
          },
          gateway: executionMode === "gateway" ? { clientName: "cli", mode: "cli" } : undefined,
          dryRun: false,
        });

        const dispatchedParams =
          executionMode === "gateway"
            ? readRecordField(
                readRecordField(
                  readMockCallArg(mocks.callGatewayLeastPrivilege, "gateway call"),
                  "params",
                  "gateway call params",
                ),
                "params",
                "gateway action params",
              )
            : readRecordField(readFirstPluginCall(handleAction), "params", "plugin params");
        expectRecordFields(
          dispatchedParams,
          { to: "forum:123", threadId: "42" },
          `${executionMode} action params`,
        );
        expect(handleAction).toHaveBeenCalledTimes(executionMode === "local" ? 1 : 0);
      },
    );
  });

  describe("presentation send routing", () => {
    const handleAction = vi.fn(
      async ({ cfg, params }: { cfg: OpenClawConfig; params: Record<string, unknown> }) => {
        const message = typeof params.message === "string" ? params.message : "";
        const responsePrefix = cfg.messages?.responsePrefix;
        const rawMessage =
          responsePrefix && message.startsWith(`${responsePrefix} `)
            ? message.slice(responsePrefix.length + 1)
            : message;
        let detectedCard = false;
        try {
          detectedCard = isRecord((JSON.parse(rawMessage) as { body?: unknown }).body);
        } catch {
          // Non-JSON text remains a normal plugin message.
        }
        return jsonResult({
          ok: true,
          presentation: params.presentation ?? null,
          message: params.message ?? null,
          detectedCard,
        });
      },
    );

    const cardPlugin: ChannelPlugin = {
      id: "cardchat",
      meta: {
        id: "cardchat",
        label: "Card Chat",
        selectionLabel: "Card Chat",
        docsPath: "/channels/cardchat",
        blurb: "Card-only send test plugin.",
      },
      capabilities: { chatTypes: ["direct"] },
      config: createAlwaysConfiguredPluginConfig(),
      actions: {
        describeMessageTool: () => ({ actions: ["send"], capabilities: ["presentation"] }),
        supportsAction: ({ action }) => action === "send",
        resolveExecutionMode: ({ action }) => (action === "send" ? "gateway" : "local"),
        handleAction,
      },
    };

    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "cardchat",
            source: "test",
            plugin: cardPlugin,
          },
        ]),
      );
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it("keeps presentation-only sends on action-only gateway plugins", async () => {
      const cfg = {
        channels: {
          cardchat: {
            enabled: true,
          },
        },
      } as OpenClawConfig;

      const presentation = {
        blocks: [{ type: "text", text: "Presentation-only payload" }],
      };
      mocks.callGatewayLeastPrivilege.mockResolvedValueOnce({ ok: true, messageId: "card-1" });

      const result = await runMessageAction({
        cfg,
        action: "send",
        params: {
          channel: "cardchat",
          target: "channel:test-card",
          presentation,
        },
        gateway: {
          clientName: "cli",
          mode: "cli",
        },
        dryRun: false,
      });

      expect(result.kind).toBe("send");
      expect(result.handledBy).toBe("plugin");
      expect(handleAction).not.toHaveBeenCalled();
      expect(mocks.executeSendAction).not.toHaveBeenCalled();
      const gatewayCall = readMockCallArg(
        mocks.callGatewayLeastPrivilege,
        "gateway least privilege call",
      );
      const gatewayActionParams = readRecordField(
        readRecordField(gatewayCall, "params", "gateway call params"),
        "params",
        "gateway action params",
      );
      expect(gatewayActionParams).not.toHaveProperty("message");
      expectRecordFields(gatewayActionParams, { presentation }, "gateway action params");
    });

    it("keeps gateway-routed chart presentations on the gateway", async () => {
      const presentation = {
        blocks: [
          {
            type: "chart",
            chartType: "line",
            title: "Deployments",
            categories: ["Mon", "Tue"],
            series: [{ name: "Production", values: [2, 3] }],
          },
        ],
      };
      mocks.callGatewayLeastPrivilege.mockResolvedValueOnce({ ok: true, messageId: "card-2" });
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "cardchat",
            source: "test",
            plugin: {
              ...cardPlugin,
              outbound: {
                deliveryMode: "direct",
                sendText: async () => ({ channel: "cardchat", messageId: "msg-test" }),
              },
            },
          },
        ]),
      );

      const result = await runMessageAction({
        cfg: {
          channels: {
            cardchat: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "cardchat",
          target: "channel:test-card",
          message: "Deployment trend",
          presentation,
        },
        gateway: {
          clientName: "cli",
          mode: "cli",
        },
        dryRun: false,
      });

      expect(result.kind).toBe("send");
      expect(result.handledBy).toBe("plugin");
      expect(handleAction).not.toHaveBeenCalled();
      expect(mocks.executeSendAction).not.toHaveBeenCalled();
      const gatewayCall = readMockCallArg(
        mocks.callGatewayLeastPrivilege,
        "gateway least privilege call",
      );
      expectRecordFields(
        readRecordField(
          readRecordField(gatewayCall, "params", "gateway call params"),
          "params",
          "gateway action params",
        ),
        { message: "Deployment trend", presentation },
        "gateway action params",
      );
    });

    it("routes local chart presentations through core delivery", async () => {
      const presentation = {
        blocks: [
          {
            type: "chart",
            chartType: "line",
            title: "Deployments",
            categories: ["Mon", "Tue"],
            series: [{ name: "Production", values: [2, 3] }],
          },
        ],
      };
      mocks.executeSendAction.mockResolvedValueOnce({
        handledBy: "core",
        payload: { ok: true },
      });
      mocks.prepareOutboundMirrorRoute.mockResolvedValueOnce({
        resolvedThreadId: undefined,
        outboundRoute: {
          sessionKey: "agent:main:cardchat:channel:test-card",
          baseSessionKey: "agent:main:cardchat:channel:test-card",
          peer: { kind: "channel", id: "test-card" },
          chatType: "channel",
          from: "cardchat:channel:test-card",
          to: "channel:test-card",
        },
      });
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "cardchat",
            source: "test",
            plugin: {
              ...cardPlugin,
              actions: {
                ...cardPlugin.actions,
                resolveExecutionMode: () => "local",
              },
              outbound: {
                deliveryMode: "direct",
                sendText: async () => ({ channel: "cardchat", messageId: "msg-test" }),
              },
            },
          },
        ]),
      );

      const result = await runMessageAction({
        cfg: {
          channels: {
            cardchat: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "cardchat",
          target: "channel:test-card",
          message: "Deployment trend",
          presentation,
        },
        gateway: {
          clientName: "cli",
          mode: "cli",
        },
        agentId: "main",
        suppressTranscriptMirror: true,
        dryRun: false,
      });

      expect(result.kind).toBe("send");
      expect(result.handledBy).toBe("core");
      expect(handleAction).not.toHaveBeenCalled();
      expect(mocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
      const executeCall = readMockCallArg(mocks.executeSendAction, "execute send call");
      expectRecordFields(executeCall, { message: "Deployment trend" }, "execute send call");
      const executeContext = readRecordField(executeCall, "ctx", "execute send context");
      expectRecordFields(executeContext, { conversationType: "channel" }, "execute send context");
      expect(executeContext.mirror).toBeUndefined();
      expectRecordFields(
        readRecordField(executeCall, "payload", "execute send payload"),
        { text: "Deployment trend", presentation },
        "execute send payload",
      );
    });

    it("keeps non-presentation sends on plugin-owned handling", async () => {
      const cardJson = JSON.stringify({
        body: {
          elements: [{ tag: "markdown", content: "Card body" }],
        },
      });
      const result = await runMessageAction({
        cfg: {
          channels: {
            cardchat: {
              enabled: true,
            },
          },
          messages: { responsePrefix: "[Nexus]" },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "cardchat",
          target: "channel:test-card",
          message: cardJson,
        },
        dryRun: false,
      });

      expect(result.kind).toBe("send");
      expect(result.handledBy).toBe("plugin");
      expectRecordFields(
        readRecordField(result, "payload", "result payload"),
        {
          ok: true,
          detectedCard: true,
        },
        "result payload",
      );
      const pluginParams = readRecordField(readFirstPluginCall(handleAction), "params", "params");
      expect(pluginParams.message).toBe(`[Nexus] ${cardJson}`);
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
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "pollchat",
            source: "test",
            plugin: pollChatPlugin,
          },
        ]),
      );
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it("forwards poll params through plugin dispatch", async () => {
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
          pollDurationSeconds: 120,
          pollPublic: true,
          threadId: "42",
        },
        dryRun: false,
      });

      expect(result.kind).toBe("poll");
      expect(result.handledBy).toBe("plugin");
      const pluginCall = readFirstPluginCall(handleAction);
      expectRecordFields(
        pluginCall,
        {
          action: "poll",
          channel: "pollchat",
        },
        "plugin call",
      );
      expectRecordFields(
        readRecordField(pluginCall, "params", "plugin params"),
        {
          to: "pollchat:123",
          pollQuestion: "Lunch?",
          pollOption: ["Pizza", "Sushi"],
          pollDurationSeconds: 120,
          pollPublic: true,
          threadId: "42",
        },
        "plugin params",
      );
      expectRecordFields(
        readRecordField(result, "payload", "result payload"),
        {
          ok: true,
          forwarded: {
            to: "pollchat:123",
            pollQuestion: "Lunch?",
            pollOption: ["Pizza", "Sushi"],
            pollDurationSeconds: 120,
            pollPublic: true,
            threadId: "42",
          },
        },
        "result payload",
      );
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
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "pollchat",
            source: "test",
            plugin: pollGatewayPlugin,
          },
        ]),
      );
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

  describe("plugin-owned poll semantics", () => {
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({
        ok: true,
        forwarded: {
          to: params.to ?? null,
          pollQuestion: params.pollQuestion ?? null,
          pollOption: params.pollOption ?? null,
          pollDurationSeconds: params.pollDurationSeconds ?? null,
          pollPublic: params.pollPublic ?? null,
        },
      }),
    );

    const guildPollPlugin = createPollForwardingPlugin({
      pluginId: "guildchat",
      label: "Guild Chat",
      blurb: "Guild chat plugin-owned poll test plugin.",
      handleAction,
    });

    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "guildchat",
            source: "test",
            plugin: guildPollPlugin,
          },
        ]),
      );
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it("lets other plugins own extra poll fields", async () => {
      const result = await runMessageAction({
        cfg: {
          channels: {
            guildchat: {
              token: "tok",
            },
          },
        } as OpenClawConfig,
        action: "poll",
        params: {
          channel: "guildchat",
          target: "channel:123",
          pollQuestion: "Lunch?",
          pollOption: ["Pizza", "Sushi"],
          pollDurationSeconds: 120,
          pollPublic: true,
        },
        dryRun: false,
      });

      expect(result.kind).toBe("poll");
      expect(result.handledBy).toBe("plugin");
      const pluginCall = readFirstPluginCall(handleAction);
      expectRecordFields(
        pluginCall,
        {
          action: "poll",
          channel: "guildchat",
        },
        "plugin call",
      );
      expectRecordFields(
        readRecordField(pluginCall, "params", "plugin params"),
        {
          to: "channel:123",
          pollQuestion: "Lunch?",
          pollOption: ["Pizza", "Sushi"],
          pollDurationSeconds: 120,
          pollPublic: true,
        },
        "plugin params",
      );
    });
  });

  describe("presentation parsing", () => {
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({
        ok: true,
        presentation: params.presentation ?? null,
      }),
    );

    const componentsPlugin: ChannelPlugin = {
      id: "componentchat",
      meta: {
        id: "componentchat",
        label: "Component Chat",
        selectionLabel: "Component Chat",
        docsPath: "/channels/componentchat",
        blurb: "Component chat send test plugin.",
      },
      capabilities: { chatTypes: ["direct"] },
      config: createAlwaysConfiguredPluginConfig({}),
      actions: {
        describeMessageTool: () => ({ actions: ["send"], capabilities: ["presentation"] }),
        supportsAction: ({ action }) => action === "send",
        handleAction,
      },
    };

    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "componentchat",
            source: "test",
            plugin: componentsPlugin,
          },
        ]),
      );
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it("parses presentation JSON strings before plugin dispatch", async () => {
      const presentation = {
        blocks: [{ type: "buttons", buttons: [{ label: "A", value: "a" }] }],
      };
      const result = await runMessageAction({
        cfg: {} as OpenClawConfig,
        action: "send",
        params: {
          channel: "componentchat",
          target: "channel:123",
          message: "hi",
          presentation: JSON.stringify(presentation),
        },
        dryRun: false,
      });

      expect(result.kind).toBe("send");
      expect(handleAction).toHaveBeenCalled();
      expectRecordFields(
        readRecordField(result, "payload", "result payload"),
        {
          ok: true,
          presentation,
        },
        "result payload",
      );
    });

    it("throws on invalid presentation JSON strings", async () => {
      await expect(
        runMessageAction({
          cfg: {} as OpenClawConfig,
          action: "send",
          params: {
            channel: "componentchat",
            target: "channel:123",
            message: "hi",
            presentation: "{not-json}",
          },
          dryRun: false,
        }),
      ).rejects.toThrow(/--presentation must be valid JSON/);

      expect(handleAction).not.toHaveBeenCalled();
    });
  });

  describe("accountId defaults", () => {
    const handleAction = vi.fn(async () => jsonResult({ ok: true }));
    const accountPlugin: ChannelPlugin = {
      id: "accountchat",
      meta: {
        id: "accountchat",
        label: "Account Chat",
        selectionLabel: "Account Chat",
        docsPath: "/channels/accountchat",
        blurb: "Account chat test plugin.",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({}),
      },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        handleAction,
      },
    };

    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "accountchat",
            source: "test",
            plugin: accountPlugin,
          },
        ]),
      );
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it.each([
      {
        name: "uses defaultAccountId override",
        args: {
          cfg: {} as OpenClawConfig,
          defaultAccountId: "ops",
        },
        expectedAccountId: "ops",
      },
      {
        name: "falls back to agent binding account",
        args: {
          cfg: {
            bindings: [
              { agentId: "agent-b", match: { channel: "accountchat", accountId: "account-b" } },
            ],
          } as OpenClawConfig,
          agentId: "agent-b",
        },
        expectedAccountId: "account-b",
      },
      {
        name: "prefers the account bound to the target peer",
        args: {
          cfg: {
            bindings: [
              {
                agentId: "agent-b",
                match: {
                  channel: "accountchat",
                  accountId: "wrong-peer",
                  peer: { kind: "channel", id: "C_OTHER" },
                },
              },
              {
                agentId: "agent-b",
                match: {
                  channel: "accountchat",
                  accountId: "account-peer",
                  peer: { kind: "channel", id: "C_TARGET" },
                },
              },
              {
                agentId: "agent-b",
                match: { channel: "accountchat", accountId: "agent-fallback" },
              },
            ],
          } as OpenClawConfig,
          agentId: "agent-b",
          target: "channel:C_TARGET",
        },
        expectedAccountId: "account-peer",
      },
    ])("$name", async ({ args, expectedAccountId }) => {
      await runMessageAction({
        ...args,
        action: "send",
        params: {
          channel: "accountchat",
          target: "target" in args ? args.target : "channel:123",
          message: "hi",
        },
      });

      expect(handleAction).toHaveBeenCalled();
      const ctx = (handleAction.mock.calls as unknown as Array<[unknown]>)[0]?.[0] as
        | {
            accountId?: string | null;
            params: Record<string, unknown>;
          }
        | undefined;
      if (!ctx) {
        throw new Error("expected action context");
      }
      expect(ctx.accountId).toBe(expectedAccountId);
      expect(ctx.params.accountId).toBe(expectedAccountId);
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
