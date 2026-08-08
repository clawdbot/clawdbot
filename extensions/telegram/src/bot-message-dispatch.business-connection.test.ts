import { it } from "vitest";
import {
  createContext,
  createDraftStream,
  createTelegramDraftStream,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  expectDraftStreamParams,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramMessageContext } from "./bot-message-dispatch.test-harness.js";

// Regression coverage for the direct streamed-reply funnel (createTelegramDraftStream,
// via createTelegramDraftController) — the path a normal agent reply actually takes,
// distinct from outbound-adapter.ts's business-route lookup by chat id. Business
// Connect messages must thread business_connection_id through here too, or the
// streamed reply is sent/edited as the bot identity instead of the connected account.
describeTelegramDispatch("dispatchTelegramMessage business connection routing", () => {
  it("threads business_connection_id from a business DM into the streamed draft reply", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({ queuedFinal: true });

    await dispatchWithContext({
      context: createContext({
        msg: {
          business_connection_id: "biz-conn-123",
        } as unknown as TelegramMessageContext["msg"],
      }),
    });

    expectDraftStreamParams({ businessConnectionId: "biz-conn-123" });
  });

  it("does not set businessConnectionId for a plain (non-business) DM", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({ queuedFinal: true });

    await dispatchWithContext({ context: createContext() });

    expectDraftStreamParams({ businessConnectionId: undefined });
  });
});
