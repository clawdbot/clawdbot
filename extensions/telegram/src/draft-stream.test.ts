// Telegram tests cover draft stream plugin behavior.
import type { Bot } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramDraftStream } from "./draft-stream.js";
import {
  markdownToTelegramChunks,
  renderTelegramHtmlText,
  telegramHtmlToPlainTextFallback,
} from "./format.js";
import { buildTelegramRichMarkdown, type TelegramInputRichMessage } from "./rich-message.js";

type TelegramDraftStreamParams = Parameters<typeof createTelegramDraftStream>[0];
type MockSendMessage = (
  chatId: string | number,
  text: string,
  params?: Record<string, unknown>,
) => Promise<{ message_id: number }>;
type MockSendRichMessage = (params: {
  rich_message?: TelegramInputRichMessage;
}) => Promise<{ message_id: number }>;

function createMockDraftApi(sendMessageImpl?: () => Promise<{ message_id: number }>) {
  const resolveSend = sendMessageImpl ?? (async () => ({ message_id: 17 }));
  const sendRichMessage = vi.fn<MockSendRichMessage>(async () => await resolveSend());
  const editRichMessageText = vi.fn().mockResolvedValue(true);
  return {
    sendMessage: vi.fn<MockSendMessage>(async () => await resolveSend()),
    editMessageText: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
    raw: {
      sendRichMessage,
      editMessageText: editRichMessageText,
    },
  };
}

function createForumDraftStream(api: ReturnType<typeof createMockDraftApi>) {
  return createThreadedDraftStream(api, { id: 99, scope: "forum" });
}

function createThreadedDraftStream(
  api: ReturnType<typeof createMockDraftApi>,
  thread: { id: number; scope: "forum" | "dm" },
) {
  return createDraftStream(api, { thread });
}

function createDraftStream(
  api: ReturnType<typeof createMockDraftApi>,
  overrides: Omit<Partial<TelegramDraftStreamParams>, "api" | "chatId"> = {},
) {
  return createTelegramDraftStream({
    api: api as unknown as Bot["api"],
    chatId: 123,
    ...overrides,
  });
}

async function expectInitialForumSend(
  api: ReturnType<typeof createMockDraftApi>,
  text = "Hello",
): Promise<void> {
  await vi.waitFor(() =>
    expect(api.sendMessage).toHaveBeenCalledWith(123, text, {
      message_thread_id: 99,
    }),
  );
}

function expectPreviewSend(
  api: ReturnType<typeof createMockDraftApi>,
  text: string,
  params: Record<string, unknown> = {},
) {
  expect(api.sendMessage).toHaveBeenCalledWith(123, text, params);
}

function expectNthPreviewSend(
  api: ReturnType<typeof createMockDraftApi>,
  call: number,
  text: string,
  params: Record<string, unknown> = {},
) {
  expect(api.sendMessage).toHaveBeenNthCalledWith(call, 123, text, params);
}

function requireSendMessageCallText(
  api: ReturnType<typeof createMockDraftApi>,
  callIndex: number,
): string {
  const calls = api.sendMessage.mock.calls as unknown[][];
  const call = calls[callIndex];
  expect(call, `sendMessage call ${callIndex}`).toBeDefined();
  const text = call?.[1];
  expect(typeof text).toBe("string");
  return typeof text === "string" ? text : "";
}

function expectPreviewEdit(
  api: ReturnType<typeof createMockDraftApi>,
  text: string,
  params?: Record<string, unknown>,
) {
  if (params) {
    expect(api.editMessageText).toHaveBeenCalledWith(123, 17, text, params);
    return;
  }
  expect(api.editMessageText).toHaveBeenCalledWith(123, 17, text);
}

function createForceNewMessageHarness(params: { throttleMs?: number } = {}) {
  const api = createMockDraftApi();
  api.sendMessage
    .mockResolvedValueOnce({ message_id: 17 })
    .mockResolvedValueOnce({ message_id: 42 });
  const stream = createDraftStream(
    api,
    params.throttleMs != null ? { throttleMs: params.throttleMs } : {},
  );
  return { api, stream };
}

