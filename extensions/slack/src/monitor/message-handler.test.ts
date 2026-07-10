// Slack tests cover message handler plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueueMock = vi.fn(async (_entry: unknown) => {});
const flushKeyMock = vi.fn(async (_key: string) => {});
const onFlushCallbacks: Array<(entries: Array<Record<string, unknown>>) => Promise<void>> = [];
const prepareSlackMessageMock = vi.fn(async () => ({ ctxPayload: {} }));
const dispatchPreparedSlackMessageMock = vi.fn(async () => {});
const hasSlackInboundMessageDeliveryMock = vi.fn(async () => false);
const recordSlackInboundMessageDeliveriesMock = vi.fn(async () => {});
const resolveThreadTsMock = vi.fn(async ({ message }: { message: Record<string, unknown> }) => ({
  ...message,
}));
const { createSlackMessageHandler } = await import("./message-handler.js");

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  return {
    ...actual,
    createChannelInboundDebouncer: (params: {
      onFlush: (entries: Array<Record<string, unknown>>) => Promise<void>;
    }) => {
      onFlushCallbacks.push(params.onFlush);
      return {
        debounceMs: 10,
        debouncer: {
          enqueue: (entry: unknown) => enqueueMock(entry),
          flushKey: (key: string) => flushKeyMock(key),
        },
      };
    },
    shouldDebounceTextInbound: ({ hasMedia }: { hasMedia?: boolean }) => !hasMedia,
  };
});

vi.mock("./thread-resolution.js", () => ({
  createSlackThreadTsResolver: () => ({
    resolve: (entry: { message: Record<string, unknown> }) => resolveThreadTsMock(entry),
  }),
}));

vi.mock("./message-handler/pipeline.runtime.js", () => ({
  prepareSlackMessage: prepareSlackMessageMock,
  dispatchPreparedSlackMessage: dispatchPreparedSlackMessageMock,
}));

vi.mock("./inbound-delivery-state.js", () => ({
  hasSlackInboundMessageDelivery: hasSlackInboundMessageDeliveryMock,
  recordSlackInboundMessageDeliveries: recordSlackInboundMessageDeliveriesMock,
}));

function createContext(overrides?: {
  markMessageSeen?: (channel: string | undefined, ts: string | undefined) => boolean;
  rememberSlackChannelType?: (
    channel: string | null | undefined,
    channelType: string | null | undefined,
  ) => void;
  releaseSeenMessage?: (channel: string | undefined, ts: string | undefined) => void;
}) {
  return {
    cfg: {},
    accountId: "default",
    app: {
      client: {},
    },
    runtime: {},
    markMessageSeen: (channel: string | undefined, ts: string | undefined) =>
      overrides?.markMessageSeen?.(channel, ts) ?? false,
    rememberSlackChannelType: (
      channel: string | null | undefined,
      channelType: string | null | undefined,
    ) => overrides?.rememberSlackChannelType?.(channel, channelType),
    releaseSeenMessage: (channel: string | undefined, ts: string | undefined) =>
      overrides?.releaseSeenMessage?.(channel, ts),
  } as Parameters<typeof createSlackMessageHandler>[0]["ctx"];
}

function createHandlerWithTracker(overrides?: {
  markMessageSeen?: (channel: string | undefined, ts: string | undefined) => boolean;
  rememberSlackChannelType?: (
    channel: string | null | undefined,
    channelType: string | null | undefined,
  ) => void;
  releaseSeenMessage?: (channel: string | undefined, ts: string | undefined) => void;
}) {
  const trackEvent = vi.fn();
  const handler = createSlackMessageHandler({
    ctx: createContext(overrides),
    account: { accountId: "default" } as Parameters<typeof createSlackMessageHandler>[0]["account"],
    trackEvent,
  });
  return { handler, trackEvent };
}

async function handleDirectMessage(
  handler: ReturnType<typeof createHandlerWithTracker>["handler"],
) {
  await handler(
    {
      type: "message",
      channel: "D1",
      ts: "123.456",
      text: "hello",
    } as never,
    { source: "message" },
  );
}

