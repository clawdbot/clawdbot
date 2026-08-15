// Zalo tests cover monitor.lifecycle plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createEmptyPluginRegistry,
  createRuntimeEnv,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import type { ResolvedZaloAccount } from "./accounts.js";

const getWebhookInfoMock = vi.fn(async () => ({ ok: true, result: { url: "" } }));
const deleteWebhookMock = vi.fn(async () => ({ ok: true, result: { url: "" } }));
const getUpdatesMock = vi.fn(() => new Promise(() => {}));
const setWebhookMock = vi.fn(async () => ({ ok: true, result: { url: "" } }));
const getZaloRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    deleteWebhook: deleteWebhookMock,
    getWebhookInfo: getWebhookInfoMock,
    getUpdates: getUpdatesMock,
    setWebhook: setWebhookMock,
  };
});

vi.mock("./runtime.js", () => ({
  getZaloRuntime: getZaloRuntimeMock,
}));

const TEST_ACCOUNT = {
  accountId: "default",
  config: {},
} as unknown as ResolvedZaloAccount;

const TEST_CONFIG = {} as OpenClawConfig;
let testStateDir: string | undefined;
let previousStateDir: string | undefined;

async function settleLifecycleWork(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

async function startLifecycleMonitor(
  options: {
    statusSink?: (patch: Record<string, unknown>) => void;
    useWebhook?: boolean;
    webhookSecret?: string;
    webhookUrl?: string;
  } = {},
) {
  const { monitorZaloProvider } = await import("./monitor.js");
  const abort = new AbortController();
  const runtime = createRuntimeEnv();
  const run = monitorZaloProvider({
    token: "test-token",
    account: TEST_ACCOUNT,
    config: TEST_CONFIG,
    runtime,
    abortSignal: abort.signal,
    ...options,
  });
  return { abort, runtime, run };
}

describe("monitorZaloProvider lifecycle", () => {
  beforeEach(async () => {
    const createdDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-zalo-monitor-"));
    testStateDir = await fs.realpath(createdDir);
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = testStateDir;
    const core = createPluginRuntimeMock();
    core.state.openChannelIngressQueue = (<T>(options: { accountId?: string }) =>
      createChannelIngressQueueForTests<T>({
        channelId: "zalo",
        accountId: options.accountId ?? "default",
        stateDir: testStateDir,
      })) as PluginRuntime["state"]["openChannelIngressQueue"];
    getZaloRuntimeMock.mockReturnValue(core);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    getUpdatesMock.mockReset();
    getUpdatesMock.mockImplementation(() => new Promise(() => {}));
    setActivePluginRegistry(createEmptyPluginRegistry());
    // Agent close releases leases through shared state; closing shared state first
    // can reopen it during teardown and leave Windows handles under the state dir.
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    if (testStateDir) {
      await fs.rm(testStateDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
      testStateDir = undefined;
    }
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
      previousStateDir = undefined;
    }
  });

  it("stays alive in polling mode until abort", async () => {
    let settled = false;
    const { abort, runtime, run } = await startLifecycleMonitor();
    const monitoredRun = run.then(() => {
      settled = true;
    });

    await settleLifecycleWork();
    expect(getUpdatesMock).toHaveBeenCalledTimes(1);

    expect(getWebhookInfoMock).toHaveBeenCalledTimes(1);
    expect(deleteWebhookMock).not.toHaveBeenCalled();
    expect(getUpdatesMock).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    abort.abort();
    await monitoredRun;

    expect(settled).toBe(true);
    expect(runtime.log).toHaveBeenCalledWith("[default] Zalo provider stopped mode=polling");
  });

  it("publishes ready after the first successful polling response", async () => {
    getUpdatesMock
      .mockResolvedValueOnce({ ok: true, result: undefined })
      .mockImplementation(() => new Promise(() => {}));
    const statusSink = vi.fn();
    const { abort, run } = await startLifecycleMonitor({ statusSink });

    await vi.waitFor(() =>
      expect(statusSink).toHaveBeenCalledWith({
        running: true,
        connected: true,
        lifecycle: "ready",
        terminalDisconnect: undefined,
        lastConnectedAt: expect.any(Number),
        lastError: null,
      }),
    );
    abort.abort();
    await run;
  });

  it("clears poll error backoff on abort without retrying", async () => {
    vi.useFakeTimers();
    let abort: AbortController | undefined;
    let run: Promise<void> | undefined;
    try {
      getUpdatesMock.mockReset();
      getUpdatesMock.mockRejectedValue(new Error("zalo poll transport failed"));
      const statusSink = vi.fn();

      const started = await startLifecycleMonitor({ statusSink });
      abort = started.abort;
      run = started.run;

      await vi.advanceTimersByTimeAsync(0);
      expect(started.runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("zalo poll transport failed"),
      );
      expect(statusSink).toHaveBeenCalledWith({
        connected: false,
        lifecycle: "recovering",
        lastError: expect.stringContaining("zalo poll transport failed"),
      });
      expect(getUpdatesMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      abort.abort();
      await run;

      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(getUpdatesMock).toHaveBeenCalledTimes(1);
      expect(started.runtime.log).toHaveBeenCalledWith(
        "[default] Zalo provider stopped mode=polling",
      );
    } finally {
      abort?.abort();
      await run?.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("deletes an existing webhook before polling", async () => {
    getWebhookInfoMock.mockResolvedValueOnce({
      ok: true,
      result: { url: "https://example.com/hooks/zalo" },
    });

    const { abort, runtime, run } = await startLifecycleMonitor();

    await settleLifecycleWork();
    expect(getUpdatesMock).toHaveBeenCalledTimes(1);

    expect(getWebhookInfoMock).toHaveBeenCalledTimes(1);
    expect(deleteWebhookMock).toHaveBeenCalledTimes(1);
    expect(runtime.log).toHaveBeenCalledWith(
      "[default] Zalo polling mode ready (webhook disabled)",
    );

    abort.abort();
    await run;
  });

  it("continues polling when webhook inspection returns 404", async () => {
    const { ZaloApiError } = await import("./api.js");
    getWebhookInfoMock.mockRejectedValueOnce(new ZaloApiError("Not Found", 404, "Not Found"));

    const { abort, runtime, run } = await startLifecycleMonitor();

    await settleLifecycleWork();
    expect(getUpdatesMock).toHaveBeenCalledTimes(1);

    expect(getWebhookInfoMock).toHaveBeenCalledTimes(1);
    expect(deleteWebhookMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "[default] Zalo polling mode webhook inspection unavailable; continuing without webhook cleanup",
    );
    expect(runtime.error).not.toHaveBeenCalled();

    abort.abort();
    await run;
  });

  it("waits for webhook deletion before finishing webhook shutdown", async () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);

    let resolveSetWebhookCalled: (() => void) | undefined;
    const setWebhookCalled = new Promise<void>((resolve) => {
      resolveSetWebhookCalled = resolve;
    });
    setWebhookMock.mockImplementationOnce(async () => {
      expect(registry.httpRoutes).toHaveLength(2);
      resolveSetWebhookCalled?.();
      return { ok: true, result: { url: "" } };
    });

    let resolveDeleteWebhookCalled: (() => void) | undefined;
    const deleteWebhookCalled = new Promise<void>((resolve) => {
      resolveDeleteWebhookCalled = resolve;
    });
    let resolveDeleteWebhook: (() => void) | undefined;
    deleteWebhookMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDeleteWebhookCalled?.();
          resolveDeleteWebhook = () => resolve({ ok: true, result: { url: "" } });
        }),
    );

    let settled = false;
    const statusSink = vi.fn();
    const { abort, runtime, run } = await startLifecycleMonitor({
      statusSink,
      useWebhook: true,
      webhookUrl: "https://example.com/hooks/zalo",
      webhookSecret: "supersecret", // pragma: allowlist secret
    });
    const monitoredRun = run.then(() => {
      settled = true;
    });

    await setWebhookCalled;
    await settleLifecycleWork();
    expect(statusSink).toHaveBeenCalledWith({
      running: true,
      connected: true,
      lifecycle: "ready",
      terminalDisconnect: undefined,
      lastConnectedAt: expect.any(Number),
      lastError: null,
    });
    await settleLifecycleWork();
    expect(setWebhookMock).toHaveBeenCalledTimes(1);
    expect(registry.httpRoutes).toHaveLength(2);

    abort.abort();

    await deleteWebhookCalled;
    expect(deleteWebhookMock).toHaveBeenCalledTimes(1);
    expect(deleteWebhookMock).toHaveBeenCalledWith("test-token", undefined, 5000);
    expect(settled).toBe(false);
    expect(registry.httpRoutes).toHaveLength(2);

    resolveDeleteWebhook?.();
    await monitoredRun;

    expect(settled).toBe(true);
    expect(registry.httpRoutes).toHaveLength(0);
    expect(runtime.log).toHaveBeenCalledWith("[default] Zalo provider stopped mode=webhook");
  });

  it("cleans up and rejects startup when the webhook route cannot bind", async () => {
    const registry = createEmptyPluginRegistry();
    const existingRoute = {
      path: "/hooks/zalo",
      match: "exact" as const,
      auth: "plugin" as const,
      handler: () => {},
      pluginId: "other-plugin",
      source: "other-webhook",
    };
    registry.httpRoutes.push(existingRoute);
    setActivePluginRegistry(registry);
    const statusSink = vi.fn();

    const { runtime, run } = await startLifecycleMonitor({
      statusSink,
      useWebhook: true,
      webhookUrl: "https://example.com/hooks/zalo",
      webhookSecret: "supersecret", // pragma: allowlist secret
    });

    await expect(run).rejects.toThrow("route replacement denied");

    expect(setWebhookMock).not.toHaveBeenCalled();
    expect(registry.httpRoutes).toEqual([existingRoute]);
    expect(statusSink).toHaveBeenCalledWith({
      connected: false,
      lifecycle: "recovering",
      lastError: expect.stringContaining("route replacement denied"),
    });
    expect(statusSink).not.toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("route replacement denied"));
    expect(runtime.log).toHaveBeenCalledWith("[default] Zalo provider stopped mode=webhook");
  });

  it("rejects startup when a foreign plugin owns the hosted-media route", async () => {
    const registry = createEmptyPluginRegistry();
    const existingRoute = {
      path: "/hooks/zalo/media",
      match: "prefix" as const,
      auth: "plugin" as const,
      handler: () => {},
      pluginId: "other-plugin",
      source: "other-media",
    };
    registry.httpRoutes.push(existingRoute);
    setActivePluginRegistry(registry);
    const statusSink = vi.fn();

    const { runtime, run } = await startLifecycleMonitor({
      statusSink,
      webhookUrl: "https://example.com/hooks/zalo",
    });

    await expect(run).rejects.toThrow("route reuse denied");

    expect(getWebhookInfoMock).not.toHaveBeenCalled();
    expect(getUpdatesMock).not.toHaveBeenCalled();
    expect(registry.httpRoutes).toEqual([existingRoute]);
    expect(statusSink).toHaveBeenCalledWith({
      connected: false,
      lifecycle: "recovering",
      lastError: expect.stringContaining("route reuse denied"),
    });
    expect(statusSink).not.toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));
    expect(runtime.log).toHaveBeenCalledWith("[default] Zalo provider stopped mode=polling");
  });

  it("returns immediately without polling startup when abort signal is pre-aborted", async () => {
    const { monitorZaloProvider } = await import("./monitor.js");
    const preAborted = new AbortController();
    preAborted.abort();
    const runtime = createRuntimeEnv();

    // With a pre-aborted signal the function must return without ever
    // entering the polling loop (getUpdates never called).
    await monitorZaloProvider({
      token: "test-token",
      account: TEST_ACCOUNT,
      config: TEST_CONFIG,
      runtime,
      abortSignal: preAborted.signal,
    });

    // getUpdatesMock is a never-resolving promise in polling mode; if the
    // early return works, this test completes. getUpdates should not be
    // called because we never entered polling.
    expect(getUpdatesMock).not.toHaveBeenCalled();
    // getWebhookInfo should also be skipped — on main the polling path
    // inspects the webhook before starting the loop, so a pre-aborted
    // signal that misses the early return would hit getWebhookInfo first.
    expect(getWebhookInfoMock).not.toHaveBeenCalled();
    // The early return logs provider init but skips the try/finally block,
    // so the "stopped" log from the finally block is not emitted.
  });

  it("returns immediately without webhook registration when abort signal is pre-aborted", async () => {
    const { monitorZaloProvider } = await import("./monitor.js");
    const preAborted = new AbortController();
    preAborted.abort();
    const runtime = createRuntimeEnv();

    await monitorZaloProvider({
      token: "test-token",
      account: TEST_ACCOUNT,
      config: TEST_CONFIG,
      runtime,
      abortSignal: preAborted.signal,
      useWebhook: true,
      webhookUrl: "https://example.com/hooks/zalo",
      webhookSecret: "test-webhook-secret",
    });

    // setWebhookMock should not be called — we returned before webhook setup.
    expect(setWebhookMock).not.toHaveBeenCalled();
  });
});
