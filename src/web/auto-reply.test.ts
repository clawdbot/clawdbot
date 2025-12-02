// Import test-helpers FIRST to set up mocks before other imports
import {
  resetBaileysMocks,
  resetLoadConfigMock,
  setLoadConfigMock,
} from "./test-helpers.js";

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WarelayConfig } from "../config/config.js";
import * as commandQueue from "../process/command-queue.js";
import { resetLogger, setLoggerOverride } from "../logging.js";
import {
  HEARTBEAT_PROMPT,
  HEARTBEAT_TOKEN,
  monitorWebProvider,
  resolveHeartbeatRecipients,
  resolveReplyHeartbeatMinutes,
  runWebHeartbeatOnce,
  stripHeartbeatToken,
} from "./auto-reply.js";
import type { sendMessageWeb } from "./outbound.js";
import * as commandQueue from "../process/command-queue.js";
import { getQueueSize } from "../process/command-queue.js";

const makeSessionStore = async (
  entries: Record<string, unknown> = {},
): Promise<{ storePath: string; cleanup: () => Promise<void> }> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "warelay-session-"));
  const storePath = path.join(dir, "sessions.json");
  await fs.writeFile(storePath, JSON.stringify(entries));
  return {
    storePath,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
};

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

describe("resolveHeartbeatRecipients", () => {
  it("returns the sole session recipient", async () => {
    const now = Date.now();
    const store = await makeSessionStore({ "+1000": { updatedAt: now } });
    const cfg: WarelayConfig = {
      inbound: {
        allowFrom: ["+1999"],
        reply: { mode: "command", session: { store: store.storePath } },
      },
    };
    const result = resolveHeartbeatRecipients(cfg);
    expect(result.source).toBe("session-single");
    expect(result.recipients).toEqual(["+1000"]);
    await store.cleanup();
  });

  it("surfaces ambiguity when multiple sessions exist", async () => {
    const now = Date.now();
    const store = await makeSessionStore({
      "+1000": { updatedAt: now },
      "+2000": { updatedAt: now - 10 },
    });
    const cfg: WarelayConfig = {
      inbound: {
        allowFrom: ["+1999"],
        reply: { mode: "command", session: { store: store.storePath } },
      },
    };
    const result = resolveHeartbeatRecipients(cfg);
    expect(result.source).toBe("session-ambiguous");
    expect(result.recipients).toEqual(["+1000", "+2000"]);
    await store.cleanup();
  });

  it("filters wildcard allowFrom when no sessions exist", async () => {
    const store = await makeSessionStore({});
    const cfg: WarelayConfig = {
      inbound: {
        allowFrom: ["*"],
        reply: { mode: "command", session: { store: store.storePath } },
      },
    };
    const result = resolveHeartbeatRecipients(cfg);
    expect(result.recipients).toHaveLength(0);
    expect(result.source).toBe("allowFrom");
    await store.cleanup();
  });

  it("merges sessions and allowFrom when --all is set", async () => {
    const now = Date.now();
    const store = await makeSessionStore({ "+1000": { updatedAt: now } });
    const cfg: WarelayConfig = {
      inbound: {
        allowFrom: ["+1999"],
        reply: { mode: "command", session: { store: store.storePath } },
      },
    };
    const result = resolveHeartbeatRecipients(cfg, { all: true });
    expect(result.source).toBe("all");
    expect(result.recipients.sort()).toEqual(["+1000", "+1999"].sort());
    await store.cleanup();
  });
});