describe("createTelegramDraftStream", () => {
  it("sends stream preview message with message_thread_id when provided", async () => {
    const api = createMockDraftApi();
    const stream = createForumDraftStream(api);

    stream.update("Hello");
    await expectInitialForumSend(api);
  });

  it("edits existing stream preview message on subsequent updates", async () => {
    const api = createMockDraftApi();
    const stream = createForumDraftStream(api);

    stream.update("Hello");
    await expectInitialForumSend(api);
    await (api.sendMessage.mock.results[0]?.value as Promise<unknown>);

    stream.update("Hello again");
    await stream.flush();

    expectPreviewEdit(api, "Hello again");
  });

  it("waits for in-flight updates before final flush edit", async () => {
    let resolveSend: ((value: { message_id: number }) => void) | undefined;
    const firstSend = new Promise<{ message_id: number }>((resolve) => {
      resolveSend = resolve;
    });
    const api = createMockDraftApi(() => firstSend);
    const stream = createForumDraftStream(api);

    stream.update("Hello");
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    stream.update("Hello final");
    const flushPromise = stream.flush();
    expect(api.editMessageText).not.toHaveBeenCalled();

    resolveSend?.({ message_id: 17 });
    await flushPromise;

    expectPreviewEdit(api, "Hello final");
  });

  it("omits message_thread_id for general topic id", async () => {
    const api = createMockDraftApi();
    const stream = createThreadedDraftStream(api, { id: 1, scope: "forum" });

    stream.update("Hello");

    await vi.waitFor(() => expectPreviewSend(api, "Hello"));
  });

  it("uses text send/edit for dm thread previews", async () => {
    const api = createMockDraftApi();
    const stream = createThreadedDraftStream(api, { id: 42, scope: "dm" });

    stream.update("Hello");
    await vi.waitFor(() => expectPreviewSend(api, "Hello", { message_thread_id: 42 }));
    expect(api.editMessageText).not.toHaveBeenCalled();

    stream.update("Hello again");
    await stream.flush();

    expectPreviewEdit(api, "Hello again");
  });

  it.each(["forum", "dm"] as const)(
    "does not retry %s message preview sends without the topic id",
    async (scope) => {
      const api = createMockDraftApi();
      api.sendMessage.mockRejectedValueOnce(
        new Error("400: Bad Request: message thread not found"),
      );
      const warn = vi.fn();
      const stream = createDraftStream(api, {
        thread: { id: 42, scope },
        warn,
      });

      stream.update("Hello");
      await stream.flush();

      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      expectPreviewSend(api, "Hello", { message_thread_id: 42 });
      expect(warn).toHaveBeenCalledWith(
        "telegram stream preview failed: 400: Bad Request: message thread not found",
      );
      expect(
        warn.mock.calls.some(([message]) => String(message).includes("retrying without thread")),
      ).toBe(false);
    },
  );

  it("does not finalize stale preview text after a stopped send failure", async () => {
    const api = createMockDraftApi();
    api.sendMessage.mockRejectedValueOnce(new Error("temporary send failure"));
    const warn = vi.fn();
    const stream = createDraftStream(api, { warn });

    stream.update("Hello");
    await stream.flush();
    await stream.stop();

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expectPreviewSend(api, "Hello");
    expect(warn).toHaveBeenCalledWith("telegram stream preview failed: temporary send failure");
  });

  it("keeps allow_sending_without_reply on message previews that target a reply", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api, {
      thread: { id: 42, scope: "dm" },
      replyToMessageId: 411,
    });

    stream.update("Hello");
    await stream.flush();

    expectPreviewSend(api, "Hello", {
      message_thread_id: 42,
      reply_parameters: {
        message_id: 411,
        allow_sending_without_reply: true,
      },
    });
  });

  it("converts <br> joins to newlines before parse_mode=HTML transport", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api, {
      // Progress drafts join rendered lines with <br>; Bot API parse_mode=HTML
      // has no <br> tag, so sending it verbatim 400s every multi-line edit and
      // drops the preview to the unformatted plain fallback.
      renderText: (text) => ({
        text: `<b>Shelling</b><br>🧠 <i>${text}</i>`,
        parseMode: "HTML",
      }),
    });

    stream.update("Thinking");
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledWith(123, "<b>Shelling</b>\n🧠 <i>Thinking</i>", {
      parse_mode: "HTML",
    });
  });

  it("finalizeToPreview edits the live window message in place without deleting", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api, { thread: { id: 42, scope: "dm" } });

    stream.update("🛠️ Exec: pnpm test");
    await stream.flush();
    const messageId = await stream.finalizeToPreview({ text: "🛠️ 1 tool call · ⏱️ 1s" });

    expect(messageId).toBe(17);
    // The window message is EDITED into the bar, never deleted (no focus-jump).
    expect(api.editMessageText).toHaveBeenCalledWith(123, 17, "🛠️ 1 tool call · ⏱️ 1s");
    expect(api.deleteMessage).not.toHaveBeenCalled();
  });

  it("finalizeToPreview materializes a still-pending window before editing", async () => {
    // A throttled preview may not have been sent yet when the collapse runs;
    // finalizeToPreview must send it first so there is a message to edit into
    // the bar, rather than returning undefined and forcing a delete + repost.
    const api = createMockDraftApi();
    const stream = createDraftStream(api, {
      thread: { id: 42, scope: "dm" },
      throttleMs: 10_000,
    });

    stream.update("🛠️ Exec: pnpm test");
    const messageId = await stream.finalizeToPreview({ text: "🛠️ 1 tool call · ⏱️ 1s" });

    expect(messageId).toBe(17);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.deleteMessage).not.toHaveBeenCalled();
  });

  it("finalizeToPreview returns undefined when no window ever rendered", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api, { thread: { id: 42, scope: "dm" } });

    const messageId = await stream.finalizeToPreview({ text: "🛠️ 1 tool call · ⏱️ 1s" });

    expect(messageId).toBeUndefined();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.deleteMessage).not.toHaveBeenCalled();
  });

  it("finalizeToPreview returns undefined when the in-place collapse edit does not apply", async () => {
    // Red-team F2: a flood-wait (429) on the collapse edit makes the underlying
    // send return false without applying. finalizeToPreview must report that as
    // "not collapsed in place" (undefined) so the dispatch falls back to posting
    // a durable bar — otherwise it assumes success, clears state, posts no bar,
    // and the tall window is left on screen.
    const api = createMockDraftApi();
    api.editMessageText.mockRejectedValueOnce(
      Object.assign(
        new Error("Call to 'editMessageText' failed! (429: Too Many Requests: retry after 5)"),
        { error_code: 429, parameters: { retry_after: 5 } },
      ),
    );
    const stream = createDraftStream(api, { thread: { id: 42, scope: "dm" } });

    stream.update("🛠️ Exec: pnpm test");
    await stream.flush();
    const messageId = await stream.finalizeToPreview({ text: "🛠️ 1 tool call · ⏱️ 1s" });

    expect(messageId).toBeUndefined();
    expect(api.editMessageText).toHaveBeenCalledTimes(1);
    // The live window is NOT deleted (the caller posts the bar below it instead).
    expect(api.deleteMessage).not.toHaveBeenCalled();
  });

  it("does not replay a rejected pending edit after collapse fallback", async () => {
    const api = createMockDraftApi();
    const retryableEditError = () =>
      Object.assign(new Error("429: retry after 1"), {
        error_code: 429,
        parameters: { retry_after: 1 },
      });
    const stream = createDraftStream(api, { thread: { id: 42, scope: "dm" } });

    stream.update("working");
    await stream.flush();
    api.editMessageText
      .mockRejectedValueOnce(retryableEditError())
      .mockRejectedValueOnce(retryableEditError());
    stream.update("pending update");
    const messageId = await stream.finalizeToPreview({ text: "🛠️ 1 tool call · ⏱️ 1s" });

    expect(messageId).toBeUndefined();
    expect(api.editMessageText).toHaveBeenCalledTimes(2);
    await stream.stop();
    await stream.flush();
    expect(api.editMessageText).toHaveBeenCalledTimes(2);
  });

  it("deletes message preview on clear after finalization", async () => {
    vi.useFakeTimers();
    try {
      const api = createMockDraftApi();
      const stream = createThreadedDraftStream(api, { id: 42, scope: "dm" });

      stream.update("Hello");
      await stream.flush();
      stream.update("Hello again");
      await stream.stop();
      await stream.clear();

      expectPreviewSend(api, "Hello", { message_thread_id: 42 });
      expectPreviewEdit(api, "Hello again");
      // The delete is deferred until the preview has been on screen for the
      // dwell window; advance past it to trigger the detached cleanup.
      expect(api.deleteMessage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(api.deleteMessage).toHaveBeenCalledWith(123, 17);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["first", "batched"] as const)(
    "keeps a cleared %s reply target consumed until preview deletion is confirmed",
    async (replyToMode) => {
      vi.useFakeTimers();
      try {
        const api = createMockDraftApi();
        api.deleteMessage.mockRejectedValueOnce(new Error("delete rejected"));
        const stream = createDraftStream(api, {
          replyToMessageId: 411,
          replyToMode,
          thread: { id: 42, scope: "dm" },
        });

        stream.update("Preview");
        await stream.flush();
        expect(stream.hasConsumedReplyTarget?.()).toBe(true);

        await stream.clear();
        await vi.advanceTimersByTimeAsync(4_000);

        expect(api.deleteMessage).toHaveBeenCalledWith(123, 17);
        expect(stream.hasConsumedReplyTarget?.()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["first", "batched"] as const)(
    "reserves a pending %s reply target before Telegram accepts the preview",
    async (replyToMode) => {
      let resolveSend: ((message: { message_id: number }) => void) | undefined;
      const api = createMockDraftApi(
        () =>
          new Promise((resolve) => {
            resolveSend = resolve;
          }),
      );
      const stream = createDraftStream(api, {
        replyToMessageId: 411,
        replyToMode,
      });

      stream.update("Preview");
      const flush = stream.flush();
      await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
      expect(stream.hasConsumedReplyTarget?.()).toBe(true);

      resolveSend?.({ message_id: 17 });
      await flush;
    },
  );

  it.each(["first", "batched"] as const)(
    "rotateToNewMessageDeferringDelete reuses a %s reply target only after deleting the old message",
    async (replyToMode) => {
      vi.useFakeTimers();
      try {
        const api = createMockDraftApi();
        api.sendMessage
          .mockResolvedValueOnce({ message_id: 17 })
          .mockResolvedValueOnce({ message_id: 42 })
          .mockResolvedValueOnce({ message_id: 43 });
        const stream = createDraftStream(api, {
          replyToMessageId: 411,
          replyToMode,
          thread: { id: 42, scope: "dm" },
        });

        stream.update("🛠️ Exec");
        await stream.flush();
        expectNthPreviewSend(api, 1, "🛠️ Exec", {
          message_thread_id: 42,
          reply_parameters: {
            message_id: 411,
            allow_sending_without_reply: true,
          },
        });
        // Reposition: rewind for a new message; the old one's delete is deferred.
        const superseded = stream.rotateToNewMessageDeferringDelete();
        expect(superseded).toBe(17);

        // The replacement lands before detached cleanup, so the old message
        // still owns the single-use reply and the replacement must omit it.
        stream.update("Answer below");
        await stream.flush();
        expectNthPreviewSend(api, 2, "Answer below", {
          message_thread_id: 42,
        });
        expect(api.deleteMessage).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(4_000);
        expect(api.deleteMessage).toHaveBeenCalledWith(123, 17);
        // Only the superseded (old) message is deleted; the new one stays.
        expect(api.deleteMessage).toHaveBeenCalledTimes(1);

        // Confirmed deletion releases ownership for the next concrete message.
        stream.forceNewMessage();
        stream.update("Later answer");
        await stream.flush();
        expectNthPreviewSend(api, 3, "Later answer", {
          message_thread_id: 42,
          reply_parameters: {
            message_id: 411,
            allow_sending_without_reply: true,
          },
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("rotateToNewMessageDeferringDelete is a no-op with no live message", () => {
    const api = createMockDraftApi();
    const stream = createThreadedDraftStream(api, { id: 42, scope: "dm" });

    expect(stream.rotateToNewMessageDeferringDelete()).toBeUndefined();
    expect(api.deleteMessage).not.toHaveBeenCalled();
  });

  it.each(["first", "batched"] as const)(
    "keeps a settled %s reply target owned when reposition cleanup fails",
    async (replyToMode) => {
      vi.useFakeTimers();
      try {
        const api = createMockDraftApi();
        api.sendMessage
          .mockResolvedValueOnce({ message_id: 17 })
          .mockResolvedValueOnce({ message_id: 42 })
          .mockResolvedValueOnce({ message_id: 43 });
        api.deleteMessage.mockRejectedValueOnce(new Error("delete rejected"));
        const warn = vi.fn();
        const stream = createDraftStream(api, {
          replyToMessageId: 411,
          replyToMode,
          thread: { id: 42, scope: "dm" },
          warn,
        });

        stream.update("Old preview");
        await stream.flush();
        stream.rotateToNewMessageDeferringDelete();
        stream.update("Replacement preview");
        await stream.flush();

        expectNthPreviewSend(api, 2, "Replacement preview", { message_thread_id: 42 });
        await vi.advanceTimersByTimeAsync(4_000);
        expect(api.deleteMessage).toHaveBeenCalledWith(123, 17);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("cleanup failed"));

        // The old message remains visible, so later pages must not reuse its
        // single-use reply target after cleanup rejection.
        stream.forceNewMessage();
        stream.update("Later preview");
        await stream.flush();
        expectNthPreviewSend(api, 3, "Later preview", { message_thread_id: 42 });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["first", "batched"] as const)(
    "keeps a %s reply target on a reposition-superseded in-flight send until deletion",
    async (replyToMode) => {
      // Red-team F5: rotateToNewMessageDeferringDelete rewinds while a FIRST send is
      // still in flight (no message id yet). The late-landing message is a stale
      // preview to delete — NOT a durable content chunk to retain (that is
      // forceNewMessage's contract). Previously it retained that late send,
      // leaving a ghost bubble.
      vi.useFakeTimers();
      try {
        let resolveFirstSend: ((value: { message_id: number }) => void) | undefined;
        const firstSend = new Promise<{ message_id: number }>((resolve) => {
          resolveFirstSend = resolve;
        });
        const api = createMockDraftApi();
        api.sendMessage.mockReturnValueOnce(firstSend).mockResolvedValueOnce({ message_id: 42 });
        const onSupersededPreview = vi.fn();
        const stream = createDraftStream(api, {
          onRetainedPage: onSupersededPreview,
          replyToMessageId: 411,
          replyToMode,
          thread: { id: 42, scope: "dm" },
        });

        stream.update("Message A partial");
        await vi.advanceTimersByTimeAsync(0);
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
        expectNthPreviewSend(api, 1, "Message A partial", {
          message_thread_id: 42,
          reply_parameters: {
            message_id: 411,
            allow_sending_without_reply: true,
          },
        });

        // Reposition while the first send is still in flight, then stream on.
        stream.rotateToNewMessageDeferringDelete();
        stream.update("Message B partial");

        resolveFirstSend?.({ message_id: 17 });
        await vi.advanceTimersByTimeAsync(0);
        await stream.flush();

        // The raced first send is NOT retained as a durable chunk...
        expect(onSupersededPreview).not.toHaveBeenCalled();
        expect(api.deleteMessage).not.toHaveBeenCalled();
        // ...it is deleted deferred, so no orphaned stale bubble is left behind.
        await vi.advanceTimersByTimeAsync(4_000);
        expect(api.deleteMessage).toHaveBeenCalledWith(123, 17);
        // Until detached deletion succeeds, the stale send still owns the
        // single-use reply and the replacement must omit it.
        expectNthPreviewSend(api, 2, "Message B partial", {
          message_thread_id: 42,
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["first", "batched"] as const)(
    "keeps an in-flight %s reply target owned when reposition cleanup fails",
    async (replyToMode) => {
      vi.useFakeTimers();
      try {
        let resolveFirstSend: ((value: { message_id: number }) => void) | undefined;
        const firstSend = new Promise<{ message_id: number }>((resolve) => {
          resolveFirstSend = resolve;
        });
        const api = createMockDraftApi();
        api.sendMessage
          .mockReturnValueOnce(firstSend)
          .mockResolvedValueOnce({ message_id: 42 })
          .mockResolvedValueOnce({ message_id: 43 });
        api.deleteMessage.mockRejectedValueOnce(new Error("delete rejected"));
        const warn = vi.fn();
        const stream = createDraftStream(api, {
          replyToMessageId: 411,
          replyToMode,
          thread: { id: 42, scope: "dm" },
          warn,
        });

        stream.update("Message A partial");
        await vi.advanceTimersByTimeAsync(0);
        stream.rotateToNewMessageDeferringDelete();
        stream.update("Message B partial");
        resolveFirstSend?.({ message_id: 17 });
        await vi.advanceTimersByTimeAsync(0);
        await stream.flush();

        expectNthPreviewSend(api, 2, "Message B partial", { message_thread_id: 42 });
        await vi.advanceTimersByTimeAsync(4_000);
        expect(api.deleteMessage).toHaveBeenCalledWith(123, 17);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("cleanup failed"));

        stream.forceNewMessage();
        stream.update("Message C partial");
        await stream.flush();
        expectNthPreviewSend(api, 3, "Message C partial", { message_thread_id: 42 });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("creates new message after forceNewMessage is called", async () => {
    const { api, stream } = createForceNewMessageHarness();

    // First message
    stream.update("Hello");
    await stream.flush();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);

    // Normal edit (same message)
    stream.update("Hello edited");
    await stream.flush();
    expectPreviewEdit(api, "Hello edited");

    // Force new message (e.g. after thinking block ends)
    stream.forceNewMessage();
    stream.update("After thinking");
    await stream.flush();

    // Should have sent a second new message, not edited the first
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expectNthPreviewSend(api, 2, "After thinking");
  });

  it("creates new message after cleanup and forceNewMessage", async () => {
    vi.useFakeTimers();
    try {
      const { api, stream } = createForceNewMessageHarness();

      stream.update("Stale preview");
      await stream.flush();

      await stream.clear();
      // Delete is deferred past the dwell window; advance to trigger it.
      await vi.advanceTimersByTimeAsync(4_000);
      expect(api.deleteMessage).toHaveBeenCalledWith(123, 17);

      stream.forceNewMessage();
      stream.update("Next preview");
      await stream.flush();

      expect(api.sendMessage).toHaveBeenCalledTimes(2);
      expectNthPreviewSend(api, 2, "Next preview");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the streaming preview on screen for the dwell window before deleting", async () => {
    vi.useFakeTimers();
    try {
      const api = createMockDraftApi();
      const stream = createDraftStream(api);

      stream.update("Working");
      await stream.flush();
      // Fast turn: the preview has only been visible ~1s when the turn tears down.
      await vi.advanceTimersByTimeAsync(1_000);
      await stream.clear();

      // Delete is deferred, not synchronous, and does not fire before the 4s dwell.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(api.deleteMessage).not.toHaveBeenCalled();
      // At the dwell boundary (~4s after first appearing) the detached delete runs.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(api.deleteMessage).toHaveBeenCalledWith(123, 17);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends first update immediately after forceNewMessage within throttle window", async () => {
    vi.useFakeTimers();
    try {
      const { api, stream } = createForceNewMessageHarness({ throttleMs: 1000 });

      stream.update("Hello");
      await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));

      stream.update("Hello edited");
      expect(api.editMessageText).not.toHaveBeenCalled();

      stream.forceNewMessage();
      stream.update("Second message");
      await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(2));
      expectNthPreviewSend(api, 2, "Second message");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains an old message when forceNewMessage races an in-flight send", async () => {
    let resolveFirstSend: ((value: { message_id: number }) => void) | undefined;
    const firstSend = new Promise<{ message_id: number }>((resolve) => {
      resolveFirstSend = resolve;
    });
    const api = createMockDraftApi();
    api.sendMessage.mockReturnValueOnce(firstSend).mockResolvedValueOnce({ message_id: 42 });
    const onSupersededPreview = vi.fn();
    const stream = createDraftStream(api, {
      onRetainedPage: onSupersededPreview,
      replyToMessageId: 411,
      replyToMode: "first",
      thread: { id: 42, scope: "dm" },
    });

    stream.update("Message A partial");
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    expectNthPreviewSend(api, 1, "Message A partial", {
      message_thread_id: 42,
      reply_parameters: {
        message_id: 411,
        allow_sending_without_reply: true,
      },
    });

    stream.forceNewMessage();
    stream.update("Message B partial");

    resolveFirstSend?.({ message_id: 17 });
    await stream.flush();

    expect(onSupersededPreview).toHaveBeenCalledTimes(1);
    const [supersededPreview] = onSupersededPreview.mock.calls.at(0) ?? [];
    expect(supersededPreview).toEqual({
      messageId: 17,
      textSnapshot: "Message A partial",
      visibleSinceMs: supersededPreview.visibleSinceMs,
    });
    expect(typeof supersededPreview.visibleSinceMs).toBe("number");
    expect(Number.isFinite(supersededPreview.visibleSinceMs)).toBe(true);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expectNthPreviewSend(api, 2, "Message B partial", { message_thread_id: 42 });
    expect(api.editMessageText).not.toHaveBeenCalledWith(123, 17, "Message B partial");
  });

  it("marks sendMayHaveLanded after an ambiguous first preview send failure", async () => {
    const api = createMockDraftApi();
    api.sendMessage.mockRejectedValueOnce(new Error("timeout after Telegram accepted send"));
    const stream = createDraftStream(api);

    stream.update("Hello");
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(stream.sendMayHaveLanded?.()).toBe(true);
  });

  async function expectSendMayHaveLandedStateAfterFirstFailure(error: Error, expected: boolean) {
    const api = createMockDraftApi();
    api.sendMessage.mockRejectedValueOnce(error);
    const stream = createDraftStream(api);

    stream.update("Hello");
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(stream.sendMayHaveLanded?.()).toBe(expected);
  }

  it("retries pre-connect first preview send failures instead of stopping", async () => {
    const api = createMockDraftApi();
    api.sendMessage.mockRejectedValueOnce(
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    );
    const stream = createDraftStream(api);

    stream.update("Hello");
    await stream.flush();
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(stream.sendMayHaveLanded?.()).toBe(false);
    expect(stream.messageId()).toBe(17);
  });

  it("clears sendMayHaveLanded on Telegram 4xx client rejections", async () => {
    await expectSendMayHaveLandedStateAfterFirstFailure(
      Object.assign(new Error("403: Forbidden"), { error_code: 403 }),
      false,
    );
  });

  it("treats message-is-not-modified edits as delivered", async () => {
    const api = createMockDraftApi();
    api.editMessageText.mockRejectedValueOnce(
      Object.assign(
        new Error("Call to 'editMessageText' failed! (400: Bad Request: message is not modified)"),
        { error_code: 400 },
      ),
    );
    const warn = vi.fn();
    const stream = createDraftStream(api, { warn });

    stream.update("Hello");
    await stream.flush();
    stream.update("Hello again");
    await stream.flush();
    stream.update("Hello more");
    await stream.flush();

    expect(api.editMessageText).toHaveBeenCalledTimes(2);
    expect(api.editMessageText).toHaveBeenLastCalledWith(123, 17, "Hello more");
    expect(warn).not.toHaveBeenCalled();
  });

  it("retries the preview edit after a transient network failure", async () => {
    const api = createMockDraftApi();
    api.editMessageText.mockRejectedValueOnce(
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    );
    const warn = vi.fn();
    const stream = createDraftStream(api, { warn });

    stream.update("Hello");
    await stream.flush();
    stream.update("Hello again");
    await stream.flush();
    expect(warn).toHaveBeenCalledWith(
      "telegram stream preview edit failed (retrying): read ECONNRESET",
    );

    await stream.flush();

    expect(api.editMessageText).toHaveBeenCalledTimes(2);
    expect(api.editMessageText).toHaveBeenLastCalledWith(123, 17, "Hello again");
    expect(stream.lastDeliveredText?.()).toBe("Hello again");
  });

  it("suspends preview edits for retry_after during flood control", async () => {
    vi.useFakeTimers();
    try {
      const api = createMockDraftApi();
      api.editMessageText.mockRejectedValueOnce(
        Object.assign(
          new Error("Call to 'editMessageText' failed! (429: Too Many Requests: retry after 1)"),
          { error_code: 429, parameters: { retry_after: 1 } },
        ),
      );
      const stream = createDraftStream(api);

      stream.update("Hello");
      await stream.flush();
      stream.update("Hello again");
      await stream.flush();
      stream.update("Hello more");
      await stream.flush();
      expect(api.editMessageText).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1100);
      await stream.flush();

      expect(api.editMessageText).toHaveBeenCalledTimes(2);
      expect(api.editMessageText).toHaveBeenLastCalledWith(123, 17, "Hello more");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gates stop's initial final flush on an existing retry_after window", async () => {
    vi.useFakeTimers();
    try {
      const api = createMockDraftApi();
      api.editMessageText.mockRejectedValueOnce(
        Object.assign(new Error("429: retry after 1"), {
          error_code: 429,
          parameters: { retry_after: 1 },
        }),
      );
      const stream = createDraftStream(api);

      stream.update("Hello");
      await stream.flush();
      stream.update("Hello again");
      await stream.flush();
      stream.update("Hello final");
      await stream.flush();
      expect(api.editMessageText).toHaveBeenCalledTimes(1);

      const stopPromise = stream.stop();
      await vi.advanceTimersByTimeAsync(999);
      expect(api.editMessageText).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await stopPromise;

      expect(api.editMessageText).toHaveBeenCalledTimes(2);
      expect(api.editMessageText).toHaveBeenLastCalledWith(123, 17, "Hello final");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the preview after repeated retryable edit failures", async () => {
    const api = createMockDraftApi();
    api.editMessageText.mockRejectedValue(
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    );
    const warn = vi.fn();
    const stream = createDraftStream(api, { warn });

    stream.update("Hello");
    await stream.flush();
    stream.update("Hello again");
    await stream.flush();
    await stream.flush();
    await stream.flush();
    await stream.flush();
    await stream.flush();

    expect(api.editMessageText).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledWith("telegram stream preview failed: read ECONNRESET");
  });

  it("supports rendered previews with HTML parse mode", async () => {
    const api = createMockDraftApi();
    const stream = createTelegramDraftStream({
      api: api as unknown as Bot["api"],
      chatId: 123,
      renderText: (text) => ({ text: `<i>${text}</i>`, parseMode: "HTML" }),
    });

    stream.update("hello");
    await stream.flush();
    expect(api.sendMessage).toHaveBeenCalledWith(123, "<i>hello</i>", {
      parse_mode: "HTML",
    });

    stream.update("hello again");
    await stream.flush();
    expect(api.editMessageText).toHaveBeenCalledWith(123, 17, "<i>hello again</i>", {
      parse_mode: "HTML",
    });
  });

  it("sends caller-provided HTML previews through standard text transport", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api);

    stream.updatePreview({
      text: "<b>Shelling</b>\n<b>🛠️ Exec</b>",
      parseMode: "HTML",
    });
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledWith(123, "<b>Shelling</b>\n<b>🛠️ Exec</b>", {
      parse_mode: "HTML",
    });
    expect(api.raw.sendRichMessage).not.toHaveBeenCalled();

    stream.updatePreview({
      text: "<b>Shelling</b>\n<b>🛠️ Exec</b>\n<i>Checking files</i>",
      parseMode: "HTML",
    });
    await stream.flush();

    expect(api.editMessageText).toHaveBeenCalledWith(
      123,
      17,
      "<b>Shelling</b>\n<b>🛠️ Exec</b>\n<i>Checking files</i>",
      { parse_mode: "HTML" },
    );
    expect(api.raw.editMessageText).not.toHaveBeenCalled();
  });

  it("sends marked progress HTML previews through HTML text transport", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api);

    stream.updatePreview({
      text: "<b>Shelling</b>\n<b>🛠️ Exec</b>",
      parseMode: "HTML",
    });
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledWith(123, "<b>Shelling</b>\n<b>🛠️ Exec</b>", {
      parse_mode: "HTML",
    });
    expect(api.raw.sendRichMessage).not.toHaveBeenCalled();

    stream.updatePreview({
      text: "<b>Shelling</b>\n<b>🛠️ Exec</b>\n<b>Update</b> <code>Checking files</code>",
      parseMode: "HTML",
    });
    await stream.flush();

    expect(api.editMessageText).toHaveBeenCalledWith(
      123,
      17,
      "<b>Shelling</b>\n<b>🛠️ Exec</b>\n<b>Update</b> <code>Checking files</code>",
      { parse_mode: "HTML" },
    );
    expect(api.raw.editMessageText).not.toHaveBeenCalled();
  });

  it("falls back to plain preview text when HTML parsing fails", async () => {
    const api = createMockDraftApi();
    api.sendMessage
      .mockRejectedValueOnce(new Error("can't parse entities: unsupported tag"))
      .mockResolvedValueOnce({ message_id: 17 });
    const stream = createDraftStream(api);

    stream.updatePreview({
      text: "<b>Shelling &lt;&amp;&gt;</b>\n<b>🛠️ Exec</b>",
      parseMode: "HTML",
    });
    await stream.flush();

    expect(api.sendMessage).toHaveBeenNthCalledWith(
      1,
      123,
      "<b>Shelling &lt;&amp;&gt;</b>\n<b>🛠️ Exec</b>",
      { parse_mode: "HTML" },
    );
    expect(api.sendMessage).toHaveBeenNthCalledWith(2, 123, "Shelling <&>\n🛠️ Exec", {});
    expect(stream.currentMessageSnapshot?.()).toEqual({
      text: "Shelling <&>\n🛠️ Exec",
      sourceText: "Shelling &lt;&amp;&gt;\n🛠️ Exec",
      sourceTextMode: "html",
    });

    api.editMessageText
      .mockRejectedValueOnce(new Error("can't parse entities: unsupported tag"))
      .mockResolvedValueOnce(true);
    stream.updatePreview({
      text: "<b>Done &lt;&amp;&gt;</b>",
      parseMode: "HTML",
    });
    await stream.flush();

    expect(api.editMessageText).toHaveBeenNthCalledWith(1, 123, 17, "<b>Done &lt;&amp;&gt;</b>", {
      parse_mode: "HTML",
    });
    expect(api.editMessageText).toHaveBeenNthCalledWith(2, 123, 17, "Done <&>");
    expect(stream.currentMessageSnapshot?.()).toEqual({
      text: "Done <&>",
      sourceText: "Done &lt;&amp;&gt;",
      sourceTextMode: "html",
    });
  });

  it("uses rich send and edit for previews when explicitly enabled", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api, { richMessages: true });

    stream.update("## Plan\n\n| A |\n| --- |\n| x |");
    await stream.flush();

    expect(api.raw.sendRichMessage).toHaveBeenCalledTimes(1);
    const first = api.raw.sendRichMessage.mock.calls[0]?.[0] as {
      rich_message?: TelegramInputRichMessage;
    };
    expect(first?.rich_message?.blocks?.some((block) => block.type === "heading")).toBe(true);
    expect(first?.rich_message?.blocks?.some((block) => block.type === "table")).toBe(true);
    expect(api.sendMessage).not.toHaveBeenCalled();

    stream.update("## Plan updated\n\n| B |\n| --- |\n| y |");
    await stream.flush();

    expect(api.raw.editMessageText).toHaveBeenCalledTimes(1);
    const edit = api.raw.editMessageText.mock.calls[0]?.[0] as {
      rich_message?: TelegramInputRichMessage;
    };
    expect(edit?.rich_message?.blocks?.some((block) => block.type === "heading")).toBe(true);
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it("uses plain text when rich preview fallback sends", async () => {
    const api = createMockDraftApi();
    api.raw.sendRichMessage.mockRejectedValueOnce(
      new Error("400: Bad Request: RICH_MESSAGE_URL_INVALID"),
    );
    const warn = vi.fn();
    const stream = createDraftStream(api, { richMessages: true, warn });

    stream.update("| Rank | Model |\n| --- | --- |\n| 4 | Claude Opus |");
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const plain = api.sendMessage.mock.calls[0]?.[1] ?? "";
    expect(plain).toContain("Rank");
    expect(plain).toContain("Claude Opus");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("rich-degrade=plain-fallback:rich-entity-invalid"),
    );
  });

  it("skips rich entity detection for draft text with provider-prefixed email addresses", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api, { richMessages: true });
    const oauthProfileText =
      "OAuth profile: openai:keshavbotagent@gmail.com (keshavbotagent@gmail.com)";

    stream.update(oauthProfileText);
    await stream.flush();

    expect(api.raw.sendRichMessage).toHaveBeenCalledWith({
      chat_id: 123,
      rich_message: {
        blocks: [{ type: "paragraph", text: oauthProfileText }],
        skip_entity_detection: true,
      },
    });
  });

  it("keeps short rich previews out of plain preview gating", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api, { richMessages: true, minInitialChars: 10 });

    stream.updatePreview({
      text: "Plan",
      richMessage: { blocks: [{ type: "heading", text: "Plan", size: 2 }] },
    });
    await stream.flush();

    expect(api.raw.sendRichMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("clamps rich previews to the block limit", async () => {
    const api = createMockDraftApi();
    const text = Array.from({ length: 501 }, (_, index) => `paragraph ${index}`).join("\n\n");
    const stream = createDraftStream(api, { richMessages: true });

    stream.update(text);
    await stream.flush();

    const calls = api.raw.sendRichMessage.mock.calls as unknown[][];
    const params = calls[0]?.[0] as { rich_message?: TelegramInputRichMessage } | undefined;
    const richMessage = params?.rich_message;
    const plain = (richMessage?.blocks ?? [])
      .map((block) =>
        block.type === "paragraph" && typeof block.text === "string" ? block.text : "",
      )
      .join("\n");
    expect(plain).toContain("paragraph 499");
    expect(plain).not.toContain("paragraph 500");
  });

  it("clamps rendered previews to the text-message limit", async () => {
    const api = createMockDraftApi();
    const text = `# Long\n\n${"rich line\n".repeat(600)}`;
    const stream = createTelegramDraftStream({
      api: api as unknown as Bot["api"],
      chatId: 123,
      renderText: (value) => ({ text: value }),
    });

    stream.update(text);
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const sentText = requireSendMessageCallText(api, 0);
    expect(sentText.length).toBeLessThanOrEqual(4000);
    expect(sentText.startsWith("# Long\n\nrich line")).toBe(true);
  });

  it.each([
    {
      name: "fenced code",
      text: ["```ts", "  const one = 1;", "  const two = 2;", "  return one + two;", "```"].join(
        "\n",
      ),
      pagePattern: /^<pre><code class="language-ts">[\s\S]*<\/code><\/pre>$/u,
    },
    {
      name: "indented code",
      text: `      ${"x".repeat(120)}`,
      pagePattern: /^<pre><code>[\s\S]*<\/code><\/pre>$/u,
    },
  ])("paginates rendered $name without losing code context", async ({ text, pagePattern }) => {
    const api = createMockDraftApi();
    const onSupersededPreview = vi.fn();
    const stream = createDraftStream(api, {
      maxChars: 55,
      onRetainedPage: onSupersededPreview,
      renderText: (value) => ({
        text: renderTelegramHtmlText(value),
        parseMode: "HTML",
      }),
    });

    stream.update(text);
    await stream.stop();

    const pages = api.sendMessage.mock.calls.map((call) => call[1]);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => pagePattern.test(page))).toBe(true);
    const visiblePages = pages.map(telegramHtmlToPlainTextFallback);
    expect(visiblePages.join("")).toBe(
      telegramHtmlToPlainTextFallback(renderTelegramHtmlText(text)),
    );
    expect(onSupersededPreview.mock.calls.map(([page]) => page.textSnapshot)).toEqual(
      visiblePages.slice(0, -1),
    );
    expect(stream.currentMessageSnapshot?.()).toMatchObject({
      text: visiblePages.at(-1),
      sourceText: pages.at(-1),
      sourceTextMode: "html",
    });
  });

  // Send funnel parity (extensions/telegram/CLAUDE.md): streamed FINAL pages must
  // land on the exact chunk boundaries the durable reply funnel produces
  // (delivery.replies.ts buildChunkTextResolver -> markdownToTelegramChunks), so
  // pagination never splits mid-word, inside an HTML entity, or inside a tag.
  it.each([
    {
      boundary: "mid-word",
      maxChars: 96,
      text: Array.from(
        { length: 18 },
        (_, index) => `sesquipedalian${index} incontrovertible counterrevolutionaries`,
      ).join(" "),
    },
    {
      boundary: "mid-entity",
      maxChars: 96,
      text: Array.from({ length: 24 }, (_, index) => `alpha & beta < gamma > delta ${index}`).join(
        "\n",
      ),
    },
    {
      boundary: "mid-tag",
      maxChars: 112,
      text: Array.from(
        { length: 16 },
        (_, index) =>
          `**bold span ${index}** plus [link ${index}](https://example.com/p${index}) and \`code${index}\``,
      ).join("\n"),
    },
    {
      boundary: "code-block",
      maxChars: 128,
      text: [
        "Intro paragraph before the fence.",
        "```ts",
        ...Array.from({ length: 20 }, (_, index) => `const value${index} = compute(${index});`),
        "```",
        "Closing paragraph after the fence.",
      ].join("\n"),
    },
  ])(
    "shares durable chunk boundaries with final draft pagination ($boundary)",
    async ({ maxChars, text }) => {
      const api = createMockDraftApi();
      const expectedChunks = markdownToTelegramChunks(text, maxChars);
      // Guard the table: a case that fits in one page proves nothing about boundaries.
      expect(expectedChunks.length).toBeGreaterThan(1);
      const retainedPageTexts: string[] = [];
      const stream = createDraftStream(api, {
        maxChars,
        onRetainedPage: (page) => retainedPageTexts.push(page.textSnapshot),
        renderText: (value) => ({
          text: renderTelegramHtmlText(value),
          parseMode: "HTML",
          markdownSource: { text: value },
        }),
      });

      stream.update(text);
      await stream.stop();

      const pages = api.sendMessage.mock.calls.map((call) => call[1]);
      expect(pages).toEqual(expectedChunks.map((chunk) => chunk.html));
      // Plain-fallback parity: each page must carry the durable funnel's plainText
      // projection so an HTML-parse 400 degrades both funnels to identical text.
      expect([...retainedPageTexts, stream.currentMessageSnapshot?.()?.text]).toEqual(
        expectedChunks.map((chunk) => chunk.text),
      );
    },
  );

  it("paginates one rendered rich-code plan without reparsing Markdown tails", async () => {
    const api = createMockDraftApi();
    const onSupersededPreview = vi.fn();
    const text = [
      "```ts",
      "  const one = 1;",
      "  const two = 2;",
      "  return one + two;",
      "```",
    ].join("\n");
    const stream = createDraftStream(api, {
      // Plain code body is shorter than HTML-wrapped rich text; keep the limit
      // under the pre body so pagination still splits across messages.
      maxChars: 30,
      richMessages: true,
      onRetainedPage: onSupersededPreview,
    });

    stream.update(text);
    await stream.stop();

    const pages = api.raw.sendRichMessage.mock.calls.map((call) => {
      const params = call[0] as { rich_message?: TelegramInputRichMessage };
      return params.rich_message?.blocks ?? [];
    });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((blocks) => blocks.every((block) => block.type === "pre"))).toBe(true);
    expect(
      pages.every((blocks) =>
        blocks.some((block) => block.type === "pre" && block.language === "ts"),
      ),
    ).toBe(true);
    const fullRichMessage = buildTelegramRichMarkdown(text);
    expect(
      pages
        .flatMap((blocks) => blocks.map((block) => (block.type === "pre" ? block.text : "")))
        .join(""),
    ).toBe(
      fullRichMessage.blocks.map((block) => (block.type === "pre" ? block.text : "")).join(""),
    );
    expect(onSupersededPreview).toHaveBeenCalledTimes(pages.length - 1);
  });

  it("preserves whitespace-only code content across rich pages", async () => {
    const api = createMockDraftApi();
    const text = ["```", " ".repeat(80), "```"].join("\n");
    const stream = createDraftStream(api, { maxChars: 40, richMessages: true });

    stream.update(text);
    await stream.stop();

    const pages = api.raw.sendRichMessage.mock.calls.map((call) => {
      const params = call[0] as { rich_message?: TelegramInputRichMessage };
      return params.rich_message?.blocks ?? [];
    });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((blocks) => blocks.every((block) => block.type === "pre"))).toBe(true);
    expect(
      pages
        .flatMap((blocks) => blocks.map((block) => (block.type === "pre" ? block.text : "")))
        .join("")
        .replace(/\n$/u, ""),
    ).toBe(" ".repeat(80));
  });

  it("keeps non-final overflow in one editable preview", async () => {
    const api = createMockDraftApi();
    const onSupersededPreview = vi.fn();
    const stream = createDraftStream(api, {
      maxChars: 20,
      onRetainedPage: onSupersededPreview,
    });

    stream.update("Hello world");
    await stream.flush();
    stream.update("Hello world foo bar baz qux");
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expectNthPreviewSend(api, 1, "Hello world");
    expectPreviewEdit(api, "Hello world foo bar");
    expect(onSupersededPreview).not.toHaveBeenCalled();
    expect(stream.lastDeliveredText?.()).toBe("Hello world foo bar");
  });

  it("does not retain non-final overflow preview pages", async () => {
    const api = createMockDraftApi();
    const onSupersededPreview = vi.fn();
    const stream = createDraftStream(api, {
      maxChars: 20,
      onRetainedPage: onSupersededPreview,
    });

    stream.update("Hello world");
    await stream.flush();
    stream.update("Hello world foo bar baz qux");
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expectPreviewEdit(api, "Hello world foo bar");
    expect(onSupersededPreview).not.toHaveBeenCalled();
  });

  it("continues in a new message when a final rendered preview crosses maxChars", async () => {
    const api = createMockDraftApi();
    api.sendMessage
      .mockResolvedValueOnce({ message_id: 17 })
      .mockResolvedValueOnce({ message_id: 42 });
    const stream = createDraftStream(api, { maxChars: 20 });

    stream.update("Hello world");
    await stream.flush();
    stream.update("Hello world foo bar baz qux");
    await stream.stop();

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expectNthPreviewSend(api, 1, "Hello world");
    expectPreviewEdit(api, "Hello world foo bar");
    expectNthPreviewSend(api, 2, "baz qux");
  });

  it("clamps a first oversized non-final preview on a UTF-16 boundary", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api, { maxChars: 10 });

    stream.update("123456789😀tail");
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expectNthPreviewSend(api, 1, "123456789");
    expect(stream.lastDeliveredText?.()).toBe("123456789");
  });

  it("finalizes overflow that was hidden by a clamped non-final preview", async () => {
    const api = createMockDraftApi();
    api.sendMessage
      .mockResolvedValueOnce({ message_id: 17 })
      .mockResolvedValueOnce({ message_id: 42 });
    const onSupersededPreview = vi.fn();
    const stream = createDraftStream(api, {
      maxChars: 10,
      onRetainedPage: onSupersededPreview,
    });

    stream.update("1234567890ABCDEFGHIJ");
    await stream.flush();
    await stream.stop();

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expectNthPreviewSend(api, 1, "1234567890");
    expectNthPreviewSend(api, 2, "ABCDEFGHIJ");
    expect(stream.lastDeliveredText?.()).toBe("1234567890ABCDEFGHIJ");
    expect(onSupersededPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 17,
      }),
    );
  });

  it("continues finalizing more than two overflow chunks after a clamped preview", async () => {
    const api = createMockDraftApi();
    api.sendMessage
      .mockResolvedValueOnce({ message_id: 17 })
      .mockResolvedValueOnce({ message_id: 42 })
      .mockResolvedValueOnce({ message_id: 43 });
    const stream = createDraftStream(api, { maxChars: 10 });

    stream.update("1234567890ABCDEFGHIJKLMNOPQRST");
    await stream.flush();
    await stream.stop();

    expect(api.sendMessage).toHaveBeenCalledTimes(3);
    expectNthPreviewSend(api, 1, "1234567890");
    expectNthPreviewSend(api, 2, "ABCDEFGHIJ");
    expectNthPreviewSend(api, 3, "KLMNOPQRST");
    expect(stream.lastDeliveredText?.()).toBe("1234567890ABCDEFGHIJKLMNOPQRST");
  });

  it.each(["first", "batched"] as const)(
    "uses a %s reply target only on the first draft page",
    async (replyToMode) => {
      const api = createMockDraftApi();
      api.sendMessage
        .mockResolvedValueOnce({ message_id: 17 })
        .mockResolvedValueOnce({ message_id: 42 })
        .mockResolvedValueOnce({ message_id: 43 });
      const stream = createDraftStream(api, {
        maxChars: 10,
        replyToMessageId: 411,
        replyToMode,
        thread: { id: 42, scope: "dm" },
      });

      stream.update("1234567890ABCDEFGHIJKLMNOPQRST");
      await stream.stop();

      expectNthPreviewSend(api, 1, "1234567890", {
        message_thread_id: 42,
        reply_parameters: {
          message_id: 411,
          allow_sending_without_reply: true,
        },
      });
      expectNthPreviewSend(api, 2, "ABCDEFGHIJ", { message_thread_id: 42 });
      expectNthPreviewSend(api, 3, "KLMNOPQRST", { message_thread_id: 42 });
    },
  );

  it("keeps a single-use reply target until the first draft send is accepted", async () => {
    let rejected = false;
    let nextMessageId = 17;
    const api = createMockDraftApi();
    api.sendMessage.mockImplementation(async () => {
      if (!rejected) {
        rejected = true;
        throw Object.assign(new Error("429: retry after 1"), {
          error_code: 429,
          parameters: { retry_after: 1 },
        });
      }
      return { message_id: nextMessageId++ };
    });
    const stream = createDraftStream(api, {
      maxChars: 10,
      replyToMessageId: 411,
      replyToMode: "first",
    });

    stream.update("1234567890ABCDEFGHIJ");
    await stream.stop();
    await stream.stop();

    const replyParams = {
      reply_parameters: {
        message_id: 411,
        allow_sending_without_reply: true,
      },
    };
    expectNthPreviewSend(api, 1, "1234567890", replyParams);
    expectNthPreviewSend(api, 2, "1234567890", replyParams);
    expectNthPreviewSend(api, 3, "ABCDEFGHIJ");
  });

  it("keeps an all-mode reply target on every draft page", async () => {
    const api = createMockDraftApi();
    api.sendMessage
      .mockResolvedValueOnce({ message_id: 17 })
      .mockResolvedValueOnce({ message_id: 42 })
      .mockResolvedValueOnce({ message_id: 43 });
    const stream = createDraftStream(api, {
      maxChars: 10,
      replyToMessageId: 411,
      replyToMode: "all",
      thread: { id: 42, scope: "dm" },
    });

    stream.update("1234567890ABCDEFGHIJKLMNOPQRST");
    await stream.stop();

    expectNthPreviewSend(api, 1, "1234567890", {
      message_thread_id: 42,
      reply_parameters: {
        message_id: 411,
        allow_sending_without_reply: true,
      },
    });
    const replyParams = {
      message_thread_id: 42,
      reply_parameters: {
        message_id: 411,
        allow_sending_without_reply: true,
      },
    };
    expectNthPreviewSend(api, 2, "ABCDEFGHIJ", replyParams);
    expectNthPreviewSend(api, 3, "KLMNOPQRST", replyParams);
  });

  it("resumes final pagination at the first rejected page", async () => {
    vi.useFakeTimers();
    try {
      const accepted: string[] = [];
      const attempts: string[] = [];
      let rejectedSecondPage = false;
      let nextMessageId = 17;
      const api = createMockDraftApi();
      api.sendMessage.mockImplementation(async (_chatId, text) => {
        const page = text;
        attempts.push(page);
        if (page === "ABCDEFGHIJ" && !rejectedSecondPage) {
          rejectedSecondPage = true;
          throw Object.assign(new Error("429: retry after 1"), {
            error_code: 429,
            parameters: { retry_after: 1 },
          });
        }
        accepted.push(page);
        return { message_id: nextMessageId++ };
      });
      const onSupersededPreview = vi.fn();
      const stream = createDraftStream(api, {
        maxChars: 10,
        onRetainedPage: onSupersededPreview,
      });

      stream.update("1234567890ABCDEFGHIJKLMNOPQRST");
      const stopPromise = stream.stop();
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toEqual(["1234567890", "ABCDEFGHIJ"]);
      await vi.advanceTimersByTimeAsync(999);
      expect(attempts).toEqual(["1234567890", "ABCDEFGHIJ"]);
      await vi.advanceTimersByTimeAsync(1);
      await stopPromise;

      expect(attempts).toEqual(["1234567890", "ABCDEFGHIJ", "ABCDEFGHIJ", "KLMNOPQRST"]);
      expect(accepted).toEqual(["1234567890", "ABCDEFGHIJ", "KLMNOPQRST"]);
      expect(onSupersededPreview.mock.calls.map(([page]) => page.textSnapshot)).toEqual([
        "1234567890",
        "ABCDEFGHIJ",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps only the unsent suffix after bounded final pagination rate limits", async () => {
    vi.useFakeTimers();
    try {
      const attempts: string[] = [];
      const api = createMockDraftApi();
      api.sendMessage.mockImplementation(async (_chatId, text) => {
        attempts.push(text);
        if (text === "ABCDEFGHIJ") {
          throw Object.assign(new Error("429: retry after 1"), {
            error_code: 429,
            parameters: { retry_after: 1 },
          });
        }
        return { message_id: 17 };
      });
      const retainedPages: string[] = [];
      const stream = createDraftStream(api, {
        maxChars: 10,
        onRetainedPage: (page) => retainedPages.push(page.textSnapshot),
      });

      stream.update("1234567890ABCDEFGHIJKLMNOPQRST");
      await stream.flush();
      expect(attempts).toEqual(["1234567890"]);
      // Requeue the complete final so stop's initial flush attempts page 1;
      // the two bounded retries must each honor their own retry_after window.
      stream.update("1234567890ABCDEFGHIJKLMNOPQRST");

      const stopPromise = stream.stop();
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toEqual(["1234567890", "ABCDEFGHIJ"]);

      await vi.advanceTimersByTimeAsync(999);
      expect(attempts).toEqual(["1234567890", "ABCDEFGHIJ"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toEqual(["1234567890", "ABCDEFGHIJ", "ABCDEFGHIJ"]);

      await vi.advanceTimersByTimeAsync(999);
      expect(attempts).toEqual(["1234567890", "ABCDEFGHIJ", "ABCDEFGHIJ"]);
      await vi.advanceTimersByTimeAsync(1);
      await stopPromise;

      expect(attempts).toEqual(["1234567890", "ABCDEFGHIJ", "ABCDEFGHIJ", "ABCDEFGHIJ"]);
      expect(retainedPages).toEqual(["1234567890"]);
      expect(stream.remainingFinalContent?.()).toEqual({
        text: "ABCDEFGHIJKLMNOPQRST",
        sourceText: "ABCDEFGHIJKLMNOPQRST",
        sourceTextMode: "html",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["accepted", "retryable rejection"])(
    "does not let a superseded %s final page freeze the replacement stream",
    async (outcome) => {
      let settleSecondPage: (() => void) | undefined;
      const secondPage = new Promise<{ message_id: number }>((resolve, reject) => {
        settleSecondPage = () => {
          if (outcome === "accepted") {
            resolve({ message_id: 42 });
          } else {
            reject(
              Object.assign(new Error("429: retry after 1"), {
                error_code: 429,
                parameters: { retry_after: 1 },
              }),
            );
          }
        };
      });
      const api = createMockDraftApi();
      api.sendMessage
        .mockResolvedValueOnce({ message_id: 17 })
        .mockReturnValueOnce(secondPage)
        .mockResolvedValueOnce({ message_id: 43 });
      const stream = createDraftStream(api, { maxChars: 10 });

      stream.update("1234567890ABCDEFGHIJ");
      await stream.flush();
      const stopPromise = stream.stop();
      await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(2));
      stream.forceNewMessage();
      stream.update("replaced");
      settleSecondPage?.();
      await stopPromise;
      await stream.flush();

      expect(api.sendMessage).toHaveBeenCalledTimes(3);
      expectNthPreviewSend(api, 3, "replaced");
      expect(stream.messageId()).toBe(43);
    },
  );

  it("retains final overflow preview pages", async () => {
    const api = createMockDraftApi();
    api.sendMessage
      .mockResolvedValueOnce({ message_id: 17 })
      .mockResolvedValueOnce({ message_id: 42 });
    const onSupersededPreview = vi.fn();
    const stream = createDraftStream(api, {
      maxChars: 20,
      onRetainedPage: onSupersededPreview,
    });

    stream.update("Hello world");
    await stream.flush();
    stream.update("Hello world foo bar baz qux");
    await stream.stop();

    expect(onSupersededPreview).toHaveBeenCalledTimes(1);
    const [supersededPreview] = onSupersededPreview.mock.calls.at(0) ?? [];
    expect(supersededPreview).toEqual({
      messageId: 17,
      textSnapshot: "Hello world foo bar",
      visibleSinceMs: supersededPreview.visibleSinceMs,
    });
    expect(typeof supersededPreview.visibleSinceMs).toBe("number");
    expect(Number.isFinite(supersededPreview.visibleSinceMs)).toBe(true);
  });

  it("enforces maxChars after renderText expansion", async () => {
    const api = createMockDraftApi();
    const warn = vi.fn();
    const stream = createTelegramDraftStream({
      api: api as unknown as Bot["api"],
      chatId: 123,
      maxChars: 100,
      renderText: () => ({
        text: `<b>${"A".repeat(120)}</b>`,
        parseMode: "HTML",
      }),
      warn,
    });

    stream.update("short raw text");
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(requireSendMessageCallText(api, 0).length).toBeLessThanOrEqual(100);
    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("draft stream initial message debounce", () => {
  const createMockApi = () => createMockDraftApi(async () => ({ message_id: 42 }));

  function createDebouncedStream(api: ReturnType<typeof createMockApi>, minInitialChars = 30) {
    return createTelegramDraftStream({
      api: api as unknown as Bot["api"],
      chatId: 123,
      minInitialChars,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("isFinal has highest priority", () => {
    it("sends immediately on stop() even with 1 character", async () => {
      const api = createMockApi();
      const stream = createDebouncedStream(api);

      stream.update("Y");
      await stream.stop();
      await stream.flush();

      expectPreviewSend(api, "Y");
    });

    it("sends immediately on stop() with short sentence", async () => {
      const api = createMockApi();
      const stream = createDebouncedStream(api);

      stream.update("Ok.");
      await stream.stop();
      await stream.flush();

      expectPreviewSend(api, "Ok.");
    });
  });

  describe("minInitialChars threshold", () => {
    it("does not send first message below threshold", async () => {
      const api = createMockApi();
      const stream = createDebouncedStream(api);

      stream.update("Processing");
      await stream.flush();

      expect(api.sendMessage).not.toHaveBeenCalled();
    });

    it("does not send a first message when discard() supersedes a short partial", async () => {
      const api = createMockApi();
      const stream = createDebouncedStream(api);

      stream.update("Processing");
      await stream.discard?.();
      await stream.flush();

      expect(api.sendMessage).not.toHaveBeenCalled();
      expect(api.editMessageText).not.toHaveBeenCalled();
    });

    it("sends first message when reaching threshold", async () => {
      const api = createMockApi();
      const stream = createDebouncedStream(api);

      stream.update("I am processing your request..");
      await stream.flush();

      expect(api.sendMessage).toHaveBeenCalled();
    });

    it("works with longer text above threshold", async () => {
      const api = createMockApi();
      const stream = createDebouncedStream(api);

      stream.update("I am processing your request, please wait a moment");
      await stream.flush();

      expect(api.sendMessage).toHaveBeenCalled();
    });
  });

  describe("subsequent updates after first message", () => {
    it("edits normally after first message is sent", async () => {
      const api = createMockApi();
      const stream = createDebouncedStream(api);

      stream.update("I am processing your request..");
      await stream.flush();
      expect(api.sendMessage).toHaveBeenCalledTimes(1);

      stream.update("I am processing your request.. and summarizing");
      await stream.flush();

      expect(api.editMessageText).toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe("default behavior without debounce params", () => {
    it("sends plain preview text immediately without minInitialChars set", async () => {
      const api = createMockApi();
      const stream = createTelegramDraftStream({
        api: api as unknown as Bot["api"],
        chatId: 123,
      });

      stream.update("Hi");
      await stream.flush();

      expectPreviewSend(api, "Hi");
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
