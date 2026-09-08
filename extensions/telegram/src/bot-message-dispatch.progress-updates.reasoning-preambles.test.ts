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
  expectDeliveredReply,
  telegramProgressPreview,
} from "./bot-message-dispatch.test-harness.js";

describeTelegramDispatch("dispatchTelegramMessage progress-updates reasoning and preambles", () => {
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
      telegramCfg: {
        streaming: { mode: "progress", progress: { toolProgress: true, label: "Shelling" } },
      },
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
      telegramCfg: {
        streaming: { mode: "progress", progress: { toolProgress: true, label: "Shelling" } },
      },
    });

    expect(createTelegramDraftStream).toHaveBeenCalledTimes(1);
    expect(draftStream.updatePreview).toHaveBeenLastCalledWith(
      telegramProgressPreview(
        "Shelling\n\n🧠 Thinking… (~200 tokens)",
        "<b>Shelling</b>\n<b>🧠 Thinking… (~200 tokens)</b>",
      ),
    );
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
        streaming: { mode: "progress", progress: { toolProgress: true, label: "Shelling" } },
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
        streaming: {
          mode: "progress",
          progress: { toolProgress: true, label: "Shelling", maxLineChars: 300 },
        },
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
        streaming: { mode: "progress", progress: { toolProgress: true, label: "Shelling" } },
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
          progress: { toolProgress: true, label: "Shelling", commentary: true },
        },
      },
    });

    // The opt-in 💬 lane owns preambles; the status headline stays out of the
    // way so the documented interleaved lines keep rendering.
    const lastPreview = draftStream.updatePreview.mock.calls.at(-1)?.[0];
    expect(lastPreview?.text).toContain("💬");
    expect(lastPreview?.text).toContain("Checking recent context");
  });

  it.each([
    ["active", true],
    ["inactive", false],
  ])(
    "keeps the draft as commentary owner when verbose visibility becomes %s",
    async (_label, verboseActive) => {
      const draftStream = createSequencedDraftStream(2001);
      createTelegramDraftStream.mockReturnValue(draftStream);
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
        await replyOptions?.onReplyStart?.();
        expect(replyOptions?.commentaryPayloadsEnabled).toBe(true);
        expect(replyOptions?.shouldDeliverCommentaryPayloads?.()).toBe(false);
        replyOptions?.onVerboseProgressVisibility?.(() => verboseActive);
        expect(replyOptions?.shouldDeliverCommentaryPayloads?.()).toBe(false);
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
            progress: { toolProgress: true, label: "Shelling", commentary: true },
          },
        },
      });

      const updates = draftStream.updatePreview.mock.calls
        .map(([preview]) => preview.text)
        .join("\n");
      // The draft owns commentary: exactly one visible copy per preamble.
      expect(updates.split("Checking recent context")).toHaveLength(2);
    },
  );

  it.each([
    {
      label: "progress commentary is disabled",
      streamMode: "progress",
      commentary: false,
      commentaryPayloadsEnabled: true,
    },
    {
      label: "partial streaming owns the answer preview",
      streamMode: "partial",
      commentary: true,
      commentaryPayloadsEnabled: undefined,
    },
    {
      label: "streaming is disabled",
      streamMode: "off",
      commentary: true,
      commentaryPayloadsEnabled: undefined,
    },
  ] as const)("omits the durable commentary owner when $label", async (scenario) => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      expect(replyOptions?.commentaryPayloadsEnabled).toBe(scenario.commentaryPayloadsEnabled);
      expect(replyOptions?.shouldDeliverCommentaryPayloads).toBeUndefined();
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: scenario.streamMode,
      telegramCfg: {
        streaming: {
          mode: scenario.streamMode,
          progress: { label: "Shelling", commentary: scenario.commentary },
        },
      },
    });
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
          progress: { toolProgress: true, label: "Shelling" },
        },
      },
    });

    expect(draftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview(
        "Shelling\n\nChecking recent context\n🛠️ Exec",
        "<b>Shelling</b>\nChecking recent context\n<b>🛠️ Exec</b>",
      ),
    );
  });

  it("keeps fast-mode string progress beneath a Telegram preamble", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReplyStart?.();
        await replyOptions?.onItemEvent?.({
          kind: "preamble",
          itemId: "preamble-1",
          progressText: "Checking recent context",
        });
        await dispatcherOptions.deliver(
          {
            text: "Fast mode enabled",
            channelData: { openclawProgressKind: "fast-mode-auto" },
          },
          { kind: "tool" },
        );
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

    expect(draftStream.updatePreview).toHaveBeenLastCalledWith(
      telegramProgressPreview(
        "Shelling\n\nChecking recent context\nFast mode enabled",
        "<b>Shelling</b>\nChecking recent context\nFast mode enabled",
      ),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("delivers authorized fast-mode progress once when no draft can accept it", async () => {
    let rendered: boolean | void = undefined;
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      rendered = await replyOptions?.onToolResult?.({
        text: "Fast mode enabled",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: {
          mode: "progress",
          progress: { toolProgress: true },
        },
      },
    });

    expect(rendered).toBe(true);
    expect(deliverReplies).toHaveBeenCalledOnce();
    expectDeliveredReply(0, {
      text: "Fast mode enabled",
      channelData: { openclawProgressKind: "fast-mode-auto" },
    });
  });

  it("keeps string tool-result progress beneath a Telegram preamble", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    let rendered: boolean | void = undefined;
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onItemEvent?.({
        kind: "preamble",
        itemId: "preamble-1",
        progressText: "Checking recent context",
      });
      rendered = await replyOptions?.onToolResult?.({ text: "Background task still running" });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        richMessages: true,
        streaming: { mode: "progress", progress: { toolProgress: true, label: "Shelling" } },
      },
    });

    const preview = draftStream.updatePreview.mock.calls.at(-1)?.[0];
    expect(preview?.text).toBe("Shelling\nChecking recent context\nBackground task still running");
    expect(JSON.stringify(preview?.richMessage)).toContain("Background task still running");
    expect(rendered).toBe(true);
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("reports empty tool-result progress as not rendered", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    let rendered: boolean | void = undefined;
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      rendered = await replyOptions?.onToolResult?.({ text: "   " });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: { mode: "progress", progress: { toolProgress: true, label: "Shelling" } },
      },
    });

    expect(rendered).toBe(false);
    expect(draftStream.updatePreview).not.toHaveBeenCalled();
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
        streaming: { mode: "progress", progress: { toolProgress: true, label: "Shelling" } },
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
        streaming: { mode: "progress", progress: { toolProgress: true, label: "Shelling" } },
      },
    });

    expect(draftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview("Shelling\n\n🛠️ Exec", "<b>Shelling</b>\n<b>🛠️ Exec</b>"),
    );
  });
});
