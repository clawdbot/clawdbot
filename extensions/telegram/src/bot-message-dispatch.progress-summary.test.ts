import { expect, it, vi } from "vitest";
import {
  describeTelegramDispatch,
  allDeliveredReplyTexts,
  appendAssistantMirrorMessageByIdentity,
  createContext,
  createReasoningStreamContext,
  createTelegramDraftStream,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  expectDeliveredReply,
  expectRecordFields,
  expectWindowCollapsedTo,
  loadSessionStore,
  mockCallArg,
  mockDefaultSessionEntry,
  requireInvocationOrder,
  setupDraftStreams,
  telegramProgressPreview,
  trailingFinalStatusText,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramMessageContext } from "./bot-message-dispatch.test-harness.js";
import { createTestDraftStream } from "./draft-stream.test-helpers.js";

describeTelegramDispatch("dispatchTelegramMessage progress-summary", () => {
  it("delivers the collapse bar as a real message but never mirrors it into the transcript", async () => {
    // Red-team F1: the bar is a cosmetic activity digest. It must be a durable
    // Telegram message but must NOT enter the session transcript, or the model
    // reads "🛠️ 1 tool call · ⏱️ Ns" back as its own prior turn. The real final
    // still mirrors (Discord parity: its summary bar has no mirror seam either).
    setupDraftStreams(); // no window message id → the bar posts durably (not an in-place edit)
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    deliverReplies.mockImplementation(
      async (params: {
        replies?: Array<{ text?: string }>;
        transcriptMirror?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void>;
      }) => {
        const text = params.replies
          ?.map((reply) => reply.text)
          .filter(Boolean)
          .join("\n\n");
        await params.transcriptMirror?.({ text });
        return { delivered: true };
      },
    );
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context,
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    // The final is sent first (call 0, mirrored), then the bar (call 1, not).
    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expectDeliveredReply(0, { text: "Done" });
    expect(typeof mockCallArg(deliverReplies, 0).transcriptMirror).toBe("function");
    const barParams = mockCallArg(deliverReplies, 1) as {
      replies?: Array<{ text?: string }>;
      transcriptMirror?: unknown;
    };
    expect(barParams.replies?.[0]?.text).toContain("🛠️ 1 tool call");
    expect(barParams.transcriptMirror).toBeUndefined();
    // Only the final reached the transcript; the bar line never did.
    expect(appendAssistantMirrorMessageByIdentity).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(appendAssistantMirrorMessageByIdentity), { text: "Done" });
  });

  it("does not count a start-phase message tool toward the collapse bar", async () => {
    // Red-team F4: progressSummary.noteToolCall() fired for ANY start-phase tool,
    // but the window renders only work tools (isChannelProgressDraftWorkToolName
    // rejects message/reply/react/…). A codex message_tool_only turn thus showed
    // "🛠️ 1 tool call" with no tool line. The count must match the window: one
    // work tool → 1, the message tool → 0.
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await replyOptions?.onToolStart?.({ name: "message", phase: "start" });
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    expectWindowCollapsedTo(answerDraftStream, "🛠️ 1 tool call · ⏱️ 1s");
  });

  it("does not count a work tool toward the collapse bar when toolProgress is off", async () => {
    // Red-team F4: with streaming.progress.toolProgress=false the window renders
    // no tool line, so a work tool must not feed the tally either — only the
    // reasoning that streamed to the window counts.
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({ text: "thinking" });
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createReasoningStreamContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { toolProgress: false } } },
    });

    expectWindowCollapsedTo(answerDraftStream, "🧠 1 thought · ⏱️ 1s");
  });

  it("keeps the turn alive when the cleanup-time collapse bar send throws", async () => {
    // Red-team F3: the cosmetic bar posts from the cleanup fallback AFTER the
    // real (out-of-band) final is already delivered. A flood-wait/network throw
    // from that send must be swallowed, never propagated out of dispatch.
    setupDraftStreams({ answerMessageId: 2001 });
    deliverReplies.mockRejectedValue(new Error("Too Many Requests: retry after 5"));
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      return {
        queuedFinal: true,
        counts: { block: 0, final: 1, tool: 1 },
        sourceReplyDeliveryMode: "message_tool_only",
      };
    });

    let thrown: unknown;
    try {
      await dispatchWithContext({
        context: createContext(),
        streamMode: "progress",
        telegramCfg: { streaming: { mode: "progress" } },
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeUndefined();
    // The bar send was attempted (and swallowed) rather than skipped.
    expect(deliverReplies).toHaveBeenCalled();
  });

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
    expectWindowCollapsedTo(answerDraftStream, "💬 1 note · 🛠️ 1 tool call · ⏱️ 1s");
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
    expectWindowCollapsedTo(answerDraftStream, "🛠️ 2 tool calls · ⏱️ 1s");
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
    // reposition and no delete — only the collapse edit into the bar at the end.
    // (forceNewMessage fires once at collapse to rewind the stream after the bar
    // edit; that is end-of-turn, not mid-turn churn.)
    expect(answerDraftStream.rotateToNewMessageDeferringDelete).not.toHaveBeenCalled();
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
    expectWindowCollapsedTo(answerDraftStream, "🛠️ 1 tool call · ⏱️ 1s");
    // The bar edit is the only send/edit that finalizes the window (one message).
    expect(answerDraftStream.finalizeToPreview).toHaveBeenCalledTimes(1);
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
    // ... and NEVER rotated/repositioned/deleted mid-turn.
    expect(answerDraftStream.rotateToNewMessageDeferringDelete).not.toHaveBeenCalled();
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
    // The bar edit is the single finalize, and it happens AFTER the final send.
    expect(answerDraftStream.finalizeToPreview).toHaveBeenCalledTimes(1);
    expectWindowCollapsedTo(answerDraftStream, "💬 2 notes · 🛠️ 2 tool calls · ⏱️ 1s");
    expectDeliveredReply(0, { text: "Final answer" });
    expect(requireInvocationOrder(deliverReplies, 0, "first reply delivery")).toBeLessThan(
      requireInvocationOrder(
        answerDraftStream.finalizeToPreview,
        0,
        "first answer draft finalization",
      ),
    );
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

  it("posts the collapse bar durably with no delete when the window has no live message", async () => {
    // When finalizeToPreview cannot edit in place (no live window message id),
    // the bar is still surfaced — as a durable post — and the window is NOT
    // cleared/deleted (nothing to delete; never a bare clear when a bar exists).
    const answerDraftStream = createTestDraftStream({}); // no messageId -> edit fails
    const reasoningDraftStream = createTestDraftStream({});
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
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

    const texts = allDeliveredReplyTexts();
    expect(texts.filter((text) => text.includes("⏱️"))).toEqual(["🛠️ 1 tool call · ⏱️ 1s"]);
    expect(texts).toContain("Done");
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
  });

  it("keeps the turn alive when the no-live-message fallback bar send throws", async () => {
    // Sibling of the F3 cleanup-throw guard: applyProgressCollapseSummary posts
    // the bar durably when finalizeToPreview cannot edit in place. That fallback
    // send is cosmetic and runs AFTER the in-band final, so a flood-wait/network
    // throw must be swallowed (postCosmeticSummaryBar), never failing the turn.
    const answerDraftStream = createTestDraftStream({}); // no messageId -> edit fails -> durable post
    const reasoningDraftStream = createTestDraftStream({});
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    // Only the cosmetic bar send throws; the real final "Done" still delivers.
    deliverReplies.mockImplementation(async (params: { replies?: Array<{ text?: string }> }) => {
      if (params.replies?.some((reply) => reply.text?.includes("⏱️"))) {
        throw new Error("Too Many Requests: retry after 5");
      }
      return { delivered: true };
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    let thrown: unknown;
    try {
      await dispatchWithContext({
        context: createContext(),
        streamMode: "progress",
        telegramCfg: { streaming: { mode: "progress" } },
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeUndefined();
    // The bar fallback send was attempted (and swallowed); the final survived.
    const texts = allDeliveredReplyTexts();
    expect(texts.some((text) => text.includes("⏱️"))).toBe(true);
    expect(texts).toContain("Done");
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

  it("posts a collapse summary for a message_tool_only final that bypasses the answer path", async () => {
    // Codex-runtime turns deliver the final out-of-band (queuedFinal), so the
    // in-band collapse path never runs. The window still started, so the
    // cleanup-time fallback must emit the bar (Discord parity).
    setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onItemEvent?.({ kind: "preamble", itemId: "c1", progressText: "Note" });
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      return {
        queuedFinal: true,
        counts: { block: 0, final: 1, tool: 1 },
        sourceReplyDeliveryMode: "message_tool_only",
      };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { commentary: true } } },
    });

    const texts = allDeliveredReplyTexts();
    expect(texts).toContain("💬 1 note · 🛠️ 1 tool call · ⏱️ 1s");
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
      expect(lastUpdate?.text).toContain("install dependencies");
      expect(lastUpdate?.text).not.toContain("completed");
      expect(lastUpdate).toEqual(
        telegramProgressPreview(
          "Shelling\n\n🛠️ install dependencies",
          "<b>Shelling</b>\n<b>🛠️ Exec</b> <code>install dependencies</code>",
        ),
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
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, trailingFinalStatusText);
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(2);
    expect(
      requireInvocationOrder(answerDraftStream.forceNewMessage, 1, "second answer draft rotation"),
    ).toBeLessThan(
      requireInvocationOrder(answerDraftStream.update, 0, "first answer draft update"),
    );
    // Window collapses in place into the summary bar; the final answer posts
    // fresh below it.
    expectWindowCollapsedTo(answerDraftStream, "🛠️ 1 tool call · ⏱️ 1s");
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
