import { describe, expect, it, vi } from "vitest";
import {
  archiveCopilotSession,
  resolveSidePanelTabId,
  selectCopilotPanelState,
} from "./copilot-background-shared.js";
import { createCopilotController } from "./copilot-background.js";

function eventHook() {
  return { addListener: vi.fn() };
}

function storageArea(initial: Record<string, unknown> = {}) {
  const values = { ...initial };
  return {
    get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.map((key) => [key, values[key]]))),
    set: vi.fn(async (update: Record<string, unknown>) => {
      Object.assign(values, update);
    }),
  };
}

describe("browser copilot background", () => {
  it("serializes config refreshes so a stale pairing cannot outlive unpair", async () => {
    let resolveInitial: ((config: Record<string, string>) => void) | undefined;
    const getConfig = vi
      .fn()
      .mockImplementationOnce(
        async () =>
          await new Promise<Record<string, string>>((resolve) => {
            resolveInitial = resolve;
          }),
      )
      .mockResolvedValue({ relayUrl: "", gatewayUrl: "" });
    const gateway = {
      onEvent: vi.fn(),
      onStatus: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const storage = { local: storageArea(), session: storageArea() };
    const controller = createCopilotController({
      chromeApi: {
        runtime: { onConnect: eventHook() },
        tabs: { query: vi.fn(async () => []) },
        storage,
      } as never,
      getConfig,
      isTabShared: vi.fn(),
      addTabToOpenClawGroup: vi.fn(),
      attachDebugger: vi.fn(),
      detachDebugger: vi.fn(),
      revokeDebugger: vi.fn(),
      restoreDebugger: vi.fn(),
      scheduleTabsSync: vi.fn(),
      gateway: gateway as never,
    });

    const initializing = controller.initialize();
    await vi.waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1));
    const unpairing = controller.refreshConfig();
    await Promise.resolve();
    expect(getConfig).toHaveBeenCalledTimes(1);
    resolveInitial?.({
      relayUrl: "ws://127.0.0.1:18792/browser/extension",
      gatewayUrl: "ws://127.0.0.1:18789",
    });
    await Promise.all([initializing, unpairing]);

    expect(gateway.start).toHaveBeenCalledTimes(1);
    const lastStop = Math.max(...gateway.stop.mock.invocationCallOrder);
    expect(gateway.start.mock.invocationCallOrder[0]).toBeLessThan(lastStop);
  });

  it("serializes stale-scope destruction with config changes", async () => {
    const oldScope = "ws://127.0.0.1:18789/";
    const newScope = "ws://127.0.0.1:28789/";
    let releaseRequest: (() => void) | undefined;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const request = vi.fn(async () => {
      await requestGate;
      return { ok: true };
    });
    let reportRecoveryStatus: ((status: Record<string, unknown>) => void) | undefined;
    const recoveryGateway = {
      onStatus: vi.fn((listener) => {
        reportRecoveryStatus = listener;
        return vi.fn();
      }),
      request,
      start: vi.fn(() => reportRecoveryStatus?.({ state: "ready" })),
      stop: vi.fn(),
    };
    const gateway = {
      onEvent: vi.fn(),
      onStatus: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const getConfig = vi
      .fn()
      .mockResolvedValueOnce({
        relayUrl: "ws://127.0.0.1:28792/browser/extension",
        gatewayUrl: newScope,
      })
      .mockResolvedValueOnce({
        relayUrl: "ws://127.0.0.1:18792/browser/extension",
        gatewayUrl: oldScope,
      });
    const controller = createCopilotController({
      chromeApi: {
        runtime: { onConnect: eventHook() },
        tabs: { query: vi.fn(async () => [{ id: 14 }]) },
        storage: {
          local: storageArea({
            copilotSessionRegistryV1: {
              sessions: {
                14: {
                  tabId: 14,
                  browserInstanceId: "browser-instance",
                  gatewayScope: oldScope,
                  sessionKey: "session-old",
                  activeRunId: "run-old",
                },
              },
              pendingArchives: [],
            },
          }),
          session: storageArea({ copilotBrowserInstanceV1: "browser-instance" }),
        },
      } as never,
      getConfig,
      isTabShared: vi.fn(),
      addTabToOpenClawGroup: vi.fn(),
      attachDebugger: vi.fn(),
      detachDebugger: vi.fn(),
      revokeDebugger: vi.fn(async () => undefined),
      restoreDebugger: vi.fn(async () => undefined),
      scheduleTabsSync: vi.fn(),
      gateway: gateway as never,
      recoveryGatewayFactory: () => recoveryGateway as never,
    });
    await controller.initialize();

    const recovery = controller.drainStaleScopes();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const reconfigure = controller.refreshConfig();
    await Promise.resolve();
    expect(getConfig).toHaveBeenCalledTimes(1);

    releaseRequest?.();
    await Promise.all([recovery, reconfigure]);
    expect(getConfig).toHaveBeenCalledTimes(2);
    expect(gateway.start).toHaveBeenLastCalledWith(oldScope);
  });

  it("gives the new Gateway epoch its own abort retry", async () => {
    vi.useFakeTimers();
    try {
      const oldScope = "ws://127.0.0.1:18789/";
      const newScope = "ws://127.0.0.1:28789/";
      const request = vi
        .fn()
        .mockRejectedValueOnce(new Error("old Gateway unavailable"))
        .mockRejectedValueOnce(new Error("new Gateway unavailable"))
        .mockResolvedValue({ ok: true });
      const gateway = {
        ready: true,
        onEvent: vi.fn(),
        onStatus: vi.fn(),
        request,
        start: vi.fn(),
        stop: vi.fn(),
      };
      const getConfig = vi
        .fn()
        .mockResolvedValueOnce({
          relayUrl: "ws://127.0.0.1:18792/browser/extension",
          gatewayUrl: oldScope,
        })
        .mockResolvedValueOnce({
          relayUrl: "ws://127.0.0.1:28792/browser/extension",
          gatewayUrl: newScope,
        });
      const controller = createCopilotController({
        chromeApi: {
          runtime: { onConnect: eventHook() },
          tabs: { query: vi.fn(async () => [{ id: 1 }, { id: 2 }]) },
          storage: { local: storageArea(), session: storageArea() },
        } as never,
        getConfig,
        isTabShared: vi.fn(),
        addTabToOpenClawGroup: vi.fn(),
        attachDebugger: vi.fn(),
        detachDebugger: vi.fn(),
        revokeDebugger: vi.fn(async () => undefined),
        restoreDebugger: vi.fn(async () => undefined),
        scheduleTabsSync: vi.fn(),
        gateway: gateway as never,
      });
      await controller.initialize();
      await controller.registry.put(1, { gatewayScope: oldScope, sessionKey: "session-old" });
      await controller.registry.startRun(1, oldScope, "run-old");

      await controller.refreshConfig();
      await controller.registry.put(2, { gatewayScope: newScope, sessionKey: "session-new" });
      await controller.registry.startRun(2, newScope, "run-new");
      await controller.registry.queueAbort(2, newScope);
      await controller.drainAborts(newScope);
      expect(request).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(250);
      expect(request).toHaveBeenCalledTimes(3);
      expect(controller.registry.pendingAborts(newScope)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("finishes ready reconciliation before switching Gateway clients", async () => {
    const oldScope = "ws://127.0.0.1:18789/";
    const newScope = "ws://127.0.0.1:28789/";
    let reportStatus: ((status: Record<string, unknown>) => void) | undefined;
    let releaseAbort: (() => void) | undefined;
    const abortGate = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    const request = vi.fn(async () => {
      await abortGate;
      return { ok: true };
    });
    const gateway = {
      ready: true,
      onEvent: vi.fn(),
      onStatus: vi.fn((listener) => {
        reportStatus = listener;
      }),
      request,
      start: vi.fn(),
      stop: vi.fn(),
    };
    const getConfig = vi
      .fn()
      .mockResolvedValueOnce({
        relayUrl: "ws://127.0.0.1:18792/browser/extension",
        gatewayUrl: oldScope,
      })
      .mockResolvedValueOnce({
        relayUrl: "ws://127.0.0.1:28792/browser/extension",
        gatewayUrl: newScope,
      });
    const controller = createCopilotController({
      chromeApi: {
        runtime: { onConnect: eventHook() },
        tabs: { query: vi.fn(async () => [{ id: 1 }]) },
        storage: { local: storageArea(), session: storageArea() },
      } as never,
      getConfig,
      isTabShared: vi.fn(),
      addTabToOpenClawGroup: vi.fn(),
      attachDebugger: vi.fn(),
      detachDebugger: vi.fn(),
      revokeDebugger: vi.fn(async () => undefined),
      restoreDebugger: vi.fn(async () => undefined),
      scheduleTabsSync: vi.fn(),
      gateway: gateway as never,
    });
    await controller.initialize();
    await controller.registry.put(1, { gatewayScope: oldScope, sessionKey: "session-old" });
    await controller.registry.startRun(1, oldScope, "run-old");

    reportStatus?.({ state: "ready", label: "Connected" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const reconfigure = controller.refreshConfig();
    await Promise.resolve();
    expect(getConfig).toHaveBeenCalledTimes(1);

    releaseAbort?.();
    await reconfigure;
    expect(getConfig).toHaveBeenCalledTimes(2);
    expect(gateway.start).toHaveBeenLastCalledWith(newScope);
  });

  it("does not strand the controller when old-scope storage cleanup fails", async () => {
    const oldScope = "ws://127.0.0.1:18789/";
    const newScope = "ws://127.0.0.1:28789/";
    const gateway = {
      ready: true,
      onEvent: vi.fn(),
      onStatus: vi.fn(),
      request: vi.fn(async () => ({ ok: true })),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const getConfig = vi
      .fn()
      .mockResolvedValueOnce({
        relayUrl: "ws://127.0.0.1:18792/browser/extension",
        gatewayUrl: oldScope,
      })
      .mockResolvedValue({
        relayUrl: "ws://127.0.0.1:28792/browser/extension",
        gatewayUrl: newScope,
      });
    const controller = createCopilotController({
      chromeApi: {
        runtime: { onConnect: eventHook() },
        tabs: { query: vi.fn(async () => []) },
        storage: { local: storageArea(), session: storageArea() },
      } as never,
      getConfig,
      isTabShared: vi.fn(),
      addTabToOpenClawGroup: vi.fn(),
      attachDebugger: vi.fn(),
      detachDebugger: vi.fn(),
      revokeDebugger: vi.fn(async () => undefined),
      restoreDebugger: vi.fn(async () => undefined),
      scheduleTabsSync: vi.fn(),
      gateway: gateway as never,
    });
    await controller.initialize();
    vi.spyOn(controller.registry, "closeScope").mockRejectedValueOnce(
      new Error("storage unavailable"),
    );

    await expect(controller.refreshConfig()).resolves.toBeUndefined();
    expect(gateway.stop).toHaveBeenCalled();
    expect(gateway.start).toHaveBeenLastCalledWith(newScope);
    await expect(controller.refreshConfig()).resolves.toBeUndefined();
  });

  it("processes an observed revocation before a later re-share", async () => {
    const gatewayScope = "ws://127.0.0.1:18789/";
    const revokeDebugger = vi.fn(async () => undefined);
    const gateway = {
      ready: false,
      onEvent: vi.fn(),
      onStatus: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const controller = createCopilotController({
      chromeApi: {
        runtime: { onConnect: eventHook() },
        tabs: {
          query: vi.fn(async () => [{ id: 12 }]),
          get: vi.fn(async () => ({ id: 12, title: "Fixture", url: "https://example.test" })),
        },
        storage: { local: storageArea(), session: storageArea() },
      } as never,
      getConfig: vi.fn(async () => ({
        relayUrl: "ws://127.0.0.1:18792/browser/extension",
        gatewayUrl: gatewayScope,
      })),
      isTabShared: vi.fn(async () => true),
      addTabToOpenClawGroup: vi.fn(),
      attachDebugger: vi.fn(),
      detachDebugger: vi.fn(),
      revokeDebugger,
      restoreDebugger: vi.fn(async () => undefined),
      scheduleTabsSync: vi.fn(),
      gateway: gateway as never,
    });
    await controller.initialize();
    await controller.registry.put(12, { gatewayScope, sessionKey: "session-12" });
    await controller.registry.startRun(12, gatewayScope, "run-12");

    const revoked = controller.onConsentChanged(12, { revoked: true });
    const reshared = controller.onConsentChanged(12);
    await Promise.all([revoked, reshared]);

    expect(revokeDebugger).toHaveBeenCalledWith(12);
    expect(controller.registry.pendingAborts(gatewayScope)).toEqual([
      expect.objectContaining({ activeRunId: "run-12", abortPending: true }),
    ]);
  });

  it("keeps ordinary active runs visible and gates only abort reconciliation", () => {
    expect(
      selectCopilotPanelState({
        paired: true,
        shared: true,
        abortPending: false,
        gatewayState: "ready",
      }),
    ).toBe("ready");
    expect(
      selectCopilotPanelState({
        paired: true,
        shared: true,
        abortPending: true,
        gatewayState: "ready",
      }),
    ).toBe("reconciling");
  });

  it("revokes an active debugger binding as soon as the Gateway disconnects", async () => {
    let reportStatus: ((status: Record<string, unknown>) => void) | undefined;
    const revokeDebugger = vi.fn(async () => undefined);
    const gateway = {
      ready: false,
      onEvent: vi.fn(),
      onStatus: vi.fn((listener) => {
        reportStatus = listener;
      }),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const controller = createCopilotController({
      chromeApi: {
        runtime: { onConnect: eventHook() },
        tabs: { query: vi.fn(async () => [{ id: 12 }]) },
        storage: { local: storageArea(), session: storageArea() },
      } as never,
      getConfig: vi.fn(async () => ({
        relayUrl: "ws://127.0.0.1:18792/browser/extension",
        gatewayUrl: "ws://127.0.0.1:18789",
      })),
      isTabShared: vi.fn(),
      addTabToOpenClawGroup: vi.fn(),
      attachDebugger: vi.fn(),
      detachDebugger: vi.fn(),
      revokeDebugger,
      restoreDebugger: vi.fn(),
      scheduleTabsSync: vi.fn(),
      gateway: gateway as never,
    });
    await controller.initialize();
    const gatewayScope = "ws://127.0.0.1:18789/";
    await controller.registry.put(12, {
      gatewayScope,
      sessionKey: "session-12",
    });
    await controller.registry.startRun(12, gatewayScope, "run-12");

    reportStatus?.({ state: "connecting", label: "Gateway reconnecting" });

    await vi.waitFor(() => expect(revokeDebugger).toHaveBeenCalledWith(12));
    expect(controller.registry.pendingAborts(gatewayScope)).toEqual([
      expect.objectContaining({ activeRunId: "run-12", abortPending: true }),
    ]);
  });

  it("revokes and aborts active custody when the browser relay disconnects", async () => {
    const gatewayScope = "ws://127.0.0.1:18789/";
    const revokeDebugger = vi.fn(async () => undefined);
    const request = vi.fn(async () => ({ ok: true }));
    const gateway = {
      ready: true,
      onEvent: vi.fn(),
      onStatus: vi.fn(),
      request,
      start: vi.fn(),
      stop: vi.fn(),
    };
    const controller = createCopilotController({
      chromeApi: {
        runtime: { onConnect: eventHook() },
        tabs: { query: vi.fn(async () => [{ id: 12 }]) },
        storage: { local: storageArea(), session: storageArea() },
      } as never,
      getConfig: vi.fn(async () => ({
        relayUrl: "ws://127.0.0.1:18792/browser/extension",
        gatewayUrl: gatewayScope,
      })),
      isTabShared: vi.fn(),
      addTabToOpenClawGroup: vi.fn(),
      attachDebugger: vi.fn(),
      detachDebugger: vi.fn(),
      revokeDebugger,
      restoreDebugger: vi.fn(async () => undefined),
      scheduleTabsSync: vi.fn(),
      gateway: gateway as never,
    });
    await controller.initialize();
    await controller.onRelayStatus({ ready: true, label: "Browser relay connected" });
    await controller.registry.put(12, { gatewayScope, sessionKey: "session-12" });
    await controller.registry.startRun(12, gatewayScope, "run-12");

    await controller.onRelayStatus({ ready: false, label: "Browser relay reconnecting" });

    expect(revokeDebugger).toHaveBeenCalledWith(12);
    expect(request).toHaveBeenCalledWith("sessions.abort", {
      key: "session-12",
      runId: "run-12",
    });
    expect(controller.registry.pendingAborts(gatewayScope)).toEqual([]);
  });

  it("restores durable debugger denial before a suspended worker reconnects", async () => {
    const gatewayScope = "ws://127.0.0.1:18789/";
    const revokeDebugger = vi.fn(async () => undefined);
    const gateway = {
      onEvent: vi.fn(),
      onStatus: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const controller = createCopilotController({
      chromeApi: {
        runtime: { onConnect: eventHook() },
        tabs: { query: vi.fn(async () => [{ id: 12 }]) },
        storage: {
          local: storageArea({
            copilotSessionRegistryV1: {
              sessions: {
                12: {
                  tabId: 12,
                  browserInstanceId: "browser-instance",
                  gatewayScope,
                  sessionKey: "session-12",
                  activeRunId: "run-12",
                },
              },
              pendingArchives: [],
            },
          }),
          session: storageArea({ copilotBrowserInstanceV1: "browser-instance" }),
        },
      } as never,
      getConfig: vi.fn(async () => ({
        relayUrl: "ws://127.0.0.1:18792/browser/extension",
        gatewayUrl: "ws://127.0.0.1:18789",
      })),
      isTabShared: vi.fn(),
      addTabToOpenClawGroup: vi.fn(),
      attachDebugger: vi.fn(),
      detachDebugger: vi.fn(),
      revokeDebugger,
      restoreDebugger: vi.fn(),
      scheduleTabsSync: vi.fn(),
      gateway: gateway as never,
    });

    await controller.initialize();

    expect(revokeDebugger).toHaveBeenCalledWith(12);
    expect(controller.registry.pendingAborts(gatewayScope)).toEqual([
      expect.objectContaining({ activeRunId: "run-12", abortPending: true }),
    ]);
  });

  it("starts the configured Gateway while cleaning a persisted old scope separately", async () => {
    const oldScope = "ws://127.0.0.1:18789/";
    const request = vi.fn(async () => ({ ok: true }));
    let reportRecoveryStatus: ((status: Record<string, unknown>) => void) | undefined;
    const recoveryGateway = {
      onStatus: vi.fn((listener) => {
        reportRecoveryStatus = listener;
        return vi.fn();
      }),
      request,
      start: vi.fn(() => reportRecoveryStatus?.({ state: "ready" })),
      stop: vi.fn(),
    };
    const gateway = {
      onEvent: vi.fn(),
      onStatus: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const restoreDebugger = vi.fn(async () => undefined);
    const controller = createCopilotController({
      chromeApi: {
        runtime: { onConnect: eventHook() },
        tabs: { query: vi.fn(async () => [{ id: 14 }]) },
        storage: {
          local: storageArea({
            copilotSessionRegistryV1: {
              sessions: {
                14: {
                  tabId: 14,
                  browserInstanceId: "browser-instance",
                  gatewayScope: oldScope,
                  sessionKey: "session-old",
                  activeRunId: "run-old",
                },
              },
              pendingArchives: [],
            },
          }),
          session: storageArea({ copilotBrowserInstanceV1: "browser-instance" }),
        },
      } as never,
      getConfig: vi.fn(async () => ({
        relayUrl: "ws://127.0.0.1:28792/browser/extension",
        gatewayUrl: "ws://127.0.0.1:28789",
      })),
      isTabShared: vi.fn(),
      addTabToOpenClawGroup: vi.fn(),
      attachDebugger: vi.fn(),
      detachDebugger: vi.fn(),
      revokeDebugger: vi.fn(async () => undefined),
      restoreDebugger,
      scheduleTabsSync: vi.fn(),
      gateway: gateway as never,
      recoveryGatewayFactory: () => recoveryGateway as never,
    });

    await controller.initialize();

    expect(gateway.start).toHaveBeenCalledWith("ws://127.0.0.1:28789/");
    expect(recoveryGateway.start).not.toHaveBeenCalled();
    await controller.drainStaleScopes();
    expect(recoveryGateway.start).toHaveBeenCalledWith(oldScope);
    expect(request.mock.calls).toEqual([
      ["sessions.abort", { key: "session-old", runId: "run-old" }],
      ["sessions.messages.unsubscribe", { key: "session-old" }],
      ["sessions.abort", { key: "session-old" }],
      ["sessions.patch", { key: "session-old", archived: true }],
    ]);
    expect(restoreDebugger).toHaveBeenCalledWith(14);
    expect(controller.registry.gatewayScopes()).toEqual([]);
  });

  it("accepts only capability-bound live side-panel contexts", async () => {
    const chromeApi = {
      runtime: {
        id: "extension-id",
        getContexts: vi.fn(async () => [
          {
            contextType: "SIDE_PANEL",
            documentId: "doc-a",
            documentUrl: "chrome-extension://extension-id/sidepanel.html?binding=cap-a",
            tabId: -1,
          },
        ]),
      },
    };
    const panelBindings = { resolve: vi.fn(async (token) => (token === "cap-a" ? 12 : null)) };
    await expect(
      resolveSidePanelTabId(
        chromeApi as never,
        {
          sender: {
            documentId: "doc-a",
            url: "chrome-extension://extension-id/sidepanel.html?binding=cap-a",
          },
        } as never,
        panelBindings as never,
      ),
    ).resolves.toBe(12);
    await expect(
      resolveSidePanelTabId(
        chromeApi as never,
        {
          sender: {
            url: "chrome-extension://extension-id/sidepanel.html?binding=forged",
          },
        } as never,
        panelBindings as never,
      ),
    ).rejects.toThrow("live tab binding");
  });

  it("prepares a unique tab-specific panel path without a global option", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("44444444-4444-4444-8444-444444444444");
    const gateway = {
      onEvent: vi.fn(),
      onStatus: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const chromeApi = {
      runtime: { onConnect: eventHook() },
      tabs: { get: vi.fn(async () => ({ id: 44 })) },
      storage: { local: storageArea(), session: storageArea() },
    };
    const controller = createCopilotController({
      chromeApi: chromeApi as never,
      getConfig: vi.fn(),
      isTabShared: vi.fn(),
      addTabToOpenClawGroup: vi.fn(),
      attachDebugger: vi.fn(),
      detachDebugger: vi.fn(),
      revokeDebugger: vi.fn(),
      restoreDebugger: vi.fn(),
      scheduleTabsSync: vi.fn(),
      gateway: gateway as never,
    });

    await expect(controller.preparePanel(44)).resolves.toEqual({
      path: "sidepanel.html?binding=44444444-4444-4444-8444-444444444444",
    });
  });

  it("stops delivery and archives after aborting active work", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    await archiveCopilotSession(
      { request } as never,
      { sessionKey: "session-7", sessionId: "id-7" } as never,
    );
    expect(request.mock.calls).toEqual([
      ["sessions.messages.unsubscribe", { key: "session-7" }],
      ["sessions.abort", { key: "session-7" }],
      ["sessions.patch", { key: "session-7", archived: true }],
    ]);
  });

  it("still attempts the authoritative archive when unsubscribe and abort fail", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket allowlist already gone"))
      .mockRejectedValueOnce(new Error("no active run"))
      .mockResolvedValueOnce({ ok: true });
    await expect(
      archiveCopilotSession(
        { request } as never,
        { sessionKey: "session-8", sessionId: "id-8" } as never,
      ),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenLastCalledWith("sessions.patch", {
      key: "session-8",
      archived: true,
    });
  });

  it("replays ambiguous session creation before archiving its key", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    await archiveCopilotSession(
      { request } as never,
      { sessionKey: "session-pending", ensureCreated: true } as never,
    );
    expect(request.mock.calls).toEqual([
      ["sessions.create", { key: "session-pending", label: "Browser copilot" }],
      ["sessions.messages.unsubscribe", { key: "session-pending" }],
      ["sessions.abort", { key: "session-pending" }],
      ["sessions.patch", { key: "session-pending", archived: true }],
    ]);
  });
});
