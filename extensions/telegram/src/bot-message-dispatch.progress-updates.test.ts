import { expect, it } from "vitest";
import {
  describeTelegramDispatch,
  createContext,
  createReasoningStreamContext,
  createSequencedDraftStream,
  createTelegramDraftStream,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  editMessageTelegram,
  expectDeliveredReply,
  expectDeliverRepliesParams,
  expectRecordFields,
  expectWindowCollapsedTo,
  mockCallArg,
  mockDefaultSessionEntry,
  readLatestAssistantTextByIdentity,
  recordOutboundMessageForPromptContext,
  setupDraftStreams,
  telegramProgressPreview,
} from "./bot-message-dispatch.test-harness.js";

describeTelegramDispatch("dispatchTelegramMessage progress-updates", () => {
  it("does not restart progress drafts after final answer delivery", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Branch is up to date" }, { kind: "final" });
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
    });

    expect(answerDraftStream.updatePreview).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview("Shelling\n\n🛠️ Exec", "<b>Shelling</b>\n<b>🛠️ Exec</b>"),
    );
    expectWindowCollapsedTo(answerDraftStream, "🛠️ 1 tool call · ⏱️ 1s");
    expectDeliveredReply(0, { text: "Branch is up to date" });
  });

  it("does not restart progress drafts for command output after final answer delivery", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Branch is up to date" }, { kind: "final" });
        await replyOptions?.onCommandOutput?.({
          phase: "end",
          title: "Exec",
          name: "exec",
          status: "failed",
          exitCode: 1,
        });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
    });

    expect(answerDraftStream.updatePreview).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview("Shelling\n\n🛠️ Exec", "<b>Shelling</b>\n<b>🛠️ Exec</b>"),
    );
    expectWindowCollapsedTo(answerDraftStream, "🛠️ 1 tool call · ⏱️ 1s");
    expectDeliveredReply(0, { text: "Branch is up to date" });
  });

  it("does not restart progress drafts for command output while final answer delivery is pending", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        const finalDelivery = dispatcherOptions.deliver(
          { text: "Branch is up to date" },
          { kind: "final" },
        );
        await replyOptions?.onCommandOutput?.({
          phase: "end",
          title: "Exec",
          name: "exec",
          status: "failed",
          exitCode: 1,
        });
        await finalDelivery;
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
    });

    expect(answerDraftStream.updatePreview).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview("Shelling\n\n🛠️ Exec", "<b>Shelling</b>\n<b>🛠️ Exec</b>"),
    );
    expectWindowCollapsedTo(answerDraftStream, "🛠️ 1 tool call · ⏱️ 1s");
    expectDeliveredReply(0, { text: "Branch is up to date" });
  });

  it("uses the transcript final when progress-mode final text is truncated", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    const fullAnswer =
      "Ja. Hier nochmal sauber Schritt fuer Schritt. Einen API Key kopiert man aus der Google Cloud Console. Danach pruefst du die Projekt- und API-Einstellungen.";
    const truncatedFinal =
      "Ja. Hier nochmal sauber Schritt fuer Schritt. Einen API Key kopiert man...";
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      text: fullAnswer,
      timestamp: Date.now() + 1_000,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: truncatedFinal }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context,
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    expectWindowCollapsedTo(answerDraftStream, "🛠️ 1 tool call · ⏱️ 1s");
    expectDeliveredReply(0, { text: fullAnswer });
  });

  it("hands the complete long final to draft-owned pagination", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    const longText = "one ".repeat(80);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: longText }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext(), textLimit: 80 });

    expect(answerDraftStream.update).toHaveBeenLastCalledWith(longText.trimEnd());
    expectRecordFields(mockCallArg(recordOutboundMessageForPromptContext), {
      messageId: 2001,
      text: longText.trimEnd(),
    });
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(editMessageTelegram).not.toHaveBeenCalled();
  });

  it("keeps streamed final text in place when late media arrives", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    const mediaMaxBytes = 50 * 1024 * 1024;
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Photo" });
        await dispatcherOptions.deliver(
          { text: "Photo", mediaUrl: "https://example.com/a.png" },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      telegramCfg: { mediaMaxMb: 50 },
    });

    expect(answerDraftStream.clear).not.toHaveBeenCalled();
    expect(answerDraftStream.update).toHaveBeenCalledWith("Photo");
    expectDeliverRepliesParams({ mediaMaxBytes });
    expectDeliveredReply(0, { text: undefined, mediaUrl: "https://example.com/a.png" });
  });

  it("sends standalone MEDIA directive final replies as media", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "MEDIA:/tmp/reply-image.png" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).not.toHaveBeenCalledWith("MEDIA:/tmp/reply-image.png");
    expectDeliveredReply(0, {
      text: "",
      mediaUrl: "/tmp/reply-image.png",
      mediaUrls: ["/tmp/reply-image.png"],
    });
  });

  it("attaches interactive buttons to streamed text when late media arrives", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Photo" });
        await dispatcherOptions.deliver(
          {
            text: "Photo",
            mediaUrl: "https://example.com/a.png",
            interactive: {
              blocks: [{ type: "buttons", buttons: [{ label: "OK", value: "ok" }] }],
            },
          },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenCalledWith("Photo");
    expectRecordFields(mockCallArg(editMessageTelegram, 0, 3), {
      buttons: [[{ text: "OK", callback_data: "ok" }]],
    });
    expectDeliveredReply(0, { text: undefined, mediaUrl: "https://example.com/a.png" });
  });

  it("shows Telegram progress drafts immediately for explicit tool starts", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
    });

    expect(draftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview("Shelling\n\n🛠️ Exec", "<b>Shelling</b>\n<b>🛠️ Exec</b>"),
    );
    expect(draftStream.flush).toHaveBeenCalled();
  });

  it("renders command status without command output in Telegram progress draft previews", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onToolStart?.({
        name: "exec",
        phase: "start",
        toolCallId: "exec-1",
        args: { command: "false" },
      });
      await replyOptions?.onCommandOutput?.({
        phase: "end",
        title: "command false",
        name: "exec",
        toolCallId: "exec-1",
        output: "No such file or directory",
        exitCode: 2,
      });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: {
          mode: "progress",
          progress: { label: "Shelling", commandText: "raw" },
        },
      },
    });

    expect(draftStream.updatePreview).toHaveBeenLastCalledWith(
      telegramProgressPreview(
        "Shelling\n\n🛠️ exit 2; command false",
        "<b>Shelling</b>\n<b>🛠️ Exec</b> <code>command false</code> <i>exit 2</i>",
      ),
    );
  });

  it("hides command titles in Telegram status-only progress draft previews", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onToolStart?.({
        name: "exec",
        phase: "start",
        toolCallId: "exec-1",
        args: { command: "curl -H 'Authorization: token' https://example.test" },
      });
      await replyOptions?.onCommandOutput?.({
        phase: "end",
        title: "curl -H 'Authorization: token' https://example.test",
        name: "exec",
        toolCallId: "exec-1",
        output: "secret response",
        exitCode: 2,
      });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: {
          mode: "progress",
          progress: { label: "Shelling", commandText: "status" },
        },
      },
    });

    expect(draftStream.updatePreview).toHaveBeenLastCalledWith(
      telegramProgressPreview(
        "Shelling\n\n🛠️ exit 2",
        "<b>Shelling</b>\n<b>🛠️ Exec</b> <code>exit 2</code>",
      ),
    );
  });

  it("composes streamed reasoning with tool progress in Telegram progress drafts", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await replyOptions?.onReasoningStream?.({ text: "<think>Checking files</think>" });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createReasoningStreamContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
    });

    expect(createTelegramDraftStream).toHaveBeenCalledTimes(1);
    expect(draftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview(
        "Shelling\n\n🛠️ Exec\n🧠 Checking files",
        "<b>Shelling</b>\n<b>🛠️ Exec</b>\n🧠 <i>Checking files</i>",
      ),
    );
  });

  it("renders CLI thinking token progress in the Telegram progress draft", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReplyStart?.();
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onReasoningProgress?.({ progressTokens: 50 });
        await replyOptions?.onReasoningProgress?.({ progressTokens: 200 });
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
    });

    expect(createTelegramDraftStream).toHaveBeenCalledTimes(1);
    expect(draftStream.updatePreview).toHaveBeenLastCalledWith(
      telegramProgressPreview(
        "Shelling\n\n🧠 Thinking… (~200 tokens)",
        "<b>Shelling</b>\n<b>🧠 Thinking… (~200 tokens)</b>",
      ),
    );
    expectWindowCollapsedTo(draftStream, "🧠 1 thought · ⏱️ 1s");
    expectDeliveredReply(0, { text: "Done" });
  });

  it("renders model markdown in the preamble status headline", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onReasoningStream?.({ text: "<think>Running `sleep 4`</think>" });
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await replyOptions?.onItemEvent?.({
        kind: "preamble",
        itemId: "c1",
        progressText: "**Reading AGENTS.md**",
      });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createReasoningStreamContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: { mode: "progress", progress: { label: "Shelling" } },
      },
    });

    const headlinePreview = draftStream.updatePreview.mock.calls
      .map(([preview]) => preview)
      .find((preview) => preview.text.includes("AGENTS.md"));
    expect(headlinePreview?.parseMode).toBe("HTML");
    expect(headlinePreview?.text).toContain("<b>Reading <code>AGENTS.md</code></b>");
    // The fresh headline owns the status slot while reasoning remains buffered.
    expect(headlinePreview?.text).not.toContain("🧠");
    expect(headlinePreview?.text).not.toContain("**");
  });

  it("keeps clipped long reasoning lines italic behind the 🧠 marker", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    // Real reasoning routinely exceeds the progress clip limit; truncation must
    // clip inside the `_…_` wrapper, not chop the closing underscore (which
    // silently degrades the lane to plain text with a leaked underscore).
    const longThought = "The user wants me to think carefully and run several steps. ".repeat(8);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await replyOptions?.onReasoningStream?.({ text: `<think>${longThought}</think>` });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createReasoningStreamContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: { mode: "progress", progress: { label: "Shelling", maxLineChars: 300 } },
      },
    });

    const lastPreview = draftStream.updatePreview.mock.calls.at(-1)?.[0];
    expect(lastPreview?.parseMode).toBe("HTML");
    expect(lastPreview?.text).toContain("🧠 <i>The user wants me to think carefully");
    expect(lastPreview?.text).toMatch(/…<\/i>/u);
    expect(lastPreview?.text).not.toContain("_");
  });

  it("keeps normalized preamble headline markdown parse_mode-safe", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    // Models separate narration blocks with `\n\n---\n\n`; headline whitespace
    // normalization must keep that marker from becoming block-level HTML that
    // Telegram rejects.
    const commentary =
      "Planning: three sequential steps with a file read in between.\n\n---\n\n**Step 1:** Run `sleep 6 && date`";
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onReasoningStream?.({ text: "<think>Planning the steps</think>" });
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await replyOptions?.onItemEvent?.({
        kind: "preamble",
        itemId: "c1",
        progressText: commentary,
      });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createReasoningStreamContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: { mode: "progress", progress: { label: "Shelling" } },
      },
    });

    const headlinePreview = draftStream.updatePreview.mock.calls
      .map(([preview]) => preview)
      .find((preview) => preview.text.includes("three sequential steps"));
    expect(headlinePreview?.parseMode).toBe("HTML");
    expect(headlinePreview?.text).toContain("Planning: three sequential steps");
    expect(headlinePreview?.text).toContain("<b>Step 1:</b>");
    expect(headlinePreview?.text).toContain("<code>sleep 6 &amp;&amp; date</code>");
    expect(headlinePreview?.text).not.toContain("🧠");
    // No rich-only block HTML that Telegram's parse_mode=HTML would reject.
    expect(headlinePreview?.text).not.toMatch(/<(h[1-6]|hr|ul|ol|li|p|div)\b/u);
  });

  it("hands preambles to the interleaved commentary lane when it is enabled", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onItemEvent?.({
        kind: "preamble",
        itemId: "preamble-1",
        progressText: "Checking recent context",
      });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: {
          mode: "progress",
          progress: { label: "Shelling", commentary: true },
        },
      },
    });

    // The opt-in 💬 lane owns preambles; the status headline stays out of the
    // way so the documented interleaved lines keep rendering.
    const lastPreview = draftStream.updatePreview.mock.calls.at(-1)?.[0];
    expect(lastPreview?.text).toContain("💬");
    expect(lastPreview?.text).toContain("Checking recent context");
  });

  it("renders the Telegram preamble headline when commentary is disabled", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      expect(replyOptions?.progressPreambleEnabled).toBe(true);
      await replyOptions?.onItemEvent?.({
        kind: "preamble",
        itemId: "preamble-1",
        progressText: "Checking recent context",
      });
      expect(draftStream.updatePreview).not.toHaveBeenCalled();
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: {
          mode: "progress",
          progress: { label: "Shelling" },
        },
      },
    });

    expect(draftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview(
        "Shelling\n\nChecking recent context",
        "<b>Shelling</b>\nChecking recent context",
      ),
    );
  });

  it("retracts the Telegram preamble headline by item identity", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onItemEvent?.({
        kind: "preamble",
        itemId: "preamble-1",
        progressText: "Checking recent context",
      });
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await replyOptions?.onItemEvent?.({
        kind: "preamble",
        itemId: "preamble-1",
        progressText: "",
      });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: { mode: "progress", progress: { label: "Shelling" } },
      },
    });

    const lastPreview = draftStream.updatePreview.mock.calls.at(-1)?.[0];
    expect(lastPreview?.text).toContain("Exec");
    expect(lastPreview?.text).not.toContain("Checking recent context");
  });

  it("keeps structured progress rendering after a silent preamble", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onItemEvent?.({
        kind: "preamble",
        itemId: "preamble-1",
        progressText: "[[reply_to_current]] _NO_REPLY_ [[audio_as_voice]]",
      });
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: { mode: "progress", progress: { label: "Shelling" } },
      },
    });

    expect(draftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview("Shelling\n\n🛠️ Exec", "<b>Shelling</b>\n<b>🛠️ Exec</b>"),
    );
  });
});
