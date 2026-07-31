import { describe, expect, it, vi } from "vitest";
import { archiveCopilotSession } from "./copilot-background-shared.js";
import { CopilotPanelBindingRegistry, CopilotSessionRegistry } from "./copilot-session-registry.js";
import { createCopilotSessionController } from "./copilot-session.js";

const GATEWAY_SCOPE = "ws://127.0.0.1:18789/";

function storageArea(initial: Record<string, unknown> = {}) {
  const values = { ...initial };
  const setCalls: Record<string, unknown>[] = [];
  return {
    setCalls,
    values,
    async get(keys: string[]) {
      return Object.fromEntries(keys.map((key) => [key, values[key]]));
    },
    async set(update: Record<string, unknown>) {
      setCalls.push(update);
      Object.assign(values, update);
    },
  };
}

function storage(localInitial: Record<string, unknown> = {}, sessionInitial = {}) {
  return { local: storageArea(localInitial), session: storageArea(sessionInitial) };
}

describe("CopilotSessionRegistry", () => {
  it("archives prior-browser and missing-tab sessions during recovery", async () => {
    const mock = storage(
      {
        copilotSessionRegistryV1: {
          sessions: {
            1: {
              browserInstanceId: "old",
              gatewayScope: GATEWAY_SCOPE,
              sessionKey: "session-old",
              sessionId: "id-old",
            },
            2: {
              browserInstanceId: "current",
              gatewayScope: GATEWAY_SCOPE,
              sessionKey: "session-closed",
              sessionId: "id-closed",
            },
            3: {
              browserInstanceId: "current",
              gatewayScope: GATEWAY_SCOPE,
              sessionKey: "session-live",
              sessionId: "id-live",
            },
          },
          pendingArchives: [],
        },
      },
      { copilotBrowserInstanceV1: "current" },
    );
    const registry = new CopilotSessionRegistry(mock as never);

    await registry.initialize(new Set([1, 3]));

    expect(registry.get(1, GATEWAY_SCOPE)).toBeNull();
    expect(registry.get(2, GATEWAY_SCOPE)).toBeNull();
    expect(registry.get(3, GATEWAY_SCOPE)?.sessionKey).toBe("session-live");
    expect(registry.pendingArchives(GATEWAY_SCOPE).map((entry) => entry.sessionKey)).toEqual([
      "session-old",
      "session-closed",
    ]);
  });

  it("creates a uniquely labeled session after archiving a prior browser instance", async () => {
    const oldSessionKey =
      "agent:main:main:thread:browser-copilot-11111111-1111-4111-8111-111111111111";
    const oldSessionLabel = "Browser copilot";
    const newSessionUuid = "22222222-2222-4222-8222-222222222222";
    const newSessionKey = `agent:main:main:thread:browser-copilot-${newSessionUuid}`;
    const mock = storage(
      {
        copilotSessionRegistryV1: {
          sessions: {
            7: {
              tabId: 7,
              browserInstanceId: "old",
              gatewayScope: GATEWAY_SCOPE,
              sessionKey: oldSessionKey,
              sessionId: "id-old",
            },
          },
          pendingArchives: [],
        },
      },
      { copilotBrowserInstanceV1: "new" },
    );
    const labels = new Map([[oldSessionLabel, oldSessionKey]]);
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method !== "sessions.create") {
        return { ok: true };
      }
      const key = String(params.key);
      const label = String(params.label);
      const existingKey = labels.get(label);
      if (existingKey && existingKey !== key) {
        throw new Error(`label already in use: ${label}`);
      }
      labels.set(label, key);
      return { sessionId: "id-new" };
    });
    const gateway = {
      ready: true,
      hello: { snapshot: { sessionDefaults: { mainSessionKey: "agent:main:main" } } },
      request,
    };
    const registry = new CopilotSessionRegistry(mock as never);
    await registry.initialize(new Set([7]));
    const [archive] = registry.pendingArchives(GATEWAY_SCOPE);
    if (!archive) {
      throw new Error("expected the prior browser session to be pending archival");
    }
    expect(archive.sessionKey).toBe(oldSessionKey);
    await archiveCopilotSession(gateway, archive);
    await registry.resolveArchive(GATEWAY_SCOPE, oldSessionKey);

    vi.spyOn(crypto, "randomUUID").mockReturnValue(newSessionUuid);
    const controller = createCopilotSessionController({
      chromeApi: { tabs: { get: vi.fn(async () => ({ id: 7 })) } },
      gateway,
      registry,
      ensureByTab: new Map(),
      tabRevisions: new Map(),
      portsByTab: new Map([[7, new Set([{}])]]),
      portRevisions: new Map(),
      sendsByTab: new Set(),
      currentGatewayScope: () => GATEWAY_SCOPE,
      getGatewayRevision: () => 0,
      getCurrentConfig: () => ({
        relayUrl: "ws://127.0.0.1:18792/browser/extension",
        gatewayUrl: GATEWAY_SCOPE,
      }),
      isConfigTransitioning: () => false,
      currentReadyEpoch: () => ({ gatewayScope: GATEWAY_SCOPE, configRevision: 0 }),
      readyEpochIsCurrent: () => true,
      isTabShared: vi.fn(async () => true),
      attachDebugger: vi.fn(async () => ({ targetId: "target-7" })),
      revokeDebugger: vi.fn(),
      restoreDebuggerIfReleased: vi.fn(),
      subscribe: vi.fn(async () => undefined),
      unsubscribeTab: vi.fn(),
      suspendTab: vi.fn(),
      hydrate: vi.fn(),
      refreshPanelState: vi.fn(),
      drainArchives: vi.fn(),
      scheduleAbortRetry: vi.fn(),
    } as never);

    await expect(controller.ensureSession(7, { hydrateHistory: false })).resolves.toMatchObject({
      sessionKey: newSessionKey,
      sessionId: "id-new",
    });
    expect(labels).toEqual(
      new Map([
        [oldSessionLabel, oldSessionKey],
        [`Browser copilot ${newSessionUuid}`, newSessionKey],
      ]),
    );
  });

  it("moves a closed tab to the durable archive queue exactly once", async () => {
    const mock = storage();
    const registry = new CopilotSessionRegistry(mock as never);
    await registry.initialize(new Set([8]));
    await registry.put(8, {
      gatewayScope: GATEWAY_SCOPE,
      sessionKey: "session-8",
      sessionId: "id-8",
    });

    await registry.closeTab(8);
    await registry.closeTab(8);

    expect(registry.get(8, GATEWAY_SCOPE)).toBeNull();
    expect(registry.pendingArchives(GATEWAY_SCOPE)).toEqual([
      expect.objectContaining({ sessionKey: "session-8", tabId: 8 }),
    ]);
    await registry.resolveArchive(GATEWAY_SCOPE, "session-8");
    expect(registry.pendingArchives(GATEWAY_SCOPE)).toEqual([]);
  });

  it("keeps a provisional session key until Gateway creation is confirmed", async () => {
    const mock = storage();
    const registry = new CopilotSessionRegistry(mock as never);
    await registry.initialize(new Set([11]));
    await registry.put(11, {
      gatewayScope: GATEWAY_SCOPE,
      sessionKey: "session-provisional",
      provisional: true,
    });

    expect(registry.get(11, GATEWAY_SCOPE)).toMatchObject({
      provisional: true,
      sessionKey: "session-provisional",
    });
    await registry.markSessionCreationPending(11, GATEWAY_SCOPE);
    expect(registry.get(11, GATEWAY_SCOPE)).toMatchObject({ creationPending: true });
    await registry.confirmSession(11, GATEWAY_SCOPE, "id-provisional");
    expect(registry.get(11, GATEWAY_SCOPE)).toMatchObject({
      sessionId: "id-provisional",
      sessionKey: "session-provisional",
    });
    expect(registry.get(11, GATEWAY_SCOPE)).not.toHaveProperty("provisional");
    expect(registry.get(11, GATEWAY_SCOPE)).not.toHaveProperty("creationPending");
  });

  it("archives a provisional key only after its creation RPC can have reached Gateway", async () => {
    const mock = storage();
    const registry = new CopilotSessionRegistry(mock as never);
    await registry.initialize(new Set([11, 12]));
    await registry.put(11, {
      gatewayScope: GATEWAY_SCOPE,
      sessionKey: "session-not-attempted",
      provisional: true,
      creationPending: false,
    });
    await registry.closeTab(11);
    expect(registry.pendingArchives(GATEWAY_SCOPE)).toEqual([]);

    await registry.put(12, {
      gatewayScope: GATEWAY_SCOPE,
      sessionKey: "session-attempted",
      provisional: true,
      creationPending: false,
    });
    await registry.markSessionCreationPending(12, GATEWAY_SCOPE);
    await registry.closeTab(12);
    expect(registry.pendingArchives(GATEWAY_SCOPE)).toEqual([
      expect.objectContaining({
        sessionKey: "session-attempted",
        tabId: 12,
        ensureCreated: true,
      }),
    ]);
  });

  it("drops a definitively rejected provisional session without archiving it", async () => {
    const mock = storage();
    const registry = new CopilotSessionRegistry(mock as never);
    await registry.initialize(new Set([13]));
    await registry.put(13, {
      gatewayScope: GATEWAY_SCOPE,
      sessionKey: "session-rejected",
      provisional: true,
      creationPending: true,
    });

    await expect(registry.discardProvisionalSession(13, GATEWAY_SCOPE)).resolves.toBe(true);
    expect(registry.get(13, GATEWAY_SCOPE)).toBeNull();
    expect(registry.pendingArchives(GATEWAY_SCOPE)).toEqual([]);
  });

  it("never reuses or drains session custody across Gateways", async () => {
    const mock = storage();
    const registry = new CopilotSessionRegistry(mock as never);
    const otherGateway = "ws://127.0.0.1:28789/";
    await registry.initialize(new Set([9]));
    await registry.put(9, {
      gatewayScope: GATEWAY_SCOPE,
      sessionKey: "session-a",
    });
    await registry.put(9, {
      gatewayScope: otherGateway,
      sessionKey: "session-b",
    });

    expect(registry.get(9, GATEWAY_SCOPE)).toBeNull();
    expect(registry.get(9, otherGateway)?.sessionKey).toBe("session-b");
    expect(registry.pendingArchives(otherGateway)).toEqual([]);
    expect(registry.pendingArchives(GATEWAY_SCOPE).map((entry) => entry.sessionKey)).toEqual([
      "session-a",
    ]);
    await registry.resolveArchive(otherGateway, "session-a");
    expect(registry.pendingArchives(GATEWAY_SCOPE)).toHaveLength(1);
    await registry.resolveArchive(GATEWAY_SCOPE, "session-a");
    expect(registry.pendingArchives(GATEWAY_SCOPE)).toEqual([]);
  });

  it("persists active-run cancellation until the owning Gateway resolves it", async () => {
    const mock = storage();
    const registry = new CopilotSessionRegistry(mock as never);
    await registry.initialize(new Set([10]));
    await registry.put(10, {
      gatewayScope: GATEWAY_SCOPE,
      sessionKey: "session-10",
    });

    await expect(registry.startRun(10, GATEWAY_SCOPE, "run-10")).resolves.toMatchObject({
      activeRunId: "run-10",
    });
    await registry.queueActiveAborts(GATEWAY_SCOPE);
    expect(registry.pendingAborts(GATEWAY_SCOPE)).toEqual([
      expect.objectContaining({
        abortPending: true,
        activeRunId: "run-10",
        sessionKey: "session-10",
      }),
    ]);
    await expect(registry.finishRun(GATEWAY_SCOPE, "session-10", "stale-run")).resolves.toBe(false);
    expect(registry.pendingAborts(GATEWAY_SCOPE)).toHaveLength(1);
    await expect(registry.finishRun(GATEWAY_SCOPE, "session-10", "run-10")).resolves.toBe(true);
    expect(registry.pendingAborts(GATEWAY_SCOPE)).toEqual([]);
  });
});

describe("CopilotPanelBindingRegistry", () => {
  it("mints one browser-instance capability per tab and removes it on close", async () => {
    const area = storageArea();
    const bindings = new CopilotPanelBindingRegistry(area as never);

    const [first, second] = await Promise.all([bindings.bind(7), bindings.bind(7)]);

    expect(first).toBe(second);
    expect(area.setCalls).toHaveLength(1);
    await expect(bindings.bind(7)).resolves.toBe(first);
    expect(area.setCalls).toHaveLength(1);
    await expect(bindings.resolve(first)).resolves.toBe(7);
    await bindings.remove(7);
    await expect(bindings.resolve(first)).resolves.toBeNull();
  });
});
