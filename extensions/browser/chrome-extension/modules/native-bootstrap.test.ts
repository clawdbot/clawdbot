import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNativeBootstrapController,
  discardRetiredCopilotState,
  prepareRetiredCopilotState,
} from "./native-bootstrap.js";

const COPILOT_LOCAL_KEYS = [
  "copilotSessionRegistryV1",
  "copilotDeviceIdentitiesV1",
  "copilotDeviceTokensV1",
];
const COPILOT_SESSION_KEYS = ["copilotBrowserInstanceV1", "copilotPanelBindingsV1"];
const CUSTODY_BLOCKED_KEY = "retiredCopilotCustodyBlockedV1";
const RETAINED_LOCAL = {
  relayUrl: "ws://127.0.0.1:18789/extension",
  token: "test-relay-key",
  accessMode: "selected",
  deniedTabIdsV1: [7],
  nativeBootstrapDisabled: true,
};

type CleanupFailureStage =
  | "marker_set"
  | "session_remove"
  | "retired_local_remove"
  | "marker_remove";

function cleanupStorage(params: {
  registry?: unknown;
  registryPresent?: boolean;
  readError?: Error;
  failureStage?: CleanupFailureStage;
  marker?: boolean;
}) {
  let failureStage = params.failureStage;
  const operations: string[] = [];
  const localValues: Record<string, unknown> = {
    copilotDeviceIdentitiesV1: { device: "identity" },
    copilotDeviceTokensV1: { device: "token" },
    ...RETAINED_LOCAL,
  };
  if (params.registryPresent !== false) {
    localValues.copilotSessionRegistryV1 = params.registry;
  }
  if (params.marker === true) {
    localValues[CUSTODY_BLOCKED_KEY] = true;
  }
  const sessionValues: Record<string, unknown> = {
    copilotBrowserInstanceV1: "browser-instance",
    copilotPanelBindingsV1: { 7: "panel-binding" },
  };
  const localSet = vi.fn(async (values: Record<string, unknown>) => {
    operations.push("marker_set");
    if (failureStage === "marker_set") {
      throw new Error("marker set failed");
    }
    Object.assign(localValues, values);
  });
  const localRemove = vi.fn(async (keys: string[]) => {
    const stage = keys.includes(CUSTODY_BLOCKED_KEY) ? "marker_remove" : "retired_local_remove";
    operations.push(stage);
    if (failureStage === stage) {
      throw new Error(`${stage} failed`);
    }
    for (const key of keys) {
      delete localValues[key];
    }
  });
  const sessionRemove = vi.fn(async (keys: string[]) => {
    operations.push("session_remove");
    if (failureStage === "session_remove") {
      throw new Error("session remove failed");
    }
    for (const key of keys) {
      delete sessionValues[key];
    }
  });
  return {
    chromeApi: {
      storage: {
        local: {
          get: vi.fn(async (keys: string[]) => {
            if (params.readError) {
              throw params.readError;
            }
            return Object.fromEntries(
              keys
                .filter((key) => Object.hasOwn(localValues, key))
                .map((key) => [key, localValues[key]]),
            );
          }),
          set: localSet,
          remove: localRemove,
        },
        session: { remove: sessionRemove },
      },
    },
    localSet,
    localRemove,
    localValues,
    operations,
    setFailureStage: (next: CleanupFailureStage | undefined) => {
      failureStage = next;
    },
    sessionRemove,
    sessionValues,
  };
}

