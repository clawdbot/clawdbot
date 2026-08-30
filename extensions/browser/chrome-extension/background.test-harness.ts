import { expect, vi } from "vitest";
import {
  AUTH_INSTANCE_ID,
  AUTH_SERVER_NONCE,
  AUTH_SESSION_ID,
  configureFakeWebSockets,
  FakeWebSocket,
} from "./background.test-support.js";
import type { RuntimeMessageListener } from "./background.test-support.js";
import { computeRelayAuthProof } from "./modules/relay-auth-v2-crypto.js";
import type { BrowserTabSnapshot } from "./modules/tab-eligibility.js";
import { relayTestKey } from "./relay-key.test-support.js";

export const TEST_RELAY_KEY = relayTestKey(1);
export const REPLACEMENT_TEST_RELAY_KEY = relayTestKey(2);
const PAIRING_CONFIG_KEYS = ["relayUrl", "token", "pairingStatus"];
const RETIRED_CUSTODY_BLOCKED_KEY = "retiredCopilotCustodyBlockedV1";
const backgroundCleanups = new Set<() => Promise<void>>();

function waitForBackgroundState<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { interval: 1 });
}

export async function cleanupBackgroundHarnesses(): Promise<void> {
  await Promise.all([...backgroundCleanups].map(async (cleanup) => await cleanup()));
}

export type RetiredStorageFailureStage =
  | "marker_set"
  | "session_remove"
  | "retired_local_remove"
  | "marker_remove";

