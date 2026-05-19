import { describe, expect, it, vi } from "vitest";
import { createNativeTelegramToolProgressDraft } from "./native-tool-progress-draft.js";

describe("createNativeTelegramToolProgressDraft", () => {
  const createSendMessageDraftMock = (implementation?: () => Promise<unknown>) =>
    vi.fn(
      async (
        _chatId: number | string,
        _draftId: number,
        _text?: string,
        _params?: Record<string, unknown>,
      ) => implementation?.(),
    );

  it("returns undefined when the Bot API client has no sendMessageDraft method", () => {
    const draft = createNativeTelegramToolProgressDraft({
      api: {},
      chatId: 123,
    } as never);

    expect(draft).toBeUndefined();
  });

  it("updates the same non-zero draft id for animated native progress", async () => {
    const sendMessageDraft = createSendMessageDraftMock();
    const draft = createNativeTelegramToolProgressDraft({
      api: { sendMessageDraft },
      chatId: 123,
      thread: { id: 456, scope: "dm" },
    } as never);

    expect(draft).toBeDefined();
    await draft?.update("Running command");

    expect(sendMessageDraft).toHaveBeenCalledTimes(1);
    const firstDraftId = sendMessageDraft.mock.calls[0]?.[1];
    expect(firstDraftId).toEqual(expect.any(Number));
    expect(firstDraftId).not.toBe(0);
    expect(sendMessageDraft).toHaveBeenLastCalledWith(123, firstDraftId, "Running command", {
      message_thread_id: 456,
    });
  });

  it("stops after a Telegram rejection so callers can fall back silently", async () => {
    const sendMessageDraft = createSendMessageDraftMock(async () => {
      throw new Error("Bad Request: method is unavailable");
    });
    const log = vi.fn();
    const draft = createNativeTelegramToolProgressDraft({
      api: { sendMessageDraft },
      chatId: 123,
      log,
    } as never);

    expect(draft).toBeDefined();
    await expect(draft?.update("Running command")).resolves.toBe(false);
    await expect(draft?.update("Still running")).resolves.toBe(false);

    expect(sendMessageDraft).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("disabled"));
  });
});
