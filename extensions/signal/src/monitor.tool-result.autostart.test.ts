import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import type { SignalDaemonExitEvent } from "./daemon.js";
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
    return;
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

function expectWaitForTransportReadyTimeout(timeoutMs: number) {
  expect(waitForTransportReadyMock).toHaveBeenCalledTimes(1);
  const options = waitForTransportReadyMock.mock.calls[0]?.[0] as { timeoutMs?: number };
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
    const options = waitForTransportReadyMock.mock.calls[0]?.[0] as {
      abortSignal?: unknown;
      check?: unknown;
    } & Record<string, unknown>;
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
            reject(params.abortSignal.reason);
            return;
          }
          params.abortSignal?.addEventListener(
            "abort",
            () => reject(params.abortSignal?.reason ?? new Error("aborted")),
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
    const stop = vi.fn(() => {
      if (exited) {
        return;
      }
      exited = true;
      if (!resolveExit) {
        throw new Error("Expected signal daemon exit resolver to be initialized");
      }
      resolveExit({ source: "process", code: null, signal: "SIGTERM" });
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
});
