// Signal tests cover monitor.tool result.autostart plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { toErrorObject as toLintErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { describe, expect, it, vi } from "vitest";
import type { SignalDaemonHandle } from "./daemon.js";
import {
  createSignalToolResultConfig,
  createMockSignalDaemonHandle,
  config,
  getSignalToolResultTestMocks,
  installSignalToolResultTestHooks,
  setSignalToolResultTestConfig,
} from "./monitor.tool-result.test-harness.js";

installSignalToolResultTestHooks();

const { monitorSignalProvider } = await import("./monitor.js");

const {
  waitForTransportReadyMock,
  assertSignalDaemonEndpointAvailableMock,
  signalCheckMock,
  spawnSignalDaemonMock,
  streamMock,
} = getSignalToolResultTestMocks();

const SIGNAL_BASE_URL = "http://127.0.0.1:8080";
type MonitorSignalProviderOptions = NonNullable<Parameters<typeof monitorSignalProvider>[0]>;
type SignalDaemonExitEvent = Awaited<SignalDaemonHandle["exited"]>;

function createMonitorRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: ((code: number): never => {
      throw new Error(`exit ${code}`);
    }) as (code: number) => never,
  };
}

function setSignalAutoStartConfig(overrides: Record<string, unknown> = {}) {
  setSignalToolResultTestConfig(createSignalToolResultConfig(overrides));
}

function createAutoAbortController() {
  const abortController = new AbortController();
  streamMock.mockImplementation(async () => {
    abortController.abort();
  });
  return abortController;
}

async function runMonitorWithMocks(opts: MonitorSignalProviderOptions) {
  return monitorSignalProvider({
    config: config as OpenClawConfig,
    waitForTransportReady:
      waitForTransportReadyMock as MonitorSignalProviderOptions["waitForTransportReady"],
    ...opts,
  });
}

function requireWaitForTransportReadyOptions(): Record<string, unknown> {
  const [call] = waitForTransportReadyMock.mock.calls;
  if (!call) {
    throw new Error("expected waitForTransportReady call");
  }
  const [options] = call;
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("expected waitForTransportReady options");
  }
  return options as Record<string, unknown>;
}

function expectWaitForTransportReadyTimeout(timeoutMs: number) {
  expect(waitForTransportReadyMock).toHaveBeenCalledTimes(1);
  const options = requireWaitForTransportReadyOptions();
  if (typeof options.timeoutMs !== "number") {
    throw new Error("expected waitForTransportReady timeoutMs to be a number");
  }
  expect(options.timeoutMs).toBeGreaterThan(timeoutMs - 1_000);
  expect(options.timeoutMs).toBeLessThanOrEqual(timeoutMs);
}

