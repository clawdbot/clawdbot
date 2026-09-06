import { expect, it, vi } from "vitest";
import {
  createBot,
  createContext,
  createDirectSessionPayload,
  createTelegramDraftStream,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  expectDeliveredReply,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramDraftStream } from "./draft-stream.js";

// Use the real compositor, renderer and draft transport. Only Telegram's network
// boundary is replaced so short sends and stopped-stream regressions are visible.
describeTelegramDispatch("dispatchTelegramMessage progress cards", () => {
  it.each(["progress", "partial", "block"] as const)(
    "replaces, clears and resumes a short card before the final reply in %s mode",
    async (mode) => {
      vi.useFakeTimers();
      try {
        const actualDraft =
          await vi.importActual<typeof import("./draft-stream.js")>("./draft-stream.js");
        let draft: TelegramDraftStream | undefined;
        createTelegramDraftStream.mockImplementation((params) => {
          draft = actualDraft.createTelegramDraftStream(params);
          return draft;
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
        vi.spyOn(bot.api, "editMessageText").mockImplementation(
          async (_chatId, messageId, text) => {
            visible.set(messageId, text);
            return true;
          },
        );
        vi.spyOn(bot.api, "deleteMessage").mockImplementation(async (_chatId, messageId) => {
          visible.delete(messageId);
          return true;
        });
        dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
          async ({ dispatcherOptions, replyOptions }) => {
            await replyOptions?.onPlanUpdate?.({ phase: "update", steps: [] });
            await draft?.flush();
            expect(send).not.toHaveBeenCalled();

            await replyOptions?.onPlanUpdate?.({
              phase: "update",
              explanation: "Working",
              steps: [],
            });
            await draft?.flush();
            expect(send).toHaveBeenCalledOnce();
            expect([...visible.values()]).toEqual(["<b>Working</b>"]);

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

            await replyOptions?.onPlanUpdate?.({ phase: "update", steps: [] });
            await vi.advanceTimersByTimeAsync(4_000);
            expect(visible.size).toBe(0);

            await replyOptions?.onPlanUpdate?.({
              phase: "update",
              explanation: "Resumed",
              steps: [],
            });
            await draft?.flush();
            expect(send).toHaveBeenCalledTimes(2);
            expect([...visible.values()]).toEqual(["<b>Resumed</b>"]);

            await replyOptions?.onToolStart?.({
              phase: "start",
              name: "Read",
              args: { file_path: "/tmp/fixture.ts" },
            });
            await replyOptions?.onPlanUpdate?.({ phase: "update", steps: [] });
            await draft?.flush();
            expect([...visible.values()][0]).toContain("Read");
            expect([...visible.values()][0]).not.toContain("Resumed");
            expect(send).toHaveBeenCalledTimes(2);

            await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
            const sendsAfterFinal = send.mock.calls.length;
            await replyOptions?.onPlanUpdate?.({
              phase: "update",
              explanation: "Late card",
              steps: [],
            });
            await draft?.flush();
            expect(send).toHaveBeenCalledTimes(sendsAfterFinal);
            expect([...visible.values()].join("\n")).not.toContain("Late card");
            return { queuedFinal: true };
          },
        );

        await dispatchWithContext({
          bot,
          context: createContext({
            ctxPayload: createDirectSessionPayload(),
            threadSpec: { id: undefined, scope: "none" },
            replyThreadId: undefined,
          }),
          streamMode: mode,
          telegramCfg: {
            streaming: {
              mode,
              progress: { toolProgress: true, label: false },
              preview: { toolProgress: true },
            },
          },
        });
        expectDeliveredReply(0, { text: "Done" });
        await vi.runOnlyPendingTimersAsync();
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
