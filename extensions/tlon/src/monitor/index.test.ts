// Tlon monitor tests cover authentication retry scheduling and shutdown lifecycle.
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  authenticateMock,
  sleepWithAbortMock,
  sseClientCtorMock,
  sseClientInstanceMock,
  settingsManagerMock,
  ingressMonitorMock,
} = vi.hoisted(() => ({
  authenticateMock: vi.fn(),
  sleepWithAbortMock: vi.fn(),
  sseClientCtorMock: vi.fn(),
  sseClientInstanceMock: {
    scry: vi.fn(async () => null),
    poke: vi.fn(async () => undefined),
    subscribe: vi.fn(async () => undefined),
    connect: vi.fn(async () => undefined),
    stopReceiving: vi.fn(),
    close: vi.fn(async () => undefined),
  },
  settingsManagerMock: {
    load: vi.fn(async () => ({})),
    onChange: vi.fn(() => () => {}),
    startSubscription: vi.fn(async () => undefined),
  },
  ingressMonitorMock: {
    receive: vi.fn(async () => ({ kind: "ignored" })),
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
    waitForIdle: vi.fn(async () => undefined),
  },
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    sleepWithAbort: sleepWithAbortMock,
  };
});

vi.mock("../runtime.js", () => ({
  getTlonRuntime: () => ({
    config: {
      current: () => ({
        channels: {
          tlon: {
            code: "code",
            ship: "~zod",
            url: "https://urbit.example.com",
          },
        },
      }),
    },
    logging: {
      getChildLogger: () => ({}),
    },
  }),
}));

vi.mock("../urbit/auth.js", () => ({
  authenticate: authenticateMock,
}));

vi.mock("../urbit/sse-client.js", () => ({
  UrbitSSEClient: vi.fn((...args: unknown[]) => {
    sseClientCtorMock(...args);
    return sseClientInstanceMock;
  }),
}));

vi.mock("../settings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../settings.js")>();
  return {
    ...actual,
    createSettingsManager: vi.fn(() => settingsManagerMock),
  };
});

vi.mock("./ingress.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ingress.js")>();
  return {
    ...actual,
    createTlonIngressMonitor: vi.fn(() => ingressMonitorMock),
  };
});

import { monitorTlonProvider } from "./index.js";

describe("monitorTlonProvider authentication retry", () => {
  it("uses the shared abort-aware sleep for retry backoff", async () => {
    const controller = new AbortController();
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;
    authenticateMock.mockRejectedValueOnce(new Error("login failed"));
    sleepWithAbortMock.mockRejectedValueOnce(new Error("aborted"));

    await expect(
      monitorTlonProvider({
        abortSignal: controller.signal,
        runtime,
      }),
    ).rejects.toThrow("aborted");

    expect(authenticateMock).toHaveBeenCalledTimes(1);
    expect(sleepWithAbortMock).toHaveBeenCalledWith(1_000, controller.signal);
  });
});

describe("monitorTlonProvider shutdown during startup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("settles and runs cleanup when abort fires while api.connect() is pending", async () => {
    // Regression for #114886: an abort during async startup must not leave the
    // monitor hanging. After connect() resolves, waitUntilAbort sees an
    // already-aborted signal and resolves immediately so finally cleanup runs.
    const controller = new AbortController();
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;
    authenticateMock.mockResolvedValueOnce("cookie");

    let resolveConnect!: () => void;
    sseClientInstanceMock.connect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveConnect = resolve;
        }),
    );

    const monitor = monitorTlonProvider({ abortSignal: controller.signal, runtime });

    // Wait for connect() to be in flight, then abort during the pending startup.
    await vi.waitFor(() => expect(sseClientInstanceMock.connect).toHaveBeenCalled());
    controller.abort();
    resolveConnect();

    // The monitor must settle (not hang) and run finally cleanup exactly once.
    await expect(monitor).resolves.toBeUndefined();
    expect(sseClientInstanceMock.stopReceiving).toHaveBeenCalledTimes(1);
    expect(sseClientInstanceMock.close).toHaveBeenCalledTimes(1);
    expect(ingressMonitorMock.stop).toHaveBeenCalledTimes(1);
  });
});
