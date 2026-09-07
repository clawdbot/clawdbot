import { expect, it } from "vitest";
import {
  createReasoningStreamContext,
  createSequencedDraftStream,
  createTelegramDraftStream,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramDraftPreview } from "./draft-stream.js";

describeTelegramDispatch("Telegram reasoning beside progress headlines", () => {
  it.each([
    { richMessages: false, commentary: true },
    { richMessages: true, commentary: true },
    { richMessages: false, commentary: false },
    { richMessages: true, commentary: false },
  ])(
    "preserves the reasoning policy with richMessages=$richMessages, commentary=$commentary",
    async ({ richMessages, commentary }) => {
      const draftStream = createSequencedDraftStream(2001);
      createTelegramDraftStream.mockReturnValue(draftStream);
      const previews: Array<TelegramDraftPreview | undefined> = [];
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
        await replyOptions?.onReplyStart?.();
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await replyOptions?.onReasoningStream?.({ text: "Checking files" });
        previews.push(draftStream.updatePreview.mock.lastCall?.[0]);
        await replyOptions?.onItemEvent?.({
          kind: "preamble",
          itemId: "preamble-1",
          progressText: "Reading the workspace",
        });
        previews.push(draftStream.updatePreview.mock.lastCall?.[0]);
        await replyOptions?.onReasoningStream?.({
          text: "Checking files and configuration",
          isReasoningSnapshot: true,
        });
        previews.push(draftStream.updatePreview.mock.lastCall?.[0]);
        await replyOptions?.onReasoningProgress?.({ progressTokens: 200 });
        previews.push(draftStream.updatePreview.mock.lastCall?.[0]);
        return { queuedFinal: false };
      });

      await dispatchWithContext({
        context: createReasoningStreamContext(),
        streamMode: "progress",
        telegramCfg: {
          richMessages,
          streaming: {
            mode: "progress",
            progress: { commentary, toolProgress: true, label: false },
          },
        },
      });

      expect(createTelegramDraftStream).toHaveBeenCalledTimes(1);
      expect(previews).toHaveLength(4);
      expect(previews[0]?.text).toContain("Checking files");
      for (const [index, preview] of previews.slice(1).entries()) {
        expect(preview?.text).toContain("Reading the workspace");
        const visibleContent = richMessages ? JSON.stringify(preview?.richMessage) : preview?.text;
        if (commentary) {
          const reasoning = index === 0 ? "Checking files" : "Checking files and configuration";
          expect(preview?.text).toContain(reasoning);
          expect(visibleContent).toContain(reasoning);
          if (index === 2) {
            expect(visibleContent).toContain("Thinking… (~200 tokens)");
          }
        } else {
          // Headline-only mode intentionally buffers reasoning until the headline is gone.
          expect(preview?.text).not.toContain("🧠");
          expect(visibleContent).not.toContain("Checking files");
          expect(visibleContent).not.toContain("Thinking…");
        }
      }
    },
  );
});
