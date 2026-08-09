import { expect, vi } from "vitest";
import {
  AUTH_INSTANCE_ID,
  AUTH_SERVER_NONCE,
  AUTH_SESSION_ID,
  configureFakeWebSockets,
  FakeWebSocket,
} from "./background.test-support.js";
import type { PageCaptureResult, RuntimeMessageListener } from "./background.test-support.js";
import { computeRelayAuthProof } from "./modules/relay-auth-v2-crypto.js";

export const RELAY_SECRET = "a".repeat(64);
export const REPLACEMENT_RELAY_SECRET = "b".repeat(64);
const PAIRING_CONFIG_KEYS = ["relayUrl", "token", "pairingStatus"];

export async function loadBackground({
  deferTabAccessInitialization = false,
  deferSocketClose = false,
  onConsentChanged,
  rejectStorageRemove = false,
  relayNegotiatedProtocol,
  sessionConfig,
  storedConfig,
  initialTabs = [],
}: {
  deferTabAccessInitialization?: boolean;
  deferSocketClose?: boolean;
  onConsentChanged?: () => Promise<void>;
  rejectStorageRemove?: boolean;
  relayNegotiatedProtocol?: string;
  sessionConfig?: Record<string, unknown>;
  storedConfig?: Record<string, unknown>;
  initialTabs?: Array<Record<string, unknown> & { id: number }>;
} = {}) {
  const sockets: FakeWebSocket[] = [];
  let alarmListener: ((alarm: { name: string }) => void) | undefined;
  let messageListener: RuntimeMessageListener | undefined;
  let debuggerDetachListener:
    | ((source: { tabId?: number }, reason: "target_closed" | "canceled_by_user") => void)
    | undefined;
  let debuggerEventListener:
    | ((source: { tabId?: number; sessionId?: string }, method: string, params?: unknown) => void)
    | undefined;
  let tabsRemovedListener: ((tabId: number) => void) | undefined;
  let tabsReplacedListener: ((addedTabId: number, removedTabId: number) => void) | undefined;
  let tabGroupUpdatedListener: (() => void) | undefined;
  let tabGroupRemovedListener: (() => void) | undefined;
  let tabsUpdatedListener: ((tabId: number, changeInfo: { groupId?: number }) => void) | undefined;
  let nextStorageGet: Promise<void> | null = null;
  let nextStorageRemove: Promise<void> | null = null;
  let nextStorageSet: Promise<void> | null = null;
  let nextSessionStorageSet: Promise<void> | null = null;
  let releaseTabAccessInitialization = () => {};
  const tabAccessInitialization = deferTabAccessInitialization
    ? new Promise<void>((resolve) => {
        releaseTabAccessInitialization = resolve;
      })
    : Promise.resolve();
  const sharedTabIds = new Set<number>([1]);
  const storageValues: Record<string, unknown> = {
    ...(storedConfig ?? {
      relayUrl: "ws://127.0.0.1:18797/extension",
      token: RELAY_SECRET,
      authVersion: 2,
      accessMode: "selected",
      groupColor: "orange",
    }),
  };
  const sessionStorageValues: Record<string, unknown> = { ...sessionConfig };
  const tabsById = new Map(initialTabs.map((tab) => [tab.id, tab]));
  for (const tab of initialTabs) {
    if (tab.groupId === 7) {
      sharedTabIds.add(tab.id);
    }
  }
  configureFakeWebSockets({ sockets, deferSocketClose, relayNegotiatedProtocol });

  const addListener = vi.fn();
  const createAlarm = vi.fn();
  const clearAlarm = vi.fn(async () => true);
  const setBadgeText = vi.fn(async () => undefined);
  const setBadgeBackgroundColor = vi.fn(async () => undefined);
  const storageGet = vi.fn(async (keys: string[]) => {
    const pending = nextStorageGet;
    nextStorageGet = null;
    await pending;
    return Object.fromEntries(
      keys
        .filter((key) => Object.hasOwn(storageValues, key))
        .map((key) => [key, storageValues[key]]),
    );
  });
  const storageSet = vi.fn(async (values: Record<string, unknown>) => {
    const pending = nextStorageSet;
    nextStorageSet = null;
    await pending;
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
  const sessionStorageSet = vi.fn(async (values: Record<string, unknown>) => {
    const pending = nextSessionStorageSet;
    nextSessionStorageSet = null;
    await pending;
    Object.assign(sessionStorageValues, values);
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
      onEvent: {
        addListener: vi.fn(
          (
            listener: (
              source: { tabId?: number; sessionId?: string },
              method: string,
              params?: unknown,
            ) => void,
          ) => {
            debuggerEventListener = listener;
          },
        ),
      },
      onDetach: {
        addListener: vi.fn(
          (
            listener: (
              source: { tabId?: number },
              reason: "target_closed" | "canceled_by_user",
            ) => void,
          ) => {
            debuggerDetachListener = listener;
          },
        ),
      },
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async (_source: { tabId: number }) => undefined),
      getTargets: vi.fn(
        async (): Promise<Array<{ id?: string; tabId?: number; attached?: boolean }>> => [],
      ),
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
      local: { get: storageGet, set: storageSet, remove: storageRemove },
      session: {
        get: vi.fn(async (keys: string[]) => {
          await tabAccessInitialization;
          return Object.fromEntries(
            keys
              .filter((key) => Object.hasOwn(sessionStorageValues, key))
              .map((key) => [key, sessionStorageValues[key]]),
          );
        }),
        set: sessionStorageSet,
        remove: vi.fn(async (keys: string[]) => {
          for (const key of keys) {
            delete sessionStorageValues[key];
          }
        }),
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
      onUpdated: {
        addListener: vi.fn((listener: () => void) => {
          tabGroupUpdatedListener = listener;
        }),
      },
      onRemoved: {
        addListener: vi.fn((listener: () => void) => {
          tabGroupRemovedListener = listener;
        }),
      },
    },
    tabs: {
      query: vi.fn(async () =>
        [...tabsById.values()].map((tab) =>
          Object.assign({}, tab, { groupId: sharedTabIds.has(tab.id) ? 7 : -1 }),
        ),
      ),
      get: vi.fn(async (tabId: number) => ({
        id: tabId,
        url: `https://example.com/tab/${tabId}`,
        title: `Tab ${tabId}`,
        incognito: false,
        windowId: 1,
        ...tabsById.get(tabId),
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
      create: vi.fn(async ({ url, active }: { url: string; active: boolean }) => {
        const id = Math.max(0, ...tabsById.keys()) + 1;
        const tab = { id, url, active, windowId: 1, groupId: -1, incognito: false };
        tabsById.set(id, tab);
        return tab;
      }),
      remove: vi.fn(async (tabId: number) => {
        tabsById.delete(tabId);
      }),
      update: vi.fn(async () => undefined),
      onRemoved: {
        addListener: vi.fn((listener: (tabId: number) => void) => {
          tabsRemovedListener = listener;
        }),
      },
      onReplaced: {
        addListener: vi.fn((listener: (addedTabId: number, removedTabId: number) => void) => {
          tabsReplacedListener = listener;
        }),
      },
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

  const backgroundModulePath = "./background.js";
  await import(backgroundModulePath);
  await vi.waitFor(() => {
    const pairingReads = storageGet.mock.calls.filter(([keys]) =>
      PAIRING_CONFIG_KEYS.every((key) => keys.includes(key)),
    );
    expect(pairingReads.length).toBeGreaterThanOrEqual(2);
  });
  if (!deferTabAccessInitialization) {
    for (let attempt = 0; attempt < 20 && sockets.length === 0; attempt += 1) {
      const pairingWasCleared = storageRemove.mock.calls.some(([keys]) =>
        keys.includes("relayUrl"),
      );
      if (pairingWasCleared) {
        break;
      }
      await Promise.resolve();
    }
    const pairingWasCleared = storageRemove.mock.calls.some(([keys]) => keys.includes("relayUrl"));
    expect(sockets.length > 0 || pairingWasCleared).toBe(true);
  }

  if (!alarmListener || !messageListener || !tabsUpdatedListener || !tabsReplacedListener) {
    throw new Error("expected background worker lifecycle listeners");
  }
  return {
    alarmListener,
    clearAlarm,
    createAlarm,
    executeScript: chromeMock.scripting.executeScript,
    debuggerAttach: chromeMock.debugger.attach,
    debuggerDetach: chromeMock.debugger.detach,
    debuggerDetachListener,
    debuggerEventListener,
    debuggerGetTargets: chromeMock.debugger.getTargets,
    debuggerSendCommand: chromeMock.debugger.sendCommand,
    deferNextStorageGet: () => {
      let release = () => {};
      nextStorageGet = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    deferNextStorageRemove: () => {
      let release = () => {};
      nextStorageRemove = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    deferNextSessionStorageSet: () => {
      let release = () => {};
      nextSessionStorageSet = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    deferNextStorageSet: () => {
      let release = () => {};
      nextStorageSet = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    get gatewaySockets() {
      return sockets.filter((socket) => !socket.protocols.includes("openclaw-extension-relay.v2"));
    },
    messageListener,
    releaseTabAccessInitialization,
    get relaySockets() {
      return sockets.filter((socket) => socket.protocols.includes("openclaw-extension-relay.v2"));
    },
    authenticate: async (socket: FakeWebSocket) => {
      if (socket.readyState !== FakeWebSocket.OPEN) {
        socket.open();
      }
      await vi.waitFor(() => expect(socket.send).toHaveBeenCalled());
      const helloRaw = socket.send.mock.calls.find(
        ([raw]) => JSON.parse(raw).type === "auth.hello",
      )?.[0];
      if (typeof helloRaw !== "string") {
        throw new Error("expected auth.hello");
      }
      const hello = JSON.parse(helloRaw) as { keyId: string; clientNonce: string };
      const issuedAtMs = Date.now();
      const fields = {
        keyId: hello.keyId,
        instanceId: AUTH_INSTANCE_ID,
        sessionId: AUTH_SESSION_ID,
        clientNonce: hello.clientNonce,
        serverNonce: AUTH_SERVER_NONCE,
        issuedAtMs,
        expiresAtMs: issuedAtMs + 10_000,
        role: "extension",
        transport: "websocket",
        method: "GET",
        resource: new URL(socket.url).pathname + new URL(socket.url).search,
        flow: "extension",
      };
      socket.receive({
        type: "auth.challenge",
        v: 2,
        ...fields,
        serverProof: await computeRelayAuthProof(String(storageValues.token), "server", fields),
      });
      await vi.waitFor(() => {
        expect(
          socket.send.mock.calls.some(([raw]) => JSON.parse(raw).type === "auth.response"),
        ).toBe(true);
      });
      const responseRaw = socket.send.mock.calls.find(
        ([raw]) => JSON.parse(raw).type === "auth.response",
      )?.[0];
      if (typeof responseRaw !== "string") {
        throw new Error("expected auth.response");
      }
      const response = JSON.parse(responseRaw) as { clientProof: string };
      socket.receive({
        type: "auth.ok",
        v: 2,
        sessionId: AUTH_SESSION_ID,
        acceptProof: await computeRelayAuthProof(
          String(storageValues.token),
          "accept",
          fields,
          response.clientProof,
        ),
      });
      await vi.waitFor(() => {
        expect(socket.send.mock.calls.some(([raw]) => JSON.parse(raw).type === "hello")).toBe(true);
      });
    },
    setBadgeText,
    sockets,
    storageRemove,
    storageSet,
    storageValues,
    sessionStorageValues,
    sessionStorageSet,
    shareTab: (tabId: number) => sharedTabIds.add(tabId),
    unshareTab: (tabId: number) => sharedTabIds.delete(tabId),
    tabGroupsQuery: chromeMock.tabGroups.query,
    tabGroupUpdatedListener,
    tabGroupRemovedListener,
    tabsCreate: chromeMock.tabs.create,
    tabsGet: chromeMock.tabs.get,
    tabsGroup: chromeMock.tabs.group,
    tabsQuery: chromeMock.tabs.query,
    tabsRemove: chromeMock.tabs.remove,
    tabsUngroup: chromeMock.tabs.ungroup,
    tabsUpdate: chromeMock.tabs.update,
    tabsUpdatedListener,
    tabsRemovedListener,
    tabsReplacedListener,
    windowsUpdate: chromeMock.windows.update,
  };
}

export async function sendRuntimeMessage(
  harness: Awaited<ReturnType<typeof loadBackground>>,
  message: { type: string } & Record<string, unknown>,
) {
  return await new Promise<Record<string, unknown>>((resolve) => {
    harness.messageListener(message, {}, (response) => {
      resolve(response as Record<string, unknown>);
    });
  });
}
