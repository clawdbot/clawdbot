import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const RELAY_WATCHDOG_ALARM = "openclaw-relay-watchdog";
const RELAY_OPENING_DEADLINE_ALARM = "openclaw-relay-opening-deadline";
const START_TIME_MS = Date.parse("2026-07-16T08:00:00.000Z");
const RELAY_SECRET = "a".repeat(64);
const REPLACEMENT_RELAY_SECRET = "b".repeat(64);
const PAIRING_CONFIG_KEYS = ["relayUrl", "gatewayUrl", "token", "groupColor"];

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

async function loadBackground({
  deferSocketClose = false,
  onConsentChanged,
  rejectStorageRemove = false,
  storedConfig,
}: {
  deferSocketClose?: boolean;
  onConsentChanged?: () => Promise<void>;
  rejectStorageRemove?: boolean;
  storedConfig?: Record<string, unknown>;
} = {}) {
  const sockets: FakeWebSocket[] = [];
  let alarmListener: ((alarm: { name: string }) => void) | undefined;
  let messageListener: RuntimeMessageListener | undefined;
  let tabsUpdatedListener: ((tabId: number, changeInfo: { groupId?: number }) => void) | undefined;
  let nextStorageRemove: Promise<void> | null = null;
  const sharedTabIds = new Set<number>([1]);
  const storageValues: Record<string, unknown> = {
    ...(storedConfig ?? {
      relayUrl: "ws://127.0.0.1:18797/extension",
      token: RELAY_SECRET,
      groupColor: "orange",
    }),
  };

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
      readonly protocols: string[] = [],
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
  const storageGet = vi.fn(async (keys: string[]) =>
    Object.fromEntries(
      keys
        .filter((key) => Object.hasOwn(storageValues, key))
        .map((key) => [key, storageValues[key]]),
    ),
  );
  const storageSet = vi.fn(async (values: Record<string, unknown>) => {
    Object.assign(storageValues, values);
  });
  const storageRemove = vi.fn(async (keys: string[]) => {
    const pending = nextStorageRemove;
    nextStorageRemove = null;
    await pending;
    if (rejectStorageRemove) {
      throw new Error("Could not clear invalid browser pairing.");
    }
    for (const key of keys) {
      delete storageValues[key];
    }
  });
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
        get: storageGet,
        set: storageSet,
        remove: storageRemove,
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
      query: vi.fn(async (): Promise<Array<{ id: number; windowId: number }>> => []),
      get: vi.fn(async (groupId: number) => ({
        id: groupId,
        title: groupId === 7 ? "OpenClaw" : "Other",
        windowId: 1,
      })),
      update: vi.fn(async () => undefined),
      onUpdated: { addListener },
      onRemoved: { addListener },
    },
    tabs: {
      query: vi.fn(async (): Promise<Array<{ id: number; windowId: number }>> => []),
      get: vi.fn(async (tabId: number) => ({
        id: tabId,
        windowId: 1,
        groupId: sharedTabIds.has(tabId) ? 7 : -1,
      })),
      group: vi.fn(async ({ tabIds }: { tabIds: number[] }) => {
        for (const tabId of tabIds) {
          sharedTabIds.add(tabId);
        }
        return 7;
      }),
      ungroup: vi.fn(async (tabIds: number[]) => {
        for (const tabId of tabIds) {
          sharedTabIds.delete(tabId);
        }
      }),
      create: vi.fn(async () => ({ id: 1 })),
      remove: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      onRemoved: { addListener },
      onUpdated: {
        addListener: vi.fn(
          (listener: (tabId: number, changeInfo: { groupId?: number }) => void) => {
            tabsUpdatedListener = listener;
          },
        ),
      },
    },
    windows: { update: vi.fn(async () => undefined) },
  };

  vi.stubGlobal("chrome", chromeMock);
  vi.stubGlobal("navigator", { userAgent: "Chromium/125.0.0.0" });
  vi.stubGlobal("WebSocket", FakeWebSocket);

  if (onConsentChanged) {
    const copilotModule = await import("./modules/copilot-background.js");
    const createCopilotController = copilotModule.createCopilotController;
    vi.spyOn(copilotModule, "createCopilotController").mockImplementation((options) => ({
      ...createCopilotController(options),
      onConsentChanged,
    }));
  }

  // The shipped MV3 worker is plain JS, so keep this a runtime-resolved import.
  const backgroundModulePath = "./background.js";
  await import(backgroundModulePath);
  await vi.waitFor(() => {
    const pairingReads = storageGet.mock.calls.filter(
      ([keys]) =>
        keys.length === PAIRING_CONFIG_KEYS.length &&
        PAIRING_CONFIG_KEYS.every((key) => keys.includes(key)),
    );
    expect(pairingReads.length).toBeGreaterThanOrEqual(2);
  });

  if (!alarmListener) {
    throw new Error("expected background worker to register an alarm listener");
  }
  if (!messageListener) {
    throw new Error("expected background worker to register a message listener");
  }
  if (!tabsUpdatedListener) {
    throw new Error("expected background worker to register a tabs update listener");
  }
  return {
    alarmListener,
    clearAlarm,
    createAlarm,
    executeScript: chromeMock.scripting.executeScript,
    debuggerAttach: chromeMock.debugger.attach,
    debuggerDetach: chromeMock.debugger.detach,
    debuggerSendCommand: chromeMock.debugger.sendCommand,
    deferNextStorageRemove: () => {
      let release = () => {};
      nextStorageRemove = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    get gatewaySockets() {
      return sockets.filter((socket) => !socket.protocols.includes("openclaw-extension-relay"));
    },
    messageListener,
    get relaySockets() {
      return sockets.filter((socket) => socket.protocols.includes("openclaw-extension-relay"));
    },
    setBadgeText,
    sockets,
    storageRemove,
    storageSet,
    storageValues,
    shareTab: (tabId: number) => sharedTabIds.add(tabId),
    unshareTab: (tabId: number) => sharedTabIds.delete(tabId),
    tabGroupsQuery: chromeMock.tabGroups.query,
    tabsCreate: chromeMock.tabs.create,
    tabsGet: chromeMock.tabs.get,
    tabsGroup: chromeMock.tabs.group,
    tabsQuery: chromeMock.tabs.query,
    tabsRemove: chromeMock.tabs.remove,
    tabsUngroup: chromeMock.tabs.ungroup,
    tabsUpdate: chromeMock.tabs.update,
    tabsUpdatedListener,
    windowsUpdate: chromeMock.windows.update,
  };
}

