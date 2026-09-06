// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createTestSessionCapability } from "./session-capability.test-support.ts";
import type { SessionGateway } from "./session-capability.ts";

function createGateway(request: ReturnType<typeof vi.fn>, scopes: string[]): SessionGateway {
  const client = { request } as unknown as GatewayBrowserClient;
  return {
    snapshot: {
      client,
      phase: "connected",
      sessionKey: "agent:main:main",
      assistantAgentId: "main",
      hello: {
        auth: { role: "operator", scopes },
        features: {
          methods: ["sessions.groups.list", "sessions.groups.defaults", "sessions.groups.put"],
        },
      } as GatewayHelloOk,
    },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  };
}

function createGatewayHarness(request: ReturnType<typeof vi.fn>, scopes: string[]) {
  const gateway = createGateway(request, scopes);
  let snapshot = gateway.snapshot;
  const listeners = new Set<(next: SessionGateway["snapshot"]) => void>();
  return {
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (next: SessionGateway["snapshot"]) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      subscribeEvents: () => () => undefined,
    } satisfies SessionGateway,
    publish(connected: boolean) {
      snapshot = { ...snapshot, phase: connected ? "connected" : "stopped" };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("legacy session group migration", () => {
  it("does not migrate browser groups without operator.write", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    localStorage.setItem("openclaw:sessions:custom-groups", JSON.stringify(["Research"]));
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.groups.list") {
        return { groups: [] };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const sessions = createTestSessionCapability(createGateway(request, ["operator.read"]));

    await sessions.groupsLoad();

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("sessions.groups.list", {});
    expect(localStorage.getItem("openclaw:sessions:custom-groups")).toBe(
      JSON.stringify(["Research"]),
    );
    sessions.dispose();
  });

  it("migrates browser groups with operator.write", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    localStorage.setItem("openclaw:sessions:custom-groups", JSON.stringify(["Research"]));
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.groups.list") {
        return { groups: [] };
      }
      if (method === "sessions.groups.put") {
        return { groups: [{ name: "Research" }] };
      }
      if (method === "sessions.groups.defaults") {
        return { defaults: [{ name: "Research" }] };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const sessions = createTestSessionCapability(createGateway(request, ["operator.write"]));

    await sessions.groupsLoad();

    expect(request).toHaveBeenCalledWith("sessions.groups.put", { names: ["Research"] });
    expect(sessions.state.groups).toEqual(["Research"]);
    expect(localStorage.getItem("openclaw:sessions:custom-groups")).toBeNull();
    sessions.dispose();
  });
});

