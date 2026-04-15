import { afterEach, describe, expect, it, vi } from "vitest";
import { telegramBotDepsForTest } from "./bot.media.e2e-harness.js";
import { setNextSavedMediaPath } from "./bot.media.e2e-harness.js";
import {
  TELEGRAM_TEST_TIMINGS,
  createBotHandler,
  createBotHandlerWithOptions,
  mockTelegramFileDownload,
  mockTelegramPngDownload,
  watchTelegramFetch,
} from "./bot.media.test-utils.js";

describe("telegram inbound media", () => {
  // Parallel vitest shards can make this suite slower than the standalone run.
  const INBOUND_MEDIA_TEST_TIMEOUT_MS = process.platform === "win32" ? 120_000 : 90_000;

  it(
    "handles file_path media downloads and missing file_path safely",
    async () => {
      const runtimeLog = vi.fn();
      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({
        runtimeLog,
        runtimeError,
      });

      for (const scenario of [
        {
          name: "downloads via file_path",
          messageId: 1,
          getFile: async () => ({ file_path: "photos/1.jpg" }),
          setupFetch: () =>
            mockTelegramFileDownload({
              contentType: "image/jpeg",
              bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
            }),
          assert: (params: {
            fetchSpy: ReturnType<typeof vi.spyOn>;
            replySpy: ReturnType<typeof vi.fn>;
            runtimeError: ReturnType<typeof vi.fn>;
          }) => {
            expect(params.runtimeError).not.toHaveBeenCalled();
            expect(params.fetchSpy).toHaveBeenCalledWith(
              expect.objectContaining({
                url: "https://api.telegram.org/file/bottok/photos/1.jpg",
                filePathHint: "photos/1.jpg",
              }),
            );
            expect(params.replySpy).toHaveBeenCalledTimes(1);
            const payload = params.replySpy.mock.calls[0][0];
            expect(payload.Body).toContain("<media:image>");
          },
        },
        {
          name: "skips when file_path is missing",
          messageId: 2,
          getFile: async () => ({}),
          setupFetch: () => watchTelegramFetch(),
          assert: (params: {
            fetchSpy: ReturnType<typeof vi.spyOn>;
            replySpy: ReturnType<typeof vi.fn>;
            runtimeError: ReturnType<typeof vi.fn>;
          }) => {
            expect(params.fetchSpy).not.toHaveBeenCalled();
            expect(params.replySpy).not.toHaveBeenCalled();
            expect(params.runtimeError).not.toHaveBeenCalled();
          },
        },
      ]) {
        replySpy.mockClear();
        runtimeError.mockClear();
        const fetchSpy = scenario.setupFetch();

        await handler({
          message: {
            message_id: scenario.messageId,
            chat: { id: 1234, type: "private" },
            from: { id: 777, is_bot: false, first_name: "Ada" },
            photo: [{ file_id: "fid" }],
            date: 1736380800, // 2025-01-09T00:00:00Z
          },
          me: { username: "openclaw_bot" },
          getFile: scenario.getFile,
        });

        scenario.assert({ fetchSpy, replySpy, runtimeError });
        fetchSpy.mockRestore();
      }
    },
    INBOUND_MEDIA_TEST_TIMEOUT_MS,
  );

  it(
    "keeps Telegram inbound media paths with triple-dash ids",
    async () => {
      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      const fetchSpy = mockTelegramFileDownload({
        contentType: "image/jpeg",
        bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
      });
      const inboundPath = "/tmp/media/inbound/file_1095---f00a04a2-99a0-4d98-99b0-dfe61c5a4198.jpg";
      setNextSavedMediaPath({
        path: inboundPath,
        size: 4,
        contentType: "image/jpeg",
      });

      try {
        await handler({
          message: {
            message_id: 1001,
            chat: { id: 1234, type: "private" },
            from: { id: 777, is_bot: false, first_name: "Ada" },
            photo: [{ file_id: "fid" }],
            date: 1736380800,
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({ file_path: "photos/1.jpg" }),
        });

        expect(runtimeError).not.toHaveBeenCalled();
        expect(replySpy).toHaveBeenCalledTimes(1);
        const payload = replySpy.mock.calls[0]?.[0] as { Body?: string; MediaPaths?: string[] };
        expect(payload.Body).toContain("<media:image>");
        expect(payload.MediaPaths).toContain(inboundPath);
      } finally {
        fetchSpy.mockRestore();
      }
    },
    INBOUND_MEDIA_TEST_TIMEOUT_MS,
  );

  it("prefers proxyFetch over global fetch", async () => {
    const runtimeLog = vi.fn();
    const runtimeError = vi.fn();
    const globalFetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("global fetch should not be called");
    });
    const proxyFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "image/jpeg" },
      arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer,
    } as unknown as Response);

    const { handler } = await createBotHandlerWithOptions({
      proxyFetch: proxyFetch as unknown as typeof fetch,
      runtimeLog,
      runtimeError,
    });

    await handler({
      message: {
        message_id: 2,
        chat: { id: 1234, type: "private" },
        photo: [{ file_id: "fid" }],
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ file_path: "photos/2.jpg" }),
    });

    expect(runtimeError).not.toHaveBeenCalled();
    expect(proxyFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/file/bottok/photos/2.jpg",
      expect.objectContaining({ redirect: "manual" }),
    );

    globalFetchSpy.mockRestore();
  });

  it("captures pin and venue location payload fields", async () => {
    const { handler, replySpy } = await createBotHandler();

    const cases = [
      {
        message: {
          chat: { id: 42, type: "private" as const },
          message_id: 5,
          caption: "Meet here",
          date: 1736380800,
          location: {
            latitude: 48.858844,
            longitude: 2.294351,
            horizontal_accuracy: 12,
          },
        },
        assert: (payload: Record<string, unknown>) => {
          expect(payload.Body).toContain("Meet here");
          expect(payload.Body).toContain("48.858844");
          expect(payload.LocationLat).toBe(48.858844);
          expect(payload.LocationLon).toBe(2.294351);
          expect(payload.LocationSource).toBe("pin");
          expect(payload.LocationIsLive).toBe(false);
        },
      },
      {
        message: {
          chat: { id: 42, type: "private" as const },
          message_id: 6,
          date: 1736380800,
          venue: {
            title: "Eiffel Tower",
            address: "Champ de Mars, Paris",
            location: { latitude: 48.858844, longitude: 2.294351 },
          },
        },
        assert: (payload: Record<string, unknown>) => {
          expect(payload.Body).toContain("Eiffel Tower");
          expect(payload.LocationName).toBe("Eiffel Tower");
          expect(payload.LocationAddress).toBe("Champ de Mars, Paris");
          expect(payload.LocationSource).toBe("place");
        },
      },
    ] as const;

    for (const testCase of cases) {
      replySpy.mockClear();
      await handler({
        message: testCase.message,
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "unused" }),
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0][0] as Record<string, unknown>;
      testCase.assert(payload);
    }
  });
});