describe("monitorSignalProvider autostart", () => {
  it.each(["external-native", "container"] as const)(
    "does not spawn a daemon for %s transport",
    async (kind) => {
      const abortController = createAutoAbortController();
      setSignalToolResultTestConfig({
        channels: {
          signal: {
            transport: { kind, url: `http://${kind}:8080` },
            dmPolicy: "open",
            allowFrom: ["*"],
          },
        },
      });

      await runMonitorWithMocks({
        abortSignal: abortController.signal,
        runtime: createMonitorRuntime(),
      });

      expect(spawnSignalDaemonMock).not.toHaveBeenCalled();
      expect(waitForTransportReadyMock).not.toHaveBeenCalled();
      expect(streamMock).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: `http://${kind}:8080`,
          transportKind: kind,
        }),
      );
    },
  );

  it("uses bounded readiness checks when auto-starting the daemon", async () => {
    const runtime = createMonitorRuntime();
    setSignalAutoStartConfig();
    const abortController = createAutoAbortController();
    await runMonitorWithMocks({
      autoStart: true,
      baseUrl: SIGNAL_BASE_URL,
      abortSignal: abortController.signal,
      runtime,
    });

    expect(waitForTransportReadyMock).toHaveBeenCalledTimes(1);
    const options = requireWaitForTransportReadyOptions();
    expect(options).toEqual({
      label: "signal daemon",
      timeoutMs: options.timeoutMs,
      logAfterMs: 10_000,
      logIntervalMs: 10_000,
      pollIntervalMs: 150,
      runtime,
      abortSignal: options.abortSignal,
      check: options.check,
    });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    expect(typeof options.check).toBe("function");
    expectWaitForTransportReadyTimeout(30_000);
  });

  it("reports an occupied managed endpoint before spawning signal-cli", async () => {
    const runtime = createMonitorRuntime();
    const abortController = createAutoAbortController();
    setSignalAutoStartConfig({ httpHost: "127.0.0.1", httpPort: 8181 });
    assertSignalDaemonEndpointAvailableMock.mockRejectedValueOnce(
      new Error("Signal managed native endpoint 127.0.0.1:8181 is already in use."),
    );

    await expect(
      runMonitorWithMocks({
        abortSignal: abortController.signal,
        runtime,
      }),
    ).rejects.toThrow("Signal managed native endpoint 127.0.0.1:8181 is already in use.");
    expect(assertSignalDaemonEndpointAvailableMock).toHaveBeenCalledWith(
      expect.objectContaining({
        httpHost: "127.0.0.1",
        httpPort: 8181,
        abortSignal: expect.any(AbortSignal),
      }),
    );
    expect(spawnSignalDaemonMock).not.toHaveBeenCalled();
    expect(waitForTransportReadyMock).not.toHaveBeenCalled();
  });

  it("normalizes a bracketed IPv6 host override before probing and spawning", async () => {
    const abortController = createAutoAbortController();
    setSignalAutoStartConfig();

    await runMonitorWithMocks({
      abortSignal: abortController.signal,
      httpHost: "[::1]",
      runtime: createMonitorRuntime(),
    });

    expect(assertSignalDaemonEndpointAvailableMock).toHaveBeenCalledWith(
      expect.objectContaining({ httpHost: "::1" }),
    );
    expect(spawnSignalDaemonMock).toHaveBeenCalledWith(
      expect.objectContaining({ httpHost: "::1" }),
    );
  });

  it("cancels the managed endpoint probe when monitoring aborts", async () => {
    const runtime = createMonitorRuntime();
    const abortController = new AbortController();
    setSignalAutoStartConfig();
    let probeStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      probeStarted = resolve;
    });
    assertSignalDaemonEndpointAvailableMock.mockImplementationOnce(
      ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          probeStarted?.();
          abortSignal.addEventListener(
            "abort",
            () => reject(toLintErrorObject(abortSignal.reason, "Non-Error rejection")),
            { once: true },
          );
        }),
    );

    const monitorPromise = runMonitorWithMocks({
      abortSignal: abortController.signal,
      runtime,
    });
    await started;
    abortController.abort();

    await expect(monitorPromise).resolves.toBeUndefined();
    expect(spawnSignalDaemonMock).not.toHaveBeenCalled();
  });

  it("does not spawn when monitoring aborts as the endpoint probe completes", async () => {
    const runtime = createMonitorRuntime();
    const abortController = new AbortController();
    setSignalAutoStartConfig();
    assertSignalDaemonEndpointAvailableMock.mockImplementationOnce(async () => {
      abortController.abort();
    });

    await expect(
      runMonitorWithMocks({
        abortSignal: abortController.signal,
        runtime,
      }),
    ).resolves.toBeUndefined();
    expect(spawnSignalDaemonMock).not.toHaveBeenCalled();
  });

  it("bounds the managed endpoint probe by the startup timeout", async () => {
    const runtime = createMonitorRuntime();
    setSignalAutoStartConfig();
    assertSignalDaemonEndpointAvailableMock.mockImplementationOnce(
      ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          abortSignal.addEventListener(
            "abort",
            () => reject(toLintErrorObject(abortSignal.reason, "Non-Error rejection")),
            { once: true },
          );
        }),
    );

    await expect(
      runMonitorWithMocks({
        runtime,
        startupTimeoutMs: 1_000,
      }),
    ).rejects.toThrow("signal daemon startup timed out after 1000ms while checking its endpoint");
    expect(spawnSignalDaemonMock).not.toHaveBeenCalled();
  });

  it("does not spawn when the endpoint probe consumes the startup deadline", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    setSignalAutoStartConfig();
    assertSignalDaemonEndpointAvailableMock.mockImplementationOnce(async () => {
      now.mockReturnValue(2_000);
    });

    try {
      await expect(
        runMonitorWithMocks({
          runtime: createMonitorRuntime(),
          startupTimeoutMs: 1_000,
        }),
      ).rejects.toThrow("signal daemon startup timed out after 1000ms before starting");
      expect(spawnSignalDaemonMock).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it("bounds the final readiness request by the shared startup deadline", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const abortController = createAutoAbortController();
    setSignalAutoStartConfig();
    assertSignalDaemonEndpointAvailableMock.mockImplementationOnce(async () => {
      now.mockReturnValue(1_900);
    });
    signalCheckMock.mockImplementationOnce(async () => {
      now.mockReturnValue(2_001);
      return { ok: true };
    });
    let readinessResult: unknown;
    waitForTransportReadyMock.mockImplementationOnce(
      async ({ check }: { check: () => Promise<unknown> }) => {
        readinessResult = await check();
      },
    );

    try {
      await runMonitorWithMocks({
        abortSignal: abortController.signal,
        runtime: createMonitorRuntime(),
        startupTimeoutMs: 1_000,
      });
      expect(signalCheckMock).toHaveBeenCalledWith(SIGNAL_BASE_URL, 100);
      expect(readinessResult).toEqual({ ok: false, error: "startup deadline exceeded" });
    } finally {
      now.mockRestore();
    }
  });

  it("uses startupTimeoutMs override when provided", async () => {
    const runtime = createMonitorRuntime();
    setSignalAutoStartConfig({ startupTimeoutMs: 60_000 });
    const abortController = createAutoAbortController();

    await runMonitorWithMocks({
      autoStart: true,
      baseUrl: SIGNAL_BASE_URL,
      abortSignal: abortController.signal,
      runtime,
      startupTimeoutMs: 90_000,
    });

    expectWaitForTransportReadyTimeout(90_000);
  });

  it("passes managed transport configPath to signal-cli daemon startup", async () => {
    const runtime = createMonitorRuntime();
    setSignalAutoStartConfig({ configPath: "~/.openclaw/signal-cli" });
    const abortController = createAutoAbortController();

    await runMonitorWithMocks({
      autoStart: true,
      baseUrl: SIGNAL_BASE_URL,
      abortSignal: abortController.signal,
      runtime,
    });

    expect(spawnSignalDaemonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        configPath: "~/.openclaw/signal-cli",
      }),
    );
  });

  it("omits configPath when managed transport configPath is blank", async () => {
    const runtime = createMonitorRuntime();
    setSignalAutoStartConfig({ configPath: " " });
    const abortController = createAutoAbortController();

    await runMonitorWithMocks({
      autoStart: true,
      baseUrl: SIGNAL_BASE_URL,
      abortSignal: abortController.signal,
      runtime,
    });

    const [daemonOpts] = spawnSignalDaemonMock.mock.calls[0] ?? [];
    expect(daemonOpts).toBeDefined();
    expect(daemonOpts).not.toHaveProperty("configPath");
  });

  it("caps startupTimeoutMs at 2 minutes", async () => {
    const runtime = createMonitorRuntime();
    setSignalAutoStartConfig({ startupTimeoutMs: 180_000 });
    const abortController = createAutoAbortController();

    await runMonitorWithMocks({
      autoStart: true,
      baseUrl: SIGNAL_BASE_URL,
      abortSignal: abortController.signal,
      runtime,
    });

    expectWaitForTransportReadyTimeout(120_000);
  });

  it("fails fast when auto-started signal daemon exits during startup", async () => {
    const runtime = createMonitorRuntime();
    const statusSink = vi.fn();
    setSignalAutoStartConfig();
    spawnSignalDaemonMock.mockReturnValueOnce(
      createMockSignalDaemonHandle({
        exited: Promise.resolve({ source: "process", code: 1, signal: null }),
        isExited: () => true,
      }),
    );
    waitForTransportReadyMock.mockImplementationOnce(
      async (params: { abortSignal?: AbortSignal | null }) => {
        await new Promise<void>((_resolve, reject) => {
          if (params.abortSignal?.aborted) {
            reject(toLintErrorObject(params.abortSignal.reason, "Non-Error rejection"));
            return;
          }
          params.abortSignal?.addEventListener(
            "abort",
            () =>
              reject(
                toLintErrorObject(
                  params.abortSignal?.reason ?? new Error("aborted"),
                  "Non-Error rejection",
                ),
              ),
            { once: true },
          );
        });
      },
    );

    await expect(
      runMonitorWithMocks({
        autoStart: true,
        baseUrl: SIGNAL_BASE_URL,
        runtime,
        statusSink,
      }),
    ).rejects.toThrow(/signal daemon exited/i);
    expect(statusSink).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: "recovering", connected: false }),
    );
  });

  it("treats daemon exit after user abort as clean shutdown", async () => {
    const runtime = createMonitorRuntime();
    setSignalAutoStartConfig();
    const abortController = new AbortController();
    let exited = false;
    let resolveExit: ((value: SignalDaemonExitEvent) => void) | undefined;
    const exitedPromise = new Promise<SignalDaemonExitEvent>((resolve) => {
      resolveExit = resolve;
    });
    const stop = vi.fn(async () => {
      if (exited) {
        return;
      }
      exited = true;
      if (!resolveExit) {
        throw new Error("Expected signal daemon exit resolver to be initialized");
      }
      resolveExit({ source: "process", code: null, signal: "SIGTERM" });
      await exitedPromise;
    });
    spawnSignalDaemonMock.mockReturnValueOnce(
      createMockSignalDaemonHandle({
        stop,
        exited: exitedPromise,
        isExited: () => exited,
      }),
    );
    streamMock.mockImplementationOnce(async () => {
      abortController.abort(new Error("stop"));
    });

    await expect(
      runMonitorWithMocks({
        autoStart: true,
        baseUrl: SIGNAL_BASE_URL,
        runtime,
        abortSignal: abortController.signal,
      }),
    ).resolves.toBeUndefined();
  });

  it("awaits daemon exit before resolving aborted monitor shutdown", async () => {
    const runtime = createMonitorRuntime();
    setSignalAutoStartConfig();
    const abortController = new AbortController();
    let resolveStop!: () => void;
    const stopPromise = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    const stop = vi.fn(() => stopPromise);
    spawnSignalDaemonMock.mockReturnValueOnce(createMockSignalDaemonHandle({ stop }));
    streamMock.mockImplementationOnce(async () => {
      abortController.abort(new Error("stop"));
    });

    let settled = false;
    const monitorPromise = runMonitorWithMocks({
      autoStart: true,
      baseUrl: SIGNAL_BASE_URL,
      runtime,
      abortSignal: abortController.signal,
    }).then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);

    resolveStop();
    await monitorPromise;
    expect(settled).toBe(true);
  });
});