describe("runWebHeartbeatOnce", () => {
  it("skips when heartbeat token returned", async () => {
    const store = await makeSessionStore();
    const sender: typeof sendMessageWeb = vi.fn();
    const resolver = vi.fn(async () => ({ text: HEARTBEAT_TOKEN }));
    await runWebHeartbeatOnce({
      cfg: {
        inbound: {
          allowFrom: ["+1555"],
          reply: { mode: "command", session: { store: store.storePath } },
        },
      },
      to: "+1555",
      verbose: false,
      sender,
      replyResolver: resolver,
    });
    expect(resolver).toHaveBeenCalled();
    expect(sender).not.toHaveBeenCalled();
    await store.cleanup();
  });

  it("sends when alert text present", async () => {
    const store = await makeSessionStore();
    const sender: typeof sendMessageWeb = vi
      .fn()
      .mockResolvedValue({ messageId: "m1", toJid: "jid" });
    const resolver = vi.fn(async () => ({ text: "ALERT" }));
    await runWebHeartbeatOnce({
      cfg: {
        inbound: {
          allowFrom: ["+1555"],
          reply: { mode: "command", session: { store: store.storePath } },
        },
      },
      to: "+1555",
      verbose: false,
      sender,
      replyResolver: resolver,
    });
    expect(sender).toHaveBeenCalledWith("+1555", "ALERT", { verbose: false });
    await store.cleanup();
  });

  it("falls back to most recent session when no to is provided", async () => {
    const store = await makeSessionStore();
    const storePath = store.storePath;
    const sender: typeof sendMessageWeb = vi
      .fn()
      .mockResolvedValue({ messageId: "m1", toJid: "jid" });
    const resolver = vi.fn(async () => ({ text: "ALERT" }));
    const now = Date.now();
    const sessionEntries = {
      "+1222": { sessionId: "s1", updatedAt: now - 1000 },
      "+1333": { sessionId: "s2", updatedAt: now },
    };
    await fs.writeFile(storePath, JSON.stringify(sessionEntries));
    await runWebHeartbeatOnce({
      cfg: {
        inbound: {
          allowFrom: ["+1999"],
          reply: { mode: "command", session: { store: storePath } },
        },
      },
      to: "+1999",
      verbose: false,
      sender,
      replyResolver: resolver,
    });
    expect(sender).toHaveBeenCalledWith("+1999", "ALERT", { verbose: false });
    await store.cleanup();
  });

  it("does not refresh updatedAt when heartbeat is skipped", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "warelay-heartbeat-"),
    );
    const storePath = path.join(tmpDir, "sessions.json");
    const now = Date.now();
    const originalUpdated = now - 30 * 60 * 1000;
    const store = {
      "+1555": { sessionId: "sess1", updatedAt: originalUpdated },
    };
    await fs.writeFile(storePath, JSON.stringify(store));

    const sender: typeof sendMessageWeb = vi.fn();
    const resolver = vi.fn(async () => ({ text: HEARTBEAT_TOKEN }));
    setLoadConfigMock({
      inbound: {
        allowFrom: ["+1555"],
        reply: {
          mode: "command",
          session: {
            store: storePath,
            idleMinutes: 60,
            heartbeatIdleMinutes: 10,
          },
        },
      },
    });

    await runWebHeartbeatOnce({
      to: "+1555",
      verbose: false,
      sender,
      replyResolver: resolver,
    });

    const after = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(after["+1555"].updatedAt).toBe(originalUpdated);
    expect(sender).not.toHaveBeenCalled();
  });

  it("heartbeat reuses existing session id when last inbound is present", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "warelay-heartbeat-session-"),
    );
    const storePath = path.join(tmpDir, "sessions.json");
    const sessionId = "sess-keep";
    await fs.writeFile(
      storePath,
      JSON.stringify({
        "+4367": { sessionId, updatedAt: Date.now(), systemSent: false },
      }),
    );

    setLoadConfigMock(() => ({
      inbound: {
        allowFrom: ["+4367"],
        reply: {
          mode: "command",
          heartbeatMinutes: 0.001,
          session: { store: storePath, idleMinutes: 60 },
        },
      },
    }));

    const replyResolver = vi.fn().mockResolvedValue({ text: HEARTBEAT_TOKEN });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as never;
    const cfg: WarelayConfig = {
      inbound: {
        allowFrom: ["+4367"],
        reply: {
          mode: "command",
          session: { store: storePath, idleMinutes: 60 },
        },
      },
    };

    await runWebHeartbeatOnce({
      cfg,
      to: "+4367",
      verbose: false,
      replyResolver,
      runtime,
    });

    const heartbeatCall = replyResolver.mock.calls.find(
      (call) => call[0]?.Body === HEARTBEAT_PROMPT,
    );
    expect(heartbeatCall?.[0]?.MessageSid).toBe(sessionId);
  });

  it("heartbeat honors session-id override and seeds store", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "warelay-heartbeat-override-"),
    );
    const storePath = path.join(tmpDir, "sessions.json");
    await fs.writeFile(storePath, JSON.stringify({}));

    const sessionId = "override-123";
    setLoadConfigMock(() => ({
      inbound: {
        allowFrom: ["+1999"],
        reply: {
          mode: "command",
          session: { store: storePath, idleMinutes: 60 },
        },
      },
    }));

    const resolver = vi.fn(async () => ({ text: HEARTBEAT_TOKEN }));
    const cfg: WarelayConfig = {
      inbound: {
        allowFrom: ["+1999"],
        reply: {
          mode: "command",
          session: { store: storePath, idleMinutes: 60 },
        },
      },
    };
    await runWebHeartbeatOnce({
      cfg,
      to: "+1999",
      verbose: false,
      replyResolver: resolver,
      sessionId,
    });

    const heartbeatCall = resolver.mock.calls.find(
      (call) => call[0]?.Body === HEARTBEAT_PROMPT,
    );
    expect(heartbeatCall?.[0]?.MessageSid).toBe(sessionId);
    const raw = await fs.readFile(storePath, "utf-8");
    const stored = raw ? JSON.parse(raw) : {};
    expect(stored["+1999"]?.sessionId).toBe(sessionId);
    expect(stored["+1999"]?.updatedAt).toBeDefined();
  });

  it("sends overrideBody directly and skips resolver", async () => {
    const store = await makeSessionStore();
    const sender: typeof sendMessageWeb = vi
      .fn()
      .mockResolvedValue({ messageId: "m1", toJid: "jid" });
    const resolver = vi.fn();
    await runWebHeartbeatOnce({
      cfg: {
        inbound: {
          allowFrom: ["+1555"],
          reply: { mode: "command", session: { store: store.storePath } },
        },
      },
      to: "+1555",
      verbose: false,
      sender,
      replyResolver: resolver,
      overrideBody: "manual ping",
    });
    expect(sender).toHaveBeenCalledWith("+1555", "manual ping", {
      verbose: false,
    });
    expect(resolver).not.toHaveBeenCalled();
    await store.cleanup();
  });

  it("dry-run overrideBody prints and skips send", async () => {
    const store = await makeSessionStore();
    const sender: typeof sendMessageWeb = vi.fn();
    const resolver = vi.fn();
    await runWebHeartbeatOnce({
      cfg: {
        inbound: {
          allowFrom: ["+1555"],
          reply: { mode: "command", session: { store: store.storePath } },
        },
      },
      to: "+1555",
      verbose: false,
      sender,
      replyResolver: resolver,
      overrideBody: "dry",
      dryRun: true,
    });
    expect(sender).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
    await store.cleanup();
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

  it("skips reply heartbeat when requests are running", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "warelay-heartbeat-queue-"),
    );
    const storePath = path.join(tmpDir, "sessions.json");
    await fs.writeFile(storePath, JSON.stringify({}));

    const queueSpy = vi
      .spyOn(commandQueue, "getQueueSize")
      .mockReturnValue(2);
    const replyResolver = vi.fn();
    const listenerFactory = vi.fn(async () => {
      const onClose = new Promise<void>(() => {
        // stay open until aborted
      });
      return { close: vi.fn(), onClose };
    });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as never;

    setLoadConfigMock(() => ({
      inbound: {
        allowFrom: ["+1555"],
        reply: { mode: "command", session: { store: storePath } },
      },
    }));

    const controller = new AbortController();
    const run = monitorWebProvider(
      false,
      listenerFactory,
      true,
      replyResolver,
      runtime,
      controller.signal,
      { replyHeartbeatMinutes: 1, replyHeartbeatNow: true },
    );

    try {
      await Promise.resolve();
      controller.abort();
      await run;
      expect(replyResolver).not.toHaveBeenCalled();
    } finally {
      queueSpy.mockRestore();
    }
  });

  it("batches inbound messages while queue is busy and preserves timestamps", async () => {
    vi.useFakeTimers();
    const originalMax = process.getMaxListeners();
    process.setMaxListeners?.(1); // force low to confirm bump

    const sendMedia = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ text: "batched" });

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

    // Queue starts busy, then frees after one polling tick.
    let queueBusy = true;
    const queueSpy = vi
      .spyOn(commandQueue, "getQueueSize")
      .mockImplementation(() => (queueBusy ? 1 : 0));

    setLoadConfigMock(() => ({ inbound: { timestampPrefix: "UTC" } }));

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

    // Let the queued batch flush once the queue is free
    queueBusy = false;
    vi.advanceTimersByTime(200);

    expect(resolver).toHaveBeenCalledTimes(1);
    const args = resolver.mock.calls[0][0];
    expect(args.Body).toContain("[Jan 1 00:00] [warelay] first");
    expect(args.Body).toContain("[Jan 1 01:00] [warelay] second");

    // Max listeners bumped to avoid warnings in multi-instance test runs
    expect(process.getMaxListeners?.()).toBeGreaterThanOrEqual(50);

    queueSpy.mockRestore();
    process.setMaxListeners?.(originalMax);
    vi.useRealTimers();
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

  it("prefixes body with same-phone marker when from === to", async () => {
    // Enable messagePrefix for same-phone mode testing
    setLoadConfigMock(() => ({
      inbound: {
        allowFrom: ["*"],
        messagePrefix: "[same-phone]",
        responsePrefix: undefined,
        timestampPrefix: false,
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
    expect(callArg?.Body).toBe("[same-phone] hello");
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

    // Body should NOT be prefixed
    const callArg = resolver.mock.calls[0]?.[0] as { Body?: string };
    expect(callArg?.Body).toBe("hello");
  });

  it("applies responsePrefix to regular replies", async () => {
    setLoadConfigMock(() => ({
      inbound: {
        allowFrom: ["*"],
        messagePrefix: undefined,
        responsePrefix: "🦞",
        timestampPrefix: false,
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

  it("skips responsePrefix for HEARTBEAT_OK responses", async () => {
    setLoadConfigMock(() => ({
      inbound: {
        allowFrom: ["*"],
        messagePrefix: undefined,
        responsePrefix: "🦞",
        timestampPrefix: false,
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

    // HEARTBEAT_OK should NOT have prefix - warelay needs exact match
    expect(reply).toHaveBeenCalledWith(HEARTBEAT_TOKEN);
    resetLoadConfigMock();
  });

  it("does not double-prefix if responsePrefix already present", async () => {
    setLoadConfigMock(() => ({
      inbound: {
        allowFrom: ["*"],
        messagePrefix: undefined,
        responsePrefix: "🦞",
        timestampPrefix: false,
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
});
