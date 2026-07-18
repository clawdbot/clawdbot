// Tests routeReply delivery decisions across channels and fallback paths.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChannelMessagingAdapter,
  ChannelPlugin,
  ChannelThreadingAdapter,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(),
  hookRunner: undefined as
    | {
        hasHooks: ReturnType<typeof vi.fn>;
        runMessageSending: ReturnType<typeof vi.fn>;
        runReplyPayloadSending: ReturnType<typeof vi.fn>;
      }
    | undefined,
}));

vi.mock("../../infra/outbound/deliver-runtime.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => mocks.hookRunner,
}));

const { routeReply: routeReplyRuntime } = await import("./route-reply.js");
type RouteReplyParams = Parameters<typeof routeReplyRuntime>[0];
const routeReply = (
  params: Omit<RouteReplyParams, "replyKind"> & { replyKind?: RouteReplyParams["replyKind"] },
) => routeReplyRuntime({ replyKind: "final", ...params });

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
  resolveReplyTransport: ({ threadId, replyToId, replyDelivery }) => {
    const resolvedReplyToId =
      resolveSlackThreadTsCandidate(replyDelivery?.replyToMode === "off" ? undefined : replyToId) ??
      resolveSlackThreadTsCandidate(threadId);
    return {
      replyToId:
        replyDelivery?.replyToMode === "off" && !resolvedReplyToId ? null : resolvedReplyToId,
      threadId: null,
    };
  },
};

function resolveSlackThreadTsCandidate(value?: string | number | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return /^\d+\.\d+$/.test(normalized) ? normalized : undefined;
}

