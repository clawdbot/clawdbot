import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetInboundDedupe } from "../auto-reply/reply/inbound-dedupe.js";

const useSpy = vi.fn();
const middlewareUseSpy = vi.fn();
const onSpy = vi.fn();
const stopSpy = vi.fn();
const sendChatActionSpy = vi.fn();

type ApiStub = {
  config: { use: (arg: unknown) => void };
  sendChatAction: typeof sendChatActionSpy;
  setMyCommands: (commands: Array<{ command: string; description: string }>) => Promise<void>;
};

const apiStub: ApiStub = {
  config: { use: useSpy },
  sendChatAction: sendChatActionSpy,
  setMyCommands: vi.fn(async () => undefined),
};

beforeEach(() => {
  resetInboundDedupe();
});

vi.mock("grammy", () => ({
  Bot: class {
    api = apiStub;
    use = middlewareUseSpy;
    on = onSpy;
    command = vi.fn();
    stop = stopSpy;
    catch = vi.fn();
    constructor(public token: string) {}
  },
  InputFile: class {},
  webhookCallback: vi.fn(),
}));

vi.mock("@grammyjs/runner", () => ({
  sequentialize: () => vi.fn(),
}));

const throttlerSpy = vi.fn(() => "throttler");
vi.mock("@grammyjs/transformer-throttler", () => ({
  apiThrottler: () => throttlerSpy(),
}));

vi.mock("../media/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media/store.js")>();
  return {
    ...actual,
    saveMediaBuffer: vi.fn(async (buffer: Buffer, contentType?: string) => ({
      id: "media",
      path: "/tmp/telegram-media",
      size: buffer.byteLength,
      contentType: contentType ?? "application/octet-stream",
    })),
  };
});

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    }),
  };
});

vi.mock("../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions.js")>();
  return {
    ...actual,
    updateLastRoute: vi.fn(async () => undefined),
  };
});

vi.mock("./pairing-store.js", () => ({
  readTelegramAllowFromStore: vi.fn(async () => [] as string[]),
  upsertTelegramPairingRequest: vi.fn(async () => ({
    code: "PAIRCODE",
    created: true,
  })),
}));

vi.mock("../auto-reply/reply.js", () => {
  const replySpy = vi.fn(async (_ctx, opts) => {
    await opts?.onReplyStart?.();
    return undefined;
  });
  return { getReplyFromConfig: replySpy, __replySpy: replySpy };
});

describe("telegram inbound media", () => {
  const _INBOUND_MEDIA_TEST_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 20_000;
  it(
    "includes location text and ctx fields for pins",
    async () => {
      const { createTelegramBot } = await import("./bot.js");
      const replyModule = await import("../auto-reply/reply.js");
      const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;

      onSpy.mockReset();
      replySpy.mockReset();

      createTelegramBot({ token: "tok" });
      const handler = onSpy.mock.calls.find((call) => call[0] === "message")?.[1] as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      expect(handler).toBeDefined();

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 5,
          caption: "Meet here",
          date: 1736380800,
          location: {
            latitude: 48.858844,
            longitude: 2.294351,
            horizontal_accuracy: 12,
          },
        },
        me: { username: "moltbot_bot" },
        getFile: async () => ({ file_path: "unused" }),
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0][0];
      expect(payload.Body).toContain("Meet here");
      expect(payload.Body).toContain("48.858844");
      expect(payload.LocationLat).toBe(48.858844);
      expect(payload.LocationLon).toBe(2.294351);
      expect(payload.LocationSource).toBe("pin");
      expect(payload.LocationIsLive).toBe(false);
    },
    _INBOUND_MEDIA_TEST_TIMEOUT_MS,
  );

  it(
    "captures venue fields for named places",
    async () => {
      const { createTelegramBot } = await import("./bot.js");
      const replyModule = await import("../auto-reply/reply.js");
      const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;

      onSpy.mockReset();
      replySpy.mockReset();

      createTelegramBot({ token: "tok" });
      const handler = onSpy.mock.calls.find((call) => call[0] === "message")?.[1] as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      expect(handler).toBeDefined();

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 6,
          date: 1736380800,
          venue: {
            title: "Eiffel Tower",
            address: "Champ de Mars, Paris",
            location: { latitude: 48.858844, longitude: 2.294351 },
          },
        },
        me: { username: "moltbot_bot" },
        getFile: async () => ({ file_path: "unused" }),
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0][0];
      expect(payload.Body).toContain("Eiffel Tower");
      expect(payload.LocationName).toBe("Eiffel Tower");
      expect(payload.LocationAddress).toBe("Champ de Mars, Paris");
      expect(payload.LocationSource).toBe("place");
    },
    _INBOUND_MEDIA_TEST_TIMEOUT_MS,
  );
});
