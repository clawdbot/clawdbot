import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const RELAY_WATCHDOG_ALARM = "openclaw-relay-watchdog";
const RELAY_OPENING_DEADLINE_ALARM = "openclaw-relay-opening-deadline";
const START_TIME_MS = Date.parse("2026-07-16T08:00:00.000Z");

type SocketEvent = { data?: unknown };
type SocketListener = (event: SocketEvent) => void;

async function loadBackground() {
  const sockets: FakeWebSocket[] = [];
  let alarmListener: ((alarm: { name: string }) => void) | undefined;

  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readyState = FakeWebSocket.CONNECTING;
    readonly send = vi.fn();
    readonly close = vi.fn(() => {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit("close");
    });
    private readonly listeners = new Map<string, SocketListener[]>();

    constructor(
      readonly url: string,
      readonly protocols: string[],
    ) {
      sockets.push(this);
    }

    addEventListener(type: string, listener: SocketListener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    open() {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open");
    }

    private emit(type: string, event: SocketEvent = {}) {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(event);
      }
    }
  }

  const addListener = vi.fn();
  const createAlarm = vi.fn();
  const clearAlarm = vi.fn(async () => true);
  const setBadgeText = vi.fn(async () => undefined);
  const setBadgeBackgroundColor = vi.fn(async () => undefined);
  const chromeMock = {
    action: { setBadgeText, setBadgeBackgroundColor },
    commands: { onCommand: { addListener } },
    contextMenus: {
      create: vi.fn(),
      removeAll: vi.fn(async () => undefined),
      onClicked: { addListener },
    },
    alarms: {
      create: createAlarm,
      clear: clearAlarm,
      onAlarm: {
        addListener: vi.fn((listener: (alarm: { name: string }) => void) => {
          alarmListener = listener;
        }),
      },
    },
    debugger: {
      onEvent: { addListener },
      onDetach: { addListener },
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      getTargets: vi.fn(async () => []),
      sendCommand: vi.fn(async () => ({})),
    },
    runtime: {
      getManifest: vi.fn(() => ({ version: "1.0.0" })),
      onConnect: { addListener },
      onMessage: { addListener },
      onStartup: { addListener },
      onInstalled: { addListener },
    },
    storage: {
      local: {
        get: vi.fn(async () => ({
          relayUrl: "ws://127.0.0.1:18797/extension",
          token: "test-token-placeholder",
          groupColor: "orange",
        })),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
      },
    },
    scripting: { executeScript: vi.fn(async () => []) },
    tabGroups: {
      query: vi.fn(async () => []),
      update: vi.fn(async () => undefined),
      onUpdated: { addListener },
      onRemoved: { addListener },
    },
    tabs: {
      query: vi.fn(async () => []),
      get: vi.fn(async () => ({ id: 1, windowId: 1 })),
      group: vi.fn(async () => 1),
      ungroup: vi.fn(async () => undefined),
      create: vi.fn(async () => ({ id: 1 })),
      remove: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      onRemoved: { addListener },
      onUpdated: { addListener },
    },
    windows: { update: vi.fn(async () => undefined) },
  };

  vi.stubGlobal("chrome", chromeMock);
  vi.stubGlobal("navigator", { userAgent: "Chromium/125.0.0.0" });
  vi.stubGlobal("WebSocket", FakeWebSocket);

  // The shipped MV3 worker is plain JS, so keep this a runtime-resolved import.
  const backgroundModulePath = "./background.js";
  await import(backgroundModulePath);
  await Promise.resolve();
  await Promise.resolve();

  if (!alarmListener) {
    throw new Error("expected background worker to register an alarm listener");
  }
  return {
    alarmListener,
    clearAlarm,
    createAlarm,
    setBadgeText,
    sockets,
  };
}

describe("relay opening deadline", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(START_TIME_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("closes a stuck connecting socket and retries", async () => {
    const harness = await loadBackground();
    expect(harness.sockets).toHaveLength(1);
    expect(harness.createAlarm).toHaveBeenCalledWith(RELAY_WATCHDOG_ALARM, {
      periodInMinutes: 0.5,
    });
    expect(harness.createAlarm).toHaveBeenCalledWith(RELAY_OPENING_DEADLINE_ALARM, {
      when: START_TIME_MS + 30_000,
    });

    vi.setSystemTime(START_TIME_MS + 30_000);
    harness.alarmListener({ name: RELAY_OPENING_DEADLINE_ALARM });

    expect(harness.sockets[0]?.close).toHaveBeenCalledOnce();
    expect(harness.clearAlarm).toHaveBeenCalledWith(RELAY_OPENING_DEADLINE_ALARM);
    expect(harness.setBadgeText).toHaveBeenLastCalledWith({ text: "!" });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.sockets).toHaveLength(2);
    expect(harness.createAlarm).toHaveBeenLastCalledWith(RELAY_OPENING_DEADLINE_ALARM, {
      when: START_TIME_MS + 61_000,
    });
  });

  it("clears the deadline after the socket opens", async () => {
    const harness = await loadBackground();
    const socket = harness.sockets[0];
    expect(socket).toBeDefined();

    socket?.open();
    expect(harness.clearAlarm).toHaveBeenCalledWith(RELAY_OPENING_DEADLINE_ALARM);
    expect(harness.setBadgeText).toHaveBeenLastCalledWith({ text: "ON" });

    vi.setSystemTime(START_TIME_MS + 60_000);
    harness.alarmListener({ name: RELAY_OPENING_DEADLINE_ALARM });
    expect(socket?.close).not.toHaveBeenCalled();
  });
});
