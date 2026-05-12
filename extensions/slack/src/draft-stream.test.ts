import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-message";
import { describe, expect, it, vi } from "vitest";
import { createSlackDraftStream } from "./draft-stream.js";

type DraftStreamParams = Parameters<typeof createSlackDraftStream>[0];
type DraftSendFn = NonNullable<DraftStreamParams["send"]>;
type DraftEditFn = NonNullable<DraftStreamParams["edit"]>;
type DraftRemoveFn = NonNullable<DraftStreamParams["remove"]>;
type DraftWarnFn = NonNullable<DraftStreamParams["warn"]>;
type MockCalls<TArgs extends readonly unknown[]> = { mock: { calls: TArgs[] } };

const TEST_CFG = {};

function mockCalls<TArgs extends readonly unknown[]>(fn: unknown): TArgs[] {
  return (fn as MockCalls<TArgs>).mock.calls;
}

function slackDraftSendResult(messageId: string, channelId = "C123") {
  return {
    channelId,
    messageId,
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ channel: "slack", messageId, channelId }],
      kind: "preview",
    }),
  };
}

function createDraftStreamHarness(
  params: {
    maxChars?: number;
    send?: DraftSendFn;
    edit?: DraftEditFn;
    remove?: DraftRemoveFn;
    warn?: DraftWarnFn;
  } = {},
) {
  const send = params.send ?? vi.fn<DraftSendFn>(async () => slackDraftSendResult("111.222"));
  const edit = params.edit ?? vi.fn<DraftEditFn>(async () => {});
  const remove = params.remove ?? vi.fn<DraftRemoveFn>(async () => {});
  const warn = params.warn ?? vi.fn<DraftWarnFn>();
  const stream = createSlackDraftStream({
    target: "channel:C123",
    cfg: TEST_CFG,
    token: "xoxb-test",
    throttleMs: 250,
    maxChars: params.maxChars,
    send,
    edit,
    remove,
    warn,
  });
  return { stream, send, edit, remove, warn };
}

describe("createSlackDraftStream", () => {
  it("sends the first update and edits subsequent updates", async () => {
    const { stream, send, edit } = createDraftStreamHarness();

    stream.update("hello");
    await stream.flush();
    stream.update("hello world");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledWith("C123", "111.222", "hello world", {
      cfg: TEST_CFG,
      token: "xoxb-test",
      accountId: undefined,
    });
  });

  it("sends and edits rich draft blocks with text fallback", async () => {
    const { stream, send, edit } = createDraftStreamHarness();
    const blocks = [{ type: "divider" }] as const;

    stream.update({ text: "fallback", blocks: [...blocks] });
    await stream.flush();
    stream.update({ text: "updated fallback", blocks: [...blocks] });
    await stream.flush();

    const sendCall = mockCalls<Parameters<DraftSendFn>>(send)[0];
    expect(sendCall?.[0]).toBe("channel:C123");
    expect(sendCall?.[1]).toBe("fallback");
    expect((sendCall?.[2] as { blocks?: unknown } | undefined)?.blocks).toEqual([...blocks]);

    const editCall = mockCalls<Parameters<DraftEditFn>>(edit)[0];
    expect(editCall?.[0]).toBe("C123");
    expect(editCall?.[1]).toBe("111.222");
    expect(editCall?.[2]).toBe("updated fallback");
    expect((editCall?.[3] as { blocks?: unknown } | undefined)?.blocks).toEqual([...blocks]);
  });

  it("forwards identity to the initial send call", async () => {
    const identity = { username: "test-agent", iconEmoji: ":robot_face:" };
    const send = vi.fn<DraftSendFn>(async () => slackDraftSendResult("111.222"));
    const stream = createSlackDraftStream({
      target: "channel:C123",
      cfg: TEST_CFG,
      token: "xoxb-test",
      throttleMs: 250,
      identity,
      send,
      edit: vi.fn<DraftEditFn>(async () => {}),
      remove: vi.fn<DraftRemoveFn>(async () => {}),
    });

    stream.update("hello");
    await stream.flush();

    const sendCall = mockCalls<Parameters<DraftSendFn>>(send)[0];
    expect(sendCall?.[0]).toBe("channel:C123");
    expect(sendCall?.[1]).toBe("hello");
    expect((sendCall?.[2] as { identity?: unknown } | undefined)?.identity).toEqual(identity);
  });

  it("does not send duplicate text", async () => {
    const { stream, send, edit } = createDraftStreamHarness();

    stream.update("same");
    await stream.flush();
    stream.update("same");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(0);
  });

  it("supports forceNewMessage for subsequent assistant messages", async () => {
    const send = vi
      .fn<DraftSendFn>()
      .mockResolvedValueOnce(slackDraftSendResult("111.222"))
      .mockResolvedValueOnce(slackDraftSendResult("333.444"));
    const { stream, edit } = createDraftStreamHarness({ send });

    stream.update("first");
    await stream.flush();
    stream.forceNewMessage();
    stream.update("second");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(2);
    expect(edit).toHaveBeenCalledTimes(0);
    expect(stream.messageId()).toBe("333.444");
  });

  it("stops when text exceeds max chars", async () => {
    const { stream, send, edit, warn } = createDraftStreamHarness({ maxChars: 5 });

    stream.update("123456");
    await stream.flush();
    stream.update("ok");
    await stream.flush();

    expect(send).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("allows a 4205-character preview with the default max chars", async () => {
    const { stream, send, warn } = createDraftStreamHarness();
    const text = "a".repeat(4205);

    stream.update(text);
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(1);
    const sendCall = mockCalls<Parameters<DraftSendFn>>(send)[0];
    expect(sendCall?.[0]).toBe("channel:C123");
    expect(sendCall?.[1]).toBe(text);
    expect((sendCall?.[2] as { token?: string } | undefined)?.token).toBe("xoxb-test");
    expect(warn).not.toHaveBeenCalled();
  });

  it("clear removes preview message when one exists", async () => {
    const { stream, remove } = createDraftStreamHarness();

    stream.update("hello");
    await stream.flush();
    await stream.clear();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("C123", "111.222", {
      token: "xoxb-test",
      accountId: undefined,
    });
    expect(stream.messageId()).toBeUndefined();
    expect(stream.channelId()).toBeUndefined();
  });

  it("discardPending stops late updates without deleting the visible preview", async () => {
    const { stream, send, edit, remove } = createDraftStreamHarness();

    stream.update("hello");
    await stream.flush();
    await stream.discardPending();
    stream.update("late");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(stream.messageId()).toBe("111.222");
    expect(stream.channelId()).toBe("C123");
  });

  it("clear is a no-op when no preview message exists", async () => {
    const { stream, remove } = createDraftStreamHarness();

    await stream.clear();

    expect(remove).not.toHaveBeenCalled();
  });

  it("clear warns when cleanup fails", async () => {
    const remove = vi.fn<DraftRemoveFn>(async () => {
      throw new Error("cleanup failed");
    });
    const warn = vi.fn<DraftWarnFn>();
    const { stream } = createDraftStreamHarness({ remove, warn });

    stream.update("hello");
    await stream.flush();
    await stream.clear();

    expect(warn).toHaveBeenCalledWith("slack stream preview cleanup failed: cleanup failed");
    expect(stream.messageId()).toBeUndefined();
    expect(stream.channelId()).toBeUndefined();
  });
});
