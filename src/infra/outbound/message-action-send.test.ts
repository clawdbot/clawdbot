// Covers plugin-dispatched message actions, target resolution, dry-run behavior,
// and plugin tool-result extraction.
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../system-events.js";
import {
  createAlwaysConfiguredPluginConfig,
  createActionHubPluginFixture,
  createGatewayActionPlugin,
  messageActionRunnerMocks as mocks,
  resetMessageActionRunnerMocks,
  runMessageAction,
  setMessageActionTestPlugin as setTestPlugin,
} from "./message-action-runner.test-helpers.js";
import {
  createTargetSessionProjectionCoordinator,
  projectHeartbeatMessageToolDeliveries,
} from "./target-session-projection.js";

const sessionAccessorMockState = vi.hoisted(() => ({
  targetEntry: undefined as { sessionId: string; updatedAt: number } | undefined,
}));
const appendAssistantMessageToSessionTranscript = vi.hoisted(() => vi.fn());

vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    loadSessionEntry: (...args: Parameters<typeof actual.loadSessionEntry>) =>
      sessionAccessorMockState.targetEntry ?? actual.loadSessionEntry(...args),
  };
});

vi.mock("../../config/sessions/transcript.runtime.js", () => ({
  appendAssistantMessageToSessionTranscript,
}));

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

