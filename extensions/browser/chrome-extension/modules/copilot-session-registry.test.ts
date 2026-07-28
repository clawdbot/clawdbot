import { describe, expect, it } from "vitest";
import { CopilotPanelBindingRegistry, CopilotSessionRegistry } from "./copilot-session-registry.js";

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
