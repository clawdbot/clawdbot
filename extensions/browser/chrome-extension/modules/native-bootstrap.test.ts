import { afterEach, describe, expect, it, vi } from "vitest";
import { clearRetiredExtensionState, createNativeBootstrapController } from "./native-bootstrap.js";

const COPILOT_LOCAL_KEYS = [
  "copilotSessionRegistryV1",
  "copilotDeviceIdentitiesV1",
  "copilotDeviceTokensV1",
];
const COPILOT_SESSION_KEYS = ["copilotBrowserInstanceV1", "copilotPanelBindingsV1"];
const RETAINED_LOCAL = {
  relayUrl: "ws://127.0.0.1:18789/extension",
  token: "test-relay-key",
  accessMode: "selected",
  deniedTabIdsV1: [7],
  nativeBootstrapDisabled: true,
};

function cleanupStorage(params: { registry?: unknown; registryPresent?: boolean }) {
  const localValues: Record<string, unknown> = {
    copilotDeviceIdentitiesV1: { device: "identity" },
    copilotDeviceTokensV1: { device: "token" },
    ...RETAINED_LOCAL,
  };
  if (params.registryPresent !== false) {
    localValues.copilotSessionRegistryV1 = params.registry;
  }
  const sessionValues: Record<string, unknown> = {
    copilotBrowserInstanceV1: "browser-instance",
    copilotPanelBindingsV1: { 7: "panel-binding" },
  };
  const localRemove = vi.fn(async (keys: string[]) => {
    for (const key of keys) {
      delete localValues[key];
    }
  });
  const sessionRemove = vi.fn(async (keys: string[]) => {
    for (const key of keys) {
      delete sessionValues[key];
    }
  });
  return {
    chromeApi: {
      storage: {
        local: {
          get: vi.fn(async (keys: string[]) =>
            Object.fromEntries(
              keys
                .filter((key) => Object.hasOwn(localValues, key))
                .map((key) => [key, localValues[key]]),
            ),
          ),
          remove: localRemove,
        },
        session: { remove: sessionRemove },
      },
    },
    localRemove,
    localValues,
    sessionRemove,
    sessionValues,
  };
}

function inactiveSession() {
  return {
    tabId: 7,
    browserInstanceId: "browser-instance",
    gatewayScope: "ws://127.0.0.1:18789/",
    sessionKey: "browser:tab:7",
    binding: {
      kind: "tab",
      tabId: 7,
      target: "host",
      profile: "chrome",
      targetId: "target-7",
    },
    createdAt: 1,
    provisional: false,
    creationPending: false,
    abortPending: false,
  };
}

describe("retired copilot cleanup", () => {
  it.each([
    { label: "no registry", registryPresent: false, registry: undefined },
    {
      label: "a clean inactive registry",
      registryPresent: true,
      registry: { sessions: { 7: inactiveSession() }, pendingArchives: [] },
    },
  ])("removes all retired keys for $label", async ({ registry, registryPresent }) => {
    const storage = cleanupStorage({ registry, registryPresent });

    await clearRetiredExtensionState(storage.chromeApi);

    expect(storage.localRemove).toHaveBeenCalledOnce();
    expect(storage.localRemove).toHaveBeenCalledWith(COPILOT_LOCAL_KEYS);
    expect(storage.sessionRemove).toHaveBeenCalledOnce();
    expect(storage.sessionRemove).toHaveBeenCalledWith(COPILOT_SESSION_KEYS);
    expect(storage.localValues).toEqual(RETAINED_LOCAL);
    expect(storage.sessionValues).toEqual({});
  });

  it.each([
    {
      label: "an active run",
      registry: {
        sessions: { 7: { ...inactiveSession(), activeRunId: "run-7" } },
        pendingArchives: [],
      },
    },
    {
      label: "an abort pending session",
      registry: {
        sessions: { 7: { ...inactiveSession(), abortPending: true } },
        pendingArchives: [],
      },
    },
    {
      label: "a pending archive",
      registry: {
        sessions: {},
        pendingArchives: [
          {
            tabId: 7,
            gatewayScope: "ws://127.0.0.1:18789/",
            sessionKey: "browser:tab:7",
            queuedAt: 1,
          },
        ],
      },
    },
    { label: "a malformed registry", registry: { sessions: [], pendingArchives: [] } },
    {
      label: "an unrecognized registry",
      registry: { sessions: {}, pendingArchives: [], futureCustody: {} },
    },
  ])("preserves every retired key for $label", async ({ registry }) => {
    const storage = cleanupStorage({ registry });
    const beforeLocal = structuredClone(storage.localValues);
    const beforeSession = structuredClone(storage.sessionValues);

    await clearRetiredExtensionState(storage.chromeApi);

    expect(storage.localRemove).not.toHaveBeenCalled();
    expect(storage.sessionRemove).not.toHaveBeenCalled();
    expect(storage.localValues).toEqual(beforeLocal);
    expect(storage.sessionValues).toEqual(beforeSession);
    expect(storage.localValues).toMatchObject(RETAINED_LOCAL);
  });
});

describe("native bootstrap timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("bounds a stuck native call and leaves status retryable", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn(() => "00112233-4455-6677-8899-aabbccddeeff"),
    });
    const stored: Record<string, unknown> = {};
    let onDisconnect = () => {};
    const disconnect = vi.fn(() => onDisconnect());
    const chromeApi = {
      runtime: {
        connectNative: vi.fn(() => ({
          disconnect,
          onDisconnect: {
            addListener: (listener: () => void) => {
              onDisconnect = listener;
            },
          },
          onMessage: { addListener: vi.fn() },
          postMessage: vi.fn(),
        })),
      },
      storage: {
        local: {
          get: vi.fn(async (keys: string[]) =>
            Object.fromEntries(
              keys.filter((key) => Object.hasOwn(stored, key)).map((key) => [key, stored[key]]),
            ),
          ),
          set: vi.fn(async (values: Record<string, unknown>) => {
            Object.assign(stored, values);
          }),
          remove: vi.fn(async (keys: string[]) => {
            for (const key of keys) {
              delete stored[key];
            }
          }),
        },
      },
    };
    const controller = createNativeBootstrapController({
      chromeApi,
      getPairing: async () => null,
      applyPairing: vi.fn(),
    });

    const attempt = controller.attempt();
    await vi.advanceTimersByTimeAsync(0);
    expect(chromeApi.runtime.connectNative.mock.results[0]?.value.postMessage).toHaveBeenCalledWith(
      {
        v: 1,
        op: "bootstrap",
        nonce: "ABEiM0RVZneImaq7zN3u_w",
      },
    );
    await vi.advanceTimersByTimeAsync(29_999);
    expect(stored).toEqual({});
    await vi.advanceTimersByTimeAsync(1);

    await expect(attempt).resolves.toEqual({
      status: "retrying",
      code: "native_host_timeout",
    });
    await expect(controller.status()).resolves.toEqual({
      disabled: false,
      state: "retrying",
      failureCode: "native_host_timeout",
    });
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
