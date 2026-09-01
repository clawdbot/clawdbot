// Slack tests cover draft stream plugin behavior.
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it, vi } from "vitest";
import { noteSlackDraftConversationMessage } from "./draft-message-boundaries.js";
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
    accountId?: string;
    maxChars?: number;
    threadTs?: string;
    send?: DraftSendFn;
    edit?: DraftEditFn;
    eventScope?: DraftStreamParams["eventScope"];
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
    accountId: params.accountId,
    conversationChannelId: "C123",
    throttleMs: 250,
    maxChars: params.maxChars,
    eventScope: params.eventScope,
    resolveThreadTs: params.threadTs ? () => params.threadTs : undefined,
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

  it("uses the enterprise event client for draft writes", async () => {
    const client = {} as NonNullable<DraftStreamParams["eventScope"]>["client"];
    const eventScope = {
      teamId: "T_TEST",
      client,
    };
    const { stream, send, edit, remove } = createDraftStreamHarness({ eventScope });

    stream.update("hello");
    await stream.flush();
    stream.update("hello world");
    await stream.flush();
    await stream.clear();

    expect(send).toHaveBeenCalledWith(
      "channel:C123",
      "hello",
      expect.objectContaining({ eventScope }),
    );
    expect(edit).toHaveBeenCalledWith(
      "C123",
      "111.222",
      "hello world",
      expect.objectContaining({ client }),
    );
    expect(remove).toHaveBeenCalledWith("C123", "111.222", expect.objectContaining({ client }));
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

  it("edits changed blocks even when fallback text is unchanged", async () => {
    const { stream, edit } = createDraftStreamHarness();
    const firstBlocks = [{ type: "divider" }] as const;
    const latestBlocks = [{ type: "section", text: { type: "mrkdwn", text: "latest" } }] as const;

    stream.update({ text: "same fallback", blocks: [...firstBlocks] });
    await stream.flush();
    stream.update({ text: "same fallback", blocks: [...latestBlocks] });
    await stream.flush();

    const editCall = mockCalls<Parameters<DraftEditFn>>(edit)[0];
    expect(editCall?.[2]).toBe("same fallback");
    expect((editCall?.[3] as { blocks?: unknown } | undefined)?.blocks).toEqual([...latestBlocks]);
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

  it("drains past a failed preview and retries only the retained failure", async () => {
    const send = vi
      .fn<DraftSendFn>()
      .mockResolvedValueOnce(slackDraftSendResult("100.100"))
      .mockResolvedValueOnce(slackDraftSendResult("100.300"));
    const remove = vi.fn<DraftRemoveFn>(async () => {});
    remove.mockRejectedValueOnce(new Error("cleanup failed"));
    const { stream } = createDraftStreamHarness({ send, remove });
    const removedMessageIds = () =>
      mockCalls<Parameters<DraftRemoveFn>>(remove).map(([, messageId]) => messageId);

    for (const text of ["first", "second"]) {
      stream.update(text);
      await stream.flush();
      stream.forceNewMessage();
    }
    await stream.dropDetachedMessages();
    expect(removedMessageIds()).toEqual(["100.100", "100.300"]);

    await stream.dropDetachedMessages();
    expect(removedMessageIds()).toEqual(["100.100", "100.300", "100.100"]);
  });

  it("drains previews detached during an in-flight removal", async () => {
    const accountId = "detach-during-drop";
    let finishFirstRemove: (() => void) | undefined;
    const firstRemove = new Promise<void>((resolve) => {
      finishFirstRemove = resolve;
    });
    const send = vi
      .fn<DraftSendFn>()
      .mockResolvedValueOnce(slackDraftSendResult("100.100"))
      .mockResolvedValueOnce(slackDraftSendResult("100.300"));
    const remove = vi
      .fn<DraftRemoveFn>()
      .mockImplementationOnce(async () => await firstRemove)
      .mockResolvedValueOnce(undefined);
    const { stream } = createDraftStreamHarness({
      accountId,
      threadTs: "100.000",
      send,
      remove,
    });

    stream.update("_first card_");
    await stream.flush();
    noteSlackDraftConversationMessage({
      accountId,
      channelId: "C123",
      threadTs: "100.000",
      messageTs: "100.200",
      userId: "U_OWNER",
    });

    const dropping = stream.dropDetachedMessages();
    await vi.waitFor(() => {
      expect(remove).toHaveBeenCalledOnce();
    });

    stream.update("_second card_");
    await stream.flush();
    noteSlackDraftConversationMessage({
      accountId,
      channelId: "C123",
      threadTs: "100.000",
      messageTs: "100.400",
      userId: "U_OWNER",
    });

    finishFirstRemove?.();
    await dropping;

    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenNthCalledWith(1, "C123", "100.100", {
      token: "xoxb-test",
      accountId,
    });
    expect(remove).toHaveBeenNthCalledWith(2, "C123", "100.300", {
      token: "xoxb-test",
      accountId,
    });
  });

  it("does not drop a finalized preview after forceNewMessage", async () => {
    const { stream, remove } = createDraftStreamHarness();

    stream.update("finished");
    await stream.flush();
    await stream.seal();
    await expect(stream.finalizeMessage("111.222", async () => {})).resolves.toBe(true);
    stream.forceNewMessage();
    await stream.dropDetachedMessages();

    expect(remove).not.toHaveBeenCalled();
  });

  it("does not issue wire calls when no detached preview exists", async () => {
    const { stream, send, edit, remove } = createDraftStreamHarness();

    await stream.dropDetachedMessages();

    expect(send).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("rearms updates after sealing and finalizing the previous message", async () => {
    const send = vi
      .fn<DraftSendFn>()
      .mockResolvedValueOnce(slackDraftSendResult("111.222"))
      .mockResolvedValueOnce(slackDraftSendResult("333.444"));
    const { stream } = createDraftStreamHarness({ send });

    stream.update("first card");
    await stream.flush();
    await stream.seal();
    await expect(stream.finalizeMessage("111.222", async () => {})).resolves.toBe(true);
    stream.forceNewMessage();
    stream.update("second card");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(2);
    expect(stream.messageId()).toBe("333.444");
  });

  it("continues below a human message that interrupts an in-progress Slack reply", async () => {
    const accountId = "interrupted-reply";
    const send = vi
      .fn<DraftSendFn>()
      .mockResolvedValueOnce(slackDraftSendResult("100.100"))
      .mockResolvedValueOnce(slackDraftSendResult("100.300"));
    const { stream, edit, remove } = createDraftStreamHarness({
      accountId,
      threadTs: "100.000",
      send,
    });

    stream.update("_looking into the original question_");
    await stream.flush();

    noteSlackDraftConversationMessage({
      accountId,
      channelId: "C123",
      threadTs: "100.000",
      messageTs: "100.200",
      userId: "U_OWNER",
      botUserId: "U_BOT",
    });

    expect(stream.messageId()).toBeUndefined();
    expect(remove).not.toHaveBeenCalled();

    stream.update("_incorporating your clarification_");
    await stream.flush();
    stream.update("_checking one last detail_");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(2);
    expect(edit).toHaveBeenCalledWith(
      "C123",
      "100.300",
      "_checking one last detail_",
      expect.objectContaining({ accountId }),
    );
    expect(stream.messageId()).toBe("100.300");
  });

  it("keeps moving below repeated interruptions from different participants", async () => {
    const accountId = "multiple-participants";
    const send = vi
      .fn<DraftSendFn>()
      .mockResolvedValueOnce(slackDraftSendResult("100.100"))
      .mockResolvedValueOnce(slackDraftSendResult("100.300"))
      .mockResolvedValueOnce(slackDraftSendResult("100.500"));
    const { stream, edit, remove } = createDraftStreamHarness({
      accountId,
      threadTs: "100.000",
      send,
    });

    stream.update("_first update_");
    await stream.flush();
    noteSlackDraftConversationMessage({
      accountId,
      channelId: "C123",
      threadTs: "100.000",
      messageTs: "100.200",
      userId: "U_OWNER",
    });

    stream.update("_second update_");
    await stream.flush();
    noteSlackDraftConversationMessage({
      accountId,
      channelId: "C123",
      threadTs: "100.000",
      messageTs: "100.400",
      userId: "U_COLLEAGUE",
    });

    stream.update("_third update_");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(3);
    expect(edit).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(stream.messageId()).toBe("100.500");
  });

  it("reconciles an interruption received before Slack returns the first preview id", async () => {
    const accountId = "interruption-during-send";
    let finishFirstSend: ((value: ReturnType<typeof slackDraftSendResult>) => void) | undefined;
    const firstSend = new Promise<ReturnType<typeof slackDraftSendResult>>((resolve) => {
      finishFirstSend = resolve;
    });
    const send = vi
      .fn<DraftSendFn>()
      .mockImplementationOnce(async () => await firstSend)
      .mockResolvedValueOnce(slackDraftSendResult("100.300"));
    const { stream, edit, remove } = createDraftStreamHarness({
      accountId,
      threadTs: "100.000",
      send,
    });

    stream.update("_checking the original request_");
    const firstFlush = stream.flush();
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledOnce();
    });

    noteSlackDraftConversationMessage({
      accountId,
      channelId: "C123",
      threadTs: "100.000",
      messageTs: "100.200",
      userId: "U_OWNER",
    });
    finishFirstSend?.(slackDraftSendResult("100.100"));
    await firstFlush;

    expect(stream.messageId()).toBeUndefined();
    expect(remove).not.toHaveBeenCalled();

    stream.update("_incorporating the newer clarification_");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(2);
    expect(edit).not.toHaveBeenCalled();
    expect(stream.messageId()).toBe("100.300");
  });

  it("keeps direct-message previews after the latest unthreaded human message", async () => {
    const accountId = "unthreaded-direct-message";
    const send = vi
      .fn<DraftSendFn>()
      .mockResolvedValueOnce(slackDraftSendResult("100.100"))
      .mockResolvedValueOnce(slackDraftSendResult("100.300"));
    const { stream } = createDraftStreamHarness({ accountId, send });

    stream.update("_looking into this_");
    await stream.flush();
    noteSlackDraftConversationMessage({
      accountId,
      channelId: "C123",
      messageTs: "100.200",
      userId: "U_OWNER",
    });
    stream.update("_looking into this_");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(2);
    expect(stream.messageId()).toBe("100.300");
  });

  it("keeps simultaneous Enterprise Grid conversations isolated by workspace", async () => {
    const accountId = "enterprise-grid";
    const eventScope = {
      teamId: "T_FIRST",
      client: {} as NonNullable<DraftStreamParams["eventScope"]>["client"],
    };
    const send = vi
      .fn<DraftSendFn>()
      .mockResolvedValueOnce(slackDraftSendResult("100.100"))
      .mockResolvedValueOnce(slackDraftSendResult("100.300"));
    const { stream, edit } = createDraftStreamHarness({
      accountId,
      eventScope,
      threadTs: "100.000",
      send,
    });

    stream.update("_first workspace_");
    await stream.flush();
    noteSlackDraftConversationMessage({
      accountId,
      teamId: "T_SECOND",
      channelId: "C123",
      threadTs: "100.000",
      messageTs: "100.200",
      userId: "U_OTHER_WORKSPACE",
    });
    stream.update("_still in the first workspace_");
    await stream.flush();

    expect(send).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledOnce();

    noteSlackDraftConversationMessage({
      accountId,
      teamId: "T_FIRST",
      channelId: "C123",
      threadTs: "100.000",
      messageTs: "100.200",
      userId: "U_OWNER",
    });
    stream.update("_after the real interruption_");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(2);
    expect(stream.messageId()).toBe("100.300");
  });

  it("ignores older, duplicate, unrelated, and bot-authored conversation events", async () => {
    const accountId = "irrelevant-events";
    const { stream, send, edit } = createDraftStreamHarness({
      accountId,
      threadTs: "100.000",
    });

    stream.update("_still working_");
    await stream.flush();

    for (const event of [
      { channelId: "C123", threadTs: "100.000", messageTs: "111.111", userId: "U_OWNER" },
      { channelId: "C123", threadTs: "100.000", messageTs: "111.222", userId: "U_OWNER" },
      { channelId: "C123", threadTs: "200.000", messageTs: "111.333", userId: "U_OWNER" },
      { channelId: "C_OTHER", threadTs: "100.000", messageTs: "111.333", userId: "U_OWNER" },
      {
        channelId: "C123",
        threadTs: "100.000",
        messageTs: "111.333",
        userId: "U_BOT",
        botUserId: "U_BOT",
      },
      {
        channelId: "C123",
        threadTs: "100.000",
        messageTs: "111.333",
        userId: "U_OTHER_BOT",
        botId: "B_OTHER",
      },
    ]) {
      noteSlackDraftConversationMessage({ accountId, ...event });
    }

    stream.update("_latest update_");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledOnce();
    expect(stream.messageId()).toBe("111.222");
  });

  it("continues observing conversation boundaries while the final preview edit is in flight", async () => {
    const accountId = "interrupted-final-edit";
    let finishFinalEdit: (() => void) | undefined;
    const finalEdit = new Promise<void>((resolve) => {
      finishFinalEdit = resolve;
    });
    const { stream, edit, remove } = createDraftStreamHarness({
      accountId,
      threadTs: "100.000",
    });

    stream.update("_checking the last detail_");
    await stream.flush();
    await stream.seal();
    const finalizing = stream.finalizeMessage("111.222", async () => {
      await finalEdit;
    });

    noteSlackDraftConversationMessage({
      accountId,
      channelId: "C123",
      threadTs: "100.000",
      messageTs: "111.333",
      userId: "U_OWNER",
    });
    finishFinalEdit?.();

    await expect(finalizing).resolves.toBe(false);
    expect(stream.messageId()).toBeUndefined();
    expect(remove).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledWith(
      "C123",
      "111.222",
      "_checking the last detail_",
      expect.objectContaining({ accountId }),
    );
  });

  it("does not finalize a preview invalidated while the stream was being sealed", async () => {
    const accountId = "interrupted-sealed-preview";
    const { stream, edit } = createDraftStreamHarness({ accountId, threadTs: "100.000" });
    const finalize = vi.fn(async () => {});

    stream.update("_nearly finished_");
    await stream.flush();
    await stream.seal();
    noteSlackDraftConversationMessage({
      accountId,
      channelId: "C123",
      threadTs: "100.000",
      messageTs: "111.333",
      userId: "U_OWNER",
    });

    await expect(stream.finalizeMessage("111.222", finalize)).resolves.toBe(false);
    expect(finalize).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
  });

  it("stops observing conversation boundaries once the preview is finalized", async () => {
    const accountId = "finalized-preview";
    const { stream } = createDraftStreamHarness({ accountId, threadTs: "100.000" });

    stream.update("_finished_");
    await stream.flush();
    await stream.seal();
    await stream.finalizeMessage("111.222", async () => {});

    noteSlackDraftConversationMessage({
      accountId,
      channelId: "C123",
      threadTs: "100.000",
      messageTs: "111.333",
      userId: "U_OWNER",
    });

    expect(stream.messageId()).toBe("111.222");
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

  it("retries a failed active preview cleanup on the next clear", async () => {
    const remove = vi.fn<DraftRemoveFn>(async () => {});
    remove.mockRejectedValueOnce(new Error("cleanup failed"));
    const warn = vi.fn<DraftWarnFn>();
    const { stream } = createDraftStreamHarness({ remove, warn });

    stream.update("hello");
    await stream.flush();
    await stream.clear();
    await stream.clear();

    expect(remove).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("slack stream preview cleanup failed: cleanup failed");
  });
});
