// Discord message processing coverage split by cohesive behavior.
import { describe, expect, it } from "vitest";
import {
  createAutomaticSourceDeliveryContext,
  createNoQueuedDispatchResult,
  createNonTerminalToolWarningPayload,
  deliverDiscordReply,
  dispatchInboundMessageForTest as dispatchInboundMessage,
  runProcessDiscordMessage,
  registerDiscordProcessTestLifecycle,
} from "./message-handler.process.test-harness.js";
import type { DispatchInboundParams } from "./message-handler.process.test-harness.js";
import {
  createMockDraftStreamForTest,
  expectFinalWithProgressReceipt,
  getDeliveredFinalTexts,
  useProgressDraftStartDelay,
} from "./message-handler.process.test-helpers.js";

registerDiscordProcessTestLifecycle();

describe("processDiscordMessage draft streaming progress", () => {
  it("keeps opt-in commentary receipts independent from hidden tool progress", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-silent",
        kind: "preamble",
        progressText: "[[reply_to_current]] _NO_REPLY_ [[audio_as_voice]]",
      });
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking the current weather source before summarizing.",
      });
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking the current weather source before summarizing clearly.",
      });
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-2",
        kind: "preamble",
        progressText: "Checking route impacts.",
      });
      await params?.replyOptions?.onItemEvent?.({
        itemId: "tool-1",
        kind: "tool",
        name: "exec",
        progressText: "curl weather api",
      });
      await params?.dispatcher.sendFinalReply({ text: "done" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: false,
            toolProgress: false,
            commentary: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenLastCalledWith(
      "💬 Checking the current weather source before summarizing clearly.\n💬 Checking route impacts.",
    );
    const updates = draftStream.update.mock.calls.map((call) => call[0]).join("\n");
    expect(updates).not.toContain("Exec");
    expect(updates).not.toContain("curl weather api");
    expectFinalWithProgressReceipt("done", "💬 2 notes", "🛠️ 1 tool call");
  });

  it.each([
    ["active", true],
    ["inactive", false],
  ])(
    "renders Discord commentary in the draft exactly when durable verbose progress is %s",
    async (_label, durableLaneActive) => {
      const draftStream = createMockDraftStreamForTest();

      dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
        params?.replyOptions?.onVerboseProgressVisibility?.(() => durableLaneActive);
        await params?.replyOptions?.onItemEvent?.({
          itemId: "preamble-1",
          kind: "preamble",
          progressText: "Checking the current weather source before summarizing.",
        });
        return createNoQueuedDispatchResult();
      });

      const ctx = await createAutomaticSourceDeliveryContext({
        discordConfig: {
          streaming: {
            mode: "progress",
            progress: {
              label: false,
              toolProgress: false,
              commentary: true,
            },
          },
        },
      });

      await runProcessDiscordMessage(ctx);

      const updates = draftStream.update.mock.calls.map((call) => call[0]).join("\n");
      if (durableLaneActive) {
        // The durable verbose lane owns commentary: the ephemeral draft must
        // not render it a second time.
        expect(updates).toBe("");
      } else {
        expect(updates).toContain("Checking the current weather source");
      }
    },
  );

  it.each([
    ["active", true],
    ["inactive", false],
  ])(
    "renders Discord tool lines in the draft exactly when durable verbose progress is %s",
    async (_label, durableLaneActive) => {
      const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
      const draftStream = createMockDraftStreamForTest();

      dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
        params?.replyOptions?.onVerboseProgressVisibility?.(() => durableLaneActive);
        await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await params?.replyOptions?.onItemEvent?.({ progressText: "exec running" });
        await params?.replyOptions?.onCommandOutput?.({
          phase: "end",
          title: "Exec",
          name: "exec",
          exitCode: 0,
        });
        await elapseProgressDraftStartDelay();
        return createNoQueuedDispatchResult();
      });

      const ctx = await createAutomaticSourceDeliveryContext({
        discordConfig: {
          streaming: { mode: "progress", progress: { label: "Shelling" } },
        },
      });

      await runProcessDiscordMessage(ctx);

      const updates = draftStream.update.mock.calls.map((call) => call[0]).join("\n");
      if (durableLaneActive) {
        // The durable verbose lane persists tool summaries: the ephemeral
        // draft must not render the same tool activity a second time.
        expect(updates).toBe("");
      } else {
        expect(updates).toContain("Exec");
      }
    },
  );

  it("retracts a preamble headline by item identity", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Temporary note.",
      });
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "",
      });
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: false,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenLastCalledWith("🛠️ Exec");
    expect(draftStream.update.mock.calls.flat().join("\n")).not.toContain("Temporary note.");
    // Cleanup still removes the unfinished tool-progress draft at run end.
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("does not update Discord commentary progress after final answer delivery starts", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking source data.",
      });
      void params?.dispatcher.sendFinalReply({ text: "done" });
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-2",
        kind: "preamble",
        progressText: "Late commentary should not edit the draft.",
      });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: false,
            commentary: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates).toEqual(["💬 Checking source data."]);
    expectFinalWithProgressReceipt("done");
  });

  it("does not start Discord progress drafts for text-only accepted turns", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async () => createNoQueuedDispatchResult());

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Shelling",
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).not.toHaveBeenCalled();
    expect(draftStream.flush).not.toHaveBeenCalled();
  });

  it("keeps Discord progress drafts instead of delivering text-only interim blocks after work expands", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendBlockReply({ text: "on it" });
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "done" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 1 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Shelling",
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith("Shelling\n\n🛠️ Exec\n• exec done");
    expectFinalWithProgressReceipt("done", "🛠️ 1 tool call");
  });

  it("drops later tool warning finals after progress preview final replies", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "delivery survived" });
      await params?.dispatcher.waitForIdle();
      await params?.dispatcher.sendFinalReply(createNonTerminalToolWarningPayload());
      return { queuedFinal: true, counts: { final: 2, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Shelling",
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith("Shelling\n\n🛠️ Exec\n• exec done");
    // The delivered final consumed the draft; the later tool warning must not
    // resurrect it or produce a second visible reply.
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(draftStream.messageId()).toBeUndefined();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expectFinalWithProgressReceipt("delivery survived", "🛠️ 1 tool call");
  });

  it("consumes a progress draft once across repeated final payloads", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "first answer" });
      await params?.dispatcher.waitForIdle();
      await params?.dispatcher.sendFinalReply({ text: "second answer" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 2, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: { mode: "progress", progress: { label: "Shelling" } },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    const finals = getDeliveredFinalTexts();
    expect(finals).toHaveLength(2);
    expect(finals[0]).toMatch(/^first answer\n-# .*🛠️ 1 tool call/);
    expect(finals[1]).toBe("second answer");
  });

  it("preserves the progress receipt when the first final delivery fails", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();
    deliverDiscordReply.mockRejectedValueOnce(new Error("Discord unavailable"));

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "first answer" });
      await params?.dispatcher.waitForIdle();
      await params?.dispatcher.sendFinalReply({ text: "retry answer" });
      await params?.dispatcher.waitForIdle();
      return {
        queuedFinal: true,
        counts: { final: 1, tool: 0, block: 0 },
        failedCounts: { final: 1 },
      };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: { mode: "progress", progress: { label: "Shelling" } },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    const attemptedFinals = getDeliveredFinalTexts();
    expect(attemptedFinals).toHaveLength(2);
    expect(attemptedFinals[0]).toMatch(/^first answer\n-# .*🛠️ 1 tool call/);
    expect(attemptedFinals[1]).toMatch(/^retry answer\n-# .*🛠️ 1 tool call/);
  });

  it("re-arms progress collapse for a queued assistant turn", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "first tool done" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "first answer" });
      await params?.dispatcher.waitForIdle();
      await params?.replyOptions?.onAssistantMessageStart?.();
      await params?.replyOptions?.onToolStart?.({ name: "read", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "second tool done" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "second answer" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 2, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: { mode: "progress", progress: { label: "Shelling" } },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.clear).toHaveBeenCalledTimes(2);
    expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    const finals = getDeliveredFinalTexts();
    expect(finals).toHaveLength(2);
    expect(finals[0]).toMatch(/^first answer\n-# .*🛠️ 1 tool call/);
    expect(finals[1]).toMatch(/^second answer\n-# .*🛠️ 1 tool call/);
  });

  it("does not collapse a text-only queued assistant turn", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "first tool done" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "first answer" });
      await params?.dispatcher.waitForIdle();
      await params?.replyOptions?.onAssistantMessageStart?.();
      await params?.dispatcher.sendFinalReply({ text: "text-only answer" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 2, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: { mode: "progress", progress: { label: "Shelling" } },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(getDeliveredFinalTexts()).toEqual([
      expect.stringMatching(/^first answer\n-# /),
      "text-only answer",
    ]);
  });

  it("cleans up an unfinished queued progress turn", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "first tool done" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "first answer" });
      await params?.dispatcher.waitForIdle();
      await params?.replyOptions?.onAssistantMessageStart?.();
      await params?.replyOptions?.onToolStart?.({ name: "read", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "queued work" });
      await elapseProgressDraftStartDelay();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: { mode: "progress", progress: { label: "Shelling" } },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(2);
    expect(draftStream.messageId()).toBeUndefined();
  });

  it("uses raw tool-progress detail in Discord progress drafts", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({
        name: "exec",
        phase: "start",
        args: { command: "pnpm test -- --watch=false" },
        detailMode: "raw",
      });
      await params?.replyOptions?.onItemEvent?.({ progressText: "done" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Shelling",
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Shelling\n\n🛠️ run tests, `pnpm test -- --watch=false`\n• done",
    );
  });

  it("can hide raw command progress text in Discord progress drafts by config", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({
        name: "exec",
        phase: "start",
        args: { command: "pnpm test -- --watch=false" },
        detailMode: "raw",
      });
      await params?.replyOptions?.onItemEvent?.({ progressText: "done" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Shelling",
            commandText: "status",
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith("Shelling\n\n🛠️ Exec\n• done");
  });

  it("keeps Discord progress lines below the configured label", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "first", phase: "start" });
      await params?.replyOptions?.onToolStart?.({ name: "second", phase: "start" });
      await params?.replyOptions?.onToolStart?.({ name: "third", phase: "start" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
            maxLines: 4,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith("Clawing...\n\n🧩 First\n🧩 Second\n🧩 Third");
  });
});