export async function loadBackground({
  deferTabAccessInitialization = false,
  deferRetiredStatePreparation = false,
  deferSocketClose = false,
  inheritedDebuggerTabIds = [],
  nativeMessage,
  rejectStorageRemove = false,
  retiredStorageFailureStage,
  relayNegotiatedProtocol,
  sessionConfig,
  storedConfig,
  initialTabs = [],
  emitTabEvents = false,
  fileAccessAllowed = false,
}: {
  deferTabAccessInitialization?: boolean;
  deferRetiredStatePreparation?: boolean;
  deferSocketClose?: boolean;
  inheritedDebuggerTabIds?: number[];
  nativeMessage?: (request: unknown) => Promise<unknown>;
  rejectStorageRemove?: boolean;
  retiredStorageFailureStage?: RetiredStorageFailureStage;
  relayNegotiatedProtocol?: string;
  sessionConfig?: Record<string, unknown>;
  storedConfig?: Record<string, unknown>;
  initialTabs?: Array<Record<string, unknown> & { id: number }>;
  emitTabEvents?: boolean;
  fileAccessAllowed?: boolean;
} = {}) {
  const sockets: FakeWebSocket[] = [];
  let alarmListener: ((alarm: { name: string }) => void) | undefined;
  let installedListener: (() => void) | undefined;
  let messageListener: RuntimeMessageListener | undefined;
  let startupListener: (() => void) | undefined;
  let debuggerDetachListener:
    | ((source: { tabId?: number }, reason: "target_closed" | "canceled_by_user") => void)
    | undefined;
  let debuggerEventListener:
    | ((source: { tabId?: number; sessionId?: string }, method: string, params?: unknown) => void)
    | undefined;
  let tabsRemovedListener: ((tabId: number) => void) | undefined;
  let tabsReplacedListener: ((addedTabId: number, removedTabId: number) => void) | undefined;
  let tabGroupUpdatedListener: ((group?: { id: number; title?: string }) => void) | undefined;
  let tabGroupRemovedListener: ((group?: { id: number; title?: string }) => void) | undefined;
  let tabsUpdatedListener:
    | ((tabId: number, changeInfo: Partial<BrowserTabSnapshot>, tab?: BrowserTabSnapshot) => void)
    | undefined;
  let nextStorageGet: Promise<void> | null = null;
  let nextStorageRemove: Promise<void> | null = null;
  let nextStorageSet: Promise<void> | null = null;
  let nextSessionStorageSet: Promise<void> | null = null;
  let currentRetiredStorageFailureStage = retiredStorageFailureStage;
  let releaseTabAccessInitialization = () => {};
  let releaseRetiredStatePreparation = () => {};
  const tabAccessInitialization = deferTabAccessInitialization
    ? new Promise<void>((resolve) => {
        releaseTabAccessInitialization = resolve;
      })
    : Promise.resolve();
  const retiredStatePreparation = deferRetiredStatePreparation
    ? new Promise<void>((resolve) => {
        releaseRetiredStatePreparation = resolve;
      })
    : Promise.resolve();
  const sharedTabIds = new Set<number>([1]);
  const storageValues: Record<string, unknown> = {
    ...(storedConfig ?? {
      relayUrl: "ws://127.0.0.1:18797/extension",
      token: TEST_RELAY_KEY,
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
  const storageGet = vi.fn(async (requestedKeys: string[] | string) => {
    const keys = Array.isArray(requestedKeys) ? requestedKeys : [requestedKeys];
    if (keys.includes("copilotSessionRegistryV1")) {
      await retiredStatePreparation;
    }
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
    if (
      currentRetiredStorageFailureStage === "marker_set" &&
      values[RETIRED_CUSTODY_BLOCKED_KEY] === true
    ) {
      throw new Error("Could not persist retired recovery block.");
    }
    Object.assign(storageValues, values);
  });
  const storageRemove = vi.fn(async (keys: string[]) => {
    const pending = nextStorageRemove;
    nextStorageRemove = null;
    await pending;
    if (
      rejectStorageRemove &&
      !keys.some((key) => key.startsWith("copilot") || key === RETIRED_CUSTODY_BLOCKED_KEY)
    ) {
      throw new Error("Could not clear invalid browser pairing.");
    }
    const retiredStage = keys.includes(RETIRED_CUSTODY_BLOCKED_KEY)
      ? "marker_remove"
      : keys.some((key) => key.startsWith("copilot"))
        ? "retired_local_remove"
        : null;
    if (retiredStage && currentRetiredStorageFailureStage === retiredStage) {
      throw new Error("Could not discard retired recovery state.");
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
  const sendNativeMessage = vi.fn(async (_host: string, request: unknown) => {
    if (nativeMessage) {
      return await nativeMessage(request);
    }
    throw new Error("Specified native messaging host not found.");
  });
  const debuggerGetTargetInfo = vi.fn(async (source: { tabId: number }) => ({
    targetInfo: { targetId: `tab-${source.tabId}` },
  }));
  const debuggerSendCommand = vi.fn(
    async (
      _source: { tabId: number; sessionId?: string },
      _method: string,
      _params?: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => ({}),
  );
  let runtimeLastError: { message?: string } | undefined;
  const chromeMock = {
    extension: { isAllowedFileSchemeAccess: vi.fn(async () => fileAccessAllowed) },
    action: { setBadgeText, setBadgeBackgroundColor },
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
      attach: vi.fn(async (_source: { tabId: number }, _version: string) => undefined),
      detach: vi.fn(async (_source: { tabId?: number; targetId?: string }) => undefined),
      getTargets: vi.fn(
        async (): Promise<Array<{ id?: string; tabId?: number; attached?: boolean }>> =>
          inheritedDebuggerTabIds.map((tabId) => ({ id: `tab-${tabId}`, tabId, attached: true })),
      ),
      sendCommand: (
        source: { tabId: number; sessionId?: string },
        method: string,
        params?: Record<string, unknown>,
      ) =>
        method === "Target.getTargetInfo"
          ? debuggerGetTargetInfo(source)
          : debuggerSendCommand(source, method, params),
    },
    runtime: {
      get lastError() {
        return runtimeLastError;
      },
      connectNative: vi.fn((host: string) => {
        let disconnected = false;
        let nativeMessageListener: ((response: unknown) => void) | undefined;
        let disconnectListener: (() => void) | undefined;
        const disconnect = () => {
          if (disconnected) {
            return;
          }
          disconnected = true;
          disconnectListener?.();
        };
        return {
          disconnect,
          onDisconnect: {
            addListener: (listener: () => void) => {
              disconnectListener = listener;
            },
          },
          onMessage: {
            addListener: (listener: (response: unknown) => void) => {
              nativeMessageListener = listener;
            },
          },
          postMessage: (request: unknown) => {
            void sendNativeMessage(host, request).then(
              (response) => {
                if (!disconnected) {
                  nativeMessageListener?.(response);
                }
              },
              (error: unknown) => {
                if (!disconnected) {
                  runtimeLastError = {
                    message: error instanceof Error ? error.message : String(error),
                  };
                  disconnect();
                  runtimeLastError = undefined;
                }
              },
            );
          },
        };
      }),
      getManifest: vi.fn(() => ({ version: "1.0.0" })),
      openOptionsPage: vi.fn(async () => undefined),
      onConnect: { addListener },
      onMessage: {
        addListener: vi.fn((listener: RuntimeMessageListener) => {
          messageListener = listener;
        }),
      },
      onStartup: {
        addListener: vi.fn((listener: () => void) => {
          startupListener = listener;
        }),
      },
      onInstalled: {
        addListener: vi.fn((listener: () => void) => {
          installedListener = listener;
        }),
      },
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
          if (
            currentRetiredStorageFailureStage === "session_remove" &&
            keys.some((key) => key.startsWith("copilot"))
          ) {
            throw new Error("Could not discard retired recovery state.");
          }
          for (const key of keys) {
            delete sessionStorageValues[key];
          }
        }),
      },
    },
    tabGroups: {
      query: vi.fn(async (): Promise<Array<{ id: number; windowId: number }>> => []),
      get: vi.fn(async (groupId: number) => ({
        id: groupId,
        title: groupId === 7 ? "OpenClaw" : "Other",
        windowId: 1,
      })),
      update: vi.fn(async (id: number, properties: { title: string; color?: string }) => {
        if (emitTabEvents) {
          tabGroupUpdatedListener?.({ id, ...properties });
        }
      }),
      onUpdated: {
        addListener: vi.fn((listener: typeof tabGroupUpdatedListener) => {
          tabGroupUpdatedListener = listener;
        }),
      },
      onRemoved: {
        addListener: vi.fn((listener: typeof tabGroupRemovedListener) => {
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
          if (emitTabEvents) {
            tabsUpdatedListener?.(
              tabId,
              { groupId: 7 },
              { ...tabsById.get(tabId), id: tabId, groupId: 7 },
            );
          }
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
        if (emitTabEvents) {
          tabsRemovedListener?.(tabId);
        }
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
        addListener: vi.fn((listener: typeof tabsUpdatedListener) => {
          tabsUpdatedListener = listener;
        }),
      },
    },
    windows: { update: vi.fn(async () => undefined) },
  };

  vi.stubGlobal("chrome", chromeMock);
  vi.stubGlobal("navigator", { userAgent: "Chromium/125.0.0.0" });
  vi.stubGlobal("WebSocket", FakeWebSocket);

  const backgroundModulePath = "./background.js";
  await import(backgroundModulePath);
  if (!deferRetiredStatePreparation) {
    await waitForBackgroundState(() => {
      const pairingReads = storageGet.mock.calls.filter(([keys]) =>
        PAIRING_CONFIG_KEYS.every((key) => keys.includes(key)),
      );
      expect(pairingReads.length).toBeGreaterThanOrEqual(1);
    });
  }
  if (!deferTabAccessInitialization && !deferRetiredStatePreparation) {
    await waitForBackgroundState(() => {
      const pairingWasCleared = storageRemove.mock.calls.some(([keys]) =>
        keys.includes("relayUrl"),
      );
      expect(
        sockets.length > 0 ||
          pairingWasCleared ||
          sendNativeMessage.mock.calls.length > 0 ||
          Object.hasOwn(storageValues, "copilotSessionRegistryV1") ||
          Object.hasOwn(storageValues, RETIRED_CUSTODY_BLOCKED_KEY) ||
          storageValues.nativeBootstrapDisabled === true,
      ).toBe(true);
    });
  }

  if (
    !alarmListener ||
    !installedListener ||
    !messageListener ||
    !startupListener ||
    !tabsUpdatedListener ||
    !tabsReplacedListener
  ) {
    throw new Error("expected background worker lifecycle listeners");
  }
  const lifecycleMessageListener = messageListener;
  const cleanup = async () => {
    backgroundCleanups.delete(cleanup);
    await new Promise<void>((resolve) => {
      lifecycleMessageListener({ type: "unpair" }, {}, () => resolve());
    });
  };
  backgroundCleanups.add(cleanup);
  return {
    alarmListener,
    clearAlarm,
    createAlarm,
    debuggerAttach: chromeMock.debugger.attach,
    debuggerDetach: chromeMock.debugger.detach,
    debuggerDetachListener,
    debuggerEventListener,
    debuggerGetTargets: chromeMock.debugger.getTargets,
    debuggerSendCommand,
    debuggerGetTargetInfo,
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
    installedListener,
    messageListener,
    sendNativeMessage,
    releaseTabAccessInitialization,
    releaseRetiredStatePreparation,
    get relaySockets() {
      return sockets.filter((socket) => socket.protocols.includes("openclaw-extension-relay.v2"));
    },
    authenticate: async (socket: FakeWebSocket) => {
      if (socket.readyState !== FakeWebSocket.OPEN) {
        socket.open();
      }
      await waitForBackgroundState(() => expect(socket.send).toHaveBeenCalled());
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
      await waitForBackgroundState(() => {
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
      await waitForBackgroundState(() => {
        expect(socket.send.mock.calls.some(([raw]) => JSON.parse(raw).type === "hello")).toBe(true);
      });
    },
    setBadgeText,
    sockets,
    storageRemove,
    storageSet,
    storageValues,
    setRetiredStorageFailureStage: (stage?: RetiredStorageFailureStage) => {
      currentRetiredStorageFailureStage = stage;
    },
    startupListener,
    sessionStorageValues,
    sessionStorageSet,
    shareTab: (tabId: number) => sharedTabIds.add(tabId),
    unshareTab: (tabId: number) => sharedTabIds.delete(tabId),
    tabGroupsQuery: chromeMock.tabGroups.query,
    tabGroupsGet: chromeMock.tabGroups.get,
    tabGroupsUpdate: chromeMock.tabGroups.update,
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
    updateTab: (tabId: number, change: Partial<BrowserTabSnapshot>, notify = true) => {
      const tab = { ...tabsById.get(tabId), ...change, id: tabId };
      tabsById.set(tabId, tab);
      if (typeof change.groupId === "number") {
        if (change.groupId === 7) {
          sharedTabIds.add(tabId);
        } else {
          sharedTabIds.delete(tabId);
        }
      }
      if (notify) {
        tabsUpdatedListener?.(tabId, change, { ...tab, groupId: sharedTabIds.has(tabId) ? 7 : -1 });
      }
    },
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

export async function loadRelayCommandHarness(accessMode: "all" | "selected") {
  const harness = await loadBackground({
    emitTabEvents: true,
    storedConfig: {
      relayUrl: "ws://127.0.0.1:18797/extension",
      token: TEST_RELAY_KEY,
      authVersion: 2,
      accessMode,
    },
    initialTabs: [{ id: 100, url: "about:blank", groupId: 7 }],
  });
  const socket = harness.relaySockets[0]!;
  await harness.authenticate(socket);
  let seq = 0;
  const frames = () => socket.send.mock.calls.map(([raw]) => JSON.parse(raw));
  const command = async (message: Record<string, unknown>) => {
    const id = ++seq;
    socket.receive({ ...message, seq: id });
    return await waitForBackgroundState(() => {
      const response = frames().find((frame) => frame.seq === id);
      expect(response).toBeDefined();
      return response;
    });
  };
  return { ...harness, socket, frames, command };
}
