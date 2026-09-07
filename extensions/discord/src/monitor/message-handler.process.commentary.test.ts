import { describe, expect, it } from "vitest";
import {
  deliverDiscordReply,
  dispatchInboundMessageForTest as dispatchInboundMessage,
  registerDiscordProcessTestLifecycle,
  runProcessDiscordMessage,
} from "./message-handler.process.test-harness.js";
import type { DispatchInboundParams } from "./message-handler.process.test-harness.js";
import {
  createAutomaticDraftContext,
  createMockDraftStreamForTest,
  expectFinalAnswerText,
} from "./message-handler.process.test-helpers.js";

registerDiscordProcessTestLifecycle();

describe("Discord durable commentary delivery", () => {
  it("delivers admitted commentary once without exposing ordinary progress blocks", async () => {
    createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      params?.replyOptions?.onVerboseProgressVisibility?.(() => true);
      await params?.dispatcher.sendBlockReply({ text: "ordinary interim text" });
      await params?.dispatcher.sendBlockReply({
        text: "Checking the source before asking.",
        isCommentary: true,
      });
      await params?.dispatcher.sendFinalReply({ text: "done" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 1 } };
    });
    const ctx = await createAutomaticDraftContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: { toolProgress: false, commentary: true },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(deliverDiscordReply).toHaveBeenCalledTimes(2);
    expect(deliverDiscordReply).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [{ text: "Checking the source before asking.", isCommentary: true }],
      }),
    );
    expectFinalAnswerText("done");
  });
});
