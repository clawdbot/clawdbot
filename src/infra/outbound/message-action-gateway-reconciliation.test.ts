// Covers plugin-dispatched message actions, target resolution, dry-run behavior,
// and plugin tool-result extraction.
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
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { runMessageAction } from "./message-action-runner.js";

type ChannelActionHandler = NonNullable<NonNullable<ChannelPlugin["actions"]>["handleAction"]>;

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
      setTestPlugin(gatewayPlugin, "gatewaychat");
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
      const policySessionKey = "agent:main:gatewaychat:policy:user-123";

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
        sessionKey: policySessionKey,
        sourceReplySessionKey: receipt.sessionKey,
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
      setTestPlugin(gatewayPlugin, "gatewaychat");
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
      setTestPlugin(gatewayPlugin, "gatewaychat");
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
      setTestPlugin(gatewayPlugin, "gatewaychat");
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
      setTestPlugin(gatewayPlugin, "gatewaychat");
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
      setTestPlugin(gatewayPlugin, "gatewaychat");
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
      setTestPlugin(gatewayPlugin, "gatewaychat");
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
      setTestPlugin(gatewayPlugin, "gatewaychat");
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
      setTestPlugin(gatewayPlugin, "gatewaychat");
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
      setTestPlugin(gatewayPlugin, "gatewaychat");
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
      setTestPlugin(gatewayPlugin, "gatewaychat");
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
  });
});
