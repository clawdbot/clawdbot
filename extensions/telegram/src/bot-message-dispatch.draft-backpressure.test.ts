import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import {
  createBot,
  createContext,
  createTelegramDraftStream,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
} from "./bot-message-dispatch.test-harness.js";

describeTelegramDispatch("Telegram cumulative draft backpressure", () => {
  it("coalesces concurrent partial callbacks while the provider holds the first preview", async () => {
    const { createTelegramDraftStream: createRealDraftStream } =
      await vi.importActual<typeof import("./draft-stream.js")>("./draft-stream.js");
    createTelegramDraftStream.mockImplementation((params) =>
      createRealDraftStream({ ...params, throttleMs: 0, minInitialChars: 0 }),
    );
    const bot = createBot();
    const sendMessage = vi.spyOn(bot.api, "sendMessage");
    const editMessageText = vi.spyOn(bot.api, "editMessageText");
    let releaseSend!: () => void;
    const heldSend = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    sendMessage.mockImplementationOnce(async () => {
      await heldSend;
      return {
        message_id: 1001,
        message_thread_id: 777,
      } as Awaited<ReturnType<typeof bot.api.sendMessage>>;
    });
    const finalText = "Hele svaret er ferdig, inkludert den siste delen.";
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ replyOptions, dispatcherOptions }) => {
        const partial = replyOptions?.onPartialReply;
        expect(partial).toBeTypeOf("function");
        const pending = [
          Promise.resolve(partial?.({ text: "Første del av et svar som fortsetter." })),
        ];
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
        // Native callbacks start in source order without waiting for provider I/O.
        // The channel owns coalescing and must not turn every delta into an edit.
        for (let index = 0; index < 40; index += 1) {
          pending.push(Promise.resolve(partial?.({ text: `Mellomliggende svar ${index}.` })));
        }
        pending.push(Promise.resolve(partial?.({ text: finalText })));
        await setImmediate();
        expect(sendMessage).toHaveBeenCalledOnce();
        expect(editMessageText).not.toHaveBeenCalled();

        releaseSend();
        await Promise.all(pending);
        await dispatcherOptions.deliver({ text: finalText }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    try {
      await dispatchWithContext({ context: createContext(), bot });
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(editMessageText).toHaveBeenCalledOnce();
      expect(editMessageText.mock.calls[0]?.[2]).toBe(finalText);
    } finally {
      releaseSend();
    }
  });
});
