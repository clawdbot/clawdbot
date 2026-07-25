// Discord message processing coverage split by cohesive behavior.
import { describe, expect, it } from "vitest";
import {
  BASE_CHANNEL_ROUTE,
  createAutomaticSourceDeliveryContext,
  createNoQueuedDispatchResult,
  createNonTerminalToolWarningPayload,
  deliverDiscordReply,
  dispatchInboundMessageForTest as dispatchInboundMessage,
  editMessageDiscord,
  getSessionEntry,
  mockDispatchSingleBlockReply,
  processStreamOffDiscordMessage,
  readLatestAssistantTextByIdentity,
  runProcessDiscordMessage,
  registerDiscordProcessTestLifecycle,
} from "./message-handler.process.test-harness.js";
import type { DispatchInboundParams } from "./message-handler.process.test-harness.js";
import {
  createBlockModeContext,
  createMockDraftStreamForTest,
  expectFinalWithProgressReceipt,
  expectFreshFinalText,
  firstDispatchParams,
  firstMockArg,
  getDeliveredFinalTexts,
  requireRecord,
  runSingleChunkFinalScenario,
  useProgressDraftStartDelay,
} from "./message-handler.process.test-helpers.js";

registerDiscordProcessTestLifecycle();

describe("processDiscordMessage draft streaming recovery", () => {
  it("falls back to standard send when final needs multiple chunks", async () => {
    await runSingleChunkFinalScenario({ streaming: { mode: "partial" }, maxLinesPerMessage: 1 });

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("uses transcript-backed final text when progress final text is truncated", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();
    const prefix =
      "Here is the complete Discord answer with enough stable prefix text before truncation";
    const truncatedFinal = `${prefix}...`;
    const fullAnswer = `${prefix} ${Array.from(
      { length: 260 },
      (_value, index) => `continuation${index}`,
    ).join(" ")}`;

    getSessionEntry.mockReturnValue({ sessionId: "session-1" });
    readLatestAssistantTextByIdentity.mockResolvedValue({
      text: fullAnswer,
      timestamp: Date.now() + 60_000,
    });
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: truncatedFinal });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      baseSessionKey: BASE_CHANNEL_ROUTE.sessionKey,
      discordConfig: { maxLinesPerMessage: 120 },
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledTimes(1);
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expectFinalWithProgressReceipt(fullAnswer, "🛠️ 1 tool call");
  });

  it("clears partial drafts when fallback final delivery fails before completion", async () => {
    const draftStream = createMockDraftStreamForTest();
    deliverDiscordReply.mockRejectedValueOnce(new Error("send failed"));
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onPartialReply?.({ text: "partial answer..." });
      await params?.dispatcher.sendFinalReply({ text: "complete\nanswer" });
      return {
        queuedFinal: true,
        counts: { final: 1, tool: 0, block: 0 },
        failedCounts: { final: 1 },
      };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 1 },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith("partial answer...");
    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(draftStream.discardPending).toHaveBeenCalled();
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("uses root discord maxLinesPerMessage for fresh final delivery when runtime config omits it", async () => {
    const longReply = Array.from({ length: 20 }, (_value, index) => `Line ${index + 1}`).join("\n");
    const draftStream = createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: longReply });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      cfg: {
        messages: { ackReaction: "👀" },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
        channels: {
          discord: {
            maxLinesPerMessage: 120,
          },
        },
      },
      discordConfig: { streaming: { mode: "partial" } },
    });

    await runProcessDiscordMessage(ctx);

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expectFreshFinalText(longReply);
    expect(draftStream.discardPending).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("falls back to standard delivery for explicit reply-tag finals", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({
        text: "[[reply_to_current]] Hello\nWorld",
        replyToId: "m-explicit-1",
        replyToTag: true,
        replyToCurrent: true,
      });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("does not flush draft previews for media finals before normal delivery", async () => {
    const draftStream = createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({
        text: "Photo",
        mediaUrl: "https://example.com/a.png",
      } as never);
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.flush).not.toHaveBeenCalled();
    expect(draftStream.discardPending).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("sends a fresh visible TTS supplement final and clears the preview", async () => {
    const draftStream = createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      } as never);
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
      replyToMode: "first",
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.flush).not.toHaveBeenCalled();
    expect(draftStream.discardPending).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(firstMockArg(deliverDiscordReply, "deliverDiscordReply")).toMatchObject({
      replyToId: "m1",
      replies: [
        {
          text: "Spoken answer",
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
          spokenText: "Spoken answer",
          ttsSupplement: { spokenText: "Spoken answer" },
        },
      ],
    });
  });

  it("sends fresh visible text for TTS supplement finals", async () => {
    const draftStream = createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      } as never);
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.flush).not.toHaveBeenCalled();
    expect(draftStream.discardPending).toHaveBeenCalled();
    expect(draftStream.clear).toHaveBeenCalled();
    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(firstMockArg(deliverDiscordReply, "deliverDiscordReply")).toMatchObject({
      replies: [
        {
          text: "Spoken answer",
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
          spokenText: "Spoken answer",
          ttsSupplement: { spokenText: "Spoken answer" },
        },
      ],
    });
  });

  it("keeps already-delivered TTS supplement fallback audio-only", async () => {
    editMessageDiscord.mockRejectedValueOnce(new Error("edit failed"));
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: {
          spokenText: "Spoken answer",
          visibleTextAlreadyDelivered: true,
        },
      } as never);
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(firstMockArg(deliverDiscordReply, "deliverDiscordReply")).toMatchObject({
      replies: [
        {
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
          spokenText: "Spoken answer",
          ttsSupplement: {
            spokenText: "Spoken answer",
            visibleTextAlreadyDelivered: true,
          },
        },
      ],
    });
  });

  it("does not flush draft previews for error finals before normal delivery", async () => {
    const draftStream = createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({
        text: "Something failed",
        isError: true,
      } as never);
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.flush).not.toHaveBeenCalled();
    expect(draftStream.discardPending).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("drops later tool warning finals after preview final replies", async () => {
    const draftStream = createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "delivery survived" });
      await params?.dispatcher.waitForIdle();
      await params?.dispatcher.sendFinalReply(createNonTerminalToolWarningPayload());
      return { queuedFinal: true, counts: { final: 2, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expectFreshFinalText("delivery survived");
    expect(draftStream.discardPending).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("drops earlier tool warning finals when recovered replies arrive", async () => {
    const draftStream = createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply(createNonTerminalToolWarningPayload());
      await params?.dispatcher.sendFinalReply({ text: "delivery recovered" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 2, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expectFreshFinalText("delivery recovered");
    expect(draftStream.discardPending).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("suppresses pure tool warning finals when no recovered reply is available", async () => {
    const draftStream = createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply(createNonTerminalToolWarningPayload());
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(deliverDiscordReply).not.toHaveBeenCalled();
  });

  it("suppresses tool warning finals when the recovered reply fails to send", async () => {
    deliverDiscordReply.mockRejectedValueOnce(new Error("send failed"));
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "delivery failed" });
      await params?.dispatcher.waitForIdle();
      await params?.dispatcher.sendFinalReply(createNonTerminalToolWarningPayload());
      return {
        queuedFinal: true,
        counts: { final: 2, tool: 0, block: 0 },
        failedCounts: { final: 1 },
      };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streaming: { mode: "off" } },
    });

    await runProcessDiscordMessage(ctx);

    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(firstMockArg(deliverDiscordReply, "deliverDiscordReply")).toMatchObject({
      replies: [{ text: "delivery failed" }],
    });
  });

  it("suppresses mutating tool warning finals after successful-looking replies", async () => {
    const draftStream = createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "Done." });
      await params?.dispatcher.sendFinalReply({
        text: "⚠️ 🛠️ `write file (agent)` failed",
        isError: true,
      } as never);
      return { queuedFinal: true, counts: { final: 2, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expectFreshFinalText("Done.");
    expect(draftStream.discardPending).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("renders reasoning block payloads as a 🧠 blockquote", async () => {
    mockDispatchSingleBlockReply({ text: "thinking...", isReasoning: true });
    await processStreamOffDiscordMessage();

    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(firstMockArg(deliverDiscordReply, "deliverDiscordReply")).toMatchObject({
      replies: [{ text: "> 🧠 thinking..." }],
    });
  });

  it("renders reasoning-tagged final payloads as a 🧠 blockquote, never the final", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({
        text: "Reasoning:\nthis renders as a quoted thinking message",
        isReasoning: true,
      });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: { streaming: { mode: "off" } },
    });

    await runProcessDiscordMessage(ctx);

    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(firstMockArg(deliverDiscordReply, "deliverDiscordReply")).toMatchObject({
      replies: [{ text: "> 🧠 this renders as a quoted thinking message" }],
    });
  });

  it("delivers non-reasoning block payloads to Discord", async () => {
    mockDispatchSingleBlockReply({ text: "hello from block stream" });
    await processStreamOffDiscordMessage();

    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("streams block previews using draft chunking", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onPartialReply?.({ text: "HelloWorld" });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createBlockModeContext();

    await runProcessDiscordMessage(ctx);

    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates).toEqual(["Hello", "HelloWorld"]);
  });

  it("keeps canonical block mode on the Discord draft preview path", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onPartialReply?.({ text: "HelloWorld" });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createBlockModeContext({ streaming: { mode: "block" } });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith("Hello");
    expect(firstDispatchParams().replyOptions?.disableBlockStreaming).toBe(true);
  });

  it("shows only the agent status in the default Discord progress draft", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReplyStart?.();
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Claiming my square footage. Tastefully, but with claws.",
      });
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledTimes(1);
    expect(draftStream.update).toHaveBeenCalledWith(
      "Claiming my square footage. Tastefully, but with claws.",
    );
    expect(String(draftStream.update.mock.calls[0]?.[0])).not.toMatch(/Working|Exec|\n\n/);
    expect(draftStream.flush).toHaveBeenCalledTimes(1);
    expect(
      requireRecord(firstDispatchParams().replyOptions, "dispatch reply options")
        .suppressDefaultToolProgressMessages,
    ).toBe(true);
  });

  it("renders a preamble headline without enabling commentary progress", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      expect(params?.replyOptions?.progressPreambleEnabled).toBe(true);
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking private context before replying.",
      });
      expect(draftStream.update).not.toHaveBeenCalled();
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "done" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: { label: false, commentary: false },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenLastCalledWith(
      "Checking private context before replying.",
    );
    expectFinalWithProgressReceipt("done", "🛠️ 1 tool call");
    expect(getDeliveredFinalTexts()[0]).not.toContain("💬");
  });

  it("renders plan updates as an immediate Discord checklist", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onPlanUpdate?.({
        phase: "update",
        explanation: "Implementing the change.",
        steps: [
          { step: "Inspect", status: "completed" },
          { step: "Patch", status: "in_progress" },
          { step: "Test", status: "pending" },
        ],
      });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: { mode: "progress", progress: { label: false } },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Implementing the change.\n\n✅ Inspect\n▸ Patch\n▢ Test",
    );
    expect(draftStream.flush).toHaveBeenCalledTimes(1);
  });
});
