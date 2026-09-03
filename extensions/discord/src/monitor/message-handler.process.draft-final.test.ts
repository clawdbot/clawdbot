// Discord message processing coverage split by cohesive behavior.
import { describe, expect, it, vi } from "vitest";
import {
  BASE_CHANNEL_ROUTE,
  createBaseContext,
  createDiscordDraftStream,
  createMockDraftStream,
  createNoQueuedDispatchResult,
  deliverDiscordReply,
  dispatchInboundMessageForTest as dispatchInboundMessage,
  editMessageDiscord,
  getGlobalHookRunnerForTest as getGlobalHookRunner,
  getLastDispatchReplyOptions,
  getSessionEntry,
  readLatestAssistantTextByIdentity,
  runProcessDiscordMessage,
  registerDiscordProcessTestLifecycle,
} from "./message-handler.process.test-harness.js";
import type { DispatchInboundParams } from "./message-handler.process.test-harness.js";
import {
  createAutomaticDraftContext,
  createMockDraftStreamForTest,
  expectFinalAnswerText,
  expectFreshFinalText,
  firstMockArg,
  getDeliveredFinalTexts,
  runSingleChunkFinalScenario,
  useProgressDraftStartDelay,
} from "./message-handler.process.test-helpers.js";

registerDiscordProcessTestLifecycle();

const PREVIEW_MODES = ["partial", "block", "progress"] as const;

function registerHooks(...hooks: string[]) {
  const registered = new Set(hooks);
  getGlobalHookRunner.mockReturnValue({
    hasHooks: vi.fn((hookName: string) => registered.has(hookName)),
  });
}

async function runHookSafetyFinalReply(mode: (typeof PREVIEW_MODES)[number]) {
  dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
    await params?.dispatcher.sendFinalReply({ text: "final answer" });
    await params?.dispatcher.waitForIdle();
    return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
  });
  const ctx = await createAutomaticDraftContext({
    discordConfig: { streaming: { mode } },
  });
  await runProcessDiscordMessage(ctx);
}

