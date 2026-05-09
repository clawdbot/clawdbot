import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChannelMessagingAdapter,
  ChannelPlugin,
  ChannelThreadingAdapter,
} from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(),
}));

vi.mock("../../infra/outbound/deliver-runtime.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
}));

const { routeReply } = await import("./route-reply.js");

function compileSlackInteractiveRepliesForTest(
  payload: Parameters<NonNullable<ChannelMessagingAdapter["transformReplyPayload"]>>[0]["payload"],
) {
  const text = payload.text ?? "";
  if (!text.includes("[[slack_select:") && !text.includes("[[slack_buttons:")) {
    return payload;
  }
  return {
    ...payload,
    channelData: {
      ...payload.channelData,
      slack: {
        ...(payload.channelData?.slack as Record<string, unknown> | undefined),
        blocks: [{ type: "section", text }],
      },
    },
  };
}

const slackMessaging: ChannelMessagingAdapter = {
  transformReplyPayload: ({ payload, cfg }) =>
    (cfg.channels?.slack as { capabilities?: { interactiveReplies?: boolean } } | undefined)
      ?.capabilities?.interactiveReplies === true
      ? compileSlackInteractiveRepliesForTest(payload)
      : payload,
  enableInteractiveReplies: ({ cfg }) =>
    (cfg.channels?.slack as { capabilities?: { interactiveReplies?: boolean } } | undefined)
      ?.capabilities?.interactiveReplies === true,
  hasStructuredReplyPayload: ({ payload }) => {
    const blocks = (payload.channelData?.slack as { blocks?: unknown } | undefined)?.blocks;
    if (typeof blocks === "string") {
      return blocks.trim().length > 0;
    }
    return Array.isArray(blocks) && blocks.length > 0;
  },
};

const slackThreading: ChannelThreadingAdapter = {
  resolveReplyTransport: ({ threadId, replyToId }) => ({
    replyToId: resolveSlackThreadTsCandidate(replyToId) ?? resolveSlackThreadTsCandidate(threadId),
    threadId: null,
  }),
};

function resolveSlackThreadTsCandidate(value?: string | number | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return /^\d+\.\d+$/.test(normalized) ? normalized : undefined;
}

const mattermostThreading: ChannelThreadingAdapter = {
  resolveReplyTransport: ({ threadId, replyToId }) => ({
    replyToId: replyToId ?? (threadId != null && threadId !== "" ? String(threadId) : undefined),
    threadId,
  }),
};

function createChannelPlugin(
  id: ChannelPlugin["id"],
  options: {
    messaging?: ChannelMessagingAdapter;
    threading?: ChannelThreadingAdapter;
    label?: string;
  } = {},
): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      id,
      label: options.label ?? String(id),
      config: { listAccountIds: () => [], resolveAccount: () => ({}) },
    }),
    ...(options.messaging ? { messaging: options.messaging } : {}),
    ...(options.threading ? { threading: options.threading } : {}),
  };
}

function expectLastDelivery(
  matcher: Partial<Parameters<(typeof mocks.deliverOutboundPayloads.mock.calls)[number][0]>[0]>,
) {
  expect(mocks.deliverOutboundPayloads).toHaveBeenLastCalledWith(expect.objectContaining(matcher));
}

async function expectSlackNoDelivery(
  payload: Parameters<typeof routeReply>[0]["payload"],
  overrides: Partial<Parameters<typeof routeReply>[0]> = {},
) {
  mocks.deliverOutboundPayloads.mockClear();
  const res = await routeReply({
    payload,
    channel: "slack",
    to: "channel:C123",
    cfg: {} as never,
    ...overrides,
  });
  expect(res.ok).toBe(true);
  expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  return res;
}

