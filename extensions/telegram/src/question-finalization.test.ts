// Covers Telegram question delivery capture and native final edit.
import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  edit: vi.fn(),
  editMarkup: vi.fn(),
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
vi.mock("./send.js", () => ({
  editMessageReplyMarkupTelegram: hoisted.editMarkup,
  editMessageTelegram: hoisted.edit,
}));

import { createTelegramOutboundAdapter } from "./outbound-adapter.js";

describe("Telegram question finalization", () => {
  it("removes buttons and appends terminal status", async () => {
    const deliveredText = "x".repeat(5000);
    const statusLine = `Answered: ${"y".repeat(600)}`;
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
          target: { kind: "chat", id: "123" },
          meta: { telegramDeliveredText: "Long preface", telegramHasInlineKeyboard: false },
        },
        {
          channel: "telegram",
          messageId: "55",
          target: { kind: "chat", id: "123" },
          meta: { telegramDeliveredText: deliveredText, telegramHasInlineKeyboard: true },
        },
      ],
    });

    await hoisted.registration?.finalize(statusLine);
    expect(hoisted.editMarkup).toHaveBeenCalledWith("123", "55", [], {
      cfg: {},
      accountId: "default",
      verbose: false,
    });
    const annotatedText = hoisted.edit.mock.calls[0]?.[2] as string;
    expect(annotatedText.length).toBeLessThanOrEqual(4000);
    expect(annotatedText).toContain("\n\nAnswered: ");
    expect(hoisted.editMarkup.mock.invocationCallOrder[0]).toBeLessThan(
      hoisted.edit.mock.invocationCallOrder[0] ?? Infinity,
    );
  });
});
