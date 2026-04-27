import "./test-helpers.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { setLoggerOverride } from "openclaw/plugin-sdk/runtime-env";
import { withEnvAsync } from "openclaw/plugin-sdk/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { escapeRegExp, formatEnvelopeTimestamp } from "../../../test/helpers/envelope-timestamp.js";
import { WhatsAppAuthUnstableError } from "./auth-store.js";
import {
  createWebInboundDeliverySpies,
  createMockWebListener,
  createScriptedWebListenerFactory,
  createWebListenerFactoryCapture,
  getLastWebAutoReplySessionSocket,
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  makeSessionStore,
  resetLoadConfigMock,
  sendWebDirectInboundMessage,
  setLoadConfigMock,
  setRuntimeConfigSourceSnapshotMock,
  startWebAutoReplyMonitor,
} from "./auto-reply.test-harness.js";

installWebAutoReplyTestHomeHooks();

async function startWatchdogScenario(params: {
  monitorWebChannel: typeof import("./auto-reply/monitor.js").monitorWebChannel;
}) {
  const sleep = vi.fn(async () => {});
  const scripted = createScriptedWebListenerFactory();
  const started = startWebAutoReplyMonitor({
    monitorWebChannelFn: params.monitorWebChannel as never,
    listenerFactory: scripted.listenerFactory,
    sleep,
    heartbeatSeconds: 60,
    messageTimeoutMs: 30,
    watchdogCheckMs: 5,
  });

  await vi.waitFor(
    () => {
      expect(scripted.getListenerCount()).toBe(1);
    },
    { timeout: 250, interval: 2 },
  );
  await vi.waitFor(
    () => {
      expect(scripted.getOnMessage()).toBeTypeOf("function");
    },
    { timeout: 250, interval: 2 },
  );

  const spies = createWebInboundDeliverySpies();
  await sendWebDirectInboundMessage({
    onMessage: scripted.getOnMessage()!,
    body: "hi",
    from: "+1",
    to: "+2",
    id: "m1",
    spies,
  });

  return { scripted, sleep, spies, ...started };
}