describe("persisted relay pairing validation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens the canonical persisted pairing on startup", async () => {
    const harness = await loadBackground({
      storedConfig: {
        relayUrl: "wss://gateway.example.com/base/browser/extension",
        token: RELAY_SECRET,
        gatewayUrl: "wss://gateway.example.com/base",
        groupColor: "blue",
      },
    });

    await vi.waitFor(() => {
      expect(harness.relaySockets).toHaveLength(1);
      expect(harness.gatewaySockets).toHaveLength(1);
    });
    expect(harness.relaySockets[0]).toMatchObject({
      url: "wss://gateway.example.com/base/browser/extension",
      protocols: ["openclaw-extension-relay", `openclaw-extension-token.${RELAY_SECRET}`],
    });
    expect(harness.storageRemove).not.toHaveBeenCalled();
  });

  it.each([
    ["an invalid token", { relayUrl: "ws://127.0.0.1:18797/extension", token: "short" }],
    [
      "an unsafe remote relay URL",
      { relayUrl: "ws://gateway.example.com/extension", token: RELAY_SECRET },
    ],
    [
      "URL credentials",
      { relayUrl: "wss://user:pass@gateway.example.com/extension", token: RELAY_SECRET },
    ],
    [
      "an unsafe remote Gateway URL",
      {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: RELAY_SECRET,
        gatewayUrl: "ws://gateway.example.com",
      },
    ],
    [
      "Gateway URL credentials",
      {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: RELAY_SECRET,
        gatewayUrl: "wss://user:pass@gateway.example.com",
      },
    ],
    [
      "a Gateway URL query",
      {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: RELAY_SECRET,
        gatewayUrl: "wss://gateway.example.com?token=nope",
      },
    ],
    [
      "a Gateway URL fragment",
      {
        relayUrl: "ws://127.0.0.1:18797/extension",
        token: RELAY_SECRET,
        gatewayUrl: "wss://gateway.example.com#fragment",
      },
    ],
    ["a malformed URL", { relayUrl: "not a URL", token: RELAY_SECRET }],
    [
      "an unknown query",
      { relayUrl: "ws://127.0.0.1:18797/extension?unknown=1", token: RELAY_SECRET },
    ],
    ["partial state", { relayUrl: "ws://127.0.0.1:18797/extension", groupColor: "orange" }],
    [
      "mismatched direct state",
      {
        relayUrl: "wss://gateway.example.com/base/browser/extension",
        token: RELAY_SECRET,
        gatewayUrl: "wss://other.example.com/base",
      },
    ],
  ])("clears %s before startup can open a socket", async (_label, storedConfig) => {
    const harness = await loadBackground({ storedConfig });

    expect(harness.relaySockets).toHaveLength(0);
    expect(harness.gatewaySockets).toHaveLength(0);
    expect(harness.storageRemove).toHaveBeenCalledWith(["relayUrl", "gatewayUrl", "token"]);
    const response = vi.fn();
    harness.messageListener({ type: "getStatus" }, {}, response);
    await vi.waitFor(() => {
      expect(response).toHaveBeenCalledWith({
        paired: false,
        state: "off",
        sharedTabCount: 0,
        relayUrl: "",
      });
    });
  });

  it("stays unpaired when clearing invalid persisted state fails", async () => {
    const harness = await loadBackground({
      rejectStorageRemove: true,
      storedConfig: { relayUrl: "ws://gateway.example.com/extension", token: RELAY_SECRET },
    });

    const response = vi.fn();
    harness.messageListener({ type: "getStatus" }, {}, response);

    await vi.waitFor(() => {
      expect(response).toHaveBeenCalledWith({
        paired: false,
        state: "off",
        sharedTabCount: 0,
        relayUrl: "",
      });
    });
    expect(harness.relaySockets).toHaveLength(0);
    expect(harness.gatewaySockets).toHaveLength(0);
    expect(harness.storageRemove).toHaveBeenCalled();
    expect(harness.storageValues).toMatchObject({ token: RELAY_SECRET });
  });

  it("revalidates persisted state before a reconnect", async () => {
    const harness = await loadBackground();
    const socket = harness.sockets[0];
    if (!socket) {
      throw new Error("expected initial relay socket");
    }
    harness.storageValues.token = "invalid-after-startup";

    socket.close();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.sockets).toHaveLength(1);
    expect(harness.storageRemove).toHaveBeenCalledWith(["relayUrl", "gatewayUrl", "token"]);
    expect(harness.setBadgeText).toHaveBeenLastCalledWith({ text: "" });
  });

  it("disconnects both live consumers when the watchdog observes invalid state", async () => {
    const harness = await loadBackground({
      storedConfig: {
        relayUrl: "wss://gateway.example.com/browser/extension",
        token: RELAY_SECRET,
        gatewayUrl: "wss://gateway.example.com",
      },
    });
    await vi.waitFor(() => {
      expect(harness.relaySockets).toHaveLength(1);
      expect(harness.gatewaySockets).toHaveLength(1);
    });
    harness.storageValues.token = "invalid-after-startup";

    harness.alarmListener({ name: RELAY_WATCHDOG_ALARM });

    await vi.waitFor(() => {
      expect(harness.relaySockets[0]?.close).toHaveBeenCalled();
      expect(harness.gatewaySockets[0]?.close).toHaveBeenCalled();
      expect(harness.setBadgeText).toHaveBeenLastCalledWith({ text: "" });
    });
    expect(harness.sockets).toHaveLength(2);
  });

  it("does not let stale invalid cleanup erase a concurrently saved pairing", async () => {
    const harness = await loadBackground();
    harness.storageValues.token = "invalid-after-startup";
    const releaseRemove = harness.deferNextStorageRemove();
    const statusResponse = vi.fn();
    harness.messageListener({ type: "getStatus" }, {}, statusResponse);
    await vi.waitFor(() => expect(harness.storageRemove).toHaveBeenCalled());
    const pairResponse = vi.fn();
    harness.messageListener(
      {
        type: "pair",
        pairingString: `ws://127.0.0.1:18798/extension#${REPLACEMENT_RELAY_SECRET}`,
      },
      {},
      pairResponse,
    );

    releaseRemove();

    await vi.waitFor(() => expect(pairResponse).toHaveBeenCalledWith({ ok: true }));
    expect(harness.storageValues).toMatchObject({
      relayUrl: "ws://127.0.0.1:18798/extension",
      token: REPLACEMENT_RELAY_SECRET,
      gatewayUrl: "",
    });
    const replacement = harness.relaySockets.find(
      (socket) => socket.url === "ws://127.0.0.1:18798/extension",
    );
    expect(replacement).toBeDefined();
    expect(replacement?.close).not.toHaveBeenCalled();
  });
});

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

