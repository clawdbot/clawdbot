import type { Bot } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";
import { __testing, createTelegramDraftStream } from "./draft-stream.js";

type TelegramDraftStreamParams = Parameters<typeof createTelegramDraftStream>[0];

function createMockDraftApi(sendMessageImpl?: () => Promise<{ message_id: number }>) {
  return {
    sendMessage: vi.fn(sendMessageImpl ?? (async () => ({ message_id: 17 }))),
    sendMessageDraft: vi.fn().mockResolvedValue(true),
    editMessageText: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
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
    expect(api.sendMessage).toHaveBeenCalledWith(123, text, { message_thread_id: 99 }),
  );
}

function expectDmMessagePreviewViaSendMessage(
  api: ReturnType<typeof createMockDraftApi>,
  text = "Hello",
): void {
  expect(api.sendMessage).toHaveBeenCalledWith(123, text, { message_thread_id: 42 });
  expect(api.editMessageText).not.toHaveBeenCalled();
}

async function createDmDraftTransportStream(params: {
  api?: ReturnType<typeof createMockDraftApi>;
  previewTransport?: "draft" | "message";
  warn?: (message: string) => void;
}) {
  const api = params.api ?? createMockDraftApi();
  const stream = createDraftStream(api, {
    thread: { id: 42, scope: "dm" },
    previewTransport: params.previewTransport ?? "draft",
    ...(params.warn ? { warn: params.warn } : {}),
  });
  stream.update("Hello");
  await stream.flush();
  return { api, stream };
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
  afterEach(() => {
    __testing.resetTelegramDraftStreamForTests();
  });

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

    expect(api.editMessageText).toHaveBeenCalledWith(123, 17, "Hello again");
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

    expect(api.editMessageText).toHaveBeenCalledWith(123, 17, "Hello final");
  });

  it("omits message_thread_id for general topic id", async () => {
    const api = createMockDraftApi();
    const stream = createThreadedDraftStream(api, { id: 1, scope: "forum" });

    stream.update("Hello");

    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledWith(123, "Hello", undefined));
  });

  it("uses sendMessageDraft for dm threads and does not create a preview message", async () => {
    const api = createMockDraftApi();
    const stream = createThreadedDraftStream(api, { id: 42, scope: "dm" });

    stream.update("Hello");
    await vi.waitFor(() =>
      expect(api.sendMessageDraft).toHaveBeenCalledWith(123, expect.any(Number), "Hello", {
        message_thread_id: 42,
      }),
    );
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.editMessageText).not.toHaveBeenCalled();
    await stream.clear();

    expect(api.deleteMessage).not.toHaveBeenCalled();
  });

  it("supports forcing message transport in dm threads", async () => {
    const { api } = await createDmDraftTransportStream({ previewTransport: "message" });

    expectDmMessagePreviewViaSendMessage(api);
    expect(api.sendMessageDraft).not.toHaveBeenCalled();
  });

  it("falls back to message transport when sendMessageDraft is unavailable", async () => {
    const api = createMockDraftApi();
    delete (api as { sendMessageDraft?: unknown }).sendMessageDraft;
    const warn = vi.fn();
    await createDmDraftTransportStream({ api, warn });

    expectDmMessagePreviewViaSendMessage(api);
    expect(warn).toHaveBeenCalledWith(
      "telegram stream preview: sendMessageDraft unavailable; falling back to sendMessage/editMessageText",
    );
  });

  it("falls back to message transport when sendMessageDraft is rejected at runtime", async () => {
    const api = createMockDraftApi();
    api.sendMessageDraft.mockRejectedValueOnce(
      new Error(
        "Call to 'sendMessageDraft' failed! (400: Bad Request: method sendMessageDraft can be used only in private chats)",
      ),
    );
    const warn = vi.fn();
    const { stream } = await createDmDraftTransportStream({ api, warn });

    expect(api.sendMessageDraft).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledWith(123, "Hello", { message_thread_id: 42 });
    expect(stream.previewMode?.()).toBe("message");
    expect(warn).toHaveBeenCalledWith(
      "telegram stream preview: sendMessageDraft rejected by API; falling back to sendMessage/editMessageText",
    );

    stream.update("Hello again");
    await stream.flush();

    expect(api.editMessageText).toHaveBeenCalledWith(123, 17, "Hello again");
  });

  it("retries DM message preview send without thread when thread is not found", async () => {
    const api = createMockDraftApi();
    api.sendMessage
      .mockRejectedValueOnce(new Error("400: Bad Request: message thread not found"))
      .mockResolvedValueOnce({ message_id: 17 });
    const warn = vi.fn();
    const stream = createDraftStream(api, {
      thread: { id: 42, scope: "dm" },
      previewTransport: "message",
      warn,
    });

    stream.update("Hello");
    await stream.flush();

    expect(api.sendMessage).toHaveBeenNthCalledWith(1, 123, "Hello", { message_thread_id: 42 });
    expect(api.sendMessage).toHaveBeenNthCalledWith(2, 123, "Hello", undefined);
    expect(warn).toHaveBeenCalledWith(
      "telegram stream preview send failed with message_thread_id, retrying without thread",
    );
  });

  it("keeps allow_sending_without_reply on message previews that target a reply", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api, {
      thread: { id: 42, scope: "dm" },
      previewTransport: "message",
      replyToMessageId: 411,
    });

    stream.update("Hello");
    await stream.flush();

    expect(api.sendMessage).toHaveBeenCalledWith(123, "Hello", {
      message_thread_id: 42,
      reply_to_message_id: 411,
      allow_sending_without_reply: true,
    });
  });

  it("materializes draft previews using rendered HTML text", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api, {
      thread: { id: 42, scope: "dm" },
      previewTransport: "draft",
      renderText: (text) => ({
        text: text.replace("**bold**", "<b>bold</b>"),
        parseMode: "HTML",
      }),
    });

    stream.update("**bold**");
    await stream.flush();
    await stream.materialize?.();

    expect(api.sendMessage).toHaveBeenCalledWith(123, "<b>bold</b>", {
      message_thread_id: 42,
      parse_mode: "HTML",
    });
  });

  it("clears draft after materializing to avoid duplicate display in DM", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api, {
      thread: { id: 42, scope: "dm" },
      previewTransport: "draft",
    });

    stream.update("Hello");
    await stream.flush();
    const materializedId = await stream.materialize?.();

    expect(materializedId).toBe(17);
    expect(api.sendMessage).toHaveBeenCalledWith(123, "Hello", { message_thread_id: 42 });
    // Draft should be cleared with empty string after real message is sent.
    const draftCalls = api.sendMessageDraft.mock.calls;
    const clearCall = draftCalls.find((call) => call[2] === "");
    expect(clearCall).toBeDefined();
    expect(clearCall?.[0]).toBe(123);
    expect(clearCall?.[3]).toEqual({ message_thread_id: 42 });
  });

  it("retries materialize send without thread when dm thread lookup fails", async () => {
    const api = createMockDraftApi();
    api.sendMessage
      .mockRejectedValueOnce(new Error("400: Bad Request: message thread not found"))
      .mockResolvedValueOnce({ message_id: 55 });
    const warn = vi.fn();
    const stream = createDraftStream(api, {
      thread: { id: 42, scope: "dm" },
      previewTransport: "draft",
      warn,
    });

    stream.update("Hello");
    await stream.flush();
    const materializedId = await stream.materialize?.();

    expect(materializedId).toBe(55);
    expect(api.sendMessage).toHaveBeenNthCalledWith(1, 123, "Hello", { message_thread_id: 42 });
    expect(api.sendMessage).toHaveBeenNthCalledWith(2, 123, "Hello", undefined);
    const draftCalls = api.sendMessageDraft.mock.calls;
    const clearCall = draftCalls.find((call) => call[2] === "");
    expect(clearCall).toBeDefined();
    expect(clearCall?.[3]).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "telegram stream preview materialize send failed with message_thread_id, retrying without thread",
    );
  });

  it("returns existing preview id when materializing message transport", async () => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api, {
      thread: { id: 42, scope: "dm" },
      previewTransport: "message",
    });

    stream.update("Hello");
    await stream.flush();
    const materializedId = await stream.materialize?.();

    expect(materializedId).toBe(17);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not edit or delete messages after DM draft stream finalization", async () => {
    const api = createMockDraftApi();
    const stream = createThreadedDraftStream(api, { id: 42, scope: "dm" });

    stream.update("Hello");
    await stream.flush();
    stream.update("Hello again");
    await stream.stop();
    await stream.clear();

    expect(api.sendMessageDraft).toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.deleteMessage).not.toHaveBeenCalled();
  });

  it("rotates draft_id when forceNewMessage races an in-flight DM draft send", async () => {
    let resolveFirstDraft: ((value: boolean) => void) | undefined;
    const firstDraftSend = new Promise<boolean>((resolve) => {
      resolveFirstDraft = resolve;
    });
    const api = {
      sendMessageDraft: vi.fn().mockReturnValueOnce(firstDraftSend).mockResolvedValueOnce(true),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 17 }),
      editMessageText: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
    };
    const stream = createThreadedDraftStream(
      api as unknown as ReturnType<typeof createMockDraftApi>,
      { id: 42, scope: "dm" },
    );

    stream.update("Message A");
    await vi.waitFor(() => expect(api.sendMessageDraft).toHaveBeenCalledTimes(1));

    stream.forceNewMessage();
    stream.update("Message B");

    resolveFirstDraft?.(true);
    await stream.flush();

    expect(api.sendMessageDraft).toHaveBeenCalledTimes(2);
    const firstDraftId = api.sendMessageDraft.mock.calls[0]?.[1];
    const secondDraftId = api.sendMessageDraft.mock.calls[1]?.[1];
    expect(typeof firstDraftId).toBe("number");
    expect(typeof secondDraftId).toBe("number");
    expect(firstDraftId).not.toBe(secondDraftId);
    expect(api.sendMessageDraft.mock.calls[1]?.[2]).toBe("Message B");
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it("shares draft-id allocation across distinct module instances", async () => {
    const draftA = await importFreshModule<typeof import("./draft-stream.js")>(
      import.meta.url,
      "./draft-stream.js?scope=shared-a",
    );
    const draftB = await importFreshModule<typeof import("./draft-stream.js")>(
      import.meta.url,
      "./draft-stream.js?scope=shared-b",
    );
    const apiA = createMockDraftApi();
    const apiB = createMockDraftApi();

    draftA.__testing.resetTelegramDraftStreamForTests();

    try {
      const streamA = draftA.createTelegramDraftStream({
        api: apiA as unknown as Bot["api"],
        chatId: 123,
        thread: { id: 42, scope: "dm" },
        previewTransport: "draft",
      });
      const streamB = draftB.createTelegramDraftStream({
        api: apiB as unknown as Bot["api"],
        chatId: 123,
        thread: { id: 42, scope: "dm" },
        previewTransport: "draft",
      });

      streamA.update("Message A");
      await streamA.flush();
      streamB.update("Message B");
      await streamB.flush();

      expect(apiA.sendMessageDraft.mock.calls[0]?.[1]).toBe(1);
      expect(apiB.sendMessageDraft.mock.calls[0]?.[1]).toBe(2);
    } finally {
      draftA.__testing.resetTelegramDraftStreamForTests();
    }
  });

  it("creates new message after forceNewMessage is called", async () => {
    const { api, stream } = createForceNewMessageHarness();

    // First message
    stream.update("Hello");
    await stream.flush();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);

    // Normal edit (same message)
    stream.update("Hello edited");
    await stream.flush();
    expect(api.editMessageText).toHaveBeenCalledWith(123, 17, "Hello edited");

    // Force new message (e.g. after thinking block ends)
    stream.forceNewMessage();
    stream.update("After thinking");
    await stream.flush();

    // Should have sent a second new message, not edited the first
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendMessage).toHaveBeenLastCalledWith(123, "After thinking", undefined);
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
      expect(api.sendMessage).toHaveBeenLastCalledWith(123, "Second message", undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not rebind to an old message when forceNewMessage races an in-flight send", async () => {
    let resolveFirstSend: ((value: { message_id: number }) => void) | undefined;
    const firstSend = new Promise<{ message_id: number }>((resolve) => {
      resolveFirstSend = resolve;
    });
    const api = {
      sendMessage: vi.fn().mockReturnValueOnce(firstSend).mockResolvedValueOnce({ message_id: 42 }),
      editMessageText: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
    };
    const onSupersededPreview = vi.fn();
    const stream = createTelegramDraftStream({
      api: api as unknown as Bot["api"],
      chatId: 123,
      onSupersededPreview,
    });

    stream.update("Message A partial");
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));

    // Rotate to message B before message A send resolves.
    stream.forceNewMessage();
    stream.update("Message B partial");

    resolveFirstSend?.({ message_id: 17 });
    await stream.flush();

    expect(onSupersededPreview).toHaveBeenCalledWith({
      messageId: 17,
      textSnapshot: "Message A partial",
      parseMode: undefined,
    });
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendMessage).toHaveBeenNthCalledWith(2, 123, "Message B partial", undefined);
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

  it("clears sendMayHaveLanded on pre-connect first preview send failures", async () => {
    await expectSendMayHaveLandedStateAfterFirstFailure(
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      false,
    );
  });

  it("clears sendMayHaveLanded on Telegram 4xx client rejections", async () => {
    await expectSendMayHaveLandedStateAfterFirstFailure(
      Object.assign(new Error("403: Forbidden"), { error_code: 403 }),
      false,
    );
  });

  it("supports rendered previews with parse_mode", async () => {
    const api = createMockDraftApi();
    const stream = createTelegramDraftStream({
      api: api as unknown as Bot["api"],
      chatId: 123,
      renderText: (text) => ({ text: `<i>${text}</i>`, parseMode: "HTML" }),
    });

    stream.update("hello");
    await stream.flush();
    expect(api.sendMessage).toHaveBeenCalledWith(123, "<i>hello</i>", { parse_mode: "HTML" });

    stream.update("hello again");
    await stream.flush();
    expect(api.editMessageText).toHaveBeenCalledWith(123, 17, "<i>hello again</i>", {
      parse_mode: "HTML",
    });
  });

  it("enforces maxChars after renderText expansion", async () => {
    const api = createMockDraftApi();
    const warn = vi.fn();
    const stream = createTelegramDraftStream({
      api: api as unknown as Bot["api"],
      chatId: 123,
      maxChars: 100,
      renderText: () => ({ text: `<b>${"<".repeat(120)}</b>`, parseMode: "HTML" }),
      warn,
    });

    stream.update("short raw text");
    await stream.flush();

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("telegram stream preview stopped (text length 127 > 100)"),
    );
  });
});

describe("draft stream initial message debounce", () => {
  const createMockApi = () => ({
    sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
    editMessageText: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
  });

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

      expect(api.sendMessage).toHaveBeenCalledWith(123, "Y", undefined);
    });

    it("sends immediately on stop() with short sentence", async () => {
      const api = createMockApi();
      const stream = createDebouncedStream(api);

      stream.update("Ok.");
      await stream.stop();
      await stream.flush();

      expect(api.sendMessage).toHaveBeenCalledWith(123, "Ok.", undefined);
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
    it("sends immediately without minInitialChars set (backward compatible)", async () => {
      const api = createMockApi();
      const stream = createTelegramDraftStream({
        api: api as unknown as Bot["api"],
        chatId: 123,
      });

      stream.update("Hi");
      await stream.flush();

      expect(api.sendMessage).toHaveBeenCalledWith(123, "Hi", undefined);
    });
  });
});
