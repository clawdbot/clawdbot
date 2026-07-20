import { DEFAULT_TIMING } from "openclaw/plugin-sdk/channel-feedback";
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
    vi.useFakeTimers();
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
        removeAckAfterReply: true,
      }),
      runtime,
      suppressFailureFallback: true,
    });

    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.errorHoldMs);
    expect(statusReactionController.restoreInitial).toHaveBeenCalled();
    expect(reactionApi).not.toHaveBeenCalled();
  });
});
