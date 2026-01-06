import "./test-helpers.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) =>
    `session:${key.trim() || "main"}`,
}));

import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { getReplyFromConfig } from "../auto-reply/reply.js";
import type { ClawdbotConfig } from "../config/config.js";
import { resetLogger, setLoggerOverride } from "../logging.js";
import {
  HEARTBEAT_TOKEN,
  monitorWebProvider,
  SILENT_REPLY_TOKEN,
} from "./auto-reply.js";
import {
  resetBaileysMocks,
  resetLoadConfigMock,
  setLoadConfigMock,
} from "./test-helpers.js";

let previousHome: string | undefined;
let tempHome: string | undefined;

const rmDirWithRetries = async (dir: string): Promise<void> => {
  // Some tests can leave async session-store writes in-flight; recursive deletion can race and throw ENOTEMPTY.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code)
          : null;
      if (code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM") {
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      throw err;
    }
  }

  await fs.rm(dir, { recursive: true, force: true });
};

beforeEach(async () => {
  previousHome = process.env.HOME;
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-web-home-"));
  process.env.HOME = tempHome;
});

afterEach(async () => {
  process.env.HOME = previousHome;
  if (tempHome) {
    await rmDirWithRetries(tempHome);
    tempHome = undefined;
  }
});

const makeSessionStore = async (
  entries: Record<string, unknown> = {},
): Promise<{ storePath: string; cleanup: () => Promise<void> }> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-session-"));
  const storePath = path.join(dir, "sessions.json");
  await fs.writeFile(storePath, JSON.stringify(entries));
  const cleanup = async () => {
    // Session store writes can be in-flight when the test finishes (e.g. updateLastRoute
    // after a message flush). `fs.rm({ recursive })` can race and throw ENOTEMPTY.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        return;
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code?: unknown }).code)
            : null;
        if (code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM") {
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        throw err;
      }
    }

    await fs.rm(dir, { recursive: true, force: true });
  };
  return {
    storePath,
    cleanup,
  };
};

describe("partial reply gating", () => {
  it("does not send partial replies for WhatsApp surface", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn().mockResolvedValue(undefined);
    const sendMedia = vi.fn().mockResolvedValue(undefined);

    const replyResolver = vi.fn().mockResolvedValue({ text: "final reply" });

    const mockConfig: ClawdbotConfig = {
      whatsapp: {
        allowFrom: ["*"],
      },
    };

    setLoadConfigMock(mockConfig);

    await monitorWebProvider(
      false,
      async ({ onMessage }) => {
        await onMessage({
          id: "m1",
          from: "+1000",
          conversationId: "+1000",
          to: "+2000",
          body: "hello",
          timestamp: Date.now(),
          chatType: "direct",
          chatId: "direct:+1000",
          sendComposing,
          reply,
          sendMedia,
        });
        return { close: vi.fn().mockResolvedValue(undefined) };
      },
      false,
      replyResolver,
    );

    resetLoadConfigMock();

    expect(replyResolver).toHaveBeenCalledTimes(1);
    const resolverOptions = replyResolver.mock.calls[0]?.[1] ?? {};
    expect("onPartialReply" in resolverOptions).toBe(false);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith("final reply");
  });

  it("updates last-route for direct chats without senderE164", async () => {
    const now = Date.now();
    const store = await makeSessionStore({
      main: { sessionId: "sid", updatedAt: now - 1 },
    });

    const replyResolver = vi.fn().mockResolvedValue(undefined);

    const mockConfig: ClawdbotConfig = {
      whatsapp: {
        allowFrom: ["*"],
      },
      session: { store: store.storePath, mainKey: "main" },
    };

    setLoadConfigMock(mockConfig);

    await monitorWebProvider(
      false,
      async ({ onMessage }) => {
        await onMessage({
          id: "m1",
          from: "+1000",
          conversationId: "+1000",
          to: "+2000",
          body: "hello",
          timestamp: now,
          chatType: "direct",
          chatId: "direct:+1000",
          sendComposing: vi.fn().mockResolvedValue(undefined),
          reply: vi.fn().mockResolvedValue(undefined),
          sendMedia: vi.fn().mockResolvedValue(undefined),
        });
        return { close: vi.fn().mockResolvedValue(undefined) };
      },
      false,
      replyResolver,
    );

    let stored: { main?: { lastChannel?: string; lastTo?: string } } | null =
      null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      stored = JSON.parse(await fs.readFile(store.storePath, "utf8")) as {
        main?: { lastChannel?: string; lastTo?: string };
      };
      if (stored.main?.lastChannel && stored.main?.lastTo) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!stored) throw new Error("store not loaded");
    expect(stored.main?.lastChannel).toBe("whatsapp");
    expect(stored.main?.lastTo).toBe("+1000");

    resetLoadConfigMock();
    await store.cleanup();
  });

  it("defaults to self-only when no config is present", async () => {
    vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: {
        durationMs: 1,
        agentMeta: { sessionId: "s", provider: "p", model: "m" },
      },
    });

    // Not self: should be blocked
    const blocked = await getReplyFromConfig(
      {
        Body: "hi",
        From: "whatsapp:+999",
        To: "whatsapp:+123",
      },
      undefined,
      {},
    );
    expect(blocked).toBeUndefined();
    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();

    // Self: should be allowed
    const allowed = await getReplyFromConfig(
      {
        Body: "hi",
        From: "whatsapp:+123",
        To: "whatsapp:+123",
      },
      undefined,
      {},
    );
    expect(allowed).toEqual({ text: "ok" });
    expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
  });
});