describe("popup message failure responses", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("responds exactly once when a shared tab closes before it can be grouped", async () => {
    const harness = await loadBackground();
    harness.tabsGet.mockRejectedValueOnce(new Error("No tab with id: 44."));
    const sendResponse = vi.fn();

    expect(harness.messageListener({ type: "toggleShareTab", tabId: 44 }, {}, sendResponse)).toBe(
      true,
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledExactlyOnceWith({
        ok: false,
        error: "No tab with id: 44.",
      });
    });
    expect(harness.tabsGet).toHaveBeenCalledWith(44);
  });

  it.each([
    { action: "share", initiallyShared: false },
    { action: "unshare", initiallyShared: true },
  ])(
    "responds exactly once when $action consent reconciliation rejects",
    async ({ initiallyShared }) => {
      const error = "Could not reconcile browser tab consent.";
      const onConsentChanged = vi.fn(async () => {
        throw new Error(error);
      });
      const harness = await loadBackground({ onConsentChanged });
      if (initiallyShared) {
        harness.tabGroupsQuery.mockResolvedValueOnce([{ id: 7, windowId: 1 }]);
        harness.tabsQuery.mockResolvedValueOnce([{ id: 44, windowId: 1 }]);
      }
      const sendResponse = vi.fn();

      expect(harness.messageListener({ type: "toggleShareTab", tabId: 44 }, {}, sendResponse)).toBe(
        true,
      );

      await vi.waitFor(() => {
        expect(onConsentChanged).toHaveBeenCalledOnce();
      });
      if (initiallyShared) {
        expect(harness.tabsUngroup).toHaveBeenCalledWith([44]);
      } else {
        expect(harness.tabsGroup).toHaveBeenCalledWith({ tabIds: [44] });
      }
      expect(sendResponse).toHaveBeenCalledExactlyOnceWith({ ok: false, error });
      expect(sendResponse).not.toHaveBeenCalledWith({ ok: true, shared: !initiallyShared });
    },
  );

  it.each([
    {
      message: {
        type: "pair" as const,
        pairingString: `ws://127.0.0.1:18798/extension#${REPLACEMENT_RELAY_SECRET}`,
      },
      operation: "set" as const,
      error: "Could not save browser pairing.",
    },
    {
      message: { type: "unpair" as const },
      operation: "remove" as const,
      error: "Could not remove browser pairing.",
    },
  ])(
    "responds exactly once when $message.type storage rejects",
    async ({ message, operation, error }) => {
      const harness = await loadBackground();
      const storageOperation = operation === "set" ? harness.storageSet : harness.storageRemove;
      storageOperation.mockRejectedValueOnce(new Error(error));
      const sendResponse = vi.fn();

      expect(harness.messageListener(message, {}, sendResponse)).toBe(true);

      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledExactlyOnceWith({ ok: false, error });
      });
    },
  );
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
          pairingString: `ws://127.0.0.1:18798/extension#${REPLACEMENT_RELAY_SECRET}`,
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

