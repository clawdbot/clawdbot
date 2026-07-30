import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const RELAY_WATCHDOG_ALARM = "openclaw-relay-watchdog";
const RELAY_OPENING_DEADLINE_ALARM = "openclaw-relay-opening-deadline";
const START_TIME_MS = Date.parse("2026-07-16T08:00:00.000Z");

type SocketEvent = { data?: unknown };
type SocketListener = (event: SocketEvent) => void;
type RuntimeMessageListener = (
  message: { type: string; tabId?: number; note?: string; pairingString?: string },
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean;
type PageCaptureResult = {
  content: string;
  selection: string;
  title: string;
  url: string;
};

async function loadBackground({ deferSocketClose = false }: { deferSocketClose?: boolean } = {}) {
  const sockets: FakeWebSocket[] = [];
  let alarmListener: ((alarm: { name: string }) => void) | undefined;
  let messageListener: RuntimeMessageListener | undefined;

  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readyState = FakeWebSocket.CONNECTING;
    readonly send = vi.fn();
    readonly close = vi.fn(() => {
      if (deferSocketClose) {
        this.readyState = FakeWebSocket.CLOSING;
        return;
      }
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

    receive(message: unknown) {
      this.emit("message", { data: JSON.stringify(message) });
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
      onMessage: {
        addListener: vi.fn((listener: RuntimeMessageListener) => {
          messageListener = listener;
        }),
      },
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
    scripting: {
      executeScript: vi.fn(async (): Promise<Array<{ result: PageCaptureResult }>> => []),
    },
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
  if (!messageListener) {
    throw new Error("expected background worker to register a message listener");
  }
  return {
    alarmListener,
    clearAlarm,
    createAlarm,
    executeScript: chromeMock.scripting.executeScript,
    messageListener,
    setBadgeText,
    sockets,
    tabsGet: chromeMock.tabs.get,
  };
}

async function startPendingPageShare(
  harness: Awaited<ReturnType<typeof loadBackground>>,
  socket = harness.sockets.at(-1),
) {
  if (!socket) {
    throw new Error("expected the page-share relay socket");
  }
  if (socket.readyState !== 1) {
    socket.open();
  }
  harness.executeScript.mockResolvedValueOnce([
    {
      result: {
        url: "https://example.com/article",
        title: "Example article",
        selection: "",
        content: "Article body",
      },
    },
  ]);
  const response = vi.fn();
  expect(harness.messageListener({ type: "sendPageToOpenClaw", tabId: 1 }, {}, response)).toBe(
    true,
  );
  await vi.waitFor(() => {
    expect(socket.send.mock.calls.some(([raw]) => JSON.parse(raw).type === "pageShare")).toBe(true);
  });
  const raw = socket.send.mock.calls.find(([frame]) => JSON.parse(frame).type === "pageShare")?.[0];
  if (typeof raw !== "string") {
    throw new Error("expected a sent page-share request");
  }
  return { socket, response, requestId: (JSON.parse(raw) as { requestId: number }).requestId };
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

describe("copilot panel messaging", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("responds exactly once when the tab cannot be retrieved", async () => {
    const harness = await loadBackground();
    harness.tabsGet.mockRejectedValueOnce(new Error("No tab with id: 44."));
    const sendResponse = vi.fn();

    expect(
      harness.messageListener({ type: "prepareCopilotPanel", tabId: 44 }, {}, sendResponse),
    ).toBe(true);

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledOnce();
    });
    expect(harness.tabsGet).toHaveBeenCalledWith(44);
    expect(sendResponse).toHaveBeenCalledWith({
      ok: false,
      error: "No tab with id: 44.",
    });
  });

  it("responds exactly once with the prepared panel path", async () => {
    const harness = await loadBackground();
    const sendResponse = vi.fn();

    expect(
      harness.messageListener({ type: "prepareCopilotPanel", tabId: 44 }, {}, sendResponse),
    ).toBe(true);

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledOnce();
    });
    expect(harness.tabsGet).toHaveBeenCalledWith(44);
    expect(sendResponse).toHaveBeenCalledWith({
      ok: true,
      path: expect.stringMatching(/^sidepanel\.html\?binding=/),
    });
  });
});

