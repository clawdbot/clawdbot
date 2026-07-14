// Telegram tests cover bot message context.sticker media plugin behavior.
import { describe, expect, it, vi } from "vitest";

type ResolveTelegramInboundBody =
  typeof import("./bot-message-context.body.js").resolveTelegramInboundBody;
type TelegramInboundBodyResult = NonNullable<Awaited<ReturnType<ResolveTelegramInboundBody>>>;

type InboundBodyMock = (arg: unknown) => Promise<TelegramInboundBodyResult>;

const inboundBodyMock = vi.hoisted(() =>
  vi.fn<InboundBodyMock>(async () => ({
    bodyText: "[Sticker] Cached description",
    rawBody: "[Sticker] Cached description",
    historyKey: undefined,
    commandAuthorized: false,
    effectiveWasMentioned: false,
    inboundEventKind: "user_request",
    mentionFacts: {
      canDetectMention: true,
      wasMentioned: false,
      effectiveWasMentioned: false,
      requireMention: false,
      shouldSkip: false,
    },
    canDetectMention: true,
    shouldBypassMention: false,
    hasControlCommand: false,
    stickerCacheHit: true,
    locationData: undefined,
  })),
);

vi.mock("./bot-message-context.body.js", () => ({
  resolveTelegramInboundBody: (arg: unknown) => inboundBodyMock(arg),
}));

const { buildTelegramMessageContextForTest } =
  await import("./bot-message-context.test-harness.js");

describe("buildTelegramMessageContext sticker media", () => {
  it("keeps cached static sticker media attached to the inbound context", async () => {
    const stickerPath = "/tmp/openclaw/media/inbound/sticker.webp";
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 104,
        chat: { id: 1234, type: "private" },
        from: { id: 777, is_bot: false, first_name: "Ada" },
        sticker: {
          file_id: "new_file_id",
          file_unique_id: "sticker_unique_789",
          type: "regular",
          width: 512,
          height: 512,
          is_animated: false,
          is_video: false,
          emoji: "🔥",
          set_name: "NewSet",
        },
        date: 1736380800,
      },
      allMedia: [
        {
          path: stickerPath,
          contentType: "image/webp",
          stickerMetadata: {
            emoji: "🔥",
            setName: "NewSet",
            fileId: "new_file_id",
            fileUniqueId: "sticker_unique_789",
            cachedDescription: "Cached description",
          },
        },
      ],
    });

    expect(ctx?.ctxPayload.MediaPath).toBe(stickerPath);
    expect(ctx?.ctxPayload.MediaUrl).toBe(stickerPath);
    expect(ctx?.ctxPayload.MediaType).toBe("image/webp");
    expect(ctx?.ctxPayload.MediaPaths).toEqual([stickerPath]);
    expect(ctx?.ctxPayload.MediaUrls).toEqual([stickerPath]);
    expect(ctx?.ctxPayload.MediaTypes).toEqual(["image/webp"]);
    expect(ctx?.ctxPayload.StickerMediaIncluded).toBe(true);
    expect(ctx?.ctxPayload.SkipStickerMediaUnderstanding).toBe(true);
    expect(ctx?.ctxPayload.Sticker).toMatchObject({
      fileId: "new_file_id",
      fileUniqueId: "sticker_unique_789",
      cachedDescription: "Cached description",
    });
  });
});
