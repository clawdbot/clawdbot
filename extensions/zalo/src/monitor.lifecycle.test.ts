import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../../src/plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../../src/plugins/runtime.js";
import { createRuntimeEnv } from "../../../test/helpers/plugins/runtime-env.js";
import type { OpenClawConfig } from "../runtime-api.js";
import type { ResolvedZaloAccount } from "./accounts.js";

const getWebhookInfoMock = vi.fn(async () => ({ ok: true, result: { url: "" } }));
const deleteWebhookMock = vi.fn(async () => ({ ok: true, result: { url: "" } }));
const getUpdatesMock = vi.fn(() => new Promise(() => {}));
const setWebhookMock = vi.fn(async () => ({ ok: true, result: { url: "" } }));

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
  getZaloRuntime: () => ({
    logging: {
      shouldLogVerbose: () => false,
    },
  }),
}));

const TEST_ACCOUNT = {
  accountId: "default",
  config: {},
} as unknown as ResolvedZaloAccount;

const TEST_CONFIG = {} as OpenClawConfig;

async function settleLifecycleWork(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
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
  afterEach(() => {
    vi.clearAllMocks();
    setActivePluginRegistry(createEmptyPluginRegistry());
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
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Zalo provider stopped mode=polling"),
    );
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
      expect.stringContaining("Zalo polling mode ready (webhook disabled)"),
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
      expect.stringContaining("webhook inspection unavailable; continuing without webhook cleanup"),
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
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Zalo provider stopped mode=webhook"),
    );
  });
});
