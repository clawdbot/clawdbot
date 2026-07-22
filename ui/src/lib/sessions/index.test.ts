// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  GatewayRequestError,
  type GatewayBrowserClient,
  type GatewayEventFrame,
  type GatewayHelloOk,
} from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createSessionCapability, reconcileSessionRunTerminal } from "./index.ts";

function sessionsResult(sessions: SessionsListResult["sessions"], ts: number): SessionsListResult {
  return {
    ts,
    path: "(multiple)",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function createGatewayHarness(client: GatewayBrowserClient, featureMethods?: string[]) {
  let snapshot: {
    client: GatewayBrowserClient | null;
    connected: boolean;
    sessionKey: string;
    assistantAgentId: string | null;
    hello: GatewayHelloOk | null;
  } = {
    client,
    connected: true,
    sessionKey: "agent:main:main",
    assistantAgentId: "main",
    hello:
      featureMethods === undefined
        ? null
        : ({ features: { methods: featureMethods } } as GatewayHelloOk),
  };
  const listeners = new Set<(next: typeof snapshot) => void>();
  const eventListeners = new Set<(event: GatewayEventFrame) => void>();
  return {
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (next: typeof snapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      subscribeEvents(listener: (event: GatewayEventFrame) => void) {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
    },
    emitEvent: (event: GatewayEventFrame) => {
      for (const listener of eventListeners) {
        listener(event);
      }
    },
    publish: (connected: boolean, nextClient: GatewayBrowserClient | null = snapshot.client) => {
      snapshot = { ...snapshot, client: nextClient, connected };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

function sessionChangedEvent(key: string): GatewayEventFrame {
  return {
    type: "event",
    event: "sessions.changed",
    payload: {
      sessionKey: key,
      reason: "create",
      key,
      kind: "direct",
      updatedAt: 2,
      sessionId: "hidden-session",
      label: "Hidden",
    },
  };
}

describe("createSessionCapability", () => {
  it("allows an advertised group catalog load to be retried after failure", async () => {
    let groupsCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.groups.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      groupsCalls += 1;
      if (groupsCalls === 1) {
        throw new Error("temporary catalog failure");
      }
      return { groups: [{ name: "Research" }] };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client, ["sessions.groups.list"]);
    const sessions = createSessionCapability(gateway);

    await sessions.groupsLoad();
    expect(sessions.state.groups).toEqual([]);
    await sessions.groupsLoad();

    expect(groupsCalls).toBe(2);
    expect(sessions.state.groups).toEqual(["Research"]);
    sessions.dispose();
  });

  it("automatically retries an explicitly retryable group catalog failure", async () => {
    let groupsCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.groups.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      groupsCalls += 1;
      if (groupsCalls === 1) {
        throw new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "temporary catalog failure",
          retryable: true,
          retryAfterMs: 100,
        });
      }
      return { groups: [{ name: "Recovered" }] };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client, ["sessions.groups.list"]);
    const sessions = createSessionCapability(gateway);

    await sessions.groupsLoad();

    await waitForFast(() => expect(sessions.state.groups).toEqual(["Recovered"]));
    expect(groupsCalls).toBe(2);
    sessions.dispose();
  });

  it("keeps the legacy group catalog probe one-shot without feature metadata", async () => {
    const request = vi.fn(async () => {
      throw new Error("unknown method");
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const sessions = createSessionCapability(gateway);

    await sessions.groupsLoad();
    await sessions.groupsLoad();

    expect(request).toHaveBeenCalledOnce();
    sessions.dispose();
  });

  it("publishes state.error when group rename is rejected", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.groups.rename") {
        throw new Error("rename failed");
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client, ["sessions.groups.rename"]);
    const sessions = createSessionCapability(gateway);

    await expect(sessions.groupsRename("Alpha", "Beta")).rejects.toThrow("rename failed");
    expect(sessions.state.error).toBe("Error: rename failed");
    sessions.dispose();
  });

  it("publishes state.error when replacing the group catalog is rejected", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.groups.put") {
        throw new Error("group catalog rejected");
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client, ["sessions.groups.put"]);
    const sessions = createSessionCapability(gateway);

    await expect(sessions.groupsPut(["Alpha"])).rejects.toThrow("group catalog rejected");
    expect(sessions.state.error).toBe("Error: group catalog rejected");
    sessions.dispose();
  });

  it("publishes state.error when group delete is rejected", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.groups.delete") {
        throw new Error("delete failed");
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client, ["sessions.groups.delete"]);
    const sessions = createSessionCapability(gateway);

    await expect(sessions.groupsDelete("Alpha")).rejects.toThrow("delete failed");
    expect(sessions.state.error).toBe("Error: delete failed");
    sessions.dispose();
  });

  it("reports a group rename as stale after a same-client reconnect", async () => {
    const renamed = deferred<{ groups: Array<{ name: string }> }>();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.groups.rename") {
        return await renamed.promise;
      }
      if (method === "sessions.subscribe") {
        return {};
      }
      if (method === "sessions.list") {
        return sessionsResult([], 2);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client, ["sessions.groups.rename"]);
    const sessions = createSessionCapability(gateway);

    const operation = sessions.groupsRename("Alpha", "Beta");
    publish(false);
    publish(true);
    renamed.resolve({ groups: [{ name: "Beta" }] });

    await expect(operation).resolves.toBe("stale");
    expect(sessions.state.groups).toEqual([]);
    sessions.dispose();
  });

  it("reports a group catalog replacement as stale after a same-client reconnect", async () => {
    const replaced = deferred<{ groups: Array<{ name: string }> }>();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.groups.put") {
        return await replaced.promise;
      }
      if (method === "sessions.subscribe") {
        return {};
      }
      if (method === "sessions.list") {
        return sessionsResult([], 2);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client, ["sessions.groups.put"]);
    const sessions = createSessionCapability(gateway);

    const operation = sessions.groupsPut(["Alpha"]);
    publish(false);
    publish(true);
    replaced.resolve({ groups: [{ name: "Alpha" }] });

    await expect(operation).resolves.toBe("stale");
    expect(sessions.state.groups).toEqual([]);
    expect(sessions.state.error).toBeNull();
    sessions.dispose();
  });

  it.each(["rename", "delete"] as const)(
    "keeps a confirmed group %s completed when its row refresh outlives the connection",
    async (operation) => {
      const refreshed = deferred<SessionsListResult>();
      const method = operation === "rename" ? "sessions.groups.rename" : "sessions.groups.delete";
      const request = vi.fn(async (requestedMethod: string) => {
        if (requestedMethod === method) {
          return { groups: [{ name: operation === "rename" ? "Beta" : "Other" }] };
        }
        if (requestedMethod === "sessions.list") {
          return await refreshed.promise;
        }
        throw new Error(`Unexpected request: ${requestedMethod}`);
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const { gateway, publish } = createGatewayHarness(client, [method]);
      const sessions = createSessionCapability(gateway);

      const mutation =
        operation === "rename"
          ? sessions.groupsRename("Alpha", "Beta")
          : sessions.groupsDelete("Alpha");
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("sessions.list", expect.any(Object)),
      );
      publish(false);
      refreshed.resolve(sessionsResult([], 2));

      await expect(mutation).resolves.toBe("completed");
      sessions.dispose();
    },
  );

  it("does not probe for a group catalog when the method is explicitly absent", async () => {
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client, []);
    const sessions = createSessionCapability(gateway);

    await sessions.groupsLoad();
    await sessions.groupsLoad();

    expect(request).not.toHaveBeenCalled();
    expect(sessions.state.groups).toEqual([]);
    sessions.dispose();
  });

  it("ignores an older group load failure after an event-driven load succeeds", async () => {
    const firstGroups = deferred<{ groups: Array<{ name: string }> }>();
    const currentGroups = deferred<{ groups: Array<{ name: string }> }>();
    let groupsCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.groups.list") {
        groupsCalls += 1;
        return await (groupsCalls === 1 ? firstGroups.promise : currentGroups.promise);
      }
      if (method === "sessions.list") {
        return sessionsResult([], 1);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, emitEvent } = createGatewayHarness(client, ["sessions.groups.list"]);
    const sessions = createSessionCapability(gateway);

    const firstLoad = sessions.groupsLoad();
    await waitForFast(() => expect(groupsCalls).toBe(1));
    emitEvent({ type: "event", event: "sessions.changed", payload: { reason: "groups" } });
    await waitForFast(() => expect(groupsCalls).toBe(2));
    currentGroups.resolve({ groups: [{ name: "Current" }] });
    await waitForFast(() => expect(sessions.state.groups).toEqual(["Current"]));
    firstGroups.reject(new Error("stale catalog failure"));
    await firstLoad;

    await sessions.groupsLoad();
    expect(groupsCalls).toBe(2);
    expect(sessions.state.groups).toEqual(["Current"]);
    sessions.dispose();
  });

  it("keeps a session when sessions.delete reports no deletion", async () => {
    const key = "agent:main:missing";
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.delete") {
        return { ok: true, deleted: false };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const sessions = createSessionCapability(gateway);

    await expect(sessions.delete(key)).resolves.toEqual({ deleted: false });
    expect(sessions.state.deletedSessions).toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
    sessions.dispose();
  });

  it("excludes lifecycle no-ops from batch deletion results", async () => {
    const keptKey = "agent:main:kept";
    const deletedKey = "agent:main:deleted";
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "sessions.delete") {
        const key = (params as { key?: string } | undefined)?.key;
        return { ok: true, deleted: key === deletedKey };
      }
      if (method === "sessions.list") {
        return sessionsResult([{ key: keptKey, kind: "direct", updatedAt: 1 }], 2);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const sessions = createSessionCapability(gateway);
    const deletedSnapshots: string[][] = [];
    const unsubscribe = sessions.subscribe((next) => {
      deletedSnapshots.push(next.deletedSessions.map((target) => target.key));
    });

    await expect(
      sessions.deleteMany([{ key: keptKey }, { key: deletedKey, archivedOnly: true }]),
    ).resolves.toEqual({ deleted: [deletedKey], errors: [], preservedWorktrees: [] });
    expect(deletedSnapshots.some((keys) => keys.includes(deletedKey))).toBe(true);
    expect(deletedSnapshots.some((keys) => keys.includes(keptKey))).toBe(false);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenCalledWith("sessions.delete", {
      key: deletedKey,
      deleteTranscript: true,
      archivedOnly: true,
    });
    unsubscribe();
    sessions.dispose();
  });

  it("advances the canonical list revision only for sessions.list publications", async () => {
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      return sessionsResult([{ key: "agent:main:listed", kind: "direct", updatedAt: 2 }], 2);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const sessions = createSessionCapability({
      snapshot: {
        client,
        connected: true,
        sessionKey: "agent:main:main",
        assistantAgentId: "main",
        hello: null,
      },
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    });

    expect(sessions.canonicalListRevision).toBe(0);
    sessions.reconcile(
      { key: "agent:main:startup", kind: "direct", updatedAt: 1 },
      { modelProvider: null, model: null, contextTokens: null },
    );
    expect(sessions.canonicalListRevision).toBe(0);

    await sessions.refresh({ force: true });

    expect(sessions.canonicalListRevision).toBe(1);
    expect(sessions.state.result?.sessions[0]?.key).toBe("agent:main:listed");
    sessions.dispose();
  });

  it("starts a fresh list epoch when the same client reconnects", async () => {
    const staleList = deferred<SessionsListResult>();
    const currentList = deferred<SessionsListResult>();
    let listCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.subscribe") {
        return {};
      }
      if (method === "sessions.list") {
        listCalls += 1;
        return await (listCalls === 1 ? staleList.promise : currentList.promise);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    const sessions = createSessionCapability(gateway);

    const staleRefresh = sessions.refresh({ force: true });
    publish(false);
    publish(true);
    await waitForFast(() => expect(listCalls).toBe(2));

    staleList.resolve(sessionsResult([{ key: "stale", kind: "direct", updatedAt: 1 }], 1));
    await staleRefresh;
    expect(sessions.state.result).toBeNull();

    currentList.resolve(sessionsResult([{ key: "current", kind: "direct", updatedAt: 2 }], 2));
    await waitForFast(() => expect(sessions.state.result?.sessions[0]?.key).toBe("current"));
    sessions.dispose();
  });

  it("does not publish a created session from a retired same-client epoch", async () => {
    const staleCreate = deferred<{ key: string }>();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.create") {
        return await staleCreate.promise;
      }
      if (method === "sessions.subscribe") {
        return {};
      }
      if (method === "sessions.list") {
        return sessionsResult([], 2);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    const sessions = createSessionCapability(gateway);
    const created = vi.fn();
    sessions.subscribeCreated(created);

    const operation = sessions.create({ agentId: "main" });
    publish(false);
    publish(true);
    staleCreate.resolve({ key: "agent:main:stale" });

    await expect(operation).resolves.toBeNull();
    expect(created).not.toHaveBeenCalled();
    sessions.dispose();
  });

  it("creates a session while a list refresh is in flight", async () => {
    const pendingList = deferred<SessionsListResult>();
    let listCalls = 0;
    const key = "agent:main:created";
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        listCalls += 1;
        return listCalls === 1
          ? await pendingList.promise
          : sessionsResult([{ key, kind: "direct", updatedAt: 2 }], 2);
      }
      if (method === "sessions.create") {
        return { key };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const sessions = createSessionCapability(gateway);

    const refresh = sessions.refresh({ force: true });
    expect(sessions.state.loading).toBe(true);

    const created = sessions.create({ agentId: "main" });
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("sessions.create", { agentId: "main" }),
    );

    pendingList.resolve(sessionsResult([], 1));
    await expect(created).resolves.toBe(key);
    await refresh;

    expect(listCalls).toBe(2);
    expect(sessions.state.result?.sessions[0]?.key).toBe(key);
    sessions.dispose();
  });

  it("returns the initial-run rejection without discarding the created session key", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.create") {
        return {
          key: "agent:main:rejected",
          runStarted: false,
          runError: { code: "INVALID_REQUEST", message: "send blocked by session policy" },
        };
      }
      if (method === "sessions.list") {
        return sessionsResult([], 2);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const sessions = createSessionCapability({
      snapshot: {
        client,
        connected: true,
        sessionKey: "agent:main:source",
        assistantAgentId: "main",
        hello: null,
      },
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    });

    await expect(sessions.createResult({ agentId: "main", message: "hello" })).resolves.toEqual({
      key: "agent:main:rejected",
      initialRun: { status: "rejected", error: "send blocked by session policy" },
    });
    sessions.dispose();
  });

  it("reports a reset as stale when its connection epoch retires", async () => {
    const staleReset = deferred<unknown>();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.reset") {
        return await staleReset.promise;
      }
      if (method === "sessions.subscribe") {
        return {};
      }
      if (method === "sessions.list") {
        return sessionsResult([], 2);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    const sessions = createSessionCapability(gateway);

    const reset = sessions.reset("agent:main:main");
    publish(false);
    publish(true);
    staleReset.resolve({});

    await expect(reset).resolves.toBe("uncertain");
    sessions.dispose();
  });

  it("reports a same-connection reset rejection as uncertain", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.reset") {
        throw new Error("post-commit lifecycle failed");
      }
      if (method === "sessions.subscribe") {
        return {};
      }
      if (method === "sessions.list") {
        return sessionsResult([], 2);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const sessions = createSessionCapability(gateway);

    await expect(sessions.reset("agent:main:main")).resolves.toBe("uncertain");
    expect(sessions.state.error).toContain("post-commit lifecycle failed");
    sessions.dispose();
  });

  it("rolls back an optimistic model patch when its connection epoch retires", async () => {
    const stalePatch = deferred<unknown>();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.patch") {
        return await stalePatch.promise;
      }
      if (method === "sessions.subscribe") {
        return {};
      }
      if (method === "sessions.list") {
        return sessionsResult([], 2);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    const sessions = createSessionCapability(gateway);
    const key = "agent:main:main";
    sessions.setModelOverride(key, "openai/gpt-old");

    const operation = sessions.patch(key, { model: "openai/gpt-new" });
    expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-new");

    publish(false);
    expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-old");
    publish(true);
    stalePatch.resolve({});

    await expect(operation).resolves.toBeNull();
    expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-old");
    sessions.dispose();
  });

  it("does not dispatch a queued patch on a replacement connection", async () => {
    const priorPatch = deferred<void>();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.patch") {
        return { ok: true, path: "", key: "agent:main:main", entry: {} };
      }
      if (method === "sessions.subscribe") {
        return {};
      }
      if (method === "sessions.list") {
        return sessionsResult([], 2);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    const sessions = createSessionCapability(gateway);
    const key = "agent:main:main";
    sessions.setModelOverride(key, "openai/gpt-old");

    const operation = sessions.patch(
      key,
      { model: "openai/gpt-new" },
      { waitFor: priorPatch.promise },
    );
    expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-new");
    expect(request).not.toHaveBeenCalledWith("sessions.patch", expect.anything());

    publish(false);
    publish(true);
    priorPatch.resolve();

    await expect(operation).resolves.toBeNull();
    expect(request).not.toHaveBeenCalledWith("sessions.patch", expect.anything());
    expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-old");
    sessions.dispose();
  });

  it("passes transcript fork parameters to sessions.create", async () => {
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "sessions.create") {
        return { key: "agent:main:forked" };
      }
      if (method === "sessions.list") {
        return sessionsResult([], 2);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const sessions = createSessionCapability({
      snapshot: {
        client,
        connected: true,
        sessionKey: "agent:main:source",
        assistantAgentId: "main",
        hello: null,
      },
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    });

    await expect(
      sessions.create({
        agentId: "main",
        parentSessionKey: "agent:main:source",
        fork: true,
      }),
    ).resolves.toBe("agent:main:forked");
    expect(request).toHaveBeenCalledWith("sessions.create", {
      agentId: "main",
      parentSessionKey: "agent:main:source",
      fork: true,
    });
    sessions.dispose();
  });

  it("keeps background hydration non-blocking and retains an omitted selected row", async () => {
    const secondList = deferred<SessionsListResult>();
    let listCalls = 0;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      listCalls += 1;
      if (listCalls === 1) {
        return sessionsResult(
          [
            {
              key: "agent:main:oldest",
              kind: "direct",
              updatedAt: 1,
              label: "Oldest",
            },
          ],
          1,
        );
      }
      return await secondList.promise;
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = {
      snapshot: {
        client,
        connected: true,
        sessionKey: "agent:main:oldest",
        assistantAgentId: "main",
        hello: null,
      },
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    };
    const sessions = createSessionCapability(gateway);
    await sessions.refresh({ agentId: "main", force: true });
    const loadingStates: boolean[] = [];
    const stop = sessions.subscribe((state) => loadingStates.push(state.loading));

    const hydration = sessions.refresh({
      agentId: "main",
      backgroundHydrate: true,
      force: true,
    });
    expect(sessions.state.loading).toBe(false);
    secondList.resolve(sessionsResult([], 2));
    await hydration;

    expect(loadingStates).not.toContain(true);
    expect(sessions.state.result?.sessions).toEqual([
      expect.objectContaining({ key: "agent:main:oldest", label: "Oldest" }),
    ]);
    stop();
    sessions.dispose();
  });

  it("publishes terminal run state to shared session subscribers", async () => {
    const key = "agent:main:main";
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      return sessionsResult(
        [
          {
            key,
            kind: "direct",
            updatedAt: 1,
            hasActiveRun: true,
            activeRunIds: ["run-1"],
            status: "running",
            startedAt: 100,
          },
        ],
        1,
      );
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const sessions = createSessionCapability({
      snapshot: {
        client,
        connected: true,
        sessionKey: key,
        assistantAgentId: "main",
        hello: null,
      },
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    });
    await sessions.refresh({ agentId: "main", force: true });

    expect(
      sessions.reconcileRunTerminal({
        sessionKeys: ["main"],
        runId: "run-1",
        status: "done",
        endedAt: 160,
      }),
    ).toBe(true);
    expect(sessions.state.result?.sessions[0]).toMatchObject({
      key,
      hasActiveRun: false,
      activeRunIds: [],
      status: "done",
      endedAt: 160,
      runtimeMs: 60,
    });

    expect(
      sessions.reconcile({
        key,
        kind: "direct",
        updatedAt: 2,
        hasActiveRun: true,
        activeRunIds: ["run-2"],
        status: "running",
        startedAt: 200,
      }),
    ).toBe(true);
    expect(
      sessions.reconcileRunTerminal({
        sessionKeys: ["main"],
        runId: "run-1",
        status: "done",
        endedAt: 260,
      }),
    ).toBe(false);
    expect(sessions.state.result?.sessions[0]).toMatchObject({
      hasActiveRun: true,
      activeRunIds: ["run-2"],
      status: "running",
    });

    expect(
      sessions.reconcile({
        key,
        kind: "direct",
        updatedAt: 3,
        hasActiveRun: true,
        status: "running",
        startedAt: 300,
      }),
    ).toBe(true);
    expect(
      sessions.reconcileRunTerminal({
        sessionKeys: ["main"],
        runId: "run-1",
        status: "done",
        endedAt: 360,
      }),
    ).toBe(false);
    expect(sessions.state.result?.sessions[0]).toMatchObject({
      hasActiveRun: true,
      status: "running",
    });
    expect(
      sessions.reconcileRunTerminal({
        sessionKeys: ["main"],
        status: "done",
        endedAt: 360,
      }),
    ).toBe(false);
    sessions.dispose();
  });

  it("preserves registry-active terminal rows without matching run identity", () => {
    const result = sessionsResult(
      [
        {
          key: "agent:main:main",
          kind: "direct",
          updatedAt: 1,
          hasActiveRun: true,
          status: "done",
        },
      ],
      1,
    );

    expect(
      reconcileSessionRunTerminal(result, {
        sessionKeys: ["main"],
        runId: "run-1",
        status: "done",
        endedAt: 160,
      }),
    ).toBe(result);
  });

  it("refreshes instead of inserting hidden sessions after configured-only lists", async () => {
    const visibleKey = "agent:main:main";
    const hiddenKey = "agent:local:hidden";
    const refreshed = deferred<SessionsListResult>();
    let listCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      listCalls += 1;
      const result = sessionsResult(
        [
          {
            key: visibleKey,
            kind: "direct",
            updatedAt: 1,
            sessionId: "visible-session",
          },
        ],
        1,
      );
      return listCalls === 1 ? result : await refreshed.promise;
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, emitEvent } = createGatewayHarness(client);
    const sessions = createSessionCapability(gateway);

    await sessions.refresh({ force: true });
    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({ configuredAgentsOnly: true, limit: 50 }),
    );
    const publishedKeys: string[][] = [];
    sessions.subscribe((next) => {
      publishedKeys.push(next.result?.sessions.map((row) => row.key) ?? []);
    });

    emitEvent(sessionChangedEvent(hiddenKey));

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual([visibleKey]);
    expect(publishedKeys.some((keys) => keys.includes(hiddenKey))).toBe(false);
    refreshed.resolve(sessionsResult([{ key: visibleKey, kind: "direct", updatedAt: 1 }], 2));
    await waitForFast(() => expect(sessions.state.loading).toBe(false));
    sessions.dispose();
  });

  it("publishes remote deletion before refreshing the canonical list", async () => {
    const visibleKey = "agent:main:main";
    const refreshed = deferred<SessionsListResult>();
    let listCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      listCalls += 1;
      const result = sessionsResult([{ key: visibleKey, kind: "direct", updatedAt: 1 }], 1);
      return listCalls === 1 ? result : await refreshed.promise;
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, emitEvent } = createGatewayHarness(client);
    const sessions = createSessionCapability(gateway);

    await sessions.refresh({ force: true });
    const deletedSnapshots: string[][] = [];
    sessions.subscribe((next) => {
      deletedSnapshots.push(next.deletedSessions.map((target) => target.key));
    });

    emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: { sessionKey: visibleKey, reason: "delete" },
    });

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expect(deletedSnapshots.some((keys) => keys.includes(visibleKey))).toBe(true);
    refreshed.resolve(sessionsResult([], 2));
    await waitForFast(() => expect(sessions.state.loading).toBe(false));
    sessions.dispose();
  });

  it("refreshes broad lists when the client omits the server-side window limit", async () => {
    const visibleKey = "agent:main:main";
    const hiddenKey = "agent:local:hidden";
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      return sessionsResult([{ key: visibleKey, kind: "direct", updatedAt: 1 }], 1);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, emitEvent } = createGatewayHarness(client);
    const sessions = createSessionCapability(gateway);

    await sessions.refresh({ configuredAgentsOnly: false, force: true, limit: 0 });
    const requestParams = request.mock.calls[0]?.[1];
    expect(requestParams).toEqual(
      expect.objectContaining({
        configuredAgentsOnly: false,
        includeGlobal: true,
        includeUnknown: true,
      }),
    );
    expect(requestParams).not.toHaveProperty("limit");

    emitEvent(sessionChangedEvent(hiddenKey));

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expect(sessions.state.result?.sessions.map((row) => row.key)).not.toContain(hiddenKey);
    sessions.dispose();
  });

  it("refreshes stale active rows after a terminal session message", async () => {
    const key = "agent:main:main";
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        sessionsResult(
          [{ key, kind: "direct", updatedAt: 1, hasActiveRun: true, status: "running" }],
          1,
        ),
      )
      .mockResolvedValueOnce(
        sessionsResult(
          [{ key, kind: "direct", updatedAt: 2, hasActiveRun: false, status: "done" }],
          2,
        ),
      );
    let eventListener: ((event: GatewayEventFrame) => void) | undefined;
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = {
      snapshot: {
        client,
        connected: true,
        sessionKey: key,
        assistantAgentId: "main",
        hello: null,
      },
      subscribe: () => () => undefined,
      subscribeEvents: (listener: (event: GatewayEventFrame) => void) => {
        eventListener = listener;
        return () => undefined;
      },
    };
    const sessions = createSessionCapability(gateway);
    await sessions.refresh({ agentId: "main", force: true });

    eventListener?.({
      type: "event",
      event: "session.message",
      payload: { sessionKey: key, updatedAt: 1, status: "done" },
    });

    await waitForFast(() =>
      expect(sessions.state.result?.sessions[0]).toMatchObject({
        key,
        hasActiveRun: false,
        status: "done",
      }),
    );
    expect(request).toHaveBeenCalledTimes(2);
    sessions.dispose();
  });
});
