import "./test-helpers.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { escapeRegExp, formatEnvelopeTimestamp } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { setLoggerOverride } from "openclaw/plugin-sdk/runtime-env";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getActiveWebListener } from "./active-listener.js";
import { WhatsAppAuthUnstableError, resolveWebCredsPath } from "./auth-store.js";
import { resolveOAuthDir } from "./auth-store.runtime.js";
import {
  createWebInboundDeliverySpies,
  createAcceptedWhatsAppSendResult,
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

function requireOnMessage(
  value: unknown,
): Parameters<typeof sendWebDirectInboundMessage>[0]["onMessage"] {
  if (typeof value !== "function") {
    throw new Error("expected web listener onMessage callback");
  }
  return value as Parameters<typeof sendWebDirectInboundMessage>[0]["onMessage"];
}

async function startWatchdogScenario(params: {
  monitorWebChannel: typeof import("./auto-reply/monitor.js").monitorWebChannel;
  statusSink?: Parameters<typeof startWebAutoReplyMonitor>[0]["statusSink"];
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
    statusSink: params.statusSink,
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

function expectErrorContaining(errorFn: unknown, text: string): void {
  const messages = ((errorFn as { mock?: { calls?: unknown[][] } }).mock?.calls ?? []).map((call) =>
    typeof call[0] === "string" ? call[0] : call[0] instanceof Error ? call[0].message : "",
  );
  expect(messages.some((message) => message.includes(text))).toBe(true);
}

function mockCallArg(mocked: unknown, callIndex: number, argIndex: number): unknown {
  const calls = (mocked as { mock?: { calls?: unknown[][] } }).mock?.calls;
  expect(calls?.[callIndex]).toBeDefined();
  return calls?.[callIndex]?.[argIndex];
}

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.stat(targetPath);
  } catch (error) {
    expect((error as { code?: unknown }).code).toBe("ENOENT");
    return;
  }
  throw new Error(`Expected path to be missing: ${targetPath}`);
}

describe("web auto-reply connection", () => {
  installWebAutoReplyUnitTestHooks();

  let monitorWebChannel: typeof import("./auto-reply/monitor.js").monitorWebChannel;
  beforeAll(async () => {
    ({ monitorWebChannel } = await import("./auto-reply/monitor.js"));
  });

  it("handles helper envelope timestamps with trimmed timezones (regression)", () => {
    const d = new Date("2025-01-01T00:00:00.000Z");
    expect(formatEnvelopeTimestamp(d, " America/Los_Angeles ")).toBe("Tue 2024-12-31 16:00 PST");
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

      expectErrorContaining(runtime.error, scenario.expectedError);
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
    expectErrorContaining(runtime.error, "status 440");
    expectErrorContaining(runtime.error, "session conflict");
    expectErrorContaining(runtime.error, "Stopping web monitoring");
  });

  it.each([
    {
      status: 440,
      isLoggedOut: false,
      healthState: "conflict",
      error: "Unknown Stream Errored (conflict)",
    },
    {
      status: 401,
      isLoggedOut: true,
      healthState: "logged-out",
      error: "Stream Errored (logged out)",
    },
  ] as const)(
    "clears stale auth and active listener after terminal status $status",
    async ({ status, isLoggedOut, healthState, error }) => {
      const accountId = `terminal-${status}`;
      const authDir = path.join(resolveOAuthDir(), "whatsapp", accountId);
      await fs.mkdir(authDir, { recursive: true });
      await fs.writeFile(
        resolveWebCredsPath(authDir),
        JSON.stringify({ me: { id: "123@s.whatsapp.net" } }),
      );
      setLoadConfigMock({
        channels: {
          whatsapp: {
            allowFrom: ["*"],
            accounts: {
              [accountId]: {
                authDir,
              },
            },
          },
        },
        messages: {
          messagePrefix: undefined,
          responsePrefix: undefined,
        },
      });

      const sleep = vi.fn(async () => {});
      const statuses: Array<{ healthState?: string; running?: boolean; connected?: boolean }> = [];
      const scripted = createScriptedWebListenerFactory();
      const { run } = startWebAutoReplyMonitor({
        monitorWebChannelFn: monitorWebChannel as never,
        listenerFactory: scripted.listenerFactory,
        sleep,
        accountId,
        statusSink: (next) => statuses.push(next),
        reconnect: { initialMs: 10, maxMs: 10, maxAttempts: 3, factor: 1.1 },
      });

      await vi.waitFor(
        () => {
          expect(scripted.getListenerCount()).toBe(1);
          const activeListener = getActiveWebListener(accountId);
          if (!activeListener) {
            throw new Error("expected active WhatsApp web listener");
          }
        },
        { timeout: 250, interval: 2 },
      );

      scripted.resolveClose(0, { status, isLoggedOut, error });
      await run;

      expect(scripted.getListenerCount()).toBe(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(getActiveWebListener(accountId)).toBeNull();
      await expectPathMissing(authDir);
      expect(
        statuses.some((entry) => entry.connected === false && entry.healthState === healthState),
      ).toBe(true);
      const finalStatus = statuses.at(-1);
      expect(finalStatus?.running).toBe(false);
      expect(finalStatus?.connected).toBe(false);
      expect(finalStatus?.healthState).toBe(healthState);
    },
  );

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

    expect(typeof mockCallArg(sleep, 0, 0)).toBe("number");
    expect(mockCallArg(sleep, 0, 1)).toBeInstanceOf(AbortSignal);
    expectErrorContaining(runtime.error, "inbox attach");
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
    expectErrorContaining(runtime.error, "Retry 1/2");
    expectErrorContaining(runtime.error, "Stopping web monitoring");
  });

  it("forces reconnect when watchdog closes without onClose", async () => {
    vi.useFakeTimers();
    try {
      const statuses: Array<Record<string, unknown>> = [];
      const { scripted, controller, run, runtime } = await startWatchdogScenario({
        monitorWebChannel,
        statusSink: (status) => statuses.push({ ...status }),
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

      expect(runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("WhatsApp Web watchdog is recovering a stale connection"),
      );
      expect(runtime.error).not.toHaveBeenCalledWith(expect.stringContaining("status 499"));
      expect(
        statuses.some(
          (status) =>
            status.healthState === "reconnecting" &&
            status.reconnectAttempts === 1 &&
            (status.lastDisconnect as { status?: number } | null)?.status === 499,
        ),
      ).toBe(true);
      expect(
        statuses.every(
          (status) =>
            !(
              status.lastDisconnect &&
              typeof status.lastDisconnect === "object" &&
              "expected" in status.lastDisconnect
            ),
        ),
      ).toBe(true);
      expect(
        statuses.some(
          (status) =>
            status.connected === true &&
            status.healthState === "healthy" &&
            status.reconnectAttempts === 0 &&
            status.lastDisconnect === null,
        ),
      ).toBe(true);
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

  it("publishes frame-driven transport activity for quiet sessions", async () => {
    vi.useFakeTimers();
    try {
      const sleep = vi.fn(async () => {});
      const statuses: Array<Record<string, unknown>> = [];
      const scripted = createScriptedWebListenerFactory();
      const { controller, run } = startWebAutoReplyMonitor({
        monitorWebChannelFn: monitorWebChannel as never,
        listenerFactory: scripted.listenerFactory,
        sleep,
        heartbeatSeconds: 1,
        transportTimeoutMs: 60_000,
        messageTimeoutMs: 60_000,
        watchdogCheckMs: 5,
        statusSink: (next) => statuses.push({ ...next }),
      });

      await vi.waitFor(
        () => {
          expect(scripted.getListenerCount()).toBe(1);
        },
        { timeout: 250, interval: 2 },
      );

      const initialTransportAt = Number(statuses.at(-1)?.lastTransportActivityAt ?? 0);
      const socket = getLastWebAutoReplySessionSocket();
      await vi.advanceTimersByTimeAsync(250);
      socket.ws.emit("frame");
      await vi.advanceTimersByTimeAsync(1_000);

      const lastTransportAt = Number(statuses.at(-1)?.lastTransportActivityAt ?? 0);
      expect(lastTransportAt).toBeGreaterThan(initialTransportAt);

      controller.abort();
      scripted.resolveClose(0, { status: 499, isLoggedOut: false, error: "aborted" });
      await Promise.resolve();
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnects on transport stall before the long app-silence window", async () => {
    vi.useFakeTimers();
    try {
      const sleep = vi.fn(async () => {});
      const scripted = createScriptedWebListenerFactory();
      const { controller, run } = startWebAutoReplyMonitor({
        monitorWebChannelFn: monitorWebChannel as never,
        listenerFactory: scripted.listenerFactory,
        sleep,
        heartbeatSeconds: 1,
        transportTimeoutMs: 30,
        messageTimeoutMs: 3_000,
        watchdogCheckMs: 5,
      });

      await vi.waitFor(
        () => {
          expect(scripted.getListenerCount()).toBe(1);
        },
        { timeout: 250, interval: 2 },
      );

      await vi.advanceTimersByTimeAsync(36);
      await Promise.resolve();
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

  it("recovers a post-408 listener when transport frames continue but app delivery stays silent", async () => {
    vi.useFakeTimers();
    try {
      const { scripted, controller, run } = await startWatchdogScenario({
        monitorWebChannel,
      });

      scripted.resolveClose(0, {
        status: 408,
        isLoggedOut: false,
        error: "status=408 Request Time-out",
      });
      await vi.waitFor(
        () => {
          expect(scripted.getListenerCount()).toBe(2);
        },
        { timeout: 250, interval: 2 },
      );

      const reconnectedSocket = getLastWebAutoReplySessionSocket();
      for (let elapsedMs = 0; elapsedMs < 45; elapsedMs += 5) {
        reconnectedSocket.ws.emit("frame");
        await vi.advanceTimersByTimeAsync(5);
      }

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
        const reply = vi.fn().mockResolvedValue(createAcceptedWhatsAppSendResult("text", "r1"));
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
        const capturedOnMessage = requireOnMessage(capture.getOnMessage());

        const spies = { sendMedia, reply, sendComposing };
        await sendWebDirectInboundMessage({
          onMessage: capturedOnMessage,
          body: "first",
          from: "+1",
          to: "+2",
          id: "m1",
          timestamp: 1735689600000,
          spies,
        });
        if (!capturedOnMessage) {
          throw new Error("Expected WhatsApp web runtime to register onMessage.");
        }
        await sendWebDirectInboundMessage({
          onMessage: capturedOnMessage,
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
    const capturedOnMessage = requireOnMessage(capture.getOnMessage());

    await capturedOnMessage({
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
    const reply = vi.fn().mockResolvedValue(createAcceptedWhatsAppSendResult("text", "r1"));
    const sendComposing = vi.fn().mockResolvedValue(undefined);
    const sendMedia = vi.fn().mockResolvedValue(createAcceptedWhatsAppSendResult("media", "m1"));

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
