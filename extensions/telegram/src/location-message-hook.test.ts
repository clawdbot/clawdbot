import type { Message } from "grammy/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hookRunner = vi.hoisted(() => ({
  hasHooks: vi.fn(() => true),
  runInboundClaim: vi.fn(async () => undefined),
  runMessageReceived: vi.fn(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>();
  return { ...actual, getGlobalHookRunner: () => hookRunner };
});

const { emitTelegramLiveLocationMessageHook } = await import("./location-message-hook.js");

describe("Telegram location message hooks", () => {
  beforeEach(() => {
    hookRunner.hasHooks.mockClear();
    hookRunner.runInboundClaim.mockClear();
    hookRunner.runMessageReceived.mockReset();
    hookRunner.runMessageReceived.mockResolvedValue(undefined);
  });

  it("ignores non-location edits", () => {
    const msg = {
      chat: { id: 1234, type: "private" },
      message_id: 456,
      date: 1_786_094_460,
      edit_date: 1_786_094_520,
      from: { id: 789, is_bot: false, first_name: "Mariano" },
      text: "edited text",
    } as Message;

    emitTelegramLiveLocationMessageHook({
      accountId: "main",
      msg,
      updateId: 9002,
      updateKind: "edited_message",
      isForum: false,
    });

    expect(hookRunner.runMessageReceived).not.toHaveBeenCalled();
  });

  it("emits edited live locations through the global message-received contract", () => {
    const msg = {
      chat: { id: 1234, type: "private" },
      message_id: 456,
      date: 1_786_094_460,
      edit_date: 1_786_094_520,
      from: { id: 789, is_bot: false, first_name: "Pat" },
      location: {
        latitude: 43.8376,
        longitude: 18.4534,
        horizontal_accuracy: 12,
        live_period: 900,
      },
    } as Message;

    emitTelegramLiveLocationMessageHook({
      accountId: "main",
      msg,
      updateId: 9002,
      updateKind: "edited_message",
      isForum: false,
    });

    expect(hookRunner.hasHooks).toHaveBeenCalledWith("message_received", expect.any(Object));
    expect(hookRunner.runMessageReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "456",
        senderId: "789",
        timestamp: 1_786_094_520_000,
        location: expect.objectContaining({
          latitude: 43.8376,
          longitude: 18.4534,
          accuracy: 12,
          source: "live",
          isLive: true,
          livePeriodSeconds: 900,
        }),
        providerUpdate: {
          id: "9002",
          kind: "edited_message",
          messageId: "456",
          messageTimestamp: 1_786_094_460_000,
          editedTimestamp: 1_786_094_520_000,
        },
      }),
      expect.objectContaining({
        channelId: "telegram",
        accountId: "main",
        conversationId: "telegram:1234",
        messageId: "456",
        senderId: "789",
      }),
    );
    expect(hookRunner.runInboundClaim).not.toHaveBeenCalled();
  });

  it("emits the terminal edit when live-location sharing stops", () => {
    const msg = {
      chat: { id: 1234, type: "private" },
      message_id: 456,
      date: 1_786_094_460,
      edit_date: 1_786_094_580,
      from: { id: 789, is_bot: false, first_name: "Pat" },
      location: { latitude: 43.8376, longitude: 18.4534 },
    } as Message;

    emitTelegramLiveLocationMessageHook({
      accountId: "main",
      msg,
      updateId: 9003,
      updateKind: "edited_message",
      isForum: false,
    });

    expect(hookRunner.runMessageReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        location: expect.objectContaining({ isLive: false }),
        providerUpdate: expect.objectContaining({ id: "9003", kind: "edited_message" }),
      }),
      expect.any(Object),
    );
    expect(hookRunner.runInboundClaim).not.toHaveBeenCalled();
  });

  it("emits edited channel-post live locations with their provider update kind", () => {
    const msg = {
      chat: { id: -1001234, type: "supergroup", title: "Travel updates" },
      message_id: 456,
      date: 1_786_094_460,
      edit_date: 1_786_094_580,
      from: { id: 789, is_bot: true, first_name: "Travel updates" },
      location: { latitude: 43.8376, longitude: 18.4534, live_period: 900 },
    } as Message;

    emitTelegramLiveLocationMessageHook({
      accountId: "main",
      msg,
      updateId: 9004,
      updateKind: "edited_channel_post",
      isForum: false,
    });

    expect(hookRunner.runMessageReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        providerUpdate: expect.objectContaining({
          id: "9004",
          kind: "edited_channel_post",
        }),
      }),
      expect.any(Object),
    );
  });

  it("does not wait for plugin observers on the Telegram inbound path", () => {
    hookRunner.runMessageReceived.mockReturnValueOnce(new Promise(() => {}));
    const msg = {
      chat: { id: 1234, type: "private" },
      message_id: 456,
      date: 1_786_094_460,
      edit_date: 1_786_094_520,
      from: { id: 789, is_bot: false, first_name: "Pat" },
      location: { latitude: 43.8376, longitude: 18.4534, live_period: 900 },
    } as Message;

    expect(
      emitTelegramLiveLocationMessageHook({
        accountId: "main",
        msg,
        updateId: 9005,
        updateKind: "edited_message",
        isForum: false,
      }),
    ).toBeUndefined();
    expect(hookRunner.runMessageReceived).toHaveBeenCalledTimes(1);
  });
});
