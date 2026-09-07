// Whatsapp tests cover channel plugin pairing behavior.
import { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-status";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  sendMessageWhatsApp: vi.fn(async () => ({ messageId: "wa-1", toJid: "jid" })),
  sendPollWhatsApp: vi.fn(async () => ({ messageId: "poll-1", toJid: "jid" })),
  sendTypingWhatsApp: vi.fn(async () => undefined),
}));

vi.mock("./send.js", () => ({
  sendMessageWhatsApp: hoisted.sendMessageWhatsApp,
  sendPollWhatsApp: hoisted.sendPollWhatsApp,
  sendTypingWhatsApp: hoisted.sendTypingWhatsApp,
}));

vi.mock("./runtime.js", () => ({
  getWhatsAppRuntime: () => ({
    logging: {
      shouldLogVerbose: () => false,
    },
  }),
  getOptionalWhatsAppRuntime: () => undefined,
}));

let whatsappPlugin: typeof import("./channel.js").whatsappPlugin;
let normalizeWhatsAppMessagingTarget: typeof import("./normalize.js").normalizeWhatsAppMessagingTarget;

describe("whatsappPlugin.pairing", () => {
  beforeAll(async () => {
    ({ whatsappPlugin } = await import("./channel.js"));
    ({ normalizeWhatsAppMessagingTarget } = await import("./normalize.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("declares a notifyApproval callback", () => {
    expect(whatsappPlugin.pairing?.notifyApproval).toBeTypeOf("function");
  });

  it("sends the pairing approved message to the paired sender", async () => {
    const notify = whatsappPlugin.pairing?.notifyApproval;
    if (!notify) {
      throw new Error("whatsapp pairing notifyApproval unavailable");
    }
    const senderId = "15551230000@s.whatsapp.net";
    const cfg = {} as OpenClawConfig;

    await notify({ cfg, id: senderId });

    const target = normalizeWhatsAppMessagingTarget(senderId) ?? senderId;
    expect(hoisted.sendMessageWhatsApp).toHaveBeenCalledTimes(1);
    expect(hoisted.sendMessageWhatsApp).toHaveBeenCalledWith(target, PAIRING_APPROVED_MESSAGE, {
      verbose: false,
      cfg,
      accountId: "default",
    });
  });
});