describe("typing controller idle", () => {
  it("marks dispatch idle after replies flush", async () => {
    const markDispatchIdle = vi.fn();
    const typingMock = {
      onReplyStart: vi.fn(async () => {}),
      startTypingLoop: vi.fn(async () => {}),
      startTypingOnText: vi.fn(async () => {}),
      refreshTypingTtl: vi.fn(),
      markRunComplete: vi.fn(),
      markDispatchIdle,
      cleanup: vi.fn(),
    };
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn().mockResolvedValue(undefined);
    const sendMedia = vi.fn().mockResolvedValue(undefined);

    const replyResolver = vi.fn().mockImplementation(async (_ctx, opts) => {
      opts?.onTypingController?.(typingMock);
      return { text: "final reply" };
    });

    const mockConfig: ClawdbotConfig = {
      whatsapp: {
        allowFrom: ["*"],
      },
    };

    setLoadConfigMock(mockConfig);

    await monitorWebProvider(
      false,
      async ({ onMessage }) => {
        await onMessage({
          id: "m1",
          from: "+1000",
          conversationId: "+1000",
          to: "+2000",
          body: "hello",
          timestamp: Date.now(),
          chatType: "direct",
          chatId: "direct:+1000",
          sendComposing,
          reply,
          sendMedia,
        });
        return { close: vi.fn().mockResolvedValue(undefined) };
      },
      false,
      replyResolver,
    );

    resetLoadConfigMock();

    expect(markDispatchIdle).toHaveBeenCalled();
  });
});