describe("routeReply", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          plugin: createChannelPlugin("discord", { label: "Discord" }),
          source: "test",
        },
        {
          pluginId: "slack",
          plugin: createChannelPlugin("slack", {
            label: "Slack",
            messaging: slackMessaging,
            threading: slackThreading,
          }),
          source: "test",
        },
        {
          pluginId: "telegram",
          plugin: createChannelPlugin("telegram", { label: "Telegram" }),
          source: "test",
        },
        {
          pluginId: "whatsapp",
          plugin: createChannelPlugin("whatsapp", { label: "WhatsApp" }),
          source: "test",
        },
        {
          pluginId: "signal",
          plugin: createChannelPlugin("signal", { label: "Signal" }),
          source: "test",
        },
        {
          pluginId: "imessage",
          plugin: createChannelPlugin("imessage", { label: "iMessage" }),
          source: "test",
        },
        {
          pluginId: "msteams",
          plugin: createChannelPlugin("msteams", { label: "Microsoft Teams" }),
          source: "test",
        },
        {
          pluginId: "mattermost",
          plugin: createChannelPlugin("mattermost", {
            label: "Mattermost",
            threading: mattermostThreading,
          }),
          source: "test",
        },
      ]),
    );
    mocks.deliverOutboundPayloads.mockReset();
    mocks.deliverOutboundPayloads.mockResolvedValue([]);
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it("skips sends when abort signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const res = await routeReply({
      payload: { text: "hi" },
      channel: "slack",
      to: "channel:C123",
      cfg: {} as never,
      abortSignal: controller.signal,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("aborted");
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("no-ops on empty payload", async () => {
    await expectSlackNoDelivery({});
  });

  it("suppresses reasoning payloads", async () => {
    await expectSlackNoDelivery({ text: "step", isReasoning: true });
  });

  it("drops silent token payloads", async () => {
    await expectSlackNoDelivery({ text: SILENT_REPLY_TOKEN });
  });

  it("does not drop payloads that merely start with the silent token", async () => {
    const res = await routeReply({
      payload: { text: `${SILENT_REPLY_TOKEN} -- (why am I here?)` },
      channel: "slack",
      to: "channel:C123",
      cfg: {} as never,
    });
    expect(res.ok).toBe(true);
    expectLastDelivery({
      channel: "slack",
      to: "channel:C123",
      payloads: [
        expect.objectContaining({
          text: `${SILENT_REPLY_TOKEN} -- (why am I here?)`,
        }),
      ],
    });
  });

  it("passes policySessionKey through to outbound delivery targets", async () => {
    const cfg = {
      agents: {
        defaults: {
          silentReply: {
            direct: "disallow",
            group: "allow",
            internal: "allow",
          },
          silentReplyRewrite: {
            direct: true,
          },
        },
      },
    } as unknown as OpenClawConfig;

    const res = await routeReply({
      payload: { text: "native command response" },
      channel: "slack",
      to: "channel:C123",
      cfg,
      sessionKey: "agent:main:main",
      policySessionKey: "agent:main:direct:U123",
      isGroup: true,
    });

    expect(res.ok).toBe(true);
    expectLastDelivery({
      payloads: [expect.objectContaining({ text: "native command response" })],
      session: expect.objectContaining({
        key: "agent:main:main",
        policyKey: "agent:main:direct:U123",
      }),
    });
    const session = mocks.deliverOutboundPayloads.mock.calls.at(-1)?.[0]?.session;
    expect(session).not.toEqual(expect.objectContaining({ conversationType: "group" }));
  });

  it("uses explicit policy conversation type to preserve routed direct silent replies", async () => {
    const cfg = {
      agents: {
        defaults: {
          silentReply: {
            direct: "disallow",
            internal: "allow",
          },
          silentReplyRewrite: {
            direct: true,
          },
        },
      },
    } as unknown as OpenClawConfig;

    const res = await routeReply({
      payload: { text: SILENT_REPLY_TOKEN },
      channel: "slack",
      to: "channel:C123",
      cfg,
      sessionKey: "agent:main:main",
      policySessionKey: "agent:main:main",
      policyConversationType: "direct",
    });

    expect(res.ok).toBe(true);
    expectLastDelivery({
      payloads: [expect.objectContaining({ text: SILENT_REPLY_TOKEN })],
      session: expect.objectContaining({
        key: "agent:main:main",
        policyKey: "agent:main:main",
        conversationType: "direct",
      }),
    });
  });

  it("applies responsePrefix when routing", async () => {
    const cfg = {
      messages: { responsePrefix: "[openclaw]" },
    } as unknown as OpenClawConfig;
    await routeReply({
      payload: { text: "hi" },
      channel: "slack",
      to: "channel:C123",
      cfg,
    });
    expectLastDelivery({
      payloads: [expect.objectContaining({ text: "[openclaw] hi" })],
    });
  });

  it("routes directive-only Slack replies when interactive replies are enabled", async () => {
    const cfg = {
      channels: {
        slack: {
          capabilities: { interactiveReplies: true },
        },
      },
    } as unknown as OpenClawConfig;
    await routeReply({
      payload: { text: "[[slack_select: Choose one | Alpha:alpha]]" },
      channel: "slack",
      to: "channel:C123",
      cfg,
    });
    expectLastDelivery({
      payloads: [
        expect.objectContaining({
          text: "[[slack_select: Choose one | Alpha:alpha]]",
        }),
      ],
    });
  });

  it("does not bypass the empty-reply guard for invalid Slack blocks", async () => {
    await expectSlackNoDelivery({
      text: " ",
      channelData: {
        slack: {
          blocks: " ",
        },
      },
    });
  });

  it("does not derive responsePrefix from agent identity when routing", async () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "rich",
            identity: { name: "Richbot", theme: "lion bot", emoji: "lion" },
          },
        ],
      },
      messages: {},
    } as unknown as OpenClawConfig;
    await routeReply({
      payload: { text: "hi" },
      channel: "slack",
      to: "channel:C123",
      sessionKey: "agent:rich:main",
      cfg,
    });
    expectLastDelivery({
      payloads: [expect.objectContaining({ text: "hi" })],
    });
  });

  it("uses threadId for Slack when replyToId is missing", async () => {
    await routeReply({
      payload: { text: "hi" },
      channel: "slack",
      to: "channel:C123",
      threadId: "456.789",
      cfg: {} as never,
    });
    expectLastDelivery({
      channel: "slack",
      replyToId: "456.789",
      threadId: null,
    });
  });

  it("passes thread id to Telegram sends", async () => {
    await routeReply({
      payload: { text: "hi" },
      channel: "telegram",
      to: "telegram:123",
      threadId: 42,
      cfg: {} as never,
    });
    expectLastDelivery({
      channel: "telegram",
      to: "telegram:123",
      threadId: 42,
    });
  });

  it("formats BTW replies prominently on routed sends", async () => {
    await routeReply({
      payload: { text: "323", btw: { question: "what is 17 * 19?" } },
      channel: "slack",
      to: "channel:C123",
      cfg: {} as never,
    });
    expectLastDelivery({
      channel: "slack",
      payloads: [expect.objectContaining({ text: "BTW\nQuestion: what is 17 * 19?\n\n323" })],
    });
  });

  it("formats BTW replies prominently on routed discord sends", async () => {
    await routeReply({
      payload: { text: "323", btw: { question: "what is 17 * 19?" } },
      channel: "discord",
      to: "channel:123456",
      cfg: {} as never,
    });
    expectLastDelivery({
      channel: "discord",
      payloads: [expect.objectContaining({ text: "BTW\nQuestion: what is 17 * 19?\n\n323" })],
    });
  });

  it("passes replyToId to Telegram sends", async () => {
    await routeReply({
      payload: { text: "hi", replyToId: "123" },
      channel: "telegram",
      to: "telegram:123",
      cfg: {} as never,
    });
    expectLastDelivery({
      channel: "telegram",
      to: "telegram:123",
      replyToId: "123",
    });
  });

  it("preserves audioAsVoice on routed outbound payloads", async () => {
    await routeReply({
      payload: { text: "voice caption", mediaUrl: "file:///tmp/clip.mp3", audioAsVoice: true },
      channel: "slack",
      to: "channel:C123",
      cfg: {} as never,
    });
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expectLastDelivery({
      channel: "slack",
      to: "channel:C123",
      payloads: [
        expect.objectContaining({
          text: "voice caption",
          mediaUrl: "file:///tmp/clip.mp3",
          audioAsVoice: true,
        }),
      ],
    });
  });

  it("uses replyToId as threadTs for Slack", async () => {
    await routeReply({
      payload: { text: "hi", replyToId: "1710000000.0001" },
      channel: "slack",
      to: "channel:C123",
      cfg: {} as never,
    });
    expectLastDelivery({
      channel: "slack",
      replyToId: "1710000000.0001",
      threadId: null,
    });
  });

  it("uses threadId as threadTs for Slack when replyToId is missing", async () => {
    await routeReply({
      payload: { text: "hi" },
      channel: "slack",
      to: "channel:C123",
      threadId: "1710000000.9999",
      cfg: {} as never,
    });
    expectLastDelivery({
      channel: "slack",
      replyToId: "1710000000.9999",
      threadId: null,
    });
  });

  it("uses Slack threadId when routed replyToId is an internal message id", async () => {
    await routeReply({
      payload: { text: "hi", replyToId: "msg-internal-1" },
      channel: "slack",
      to: "channel:C123",
      threadId: "1710000000.9999",
      cfg: {} as never,
    });
    expectLastDelivery({
      channel: "slack",
      replyToId: "1710000000.9999",
      threadId: null,
    });
  });

  it("uses threadId as replyToId for Mattermost when replyToId is missing", async () => {
    await routeReply({
      payload: { text: "hi" },
      channel: "mattermost",
      to: "channel:CHAN1",
      threadId: "post-root",
      cfg: {
        channels: {
          mattermost: {
            enabled: true,
            botToken: "test-token",
            baseUrl: "https://chat.example.com",
          },
        },
      } as unknown as OpenClawConfig,
    });
    expectLastDelivery({
      channel: "mattermost",
      to: "channel:CHAN1",
      replyToId: "post-root",
      threadId: "post-root",
    });
  });

  it("preserves multiple mediaUrls as a single outbound payload", async () => {
    await routeReply({
      payload: { text: "caption", mediaUrls: ["a", "b"] },
      channel: "slack",
      to: "channel:C123",
      cfg: {} as never,
    });
    expectLastDelivery({
      channel: "slack",
      payloads: [
        expect.objectContaining({
          text: "caption",
          mediaUrls: ["a", "b"],
        }),
      ],
    });
  });

  it("routes WhatsApp with the account id intact", async () => {
    await routeReply({
      payload: { text: "hi" },
      channel: "whatsapp",
      to: "+15551234567",
      accountId: "acc-1",
      cfg: {} as never,
    });
    expectLastDelivery({
      channel: "whatsapp",
      to: "+15551234567",
      accountId: "acc-1",
    });
  });

  it("routes MS Teams via outbound delivery", async () => {
    const cfg = {
      channels: {
        msteams: {
          enabled: true,
        },
      },
    } as unknown as OpenClawConfig;
    await routeReply({
      payload: { text: "hi" },
      channel: "msteams",
      to: "conversation:19:abc@thread.tacv2",
      cfg,
    });
    expectLastDelivery({
      channel: "msteams",
      to: "conversation:19:abc@thread.tacv2",
      cfg,
      payloads: [expect.objectContaining({ text: "hi" })],
    });
  });

  it("passes mirror data when sessionKey is set", async () => {
    await routeReply({
      payload: { text: "hi" },
      channel: "slack",
      to: "channel:C123",
      sessionKey: "agent:main:main",
      isGroup: true,
      groupId: "channel:C123",
      cfg: {} as never,
    });
    expectLastDelivery({
      mirror: expect.objectContaining({
        sessionKey: "agent:main:main",
        text: "hi",
        isGroup: true,
        groupId: "channel:C123",
      }),
    });
  });

  it("skips mirror data when mirror is false", async () => {
    await routeReply({
      payload: { text: "hi" },
      channel: "slack",
      to: "channel:C123",
      sessionKey: "agent:main:main",
      mirror: false,
      cfg: {} as never,
    });
    expectLastDelivery({
      mirror: undefined,
    });
  });
});
