// Slack tests cover message handler plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueueMock = vi.fn(async (_entry: unknown) => {});
const flushKeyMock = vi.fn(async (_key: string) => {});
const onFlushCallbacks: Array<(entries: Array<Record<string, unknown>>) => Promise<void>> = [];
const prepareSlackMessageMock = vi.fn(async () => ({ ctxPayload: {} }));
const dispatchPreparedSlackMessageMock = vi.fn(async (_prepared: unknown) => {});
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

function createContext(overrides?: {
  rememberSlackChannelType?: (
    channel: string | null | undefined,
    channelType: string | null | undefined,
  ) => void;
}) {
  return {
    cfg: {},
    accountId: "default",
    app: {
      client: {},
    },
    runtime: {},
    rememberSlackChannelType: (
      channel: string | null | undefined,
      channelType: string | null | undefined,
    ) => overrides?.rememberSlackChannelType?.(channel, channelType),
  } as Parameters<typeof createSlackMessageHandler>[0]["ctx"];
}

function createHandlerWithTracker(overrides?: {
  rememberSlackChannelType?: (
    channel: string | null | undefined,
    channelType: string | null | undefined,
  ) => void;
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

  it("tracks accepted messages", async () => {
    const { handler, trackEvent } = createHandlerWithTracker();

    await handleDirectMessage(handler);

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(resolveThreadTsMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it("records explicit channel type before thread resolution", async () => {
    let settleThreadResolution: (() => void) | undefined;
    resolveThreadTsMock.mockImplementationOnce(
      async ({ message }: { message: Record<string, unknown> }) => {
        await new Promise<void>((resolve) => {
          settleThreadResolution = resolve;
        });
        return { ...message };
      },
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
    settleThreadResolution?.();
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

  it("carries durable ingress ownership into prepared dispatch", async () => {
    const turnAdoptionLifecycle = {
      admission: "exclusive" as const,
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(),
    };
    const { handler } = createHandlerWithTracker();
    const handled = handler(
      {
        type: "message",
        channel: "C111",
        user: "U111",
        ts: "1709000000.000550",
        text: "durable message",
      } as never,
      { source: "message", awaitDispatch: true, turnAdoptionLifecycle },
    );

    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
    const entry = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    await onFlushCallbacks[0]?.([entry]);
    await handled;

    // The flush wraps the lifecycle to settle dispatch-dedupe claims, so assert
    // ownership forwarding rather than function identity.
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
    const prepared = dispatchPreparedSlackMessageMock.mock.calls[0]?.[0] as {
      turnAdoptionLifecycle?: typeof turnAdoptionLifecycle;
    };
    expect(prepared.turnAdoptionLifecycle?.admission).toBe("exclusive");
    expect(prepared.turnAdoptionLifecycle?.abortSignal).toBe(turnAdoptionLifecycle.abortSignal);
    await prepared.turnAdoptionLifecycle?.onAdopted();
    expect(turnAdoptionLifecycle.onAdopted).toHaveBeenCalledTimes(1);
    prepared.turnAdoptionLifecycle?.onDeferred();
    expect(turnAdoptionLifecycle.onDeferred).toHaveBeenCalledTimes(1);
  });

  it("dispatches a message/app_mention twin pair exactly once", async () => {
    // Slack emits both events with distinct event_ids for one mention post, so
    // the durable ingress queue admits both; the logical (channel, ts) dispatch
    // guard must collapse them to a single dispatch.
    const { handler } = createHandlerWithTracker();
    const twinTs = "1709000000.000777";
    const asMessage = handler(
      {
        type: "message",
        channel: "C111",
        user: "U111",
        ts: twinTs,
        text: "<@UBOT> hello",
      } as never,
      { source: "message", awaitDispatch: true },
    );
    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
    const first = enqueueMock.mock.calls[0]?.[0] as Record<string, unknown>;
    await onFlushCallbacks[0]?.([first]);
    await asMessage;
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);

    const asMention = handler(
      {
        type: "message",
        channel: "C111",
        user: "U111",
        ts: twinTs,
        text: "<@UBOT> hello",
      } as never,
      { source: "app_mention", wasMentioned: true, awaitDispatch: true },
    );
    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(2));
    const second = enqueueMock.mock.calls[1]?.[0] as Record<string, unknown>;
    await onFlushCallbacks[0]?.([second]);
    await asMention;
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

  it("retries native session initialization conflicts", async () => {
    dispatchPreparedSlackMessageMock.mockRejectedValueOnce(
      new Error("Slack dispatch failed", {
        cause: new Error(
          "reply session initialization conflicted for agent:main:main:thread:123.456",
        ),
      }),
    );
    const { handler } = createHandlerWithTracker();
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
    dispatchPreparedSlackMessageMock.mockRejectedValueOnce(
      new Error("Slack dispatch failed", {
        cause: new Error(
          "reply session initialization conflicted for agent:main:main:thread:123.456",
        ),
      }),
    );
    const { handler } = createHandlerWithTracker();
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

      expect(enqueueMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
