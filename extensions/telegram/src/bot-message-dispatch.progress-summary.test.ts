import { expect, it, vi } from "vitest";
import { expectWindowRetiredWithoutSummary } from "./bot-message-dispatch.progress-window.test-helpers.js";
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

describeTelegramDispatch("dispatchTelegramMessage progress-summary", () => {
  it("keeps the progress window alive under /reasoning on so commentary and tools still stream", async () => {
    // /reasoning on removes only the 🧠 lane from the window; commentary, tool
    // lines, and the collapse bar must still stream (Discord parity). A prior
    // regression forced block streaming in progress mode, killing the window.
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
      telegramCfg: { streaming: { mode: "progress", progress: { commentary: true } } },
    });

    // The window streamed (a preview was rendered) and collapsed into a bar
    // counting the note + tool — proof the window was not killed.
    expect(answerDraftStream.updatePreview).toHaveBeenCalled();
    expectWindowRetiredWithoutSummary(answerDraftStream);
    expectDeliveredReply(0, { text: "Done" });
  });

  it("collapses a tool-progress-only window without deleting when reasoning is durable and the lane rotated mid-turn (on-off)", async () => {
    // on-off cell: /reasoning on (durable), /verbose off. The window streams
    // tool progress only; a mid-turn assistant boundary/rotation must not leave
    // the collapse to a delete + repost. Every non-error collapse edits in place
    // (or posts the bar durably) — NEVER a bare clear()/deleteMessage — so there
    // is exactly one bar and no Telegram focus-jump.
    loadSessionStore.mockReturnValue({ s1: { reasoningLevel: "on" } });
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        // Durable reasoning + an assistant boundary land between tool progress
        // and the final — the mid-turn churn that dropped the live window id.
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
      telegramCfg: { streaming: { mode: "progress" } },
    });

    // Collapse edited the window in place into the bar; the window was NOT
    // deleted (no focus-jump), and exactly one bar exists.
    expectWindowRetiredWithoutSummary(answerDraftStream);
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
    const texts = allDeliveredReplyTexts();
    expect(texts.filter((text) => text.includes("⏱️"))).toHaveLength(0); // bar is the in-place edit
    expect(texts).toContain("Done");
  });

  it("keeps a single stationary window when text follows durable reasoning (no mid-turn rotation)", async () => {
    // Single-message model (Discord parity): in progress mode the window is ONE
    // message edited through every lane handover — durable 🧠, interim answer
    // text — and edited into the bar only at collapse. It must NOT reposition or
    // rotate mid-turn (no new bubble, no delete), which is what caused the churn
    // and the on-off jump. Interim answer text does not render into the window.
    loadSessionStore.mockReturnValue({ s1: { reasoningLevel: "on" } });
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver(
          { text: "<think>hidden</think>", isReasoning: true },
          { kind: "block" },
        );
        // Interim answer text mid-turn: must not spawn a new window bubble.
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
      telegramCfg: { streaming: { mode: "progress" } },
    });

    // The one window message stays put through the whole turn: no mid-turn
    // reposition. It is retired once at end of turn, leaving the final answer as
    // the only surviving message.
    expect(answerDraftStream.rotateToNewMessageDeferringDelete).not.toHaveBeenCalled();
    expect(answerDraftStream.clear).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.finalizeToPreview).not.toHaveBeenCalled();
    expectWindowRetiredWithoutSummary(answerDraftStream);
  });

  it("uses one stationary window message across a multi-boundary turn (commentary→tool→commentary→tool→final)", async () => {
    // Single-message model (Discord parity): ONE window message id is created
    // once and edited through every lane handover; it collapses into the bar in
    // place at the end. Zero deletes in the happy path; the final is posted
    // before the bar edit (task-9 order).
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
      telegramCfg: { streaming: { mode: "progress", progress: { commentary: true } } },
    });

    // The SAME window message id is used the whole turn — no new bubble.
    const windowMessageIds = new Set(
      answerDraftStream.updatePreview.mock.calls
        .map(() => answerDraftStream.messageId())
        .filter((id) => id != null),
    );
    expect(windowMessageIds).toEqual(new Set([2001]));
    // The window was EDITED many times (once per lane change) ...
    expect(answerDraftStream.updatePreview.mock.calls.length).toBeGreaterThan(1);
    // A tool-only window is never deleted. It retires in place exactly once,
    // after the final send, so the tool log survives with no mid-turn churn.
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
    expect(answerDraftStream.finalizeToPreview).not.toHaveBeenCalled();
    expect(answerDraftStream.rotateToNewMessageDeferringDelete).toHaveBeenCalledTimes(1);
    expectWindowRetiredWithoutSummary(answerDraftStream);
    expectDeliveredReply(0, { text: "Final answer" });
    expect(requireInvocationOrder(deliverReplies, 0, "first reply delivery")).toBeLessThan(
      requireInvocationOrder(
        answerDraftStream.rotateToNewMessageDeferringDelete,
        0,
        "progress window retirement",
      ),
    );
  });

  it("keeps Claude CLI pre-tool commentary after the progress window collapses", async () => {
    const markers = "Test markers: caribou-lampion-473, fromage-quantique, satellite-en-tricot";
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        expect(replyOptions?.commentaryPayloadsEnabled).toBe(true);
        expect(replyOptions?.shouldDeliverCommentaryPayloads).toBeUndefined();
        await replyOptions?.onItemEvent?.({
          kind: "preamble",
          itemId: "commentary-1",
          progressText: markers,
          suppressDurableProgress: true,
        });
        await replyOptions?.onBlockReplyQueued?.({ text: markers, isCommentary: true });
        await dispatcherOptions.deliver({ text: markers, isCommentary: true }, { kind: "block" });
        await replyOptions?.onToolStart?.({ name: "Bash", phase: "start" });
        await dispatcherOptions.deliver({ text: "TEST DONE" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    expectWindowRetiredWithoutSummary(answerDraftStream);
    expect(allDeliveredReplyTexts()).toEqual([markers, "TEST DONE"]);
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
      telegramCfg: { streaming: { mode: "progress" } },
    });

    // The interim block text never reached the window (neither update nor preview).
    const windowTexts = [
      ...answerDraftStream.update.mock.calls.map((call) => call[0]),
      ...answerDraftStream.updatePreview.mock.calls.map(
        (call) => (call[0] as { text?: string }).text ?? "",
      ),
    ];
    expect(windowTexts.some((text) => text.includes("Interim answer prose"))).toBe(false);
    // The final answer is delivered below the collapsed window.
    const delivered = allDeliveredReplyTexts();
    expect(delivered).toContain("The real final answer.");
    expect(delivered.some((text) => text.includes("Interim answer prose"))).toBe(false);
  });

  it("does not duplicate tool lines into the window under verbose", async () => {
    // Invariant D2 (persistent XOR window): when the durable verbose lane owns
    // tool messages, the window must render no tool line and must not count it.
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
      telegramCfg: { streaming: { mode: "progress" } },
    });

    // No tool line ever rendered to the window (verbose owns it durably), so the
    // window never streamed and there is no collapse bar to count it.
    expect(answerDraftStream.updatePreview).not.toHaveBeenCalled();
    expect(answerDraftStream.finalizeToPreview).not.toHaveBeenCalled();
    const texts = allDeliveredReplyTexts();
    expect(texts.some((text) => text.includes("tool call"))).toBe(false);
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
        telegramCfg: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
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
      telegramCfg: { streaming: { mode: "progress", progress: { label: "Cracking" } } },
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
    // The window retires at end of turn; the final answer posts fresh below it.
    expectWindowRetiredWithoutSummary(answerDraftStream);
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
      telegramCfg: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
    });

    expect(answerDraftStream.updatePreview).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("stdout line one") }),
    );
    expect(answerDraftStream.updatePreview).toHaveBeenLastCalledWith(
      telegramProgressPreview(
        "Shelling\n\n🛠️ Exec\n🔎 Web Search: docs lookup",
        "<b>Shelling</b>\n<b>🛠️ Exec</b>\n<b>🔎 Web Search</b> <code>docs lookup</code>",
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
        telegramCfg: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      });

      expect(answerDraftStream.updatePreview).toHaveBeenLastCalledWith(
        telegramProgressPreview(
          "Shelling\n\n🌐 API: GET /v1/users\n🌐 API: POST /v1/jobs",
          "<b>Shelling</b>\n<b>🌐 API</b> <code>GET /v1/users</code>\n<b>🌐 API</b> <code>POST /v1/jobs</code>",
        ),
      );
      expect(deliverReplies).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
