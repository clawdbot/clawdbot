import { expect, it, vi } from "vitest";
import { expectWindowRetiredAfterFinal } from "./bot-message-dispatch.progress-window.test-helpers.js";
import {
  describeTelegramDispatch,
  allDeliveredReplyTexts,
  createContext,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  expectDeliveredReply,
  loadSessionStore,
  requireInvocationOrder,
  setupDraftStreams,
  telegramProgressPreview,
  trailingFinalStatusText,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramMessageContext } from "./bot-message-dispatch.test-harness.js";

describeTelegramDispatch("dispatchTelegramMessage progress-lifecycle", () => {
  it("keeps the progress window alive under /reasoning on so commentary and tools still stream", async () => {
    // Durable reasoning removes only the reasoning lane, not commentary or tool progress.
    loadSessionStore.mockReturnValue({ s1: { reasoningLevel: "on" } });
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onItemEvent?.({ kind: "preamble", itemId: "c1", progressText: "Note" });
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext({
        ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
      }),
      streamMode: "progress",
      telegramCfg: {
        streaming: { mode: "progress", progress: { toolProgress: true, commentary: true } },
      },
    });

    expect(answerDraftStream.updatePreview).toHaveBeenCalled();
    expectDeliveredReply(0, { text: "Done" });
  });

  it("retires a tool-progress-only window after durable reasoning and a mid-turn boundary", async () => {
    loadSessionStore.mockReturnValue({ s1: { reasoningLevel: "on" } });
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver(
          { text: "<think>hidden</think>", isReasoning: true },
          { kind: "block" },
        );
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext({
        ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
      }),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { toolProgress: true } } },
    });

    expect(answerDraftStream.clear).not.toHaveBeenCalled();
    expect(allDeliveredReplyTexts()).toContain("Done");
  });

  it("keeps a single stationary window when text follows durable reasoning (no mid-turn rotation)", async () => {
    // Interim answer text must not rotate or render into the progress window.
    loadSessionStore.mockReturnValue({ s1: { reasoningLevel: "on" } });
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver(
          { text: "<think>hidden</think>", isReasoning: true },
          { kind: "block" },
        );
        await dispatcherOptions.deliver({ text: "Here is the answer" }, { kind: "block" });
        await dispatcherOptions.deliver({ text: "Here is the answer." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext({
        ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
      }),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { toolProgress: true } } },
    });

    expect(answerDraftStream.rotateToNewMessageDeferringDelete).not.toHaveBeenCalled();
    expect(answerDraftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("uses one stationary window message across a multi-boundary turn (commentary→tool→commentary→tool→final)", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onItemEvent?.({ kind: "preamble", itemId: "c1", progressText: "Look" });
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await replyOptions?.onItemEvent?.({ kind: "preamble", itemId: "c2", progressText: "Now" });
        await replyOptions?.onToolStart?.({ name: "read", phase: "start" });
        await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: { mode: "progress", progress: { toolProgress: true, commentary: true } },
      },
    });

    const windowMessageIds = new Set(
      answerDraftStream.updatePreview.mock.calls
        .map(() => answerDraftStream.messageId())
        .filter((id) => id != null),
    );
    expect(windowMessageIds).toEqual(new Set([2001]));
    expect(answerDraftStream.updatePreview.mock.calls.length).toBeGreaterThan(1);
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
    expect(answerDraftStream.rotateToNewMessageDeferringDelete).toHaveBeenCalledTimes(1);
    expectDeliveredReply(0, { text: "Final answer" });
    expectWindowRetiredAfterFinal(answerDraftStream, deliverReplies);
  });

  it("keeps verbose CLI commentary bounded in the progress window so the final wins", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        expect(replyOptions?.commentaryPayloadsEnabled).toBe(true);
        replyOptions?.onVerboseProgressVisibility?.(() => true);
        expect(replyOptions?.shouldDeliverCommentaryPayloads?.()).toBe(false);
        for (let index = 1; index <= 10; index += 1) {
          await replyOptions?.onItemEvent?.({
            kind: "preamble",
            itemId: `commentary-${index}`,
            progressText: `Commentary ${index}`,
          });
        }
        await replyOptions?.onToolStart?.({ name: "Bash", phase: "start" });
        await dispatcherOptions.deliver({ text: "TEST DONE" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: { mode: "progress", progress: { toolProgress: true, commentary: true } },
      },
    });

    const lastPreview = answerDraftStream.updatePreview.mock.calls.at(-1)?.[0].text ?? "";
    expect(lastPreview).not.toContain("Commentary 1\n");
    expect(lastPreview).not.toContain("Commentary 2\n");
    expect(lastPreview).toContain("Commentary 3");
    expect(lastPreview).toContain("Commentary 10");
    expect(allDeliveredReplyTexts()).toEqual(["TEST DONE"]);
  });

  it("never streams an interim answer block into the progress window (Discord parity)", async () => {
    // Progress mode: the window is a pure activity log. An intermediate assistant
    // answer block (info.kind === "block", before the final) must NOT render into
    // the window; it is buffered and only the final answer is delivered below.
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        // Intermediate assistant answer prose mid-turn.
        await dispatcherOptions.deliver({ text: "Interim answer prose" }, { kind: "block" });
        await dispatcherOptions.deliver({ text: "The real final answer." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { toolProgress: true } } },
    });

    // The interim block text never reached the window (neither update nor preview).
    const windowTexts = [
      ...answerDraftStream.update.mock.calls.map((call) => call[0]),
      ...answerDraftStream.updatePreview.mock.calls.map(
        (call) => (call[0] as { text?: string }).text ?? "",
      ),
    ];
    expect(windowTexts.some((text) => text.includes("Interim answer prose"))).toBe(false);
    const delivered = allDeliveredReplyTexts();
    expect(delivered).toContain("The real final answer.");
    expect(delivered.some((text) => text.includes("Interim answer prose"))).toBe(false);
  });

  it("does not duplicate tool lines into the window under verbose", async () => {
    // The durable verbose lane owns tool messages, so the progress window must not duplicate them.
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        replyOptions?.onVerboseProgressVisibility?.(() => true);
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { toolProgress: true } } },
    });

    expect(answerDraftStream.updatePreview).not.toHaveBeenCalled();
    expect(allDeliveredReplyTexts()).toEqual(["Done"]);
  });

  it("replaces Telegram command progress items with matching command output", async () => {
    vi.useFakeTimers();
    try {
      const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
        await replyOptions?.onItemEvent?.({
          itemId: "tool:call-1",
          toolCallId: "call-1",
          kind: "command",
          name: "exec",
          progressText: "install dependencies",
        });
        await vi.advanceTimersByTimeAsync(5_000);
        await replyOptions?.onCommandOutput?.({
          itemId: "tool:call-1-output",
          toolCallId: "call-1",
          phase: "end",
          name: "exec",
          exitCode: 0,
        });
        return { queuedFinal: false };
      });

      await dispatchWithContext({
        context: createContext(),
        streamMode: "progress",
        telegramCfg: {
          streaming: { mode: "progress", progress: { toolProgress: true, label: "Shelling" } },
        },
      });

      const lastUpdate = answerDraftStream.updatePreview.mock.calls.at(-1)?.[0];
      expect(lastUpdate?.text).not.toContain("install dependencies");
      expect(lastUpdate?.text).not.toContain("completed");
      expect(lastUpdate).toEqual(
        telegramProgressPreview("Shelling\n\n🛠️ Exec", "<b>Shelling</b>\n<b>🛠️ Exec</b>"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends trailing verbose status after a progress-mode final answer", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Branch is up to date" }, { kind: "final" });
        await dispatcherOptions.deliver({ text: trailingFinalStatusText }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: { mode: "progress", progress: { toolProgress: true, label: "Cracking" } },
      },
    });

    expect(answerDraftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview("Cracking\n\n🛠️ Exec", "<b>Cracking</b>\n<b>🛠️ Exec</b>"),
    );
    expect(answerDraftStream.update).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(
      1,
      trailingFinalStatusText,
      expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
    );
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(
      requireInvocationOrder(answerDraftStream.forceNewMessage, 0, "answer draft rotation"),
    ).toBeLessThan(
      requireInvocationOrder(answerDraftStream.update, 0, "first answer draft update"),
    );
    expectDeliveredReply(0, { text: "Branch is up to date" });
  });

  it("does not stream text-only tool results into progress drafts", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver(
          { text: "stdout line one\nstdout line two" },
          { kind: "tool" },
        );
        await replyOptions?.onItemEvent?.({ kind: "search", progressText: "docs lookup" });
        return { queuedFinal: false };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: { mode: "progress", progress: { toolProgress: true, label: "Shelling" } },
      },
    });

    expect(answerDraftStream.updatePreview).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("stdout line one") }),
    );
    expect(answerDraftStream.updatePreview).toHaveBeenLastCalledWith(
      telegramProgressPreview(
        "Shelling\n\n🛠️ Exec\n🔎 Web Search: docs lookup",
        "<b>Shelling</b>\n<b>🛠️ Exec</b>\n<b>🔎 Web Search</b> docs lookup",
      ),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("renders api progress item edge cases as HTML transport previews", async () => {
    vi.useFakeTimers();
    try {
      const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
        await replyOptions?.onItemEvent?.({ kind: "api", progressText: "GET /v1/users" });
        await vi.advanceTimersByTimeAsync(5_000);
        await replyOptions?.onItemEvent?.({
          kind: "api",
          name: "api",
          progressText: "POST /v1/jobs",
        });
        return { queuedFinal: false };
      });

      await dispatchWithContext({
        context: createContext(),
        streamMode: "progress",
        telegramCfg: {
          streaming: { mode: "progress", progress: { toolProgress: true, label: "Shelling" } },
        },
      });

      expect(answerDraftStream.updatePreview).toHaveBeenLastCalledWith(
        telegramProgressPreview(
          "Shelling\n\n🌐 API: GET /v1/users\n🌐 API: POST /v1/jobs",
          "<b>Shelling</b>\n<b>🌐 API</b> GET /v1/users\n<b>🌐 API</b> POST /v1/jobs",
        ),
      );
      expect(deliverReplies).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
