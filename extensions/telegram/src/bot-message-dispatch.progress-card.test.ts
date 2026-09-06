import { expect, it, vi } from "vitest";
import {
  createBot,
  createContext,
  createDirectSessionPayload,
  createSequencedDraftStream,
  createTelegramDraftStream,
  deliverReplies,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  editMessageTelegram,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramDraftStream } from "./draft-stream.js";

describeTelegramDispatch("dispatchTelegramMessage progress cards", () => {
  it.each(["progress", "partial", "block"] as const)(
    "retains the plan across an answer-to-tool transition in %s mode",
    async (mode) => {
      const draft = createSequencedDraftStream();
      createTelegramDraftStream.mockReturnValue(draft);
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions?.onAssistantMessageStart?.();
          await replyOptions?.onPlanUpdate?.({
            phase: "update",
            explanation: "Checking the change",
            steps: [{ step: "Verify delivery", status: "in_progress" }],
          });
          await replyOptions?.onToolStart?.({ name: "Read", phase: "start" });
          if (mode === "partial") {
            await replyOptions?.onPartialReply?.({ text: "Checking the result" });
          } else {
            await replyOptions?.onBlockReplyQueued?.({ text: "Checking the result" });
            await dispatcherOptions.deliver({ text: "Checking the result" }, { kind: "block" });
          }
          await replyOptions?.onAssistantMessageStart?.();
          await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
          return { queuedFinal: false };
        },
      );

      await dispatchWithContext({
        context: createContext(),
        streamMode: mode,
        telegramCfg: {
          streaming: {
            mode,
            progress: { toolProgress: true, label: false },
            preview: { toolProgress: true },
          },
        },
      });
      const preview = draft.updatePreview.mock.calls.at(-1)?.[0].text;
      expect(preview).toContain("Verify delivery (in progress)");
      expect(preview).toContain("Exec");
      if (mode === "progress") {
        expect(preview).toContain("Read");
      } else {
        expect(preview).not.toContain("Read");
      }
    },
  );

  // The real compositor, renderer and transport expose short sends, stopped
  // streams and lifecycle resets at Telegram's stubbed network boundary.
  it.each(["progress", "partial", "block"] as const)(
    "replaces, clears and resumes a short card before the final reply in %s mode",
    async (mode) => {
      vi.useFakeTimers();
      try {
        const actualDraft =
          await vi.importActual<typeof import("./draft-stream.js")>("./draft-stream.js");
        const actualDelivery = await vi.importActual<typeof import("./bot/delivery.replies.js")>(
          "./bot/delivery.replies.js",
        );
        const actualEdit = await vi.importActual<typeof import("./send-edit.js")>("./send-edit.js");
        deliverReplies.mockImplementation(actualDelivery.deliverReplies);
        editMessageTelegram.mockImplementation(actualEdit.editMessageTelegram);
        let draft: TelegramDraftStream | undefined;
        createTelegramDraftStream.mockImplementation((params) => {
          const stream = actualDraft.createTelegramDraftStream(params);
          draft ??= stream;
          return stream;
        });
        const bot = createBot();
        let nextMessageId = 1001;
        const visible = new Map<number, string>();
        const send = vi.spyOn(bot.api, "sendMessage").mockImplementation(async (_chatId, text) => {
          const message_id = nextMessageId++;
          visible.set(message_id, text);
          return {
            message_id,
            date: 0,
            chat: { id: 123, type: "private", first_name: "Fixture" },
            text,
          };
        });
        const edit = vi
          .spyOn(bot.api, "editMessageText")
          .mockImplementation(async (_chatId, messageId, text) => {
            if (typeof text !== "string") {
              throw new Error("Expected a plain-text Telegram edit");
            }
            visible.set(messageId, text);
            return true;
          });
        vi.spyOn(bot.api, "deleteMessage").mockImplementation(async (_chatId, messageId) => {
          visible.delete(messageId);
          return true;
        });
        dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
          async ({ dispatcherOptions, replyOptions }) => {
            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onPlanUpdate?.({ phase: "update", steps: [] });
            await draft?.flush();
            expect(send).not.toHaveBeenCalled();

            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onPlanUpdate?.({
              phase: "update",
              explanation: "Working",
              steps: [],
            });
            await draft?.flush();
            expect(send).toHaveBeenCalledOnce();
            expect([...visible.values()]).toEqual(["<b>Working</b>"]);

            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onPlanUpdate?.({
              phase: "update",
              explanation: "1/2 complete",
              steps: [
                { step: "Inspect", status: "completed" },
                { step: "Repair", status: "in_progress" },
              ],
            });
            await draft?.flush();
            expect(send).toHaveBeenCalledOnce();
            expect([...visible.values()][0]).toContain("[x] Inspect");
            expect([...visible.values()][0]).not.toContain("Working");

            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onPlanUpdate?.({ phase: "update", steps: [] });
            await vi.advanceTimersByTimeAsync(4_000);
            expect(visible.size).toBe(0);

            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onPlanUpdate?.({
              phase: "update",
              explanation: "Resumed",
              steps: [{ step: "Resume work", status: "in_progress" }],
            });
            await draft?.flush();
            expect(send).toHaveBeenCalledTimes(2);
            expect([...visible.values()][0]).toContain("<b>Resumed</b>");
            expect([...visible.values()][0]).toContain("Resume work (in progress)");

            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onItemEvent?.({
              kind: "tool",
              name: "progress_card",
              itemId: "blocked-card",
              status: "blocked",
            });
            await draft?.flush();
            expect([...visible.values()][0]).toContain("Resume work (in progress)");
            expect([...visible.values()][0]).toContain("Progress Card");
            expect([...visible.values()][0]).toContain("blocked");

            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onToolStart?.({
              phase: "start",
              name: "exec",
              toolCallId: "exec-proof",
              args: { command: "printf proof" },
            });
            await replyOptions?.onReasoningEnd?.();
            await draft?.flush();
            expect([...visible.values()][0]).toContain("Resume work (in progress)");
            expect([...visible.values()][0]).toContain("blocked");
            expect([...visible.values()][0]).toContain("Exec");

            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onPlanUpdate?.({ phase: "update", steps: [] });
            await draft?.flush();
            expect([...visible.values()][0]).toContain("Exec");
            expect([...visible.values()][0]).toContain("blocked");
            expect([...visible.values()][0]).not.toContain("Resumed");
            expect([...visible.values()][0]).not.toContain("Resume work");
            expect(send).toHaveBeenCalledTimes(2);

            await replyOptions?.onAssistantMessageStart?.();
            await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
            expect([...visible.values()]).toContain("Done");
            const finalMessages = [...visible.entries()];
            const sendsAfterFinal = send.mock.calls.length;
            const editsAfterFinal = edit.mock.calls.length;
            await replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onPlanUpdate?.({
              phase: "update",
              explanation: "Late card",
              steps: [],
            });
            await draft?.flush();
            expect(send).toHaveBeenCalledTimes(sendsAfterFinal);
            expect(edit).toHaveBeenCalledTimes(editsAfterFinal);
            expect([...visible.entries()]).toEqual(finalMessages);
            return { queuedFinal: true };
          },
        );

        await dispatchWithContext({
          bot,
          cfg: {
            agents: { defaults: { reasoningDefault: "stream" } },
            channels: { telegram: { botToken: "test-token" } },
          },
          context: createContext({
            ctxPayload: createDirectSessionPayload(),
            threadSpec: { id: undefined, scope: "none" },
            replyThreadId: undefined,
          }),
          streamMode: mode,
          telegramCfg: {
            streaming: {
              mode,
              progress: { toolProgress: true },
              preview: { toolProgress: true },
            },
          },
        });
        await vi.runOnlyPendingTimersAsync();
        expect([...visible.values()]).toEqual(["Done"]);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