const mattermostThreading: ChannelThreadingAdapter = {
  resolveReplyTransport: ({ threadId, replyToId, replyToIsExplicit, replyDelivery }) => {
    const ambientThreadId = threadId != null && threadId !== "" ? String(threadId) : undefined;
    const resolvedThreadId =
      replyDelivery?.chatType === "direct"
        ? undefined
        : replyToIsExplicit
          ? (replyToId ?? ambientThreadId)
          : replyDelivery
            ? (ambientThreadId ?? replyToId ?? undefined)
            : (replyToId ?? ambientThreadId);
    return {
      replyToId: replyDelivery?.chatType === "direct" ? null : resolvedThreadId,
      threadId: resolvedThreadId ?? null,
    };
  },
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

function lastDelivery() {
  const call = mocks.deliverOutboundPayloads.mock.calls.at(-1);
  if (!call) {
    throw new Error("Expected outbound delivery call");
  }
  const delivery = call[0];
  if (!delivery || typeof delivery !== "object") {
    throw new Error("expected outbound delivery");
  }
  return delivery as Record<string, unknown>;
}

function expectLastDeliveryFields(fields: Record<string, unknown>) {
  const delivery = lastDelivery();
  for (const [key, expected] of Object.entries(fields)) {
    expect(delivery[key]).toEqual(expected);
  }
}

function lastDeliveryPayload(index = 0): Record<string, unknown> {
  const payloads = lastDelivery().payloads;
  expect(Array.isArray(payloads)).toBe(true);
  const payload = (payloads as unknown[])[index];
  if (!payload || typeof payload !== "object") {
    throw new Error(`expected delivery payload ${index}`);
  }
  return payload as Record<string, unknown>;
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
    mocks.hookRunner = undefined;
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
    expectLastDeliveryFields({
      channel: "slack",
      to: "channel:C123",
    });
    expect(lastDeliveryPayload().text).toBe(`${SILENT_REPLY_TOKEN} -- (why am I here?)`);
  });

  it("passes replayable reply payload hook context to routed delivery", async () => {
    const res = await routeReply({
      payload: { text: "hello" },
      channel: "telegram",
      to: "chat-1",
      accountId: "acct-1",
      sessionKey: "agent:test",
      requesterSenderId: "sender-1",
      cfg: {} as never,
      replyKind: "block",
      runId: "run-1",
    });

    expect(res.ok).toBe(true);
    expect(lastDeliveryPayload()).toMatchObject({ text: "hello" });
    expect(lastDelivery().replyPayloadSendingHook).toMatchObject({
      kind: "block",
      channel: "telegram",
      sessionKey: "agent:test",
      runId: "run-1",
      context: {
        channelId: "telegram",
        accountId: "acct-1",
        conversationId: "chat-1",
        sessionKey: "agent:test",
        senderId: "sender-1",
        runId: "run-1",
      },
    });
    expect(lastDelivery()).not.toHaveProperty("skipMessageSendingHooks");
  });

  it("uses payload reply policy when resolving the final Slack transport", async () => {
    const payload = setReplyPayloadMetadata(
      { text: "hello", replyToId: "999.000" },
      {
        replyDelivery: {
          chatType: "channel",
          replyToMode: "off",
        },
      },
    );

    const res = await routeReply({
      payload,
      channel: "slack",
      to: "channel:C123",
      threadId: "111.000",
      cfg: {} as never,
    });

    expect(res.ok).toBe(true);
    expectLastDeliveryFields({
      replyToId: "111.000",
      threadId: null,
    });
    expect(lastDeliveryPayload().replyToId).toBe("111.000");
  });

  it("keeps fresh payload reply mode for the same destination policy route", async () => {
    const payload = setReplyPayloadMetadata(
      { text: "hello", replyToId: "999.000" },
      {
        replyDelivery: {
          chatType: "channel",
          replyToMode: "all",
        },
        replyDeliverySource: {
          channel: "slack",
          accountId: "primary",
        },
      },
    );

    const res = await routeReply({
      payload,
      channel: "slack",
      to: "channel:C123",
      accountId: "primary",
      replyDelivery: {
        chatType: "channel",
        replyToMode: "off",
      },
      cfg: {} as never,
    });

    expect(res.ok).toBe(true);
    expectLastDeliveryFields({
      replyToId: "999.000",
      threadId: null,
    });
    expect(lastDeliveryPayload().replyToId).toBe("999.000");
  });

  it("uses destination reply policy when payload policy came from another route", async () => {
    const payload = setReplyPayloadMetadata(
      { text: "hello", replyToId: "999.000" },
      {
        replyDelivery: {
          chatType: "direct",
          replyToMode: "all",
        },
        replyDeliverySource: {
          channel: "webchat",
        },
      },
    );

    const res = await routeReply({
      payload,
      channel: "slack",
      to: "channel:C123",
      replyDelivery: {
        chatType: "channel",
        replyToMode: "off",
      },
      cfg: {} as never,
    });

    expect(res.ok).toBe(true);
    expectLastDeliveryFields({
      replyToId: null,
      threadId: null,
    });
    expect(lastDeliveryPayload().replyToId).toBeUndefined();
  });

  it("uses explicit reply policy when routed blocks have no payload metadata", async () => {
    const res = await routeReply({
      payload: { text: "hello", replyToId: "999.000" },
      channel: "slack",
      to: "channel:C123",
      threadId: "111.000",
      replyDelivery: {
        chatType: "channel",
        replyToMode: "off",
      },
      cfg: {} as never,
      replyKind: "block",
    });

    expect(res.ok).toBe(true);
    expectLastDeliveryFields({
      replyToId: "111.000",
      threadId: null,
    });
  });

  it("honors Slack policy that clears a top-level reply target", async () => {
    const res = await routeReply({
      payload: { text: "hello", replyToId: "999.000" },
      channel: "slack",
      to: "channel:C123",
      replyDelivery: {
        chatType: "channel",
        replyToMode: "off",
      },
      cfg: {} as never,
      replyKind: "block",
    });

    expect(res.ok).toBe(true);
    expectLastDeliveryFields({
      replyToId: null,
      threadId: null,
    });
    expect(lastDeliveryPayload().replyToId).toBeUndefined();
  });

  it("honors Mattermost policy that clears direct-message reply targets", async () => {
    const res = await routeReply({
      payload: { text: "hello", replyToId: "post-1" },
      channel: "mattermost",
      to: "user:U123",
      replyDelivery: {
        chatType: "direct",
        replyToMode: "all",
      },
      cfg: {} as never,
      replyKind: "block",
    });

    expect(res.ok).toBe(true);
    expectLastDeliveryFields({
      replyToId: null,
      threadId: null,
    });
    expect(lastDeliveryPayload().replyToId).toBeUndefined();
  });

  it("preserves explicit Mattermost reply targets over the ambient thread", async () => {
    const res = await routeReply({
      payload: {
        text: "hello",
        replyToId: "other-root",
        replyToTag: true,
      },
      channel: "mattermost",
      to: "channel:C123",
      threadId: "ambient-root",
      replyDelivery: {
        chatType: "channel",
        replyToMode: "all",
      },
      cfg: {} as never,
    });

    expect(res.ok).toBe(true);
    expectLastDeliveryFields({
      replyToId: "other-root",
      threadId: "other-root",
    });
    expect(lastDeliveryPayload().replyToId).toBe("other-root");
  });

  it("preserves reply targets when an adapter returns undefined", async () => {
    const res = await routeReply({
      payload: { text: "hello", replyToId: "msg-internal-1" },
      channel: "slack",
      to: "channel:C123",
      cfg: {} as never,
    });

    expect(res.ok).toBe(true);
    expectLastDeliveryFields({
      replyToId: "msg-internal-1",
      threadId: null,
    });
  });

  it("leaves message_sending enforcement to routed durable delivery", async () => {
    const res = await routeReply({
      payload: { text: "secret" },
      channel: "telegram",
      to: "chat-1",
      accountId: "acct-1",
      cfg: {} as never,
    });

    expect(res.ok).toBe(true);
    expect(lastDelivery()).toMatchObject({
      channel: "telegram",
      to: "chat-1",
      accountId: "acct-1",
      payloads: [expect.objectContaining({ text: "secret" })],
      replyPayloadSendingHook: expect.objectContaining({
        kind: "final",
        channel: "telegram",
        context: expect.objectContaining({
          channelId: "telegram",
          accountId: "acct-1",
          conversationId: "chat-1",
        }),
      }),
    });
    expect(lastDelivery()).not.toHaveProperty("skipMessageSendingHooks");
  });

  it("returns routed reply hook suppression reasons from durable delivery", async () => {
    mocks.deliverOutboundPayloads.mockImplementationOnce(
      async ({
        onPayloadDeliveryOutcome,
      }: {
        onPayloadDeliveryOutcome?: (outcome: unknown) => void;
      }) => {
        onPayloadDeliveryOutcome?.({
          index: 0,
          status: "suppressed",
          reason: "cancelled_by_reply_payload_sending_hook",
        });
        return [];
      },
    );

    const res = await routeReply({
      payload: { text: "hello" },
      channel: "telegram",
      to: "chat-1",
      cfg: {} as never,
    });

    expect(res).toEqual({
      ok: true,
      suppressed: true,
      reason: "cancelled_by_reply_payload_sending_hook",
    });
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(lastDelivery().replyPayloadSendingHook).toMatchObject({
      kind: "final",
      channel: "telegram",
      context: {
        channelId: "telegram",
        conversationId: "chat-1",
      },
    });
  });

  it("suppresses routed delivery when reply payload hooks cancel", async () => {
    mocks.deliverOutboundPayloads.mockImplementationOnce(
      async ({
        onPayloadDeliveryOutcome,
      }: {
        onPayloadDeliveryOutcome?: (outcome: unknown) => void;
      }) => {
        onPayloadDeliveryOutcome?.({
          index: 0,
          status: "suppressed",
          reason: "cancelled_by_reply_payload_sending_hook",
        });
        return [];
      },
    );

    const res = await routeReply({
      payload: { text: "hello" },
      channel: "telegram",
      to: "chat-1",
      cfg: {} as never,
    });

    expect(res).toEqual({
      ok: true,
      suppressed: true,
      reason: "cancelled_by_reply_payload_sending_hook",
    });
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
  });

  it("suppresses routed delivery when reply payload hooks empty the payload", async () => {
    mocks.deliverOutboundPayloads.mockImplementationOnce(
      async ({
        onPayloadDeliveryOutcome,
      }: {
        onPayloadDeliveryOutcome?: (outcome: unknown) => void;
      }) => {
        onPayloadDeliveryOutcome?.({
          index: 0,
          status: "suppressed",
          reason: "empty_after_reply_payload_sending_hook",
        });
        return [];
      },
    );

    const res = await routeReply({
      payload: { text: "hello" },
      channel: "telegram",
      to: "chat-1",
      cfg: {} as never,
    });

    expect(res).toEqual({
      ok: true,
      suppressed: true,
      reason: "empty_after_reply_payload_sending_hook",
    });
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
  });

  it("passes policySessionKey through to outbound delivery targets", async () => {
    const cfg = {
      agents: {
        defaults: {
          silentReply: {
            group: "allow",
            internal: "allow",
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
    expect(lastDeliveryPayload().text).toBe("native command response");
    const session = lastDelivery().session as Record<string, unknown>;
    expect(session.key).toBe("agent:main:main");
    expect(session.policyKey).toBe("agent:main:direct:U123");
    expect(session.conversationType).toBeUndefined();
  });

  it("uses explicit policy conversation type to suppress routed direct silent replies", async () => {
    const cfg = {
      agents: {
        defaults: {
          silentReply: {
            internal: "allow",
          },
        },
      },
    } as unknown as OpenClawConfig;

    await expectSlackNoDelivery(
      { text: SILENT_REPLY_TOKEN },
      {
        cfg,
        sessionKey: "agent:main:main",
        policySessionKey: "agent:main:main",
        policyConversationType: "direct",
      },
    );
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
    expect(lastDeliveryPayload().text).toBe("[openclaw] hi");
  });

  it("interpolates responsePrefix from the routed channel and account", async () => {
    const cfg = {
      messages: { responsePrefix: "[global]" },
      channels: {
        slack: {
          responsePrefix: "[slack]",
          accounts: {
            support: { responsePrefix: "[{modelFull} think:{thinkingLevel}]" },
          },
        },
      },
    } as unknown as OpenClawConfig;
    await routeReply({
      payload: { text: "hi" },
      channel: "slack",
      to: "channel:C123",
      accountId: "support",
      sessionKey: "agent:main:main",
      responsePrefixContext: {
        modelFull: "anthropic/claude-opus-4-6",
        thinkingLevel: "high",
      },
      cfg,
    });
    expect(lastDeliveryPayload().text).toBe("[anthropic/claude-opus-4-6 think:high] hi");
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
    expect(lastDeliveryPayload().text).toBe("[[slack_select: Choose one | Alpha:alpha]]");
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
    expect(lastDeliveryPayload().text).toBe("hi");
  });

  it("uses threadId for Slack when replyToId is missing", async () => {
    await routeReply({
      payload: { text: "hi" },
      channel: "slack",
      to: "channel:C123",
      threadId: "456.789",
      cfg: {} as never,
    });
    expectLastDeliveryFields({
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
    expectLastDeliveryFields({
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
    expectLastDeliveryFields({
      channel: "slack",
    });
    expect(lastDeliveryPayload().text).toBe("BTW\nQuestion: what is 17 * 19?\n\n323");
  });

  it("formats BTW replies prominently on routed discord sends", async () => {
    await routeReply({
      payload: { text: "323", btw: { question: "what is 17 * 19?" } },
      channel: "discord",
      to: "channel:123456",
      cfg: {} as never,
    });
    expectLastDeliveryFields({
      channel: "discord",
    });
    expect(lastDeliveryPayload().text).toBe("BTW\nQuestion: what is 17 * 19?\n\n323");
  });

  it("passes replyToId to Telegram sends", async () => {
    await routeReply({
      payload: { text: "hi", replyToId: "123" },
      channel: "telegram",
      to: "telegram:123",
      cfg: {} as never,
    });
    expectLastDeliveryFields({
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
    expectLastDeliveryFields({
      channel: "slack",
      to: "channel:C123",
    });
    expect(lastDeliveryPayload().text).toBe("voice caption");
    expect(lastDeliveryPayload().mediaUrl).toBe("file:///tmp/clip.mp3");
    expect(lastDeliveryPayload().audioAsVoice).toBe(true);
  });

  it("uses replyToId as threadTs for Slack", async () => {
    await routeReply({
      payload: { text: "hi", replyToId: "1710000000.0001" },
      channel: "slack",
      to: "channel:C123",
      cfg: {} as never,
    });
    expectLastDeliveryFields({
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
    expectLastDeliveryFields({
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
    expectLastDeliveryFields({
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
    expectLastDeliveryFields({
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
    expectLastDeliveryFields({
      channel: "slack",
    });
    expect(lastDeliveryPayload().text).toBe("caption");
    expect(lastDeliveryPayload().mediaUrls).toEqual(["a", "b"]);
  });

  it("routes WhatsApp with the account id intact", async () => {
    await routeReply({
      payload: { text: "hi" },
      channel: "whatsapp",
      to: "+15551234567",
      accountId: "acc-1",
      cfg: {} as never,
    });
    expectLastDeliveryFields({
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
    expectLastDeliveryFields({
      channel: "msteams",
      to: "conversation:19:abc@thread.tacv2",
      cfg,
    });
    expect(lastDeliveryPayload().text).toBe("hi");
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
    const mirror = lastDelivery().mirror as Record<string, unknown>;
    expect(mirror.sessionKey).toBe("agent:main:main");
    expect(mirror.text).toBe("hi");
    expect(mirror.isGroup).toBe(true);
    expect(mirror.groupId).toBe("channel:C123");
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
    expectLastDeliveryFields({
      mirror: undefined,
    });
  });
});
