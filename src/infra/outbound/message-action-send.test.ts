// Covers plugin-dispatched message actions, target resolution, dry-run behavior,
// and plugin tool-result extraction.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
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
import { runMessageAction } from "./message-action-runner.js";

type ChannelActionHandler = NonNullable<NonNullable<ChannelPlugin["actions"]>["handleAction"]>;

const requireRecord = createRequireRecord("record", "expected-non-array-record");
const requireLabeledRecord = createRequireRecord("record", "expected-label");

function readFirstPluginCall(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const [mockCall] = mock.mock.calls;
  const call = mockCall?.[0];
  return requireRecord(call);
}

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
  isCurrentSourceReplyActionName: vi.fn(() => false),
  isDeliveredCurrentSourceReply: vi.fn(() => false),
  isDeliveredCurrentSourceReplyAction: vi.fn(() => false),
  reconcileTerminalSourceReplyDelivery: vi.fn(),
}));

vi.mock("./channel-resolution.js", () => ({
  normalizeDeliverableOutboundChannel: (value?: string | null) =>
    typeof value === "string" ? value.trim().toLowerCase() || undefined : undefined,
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
  isCurrentSourceReplyActionName: mocks.isCurrentSourceReplyActionName,
  isDeliveredCurrentSourceReply: mocks.isDeliveredCurrentSourceReply,
  isDeliveredCurrentSourceReplyAction: mocks.isDeliveredCurrentSourceReplyAction,
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

function setTestPlugin(plugin: unknown, pluginId: string, origin?: "bundled") {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId, source: "test", ...(origin ? { origin } : {}), plugin }]),
  );
}

function createAlwaysConfiguredPluginConfig(account: Record<string, unknown> = { enabled: true }) {
  return {
    listAccountIds: () => ["default"],
    resolveAccount: () => account,
    isConfigured: () => true,
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
      setTestPlugin(gatewayPlugin, "gatewaychat");
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
      setTestPlugin(gatewayDeliveryPlugin, "gatewaydeliver");
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
      setTestPlugin(gatewayPlugin, "gatewaychat");
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
          tts: {
            auto: "tagged",
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
      setTestPlugin(localPlugin, "localchat");
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
          tts: {
            auto: "tagged",
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
  });
  describe("presentation send routing", () => {
    const handleAction = vi.fn(
      async ({ cfg, params }: { cfg: OpenClawConfig; params: Record<string, unknown> }) => {
        const message = typeof params.message === "string" ? params.message : "";
        const responsePrefix = Object.values(cfg.channels ?? {}).find(
          (entry): entry is { responsePrefix?: string } =>
            typeof entry === "object" && entry !== null && "responsePrefix" in entry,
        )?.responsePrefix;
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
      setTestPlugin(cardPlugin, "cardchat");
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

    it("omits a blank shared-schema location from gateway-routed sends", async () => {
      const cfg = {
        channels: {
          cardchat: {
            enabled: true,
          },
        },
        messages: { responsePrefix: "[Nexus]" },
      } as OpenClawConfig;
      mocks.callGatewayLeastPrivilege.mockResolvedValueOnce({
        ok: true,
        messageId: "card-location",
      });

      const result = await runMessageAction({
        cfg,
        action: "send",
        params: {
          channel: "cardchat",
          target: "channel:test-card",
          message: "hello",
          location: "",
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
      const gatewayCall = readMockCallArg(
        mocks.callGatewayLeastPrivilege,
        "gateway least privilege call",
      );
      const gatewayActionParams = readRecordField(
        readRecordField(gatewayCall, "params", "gateway call params"),
        "params",
        "gateway action params",
      );
      expect(gatewayActionParams).not.toHaveProperty("location");
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
      setTestPlugin(
        {
          ...cardPlugin,
          outbound: {
            deliveryMode: "direct",
            sendText: async () => ({ channel: "cardchat", messageId: "msg-test" }),
          },
        },
        "cardchat",
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
      setTestPlugin(
        {
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
        "cardchat",
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
              responsePrefix: "[Nexus]",
            },
          },
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
});