describe("retired copilot custody", () => {
  it.each([
    { label: "no registry", registryPresent: false, registry: undefined },
    {
      label: "an exact empty registry",
      registryPresent: true,
      registry: { sessions: {}, pendingArchives: [] },
    },
  ])("removes all retired keys for $label", async ({ registry, registryPresent }) => {
    const storage = cleanupStorage({ registry, registryPresent });

    await expect(prepareRetiredCopilotState(storage.chromeApi)).resolves.toEqual({
      blocked: false,
    });

    expect(storage.localSet).toHaveBeenCalledWith({ [CUSTODY_BLOCKED_KEY]: true });
    expect(storage.localRemove).toHaveBeenCalledTimes(2);
    expect(storage.localRemove).toHaveBeenNthCalledWith(1, COPILOT_LOCAL_KEYS);
    expect(storage.localRemove).toHaveBeenNthCalledWith(2, [CUSTODY_BLOCKED_KEY]);
    expect(storage.sessionRemove).toHaveBeenCalledOnce();
    expect(storage.sessionRemove).toHaveBeenCalledWith(COPILOT_SESSION_KEYS);
    expect(storage.localValues).toEqual(RETAINED_LOCAL);
    expect(storage.sessionValues).toEqual({});
    expect(storage.operations).toEqual([
      "marker_set",
      "session_remove",
      "retired_local_remove",
      "marker_remove",
    ]);
  });

  it.each([
    {
      label: "session creation is pending",
      registry: {
        sessions: {
          7: {
            tabId: 7,
            browserInstanceId: "browser-instance",
            gatewayScope: "ws://127.0.0.1:18789/",
            sessionKey: "browser:tab:7",
            creationPending: true,
          },
        },
        pendingArchives: [],
      },
    },
    {
      label: "a confirmed session remains",
      registry: {
        sessions: {
          7: {
            tabId: 7,
            browserInstanceId: "browser-instance",
            gatewayScope: "ws://127.0.0.1:18789/",
            sessionKey: "browser:tab:7",
            sessionId: "session-7",
          },
        },
        pendingArchives: [],
      },
    },
    {
      label: "an active session remains",
      registry: {
        sessions: {
          7: {
            tabId: 7,
            browserInstanceId: "browser-instance",
            sessionKey: "browser:tab:7",
            active: true,
          },
        },
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

    await expect(prepareRetiredCopilotState(storage.chromeApi)).resolves.toEqual({ blocked: true });

    expect(storage.localRemove).not.toHaveBeenCalled();
    expect(storage.sessionRemove).not.toHaveBeenCalled();
    expect(storage.localValues).toEqual(beforeLocal);
    expect(storage.sessionValues).toEqual(beforeSession);
    expect(storage.localValues).toMatchObject(RETAINED_LOCAL);
  });

  it("preserves every retired key when the registry read fails", async () => {
    const storage = cleanupStorage({ readError: new Error("storage unavailable") });
    const beforeLocal = structuredClone(storage.localValues);
    const beforeSession = structuredClone(storage.sessionValues);

    await expect(prepareRetiredCopilotState(storage.chromeApi)).resolves.toEqual({ blocked: true });

    expect(storage.localRemove).not.toHaveBeenCalled();
    expect(storage.sessionRemove).not.toHaveBeenCalled();
    expect(storage.localValues).toEqual(beforeLocal);
    expect(storage.sessionValues).toEqual(beforeSession);
    expect(storage.localValues).toMatchObject(RETAINED_LOCAL);
  });

  it("explicitly discards every retired key", async () => {
    const storage = cleanupStorage({
      registry: {
        sessions: { 7: { creationPending: true } },
        pendingArchives: [{ tabId: 7 }],
      },
    });

    await expect(discardRetiredCopilotState(storage.chromeApi)).resolves.toBeUndefined();

    expect(storage.localValues).toEqual(RETAINED_LOCAL);
    expect(storage.sessionValues).toEqual({});
    expect(storage.operations).toEqual([
      "marker_set",
      "session_remove",
      "retired_local_remove",
      "marker_remove",
    ]);
  });

  it("blocks when a prior destructive cleanup left its durable marker", async () => {
    const storage = cleanupStorage({ registryPresent: false, marker: true });

    await expect(prepareRetiredCopilotState(storage.chromeApi)).resolves.toEqual({ blocked: true });

    expect(storage.operations).toEqual([]);
    expect(storage.localValues[CUSTODY_BLOCKED_KEY]).toBe(true);
  });

  it.each<CleanupFailureStage>([
    "marker_set",
    "session_remove",
    "retired_local_remove",
    "marker_remove",
  ])("keeps cleanup restart-safe when %s fails and an explicit retry finishes", async (stage) => {
    const storage = cleanupStorage({
      registry: { sessions: { 7: { creationPending: true } }, pendingArchives: [] },
      failureStage: stage,
    });

    await expect(discardRetiredCopilotState(storage.chromeApi)).rejects.toThrow("failed");
    if (stage === "marker_set") {
      expect(storage.localValues).toHaveProperty("copilotSessionRegistryV1");
      expect(storage.localValues).not.toHaveProperty(CUSTODY_BLOCKED_KEY);
    } else {
      expect(storage.localValues[CUSTODY_BLOCKED_KEY]).toBe(true);
    }
    if (stage === "session_remove" || stage === "retired_local_remove") {
      expect(storage.localValues).toHaveProperty("copilotSessionRegistryV1");
    }
    if (stage === "marker_remove") {
      expect(storage.localValues).not.toHaveProperty("copilotSessionRegistryV1");
    }

    await expect(prepareRetiredCopilotState(storage.chromeApi)).resolves.toEqual({ blocked: true });
    storage.setFailureStage(undefined);
    await expect(discardRetiredCopilotState(storage.chromeApi)).resolves.toBeUndefined();
    expect(storage.localValues).toEqual(RETAINED_LOCAL);
    expect(storage.sessionValues).toEqual({});
  });

  it("keeps authority blocked when automatic empty-state cleanup fails", async () => {
    const storage = cleanupStorage({
      registry: { sessions: {}, pendingArchives: [] },
      failureStage: "retired_local_remove",
    });

    await expect(prepareRetiredCopilotState(storage.chromeApi)).resolves.toEqual({ blocked: true });

    expect(storage.localValues[CUSTODY_BLOCKED_KEY]).toBe(true);
    expect(storage.localValues).toHaveProperty("copilotSessionRegistryV1");
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
      getRandomValues: vi.fn((bytes: Uint8Array) => {
        bytes.set(Uint8Array.from({ length: 16 }, (_, index) => index * 17));
        return bytes;
      }),
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
