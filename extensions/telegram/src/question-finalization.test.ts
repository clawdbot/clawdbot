// Covers Telegram question delivery capture and native final edit.
import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  edit: vi.fn(),
  registration: undefined as
    | { finalize: (statusLine: string) => void | Promise<void>; deliveryId: string }
    | undefined,
}));
vi.mock("openclaw/plugin-sdk/question-gateway-runtime", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("openclaw/plugin-sdk/question-gateway-runtime")>();
  return {
    ...original,
    questionGatewayRuntime: {
      ...original.questionGatewayRuntime,
      registerChannelDelivery: (registration: typeof hoisted.registration) => {
        hoisted.registration = registration;
      },
    },
  };
});
vi.mock("./send.js", () => ({ editMessageTelegram: hoisted.edit }));

import { createTelegramOutboundAdapter } from "./outbound-adapter.js";

describe("Telegram question finalization", () => {
  it("removes buttons and appends terminal status", async () => {
    const outbound = createTelegramOutboundAdapter();
    await outbound.afterDeliverPayload?.({
      cfg: {},
      target: { channel: "telegram", to: "123", accountId: "default" },
      payload: {
        text: "Long preface\n\nPick one",
        channelData: {
          askUser: { questionId: "ask_0123456789abcdef0123456789abcdef" },
        },
      },
      results: [
        {
          channel: "telegram",
          messageId: "54",
          chatId: "123",
          meta: { telegramDeliveredText: "Long preface", telegramHasInlineKeyboard: false },
        },
        {
          channel: "telegram",
          messageId: "55",
          chatId: "123",
          meta: { telegramDeliveredText: "Pick one", telegramHasInlineKeyboard: true },
        },
      ],
    });

    await hoisted.registration?.finalize("Answered: One");
    expect(hoisted.edit).toHaveBeenCalledWith("123", "55", "Pick one\n\nAnswered: One", {
      cfg: {},
      accountId: "default",
      buttons: [],
      verbose: false,
    });
  });
});
