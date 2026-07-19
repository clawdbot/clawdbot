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
    closeOpenClawStateDatabaseForTest();
    if (testStateDir) {
      await fs.rm(testStateDir, { recursive: true, force: true });
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

  it("clears poll error backoff on abort without retrying", async () => {
    vi.useFakeTimers();
    let abort: AbortController | undefined;
    let run: Promise<void> | undefined;
    try {
      getUpdatesMock.mockReset();
      getUpdatesMock.mockRejectedValue(new Error("zalo poll transport failed"));

      const started = await startLifecycleMonitor();
      abort = started.abort;
      run = started.run;

      await vi.advanceTimersByTimeAsync(0);
      expect(started.runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("zalo poll transport failed"),
      );
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
    const { abort, runtime, run } = await startLifecycleMonitor({
      useWebhook: true,
      webhookUrl: "https://example.com/hooks/zalo",
      webhookSecret: "supersecret", // pragma: allowlist secret
    });
    const monitoredRun = run.then(() => {
      settled = true;
    });

    await setWebhookCalled;
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
});