describe("telegram media groups", () => {
  afterEach(() => {
    vi.clearAllTimers();
  });

  const MEDIA_GROUP_TEST_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 20_000;
  const MEDIA_GROUP_FLUSH_MS = TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs + 40;

  it(
    "uses custom apiRoot for buffered media-group downloads",
    async () => {
      const originalLoadConfig = telegramBotDepsForTest.loadConfig;
      telegramBotDepsForTest.loadConfig = (() => ({
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
            apiRoot: "http://127.0.0.1:8081/custom-bot-api",
          },
        },
      })) as typeof telegramBotDepsForTest.loadConfig;

      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      const fetchSpy = mockTelegramPngDownload();

      try {
        await Promise.all([
          handler({
            message: {
              chat: { id: 42, type: "private" as const },
              from: { id: 777, is_bot: false, first_name: "Ada" },
              message_id: 1,
              caption: "Album",
              date: 1736380800,
              media_group_id: "album-custom-api-root",
              photo: [{ file_id: "photo1" }],
            },
            me: { username: "openclaw_bot" },
            getFile: async () => ({ file_path: "photos/photo1.jpg" }),
          }),
          handler({
            message: {
              chat: { id: 42, type: "private" as const },
              from: { id: 777, is_bot: false, first_name: "Ada" },
              message_id: 2,
              date: 1736380801,
              media_group_id: "album-custom-api-root",
              photo: [{ file_id: "photo2" }],
            },
            me: { username: "openclaw_bot" },
            getFile: async () => ({ file_path: "photos/photo2.jpg" }),
          }),
        ]);

        await vi.waitFor(
          () => {
            expect(replySpy).toHaveBeenCalledTimes(1);
          },
          { timeout: MEDIA_GROUP_FLUSH_MS * 4, interval: 2 },
        );

        expect(runtimeError).not.toHaveBeenCalled();
        expect(fetchSpy).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            url: "http://127.0.0.1:8081/custom-bot-api/file/bottok/photos/photo1.jpg",
          }),
        );
        expect(fetchSpy).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            url: "http://127.0.0.1:8081/custom-bot-api/file/bottok/photos/photo2.jpg",
          }),
        );
      } finally {
        telegramBotDepsForTest.loadConfig = originalLoadConfig;
        fetchSpy.mockRestore();
      }
    },
    MEDIA_GROUP_TEST_TIMEOUT_MS,
  );

  it(
    "handles same-group buffering and separate-group independence",
    async () => {
      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      const fetchSpy = mockTelegramPngDownload();

      try {
        for (const scenario of [
          {
            messages: [
              {
                chat: { id: 42, type: "private" as const },
                from: { id: 777, is_bot: false, first_name: "Ada" },
                message_id: 1,
                caption: "Here are my photos",
                date: 1736380800,
                media_group_id: "album123",
                photo: [{ file_id: "photo1" }],
                filePath: "photos/photo1.jpg",
              },
              {
                chat: { id: 42, type: "private" as const },
                from: { id: 777, is_bot: false, first_name: "Ada" },
                message_id: 2,
                date: 1736380801,
                media_group_id: "album123",
                photo: [{ file_id: "photo2" }],
                filePath: "photos/photo2.jpg",
              },
            ],
            expectedReplyCount: 1,
            assert: (replySpy: ReturnType<typeof vi.fn>) => {
              const payload = replySpy.mock.calls[0]?.[0];
              expect(payload?.Body).toContain("Here are my photos");
              expect(payload?.MediaPaths).toHaveLength(2);
            },
          },
          {
            messages: [
              {
                chat: { id: 42, type: "private" as const },
                from: { id: 777, is_bot: false, first_name: "Ada" },
                message_id: 11,
                caption: "Album A",
                date: 1736380800,
                media_group_id: "albumA",
                photo: [{ file_id: "photoA1" }],
                filePath: "photos/photoA1.jpg",
              },
              {
                chat: { id: 42, type: "private" as const },
                from: { id: 777, is_bot: false, first_name: "Ada" },
                message_id: 12,
                caption: "Album B",
                date: 1736380801,
                media_group_id: "albumB",
                photo: [{ file_id: "photoB1" }],
                filePath: "photos/photoB1.jpg",
              },
            ],
            expectedReplyCount: 2,
            assert: () => {},
          },
        ]) {
          replySpy.mockClear();
          runtimeError.mockClear();

          await Promise.all(
            scenario.messages.map((message) =>
              handler({
                message,
                me: { username: "openclaw_bot" },
                getFile: async () => ({ file_path: message.filePath }),
              }),
            ),
          );

          expect(replySpy).not.toHaveBeenCalled();
          await vi.waitFor(
            () => {
              expect(replySpy).toHaveBeenCalledTimes(scenario.expectedReplyCount);
            },
            { timeout: MEDIA_GROUP_FLUSH_MS * 4, interval: 2 },
          );

          expect(runtimeError).not.toHaveBeenCalled();
          scenario.assert(replySpy);
        }
      } finally {
        fetchSpy.mockRestore();
      }
    },
    MEDIA_GROUP_TEST_TIMEOUT_MS,
  );
});

