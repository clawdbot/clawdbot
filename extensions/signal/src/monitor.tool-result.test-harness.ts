import type { MockFn } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, vi } from "vitest";
import type { SignalDaemonExitEvent, SignalDaemonHandle } from "./daemon.js";

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
const signalToolResultSessionStorePath = vi.hoisted(
  () => `/tmp/openclaw-signal-tool-result-sessions-${process.pid}.json`,
);

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
  return {
    ...base,
    channels: {
      ...channels,
      signal: {
        ...signal,
        autoStart: true,
        dmPolicy: "open",
        allowFrom: ["*"],
        ...overrides,
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
    stop: stop as unknown as () => void,
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
    resolveStorePath: vi.fn(() => signalToolResultSessionStorePath),
    updateLastRoute: (...args: unknown[]) => updateLastRouteMock(...args),
    readSessionUpdatedAt: vi.fn(() => undefined),
    recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("openclaw/plugin-sdk/reply-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-runtime")>(
    "openclaw/plugin-sdk/reply-runtime",
  );
  return {
    ...actual,
    getReplyFromConfig: (...args: unknown[]) => replyMock(...args),
    dispatchInboundMessage: async (params: {
      ctx: unknown;
      cfg: unknown;
      dispatcher: {
        sendFinalReply: (payload: { text: string }) => boolean;
        markComplete?: () => void;
        waitForIdle?: () => Promise<void>;
      };
    }) => {
      const resolved = (await replyMock(params.ctx, {}, params.cfg)) as
        | { text?: string }
        | undefined;
      const text = typeof resolved?.text === "string" ? resolved.text.trim() : "";
      if (text) {
        params.dispatcher.sendFinalReply({ text });
      }
      params.dispatcher.markComplete?.();
      await params.dispatcher.waitForIdle?.();
      return { queuedFinal: Boolean(text) };
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
    config = {
      messages: { responsePrefix: "PFX" },
      session: { store: signalToolResultSessionStorePath },
      channels: {
        signal: { autoStart: false, dmPolicy: "open", allowFrom: ["*"] },
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
}
