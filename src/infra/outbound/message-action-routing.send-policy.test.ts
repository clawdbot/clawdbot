// Covers core message-action send fallback, TTS application, and durable send
// policy after plugin preparation is absent.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";

const ttsMocks = vi.hoisted(() => ({
  maybeApplyTtsToPayload: vi.fn(async (params: { payload: unknown }) => params.payload),
}));

vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: ttsMocks.maybeApplyTtsToPayload,
}));

function firstMockArg(
  mock: { mock: { calls: readonly unknown[][] } },
  label: string,
): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  const [arg] = call;
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    throw new Error(`expected ${label} input to be an object`);
  }
  return arg as Record<string, unknown>;
}

const slackConfig = {
  channels: {
    slack: {
      enabled: true,
    },
  },
} as OpenClawConfig;

function registerSlackTextPlugin(accountIds: string[] = ["default"]) {
  const sendText = vi.fn().mockResolvedValue({
    channel: "slack",
    messageId: "m1",
    chatId: "C123",
  });
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "slack",
        source: "test",
        plugin: {
          ...createOutboundTestPlugin({
            id: "slack",
            outbound: {
              deliveryMode: "direct",
              sendText,
            },
          }),
          config: {
            listAccountIds: () => accountIds,
            resolveAccount: () => ({ enabled: true }),
            isConfigured: () => true,
          },
          threading: { threadAddressing: "message" },
        },
      },
    ]),
  );
  return sendText;
}

describe("runMessageAction core send routing", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    ttsMocks.maybeApplyTtsToPayload
      .mockReset()
      .mockImplementation(async (params: { payload: unknown }) => params.payload);
  });
  it("accepts Telegram numeric forum topic targets through plugin-owned grammar", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "telegram",
            outbound: {
              deliveryMode: "direct",
              sendText: vi.fn(),
            },
            messaging: {
              normalizeTarget: (raw) =>
                raw === "-1001234567890:topic:42" ? "telegram:-1001234567890:topic:42" : undefined,
              targetResolver: {
                looksLikeId: (raw) => raw === "-1001234567890:topic:42",
              },
            },
          }),
        },
      ]),
    );

    const result = await runMessageAction({
      cfg: {
        channels: {
          telegram: {
            botToken: "123:test",
          },
        },
      } as OpenClawConfig,
      action: "send",
      params: {
        channel: "telegram",
        target: "-1001234567890:topic:42",
        message: "topic hello",
      },
      dryRun: true,
    });

    if (result.kind !== "send") {
      throw new Error(`Expected send result, got ${result.kind}`);
    }
    const payload = result.payload as { dryRun?: boolean; to?: string };
    expect(result.to).toBe("telegram:-1001234567890:topic:42");
    expect(payload.to).toBe("telegram:-1001234567890:topic:42");
    expect(payload.dryRun).toBe(true);
  });

  it("uses best-effort delivery for implicit message-tool-only source replies", async () => {
    const sendText = registerSlackTextPlugin();

    const result = await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        message: "visible source reply",
        bestEffort: false,
      },
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "channel:C123",
      },
      sessionKey: "agent:main:slack:channel:C123",
      sourceReplyDeliveryMode: "message_tool_only",
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect(sendText).toHaveBeenCalledOnce();
  });

  it.each([
    "agent:main:subagent:worker",
    "agent:main:cron:job:run:turn",
    "channel:agent:main:main",
  ])(
    "rejects implicit delivery to internal session %s before sending",
    async (currentChannelId) => {
      const sendText = registerSlackTextPlugin();

      await expect(
        runMessageAction({
          cfg: slackConfig,
          action: "send",
          params: {
            channel: "slack",
            message: "do not deliver to a session key",
          },
          toolContext: {
            currentChannelProvider: "slack",
            currentChannelId,
          },
          sessionKey: "agent:main:subagent:worker",
          dryRun: false,
        }),
      ).rejects.toThrow(/requires a target/i);

      expect(sendText).not.toHaveBeenCalled();
    },
  );

  it("delivers to a real current conversation instead of an internal session channel", async () => {
    const sendText = registerSlackTextPlugin();

    const result = await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        channel: "slack",
        message: "deliver to the actual conversation",
      },
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "agent:main:subagent:worker",
        currentMessagingTarget: "channel:C123",
      },
      sessionKey: "agent:main:subagent:worker",
      dryRun: false,
    });

    expect(result).toMatchObject({
      kind: "send",
      channel: "slack",
      to: "channel:C123",
    });
    expect(firstMockArg(sendText, "send text")).toMatchObject({
      to: "channel:C123",
      text: "deliver to the actual conversation",
    });
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("uses best-effort delivery for explicit current-source message-tool-only replies", async () => {
    const sendText = registerSlackTextPlugin();

    const result = await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        target: "channel:C123",
        message: "visible current-channel source reply",
        bestEffort: false,
      },
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "channel:C123",
      },
      sessionKey: "agent:main:slack:channel:C123",
      sourceReplyDeliveryMode: "message_tool_only",
      dryRun: false,
    });

    if (result.kind !== "send") {
      throw new Error(`expected send result, got ${result.kind}`);
    }
    expect(sendText).toHaveBeenCalledOnce();
    expect(result.to).toBe("channel:C123");
  });

  it("preserves required delivery when message-tool-only sends target another conversation", async () => {
    const sendText = registerSlackTextPlugin();

    await expect(
      runMessageAction({
        cfg: slackConfig,
        action: "send",
        params: {
          target: "channel:C999",
          message: "explicit durable send",
          bestEffort: false,
        },
        toolContext: {
          currentChannelProvider: "slack",
          currentChannelId: "channel:C123",
        },
        sessionKey: "agent:main:slack:channel:C123",
        sourceReplyDeliveryMode: "message_tool_only",
        dryRun: false,
      }),
    ).rejects.toThrow("missing reconcileUnknownSend");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("preserves required delivery when message-tool-only sends to another explicit channel", async () => {
    const sendText = vi.fn().mockResolvedValue({
      channel: "telegram",
      messageId: "m1",
      chatId: "C999",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "telegram",
            outbound: {
              deliveryMode: "direct",
              sendText,
            },
          }),
        },
      ]),
    );

    await expect(
      runMessageAction({
        cfg: {
          channels: {
            telegram: {
              enabled: true,
            },
          },
          tools: {
            message: {
              crossContext: {
                allowAcrossProviders: true,
              },
            },
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "telegram",
          message: "explicit channel-only durable send",
          bestEffort: false,
        },
        toolContext: {
          currentChannelProvider: "slack",
          currentChannelId: "channel:C123",
        },
        sessionKey: "agent:main:slack:channel:C123",
        sourceReplyDeliveryMode: "message_tool_only",
        dryRun: false,
      }),
    ).rejects.toThrow("missing reconcileUnknownSend");
    expect(sendText).not.toHaveBeenCalled();
  });
});