describe("web auto-reply connection", () => {
  installWebAutoReplyUnitTestHooks();

  let monitorWebChannel: typeof import("./auto-reply/monitor.js").monitorWebChannel;
  beforeAll(async () => {
    ({ monitorWebChannel } = await import("./auto-reply/monitor.js"));
  });

  it("handles helper envelope timestamps with trimmed timezones (regression)", () => {
    const d = new Date("2025-01-01T00:00:00.000Z");
    expect(() => formatEnvelopeTimestamp(d, " America/Los_Angeles ")).not.toThrow();
  });

  it("handles reconnect progress and max-attempt stop behavior", async () => {
    for (const scenario of [
      {
        reconnect: { initialMs: 10, maxMs: 10, maxAttempts: 3, factor: 1.1 },
        expectedCallsAfterFirstClose: 2,
        closeTwiceAndFinish: false,
        expectedError: "Retry 1",
      },
      {
        reconnect: { initialMs: 5, maxMs: 5, maxAttempts: 2, factor: 1.1 },
        expectedCallsAfterFirstClose: 2,
        closeTwiceAndFinish: true,
        expectedError: "max attempts reached",
      },
    ]) {
      const sleep = vi.fn(async () => {});
      const scripted = createScriptedWebListenerFactory();
      const { runtime, controller, run } = startWebAutoReplyMonitor({
        monitorWebChannelFn: monitorWebChannel as never,
        listenerFactory: scripted.listenerFactory,
        sleep,
        reconnect: scenario.reconnect,
      });

      await vi.waitFor(
        () => {
          expect(scripted.getListenerCount()).toBe(1);
        },
        { timeout: 250, interval: 2 },
      );

      scripted.resolveClose(0);
      await vi.waitFor(
        () => {
          expect(scripted.getListenerCount()).toBe(scenario.expectedCallsAfterFirstClose);
        },
        { timeout: 250, interval: 2 },
      );

      if (scenario.closeTwiceAndFinish) {
        scripted.resolveClose(1);
        await run;
      } else {
        controller.abort();
        scripted.resolveClose(1);
        await Promise.resolve();
        await run;
      }

      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(scenario.expectedError));
    }
  });

  it("treats status 440 as non-retryable and stops without retrying", async () => {
    const sleep = vi.fn(async () => {});
    const scripted = createScriptedWebListenerFactory();
    const { runtime, controller, run } = startWebAutoReplyMonitor({
      monitorWebChannelFn: monitorWebChannel as never,
      listenerFactory: scripted.listenerFactory,
      sleep,
      reconnect: { initialMs: 10, maxMs: 10, maxAttempts: 3, factor: 1.1 },
    });

    await vi.waitFor(
      () => {
        expect(scripted.getListenerCount()).toBe(1);
      },
      { timeout: 250, interval: 2 },
    );
    scripted.resolveClose(0, {
      status: 440,
      isLoggedOut: false,
      error: "Unknown Stream Errored (conflict)",
    });

    const completedQuickly = await Promise.race([
      run.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 60)),
    ]);

    if (!completedQuickly) {
      await vi.waitFor(
        () => {
          expect(scripted.getListenerCount()).toBeGreaterThanOrEqual(2);
        },
        { timeout: 250, interval: 2 },
      );
      controller.abort();
      scripted.resolveClose(1, { status: 499, isLoggedOut: false, error: "aborted" });
      await run;
    }

    expect(completedQuickly).toBe(true);
    expect(scripted.getListenerCount()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("status 440"));
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("session conflict"));
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Stopping web monitoring"));
  });

  it("retries inbox attach when auth state is still stabilizing", async () => {
    const sleep = vi.fn(async () => {});
    const listenerFactory = vi.fn(async () => {
      if (listenerFactory.mock.calls.length === 1) {
        throw new WhatsAppAuthUnstableError(
          "WhatsApp auth state is still stabilizing; retrying inbox attach.",
        );
      }
      return createMockWebListener();
    });
    const { runtime, controller, run } = startWebAutoReplyMonitor({
      monitorWebChannelFn: monitorWebChannel as never,
      listenerFactory,
      sleep,
      reconnect: { initialMs: 5, maxMs: 5, maxAttempts: 3, factor: 1.1 },
    });

    await vi.waitFor(
      () => {
        expect(listenerFactory).toHaveBeenCalledTimes(2);
      },
      { timeout: 250, interval: 2 },
    );

    controller.abort();
    await run;

    expect(sleep).toHaveBeenCalledWith(expect.any(Number), expect.any(AbortSignal));
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("inbox attach"));
  });

  it("stops retrying inbox attach when auth stays unstable past max attempts", async () => {
    const sleep = vi.fn(async () => {});
    const listenerFactory = vi.fn(async () => {
      throw new WhatsAppAuthUnstableError(
        "WhatsApp auth state is still stabilizing; retrying inbox attach.",
      );
    });
    const { runtime, run } = startWebAutoReplyMonitor({
      monitorWebChannelFn: monitorWebChannel as never,
      listenerFactory,
      sleep,
      reconnect: { initialMs: 5, maxMs: 5, maxAttempts: 2, factor: 1.1 },
    });

    await run;

    expect(listenerFactory).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Retry 1/2"));
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Stopping web monitoring"));
  });

  it("forces reconnect when watchdog closes without onClose", async () => {
    vi.useFakeTimers();
    try {
      const { scripted, controller, run } = await startWatchdogScenario({
        monitorWebChannel,
      });

      await vi.advanceTimersByTimeAsync(200);
      await Promise.resolve();
      await vi.waitFor(
        () => {
          expect(scripted.getListenerCount()).toBeGreaterThanOrEqual(2);
        },
        { timeout: 250, interval: 2 },
      );

      controller.abort();
      scripted.resolveClose(1, { status: 499, isLoggedOut: false });
      await Promise.resolve();
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps quiet linked-device sessions open when transport frames keep arriving", async () => {
    vi.useFakeTimers();
    try {
      const sleep = vi.fn(async () => {});
      const scripted = createScriptedWebListenerFactory();
      const { controller, run } = startWebAutoReplyMonitor({
        monitorWebChannelFn: monitorWebChannel as never,
        listenerFactory: scripted.listenerFactory,
        sleep,
        heartbeatSeconds: 60,
        messageTimeoutMs: 30,
        watchdogCheckMs: 5,
      });

      await vi.waitFor(
        () => {
          expect(scripted.getListenerCount()).toBe(1);
        },
        { timeout: 250, interval: 2 },
      );

      const socket = getLastWebAutoReplySessionSocket();
      await vi.advanceTimersByTimeAsync(20);
      socket.ws.emit("frame");
      await vi.advanceTimersByTimeAsync(20);
      socket.ws.emit("frame");
      await vi.advanceTimersByTimeAsync(20);

      expect(scripted.getListenerCount()).toBe(1);

      controller.abort();
      scripted.resolveClose(0, { status: 499, isLoggedOut: false });
      await Promise.resolve();
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let transport frames mask application silence forever", async () => {
    vi.useFakeTimers();
    try {
      const sleep = vi.fn(async () => {});
      const scripted = createScriptedWebListenerFactory();
      const { controller, run } = startWebAutoReplyMonitor({
        monitorWebChannelFn: monitorWebChannel as never,
        listenerFactory: scripted.listenerFactory,
        sleep,
        heartbeatSeconds: 60,
        messageTimeoutMs: 30,
        watchdogCheckMs: 5,
      });

      await vi.waitFor(
        () => {
          expect(scripted.getListenerCount()).toBe(1);
        },
        { timeout: 250, interval: 2 },
      );

      const socket = getLastWebAutoReplySessionSocket();
      for (let elapsedMs = 0; elapsedMs < 140; elapsedMs += 20) {
        socket.ws.emit("frame");
        await vi.advanceTimersByTimeAsync(20);
      }

      await vi.waitFor(
        () => {
          expect(scripted.getListenerCount()).toBeGreaterThanOrEqual(2);
        },
        { timeout: 250, interval: 2 },
      );

      controller.abort();
      scripted.resolveClose(scripted.getListenerCount() - 1, {
        status: 499,
        isLoggedOut: false,
        error: "aborted",
      });
      await Promise.resolve();
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a reconnected listener a fresh watchdog window", async () => {
    vi.useFakeTimers();
    try {
      const { scripted, controller, run } = await startWatchdogScenario({
        monitorWebChannel,
      });

      scripted.resolveClose(0, { status: 499, isLoggedOut: false, error: "first-close" });
      await vi.waitFor(
        () => {
          expect(scripted.getListenerCount()).toBe(2);
        },
        { timeout: 250, interval: 2 },
      );

      await vi.advanceTimersByTimeAsync(20);
      await Promise.resolve();
      expect(scripted.getListenerCount()).toBe(2);

      await vi.advanceTimersByTimeAsync(20);
      await Promise.resolve();
      await vi.waitFor(
        () => {
          expect(scripted.getListenerCount()).toBeGreaterThanOrEqual(3);
        },
        { timeout: 250, interval: 2 },
      );

      controller.abort();
      scripted.resolveClose(scripted.getListenerCount() - 1, {
        status: 499,
        isLoggedOut: false,
        error: "aborted",
      });
      await Promise.resolve();
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes accounts.default debounceMs into the live listener for named accounts", async () => {
    const capture = createWebListenerFactoryCapture();

    setLoadConfigMock({
      channels: {
        whatsapp: {
          accounts: {
            default: {
              debounceMs: 250,
            },
            work: {
              authDir: "/tmp/work",
            },
          },
        },
      },
    } as OpenClawConfig);

    await monitorWebChannel(
      false,
      capture.listenerFactory as never,
      false,
      async () => ({ text: "ok" }),
      undefined,
      undefined,
      {
        accountId: "work",
      },
    );

    resetLoadConfigMock();
    expect(capture.getLastOptions()?.debounceMs).toBe(250);
  });

  it("matches per-account debounce overrides case-insensitively", async () => {
    const capture = createWebListenerFactoryCapture();

    setLoadConfigMock({
      channels: {
        whatsapp: {
          accounts: {
            work: {
              authDir: "/tmp/work",
              debounceMs: 250,
            },
          },
        },
      },
    } as OpenClawConfig);

    await monitorWebChannel(
      false,
      capture.listenerFactory as never,
      false,
      async () => ({ text: "ok" }),
      undefined,
      undefined,
      {
        accountId: "Work",
      },
    );

    resetLoadConfigMock();
    expect(capture.getLastOptions()?.debounceMs).toBe(250);
  });

  it("keeps the global inbound debounce fallback when WhatsApp debounceMs is only the schema default", async () => {
    const capture = createWebListenerFactoryCapture();

    setLoadConfigMock({
      messages: {
        inbound: {
          debounceMs: 250,
        },
      },
      channels: {
        whatsapp: {
          accounts: {
            work: {
              authDir: "/tmp/work",
            },
          },
        },
      },
    } as OpenClawConfig);
    setRuntimeConfigSourceSnapshotMock(null);

    await monitorWebChannel(
      false,
      capture.listenerFactory as never,
      false,
      async () => ({ text: "ok" }),
      undefined,
      undefined,
      {
        accountId: "work",
      },
    );

    resetLoadConfigMock();
    expect(capture.getLastOptions()?.debounceMs).toBe(250);
  });

  it("processes inbound messages without batching and preserves timestamps", async () => {
    await withEnvAsync({ TZ: "Europe/Vienna" }, async () => {
      const originalMax = process.getMaxListeners();
      process.setMaxListeners?.(1);

      const store = await makeSessionStore({
        main: { sessionId: "sid", updatedAt: Date.now() },
      });

      try {
        const sendMedia = vi.fn();
        const reply = vi.fn().mockResolvedValue(undefined);
        const sendComposing = vi.fn();
        const resolver = vi.fn().mockResolvedValue({ text: "ok" });

        const capture = createWebListenerFactoryCapture();

        setLoadConfigMock(() => ({
          agents: {
            defaults: {
              envelopeTimezone: "utc",
            },
          },
          session: { store: store.storePath },
        }));

        await monitorWebChannel(false, capture.listenerFactory as never, false, resolver);
        const capturedOnMessage = capture.getOnMessage();
        expect(capturedOnMessage).toBeDefined();

        const spies = { sendMedia, reply, sendComposing };
        await sendWebDirectInboundMessage({
          onMessage: capturedOnMessage!,
          body: "first",
          from: "+1",
          to: "+2",
          id: "m1",
          timestamp: 1735689600000,
          spies,
        });
        await sendWebDirectInboundMessage({
          onMessage: capturedOnMessage!,
          body: "second",
          from: "+1",
          to: "+2",
          id: "m2",
          timestamp: 1735693200000,
          spies,
        });

        expect(resolver).toHaveBeenCalledTimes(2);
        const firstArgs = resolver.mock.calls[0][0];
        const secondArgs = resolver.mock.calls[1][0];
        const firstTimestamp = formatEnvelopeTimestamp(new Date("2025-01-01T00:00:00Z"));
        const secondTimestamp = formatEnvelopeTimestamp(new Date("2025-01-01T01:00:00Z"));
        const firstPattern = escapeRegExp(firstTimestamp);
        const secondPattern = escapeRegExp(secondTimestamp);
        expect(firstArgs.Body).toMatch(
          new RegExp(`\\[WhatsApp \\+1 (\\+\\d+[smhd] )?${firstPattern}\\] \\[openclaw\\] first`),
        );
        expect(firstArgs.Body).not.toContain("second");
        expect(secondArgs.Body).toMatch(
          new RegExp(`\\[WhatsApp \\+1 (\\+\\d+[smhd] )?${secondPattern}\\] \\[openclaw\\] second`),
        );
        expect(secondArgs.Body).not.toContain("first");
        expect(process.getMaxListeners?.()).toBeGreaterThanOrEqual(50);
      } finally {
        process.setMaxListeners?.(originalMax);
        await store.cleanup();
        resetLoadConfigMock();
      }
    });
  });

  it("emits heartbeat logs with connection metadata", async () => {
    vi.useFakeTimers();
    const logPath = `/tmp/openclaw-heartbeat-${crypto.randomUUID()}.log`;
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

    const run = monitorWebChannel(
      false,
      listenerFactory as never,
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
    const logPath = `/tmp/openclaw-log-test-${crypto.randomUUID()}.log`;
    setLoggerOverride({ level: "trace", file: logPath });

    const capture = createWebListenerFactoryCapture();

    const resolver = vi.fn().mockResolvedValue({ text: "auto" });
    await monitorWebChannel(false, capture.listenerFactory as never, false, resolver as never);
    const capturedOnMessage = capture.getOnMessage();
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hello",
      from: "+1",
      conversationId: "+1",
      to: "+2",
      accountId: "default",
      chatType: "direct",
      chatId: "+1",
      id: "msg1",
      sendComposing: vi.fn(),
      reply: vi.fn(),
      sendMedia: vi.fn(),
    });

    const content = await fs.readFile(logPath, "utf-8");
    expect(content).toMatch(/web-auto-reply/);
    expect(content).toMatch(/auto/);
  });

  it("marks dispatch idle after replies flush", async () => {
    const markDispatchIdle = vi.fn();
    const typingMock = {
      onReplyStart: vi.fn(async () => {}),
      startTypingLoop: vi.fn(async () => {}),
      startTypingOnText: vi.fn(async () => {}),
      refreshTypingTtl: vi.fn(),
      isActive: vi.fn(() => false),
      markRunComplete: vi.fn(),
      markDispatchIdle,
      cleanup: vi.fn(),
    };
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn().mockResolvedValue(undefined);
    const sendMedia = vi.fn().mockResolvedValue(undefined);

    const replyResolver = vi.fn().mockImplementation(async (ctx, opts) => {
      void ctx;
      opts?.onTypingController?.(typingMock);
      return { text: "final reply" };
    });

    const mockConfig: OpenClawConfig = {
      channels: { whatsapp: { allowFrom: ["*"] } },
    };

    setLoadConfigMock(mockConfig);

    await monitorWebChannel(
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
          accountId: "default",
          sendComposing,
          reply,
          sendMedia,
        });
        return createMockWebListener();
      },
      false,
      replyResolver,
    );

    resetLoadConfigMock();

    expect(markDispatchIdle).toHaveBeenCalled();
  });
});