describe("session group catalog loading", () => {
  it("clears cached cwd when a defaults update omits the removed value", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.groups.list") {
        return { groups: [{ name: "Client", position: 0 }] };
      }
      if (method === "sessions.groups.defaults") {
        return { defaults: [{ name: "Client", cwd: "/repos/client", worktree: true }] };
      }
      if (method === "sessions.groups.update") {
        return { defaults: [{ name: "Client", worktree: false }] };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const gateway = createGateway(request, ["operator.write"]);
    gateway.snapshot.hello = {
      ...gateway.snapshot.hello,
      features: {
        methods: ["sessions.groups.list", "sessions.groups.defaults", "sessions.groups.update"],
      },
    } as GatewayHelloOk;
    const sessions = createTestSessionCapability(gateway);

    await sessions.groupsLoad();
    expect(sessions.state.groupSettings).toEqual([
      { name: "Client", position: 0, cwd: "/repos/client", worktree: true },
    ]);

    await expect(sessions.groupsUpdate("Client", { cwd: null, worktree: false })).resolves.toBe(
      "completed",
    );
    expect(sessions.state.groupSettings).toEqual([
      { name: "Client", position: 0, worktree: false },
    ]);
    sessions.dispose();
  });

  it("keeps a loaded path-free catalog when defaults are unavailable", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.groups.list") {
        return { groups: [{ name: "Client", position: 0 }] };
      }
      if (method === "sessions.groups.defaults") {
        throw new Error("defaults unavailable");
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const sessions = createTestSessionCapability(createGateway(request, ["operator.write"]));

    await expect(sessions.groupsLoad()).resolves.toBeNull();

    expect(sessions.state.groups).toEqual(["Client"]);
    expect(sessions.state.groupSettings).toEqual([{ name: "Client", position: 0 }]);
    expect(sessions.groupsStatus()).toBe("unavailable");
    sessions.dispose();
  });

  it("keeps path-free mutations pending until fresh defaults arrive", async () => {
    const refreshedDefaults = createDeferred<{
      defaults: Array<{ name: string; cwd: string; worktree: boolean }>;
    }>();
    let defaultsCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.groups.list") {
        return { groups: [{ name: "Client", position: 0 }] };
      }
      if (method === "sessions.groups.defaults") {
        defaultsCalls += 1;
        if (defaultsCalls === 1) {
          throw new Error("defaults unavailable");
        }
        return await refreshedDefaults.promise;
      }
      if (method === "sessions.groups.put") {
        return { groups: [{ name: "Client", position: 0 }] };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const sessions = createTestSessionCapability(createGateway(request, ["operator.write"]));

    await expect(sessions.groupsLoad()).resolves.toBeNull();
    expect(sessions.groupsStatus()).toBe("unavailable");

    await expect(sessions.groupsPut(["Client"])).resolves.toBe("completed");
    await vi.waitFor(() => expect(defaultsCalls).toBe(2));
    expect(sessions.state.groups).toEqual(["Client"]);
    expect(sessions.groupsStatus()).toBe("loading");

    refreshedDefaults.resolve({
      defaults: [{ name: "Client", cwd: "/repos/client", worktree: true }],
    });
    await vi.waitFor(() => expect(sessions.groupsStatus()).toBe("ready"));
    expect(sessions.state.groupSettings).toEqual([
      { name: "Client", position: 0, cwd: "/repos/client", worktree: true },
    ]);
    sessions.dispose();
  });

  it("joins an in-flight load so route consumers see current defaults", async () => {
    const defaults = createDeferred<{
      defaults: Array<{ name: string; cwd: string; worktree: boolean }>;
    }>();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.groups.list") {
        return { groups: [{ name: "Client", position: 0 }] };
      }
      if (method === "sessions.groups.defaults") {
        return await defaults.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const sessions = createTestSessionCapability(createGateway(request, ["operator.write"]));

    const backgroundLoad = sessions.groupsLoad();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("sessions.groups.defaults", {}));
    let joined = false;
    const routeLoad = sessions.groupsLoad().then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);

    defaults.resolve({
      defaults: [{ name: "Client", cwd: "/repos/client", worktree: true }],
    });
    await Promise.all([backgroundLoad, routeLoad]);
    expect(sessions.state.groupSettings).toEqual([
      { name: "Client", position: 0, cwd: "/repos/client", worktree: true },
    ]);
    sessions.dispose();
  });

  it("returns only defaults owned by the current same-client connection", async () => {
    const stale = createDeferred<{
      defaults: Array<{ name: string; cwd: string; worktree: boolean }>;
    }>();
    const current = createDeferred<{
      defaults: Array<{ name: string; cwd: string; worktree: boolean }>;
    }>();
    let calls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method === "sessions.list") {
        return {
          ts: 1,
          path: "",
          count: 0,
          defaults: { modelProvider: null, model: null, contextTokens: null },
          sessions: [],
        };
      }
      if (method === "sessions.groups.list") {
        return { groups: [{ name: "Client", position: 0 }] };
      }
      if (method === "sessions.groups.defaults") {
        calls += 1;
        return await (calls === 1 ? stale.promise : current.promise);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const harness = createGatewayHarness(request, ["operator.write"]);
    const sessions = createTestSessionCapability(harness.gateway);

    const staleLoad = sessions.groupsLoad();
    await vi.waitFor(() => expect(calls).toBe(1));
    harness.publish(false);
    harness.publish(true);
    const currentLoad = sessions.groupsLoad();
    await vi.waitFor(() => expect(calls).toBe(2));

    stale.resolve({
      defaults: [{ name: "Client", cwd: "/gateway-a", worktree: true }],
    });
    await expect(staleLoad).resolves.toBeNull();
    current.resolve({
      defaults: [{ name: "Client", cwd: "/gateway-b", worktree: false }],
    });
    await expect(currentLoad).resolves.toEqual([
      { name: "Client", position: 0, cwd: "/gateway-b", worktree: false },
    ]);
    expect(sessions.state.groupSettings).toEqual([
      { name: "Client", position: 0, cwd: "/gateway-b", worktree: false },
    ]);
    sessions.dispose();
  });
});