describe("runMessageAction plugin dispatch", () => {
  beforeEach(() => {
    resetMessageActionRunnerMocks();
    appendAssistantMessageToSessionTranscript.mockReset();
    sessionAccessorMockState.targetEntry = undefined;
    resetSystemEventsForTest();
  });

  afterEach(() => {
    sessionAccessorMockState.targetEntry = undefined;
    resetSystemEventsForTest();
  });
  describe("alias-based plugin action dispatch", () => {
    const { handleAction, plugin: actionHubPlugin } = createActionHubPluginFixture();

    beforeEach(() => {
      setTestPlugin(actionHubPlugin, "actionhub");
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
      vi.unstubAllEnvs();
    });
    it("preserves the ordinary same-session route and mirror without detached owner detail", async () => {
      const cfg = { channels: { actionhub: { enabled: true } } } as OpenClawConfig;
      const sourceSessionKey = "agent:main:main";
      mocks.prepareOutboundMirrorRoute.mockResolvedValueOnce({
        resolvedThreadId: undefined,
        outboundRoute: {
          sessionKey: sourceSessionKey,
          baseSessionKey: sourceSessionKey,
          recipientSessionExact: true,
          peer: { kind: "direct", id: "operator" },
          chatType: "direct",
          from: "actionhub:operator",
          to: "user:operator",
        },
      });
      mocks.executeSendAction.mockResolvedValueOnce({
        handledBy: "core",
        payload: { ok: true },
        sendResult: { channel: "actionhub", messageId: "same-source-send" },
      });
      const coordinator = createTargetSessionProjectionCoordinator(() => cfg);

      await runMessageAction({
        cfg,
        action: "send",
        params: { channel: "actionhub", target: "operator", message: "Heartbeat reminder." },
        actionOrigin: "message-tool",
        agentId: "main",
        sessionKey: sourceSessionKey,
        sourceReplySessionKey: sourceSessionKey,
        targetSessionProjection: { cfg, readCurrentConfig: () => cfg, coordinator },
        dryRun: false,
      });

      expect(mocks.ensureOutboundSessionEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "main",
          route: expect.objectContaining({ sessionKey: sourceSessionKey }),
        }),
      );
      const executeContext = readRecordField(
        readMockCallArg(mocks.executeSendAction, "execute send call"),
        "ctx",
        "execute send context",
      );
      expect(executeContext.mirror).toMatchObject({
        agentId: "main",
        sessionKey: sourceSessionKey,
        text: "Heartbeat reminder.",
      });
      expect(coordinator.completions.size).toBe(0);
    });

    it.each([
      {
        name: "projects a local Gateway partial-delivery receipt without inventing transcript content",
        connectionTarget: "local" as const,
        projected: 1,
        awareness: [
          [
            "A heartbeat attempted to deliver a message to this channel, but delivery failed.",
            "One or more heartbeat message parts may already have been delivered.",
          ].join("\n"),
        ],
      },
      {
        name: "keeps a remote Gateway partial-delivery receipt out of local session state",
        connectionTarget: "remote" as const,
        projected: 0,
        awareness: [],
      },
    ])("$name", async ({ connectionTarget, projected, awareness }) => {
      const targetSessionKey = "agent:ops:gatewaychat:direct:user-123";
      const route = {
        sessionKey: targetSessionKey,
        baseSessionKey: targetSessionKey,
        recipientSessionExact: true as const,
        peer: { kind: "direct" as const, id: "user-123" },
        chatType: "direct" as const,
        from: "gatewaychat:user-123",
        to: "user-123",
      };
      const cfg = {
        session: {
          store: path.join(os.tmpdir(), "openclaw-message-action-{agentId}.json"),
        },
        channels: { gatewaychat: { enabled: true } },
      } as OpenClawConfig;
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat partial delivery test plugin.",
        actions: ["send"],
        messaging: { targetResolver: { looksLikeId: () => true } },
        handleAction: vi.fn(async () => jsonResult({ ok: true, local: true })),
      });
      setTestPlugin(gatewayPlugin, "gatewaychat");
      mocks.prepareOutboundMirrorRoute.mockResolvedValueOnce({ outboundRoute: route });
      mocks.selectAuthoritativeOutboundTargetSessionRoute.mockReturnValueOnce({
        agentId: "ops",
        route,
        isCurrent: () => true,
      });
      sessionAccessorMockState.targetEntry = {
        sessionId: "target-session",
        updatedAt: 1,
      };
      const partialDeliveryError = new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "media upload failed",
        details: {
          partialDelivery: {
            messageIds: ["caption-message"],
            visibleReplySent: true,
          },
        },
        retryable: false,
      });
      mocks.callGatewayLeastPrivilege.mockRejectedValueOnce(partialDeliveryError);
      const coordinator = createTargetSessionProjectionCoordinator(() => cfg);

      await expect(
        runMessageAction({
          cfg,
          action: "send",
          params: {
            channel: "gatewaychat",
            target: "user-123",
            message: "Caption followed by media.",
          },
          actionOrigin: "message-tool",
          agentId: "main",
          sessionKey: "agent:main:main",
          sourceReplySessionKey: "agent:main:heartbeat:test",
          targetSessionProjection: { cfg, readCurrentConfig: () => cfg, coordinator },
          gateway: {
            connectionTarget,
            clientName: "cli",
            mode: "cli",
          },
          dryRun: false,
        }),
      ).rejects.toBe(partialDeliveryError);

      expect(await projectHeartbeatMessageToolDeliveries({ coordinator })).toEqual({
        projected,
        skipped: 0,
        warnings: 0,
      });
      if (connectionTarget === "local") {
        expect(mocks.bindOutboundSessionEntry).toHaveBeenCalledWith(
          expect.objectContaining({ agentId: "ops", route }),
        );
      } else {
        expect(mocks.bindOutboundSessionEntry).not.toHaveBeenCalled();
      }
      expect(peekSystemEventEntries(targetSessionKey).map((event) => event.text)).toEqual(
        awareness,
      );
      expect(appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
    });

    it.each([
      { name: "raw base64", buffer: "SGVsbG8=" },
      { name: "data URL", buffer: "data:application/octet-stream;base64,SGVsbG8=" },
    ])("preserves $name bytes and MIME for gateway-side materialization", async ({ buffer }) => {
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
          buffer,
          filename: "gateway.txt",
          mimeType: "text/plain",
        },
        gateway: {
          connectionTarget: "local",
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
          buffer,
          filename: "gateway.txt",
          contentType: "text/plain",
        },
        "gateway message params",
      );
      expect(mocks.executeSendAction).not.toHaveBeenCalled();
    });

    it.each([
      { name: "raw base64", buffer: "SGVsbG8=" },
      { name: "data URL", buffer: "data:application/octet-stream;base64,SGVsbG8=" },
    ])("preserves $name bytes and MIME for gateway delivery-mode channels", async ({ buffer }) => {
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
          buffer,
          filename: "delivery.txt",
          mimeType: "text/plain",
        },
        gateway: {
          connectionTarget: "local",
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
          buffer,
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
          connectionTarget: "local",
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
          connectionTarget: "local",
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
          connectionTarget: "local",
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
          connectionTarget: "local",
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
          connectionTarget: "local",
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

    it.each([
      ["model-authored message-tool sends", "message-tool" as const, "caller"],
      ["operator CLI and gateway sends", undefined, undefined],
    ])("marks the delivery retry owner for %s", async (_label, actionOrigin, expected) => {
      const presentation = {
        blocks: [
          {
            type: "chart",
            chartType: "line",
            title: "Trend",
            categories: ["Mon"],
            series: [{ name: "Prod", values: [1] }],
          },
        ],
      };
      mocks.executeSendAction.mockResolvedValueOnce({ handledBy: "core", payload: { ok: true } });
      setTestPlugin(
        {
          ...cardPlugin,
          actions: { ...cardPlugin.actions, resolveExecutionMode: () => "local" },
          outbound: {
            deliveryMode: "direct",
            sendText: async () => ({ channel: "cardchat", messageId: "msg-test" }),
          },
        },
        "cardchat",
      );

      await runMessageAction({
        cfg: { channels: { cardchat: { enabled: true } } } as OpenClawConfig,
        action: "send",
        ...(actionOrigin ? { actionOrigin } : {}),
        params: {
          channel: "cardchat",
          target: "channel:test-card",
          message: "Deployment trend",
          presentation,
        },
        gateway: { clientName: "cli", mode: "cli", connectionTarget: "local" },
        agentId: "main",
        suppressTranscriptMirror: true,
        dryRun: false,
      });

      const executeCall = readMockCallArg(mocks.executeSendAction, "execute send call");
      const executeContext = readRecordField(executeCall, "ctx", "execute send context");
      expect(executeContext.deliveryRetryOwner).toBe(expected);
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
