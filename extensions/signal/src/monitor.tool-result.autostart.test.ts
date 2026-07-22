// Signal tests cover monitor.tool result.autostart plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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

const { waitForTransportReadyMock, spawnSignalDaemonMock, streamMock } =
  getSignalToolResultTestMocks();

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
  expect(options.timeoutMs).toBe(timeoutMs);
}

describe("monitorSignalProvider autostart", () => {
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
      timeoutMs: 30_000,
      logAfterMs: 10_000,
      logIntervalMs: 10_000,
      pollIntervalMs: 150,
      runtime,
      abortSignal: options.abortSignal,
      check: options.check,
    });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    expect(typeof options.check).toBe("function");
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

  it("passes channels.signal.configPath to signal-cli daemon startup", async () => {
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

  it("passes a bare IPv6 bind host from an IPv6 daemon URL", async () => {
    const runtime = createMonitorRuntime();
    setSignalAutoStartConfig();
    const abortController = createAutoAbortController();

    await runMonitorWithMocks({
      autoStart: true,
      baseUrl: "http://[::1]:9090",
      abortSignal: abortController.signal,
      runtime,
    });

    expect(spawnSignalDaemonMock).toHaveBeenCalledWith(
      expect.objectContaining({ httpHost: "::1", httpPort: 9090 }),
    );
  });

  it("omits configPath when channels.signal.configPath is blank", async () => {
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
      }),
    ).rejects.toThrow(/signal daemon exited/i);
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

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
