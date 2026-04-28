import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const prepareSlackMessageMock =
  vi.fn<
    (params: {
      opts: { source: "message" | "app_mention"; wasMentioned?: boolean };
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

function createTestHandler() {
  const seenMessages = createMarkMessageSeen();
  return createSlackMessageHandler({
    ctx: {
      cfg: {},
      accountId: "default",
      app: { client: {} },
      runtime: {},
      markMessageSeen: seenMessages.markMessageSeen,
      releaseSeenMessage: seenMessages.releaseSeenMessage,
    } as Parameters<typeof createSlackMessageHandler>[0]["ctx"],
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
  });

  beforeEach(() => {
    prepareSlackMessageMock.mockReset();
    dispatchPreparedSlackMessageMock.mockReset();
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
});