describe("telegram forwarded bursts", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const FORWARD_BURST_TEST_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 20_000;

  it(
    "coalesces forwarded text + forwarded attachment into a single processing turn with default debounce config",
    async () => {
      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      const fetchSpy = mockTelegramPngDownload();

      try {
        await handler({
          message: {
            chat: { id: 42, type: "private" },
            from: { id: 777, is_bot: false, first_name: "N" },
            message_id: 21,
            text: "Look at this",
            date: 1736380800,
            forward_origin: { type: "hidden_user", date: 1736380700, sender_user_name: "A" },
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({}),
        });

        await handler({
          message: {
            chat: { id: 42, type: "private" },
            from: { id: 777, is_bot: false, first_name: "N" },
            message_id: 22,
            date: 1736380801,
            photo: [{ file_id: "fwd_photo_1" }],
            forward_origin: { type: "hidden_user", date: 1736380701, sender_user_name: "A" },
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({ file_path: "photos/fwd1.jpg" }),
        });

        await vi.waitFor(() => {
          expect(replySpy).toHaveBeenCalledTimes(1);
        });

        expect(runtimeError).not.toHaveBeenCalled();
        const payload = replySpy.mock.calls[0][0];
        expect(payload.Body).toContain("Look at this");
        expect(payload.MediaPaths).toHaveLength(1);
      } finally {
        fetchSpy.mockRestore();
      }
    },
    FORWARD_BURST_TEST_TIMEOUT_MS,
  );
});
