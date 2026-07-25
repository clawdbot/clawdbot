// Whatsapp tests cover auto reply.web auto reply.connection and logging plugin behavior.
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
  startWebAutoReplyMonitor,
} from "./auto-reply.test-harness.js";
import {
  createTestLegacyFlatWebInboundMessage,
  createTestWebInboundMessage,
} from "./inbound/test-message.test-helper.js";
import type { WebInboundMessageInput } from "./inbound/types.js";
import { waitForWaConnection } from "./session.js";

type DrainSelectionEntry = {
  channel: string;
  accountId?: string | null;
  lastError?: string;
};
type DrainPendingDeliveriesCall = {
  drainKey: string;
  logLabel: string;
  selectEntry: (entry: DrainSelectionEntry) => { match: boolean; bypassBackoff: boolean };
};

const deliveryQueueMocks = vi.hoisted(() => ({
  drainPendingDeliveries: vi.fn(async (_opts: unknown) => undefined),
}));

vi.mock("openclaw/plugin-sdk/delivery-queue-runtime", () => ({
  drainPendingDeliveries: deliveryQueueMocks.drainPendingDeliveries,
}));

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
  const messages = ((errorFn as { mock?: { calls?: unknown[][] } }).mock?.calls ?? []).map(
    (call) =>
      typeof call[0] === "string" ? call[0] : call[0] instanceof Error ? call[0].message : "",
  );
  expect(messages.join("\n")).toContain(text);
}

function mockStringMessages(mocked: unknown): string[] {
  return ((mocked as { mock?: { calls?: unknown[][] } }).mock?.calls ?? []).map((call) =>
    typeof call[0] === "string" ? call[0] : call[0] instanceof Error ? call[0].message : "",
  );
}

function mockCallArg(mocked: unknown, callIndex: number, argIndex: number): unknown {
  const calls = (mocked as { mock?: { calls?: unknown[][] } }).mock?.calls;
  const call = calls?.[callIndex];
  if (!call) {
    throw new Error(`Expected mock call at index ${callIndex}`);
  }
  return call[argIndex];
}

