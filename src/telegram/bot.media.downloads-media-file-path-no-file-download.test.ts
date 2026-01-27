import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetInboundDedupe } from "../auto-reply/reply/inbound-dedupe.js";
import { MEDIA_GROUP_TIMEOUT_MS } from "./bot-updates.js";

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
  vi.useRealTimers();
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
  const INBOUND_MEDIA_TEST_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 20_000;

  it(
    "downloads media via file_path (no file.download)",
    async () => {
      const { createTelegramBot } = await import("./bot.js");
      const replyModule = await import("../auto-reply/reply.js");
      const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;

      onSpy.mockReset();
      replySpy.mockReset();
      sendChatActionSpy.mockReset();

      const runtimeLog = vi.fn();
      const runtimeError = vi.fn();
      createTelegramBot({
        token: "tok",
        runtime: {
          log: runtimeLog,
          error: runtimeError,
          exit: () => {
            throw new Error("exit");
          },
        },
      });
      const handler = onSpy.mock.calls.find((call) => call[0] === "message")?.[1] as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      expect(handler).toBeDefined();

      const fetchSpy = vi.spyOn(globalThis, "fetch" as never).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "image/jpeg" },
        arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0x00]).buffer,
      } as Response);

      await handler({
        message: {
          message_id: 1,
          chat: { id: 1234, type: "private" },
          photo: [{ file_id: "fid" }],
          date: 1736380800, // 2025-01-09T00:00:00Z
        },
        me: { username: "clawdbot_bot" },
        getFile: async () => ({ file_path: "photos/1.jpg" }),
      });

      expect(runtimeError).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledWith("https://api.telegram.org/file/bottok/photos/1.jpg");
      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0][0];
      expect(payload.Body).toContain("<media:image>");

      fetchSpy.mockRestore();
    },
    INBOUND_MEDIA_TEST_TIMEOUT_MS,
  );

  it("prefers proxyFetch over global fetch", async () => {
    const { createTelegramBot } = await import("./bot.js");

    onSpy.mockReset();

    const runtimeLog = vi.fn();
    const runtimeError = vi.fn();
    const globalFetchSpy = vi.spyOn(globalThis, "fetch" as never).mockImplementation(() => {
      throw new Error("global fetch should not be called");
    });
    const proxyFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "image/jpeg" },
      arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer,
    } as Response);

    createTelegramBot({
      token: "tok",
      proxyFetch: proxyFetch as unknown as typeof fetch,
      runtime: {
        log: runtimeLog,
        error: runtimeError,
        exit: () => {
          throw new Error("exit");
        },
      },
    });
    const handler = onSpy.mock.calls.find((call) => call[0] === "message")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(handler).toBeDefined();

    await handler({
      message: {
        message_id: 2,
        chat: { id: 1234, type: "private" },
        photo: [{ file_id: "fid" }],
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ file_path: "photos/2.jpg" }),
    });

    expect(runtimeError).not.toHaveBeenCalled();
    expect(proxyFetch).toHaveBeenCalledWith("https://api.telegram.org/file/bottok/photos/2.jpg");

    globalFetchSpy.mockRestore();
  });

  it("logs a handler error when getFile returns no file_path", async () => {
    const { createTelegramBot } = await import("./bot.js");
    const replyModule = await import("../auto-reply/reply.js");
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;

    onSpy.mockReset();
    replySpy.mockReset();

    const runtimeLog = vi.fn();
    const runtimeError = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch" as never);

    createTelegramBot({
      token: "tok",
      runtime: {
        log: runtimeLog,
        error: runtimeError,
        exit: () => {
          throw new Error("exit");
        },
      },
    });
    const handler = onSpy.mock.calls.find((call) => call[0] === "message")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(handler).toBeDefined();

    await handler({
      message: {
        message_id: 3,
        chat: { id: 1234, type: "private" },
        photo: [{ file_id: "fid" }],
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({}),
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
    expect(runtimeError).toHaveBeenCalledTimes(1);
    const msg = String(runtimeError.mock.calls[0]?.[0] ?? "");
    expect(msg).toContain("handler failed:");
    expect(msg).toContain("file_path");

    fetchSpy.mockRestore();
  });
});

describe("telegram media groups", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const MEDIA_GROUP_TEST_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 20_000;
  const MEDIA_GROUP_FLUSH_MS = MEDIA_GROUP_TIMEOUT_MS + 25;

  it(
    "buffers messages with same media_group_id and processes them together",
    async () => {
      const { createTelegramBot } = await import("./bot.js");
      const replyModule = await import("../auto-reply/reply.js");
      const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;

      onSpy.mockReset();
      replySpy.mockReset();

      const runtimeError = vi.fn();
      const fetchSpy = vi.spyOn(globalThis, "fetch" as never).mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "image/png" },
        arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
      } as Response);

      createTelegramBot({
        token: "tok",
        runtime: {
          log: vi.fn(),
          error: runtimeError,
          exit: () => {
            throw new Error("exit");
          },
        },
      });
      const handler = onSpy.mock.calls.find((call) => call[0] === "message")?.[1] as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      expect(handler).toBeDefined();

      const first = handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 1,
          caption: "Here are my photos",
          date: 1736380800,
          media_group_id: "album123",
          photo: [{ file_id: "photo1" }],
        },
        me: { username: "clawdbot_bot" },
        getFile: async () => ({ file_path: "photos/photo1.jpg" }),
      });

      const second = handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 2,
          date: 1736380801,
          media_group_id: "album123",
          photo: [{ file_id: "photo2" }],
        },
        me: { username: "clawdbot_bot" },
        getFile: async () => ({ file_path: "photos/photo2.jpg" }),
      });

      await first;
      await second;

      expect(replySpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(MEDIA_GROUP_FLUSH_MS);

      expect(runtimeError).not.toHaveBeenCalled();
      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0][0];
      expect(payload.Body).toContain("Here are my photos");
      expect(payload.MediaPaths).toHaveLength(2);

      fetchSpy.mockRestore();
    },
    MEDIA_GROUP_TEST_TIMEOUT_MS,
  );

  it(
    "processes separate media groups independently",
    async () => {
      const { createTelegramBot } = await import("./bot.js");
      const replyModule = await import("../auto-reply/reply.js");
      const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;

      onSpy.mockReset();
      replySpy.mockReset();

      const fetchSpy = vi.spyOn(globalThis, "fetch" as never).mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "image/png" },
        arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
      } as Response);

      createTelegramBot({ token: "tok" });
      const handler = onSpy.mock.calls.find((call) => call[0] === "message")?.[1] as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      expect(handler).toBeDefined();

      const first = handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 1,
          caption: "Album A",
          date: 1736380800,
          media_group_id: "albumA",
          photo: [{ file_id: "photoA1" }],
        },
        me: { username: "clawdbot_bot" },
        getFile: async () => ({ file_path: "photos/photoA1.jpg" }),
      });

      const second = handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 2,
          caption: "Album B",
          date: 1736380801,
          media_group_id: "albumB",
          photo: [{ file_id: "photoB1" }],
        },
        me: { username: "clawdbot_bot" },
        getFile: async () => ({ file_path: "photos/photoB1.jpg" }),
      });

      await Promise.all([first, second]);

      expect(replySpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(MEDIA_GROUP_FLUSH_MS);

      expect(replySpy).toHaveBeenCalledTimes(2);

      fetchSpy.mockRestore();
    },
    MEDIA_GROUP_TEST_TIMEOUT_MS,
  );
});

describe("telegram text fragments", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const TEXT_FRAGMENT_TEST_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 20_000;
  const TEXT_FRAGMENT_FLUSH_MS = 1600;

  it(
    "buffers near-limit text and processes sequential parts as one message",
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

      const part1 = "A".repeat(4050);
      const part2 = "B".repeat(50);

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 10,
          date: 1736380800,
          text: part1,
        },
        me: { username: "clawdbot_bot" },
        getFile: async () => ({}),
      });

      await handler({
        message: {
          chat: { id: 42, type: "private" },
          message_id: 11,
          date: 1736380801,
          text: part2,
        },
        me: { username: "clawdbot_bot" },
        getFile: async () => ({}),
      });

      expect(replySpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(TEXT_FRAGMENT_FLUSH_MS);

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0][0] as { RawBody?: string; Body?: string };
      expect(payload.RawBody).toContain(part1.slice(0, 32));
      expect(payload.RawBody).toContain(part2.slice(0, 32));
    },
    TEXT_FRAGMENT_TEST_TIMEOUT_MS,
  );
});