describe("page-share relay request lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("immediately rejects a page share when its owning relay disconnects", async () => {
    const harness = await loadBackground();
    const pending = await startPendingPageShare(harness);

    pending.socket.close();

    await vi.waitFor(() => {
      expect(pending.response).toHaveBeenCalledWith({
        ok: false,
        error: "Browser relay disconnected before OpenClaw acknowledged the page share.",
      });
    });
    expect(pending.response).toHaveBeenCalledOnce();
  });

  it("immediately rejects a page share when the user unpairs the relay", async () => {
    const harness = await loadBackground({ deferSocketClose: true });
    const pending = await startPendingPageShare(harness);
    const unpairResponse = vi.fn();

    expect(harness.messageListener({ type: "unpair" }, {}, unpairResponse)).toBe(true);

    await vi.waitFor(() => {
      expect(unpairResponse).toHaveBeenCalledWith({ ok: true });
      expect(pending.response).toHaveBeenCalledWith({
        ok: false,
        error: "Browser relay disconnected before OpenClaw acknowledged the page share.",
      });
    });
    expect(pending.socket.close).toHaveBeenCalledOnce();
    expect(pending.socket.readyState).toBe(2);
    expect(pending.response).toHaveBeenCalledOnce();
  });

  it("rejects old page shares before a replacement relay finishes closing", async () => {
    const harness = await loadBackground({ deferSocketClose: true });
    const pending = await startPendingPageShare(harness);
    const pairResponse = vi.fn();

    expect(
      harness.messageListener(
        {
          type: "pair",
          pairingString: "ws://127.0.0.1:18798/extension#replacement-token-placeholder",
        },
        {},
        pairResponse,
      ),
    ).toBe(true);

    await vi.waitFor(() => {
      expect(pairResponse).toHaveBeenCalledWith({ ok: true });
      expect(pending.response).toHaveBeenCalledWith({
        ok: false,
        error: "Browser relay disconnected before OpenClaw acknowledged the page share.",
      });
    });
    expect(pending.socket.close).toHaveBeenCalledOnce();
    expect(pending.socket.readyState).toBe(2);
    expect(harness.sockets).toHaveLength(2);
    expect(pending.response).toHaveBeenCalledOnce();
  });

  it("preserves the acknowledgement from the page share's own relay", async () => {
    const harness = await loadBackground();
    const pending = await startPendingPageShare(harness);

    pending.socket.receive({ type: "pageShareResult", requestId: pending.requestId, ok: true });

    await vi.waitFor(() => {
      expect(pending.response).toHaveBeenCalledWith({ ok: true });
    });
    pending.socket.close();
    expect(pending.response).toHaveBeenCalledOnce();
  });

  it("preserves the delivery error returned by the page share's own relay", async () => {
    const harness = await loadBackground();
    const pending = await startPendingPageShare(harness);

    pending.socket.receive({
      type: "pageShareResult",
      requestId: pending.requestId,
      ok: false,
      error: "Gateway page-share queue unavailable.",
    });

    await vi.waitFor(() => {
      expect(pending.response).toHaveBeenCalledWith({
        ok: false,
        error: "Gateway page-share queue unavailable.",
      });
    });
    pending.socket.close();
    expect(pending.response).toHaveBeenCalledOnce();
  });

  it("does not let a stale socket reject a share on the reconnected relay", async () => {
    const harness = await loadBackground();
    const original = await startPendingPageShare(harness);

    original.socket.close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.sockets).toHaveLength(2);
    const replacement = await startPendingPageShare(harness);

    original.socket.receive({
      type: "pageShareResult",
      requestId: replacement.requestId,
      ok: false,
      error: "Stale relay response.",
    });
    original.socket.close();
    expect(replacement.response).not.toHaveBeenCalled();

    replacement.socket.receive({
      type: "pageShareResult",
      requestId: replacement.requestId,
      ok: true,
    });

    await vi.waitFor(() => {
      expect(original.response).toHaveBeenCalledWith({
        ok: false,
        error: "Browser relay disconnected before OpenClaw acknowledged the page share.",
      });
      expect(replacement.response).toHaveBeenCalledWith({ ok: true });
    });
    expect(original.response).toHaveBeenCalledOnce();
    expect(replacement.response).toHaveBeenCalledOnce();
  });
});
