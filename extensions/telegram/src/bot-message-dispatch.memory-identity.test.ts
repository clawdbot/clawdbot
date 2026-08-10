import { expect, it, vi } from "vitest";
import {
  createContext,
  createDirectSessionPayload,
  describeTelegramDispatch,
  dispatchWithContext,
  telegramDepsForTest,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramMessageContext } from "./bot-message-dispatch.test-harness.js";

describeTelegramDispatch("dispatchTelegramMessage memory identity admission", () => {
  it("binds an admitted direct-DM proof to the exact finalized context", async () => {
    const attachVerifiedDirectSender = vi.fn();
    const admitVerifiedDirectPairingSender = vi.fn();
    const ctxPayload = createDirectSessionPayload();
    const context = createContext({
      accountId: "account-1",
      ctxPayload,
      msg: {
        chat: { id: 123, type: "private" },
        from: { id: 456 },
        message_id: 789,
      } as TelegramMessageContext["msg"],
    });

    await dispatchWithContext({
      context,
      telegramDeps: {
        ...telegramDepsForTest,
        memoryIdentityAdmission: { attachVerifiedDirectSender, admitVerifiedDirectPairingSender },
      },
    });

    expect(attachVerifiedDirectSender).toHaveBeenCalledWith({
      context: ctxPayload,
      channel: "telegram",
      accountId: "account-1",
      stableSenderId: "456",
    });
  });

  it("never attaches a private-subject proof for a group event", async () => {
    const attachVerifiedDirectSender = vi.fn();
    const admitVerifiedDirectPairingSender = vi.fn();
    await dispatchWithContext({
      context: createContext({
        accountId: "account-1",
        isGroup: true,
        ctxPayload: {
          SessionKey: "agent:test:telegram:group:-100123",
          ChatType: "group",
        } as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -100123, type: "supergroup" },
          from: { id: 456 },
          message_id: 789,
        } as TelegramMessageContext["msg"],
      }),
      telegramDeps: {
        ...telegramDepsForTest,
        memoryIdentityAdmission: { attachVerifiedDirectSender, admitVerifiedDirectPairingSender },
      },
    });

    expect(attachVerifiedDirectSender).not.toHaveBeenCalled();
  });
});