describe("createSlackMessageHandler", () => {
  beforeEach(() => {
    enqueueMock.mockClear();
    flushKeyMock.mockClear();
    onFlushCallbacks.length = 0;
    prepareSlackMessageMock.mockClear();
    dispatchPreparedSlackMessageMock.mockClear();
    hasSlackInboundMessageDeliveryMock.mockReset();
    hasSlackInboundMessageDeliveryMock.mockResolvedValue(false);
    recordSlackInboundMessageDeliveriesMock.mockClear();
    resolveThreadTsMock.mockClear();
  });

  it("does not track invalid non-message events from the message stream", async () => {
    const trackEvent = vi.fn();
    const handler = createSlackMessageHandler({
      ctx: createContext(),
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
      trackEvent,
    });

    await handler(
      {
        type: "reaction_added",
        channel: "D1",
        ts: "123.456",
      } as never,
      { source: "message" },
    );

    expect(trackEvent).not.toHaveBeenCalled();
    expect(resolveThreadTsMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("does not track duplicate messages that are already seen", async () => {
    const { handler, trackEvent } = createHandlerWithTracker({ markMessageSeen: () => true });

    await handleDirectMessage(handler);

    expect(trackEvent).not.toHaveBeenCalled();
    expect(resolveThreadTsMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("tracks accepted non-duplicate messages", async () => {
    const { handler, trackEvent } = createHandlerWithTracker();

    await handleDirectMessage(handler);

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(resolveThreadTsMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it("records explicit channel type before the first delivery-state await", async () => {
    let settleDeliveryLookup: ((delivered: boolean) => void) | undefined;
    hasSlackInboundMessageDeliveryMock.mockImplementationOnce(
      async () =>
        await new Promise<boolean>((resolve) => {
          settleDeliveryLookup = resolve;
        }),
    );
    const rememberSlackChannelType = vi.fn();
    const { handler } = createHandlerWithTracker({ rememberSlackChannelType });
    const handled = handler(
      {
        type: "message",
        channel: "C0MPDM42",
        channel_type: "mpim",
        user: "U_HUMAN",
        ts: "123.456",
        text: "human seed",
      } as never,
      { source: "message" },
    );

    expect(rememberSlackChannelType).toHaveBeenCalledWith("C0MPDM42", "mpim");
    expect(enqueueMock).not.toHaveBeenCalled();
    settleDeliveryLookup?.(false);
    await handled;
    expect(enqueueMock).toHaveBeenCalledOnce();
  });

  it("accepts thread_broadcast messages from the message stream", async () => {
    const { handler, trackEvent } = createHandlerWithTracker();

    await handler(
      {
        type: "message",
        subtype: "thread_broadcast",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000300",
        text: "also send to channel",
        thread_ts: "1709000000.000100",
      } as never,
      { source: "message" },
    );

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(resolveThreadTsMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it("drops message subtypes that do not carry user message text", async () => {
    const { handler, trackEvent } = createHandlerWithTracker();

    await handler(
      {
        type: "message",
        subtype: "channel_join",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000400",
        text: "<@U111> joined the channel",
      } as never,
      { source: "message" },
    );

    expect(trackEvent).not.toHaveBeenCalled();
    expect(resolveThreadTsMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("flushes pending top-level buffered keys before immediate non-debounce follow-ups", async () => {
    const handler = createSlackMessageHandler({
      ctx: createContext(),
      account: { accountId: "default" } as Parameters<
        typeof createSlackMessageHandler
      >[0]["account"],
    });

    await handler(
      {
        type: "message",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000100",
        text: "first buffered text",
      } as never,
      { source: "message" },
    );
    await handler(
      {
        type: "message",
        subtype: "file_share",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000200",
        text: "file follows",
        files: [{ id: "F1" }],
      } as never,
      { source: "message" },
    );

    expect(flushKeyMock).toHaveBeenCalledWith("slack:default:C111:1709000000.000100:U111");
  });

  it("waits for debounced dispatch completion when requested by relay delivery", async () => {
    const { handler } = createHandlerWithTracker();
    const handled = handler(
      {
        type: "message",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000500",
        text: "relay message",
      } as never,
      { source: "message", awaitDispatch: true },
    );

    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
    const entry = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    let settled = false;
    void handled.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await onFlushCallbacks[0]?.([entry]);
    await expect(handled).resolves.toBeUndefined();
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
  });

  it("propagates debounced dispatch failures to relay delivery", async () => {
    dispatchPreparedSlackMessageMock.mockRejectedValueOnce(new Error("dispatch failed"));
    const { handler } = createHandlerWithTracker();
    const handled = handler(
      {
        type: "message",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000600",
        text: "relay message",
      } as never,
      { source: "message", awaitDispatch: true },
    );

    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
    const entry = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const handledFailure = expect(handled).rejects.toThrow("dispatch failed");
    const flushFailure = expect(onFlushCallbacks[0]?.([entry])).rejects.toThrow("dispatch failed");
    await Promise.all([handledFailure, flushFailure]);
  });

  it("retries native session initialization conflicts through the delivery gates", async () => {
    const releaseSeenMessage = vi.fn();
    dispatchPreparedSlackMessageMock.mockRejectedValueOnce(
      new Error("Slack dispatch failed", {
        cause: new Error(
          "reply session initialization conflicted for agent:main:main:thread:123.456",
        ),
      }),
    );
    const { handler } = createHandlerWithTracker({ releaseSeenMessage });
    await handler(
      {
        type: "message",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000700",
        text: "native message",
      } as never,
      { source: "message" },
    );

    const entry = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    vi.useFakeTimers();
    try {
      await expect(onFlushCallbacks[0]?.([entry])).rejects.toThrow("Slack dispatch failed");
      await vi.advanceTimersByTimeAsync(1000);

      expect(releaseSeenMessage).toHaveBeenCalledWith("C111", "1709000000.000700");
      expect(recordSlackInboundMessageDeliveriesMock).not.toHaveBeenCalled();
      expect(hasSlackInboundMessageDeliveryMock).toHaveBeenCalledTimes(2);
      expect(enqueueMock).toHaveBeenCalledTimes(2);
      expect(enqueueMock.mock.calls[1]?.[0]).toMatchObject({
        opts: {
          retryAttempt: 1,
        },
      });
      expect(enqueueMock.mock.calls[1]?.[0]).not.toHaveProperty("opts.dispatchCompletion");
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves relay session conflict retries to unacknowledged redelivery", async () => {
    const releaseSeenMessage = vi.fn();
    dispatchPreparedSlackMessageMock.mockRejectedValueOnce(
      new Error("Slack dispatch failed", {
        cause: new Error(
          "reply session initialization conflicted for agent:main:main:thread:123.456",
        ),
      }),
    );
    const { handler } = createHandlerWithTracker({ releaseSeenMessage });
    const handled = handler(
      {
        type: "message",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000800",
        text: "relay message",
      } as never,
      { source: "message", awaitDispatch: true },
    );

    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
    const entry = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    vi.useFakeTimers();
    try {
      const handledFailure = expect(handled).rejects.toThrow("Slack dispatch failed");
      const flushFailure = expect(onFlushCallbacks[0]?.([entry])).rejects.toThrow(
        "Slack dispatch failed",
      );
      await Promise.all([handledFailure, flushFailure]);
      await vi.advanceTimersByTimeAsync(1000);

      expect(releaseSeenMessage).toHaveBeenCalledWith("C111", "1709000000.000800");
      expect(recordSlackInboundMessageDeliveriesMock).not.toHaveBeenCalled();
      expect(enqueueMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles an already-delivered relay event without enqueueing", async () => {
    hasSlackInboundMessageDeliveryMock.mockResolvedValueOnce(true);
    const { handler } = createHandlerWithTracker();

    await expect(
      handler(
        {
          type: "message",
          channel: "C111",
          user: "U111",
          ts: "1709000000.000850",
          text: "relay replay",
        } as never,
        { source: "message", awaitDispatch: true },
      ),
    ).resolves.toBeUndefined();

    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("skips a native retry when another delivery already succeeded", async () => {
    dispatchPreparedSlackMessageMock.mockRejectedValueOnce(
      new Error("reply session initialization conflicted for agent:main:main:thread:123.456"),
    );
    hasSlackInboundMessageDeliveryMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { handler } = createHandlerWithTracker();
    await handler(
      {
        type: "message",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000900",
        text: "native message",
      } as never,
      { source: "message" },
    );

    const entry = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    vi.useFakeTimers();
    try {
      await expect(onFlushCallbacks[0]?.([entry])).rejects.toThrow(
        "reply session initialization conflicted",
      );
      await vi.advanceTimersByTimeAsync(1000);

      expect(hasSlackInboundMessageDeliveryMock).toHaveBeenCalledTimes(2);
      expect(enqueueMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
