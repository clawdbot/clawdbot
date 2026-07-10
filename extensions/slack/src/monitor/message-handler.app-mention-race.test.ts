// Slack tests cover message handler.app mention race plugin behavior.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type TestHistoryEntry = {
  sender: string;
  body: string;
  messageId?: string;
};

const prepareSlackMessageMock = vi.fn<
  (params: {
    ctx: { channelHistories: Map<string, TestHistoryEntry[]> };
    message: { ts?: string };
    opts: {
      source: "message" | "app_mention";
      wasMentioned?: boolean;
      shouldRecordDroppedHistory?: () => boolean;
    };
  }) => Promise<unknown>
>();
const dispatchPreparedSlackMessageMock = vi.fn<(prepared: unknown) => Promise<void>>();

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  return {
    ...actual,
    shouldDebounceTextInbound: () => false,
    createChannelInboundDebouncer: (params: {
      onFlush: (
        entries: Array<{
          message: Record<string, unknown>;
          opts: { source: "message" | "app_mention"; wasMentioned?: boolean };
        }>,
      ) => Promise<void>;
    }) => ({
      debounceMs: 0,
      debouncer: {
        enqueue: async (entry: {
          message: Record<string, unknown>;
          opts: { source: "message" | "app_mention"; wasMentioned?: boolean };
        }) => {
          await params.onFlush([entry]);
        },
        flushKey: async (_key: string) => {},
      },
    }),
  };
});

vi.mock("./thread-resolution.js", () => ({
  createSlackThreadTsResolver: () => ({
    resolve: async ({ message }: { message: Record<string, unknown> }) => message,
  }),
}));

vi.mock("./message-handler/prepare.js", () => ({
  prepareSlackMessage: (
    params: Parameters<typeof prepareSlackMessageMock>[0],
  ): ReturnType<typeof prepareSlackMessageMock> => prepareSlackMessageMock(params),
}));

vi.mock("./message-handler/dispatch.js", () => ({
  dispatchPreparedSlackMessage: (
    prepared: Parameters<typeof dispatchPreparedSlackMessageMock>[0],
  ): ReturnType<typeof dispatchPreparedSlackMessageMock> =>
    dispatchPreparedSlackMessageMock(prepared),
}));

let createSlackMessageHandler: typeof import("./message-handler.js").createSlackMessageHandler;
let SlackRetryableInboundError: typeof import("./message-handler.js").SlackRetryableInboundError;
let clearSlackInboundDeliveryStateForTest: typeof import("./inbound-delivery-state.js").clearSlackInboundDeliveryStateForTest;
let clearSlackRuntime: typeof import("../runtime.js").clearSlackRuntime;
let setSlackRuntime: typeof import("../runtime.js").setSlackRuntime;

function createMarkMessageSeen() {
  const seen = new Set<string>();
  return {
    markMessageSeen(channel: string | undefined, ts: string | undefined) {
      if (!channel || !ts) {
        return false;
      }
      const key = `${channel}:${ts}`;
      if (seen.has(key)) {
        return true;
      }
      seen.add(key);
      return false;
    },
    releaseSeenMessage(channel: string | undefined, ts: string | undefined) {
      if (!channel || !ts) {
        return;
      }
      seen.delete(`${channel}:${ts}`);
    },
  };
}

function createTestHandler(
  params: {
    botUserId?: string;
    channelHistories?: Map<string, TestHistoryEntry[]>;
  } = {},
) {
  const seenMessages = createMarkMessageSeen();
  return createSlackMessageHandler({
    ctx: {
      cfg: {},
      accountId: "default",
      botUserId: params.botUserId ?? "U_BOT",
      channelHistories: params.channelHistories ?? new Map(),
      app: { client: {} },
      runtime: {},
      markMessageSeen: seenMessages["markMessageSeen"],
      rememberSlackChannelType: () => {},
      releaseSeenMessage: seenMessages["releaseSeenMessage"],
    } as unknown as Parameters<typeof createSlackMessageHandler>[0]["ctx"],
    account: { accountId: "default" } as Parameters<typeof createSlackMessageHandler>[0]["account"],
  });
}

function createSlackEvent(params: { type: "message" | "app_mention"; ts: string; text: string }) {
  return { type: params.type, channel: "C1", ts: params.ts, text: params.text } as never;
}

async function sendMessageEvent(handler: ReturnType<typeof createTestHandler>, ts: string) {
  await handler(createSlackEvent({ type: "message", ts, text: "hello" }), { source: "message" });
}

async function sendMentionEvent(handler: ReturnType<typeof createTestHandler>, ts: string) {
  await handler(createSlackEvent({ type: "app_mention", ts, text: "<@U_BOT> hello" }), {
    source: "app_mention",
    wasMentioned: true,
  });
}

