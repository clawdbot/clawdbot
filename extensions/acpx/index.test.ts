// ACPX tests cover index plugin behavior.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import setupPlugin from "./setup-api.js";

const { createAcpxRuntimeServiceMock, tryDispatchAcpReplyHookMock } = vi.hoisted(() => ({
  createAcpxRuntimeServiceMock: vi.fn(),
  tryDispatchAcpReplyHookMock: vi.fn(),
}));

vi.mock("./register.runtime.js", () => ({
  createAcpxRuntimeService: createAcpxRuntimeServiceMock,
}));

vi.mock("openclaw/plugin-sdk/acp-runtime-backend", () => ({
  tryDispatchAcpReplyHook: tryDispatchAcpReplyHookMock,
}));

import plugin from "./index.js";

type AcpxAutoEnableProbe = Parameters<OpenClawPluginApi["registerAutoEnableProbe"]>[0];

function registerAcpxAutoEnableProbe(): AcpxAutoEnableProbe {
  const probes: AcpxAutoEnableProbe[] = [];
  setupPlugin.register(
    createTestPluginApi({
      registerAutoEnableProbe(probe) {
        probes.push(probe);
      },
    }),
  );
  const probe = probes[0];
  if (!probe) {
    throw new Error("expected ACPX setup plugin to register an auto-enable probe");
  }
  return probe;
}

