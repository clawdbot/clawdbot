import { describe, expect, it, vi } from "vitest";
import { createCopilotSessionController } from "./copilot-session.js";

function createHarness(accessible: boolean) {
  const gatewayScope = "ws://127.0.0.1:18789/";
  const entry = {
    tabId: 41,
    gatewayScope,
    sessionKey: "agent:main:main:thread:browser-copilot-11111111-1111-4111-8111-111111111111",
    sessionId: "session-id",
    provisional: false,
    binding: undefined as Record<string, unknown> | undefined,
  };
  let present = false;
  const registry = {
    list: vi.fn(() => (present ? [entry] : [])),
    get: vi.fn(() => (present ? entry : null)),
    put: vi.fn(async (_tabId: number, value: Record<string, unknown>) => {
      present = true;
      Object.assign(entry, value, { tabId: 41 });
      return entry;
    }),
    updateBinding: vi.fn(
      async (_tabId: number, _scope: string, binding: Record<string, unknown>) => {
        entry.binding = binding;
      },
    ),
    markSessionCreationPending: vi.fn(async () => entry),
    confirmSession: vi.fn(async () => {
      entry.provisional = false;
      return entry;
    }),
    closeTab: vi.fn(),
  };
  const request = vi.fn(async (method: string) =>
    method === "sessions.create" ? { sessionId: "session-id" } : {},
  );
  const gateway = {
    ready: true,
    hello: { snapshot: { sessionDefaults: { mainSessionKey: "agent:main:main" } } },
    request,
  };
  const attachDebugger = vi.fn(async () => ({ targetId: "target-41" }));
  const portsByTab = new Map([[41, new Set([{}])]]);
  const controller = createCopilotSessionController({
    chromeApi: { tabs: { get: vi.fn(async () => ({ id: 41 })) } },
    gateway,
    registry: registry as never,
    ensureByTab: new Map(),
    tabRevisions: new Map(),
    portsByTab,
    portRevisions: new Map(),
    sendsByTab: new Set(),
    currentGatewayScope: () => gatewayScope,
    getGatewayRevision: () => 1,
    getCurrentConfig: () => ({
      relayUrl: "ws://127.0.0.1:18797/extension",
      gatewayUrl: gatewayScope,
    }),
    isConfigTransitioning: () => false,
    currentReadyEpoch: () => ({ gatewayScope, configRevision: 1, statusRevision: 1 }),
    readyEpochIsCurrent: () => true,
    isTabAccessible: vi.fn(async () => accessible),
    attachDebugger,
    revokeDebugger: vi.fn(),
    restoreDebuggerIfReleased: vi.fn(),
    subscribe: vi.fn(async () => undefined),
    unsubscribeTab: vi.fn(),
    suspendTab: vi.fn(),
    hydrate: vi.fn(),
    refreshPanelState: vi.fn(),
    drainArchives: vi.fn(),
    scheduleAbortRetry: vi.fn(),
  });
  return { attachDebugger, controller, request };
}

describe("tab copilot access policy", () => {
  it("prepares a session for an access-authorized ungrouped all-mode tab", async () => {
    const harness = createHarness(true);
    await expect(harness.controller.ensureSession(41)).resolves.toMatchObject({
      tabId: 41,
      binding: expect.objectContaining({ kind: "tab", tabId: 41, targetId: "target-41" }),
    });
    expect(harness.attachDebugger).toHaveBeenCalledWith(41);
    expect(harness.request).toHaveBeenCalledWith(
      "sessions.create",
      expect.objectContaining({ key: expect.stringContaining("browser-copilot") }),
    );
  });

  it.each(["paused", "restricted"])("does not attach a %s tab", async () => {
    const harness = createHarness(false);
    await expect(harness.controller.ensureSession(41)).resolves.toBeNull();
    expect(harness.attachDebugger).not.toHaveBeenCalled();
  });
});