describe("web auto-reply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBaileysMocks();
    resetLoadConfigMock();
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    vi.useRealTimers();
  });

  it("reconnects after a connection close", async () => {
    const closeResolvers: Array<() => void> = [];
    const sleep = vi.fn(async () => {});
    const listenerFactory = vi.fn(async () => {
      let _resolve!: () => void;
      const onClose = new Promise<void>((res) => {
        _resolve = res;
        closeResolvers.push(res);
      });
      return { close: vi.fn(), onClose };
    });
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const controller = new AbortController();
    const run = monitorWebProvider(
      false,
      listenerFactory,
      true,
      async () => ({ text: "ok" }),
      runtime as never,
      controller.signal,
      {
        heartbeatSeconds: 1,
        reconnect: { initialMs: 10, maxMs: 10, maxAttempts: 3, factor: 1.1 },
        sleep,
      },
    );

    await Promise.resolve();
    expect(listenerFactory).toHaveBeenCalledTimes(1);

    closeResolvers[0]?.();
    const waitForSecondCall = async () => {
      const started = Date.now();
      while (
        listenerFactory.mock.calls.length < 2 &&
        Date.now() - started < 200
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    await waitForSecondCall();
    expect(listenerFactory).toHaveBeenCalledTimes(2);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Retry 1"),
    );

    controller.abort();
    closeResolvers[1]?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await run;
  });

  it("forces reconnect when watchdog closes without onClose", async () => {
    vi.useFakeTimers();
    const sleep = vi.fn(async () => {});
    const closeResolvers: Array<(reason: unknown) => void> = [];
    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = vi.fn(
      async (opts: {
        onMessage: (
          msg: import("./inbound.js").WebInboundMessage,
        ) => Promise<void>;
      }) => {
        capturedOnMessage = opts.onMessage;
        let resolveClose: (reason: unknown) => void = () => {};
        const onClose = new Promise<unknown>((res) => {
          resolveClose = res;
          closeResolvers.push(res);
        });
        return {
          close: vi.fn(),
          onClose,
          signalClose: (reason?: unknown) => resolveClose(reason),
        };
      },
    );
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const controller = new AbortController();
    const run = monitorWebProvider(
      false,
      listenerFactory,
      true,
      async () => ({ text: "ok" }),
      runtime as never,
      controller.signal,
      {
        heartbeatSeconds: 1,
        reconnect: { initialMs: 10, maxMs: 10, maxAttempts: 3, factor: 1.1 },
        sleep,
      },
    );

    await Promise.resolve();
    expect(listenerFactory).toHaveBeenCalledTimes(1);

    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const sendMedia = vi.fn();
    await capturedOnMessage?.({
      body: "hi",
      from: "+1",
      to: "+2",
      id: "m1",
      sendComposing,
      reply,
      sendMedia,
    });

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(listenerFactory).toHaveBeenCalledTimes(2);

    controller.abort();
    closeResolvers[1]?.({ status: 499, isLoggedOut: false });
    await Promise.resolve();
    await run;
  }, 15_000);

  it(
    "stops after hitting max reconnect attempts",
    { timeout: 20000 },
    async () => {
      const closeResolvers: Array<() => void> = [];
      const sleep = vi.fn(async () => {});
      const listenerFactory = vi.fn(async () => {
        const onClose = new Promise<void>((res) => closeResolvers.push(res));
        return { close: vi.fn(), onClose };
      });
      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };

      const run = monitorWebProvider(
        false,
        listenerFactory,
        true,
        async () => ({ text: "ok" }),
        runtime as never,
        undefined,
        {
          heartbeatSeconds: 1,
          reconnect: { initialMs: 5, maxMs: 5, maxAttempts: 2, factor: 1.1 },
          sleep,
        },
      );

      await Promise.resolve();
      expect(listenerFactory).toHaveBeenCalledTimes(1);

      closeResolvers.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(listenerFactory).toHaveBeenCalledTimes(2);

      closeResolvers.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 15));
      await run;

      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("max attempts reached"),
      );
    },
  );

  it("processes inbound messages without batching and preserves timestamps", async () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "Europe/Vienna";

    const originalMax = process.getMaxListeners();
    process.setMaxListeners?.(1); // force low to confirm bump

    const store = await makeSessionStore({
      main: { sessionId: "sid", updatedAt: Date.now() },
    });

    try {
      const sendMedia = vi.fn();
      const reply = vi.fn().mockResolvedValue(undefined);
      const sendComposing = vi.fn();
      const resolver = vi.fn().mockResolvedValue({ text: "ok" });

      let capturedOnMessage:
        | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
        | undefined;
      const listenerFactory = async (opts: {
        onMessage: (
          msg: import("./inbound.js").WebInboundMessage,
        ) => Promise<void>;
      }) => {
        capturedOnMessage = opts.onMessage;
        return { close: vi.fn() };
      };

      setLoadConfigMock(() => ({
        session: { store: store.storePath },
      }));

      await monitorWebProvider(false, listenerFactory, false, resolver);
      expect(capturedOnMessage).toBeDefined();

      // Two messages from the same sender with fixed timestamps
      await capturedOnMessage?.({
        body: "first",
        from: "+1",
        to: "+2",
        id: "m1",
        timestamp: 1735689600000, // Jan 1 2025 00:00:00 UTC
        sendComposing,
        reply,
        sendMedia,
      });
      await capturedOnMessage?.({
        body: "second",
        from: "+1",
        to: "+2",
        id: "m2",
        timestamp: 1735693200000, // Jan 1 2025 01:00:00 UTC
        sendComposing,
        reply,
        sendMedia,
      });

      expect(resolver).toHaveBeenCalledTimes(2);
      const firstArgs = resolver.mock.calls[0][0];
      const secondArgs = resolver.mock.calls[1][0];
      expect(firstArgs.Body).toContain(
        "[WhatsApp +1 2025-01-01T00:00Z] [clawdbot] first",
      );
      expect(firstArgs.Body).not.toContain("second");
      expect(secondArgs.Body).toContain(
        "[WhatsApp +1 2025-01-01T01:00Z] [clawdbot] second",
      );
      expect(secondArgs.Body).not.toContain("first");

      // Max listeners bumped to avoid warnings in multi-instance test runs
      expect(process.getMaxListeners?.()).toBeGreaterThanOrEqual(50);
    } finally {
      process.setMaxListeners?.(originalMax);
      process.env.TZ = originalTz;
      await store.cleanup();
    }
  });

  it("falls back to text when media send fails", async () => {
    const sendMedia = vi.fn().mockRejectedValue(new Error("boom"));
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi.fn().mockResolvedValue({
      text: "hi",
      mediaUrl: "https://example.com/img.png",
    });

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (
        msg: import("./inbound.js").WebInboundMessage,
      ) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const smallPng = await sharp({
      create: {
        width: 200,
        height: 200,
        channels: 3,
        background: { r: 0, g: 255, b: 0 },
      },
    })
      .png()
      .toBuffer();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      body: true,
      arrayBuffer: async () =>
        smallPng.buffer.slice(
          smallPng.byteOffset,
          smallPng.byteOffset + smallPng.byteLength,
        ),
      headers: { get: () => "image/png" },
      status: 200,
    } as Response);

    await monitorWebProvider(false, listenerFactory, false, resolver);

    expect(capturedOnMessage).toBeDefined();
    await capturedOnMessage?.({
      body: "hello",
      from: "+1",
      to: "+2",
      id: "msg1",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(sendMedia).toHaveBeenCalledTimes(1);
    const fallback = reply.mock.calls[0]?.[0] as string;
    expect(fallback).toContain("hi");
    expect(fallback).toContain("Media failed");
    fetchMock.mockRestore();
  });

  it("returns a warning when remote media fetch 404s", async () => {
    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi.fn().mockResolvedValue({
      text: "caption",
      mediaUrl: "https://example.com/missing.jpg",
    });

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (
        msg: import("./inbound.js").WebInboundMessage,
      ) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 404,
      body: null,
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: { get: () => "text/plain" },
    } as unknown as Response);

    await monitorWebProvider(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hello",
      from: "+1",
      to: "+2",
      id: "msg1",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(sendMedia).not.toHaveBeenCalled();
    const fallback = reply.mock.calls[0]?.[0] as string;
    expect(fallback).toContain("caption");
    expect(fallback).toContain("Media failed");
    expect(fallback).toContain("404");

    fetchMock.mockRestore();
  });

  it("compresses media over 5MB and still sends it", async () => {
    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi.fn().mockResolvedValue({
      text: "hi",
      mediaUrl: "https://example.com/big.png",
    });

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (
        msg: import("./inbound.js").WebInboundMessage,
      ) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const bigPng = await sharp({
      create: {
        width: 3200,
        height: 3200,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(bigPng.length).toBeGreaterThan(5 * 1024 * 1024);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      body: true,
      arrayBuffer: async () =>
        bigPng.buffer.slice(
          bigPng.byteOffset,
          bigPng.byteOffset + bigPng.byteLength,
        ),
      headers: { get: () => "image/png" },
      status: 200,
    } as Response);

    await monitorWebProvider(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hello",
      from: "+1",
      to: "+2",
      id: "msg1",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(sendMedia).toHaveBeenCalledTimes(1);
    const payload = sendMedia.mock.calls[0][0] as {
      image: Buffer;
      caption?: string;
      mimetype?: string;
    };
    expect(payload.image.length).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(payload.mimetype).toBe("image/jpeg");
    // Should not fall back to separate text reply because caption is used.
    expect(reply).not.toHaveBeenCalled();

    fetchMock.mockRestore();
  });

  it(
    "compresses common formats to jpeg under the cap",
    { timeout: 45_000 },
    async () => {
      const formats = [
        {
          name: "png",
          mime: "image/png",
          make: (buf: Buffer, opts: { width: number; height: number }) =>
            sharp(buf, {
              raw: { width: opts.width, height: opts.height, channels: 3 },
            })
              .png({ compressionLevel: 0 })
              .toBuffer(),
        },
        {
          name: "jpeg",
          mime: "image/jpeg",
          make: (buf: Buffer, opts: { width: number; height: number }) =>
            sharp(buf, {
              raw: { width: opts.width, height: opts.height, channels: 3 },
            })
              .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
              .toBuffer(),
        },
        {
          name: "webp",
          mime: "image/webp",
          make: (buf: Buffer, opts: { width: number; height: number }) =>
            sharp(buf, {
              raw: { width: opts.width, height: opts.height, channels: 3 },
            })
              .webp({ quality: 100 })
              .toBuffer(),
        },
      ] as const;

      for (const fmt of formats) {
        // Force a small cap to ensure compression is exercised for every format.
        setLoadConfigMock(() => ({ agent: { mediaMaxMb: 1 } }));
        const sendMedia = vi.fn();
        const reply = vi.fn().mockResolvedValue(undefined);
        const sendComposing = vi.fn();
        const resolver = vi.fn().mockResolvedValue({
          text: "hi",
          mediaUrl: `https://example.com/big.${fmt.name}`,
        });

        let capturedOnMessage:
          | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
          | undefined;
        const listenerFactory = async (opts: {
          onMessage: (
            msg: import("./inbound.js").WebInboundMessage,
          ) => Promise<void>;
        }) => {
          capturedOnMessage = opts.onMessage;
          return { close: vi.fn() };
        };

        const width = 1200;
        const height = 1200;
        const raw = crypto.randomBytes(width * height * 3);
        const big = await fmt.make(raw, { width, height });
        expect(big.length).toBeGreaterThan(1 * 1024 * 1024);

        const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
          ok: true,
          body: true,
          arrayBuffer: async () =>
            big.buffer.slice(big.byteOffset, big.byteOffset + big.byteLength),
          headers: { get: () => fmt.mime },
          status: 200,
        } as Response);

        await monitorWebProvider(false, listenerFactory, false, resolver);
        expect(capturedOnMessage).toBeDefined();

        await capturedOnMessage?.({
          body: "hello",
          from: "+1",
          to: "+2",
          id: `msg-${fmt.name}`,
          sendComposing,
          reply,
          sendMedia,
        });

        expect(sendMedia).toHaveBeenCalledTimes(1);
        const payload = sendMedia.mock.calls[0][0] as {
          image: Buffer;
          mimetype?: string;
        };
        expect(payload.image.length).toBeLessThanOrEqual(1 * 1024 * 1024);
        expect(payload.mimetype).toBe("image/jpeg");
        expect(reply).not.toHaveBeenCalled();

        fetchMock.mockRestore();
        resetLoadConfigMock();
      }
    },
  );

  it("honors mediaMaxMb from config", async () => {
    setLoadConfigMock(() => ({ agent: { mediaMaxMb: 1 } }));
    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi.fn().mockResolvedValue({
      text: "hi",
      mediaUrl: "https://example.com/big.png",
    });

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (
        msg: import("./inbound.js").WebInboundMessage,
      ) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const bigPng = await sharp({
      create: {
        width: 2600,
        height: 2600,
        channels: 3,
        background: { r: 0, g: 0, b: 255 },
      },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(bigPng.length).toBeGreaterThan(1 * 1024 * 1024);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      body: true,
      arrayBuffer: async () =>
        bigPng.buffer.slice(
          bigPng.byteOffset,
          bigPng.byteOffset + bigPng.byteLength,
        ),
      headers: { get: () => "image/png" },
      status: 200,
    } as Response);

    await monitorWebProvider(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hello",
      from: "+1",
      to: "+2",
      id: "msg1",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(sendMedia).toHaveBeenCalledTimes(1);
    const payload = sendMedia.mock.calls[0][0] as {
      image: Buffer;
      caption?: string;
      mimetype?: string;
    };
    expect(payload.image.length).toBeLessThanOrEqual(1 * 1024 * 1024);
    expect(payload.mimetype).toBe("image/jpeg");
    expect(reply).not.toHaveBeenCalled();

    fetchMock.mockRestore();
  });

  it("falls back to text when media is unsupported", async () => {
    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi.fn().mockResolvedValue({
      text: "hi",
      mediaUrl: "https://example.com/file.pdf",
    });

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (
        msg: import("./inbound.js").WebInboundMessage,
      ) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      body: true,
      arrayBuffer: async () => Buffer.from("%PDF-1.4").buffer,
      headers: { get: () => "application/pdf" },
      status: 200,
    } as Response);

    await monitorWebProvider(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hello",
      from: "+1",
      to: "+2",
      id: "msg-pdf",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(sendMedia).toHaveBeenCalledTimes(1);
    const payload = sendMedia.mock.calls[0][0] as {
      document?: Buffer;
      caption?: string;
      fileName?: string;
    };
    expect(payload.document).toBeInstanceOf(Buffer);
    expect(payload.fileName).toBe("file.pdf");
    expect(payload.caption).toBe("hi");
    expect(reply).not.toHaveBeenCalled();

    fetchMock.mockRestore();
  });

  it("requires mention in group chats and injects history when replying", async () => {
    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ text: "ok" });

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (
        msg: import("./inbound.js").WebInboundMessage,
      ) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    await monitorWebProvider(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hello group",
      from: "123@g.us",
      conversationId: "123@g.us",
      chatId: "123@g.us",
      chatType: "group",
      to: "+2",
      id: "g1",
      senderE164: "+111",
      senderName: "Alice",
      selfE164: "+999",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(resolver).not.toHaveBeenCalled();

    await capturedOnMessage?.({
      body: "@bot ping",
      from: "123@g.us",
      conversationId: "123@g.us",
      chatId: "123@g.us",
      chatType: "group",
      to: "+2",
      id: "g2",
      senderE164: "+222",
      senderName: "Bob",
      mentionedJids: ["999@s.whatsapp.net"],
      selfE164: "+999",
      selfJid: "999@s.whatsapp.net",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    const payload = resolver.mock.calls[0][0];
    expect(payload.Body).toContain("Chat messages since your last reply");
    expect(payload.Body).toContain("Alice: hello group");
    expect(payload.Body).toContain("@bot ping");
    expect(payload.Body).toContain("[from: Bob (+222)]");
  });

  it("allows group messages when whatsapp groups default disables mention gating", async () => {
    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ text: "ok" });

    setLoadConfigMock(() => ({
      whatsapp: {
        allowFrom: ["*"],
        groups: { "*": { requireMention: false } },
      },
      routing: { groupChat: { mentionPatterns: ["@clawd"] } },
    }));

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (
        msg: import("./inbound.js").WebInboundMessage,
      ) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    await monitorWebProvider(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hello group",
      from: "123@g.us",
      conversationId: "123@g.us",
      chatId: "123@g.us",
      chatType: "group",
      to: "+2",
      id: "g-default-off",
      senderE164: "+111",
      senderName: "Alice",
      selfE164: "+999",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    resetLoadConfigMock();
  });

  it("blocks group messages when whatsapp groups is set without a wildcard", async () => {
    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ text: "ok" });

    setLoadConfigMock(() => ({
      whatsapp: {
        allowFrom: ["*"],
        groups: { "999@g.us": { requireMention: false } },
      },
      routing: { groupChat: { mentionPatterns: ["@clawd"] } },
    }));

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (
        msg: import("./inbound.js").WebInboundMessage,
      ) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    await monitorWebProvider(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "@clawd hello",
      from: "123@g.us",
      conversationId: "123@g.us",
      chatId: "123@g.us",
      chatType: "group",
      to: "+2",
      id: "g-allowlist-block",
      senderE164: "+111",
      senderName: "Alice",
      mentionedJids: ["999@s.whatsapp.net"],
      selfE164: "+999",
      selfJid: "999@s.whatsapp.net",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(resolver).not.toHaveBeenCalled();
    resetLoadConfigMock();
  });

  it("honors per-group mention overrides when conversationId uses session key", async () => {
    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ text: "ok" });

    setLoadConfigMock(() => ({
      whatsapp: {
        allowFrom: ["*"],
        groups: {
          "*": { requireMention: true },
          "123@g.us": { requireMention: false },
        },
      },
      routing: { groupChat: { mentionPatterns: ["@clawd"] } },
    }));

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (
        msg: import("./inbound.js").WebInboundMessage,
      ) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    await monitorWebProvider(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hello group",
      from: "whatsapp:group:123@g.us",
      conversationId: "whatsapp:group:123@g.us",
      chatId: "123@g.us",
      chatType: "group",
      to: "+2",
      id: "g-per-group-session-key",
      senderE164: "+111",
      senderName: "Alice",
      selfE164: "+999",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    resetLoadConfigMock();
  });

  it("supports always-on group activation with silent token and preserves history", async () => {
    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi
      .fn()
      .mockResolvedValueOnce({ text: SILENT_REPLY_TOKEN })
      .mockResolvedValueOnce({ text: "ok" });

    const { storePath, cleanup } = await makeSessionStore({
      "whatsapp:group:123@g.us": {
        sessionId: "g-1",
        updatedAt: Date.now(),
        groupActivation: "always",
      },
    });

    setLoadConfigMock(() => ({
      routing: {
        groupChat: { mentionPatterns: ["@clawd"] },
      },
      session: { store: storePath },
    }));

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (
        msg: import("./inbound.js").WebInboundMessage,
      ) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    await monitorWebProvider(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "first",
      from: "123@g.us",
      conversationId: "123@g.us",
      chatId: "123@g.us",
      chatType: "group",
      to: "+2",
      id: "g-always-1",
      senderE164: "+111",
      senderName: "Alice",
      selfE164: "+999",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();

    await capturedOnMessage?.({
      body: "second",
      from: "123@g.us",
      conversationId: "123@g.us",
      chatId: "123@g.us",
      chatType: "group",
      to: "+2",
      id: "g-always-2",
      senderE164: "+222",
      senderName: "Bob",
      selfE164: "+999",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(resolver).toHaveBeenCalledTimes(2);
    const payload = resolver.mock.calls[1][0];
    expect(payload.Body).toContain("Chat messages since your last reply");
    expect(payload.Body).toContain("Alice: first");
    expect(payload.Body).toContain("Bob: second");
    expect(reply).toHaveBeenCalledTimes(1);

    await cleanup();
    resetLoadConfigMock();
  });

  it("ignores JID mentions in self-chat mode (group chats)", async () => {
    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ text: "ok" });

    setLoadConfigMock(() => ({
      whatsapp: {
        // Self-chat heuristic: allowFrom includes selfE164.
        allowFrom: ["+999"],
        groups: { "*": { requireMention: true } },
      },
      routing: {
        groupChat: {
          mentionPatterns: ["\\bclawd\\b"],
        },
      },
    }));

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (
        msg: import("./inbound.js").WebInboundMessage,
      ) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    await monitorWebProvider(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    // WhatsApp @mention of the owner should NOT trigger the bot in self-chat mode.
    await capturedOnMessage?.({
      body: "@owner ping",
      from: "123@g.us",
      conversationId: "123@g.us",
      chatId: "123@g.us",
      chatType: "group",
      to: "+2",
      id: "g-self-1",
      senderE164: "+111",
      senderName: "Alice",
      mentionedJids: ["999@s.whatsapp.net"],
      selfE164: "+999",
      selfJid: "999@s.whatsapp.net",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(resolver).not.toHaveBeenCalled();

    // Text-based mentionPatterns still work (user can type "clawd" explicitly).
    await capturedOnMessage?.({
      body: "clawd ping",
      from: "123@g.us",
      conversationId: "123@g.us",
      chatId: "123@g.us",
      chatType: "group",
      to: "+2",
      id: "g-self-2",
      senderE164: "+222",
      senderName: "Bob",
      selfE164: "+999",
      selfJid: "999@s.whatsapp.net",
      sendComposing,
      reply,
      sendMedia,
    });

    expect(resolver).toHaveBeenCalledTimes(1);

    resetLoadConfigMock();
  });

  it("emits heartbeat logs with connection metadata", async () => {
    vi.useFakeTimers();
    const logPath = `/tmp/clawdbot-heartbeat-${crypto.randomUUID()}.log`;
    setLoggerOverride({ level: "trace", file: logPath });

    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const controller = new AbortController();
    const listenerFactory = vi.fn(async () => {
      const onClose = new Promise<void>(() => {
        // never resolves; abort will short-circuit
      });
      return { close: vi.fn(), onClose };
    });

    const run = monitorWebProvider(
      false,
      listenerFactory,
      true,
      async () => ({ text: "ok" }),
      runtime as never,
      controller.signal,
      {
        heartbeatSeconds: 1,
        reconnect: { initialMs: 5, maxMs: 5, maxAttempts: 1, factor: 1.1 },
      },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await vi.runAllTimersAsync();
    await run.catch(() => {});

    const content = await fs.readFile(logPath, "utf-8");
    expect(content).toMatch(/web-heartbeat/);
    expect(content).toMatch(/connectionId/);
    expect(content).toMatch(/messagesHandled/);
  });

  it("logs outbound replies to file", async () => {
    const logPath = `/tmp/clawdbot-log-test-${crypto.randomUUID()}.log`;
    setLoggerOverride({ level: "trace", file: logPath });

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (
        msg: import("./inbound.js").WebInboundMessage,
      ) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const resolver = vi.fn().mockResolvedValue({ text: "auto" });
    await monitorWebProvider(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hello",
      from: "+1",
      to: "+2",
      id: "msg1",
      sendComposing: vi.fn(),
      reply: vi.fn(),
      sendMedia: vi.fn(),
    });

    const content = await fs.readFile(logPath, "utf-8");
    expect(content).toMatch(/web-auto-reply/);
    expect(content).toMatch(/auto/);
  });

  it("prefixes body with same-phone marker when from === to", async () => {
    // Enable messagePrefix for same-phone mode testing
    setLoadConfigMock(() => ({
      whatsapp: {
        allowFrom: ["*"],
      },
      messages: {
        messagePrefix: "[same-phone]",
        responsePrefix: undefined,
      },
    }));

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (
        msg: import("./inbound.js").WebInboundMessage,
      ) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const resolver = vi.fn().mockResolvedValue({ text: "reply" });

    await monitorWebProvider(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hello",
      from: "+1555",
      to: "+1555", // Same phone!
      id: "msg1",
      sendComposing: vi.fn(),
      reply: vi.fn(),
      sendMedia: vi.fn(),
    });

    // The resolver should receive a prefixed body with the configured marker
    const callArg = resolver.mock.calls[0]?.[0] as { Body?: string };
    expect(callArg?.Body).toBeDefined();
    expect(callArg?.Body).toContain("[WhatsApp +1555");
    expect(callArg?.Body).toContain("[same-phone] hello");
    resetLoadConfigMock();
  });

  it("does not prefix body when from !== to", async () => {
    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (
        msg: import("./inbound.js").WebInboundMessage,
      ) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const resolver = vi.fn().mockResolvedValue({ text: "reply" });

    await monitorWebProvider(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hello",
      from: "+1555",
      to: "+2666", // Different phones
      id: "msg1",
      sendComposing: vi.fn(),
      reply: vi.fn(),
      sendMedia: vi.fn(),
    });

    // Body should include envelope but not the same-phone prefix
    const callArg = resolver.mock.calls[0]?.[0] as { Body?: string };
    expect(callArg?.Body).toContain("[WhatsApp +1555");
    expect(callArg?.Body).toContain("hello");
  });

  it("forwards reply-to context to resolver", async () => {
    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const listenerFactory = async (opts: {
      onMessage: (
        msg: import("./inbound.js").WebInboundMessage,
      ) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const resolver = vi.fn().mockResolvedValue({ text: "reply" });

    await monitorWebProvider(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hello",
      from: "+1555",
      to: "+2666",
      id: "msg1",
      replyToId: "q1",
      replyToBody: "original",
      replyToSender: "+1999",
      sendComposing: vi.fn(),
      reply: vi.fn(),
      sendMedia: vi.fn(),
    });

    const callArg = resolver.mock.calls[0]?.[0] as {
      ReplyToId?: string;
      ReplyToBody?: string;
      ReplyToSender?: string;
      Body?: string;
    };
    expect(callArg.ReplyToId).toBe("q1");
    expect(callArg.ReplyToBody).toBe("original");
    expect(callArg.ReplyToSender).toBe("+1999");
    expect(callArg.Body).toContain("[Replying to +1999 id:q1]");
    expect(callArg.Body).toContain("original");
  });

  it("applies responsePrefix to regular replies", async () => {
    setLoadConfigMock(() => ({
      whatsapp: {
        allowFrom: ["*"],
      },
      messages: {
        messagePrefix: undefined,
        responsePrefix: "🦞",
      },
    }));

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const reply = vi.fn();
    const listenerFactory = async (opts: {
      onMessage: (
        msg: import("./inbound.js").WebInboundMessage,
      ) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const resolver = vi.fn().mockResolvedValue({ text: "hello there" });

    await monitorWebProvider(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hi",
      from: "+1555",
      to: "+2666",
      id: "msg1",
      sendComposing: vi.fn(),
      reply,
      sendMedia: vi.fn(),
    });

    // Reply should have responsePrefix prepended
    expect(reply).toHaveBeenCalledWith("🦞 hello there");
    resetLoadConfigMock();
  });

  it("does not deliver HEARTBEAT_OK responses", async () => {
    setLoadConfigMock(() => ({
      whatsapp: {
        allowFrom: ["*"],
      },
      messages: {
        messagePrefix: undefined,
        responsePrefix: "🦞",
      },
    }));

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const reply = vi.fn();
    const listenerFactory = async (opts: {
      onMessage: (
        msg: import("./inbound.js").WebInboundMessage,
      ) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    // Resolver returns exact HEARTBEAT_OK
    const resolver = vi.fn().mockResolvedValue({ text: HEARTBEAT_TOKEN });

    await monitorWebProvider(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "test",
      from: "+1555",
      to: "+2666",
      id: "msg1",
      sendComposing: vi.fn(),
      reply,
      sendMedia: vi.fn(),
    });

    expect(reply).not.toHaveBeenCalled();
    resetLoadConfigMock();
  });

  it("does not double-prefix if responsePrefix already present", async () => {
    setLoadConfigMock(() => ({
      whatsapp: {
        allowFrom: ["*"],
      },
      messages: {
        messagePrefix: undefined,
        responsePrefix: "🦞",
      },
    }));

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const reply = vi.fn();
    const listenerFactory = async (opts: {
      onMessage: (
        msg: import("./inbound.js").WebInboundMessage,
      ) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    // Resolver returns text that already has prefix
    const resolver = vi.fn().mockResolvedValue({ text: "🦞 already prefixed" });

    await monitorWebProvider(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "test",
      from: "+1555",
      to: "+2666",
      id: "msg1",
      sendComposing: vi.fn(),
      reply,
      sendMedia: vi.fn(),
    });

    // Should not double-prefix
    expect(reply).toHaveBeenCalledWith("🦞 already prefixed");
    resetLoadConfigMock();
  });

  it("sends tool summaries immediately with responsePrefix", async () => {
    setLoadConfigMock(() => ({
      whatsapp: {
        allowFrom: ["*"],
      },
      messages: {
        messagePrefix: undefined,
        responsePrefix: "🦞",
      },
    }));

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const reply = vi.fn();
    const listenerFactory = async (opts: {
      onMessage: (
        msg: import("./inbound.js").WebInboundMessage,
      ) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const resolver = vi
      .fn()
      .mockImplementation(
        async (
          _ctx,
          opts?: { onToolResult?: (r: { text: string }) => Promise<void> },
        ) => {
          await opts?.onToolResult?.({ text: "🧩 tool1" });
          await opts?.onToolResult?.({ text: "🧩 tool2" });
          return { text: "final" };
        },
      );

    await monitorWebProvider(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hi",
      from: "+1555",
      to: "+2666",
      id: "msg1",
      sendComposing: vi.fn(),
      reply,
      sendMedia: vi.fn(),
    });

    const replies = reply.mock.calls.map((call) => call[0]);
    expect(replies).toEqual(["🦞 🧩 tool1", "🦞 🧩 tool2", "🦞 final"]);
    resetLoadConfigMock();
  });
});