describe("web auto-reply connection", () => {
  installWebAutoReplyUnitTestHooks();

  let monitorWebChannel: typeof import("./auto-reply/monitor.js").monitorWebChannel;
  beforeAll(async () => {
    ({ monitorWebChannel } = await import("./auto-reply/monitor.js"));
  });

  it("handles helper envelope timestamps with trimmed timezones (regression)", () => {
    const d = new Date("2025-01-01T00:00:00.000Z");
    expect(formatEnvelopeTimestamp(d, " America/Los_Angeles ")).toBe("Tue 2024-12-31 16:00:00 PST");
  });

  it("does not publish running status when config loading fails", async () => {
    setLoadConfigMock(() => {
      throw new Error("config snapshot failed");
    });

    const statuses: Array<{ running?: boolean }> = [];
    const listenerFactory = vi.fn(async () => createMockWebListener());
    const { run } = startWebAutoReplyMonitor({
      monitorWebChannelFn: monitorWebChannel as never,
      listenerFactory,
      sleep: vi.fn(async () => {}),
      statusSink: (next) => statuses.push({ ...next }),
    });

    await expect(run).rejects.toThrow("config snapshot failed");

    expect(listenerFactory).not.toHaveBeenCalled();
    expect(statuses.some((status) => status.running === true)).toBe(false);
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

  it("widens append catch-up only after reconnecting a recently active listener", async () => {
    const scripted = createScriptedWebListenerFactory();
    const { controller, run } = startWebAutoReplyMonitor({
      monitorWebChannelFn: monitorWebChannel as never,
      listenerFactory: scripted.listenerFactory,
      sleep: vi.fn(async () => {}),
      messageTimeoutMs: 30 * 60_000,
    });

    await vi.waitFor(() => expect(scripted.getListenerCount()).toBe(1));
    expect(
      (
        mockCallArg(scripted.listenerFactory, 0, 0) as {
          appendReplyWindow?: { afterMs: number; untilMs: number; maxAgeMs: number };
        }
      ).appendReplyWindow,
    ).toBeUndefined();

    await sendWebDirectInboundMessage({
      onMessage: requireOnMessage(scripted.getOnMessage()),
      body: "hi before reconnect",
      from: "+1",
      to: "+2",
      id: "active-before-reconnect",
      spies: createWebInboundDeliverySpies(),
    });

    const reconnectStartedAt = Date.now();
    scripted.resolveClose(0, { status: 408, isLoggedOut: false, error: new Error("timeout") });
    await vi.waitFor(() => expect(scripted.getListenerCount()).toBe(2));

    const appendReplyWindow = (
      mockCallArg(scripted.listenerFactory, 1, 0) as {
        appendReplyWindow?: { afterMs: number; untilMs: number; maxAgeMs: number };
      }
    ).appendReplyWindow;
    expect(appendReplyWindow?.afterMs).toBeGreaterThanOrEqual(reconnectStartedAt - 20 * 60_000);
    expect(appendReplyWindow?.afterMs).toBeLessThanOrEqual(Date.now() - 20 * 60_000);
    expect(appendReplyWindow?.untilMs).toBeGreaterThanOrEqual(reconnectStartedAt + 20 * 60_000);
    expect(appendReplyWindow?.maxAgeMs).toBe(20 * 60_000);

    controller.abort();
    scripted.resolveClose(1, { status: 499, isLoggedOut: false, error: "aborted" });
    await run;
  });

  it("retries opening-phase Boom 428 through the reconnect policy", async () => {
    const boom428 = {
      output: {
        statusCode: 428,
        payload: { error: "Precondition Required", message: "Connection Terminated" },
      },
    };
    const listenerFactory = vi.fn(async () => {
      throw toLintErrorObject(boom428, "Non-Error thrown");
    });

    const sleep = vi.fn(async () => {});
    const { runtime, run } = startWebAutoReplyMonitor({
      monitorWebChannelFn: monitorWebChannel as never,
      listenerFactory,
      sleep,
      reconnect: { initialMs: 10, maxMs: 10, maxAttempts: 2, factor: 1.1 },
    });

    await run;

    expect(listenerFactory).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalled();
    expectErrorContaining(runtime.error, "status 428");
    expectErrorContaining(runtime.error, "Retry 1/2");
    expectErrorContaining(runtime.error, "2/2 attempts");
  });

  it("retries opening-phase connection wait timeouts through the reconnect policy", async () => {
    vi.mocked(waitForWaConnection).mockRejectedValueOnce({ output: { statusCode: 408 } });
    const listenerFactory = vi.fn(async () => createMockWebListener());
    const sleep = vi.fn(async () => {});
    const { runtime, controller, run } = startWebAutoReplyMonitor({
      monitorWebChannelFn: monitorWebChannel as never,
      listenerFactory,
      sleep,
      reconnect: { initialMs: 10, maxMs: 10, maxAttempts: 2, factor: 1.1 },
    });

    await vi.waitFor(
      () => {
        expect(listenerFactory).toHaveBeenCalledTimes(1);
      },
      { timeout: 250, interval: 2 },
    );
    controller.abort();
    await run;

    expect(waitForWaConnection).toHaveBeenCalledTimes(2);
    expect(listenerFactory).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalled();
    expectErrorContaining(runtime.error, "status 408");
    expectErrorContaining(runtime.error, "Retry 1/2");
  });

  it("keeps post-open Baileys 428 on the reconnect path", async () => {
    const sleep = vi.fn(async () => {});
    const scripted = createScriptedWebListenerFactory();
    const { controller, run } = startWebAutoReplyMonitor({
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
      status: 428,
      isLoggedOut: false,
      error: "Connection Terminated",
    });

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
    await run;

    expect(scripted.getListenerCount()).toBeGreaterThanOrEqual(2);
    expect(sleep).toHaveBeenCalled();
  });

  it("drains pending deliveries while connected and stops after close", async () => {
    vi.useFakeTimers();
    try {
      const sleep = vi.fn(async () => {});
      const scripted = createScriptedWebListenerFactory();
      const { controller, run } = startWebAutoReplyMonitor({
        monitorWebChannelFn: monitorWebChannel as never,
        listenerFactory: scripted.listenerFactory,
        sleep,
        accountId: "work",
      });

      await vi.waitFor(
        () => {
          expect(scripted.getListenerCount()).toBe(1);
        },
        { timeout: 250, interval: 2 },
      );
      expect(deliveryQueueMocks.drainPendingDeliveries).toHaveBeenCalledWith(
        expect.objectContaining({
          drainKey: "whatsapp:work",
          logLabel: "WhatsApp reconnect drain",
        }),
      );

      deliveryQueueMocks.drainPendingDeliveries.mockClear();
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => {
        expect(deliveryQueueMocks.drainPendingDeliveries).toHaveBeenCalledTimes(1);
      });

      const periodicCall = deliveryQueueMocks.drainPendingDeliveries.mock.calls.at(-1)?.[0] as
        | DrainPendingDeliveriesCall
        | undefined;
      expect(periodicCall).toBeDefined();
      if (!periodicCall) {
        throw new Error("Expected WhatsApp periodic drain call");
      }
      expect(periodicCall.drainKey).toBe("whatsapp:work");
      expect(periodicCall.logLabel).toBe("WhatsApp periodic drain");
      expect(
        periodicCall.selectEntry({
          channel: "whatsapp",
          accountId: "work",
        }),
      ).toEqual({ match: true, bypassBackoff: false });
      expect(
        periodicCall.selectEntry({
          channel: "whatsapp",
          accountId: "default",
        }),
      ).toEqual({ match: false, bypassBackoff: false });
      expect(
        periodicCall.selectEntry({
          channel: "telegram",
          accountId: "work",
        }),
      ).toEqual({ match: false, bypassBackoff: false });

      controller.abort();
      scripted.resolveClose(0, { status: 499, isLoggedOut: false, error: "aborted" });
      await Promise.resolve();
      await run;

      deliveryQueueMocks.drainPendingDeliveries.mockClear();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(deliveryQueueMocks.drainPendingDeliveries).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
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
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 60);
      }),
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
    expectErrorContaining(runtime.error, "openclaw channels logout --channel whatsapp");
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
    "stops active listener and preserves auth after terminal status $status",
    async ({ status, isLoggedOut, healthState, error }) => {
      const accountId = `terminal-${status}`;
      const authDir = path.join(resolveOAuthDir(), "whatsapp", accountId);
      const credsPath = resolveWebCredsPath(authDir);
      const credsJson = JSON.stringify({ me: { id: "123@s.whatsapp.net" } });
      await fs.mkdir(authDir, { recursive: true });
      await fs.writeFile(credsPath, credsJson);
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
      await expect(fs.readFile(credsPath, "utf8")).resolves.toBe(credsJson);
      expect(
        statuses.filter((entry) => entry.connected === false && entry.healthState === healthState),
      ).not.toEqual([]);
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

      expect(mockStringMessages(runtime.log).join("\n")).toContain(
        "WhatsApp Web watchdog is recovering a stale connection",
      );
      expect(mockStringMessages(runtime.error).join("\n")).not.toContain("status 499");
      expect(
        statuses.filter(
          (status) =>
            status.healthState === "reconnecting" &&
            status.reconnectAttempts === 1 &&
            (status.lastDisconnect as { status?: number } | null)?.status === 499,
        ),
      ).not.toEqual([]);
      expect(
        statuses.filter(
          (status) =>
            status.lastDisconnect &&
            typeof status.lastDisconnect === "object" &&
            "expected" in status.lastDisconnect,
        ),
      ).toEqual([]);
      expect(
        statuses.filter(
          (status) =>
            status.connected === true &&
            status.healthState === "healthy" &&
            status.reconnectAttempts === 0 &&
            status.lastDisconnect === null,
        ),
      ).not.toEqual([]);
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

  it("passes the global inbound debounce into the live listener", async () => {
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

  it("normalizes legacy flat listener messages and rejects partial nested input", async () => {
    const capture = createWebListenerFactoryCapture();
    const { sendMedia, sendComposing, reply } = createWebInboundDeliverySpies();

    await monitorWebChannel(false, capture.listenerFactory as never, false, async () => ({
      text: "ok",
    }));
    const onMessage = requireOnMessage(capture.getOnMessage());
    const msg = createTestLegacyFlatWebInboundMessage({
      from: "+1",
      conversationId: "+1",
      chatId: "+1",
      to: "+2",
      reply,
    });

    expect(capture.getLastOptions()?.shouldDebounce?.(msg)).toBe(true);
    expect(
      capture
        .getLastOptions()
        ?.shouldDebounce?.(createTestWebInboundMessage({ payload: { body: "   " } })),
    ).toBe(false);
    expect(
      capture.getLastOptions()?.shouldDebounce?.(
        createTestWebInboundMessage({
          payload: {
            body: "/stop\n\n[whatsapp attachment unavailable]",
            commandBody: "/stop",
          },
          platform: { sendComposing, reply, sendMedia },
        }),
      ),
    ).toBe(false);
    await onMessage(msg);

    expect(reply).toHaveBeenCalledWith("ok", undefined);
    await expect(
      onMessage({
        event: { id: "canonical-no-admission" },
        payload: { body: "canonical" },
        platform: {
          chatJid: "+3",
          recipientJid: "+4",
          sendComposing,
          reply,
          sendMedia,
        },
        from: "+3",
        conversationId: "+3",
        accountId: "default",
        chatType: "direct",
      }),
    ).rejects.toThrow(/missing admission facts/);

    expect(reply).toHaveBeenCalledWith("ok", undefined);
    expect(reply).toHaveBeenCalledTimes(1);
    await expect(
      onMessage({
        ...msg,
        id: "partial-msg",
        payload: { body: "partial nested" },
      } as unknown as WebInboundMessageInput),
    ).rejects.toThrow(/legacy flat or canonical nested/);
  });

  it("processes inbound messages without batching and preserves timestamps", async () => {
    await withEnvAsync({ TZ: "Europe/Vienna" }, async () => {
      const originalMax = process.getMaxListeners();
      process.setMaxListeners?.(1);

      const store = await makeSessionStore({
        main: { sessionId: "sid", updatedAt: Date.now() },
      });

      try {
        const { sendMedia, reply, sendComposing } = createWebInboundDeliverySpies();
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
        const firstArgs = resolver.mock.calls.at(0)?.[0];
        const secondArgs = resolver.mock.calls.at(1)?.[0];
        const firstTimestamp = formatEnvelopeTimestamp(new Date("2025-01-01T00:00:00Z"));
        const secondTimestamp = formatEnvelopeTimestamp(new Date("2025-01-01T01:00:00Z"));
        const firstPattern = escapeRegExp(firstTimestamp);
        const secondPattern = escapeRegExp(secondTimestamp);
        expect(firstArgs.Body).toMatch(
          new RegExp(
            `\\[WhatsApp \\+1 (\\+\\d+[smhd] )?${firstPattern}\\] \\+1: \\[openclaw\\] first`,
          ),
        );
        expect(firstArgs.Body).not.toContain("second");
        expect(secondArgs.Body).toMatch(
          new RegExp(
            `\\[WhatsApp \\+1 (\\+\\d+[smhd] )?${secondPattern}\\] \\+1: \\[openclaw\\] second`,
          ),
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

    await capturedOnMessage(
      createTestWebInboundMessage({
        event: {
          id: "msg1",
        },
        payload: {
          body: "hello",
        },
        platform: {
          chatJid: "+1",
          recipientJid: "+2",
          sendComposing: vi.fn(),
          reply: vi.fn(),
          sendMedia: vi.fn(),
        },
        admission: {
          accountId: "default",
          conversation: {
            kind: "direct",
            id: "+1",
          },
        },
      }),
    );

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
    const { reply, sendComposing, sendMedia } = createWebInboundDeliverySpies();

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
        await onMessage(
          createTestWebInboundMessage({
            event: {
              id: "m1",
              timestamp: Date.now(),
            },
            payload: {
              body: "hello",
            },
            platform: {
              chatJid: "direct:+1000",
              recipientJid: "+2000",
              sendComposing,
              reply,
              sendMedia,
            },
            admission: {
              accountId: "default",
              conversation: {
                kind: "direct",
                id: "+1000",
              },
            },
          }),
        );
        return createMockWebListener();
      },
      false,
      replyResolver,
    );

    resetLoadConfigMock();

    expect(markDispatchIdle).toHaveBeenCalled();
  });
});

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
