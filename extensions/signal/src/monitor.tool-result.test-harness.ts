// Signal plugin module implements monitor.tool result harness behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { MockFn } from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, vi } from "vitest";
import type { SignalDaemonHandle } from "./daemon.js";
import { setSignalRuntime } from "./runtime.js";
import { clearSignalRuntimeForTest } from "./runtime.test-support.js";

type SignalDaemonExitEvent = Awaited<SignalDaemonHandle["exited"]>;

type SignalToolResultTestMocks = {
  waitForTransportReadyMock: MockFn;
  enqueueSystemEventMock: MockFn;
  sendMock: MockFn;
  replyMock: MockFn;
  updateLastRouteMock: MockFn;
  readAllowFromStoreMock: MockFn;
  upsertPairingRequestMock: MockFn;
  streamMock: MockFn;
  signalCheckMock: MockFn;
  signalRpcRequestMock: MockFn;
  spawnSignalDaemonMock: MockFn;
};

const waitForTransportReadyMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const enqueueSystemEventMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const sendMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const replyMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const updateLastRouteMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const readAllowFromStoreMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const upsertPairingRequestMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const streamMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const signalCheckMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const signalRpcRequestMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const spawnSignalDaemonMock = vi.hoisted(() => vi.fn()) as unknown as MockFn;
const signalToolResultSessionStore = vi.hoisted(() => ({ path: "" }));
let signalToolResultStateDir: string | undefined;
let signalToolResultIngressQueue: ReturnType<typeof createChannelIngressQueueForTests> | undefined;

export function toSignalToolResultTestError(value: unknown, fallbackMessage: string): Error {
  return value instanceof Error ? value : new Error(fallbackMessage, { cause: value });
}

export async function waitForSignalToolResultIngressIdle() {
  const queue = signalToolResultIngressQueue;
  if (!queue) {
    throw new Error("Signal tool-result ingress queue is not initialized");
  }
  await vi.waitFor(
    async () => {
      // Pending must be read before claims so a pending→claimed transition cannot
      // disappear between two concurrent snapshots and produce a false idle.
      const pending = await queue.listPending({ limit: "all" });
      const claims = await queue.listClaims();
      if (pending.length > 0 || claims.length > 0) {
        throw new Error(
          `Signal tool-result ingress still active: ${pending.length} pending, ${claims.length} claimed, ${replyMock.mock.calls.length} replies, ${sendMock.mock.calls.length} sends`,
        );
      }
    },
    { interval: 10, timeout: 5_000 },
  );
}

export function getSignalToolResultTestMocks(): SignalToolResultTestMocks {
  return {
    waitForTransportReadyMock,
    enqueueSystemEventMock,
    sendMock,
    replyMock,
    updateLastRouteMock,
    readAllowFromStoreMock,
    upsertPairingRequestMock,
    streamMock,
    signalCheckMock,
    signalRpcRequestMock,
    spawnSignalDaemonMock,
  };
}

export let config: Record<string, unknown> = {};

export function setSignalToolResultTestConfig(next: Record<string, unknown>) {
  config = next;
}

export function createSignalToolResultConfig(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const base = config as { channels?: Record<string, unknown> };
  const channels = base.channels ?? {};
  const signal = (channels.signal ?? {}) as Record<string, unknown>;
  const {
    autoStart,
    cliPath,
    configPath,
    httpHost,
    httpPort,
    startupTimeoutMs,
    receiveMode,
    ignoreAttachments,
    ignoreStories,
    ...accountOverrides
  } = overrides;
  const transport =
    autoStart === false
      ? { kind: "external-native", url: "http://127.0.0.1:8080" }
      : {
          kind: "managed-native",
          ...(typeof cliPath === "string" ? { cliPath } : {}),
          ...(typeof configPath === "string" ? { configPath } : {}),
          ...(typeof httpHost === "string" ? { httpHost } : {}),
          ...(typeof httpPort === "number" ? { httpPort } : {}),
          ...(typeof startupTimeoutMs === "number" ? { startupTimeoutMs } : {}),
          ...(receiveMode === "on-start" || receiveMode === "manual" ? { receiveMode } : {}),
          ...(typeof ignoreStories === "boolean" ? { ignoreStories } : {}),
        };
  return {
    ...base,
    channels: {
      ...channels,
      signal: {
        ...signal,
        transport,
        ...(typeof ignoreAttachments === "boolean" ? { ignoreAttachments } : {}),
        dmPolicy: "open",
        allowFrom: ["*"],
        ...accountOverrides,
      },
    },
  };
}

export function createMockSignalDaemonHandle(
  overrides: {
    stop?: MockFn;
    exited?: Promise<SignalDaemonExitEvent>;
    isExited?: () => boolean;
  } = {},
): SignalDaemonHandle {
  const stop = overrides.stop ?? (vi.fn() as unknown as MockFn);
  const exited = overrides.exited ?? new Promise<SignalDaemonExitEvent>(() => {});
  const isExited = overrides.isExited ?? (() => false);
  return {
    stop: stop as unknown as () => Promise<void>,
    exited,
    isExited,
  };
}

// Use importActual so shared-worker mocks from earlier test files do not leak
// into this harness's partial overrides.
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/runtime-config-snapshot")
  >("openclaw/plugin-sdk/runtime-config-snapshot");
  return {
    ...actual,
    getRuntimeConfig: () => config,
  };
});