describe("relay command authorization", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects every authority-bearing command after tab-group revocation", async () => {
    const harness = await loadBackground();
    const socket = harness.sockets[0];
    if (!socket) {
      throw new Error("expected relay socket");
    }
    socket.open();
    harness.shareTab(41);
    harness.unshareTab(41);

    socket.receive({ type: "attach", seq: 1, tabId: 41 });
    socket.receive({ type: "cdp", seq: 2, tabId: 41, method: "Runtime.evaluate" });
    socket.receive({ type: "closeTab", seq: 3, tabId: 41 });
    socket.receive({ type: "activateTab", seq: 4, tabId: 41 });

    await vi.waitFor(() => {
      const frames = socket.send.mock.calls.map(([raw]) => JSON.parse(raw));
      expect(
        frames
          .filter((frame) => frame.type === "error")
          .map((frame) => frame.seq)
          .toSorted((left, right) => left - right),
      ).toEqual([1, 2, 3, 4]);
    });
    expect(harness.debuggerAttach).not.toHaveBeenCalled();
    expect(harness.debuggerSendCommand).not.toHaveBeenCalled();
    expect(harness.tabsRemove).not.toHaveBeenCalled();
    expect(harness.tabsUpdate).not.toHaveBeenCalled();
    expect(harness.windowsUpdate).not.toHaveBeenCalled();
  });

  it("keeps detach available as the revocation cleanup command", async () => {
    const harness = await loadBackground();
    const socket = harness.sockets[0];
    if (!socket) {
      throw new Error("expected relay socket");
    }
    socket.open();
    harness.unshareTab(41);

    socket.receive({ type: "detach", seq: 5, tabId: 41 });

    await vi.waitFor(() => {
      expect(harness.debuggerDetach).toHaveBeenCalledWith({ tabId: 41 });
      const frames = socket.send.mock.calls.map(([raw]) => JSON.parse(raw));
      expect(frames).toContainEqual({ type: "result", seq: 5, result: {} });
    });
  });

  it("allows createTab and groups the new tab before reporting success", async () => {
    const harness = await loadBackground();
    const socket = harness.sockets[0];
    if (!socket) {
      throw new Error("expected relay socket");
    }
    socket.open();
    harness.tabsCreate.mockResolvedValueOnce({ id: 42 });

    socket.receive({ type: "createTab", seq: 6, url: "https://example.com" });

    await vi.waitFor(() => {
      expect(harness.tabsGroup).toHaveBeenCalledWith({ tabIds: [42] });
      const frames = socket.send.mock.calls.map(([raw]) => JSON.parse(raw));
      expect(frames).toContainEqual({ type: "result", seq: 6, result: { tabId: 42 } });
    });
  });

  it("invalidates an attach that was in flight when the tab left the group", async () => {
    const harness = await loadBackground();
    const socket = harness.sockets[0];
    if (!socket) {
      throw new Error("expected relay socket");
    }
    socket.open();
    harness.shareTab(43);
    let releaseAttach = () => {};
    harness.debuggerAttach.mockImplementationOnce(
      async () =>
        await new Promise<undefined>((resolve) => {
          releaseAttach = () => resolve(undefined);
        }),
    );

    socket.receive({ type: "attach", seq: 7, tabId: 43 });
    await vi.waitFor(() => expect(harness.debuggerAttach).toHaveBeenCalledOnce());
    harness.unshareTab(43);
    harness.tabsUpdatedListener(43, { groupId: -1 });
    await Promise.resolve();
    releaseAttach();

    await vi.waitFor(() => {
      expect(harness.debuggerDetach).toHaveBeenCalledWith({ tabId: 43 });
      const frames = socket.send.mock.calls.map(([raw]) => JSON.parse(raw));
      expect(frames).toContainEqual({
        type: "error",
        seq: 7,
        message: "tab 43 access was revoked",
      });
    });
  });
});
