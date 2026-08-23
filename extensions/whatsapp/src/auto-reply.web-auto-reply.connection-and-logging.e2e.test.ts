// Whatsapp tests cover auto reply.web auto reply.connection and logging plugin behavior.
import "./test-helpers.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { escapeRegExp, formatEnvelopeTimestamp } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { getChildLogger, setLoggerOverride } from "openclaw/plugin-sdk/runtime-env";
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
  resetLoadConfigMock,
  sendWebDirectInboundMessage,
  setLoadConfigMock,
  startWebAutoReplyMonitor,
} from "./auto-reply.test-harness.js";
import {
  createWhatsAppReplyTransportContext,
  deliverWebReply,
} from "./auto-reply/deliver-reply.js";
import { buildInboundLine } from "./auto-reply/monitor/message-line.js";
import type { WebChannelStatus } from "./auto-reply/types.js";
import { createTestWebInboundMessage } from "./inbound/test-message.test-helper.js";
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

async function waitForScriptedListeners(
  scripted: ReturnType<typeof createScriptedWebListenerFactory>,
  count: number,
  atLeast = false,
) {
  await vi.waitFor(
    () => {
      const actual = scripted.getListenerCount();
      expect(atLeast ? Math.min(actual, count) : actual).toBe(count);
    },
    { timeout: 250, interval: 2 },
  );
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

    // The controller records inbound activity before admission; this test only needs that
    // lifecycle fact and must not start unrelated delivery/session work.
    await requireOnMessage(scripted.getOnMessage())(
      createTestWebInboundMessage({
        event: { id: "active-before-reconnect" },
        payload: { body: "ignored" },
        admission: {
          conversation: { kind: "direct", id: "+1" },
          ingress: {
            admission: "drop",
            decision: "block",
            decisiveGateId: "sender",
            reasonCode: "no_policy_match",
          },
        },
      }),
    );

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
      throw toErrorObject(boom428, "Non-Error thrown");
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

  it("marks an opening-phase remote logout as a terminal disconnect", async () => {
    vi.mocked(waitForWaConnection).mockRejectedValueOnce({
      output: { statusCode: 401 },
    });
    const listenerFactory = vi.fn(async () => createMockWebListener());
    const sleep = vi.fn(async () => {});
    const statuses: Array<Partial<WebChannelStatus>> = [];
    const { runtime, run } = startWebAutoReplyMonitor({
      monitorWebChannelFn: monitorWebChannel as never,
      listenerFactory,
      sleep,
      statusSink: (next) => statuses.push({ ...next }),
    });

    await expect(run).resolves.toBeUndefined();

    expect(waitForWaConnection).toHaveBeenCalledOnce();
    expect(listenerFactory).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toMatchObject({
      running: false,
      connected: false,
      healthState: "logged-out",
      lifecycle: "blocked",
      terminalDisconnect: true,
    });
    expectErrorContaining(runtime.error, "openclaw channels login --channel whatsapp");
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
      const statuses: Array<Partial<WebChannelStatus>> = [];
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
      expect(finalStatus?.lifecycle).toBe("blocked");
    },
  );

  it.each([
    ["retries inbox attach when auth state is still stabilizing", true, 3],
    ["stops retrying inbox attach when auth stays unstable past max attempts", false, 2],
  ] as const)("%s", async (_name, recovers, maxAttempts) => {
    const sleep = vi.fn(async () => {});
    const listenerFactory = vi.fn(async () => {
      if (recovers && listenerFactory.mock.calls.length > 1) {
        return createMockWebListener();
      }
      throw new WhatsAppAuthUnstableError(
        "WhatsApp auth state is still stabilizing; retrying inbox attach.",
      );
    });
    const { runtime, controller, run } = startWebAutoReplyMonitor({
      monitorWebChannelFn: monitorWebChannel as never,
      listenerFactory,
      sleep,
      reconnect: { initialMs: 5, maxMs: 5, maxAttempts, factor: 1.1 },
    });

    if (recovers) {
      await vi.waitFor(() => expect(listenerFactory).toHaveBeenCalledTimes(2), {
        timeout: 250,
        interval: 2,
      });
      controller.abort();
    }
    await run;

    expect(listenerFactory).toHaveBeenCalledTimes(2);
    if (recovers) {
      expect(typeof mockCallArg(sleep, 0, 0)).toBe("number");
      expect(mockCallArg(sleep, 0, 1)).toBeInstanceOf(AbortSignal);
      expectErrorContaining(runtime.error, "inbox attach");
    } else {
      expect(sleep).toHaveBeenCalledTimes(1);
      expectErrorContaining(runtime.error, "Retry 1/2");
      expectErrorContaining(runtime.error, "Stopping web monitoring");
    }
  });

  type WatchdogCaseContext = {
    scripted: ReturnType<typeof createScriptedWebListenerFactory>;
    statuses: Array<Record<string, unknown>>;
    runtime: ReturnType<typeof startWebAutoReplyMonitor>["runtime"];
  };
  type WatchdogCase = {
    name: string;
    seedInbound?: boolean;
    captureStatus?: boolean;
    options?: {
      heartbeatSeconds?: number;
      transportTimeoutMs?: number;
      messageTimeoutMs?: number;
      watchdogCheckMs?: number;
    };
    cleanupWithoutError?: boolean;
    exercise: (context: WatchdogCaseContext) => Promise<void>;
    assertAfterRun?: (context: WatchdogCaseContext) => void;
  };

  const watchdogCases = [
    {
      name: "forces reconnect when watchdog closes without onClose",
      seedInbound: true,
      captureStatus: true,
      cleanupWithoutError: true,
      exercise: async ({ scripted }) => {
        await vi.advanceTimersByTimeAsync(200);
        await Promise.resolve();
        await waitForScriptedListeners(scripted, 2, true);
      },
      assertAfterRun: ({ runtime, statuses }) => {
        expect(mockStringMessages(runtime.log).join("\n")).toContain(
          "WhatsApp Web watchdog is recovering a stale connection",
        );
        expect(mockStringMessages(runtime.error).join("\n")).not.toContain("status 499");
        expect(
          statuses.filter(
            (status) =>
              status.healthState === "reconnecting" &&
              status.lifecycle === "recovering" &&
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
              status.lifecycle === "ready" &&
              status.reconnectAttempts === 0 &&
              status.lastDisconnect === null,
          ),
        ).not.toEqual([]);
      },
    },
    {
      name: "keeps quiet linked-device sessions open when transport frames keep arriving",
      cleanupWithoutError: true,
      exercise: async ({ scripted }) => {
        const socket = getLastWebAutoReplySessionSocket();
        await vi.advanceTimersByTimeAsync(20);
        socket.ws.emit("frame");
        await vi.advanceTimersByTimeAsync(20);
        socket.ws.emit("frame");
        await vi.advanceTimersByTimeAsync(20);
        expect(scripted.getListenerCount()).toBe(1);
      },
    },
    {
      name: "does not let transport frames mask application silence forever",
      exercise: async ({ scripted }) => {
        const socket = getLastWebAutoReplySessionSocket();
        for (let elapsedMs = 0; elapsedMs < 140; elapsedMs += 20) {
          socket.ws.emit("frame");
          await vi.advanceTimersByTimeAsync(20);
        }
        await waitForScriptedListeners(scripted, 2, true);
      },
    },
    {
      name: "publishes frame-driven transport activity for quiet sessions",
      captureStatus: true,
      options: {
        heartbeatSeconds: 1,
        transportTimeoutMs: 60_000,
        messageTimeoutMs: 60_000,
      },
      exercise: async ({ statuses }) => {
        const initialTransportAt = Number(statuses.at(-1)?.lastTransportActivityAt ?? 0);
        const socket = getLastWebAutoReplySessionSocket();
        await vi.advanceTimersByTimeAsync(250);
        socket.ws.emit("frame");
        await vi.advanceTimersByTimeAsync(1_000);
        const lastTransportAt = Number(statuses.at(-1)?.lastTransportActivityAt ?? 0);
        expect(lastTransportAt).toBeGreaterThan(initialTransportAt);
      },
    },
    {
      name: "reconnects on transport stall before the long app-silence window",
      options: {
        heartbeatSeconds: 1,
        transportTimeoutMs: 30,
        messageTimeoutMs: 3_000,
      },
      exercise: async ({ scripted }) => {
        await vi.advanceTimersByTimeAsync(36);
        await Promise.resolve();
        await waitForScriptedListeners(scripted, 2, true);
      },
    },
    {
      name: "recovers a post-408 listener when transport frames continue but app delivery stays silent",
      seedInbound: true,
      exercise: async ({ scripted }) => {
        scripted.resolveClose(0, {
          status: 408,
          isLoggedOut: false,
          error: "status=408 Request Time-out",
        });
        await waitForScriptedListeners(scripted, 2);
        const reconnectedSocket = getLastWebAutoReplySessionSocket();
        for (let elapsedMs = 0; elapsedMs < 45; elapsedMs += 5) {
          reconnectedSocket.ws.emit("frame");
          await vi.advanceTimersByTimeAsync(5);
        }
        await waitForScriptedListeners(scripted, 3, true);
      },
    },
    {
      name: "gives a reconnected listener a fresh watchdog window",
      seedInbound: true,
      exercise: async ({ scripted }) => {
        scripted.resolveClose(0, { status: 499, isLoggedOut: false, error: "first-close" });
        await waitForScriptedListeners(scripted, 2);
        await vi.advanceTimersByTimeAsync(20);
        await Promise.resolve();
        expect(scripted.getListenerCount()).toBe(2);
        await vi.advanceTimersByTimeAsync(20);
        await Promise.resolve();
        await waitForScriptedListeners(scripted, 3, true);
      },
    },
  ] satisfies WatchdogCase[];

  it.each(watchdogCases)("$name", async (scenario) => {
    vi.useFakeTimers();
    const sleep = vi.fn(async () => {});
    const statuses: Array<Record<string, unknown>> = [];
    const scripted = createScriptedWebListenerFactory();
    const { controller, run, runtime } = startWebAutoReplyMonitor({
      monitorWebChannelFn: monitorWebChannel as never,
      listenerFactory: scripted.listenerFactory,
      sleep,
      heartbeatSeconds: 60,
      messageTimeoutMs: 30,
      watchdogCheckMs: 5,
      ...scenario.options,
      statusSink: scenario.captureStatus ? (status) => statuses.push({ ...status }) : undefined,
    });
    const context = { scripted, statuses, runtime };

    try {
      await waitForScriptedListeners(scripted, 1);
      if (scenario.seedInbound) {
        await vi.waitFor(
          () => {
            expect(scripted.getOnMessage()).toBeTypeOf("function");
          },
          { timeout: 250, interval: 2 },
        );
        await requireOnMessage(scripted.getOnMessage())(
          createTestWebInboundMessage({
            event: { id: "m1" },
            payload: { body: "ignored" },
            admission: {
              conversation: { kind: "direct", id: "+1" },
              ingress: {
                admission: "drop",
                decision: "block",
                decisiveGateId: "sender",
                reasonCode: "no_policy_match",
              },
            },
          }),
        );
      }

      await scenario.exercise(context);
    } finally {
      controller.abort();
      scripted.resolveClose(scripted.getListenerCount() - 1, {
        status: 499,
        isLoggedOut: false,
        ...(scenario.cleanupWithoutError ? {} : { error: "aborted" }),
      });
      await Promise.resolve();
      try {
        await run;
      } finally {
        vi.useRealTimers();
      }
    }

    scenario.assertAfterRun?.(context);
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

  it("raises the process listener budget before opening the web listener", async () => {
    const originalMax = process.getMaxListeners();
    process.setMaxListeners?.(1);
    try {
      const capture = createWebListenerFactoryCapture();
      await monitorWebChannel(
        false,
        capture.listenerFactory as never,
        false,
        async () => undefined,
      );
      expect(process.getMaxListeners?.()).toBeGreaterThanOrEqual(50);
    } finally {
      process.setMaxListeners?.(originalMax);
    }
  });

  it("builds separate timestamped inbound envelopes without batching", () => {
    const cfg = {} as OpenClawConfig;
    const buildLine = (body: string, id: string, timestamp: number) =>
      buildInboundLine({
        cfg,
        agentId: "main",
        envelope: { timezone: "utc" },
        msg: createTestWebInboundMessage({
          event: { id, timestamp },
          payload: { body },
          platform: { recipientJid: "+2" },
          admission: {
            conversation: { kind: "direct", id: "+1" },
            sender: { id: "+1" },
          },
        }),
      });

    const firstBody = buildLine("first", "m1", 1735689600000);
    const secondBody = buildLine("second", "m2", 1735693200000);
    const firstTimestamp = formatEnvelopeTimestamp(new Date("2025-01-01T00:00:00Z"), "utc");
    const secondTimestamp = formatEnvelopeTimestamp(new Date("2025-01-01T01:00:00Z"), "utc");

    expect(firstBody).toMatch(
      new RegExp(
        `\\[WhatsApp \\+1 (\\+\\d+[smhd] )?${escapeRegExp(firstTimestamp)}\\] \\+1: \\[openclaw\\] first`,
      ),
    );
    expect(firstBody).not.toContain("second");
    expect(secondBody).toMatch(
      new RegExp(
        `\\[WhatsApp \\+1 (\\+\\d+[smhd] )?${escapeRegExp(secondTimestamp)}\\] \\+1: \\[openclaw\\] second`,
      ),
    );
    expect(secondBody).not.toContain("first");
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

    await vi.waitFor(() => expect(listenerFactory).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await vi.runAllTimersAsync();
    await run.catch(() => {});
    vi.useRealTimers();

    let content = "";
    await vi.waitFor(async () => {
      content = await fs.readFile(logPath, "utf-8").catch(() => "");
      expect(content).toMatch(/web-heartbeat/);
    });
    expect(content).toMatch(/web-heartbeat/);
    expect(content).toMatch(/connectionId/);
    expect(content).toMatch(/messagesHandled/);
  });

  it("logs outbound replies to file", async () => {
    const logPath = `/tmp/openclaw-log-test-${crypto.randomUUID()}.log`;
    setLoggerOverride({ level: "trace", file: logPath });
    const spies = createWebInboundDeliverySpies();
    const msg = createTestWebInboundMessage({
      event: { id: "msg1" },
      payload: { body: "hello" },
      platform: {
        chatJid: "+1",
        recipientJid: "+2",
        reply: spies.reply,
        sendMedia: spies.sendMedia,
      },
      admission: {
        accountId: "default",
        conversation: { kind: "direct", id: "+1" },
      },
    });

    await deliverWebReply({
      replyResult: { text: "auto" },
      transport: createWhatsAppReplyTransportContext(msg),
      maxMediaBytes: 5 * 1024 * 1024,
      textLimit: 64_000,
      replyLogger: getChildLogger({ module: "web-auto-reply", runId: "file-log-test" }),
      connectionId: "conn-file-log",
    });

    let content = "";
    await vi.waitFor(async () => {
      content = await fs.readFile(logPath, "utf-8").catch(() => "");
      expect(content).toMatch(/web-auto-reply/);
    });
    expect(content).toMatch(/web-auto-reply/);
    expect(content).toMatch(/auto/);
  });
});