describe("processDiscordMessage provider preview hook safety", () => {
  it.each(PREVIEW_MODES)("preserves %s previews when no hooks are registered", async (mode) => {
    await runHookSafetyFinalReply(mode);

    expect(createDiscordDraftStream).toHaveBeenCalledTimes(1);
  });

  it("preserves previews for observer-only hooks", async () => {
    registerHooks("message_sent");

    await runHookSafetyFinalReply("progress");

    expect(createDiscordDraftStream).toHaveBeenCalledTimes(1);
  });

  it.each(
    ["reply_payload_sending", "message_sending"].flatMap((hookName) =>
      PREVIEW_MODES.map((mode) => [hookName, mode] as const),
    ),
  )("suppresses %s-capable %s previews", async (hookName, mode) => {
    registerHooks(hookName);

    await runHookSafetyFinalReply(mode);

    expect(createDiscordDraftStream).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("suppresses previews when both modifying hooks are registered", async () => {
    registerHooks("reply_payload_sending", "message_sending");

    await runHookSafetyFinalReply("partial");

    expect(createDiscordDraftStream).not.toHaveBeenCalled();
  });

  it("keeps explicitly disabled previews off without hooks", async () => {
    const ctx = await createAutomaticDraftContext({
      discordConfig: { streaming: { mode: "off" } },
    });

    await runProcessDiscordMessage(ctx);

    expect(createDiscordDraftStream).not.toHaveBeenCalled();
  });

  it("uses an explicit partial preview despite inherited block delivery", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      expect(params?.replyOptions?.disableBlockStreaming).toBe(true);
      await params?.replyOptions?.onPartialReply?.({ text: "Hello" });
      await params?.dispatcher.sendFinalReply({ text: "Hello" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });
    const ctx = await createAutomaticDraftContext({
      cfg: { agents: { defaults: { blockStreamingDefault: "on" } } },
      discordConfig: { streaming: { mode: "partial" } },
    });

    await runProcessDiscordMessage(ctx);

    expect(createDiscordDraftStream).toHaveBeenCalledTimes(1);
  });

  it("does not re-enter final delivery after message_sending cancellation", async () => {
    registerHooks("message_sending");
    deliverDiscordReply.mockResolvedValueOnce({ visibleReplySent: false });

    await runHookSafetyFinalReply("partial");

    expect(createDiscordDraftStream).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });
});

describe("processDiscordMessage draft streaming final delivery", () => {
  it("sends a fresh final message when final fits one chunk", async () => {
    await runSingleChunkFinalScenario({ streaming: { mode: "partial" }, maxLinesPerMessage: 5 });
    expect(editMessageDiscord).not.toHaveBeenCalled();
    expectFreshFinalText("Hello\nWorld");
  });

  it("retries stale preview cleanup at teardown after fresh final delivery", async () => {
    const draftStream = createMockDraftStream();
    draftStream.clear.mockImplementationOnce(async () => {});
    createDiscordDraftStream.mockReturnValueOnce(draftStream);

    await runSingleChunkFinalScenario({
      streaming: { mode: "partial" },
      maxLinesPerMessage: 5,
    });

    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(2);
    expect(draftStream.messageId()).toBeUndefined();
  });

  it("preserves a delivered final when its first stale-preview cleanup fails", async () => {
    const draftStream = createMockDraftStream();
    draftStream.clear.mockRejectedValueOnce(new Error("preview cleanup failed"));
    createDiscordDraftStream.mockReturnValueOnce(draftStream);
    const runtimeError = vi.fn();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "Hello\nWorld" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });
    const ctx = await createAutomaticDraftContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
      runtime: { log: vi.fn(), error: runtimeError },
    });

    await runProcessDiscordMessage(ctx);

    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(2);
    expect(runtimeError).not.toHaveBeenCalled();
    expectFreshFinalText("Hello\nWorld");
  });

  it("delivers a fresh message instead of a preview edit when the final reply resolves a mention alias", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "On it @Sentinel" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
      cfg: {
        channels: { discord: { mentionAliases: { Sentinel: "1485891428809707651" } } },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("delivers a fresh message instead of a preview edit for a literal user mention in the final reply", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "On it <@1485891428809707651>" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("sends a fresh final message when an unaliased handle stays plain text", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "On it @Sentinel" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("sends a fresh final message for broadcast mentions like @everyone", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "heads up @everyone" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(firstMockArg(deliverDiscordReply, "deliverDiscordReply")).toMatchObject({
      allowedMentions: { parse: ["users", "roles"] },
      onPlatformSendDispatch: expect.any(Function),
    });
  });

  it("sends a fresh final message when a targeted mention is mixed with @everyone", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "heads up @Sentinel @everyone" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
      cfg: {
        channels: { discord: { mentionAliases: { Sentinel: "1485891428809707651" } } },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(firstMockArg(deliverDiscordReply, "deliverDiscordReply")).toMatchObject({
      allowedMentions: { parse: ["users", "roles"] },
    });
  });

  it("keeps unset Discord preview streaming off and delivers the final normally", async () => {
    await runSingleChunkFinalScenario({ maxLinesPerMessage: 5 });
    expect(getLastDispatchReplyOptions()?.onPartialReply).toBeUndefined();
    expect(createDiscordDraftStream).not.toHaveBeenCalled();
    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expectFreshFinalText("Hello\nWorld");
  });

  it("does not stream Discord tool progress before the initial delay", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await params?.dispatcher.sendFinalReply({ text: "done" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: { streaming: { mode: "progress" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).not.toHaveBeenCalled();
    expectFreshFinalText("done");
    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(draftStream.deleteCurrentMessage).not.toHaveBeenCalled();
  });

  it("does not attach a progress receipt when final delivery starts before the delay", async () => {
    vi.useFakeTimers();
    const draftStream = createMockDraftStreamForTest();
    let notifyLookupStarted: (() => void) | undefined;
    let resolveTranscriptLookup: (() => void) | undefined;
    const lookupStarted = new Promise<void>((resolve) => {
      notifyLookupStarted = resolve;
    });
    const truncatedFinal =
      "Here is the complete Discord answer with enough stable prefix text before truncation...";

    getSessionEntry.mockReturnValue({ sessionId: "session-1" });
    readLatestAssistantTextByIdentity.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTranscriptLookup = () => resolve(undefined);
          notifyLookupStarted?.();
        }),
    );
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await params?.dispatcher.sendFinalReply({ text: truncatedFinal });
      await lookupStarted;
      await vi.advanceTimersByTimeAsync(5_000);
      resolveTranscriptLookup?.();
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticDraftContext({
      baseSessionKey: BASE_CHANNEL_ROUTE.sessionKey,
      discordConfig: { streaming: { mode: "progress" }, maxLinesPerMessage: 5 },
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).not.toHaveBeenCalled();
    expectFreshFinalText(truncatedFinal);
    expect(getDeliveredFinalTexts()[0]).not.toContain("\n-# ");
  });

  it("streams Discord tool progress when explicitly enabled", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "done" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: {
        maxLinesPerMessage: 5,
        streaming: {
          mode: "progress",
          progress: { label: "Working", toolProgress: true },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates).toEqual(["Working"]);
    expectFinalAnswerText("done");
    // The working draft deletes once the receipt-bearing final landed.
    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(draftStream.messageId()).toBeUndefined();
  });

  it("renders narration updates into the Discord progress draft", async () => {
    vi.useFakeTimers();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      expect(params?.replyOptions?.isProgressDraftVisible?.()).toBe(false);
      await params?.replyOptions?.onNarrationUpdate?.({
        text: "Reading the gateway config and restarting agents.",
      });
      expect(draftStream.update).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(params?.replyOptions?.isProgressDraftVisible?.()).toBe(true);
      await params?.dispatcher.sendFinalReply({ text: "done" });
      expect(params?.replyOptions?.isProgressDraftVisible?.()).toBe(false);
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: { streaming: { mode: "progress" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates).toContain("Reading the gateway config and restarting agents.");
    expectFinalAnswerText("done");
  });

  it("stops narration at final and resets it for a queued turn", async () => {
    createMockDraftStreamForTest();
    const beginTurn = vi.fn();
    const stopTurn = vi.fn();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      params?.replyOptions?.onProgressNarratorLifecycle?.({ beginTurn, stopTurn });
      await params?.dispatcher.sendFinalReply({ text: "primary" });
      expect(stopTurn).toHaveBeenCalled();

      await params?.replyOptions?.onAssistantMessageStart?.();
      expect(beginTurn).toHaveBeenCalledOnce();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: { streaming: { mode: "progress" } },
    });
    await runProcessDiscordMessage(ctx);
  });

  it("omits the narration callback when progress narration is disabled", async () => {
    createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async () => createNoQueuedDispatchResult());

    const ctx = await createAutomaticDraftContext({
      discordConfig: {
        streaming: { mode: "progress", progress: { label: "Shelling", narration: false } },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(getLastDispatchReplyOptions()?.onNarrationUpdate).toBeUndefined();
    expect(getLastDispatchReplyOptions()?.isProgressDraftVisible).toBeUndefined();
  });

  it("mirrors status-only command text into the narration input policy", async () => {
    createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async () => createNoQueuedDispatchResult());

    const ctx = await createAutomaticDraftContext({
      discordConfig: {
        streaming: { mode: "progress", progress: { label: "Shelling", commandText: "status" } },
      },
    });

    await runProcessDiscordMessage(ctx);

    const replyOptions = getLastDispatchReplyOptions();
    expect(replyOptions?.onNarrationUpdate).toBeDefined();
    expect(replyOptions?.isProgressDraftVisible).toBeDefined();
    expect(replyOptions?.narrationHideCommandText).toBe(true);
  });

  it("declines failed item progress without updating the Discord draft", async () => {
    const draftStream = createMockDraftStreamForTest();
    let callbackResult: boolean | void = undefined;

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      callbackResult = await params?.replyOptions?.onItemEvent?.({
        itemId: "tool-1",
        kind: "tool",
        name: "exec",
        phase: "end",
        status: "failed",
        progressText: "exec failed",
      });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: { streaming: { mode: "progress" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(callbackResult).toBe(false);
    expect(draftStream.update).not.toHaveBeenCalled();
  });

  it("declines failed command output without updating the Discord draft", async () => {
    const draftStream = createMockDraftStreamForTest();
    let callbackResult: false | void = undefined;

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      callbackResult = await params?.replyOptions?.onCommandOutput?.({
        phase: "error",
        title: "Exec",
        name: "exec",
        status: "error",
        exitCode: 1,
      });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: { streaming: { mode: "progress" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(callbackResult).toBe(false);
    expect(draftStream.update).not.toHaveBeenCalled();
  });

  it("suppresses terminal progress callbacks without their terminal phase", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onApprovalEvent?.({ command: "must stay hidden" });
      await params?.replyOptions?.onCommandOutput?.({ title: "must stay hidden", exitCode: 0 });
      await params?.replyOptions?.onPatchSummary?.({ summary: "must stay hidden" });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: { streaming: { mode: "progress" } },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).not.toHaveBeenCalled();
  });

  it("counts window thinking bursts closed by a tool call when no end event fires", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    // deepseek streams reasoning then a tool call with no thinking_end between
    // bursts; the tool-start boundary (and the summary flush) must still tally.
    createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReasoningStream?.({ text: "Listing the workspace" });
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({ text: "Picking the largest" });
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({ text: "Composing the answer" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "done" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: {
        streaming: { mode: "progress", progress: { label: "Shelling", thinking: true } },
      },
    });

    await runProcessDiscordMessage(ctx);

    // 2 bursts closed by tool calls + 1 trailing burst flushed at summary.
    expectFinalAnswerText("done");
  });

  it("counts window thinking bursts in the collapse summary", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReasoningStream?.({ text: "Planning the survey" });
      await params?.replyOptions?.onReasoningEnd?.();
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({ text: "Reading results" });
      await params?.replyOptions?.onReasoningEnd?.();
      // A boundary without a preceding burst must not inflate the count.
      await params?.replyOptions?.onReasoningEnd?.();
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "done" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: {
        streaming: { mode: "progress", progress: { label: "Shelling", thinking: true } },
      },
    });

    await runProcessDiscordMessage(ctx);

    expectFinalAnswerText("done");
  });

  it("counts distinct narration notes in the collapse summary", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onItemEvent?.({
        kind: "preamble",
        itemId: "p1",
        progressText: "Listing the workspace",
      });
      // Re-fire of the same note (delta/snapshot) must not inflate the count.
      await params?.replyOptions?.onItemEvent?.({
        kind: "preamble",
        itemId: "p1",
        progressText: "Listing the workspace files",
      });
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await elapseProgressDraftStartDelay();
      await params?.replyOptions?.onItemEvent?.({
        kind: "preamble",
        itemId: "p2",
        progressText: "Composing the answer",
      });
      await params?.dispatcher.sendFinalReply({ text: "done" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: {
        streaming: { mode: "progress", progress: { label: "Shelling", commentary: true } },
      },
    });

    await runProcessDiscordMessage(ctx);

    expectFinalAnswerText("done");
  });

  it("does not update Discord progress drafts after final answer delivery", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec running" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "done" });
      await params?.dispatcher.waitForIdle();
      await params?.replyOptions?.onCommandOutput?.({
        phase: "end",
        title: "Exec",
        name: "exec",
        exitCode: 1,
      });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: {
        maxLinesPerMessage: 5,
        streaming: { mode: "progress", progress: { label: "Shelling" } },
      },
    });

    await runProcessDiscordMessage(ctx);

    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates).toEqual(["Shelling"]);
    expectFinalAnswerText("done");
  });

  it("does not update Discord progress drafts while final answer delivery is pending", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec running" });
      await elapseProgressDraftStartDelay();
      void params?.dispatcher.sendFinalReply({ text: "done" });
      await params?.replyOptions?.onCommandOutput?.({
        phase: "end",
        title: "Exec",
        name: "exec",
        exitCode: 1,
      });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: {
        maxLinesPerMessage: 5,
        streaming: { mode: "progress", progress: { label: "Shelling" } },
      },
    });

    await runProcessDiscordMessage(ctx);

    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates).toEqual(["Shelling"]);
    expectFinalAnswerText("done");
  });

  it("streams a quiet work summary for coding-profile message-tool-only guild replies", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      expect(params?.replyOptions?.sourceReplyDeliveryMode).toBe("message_tool_only");
      expect(params?.replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed).toBe(true);
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createBaseContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: { toolProgress: true },
        },
      },
      cfg: {
        channels: {
          discord: {
            streaming: {
              mode: "progress",
              progress: { toolProgress: true },
            },
          },
        },
        tools: { profile: "coding" },
        messages: {
          groupChat: { visibleReplies: "message_tool" },
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(draftStream.update).toHaveBeenCalledWith("Working");
    expect(deliverDiscordReply).not.toHaveBeenCalled();
  });

  it("keeps Discord preview streaming off when explicitly disabled", async () => {
    await runSingleChunkFinalScenario({ streaming: { mode: "off" }, maxLinesPerMessage: 5 });
    expect(createDiscordDraftStream).not.toHaveBeenCalled();
    expect(editMessageDiscord).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });
});