async function createInFlightMessageScenario(ts: string) {
  let resolveMessagePrepare: ((value: unknown) => void) | undefined;
  const messagePrepare = new Promise<unknown>((resolve) => {
    resolveMessagePrepare = resolve;
  });
  prepareSlackMessageMock.mockImplementation(async ({ opts }) => {
    if (opts.source === "message") {
      return messagePrepare;
    }
    return { ctxPayload: {} };
  });

  const handler = createTestHandler();
  const messagePending = handler(createSlackEvent({ type: "message", ts, text: "hello" }), {
    source: "message",
  });
  await Promise.resolve();

  return { handler, messagePending, resolveMessagePrepare };
}

describe("createSlackMessageHandler app_mention race handling", () => {
  beforeAll(async () => {
    ({ createSlackMessageHandler, SlackRetryableInboundError } =
      await import("./message-handler.js"));
    ({ clearSlackInboundDeliveryStateForTest } = await import("./inbound-delivery-state.js"));
    ({ clearSlackRuntime, setSlackRuntime } = await import("../runtime.js"));
  });

  beforeEach(() => {
    prepareSlackMessageMock.mockReset();
    dispatchPreparedSlackMessageMock.mockReset();
    clearSlackInboundDeliveryStateForTest();
    clearSlackRuntime();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows a single app_mention retry when message event was dropped before dispatch", async () => {
    prepareSlackMessageMock.mockImplementation(async ({ opts }) => {
      if (opts.source === "message") {
        return null;
      }
      return { ctxPayload: {} };
    });

    const handler = createTestHandler();

    await sendMessageEvent(handler, "1700000000.000100");
    await sendMentionEvent(handler, "1700000000.000100");
    await sendMentionEvent(handler, "1700000000.000100");

    expect(prepareSlackMessageMock).toHaveBeenCalledTimes(2);
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
  });

  it("prevents a late message copy from queuing after app_mention dispatch", async () => {
    const channelHistories = new Map<string, TestHistoryEntry[]>();
    let releaseMessagePrepare: (() => void) | undefined;
    const messagePrepareGate = new Promise<void>((resolve) => {
      releaseMessagePrepare = resolve;
    });
    prepareSlackMessageMock.mockImplementation(async ({ ctx, message, opts }) => {
      if (opts.source === "message") {
        await messagePrepareGate;
        if (opts.shouldRecordDroppedHistory?.() !== false) {
          ctx.channelHistories.set("history", [
            { sender: "Alice", body: "<@U_BOT> hello", messageId: message.ts ?? "unknown" },
          ]);
        }
        return null;
      }
      return { ctxPayload: {} };
    });
    const handler = createTestHandler({ botUserId: "", channelHistories });

    const messagePending = sendMessageEvent(handler, "1700000000.000120");
    await Promise.resolve();
    await sendMentionEvent(handler, "1700000000.000120");
    releaseMessagePrepare?.();
    await messagePending;

    expect(channelHistories.get("history") ?? []).toEqual([]);
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses a concurrent message copy while app_mention is preparing", async () => {
    let shouldRecordDroppedHistory: (() => boolean) | undefined;
    let signalMessagePrepareStarted: (() => void) | undefined;
    const messagePrepareStarted = new Promise<void>((resolve) => {
      signalMessagePrepareStarted = resolve;
    });
    let releaseMessagePrepare: (() => void) | undefined;
    const messagePrepareGate = new Promise<void>((resolve) => {
      releaseMessagePrepare = resolve;
    });
    prepareSlackMessageMock.mockImplementation(async ({ opts }) => {
      if (opts.source === "message") {
        shouldRecordDroppedHistory = opts.shouldRecordDroppedHistory;
        signalMessagePrepareStarted?.();
        await messagePrepareGate;
        return null;
      }
      expect(shouldRecordDroppedHistory?.()).toBe(false);
      return { ctxPayload: {} };
    });
    const handler = createTestHandler({ botUserId: "" });

    const messagePending = sendMessageEvent(handler, "1700000000.000130");
    await messagePrepareStarted;
    await sendMentionEvent(handler, "1700000000.000130");
    releaseMessagePrepare?.();
    await messagePending;

    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
  });

  it("does not retain app_mention retry allowance when the current clock is not a valid date timestamp", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    prepareSlackMessageMock.mockImplementation(async ({ opts }) => {
      if (opts.source === "message") {
        return null;
      }
      return { ctxPayload: {} };
    });

    const handler = createTestHandler();

    await sendMessageEvent(handler, "1700000000.000125");
    nowSpy.mockReturnValue(1_700_000_000_000);
    await sendMentionEvent(handler, "1700000000.000125");

    expect(prepareSlackMessageMock).toHaveBeenCalledTimes(1);
    expect(dispatchPreparedSlackMessageMock).not.toHaveBeenCalled();
  });

  it("does not retain app_mention retry allowance when the expiry timestamp would exceed the valid date range", async () => {
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    prepareSlackMessageMock.mockImplementation(async ({ opts }) => {
      if (opts.source === "message") {
        return null;
      }
      return { ctxPayload: {} };
    });

    const handler = createTestHandler();

    await sendMessageEvent(handler, "1700000000.000126");
    await sendMentionEvent(handler, "1700000000.000126");

    expect(prepareSlackMessageMock).toHaveBeenCalledTimes(1);
    expect(dispatchPreparedSlackMessageMock).not.toHaveBeenCalled();
  });

  it("allows app_mention while message handling is still in-flight, then keeps later duplicates deduped", async () => {
    const { handler, messagePending, resolveMessagePrepare } =
      await createInFlightMessageScenario("1700000000.000150");

    await sendMentionEvent(handler, "1700000000.000150");

    resolveMessagePrepare?.(null);
    await messagePending;

    await sendMentionEvent(handler, "1700000000.000150");

    expect(prepareSlackMessageMock).toHaveBeenCalledTimes(2);
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses message dispatch when app_mention already dispatched during in-flight race", async () => {
    const { handler, messagePending, resolveMessagePrepare } =
      await createInFlightMessageScenario("1700000000.000175");

    await sendMentionEvent(handler, "1700000000.000175");

    resolveMessagePrepare?.({ ctxPayload: {} });
    await messagePending;

    expect(prepareSlackMessageMock).toHaveBeenCalledTimes(2);
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
  });

  it("keeps app_mention deduped when message event already dispatched", async () => {
    prepareSlackMessageMock.mockResolvedValue({ ctxPayload: {} });

    const handler = createTestHandler();

    await sendMessageEvent(handler, "1700000000.000200");
    await sendMentionEvent(handler, "1700000000.000200");

    expect(prepareSlackMessageMock).toHaveBeenCalledTimes(1);
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
  });

  it("retries message replay after an explicit retryable dispatch failure", async () => {
    prepareSlackMessageMock.mockResolvedValue({ ctxPayload: {} });
    dispatchPreparedSlackMessageMock
      .mockRejectedValueOnce(new SlackRetryableInboundError("retry me"))
      .mockResolvedValueOnce(undefined);

    const handler = createTestHandler();

    await expect(sendMessageEvent(handler, "1700000000.000250")).rejects.toThrow("retry me");
    await expect(sendMessageEvent(handler, "1700000000.000250")).resolves.toBeUndefined();

    expect(prepareSlackMessageMock).toHaveBeenCalledTimes(2);
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(2);
  });

  it("keeps message replay deduped after a non-retryable dispatch failure", async () => {
    prepareSlackMessageMock.mockResolvedValue({ ctxPayload: {} });
    dispatchPreparedSlackMessageMock.mockRejectedValueOnce(new Error("post-send failure"));

    const handler = createTestHandler();

    await expect(sendMessageEvent(handler, "1700000000.000300")).rejects.toThrow(
      "post-send failure",
    );
    await sendMessageEvent(handler, "1700000000.000300");

    expect(prepareSlackMessageMock).toHaveBeenCalledTimes(1);
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
  });

  it("dedupes delayed app_mention replays after in-memory seen state is gone", async () => {
    const stored = new Map<string, unknown>();
    const register = vi.fn(async (key: string, value: unknown) => {
      stored.set(key, value);
    });
    const lookup = vi.fn(async (key: string) => stored.get(key));
    setSlackRuntime({
      state: {
        openKeyedStore: vi.fn(() => ({
          register,
          lookup,
          consume: vi.fn(),
          delete: vi.fn(),
          entries: vi.fn(),
          clear: vi.fn(),
        })),
      },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);
    prepareSlackMessageMock.mockResolvedValue({ ctxPayload: {} });

    await sendMessageEvent(createTestHandler(), "1700000000.000350");
    clearSlackInboundDeliveryStateForTest();
    await sendMentionEvent(createTestHandler(), "1700000000.000350");

    expect(register).toHaveBeenCalledWith("default:C1:1700000000.000350", {
      deliveredAt: expect.any(Number),
    });
    expect(lookup).toHaveBeenCalledWith("default:C1:1700000000.000350");
    expect(prepareSlackMessageMock).toHaveBeenCalledTimes(1);
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
  });
});