describe("acpx plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the runtime service and reply_dispatch hook", () => {
    const service = { id: "acpx-service", start: vi.fn() };
    createAcpxRuntimeServiceMock.mockReturnValue(service);
    const openKeyedStore = vi.fn();

    const api = createTestPluginApi({
      pluginConfig: { stateDir: "/tmp/acpx" },
      runtime: { state: { openKeyedStore } } as never,
      registerService: vi.fn(),
      on: vi.fn(),
    });

    plugin.register(api);

    expect(createAcpxRuntimeServiceMock).toHaveBeenCalledWith({
      pluginConfig: api.pluginConfig,
      openKeyedStore: expect.any(Function),
    });
    const params = createAcpxRuntimeServiceMock.mock.calls[0]?.[0] as {
      openKeyedStore: typeof openKeyedStore;
    };
    params.openKeyedStore({ namespace: "test", maxEntries: 1 });
    expect(openKeyedStore).toHaveBeenCalledWith({ namespace: "test", maxEntries: 1 });
    expect(api.registerService).toHaveBeenCalledWith(service);
    expect(api.on).toHaveBeenCalledWith("reply_dispatch", expect.any(Function), {
      timeoutMs: 120_000,
    });
  });

  it("uses configured ACPX timeout for reply_dispatch hook registration", () => {
    const service = { id: "acpx-service", start: vi.fn() };
    createAcpxRuntimeServiceMock.mockReturnValue(service);

    const api = createTestPluginApi({
      pluginConfig: { timeoutSeconds: 180 },
      runtime: { state: { openKeyedStore: vi.fn() } } as never,
      registerService: vi.fn(),
      on: vi.fn(),
    });

    plugin.register(api);

    expect(api.on).toHaveBeenCalledWith("reply_dispatch", expect.any(Function), {
      timeoutMs: 180_000,
    });
  });

  it("does not touch runtime state while registering metadata-only plugin APIs", () => {
    const service = { id: "acpx-service", start: vi.fn() };
    createAcpxRuntimeServiceMock.mockReturnValue(service);

    const api = createTestPluginApi({
      pluginConfig: {},
      runtime: {} as never,
      registerService: vi.fn(),
      on: vi.fn(),
    });

    expect(() => plugin.register(api)).not.toThrow();
    expect(api.registerService).toHaveBeenCalledWith(service);
  });

  it("preserves the ACP reply_dispatch runtime path through the registered hook", async () => {
    const service = { id: "acpx-service", start: vi.fn() };
    createAcpxRuntimeServiceMock.mockReturnValue(service);
    tryDispatchAcpReplyHookMock.mockResolvedValue({
      handled: true,
      queuedFinal: true,
      counts: { tool: 1, block: 0, final: 1 },
    });

    const on = vi.fn();
    const openKeyedStore = vi.fn();
    const api = createTestPluginApi({
      pluginConfig: { stateDir: "/tmp/acpx" },
      runtime: { state: { openKeyedStore } } as never,
      registerService: vi.fn(),
      on,
    });

    plugin.register(api);

    const hook = on.mock.calls.find(([hookName]) => hookName === "reply_dispatch")?.[1];
    if (!hook) {
      throw new Error("expected reply_dispatch hook to be registered");
    }

    const event = {
      ctx: { raw: "reply ctx" },
      runId: "run-1",
      sessionKey: "agent:test:session",
      inboundAudio: false,
      shouldRouteToOriginating: false,
      shouldSendToolSummaries: true,
      sendPolicy: "allow",
    };
    const ctx = {
      cfg: {},
      dispatcher: { dispatch: vi.fn(), getQueuedCounts: vi.fn(), getFailedCounts: vi.fn() },
      recordProcessed: vi.fn(),
      markIdle: vi.fn(),
    };

    await expect(hook(event, ctx)).resolves.toEqual({
      handled: true,
      queuedFinal: true,
      counts: { tool: 1, block: 0, final: 1 },
    });
    expect(tryDispatchAcpReplyHookMock).toHaveBeenCalledWith(event, {
      ...ctx,
      abortSignal: expect.any(AbortSignal),
    });
  });

  it("aborts the ACP reply_dispatch runtime path at the configured timeout", async () => {
    vi.useFakeTimers();
    try {
      const service = { id: "acpx-service", start: vi.fn() };
      createAcpxRuntimeServiceMock.mockReturnValue(service);
      const observedAbortStates: boolean[] = [];
      tryDispatchAcpReplyHookMock.mockImplementation(async (_event, hookCtx) => {
        const abortSignal = (hookCtx as { abortSignal?: AbortSignal }).abortSignal;
        if (!abortSignal) {
          throw new Error("expected ACPX hook abort signal");
        }
        observedAbortStates.push(abortSignal.aborted);
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        observedAbortStates.push(abortSignal.aborted);
        return {
          handled: true,
          queuedFinal: true,
          counts: { tool: 0, block: 0, final: 1 },
        };
      });

      const on = vi.fn();
      const api = createTestPluginApi({
        pluginConfig: { timeoutSeconds: 0.001 },
        runtime: { state: { openKeyedStore: vi.fn() } } as never,
        registerService: vi.fn(),
        on,
      });

      plugin.register(api);

      const hook = on.mock.calls.find(([hookName]) => hookName === "reply_dispatch")?.[1];
      if (!hook) {
        throw new Error("expected reply_dispatch hook to be registered");
      }

      const run = hook(
        {
          ctx: { raw: "reply ctx" },
          runId: "run-1",
          sessionKey: "agent:test:session",
          inboundAudio: false,
          shouldRouteToOriginating: false,
          shouldSendToolSummaries: true,
          sendPolicy: "allow",
        },
        {
          cfg: {},
          dispatcher: { dispatch: vi.fn(), getQueuedCounts: vi.fn(), getFailedCounts: vi.fn() },
          recordProcessed: vi.fn(),
          markIdle: vi.fn(),
        },
      );

      await vi.advanceTimersByTimeAsync(1);

      await expect(run).resolves.toEqual({
        handled: true,
        queuedFinal: true,
        counts: { tool: 0, block: 0, final: 1 },
      });
      expect(observedAbortStates).toEqual([false, true]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("declares setup auto-enable reasons for ACPX-owned ACP config", () => {
    const probe = registerAcpxAutoEnableProbe();

    expect(probe({ config: { acp: { enabled: true } }, env: {} })).toBe("ACP runtime configured");
    expect(probe({ config: { acp: { backend: "acpx" } }, env: {} })).toBe("ACP runtime configured");
    expect(probe({ config: { acp: { enabled: true, backend: "custom-runtime" } }, env: {} })).toBe(
      null,
    );
  });
});
