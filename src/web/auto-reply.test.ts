import crypto from "node:crypto";
import fs from "node:fs/promises";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WarelayConfig } from "../config/config.js";
import { resetLogger, setLoggerOverride } from "../logging.js";
import {
  HEARTBEAT_TOKEN,
  monitorWebProvider,
  resolveReplyHeartbeatMinutes,
  runWebHeartbeatOnce,
  stripHeartbeatToken,
} from "./auto-reply.js";
import type { sendMessageWeb } from "./outbound.js";
import {
  resetBaileysMocks,
  resetLoadConfigMock,
  setLoadConfigMock,
} from "./test-helpers.js";

describe("heartbeat helpers", () => {
  it("strips heartbeat token and skips when only token", () => {
    expect(stripHeartbeatToken(undefined)).toEqual({
      shouldSkip: true,
      text: "",
    });
    expect(stripHeartbeatToken("  ")).toEqual({
      shouldSkip: true,
      text: "",
    });
    expect(stripHeartbeatToken(HEARTBEAT_TOKEN)).toEqual({
      shouldSkip: true,
      text: "",
    });
  });

  it("keeps content and removes token when mixed", () => {
    expect(stripHeartbeatToken(`ALERT ${HEARTBEAT_TOKEN}`)).toEqual({
      shouldSkip: false,
      text: "ALERT",
    });
    expect(stripHeartbeatToken(`hello`)).toEqual({
      shouldSkip: false,
      text: "hello",
    });
  });

  it("resolves heartbeat minutes with default and overrides", () => {
    const cfgBase: WarelayConfig = {
      inbound: {
        reply: { mode: "command" as const },
      },
    };
    expect(resolveReplyHeartbeatMinutes(cfgBase)).toBe(30);
    expect(
      resolveReplyHeartbeatMinutes({
        inbound: { reply: { mode: "command", heartbeatMinutes: 5 } },
      }),
    ).toBe(5);
    expect(
      resolveReplyHeartbeatMinutes({
        inbound: { reply: { mode: "command", heartbeatMinutes: 0 } },
      }),
    ).toBeNull();
    expect(resolveReplyHeartbeatMinutes(cfgBase, 7)).toBe(7);
    expect(
      resolveReplyHeartbeatMinutes({
        inbound: { reply: { mode: "text" } },
      }),
    ).toBeNull();
  });
});

describe("runWebHeartbeatOnce", () => {
  it("skips when heartbeat token returned", async () => {
    const sender: typeof sendMessageWeb = vi.fn();
    const resolver = vi.fn(async () => ({ text: HEARTBEAT_TOKEN }));
    setLoadConfigMock({
      inbound: { allowFrom: ["+1555"], reply: { mode: "command" } },
    });
    await runWebHeartbeatOnce({
      to: "+1555",
      verbose: false,
      sender,
      replyResolver: resolver,
    });
    expect(resolver).toHaveBeenCalled();
    expect(sender).not.toHaveBeenCalled();
  });

  it("sends when alert text present", async () => {
    const sender: typeof sendMessageWeb = vi
      .fn()
      .mockResolvedValue({ messageId: "m1", toJid: "jid" });
    const resolver = vi.fn(async () => ({ text: "ALERT" }));
    setLoadConfigMock({
      inbound: { allowFrom: ["+1555"], reply: { mode: "command" } },
    });
    await runWebHeartbeatOnce({
      to: "+1555",
      verbose: false,
      sender,
      replyResolver: resolver,
    });
    expect(sender).toHaveBeenCalledWith("+1555", "ALERT", { verbose: false });
  });

  it("falls back to most recent session when no to is provided", async () => {
    const sender: typeof sendMessageWeb = vi
      .fn()
      .mockResolvedValue({ messageId: "m1", toJid: "jid" });
    const resolver = vi.fn(async () => ({ text: "ALERT" }));
    // Seed session store
    const now = Date.now();
    const store = {
      "+1222": { sessionId: "s1", updatedAt: now - 1000 },
      "+1333": { sessionId: "s2", updatedAt: now },
    };
    const storePath = resolveStorePath();
    await fs.mkdir(resolveStorePath().replace("sessions.json", ""), {
      recursive: true,
    });
    await fs.writeFile(storePath, JSON.stringify(store));
    setLoadConfigMock({
      inbound: {
        allowFrom: ["+1999"],
        reply: { mode: "command", session: {} },
      },
    });
    await runWebHeartbeatOnce({
      to: "+1999",
      verbose: false,
      sender,
      replyResolver: resolver,
    });
    expect(sender).toHaveBeenCalledWith("+1333", "ALERT", { verbose: false });
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

  it("stops after hitting max reconnect attempts", async () => {
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
      expect.stringContaining("Reached max retries"),
    );
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
    expect(reply).toHaveBeenCalledWith("hi");
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
    { timeout: 15_000 },
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
        setLoadConfigMock(() => ({ inbound: { reply: { mediaMaxMb: 1 } } }));
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
    setLoadConfigMock(() => ({ inbound: { reply: { mediaMaxMb: 1 } } }));
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

  it("emits heartbeat logs with connection metadata", async () => {
    vi.useFakeTimers();
    const logPath = `/tmp/warelay-heartbeat-${crypto.randomUUID()}.log`;
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
    expect(content).toContain('"module":"web-heartbeat"');
    expect(content).toMatch(/connectionId/);
    expect(content).toMatch(/messagesHandled/);
  });

  it("logs outbound replies to file", async () => {
    const logPath = `/tmp/warelay-log-test-${crypto.randomUUID()}.log`;
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
    expect(content).toContain('"module":"web-auto-reply"');
    expect(content).toContain('"text":"auto"');
  });
});
