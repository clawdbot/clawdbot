import { expect, it, vi } from "vitest";
import {
  createChannelMessageReplyPipeline,
  createContext,
  createRuntime,
  createStatusReactionController,
  describeTelegramDispatch,
  dispatchWithContext,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramMessageContext } from "./bot-message-dispatch.test-harness.js";
import { notifyTelegramInboundEventOutboundSuccess } from "./inbound-event-delivery.js";

describeTelegramDispatch("dispatchTelegramMessage pipeline-init", () => {
  it("cleans delivery correlation when reply-pipeline initialization fails", async () => {
    const sessionKey = "agent:main:telegram:direct:pipeline-init-failure";
    const statusReactionController = createStatusReactionController();
    const reactionApi = vi.fn(async () => undefined);
    const runtime = createRuntime();
    runtime.error = vi.fn(() => {
      notifyTelegramInboundEventOutboundSuccess({
        sessionKey,
        to: "123",
        accountId: "default",
      });
    });
    createChannelMessageReplyPipeline.mockImplementationOnce(() => {
      throw new Error("pipeline initialization failed");
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: sessionKey,
          ChatType: "direct",
        } as TelegramMessageContext["ctxPayload"],
        statusReactionController: statusReactionController as never,
        reactionApi,
      }),
      runtime,
      suppressFailureFallback: true,
    });

    await vi.waitFor(() => {
      expect(statusReactionController.restoreInitial).toHaveBeenCalled();
    });
    expect(reactionApi).not.toHaveBeenCalled();
  });
});