vi.mock("openclaw/plugin-sdk/session-store-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
    "openclaw/plugin-sdk/session-store-runtime",
  );
  return {
    ...actual,
    resolveStorePath: vi.fn(() => signalToolResultSessionStore.path),
    updateLastRoute: (...args: unknown[]) => updateLastRouteMock(...args),
    readSessionUpdatedAt: vi.fn(() => undefined),
    recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  return {
    ...actual,
    runChannelInboundEvent: async (params: Parameters<typeof actual.runChannelInboundEvent>[0]) => {
      const resolveTurn = params.adapter.resolveTurn;
      return await actual.runChannelInboundEvent({
        ...params,
        adapter: {
          ...params.adapter,
          resolveTurn: async (...args: Parameters<typeof resolveTurn>) => {
            const resolved = await resolveTurn(...args);
            if ("runDispatch" in resolved) {
              return resolved;
            }
            return {
              ...resolved,
              replyResolver: async (...replyArgs: unknown[]) => {
                await resolved.replyOptions?.turnAdoptionLifecycle?.onAdopted();
                return await replyMock(...replyArgs);
              },
            } as typeof resolved;
          },
        },
      });
    },
  };
});

vi.mock("./send.js", async () => {
  const actual = await vi.importActual<typeof import("./send.js")>("./send.js");
  return {
    ...actual,
    sendMessageSignal: (...args: unknown[]) => sendMock(...args),
    sendTypingSignal: vi.fn().mockResolvedValue(true),
    sendReadReceiptSignal: vi.fn().mockResolvedValue(true),
  };
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/conversation-runtime")>(
    "openclaw/plugin-sdk/conversation-runtime",
  );
  return {
    ...actual,
    readChannelAllowFromStore: (...args: unknown[]) => readAllowFromStoreMock(...args),
    upsertChannelPairingRequest: (...args: unknown[]) => upsertPairingRequestMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/security-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/security-runtime")>(
    "openclaw/plugin-sdk/security-runtime",
  );
  return {
    ...actual,
    readStoreAllowFromForDmPolicy: (...args: unknown[]) => readAllowFromStoreMock(...args),
  };
});

vi.mock("./client.js", () => ({
  streamSignalEvents: (...args: unknown[]) => streamMock(...args),
  signalCheck: (...args: unknown[]) => signalCheckMock(...args),
  signalRpcRequest: (...args: unknown[]) => signalRpcRequestMock(...args),
}));

vi.mock("./client-adapter.js", () => ({
  streamSignalEvents: (...args: unknown[]) => streamMock(...args),
  signalCheck: (...args: unknown[]) => signalCheckMock(...args),
  signalRpcRequest: (...args: unknown[]) => signalRpcRequestMock(...args),
}));

vi.mock("./daemon.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./daemon.js")>();
  return {
    ...actual,
    spawnSignalDaemon: (...args: unknown[]) => spawnSignalDaemonMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/system-event-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/system-event-runtime")>(
    "openclaw/plugin-sdk/system-event-runtime",
  );
  return {
    ...actual,
    enqueueSystemEvent: (...args: Parameters<typeof actual.enqueueSystemEvent>) => {
      enqueueSystemEventMock(...args);
      return actual.enqueueSystemEvent(...args);
    },
  };
});

vi.mock("openclaw/plugin-sdk/transport-ready-runtime", () => ({
  waitForTransportReady: (...args: unknown[]) => waitForTransportReadyMock(...args),
}));

export function installSignalToolResultTestHooks() {
  beforeEach(async () => {
    const [{ resetInboundDedupe }, { resetSystemEventsForTest }] = await Promise.all([
      import("openclaw/plugin-sdk/reply-runtime"),
      import("openclaw/plugin-sdk/system-event-runtime"),
    ]);
    resetInboundDedupe();
    const createdStateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-signal-tool-result-state-"),
    );
    const stateDir = await fs.realpath(createdStateDir);
    signalToolResultStateDir = stateDir;
    signalToolResultSessionStore.path = path.join(stateDir, "sessions.json");
    signalToolResultIngressQueue = undefined;
    setSignalRuntime({
      logging: {
        getChildLogger: () => ({
          debug: vi.fn(),
          error: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
        }),
      },
      state: {
        resolveStateDir: () => stateDir,
        openKeyedStore: () => {
          throw new Error("keyed store is not configured in Signal monitor tests");
        },
        openChannelIngressQueue: (
          options?: Omit<Parameters<typeof createChannelIngressQueueForTests>[0], "channelId">,
        ) => {
          const queue = createChannelIngressQueueForTests({
            ...options,
            channelId: "signal",
            stateDir: options?.stateDir ?? stateDir,
          });
          signalToolResultIngressQueue = queue;
          return queue;
        },
      },
    } as unknown as PluginRuntime);
    config = {
      messages: { responsePrefix: "PFX" },
      session: { store: signalToolResultSessionStore.path },
      channels: {
        signal: {
          transport: { kind: "external-native", url: "http://127.0.0.1:8080" },
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    };

    sendMock.mockReset().mockResolvedValue(undefined);
    replyMock.mockReset();
    updateLastRouteMock.mockReset();
    streamMock.mockReset();
    signalCheckMock.mockReset().mockResolvedValue({ ok: true });
    signalRpcRequestMock.mockReset().mockResolvedValue({});
    spawnSignalDaemonMock.mockReset().mockReturnValue(createMockSignalDaemonHandle());
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "PAIRCODE", created: true });
    waitForTransportReadyMock.mockReset().mockResolvedValue(undefined);
    enqueueSystemEventMock.mockReset();

    resetSystemEventsForTest();
  });

  afterEach(async () => {
    clearSignalRuntimeForTest();
    signalToolResultIngressQueue = undefined;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    if (signalToolResultStateDir) {
      await fs.rm(signalToolResultStateDir, { recursive: true, force: true });
      signalToolResultStateDir = undefined;
    }
    signalToolResultSessionStore.path = "";
  });
}
