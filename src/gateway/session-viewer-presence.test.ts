import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listSystemPresence } from "../infra/system-presence.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { createSessionViewerPresenceDeclarations } from "./session-viewer-presence.js";

function createDeclarations() {
  const client: GatewayWsClient = {
    connId: "conn-a",
    presenceKey: "viewer-timing",
    usesSharedGatewayAuth: false,
    socket: { readyState: 1 } as GatewayWsClient["socket"],
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
    },
    authenticatedUserId: "viewer@timing.test",
    personPresence: { onlineSince: Date.now() - 1_000 },
  };
  const clients = new GatewayClientRegistry([client]);
  const broadcast = vi.fn();
  const incrementPresenceVersion = vi.fn(() => 2);
  const declarations = createSessionViewerPresenceDeclarations({
    clients,
    broadcast,
    incrementPresenceVersion,
    getHealthVersion: () => 1,
  });
  const row = () => listSystemPresence().find((entry) => entry.user?.id === "viewer@timing.test");
  return { declarations, client, clients, broadcast, incrementPresenceVersion, row };
}

describe("session viewer presence declarations", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2041-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.setSystemTime(Date.now() + 300_001);
    listSystemPresence();
    vi.useRealTimers();
  });

  it("replaces rather than accumulates connection session keys", () => {
    const { declarations, broadcast, row } = createDeclarations();

    expect(declarations.replace("conn-a", [" beta ", "alpha", "beta"])).toEqual(["alpha", "beta"]);
    expect(row()?.watchedSessions).toEqual(["alpha", "beta"]);
    vi.setSystemTime(Date.now() + 1_000);
    expect(declarations.replace("conn-a", ["gamma"])).toEqual(["gamma"]);
    expect(row()).toMatchObject({ watchedSessions: ["gamma"], lastActivityAt: Date.now() });
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it("publishes an empty declaration and forgets state on disconnect", () => {
    const { declarations, broadcast, row } = createDeclarations();

    declarations.replace("conn-a", ["alpha"]);
    const activity = row()?.lastActivityAt;
    vi.setSystemTime(Date.now() + 1_000);
    declarations.replace("conn-a", []);
    expect(row()?.watchedSessions).toBeUndefined();
    expect(row()?.lastActivityAt).toBe(activity);
    declarations.replace("conn-a", ["beta"]);
    const nextActivity = row()?.lastActivityAt;
    vi.setSystemTime(Date.now() + 1_000);
    declarations.unsubscribe("conn-a");
    expect(row()?.lastActivityAt).toBe(nextActivity);
    declarations.replace("conn-a", ["beta"]);
    expect(row()?.lastActivityAt).toBe(Date.now());
    expect(broadcast).toHaveBeenCalledTimes(4);
  });

  it("does not republish an unchanged set", () => {
    const { declarations, broadcast, incrementPresenceVersion, row } = createDeclarations();

    declarations.replace("conn-a", ["beta", "alpha"]);
    const activity = row()?.lastActivityAt;
    vi.setSystemTime(Date.now() + 1_000);
    declarations.replace("conn-a", ["alpha", "beta"]);

    expect(row()?.lastActivityAt).toBe(activity);
    expect(broadcast).toHaveBeenCalledOnce();
    expect(incrementPresenceVersion).toHaveBeenCalledOnce();
  });

  it("rejects declarations from inactive connections and after stop", () => {
    const { declarations, client, clients, broadcast } = createDeclarations();
    client.invalidated = true;
    expect(declarations.replace("conn-a", ["alpha"])).toEqual([]);
    client.invalidated = false;
    clients.delete(client);
    expect(declarations.replace("conn-a", ["alpha"])).toEqual([]);
    clients.add(client);
    declarations.stop();
    expect(declarations.replace("conn-a", ["alpha"])).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
