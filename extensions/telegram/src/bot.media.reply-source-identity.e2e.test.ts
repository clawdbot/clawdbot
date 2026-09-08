// Telegram tests cover reply media source identity across ingress and provider delivery.
import { describe, expect, it, vi } from "vitest";
import { setNextSavedMediaPath } from "./bot.media.e2e.test-harness.js";
import { createBotHandlerWithOptions, mockTelegramPngDownload } from "./bot.media.test-utils.js";

describe("telegram reply media source identity", () => {
  // Parallel vitest shards can make this suite slower than the standalone run.
  const TEST_TIMEOUT_MS = process.platform === "win32" ? 120_000 : 90_000;

  it(
    "attaches one image when current and replied messages stage one source at different paths",
    async () => {
      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      const fetchSpy = mockTelegramPngDownload();
      const originalPath = "/tmp/media/inbound/original-source.png";
      const currentPath = "/tmp/media/inbound/current-source.png";
      const originalMessage = {
        message_id: 1101,
        chat: { id: 1234, type: "private" as const },
        from: { id: 777, is_bot: false, first_name: "Ada" },
        photo: [{ file_id: "original-file", file_unique_id: "shared-telegram-source" }],
        date: 1736380800,
      };

      try {
        setNextSavedMediaPath({ path: originalPath, contentType: "image/png" });
        await handler({
          message: originalMessage,
          me: { id: 999, username: "openclaw_bot" },
          getFile: async () => ({ file_path: "photos/original.png" }),
        });

        replySpy.mockClear();
        setNextSavedMediaPath({ path: currentPath, contentType: "image/png" });
        await handler({
          message: {
            message_id: 1102,
            chat: originalMessage.chat,
            from: originalMessage.from,
            photo: [{ file_id: "current-file", file_unique_id: "shared-telegram-source" }],
            reply_to_message: originalMessage,
            date: 1736380801,
          },
          me: { id: 999, username: "openclaw_bot" },
          getFile: async () => ({ file_path: "photos/current.png" }),
        });

        expect(runtimeError).not.toHaveBeenCalled();
        expect(replySpy).toHaveBeenCalledTimes(1);
        const replyCall = replySpy.mock.calls[0];
        if (!replyCall) {
          throw new Error("expected one reply call");
        }
        expect(replyCall[0]).toMatchObject({ MediaPaths: [currentPath] });
      } finally {
        fetchSpy.mockRestore();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
