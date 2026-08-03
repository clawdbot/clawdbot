import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createSessionCapability } from "./index.ts";

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

function createSessions(client: GatewayBrowserClient, key: string) {
  return createSessionCapability({
    snapshot: {
      client,
      phase: "connected" as const,
      sessionKey: key,
      assistantAgentId: "main",
      hello: null,
    },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  });
}

describe("session list replacement options", () => {
  it("preserves derived-title hydration when refreshing after session patches", async () => {
    const key = "agent:main:untitled";
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "sessions.list") {
        return sessionsResult(
          [
            {
              key,
              kind: "direct",
              updatedAt: 1,
              label: key,
              derivedTitle: "Readable planning title",
            },
          ],
          1,
        );
      }
      if (method === "sessions.patch") {
        return { ok: true };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const sessions = createSessions({ request } as unknown as GatewayBrowserClient, key);

    await sessions.refresh({
      agentId: "main",
      activeMinutes: 0,
      limit: 50,
      includeGlobal: true,
      includeUnknown: true,
      configuredAgentsOnly: true,
      includeDerivedTitles: true,
      force: true,
    });
    await sessions.patch(key, { pinned: true }, { agentId: "main" });

    const listCalls = request.mock.calls.filter(([method]) => method === "sessions.list");
    expect(listCalls).toHaveLength(2);
    expect(listCalls[1]?.[1]).toMatchObject({
      agentId: "main",
      includeGlobal: true,
      includeUnknown: true,
      configuredAgentsOnly: true,
      includeDerivedTitles: true,
      limit: 50,
    });
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key,
      agentId: "main",
      pinned: true,
    });
    sessions.dispose();
  });

  it("restores derived titles after a foreground refresh omits them", async () => {
    const key = "agent:main:untitled";
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "sessions.list") {
        const includeDerivedTitles =
          typeof params === "object" &&
          params !== null &&
          "includeDerivedTitles" in params &&
          params.includeDerivedTitles === true;
        return sessionsResult(
          [
            {
              key,
              kind: "direct",
              updatedAt: 1,
              label: key,
              ...(includeDerivedTitles ? { derivedTitle: "Readable planning title" } : {}),
            },
          ],
          1,
        );
      }
      if (method === "sessions.patch") {
        return { ok: true };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const sessions = createSessions({ request } as unknown as GatewayBrowserClient, key);

    await sessions.refresh({ agentId: "main", includeDerivedTitles: true, force: true });
    await sessions.refresh({ agentId: "main", force: true });
    await sessions.patch(key, { pinned: true }, { agentId: "main" });

    const listCalls = request.mock.calls.filter(([method]) => method === "sessions.list");
    expect(listCalls).toHaveLength(3);
    expect(listCalls[1]?.[1]).not.toHaveProperty("includeDerivedTitles");
    expect(listCalls[2]?.[1]).toMatchObject({ agentId: "main", includeDerivedTitles: true });
    expect(sessions.state.result?.sessions[0]?.derivedTitle).toBe("Readable planning title");
    sessions.dispose();
  });

  it("keeps foreground list options across background hydration and mutation refreshes", async () => {
    const key = "agent:main:filtered";
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "sessions.list") {
        return sessionsResult([{ key, kind: "direct", updatedAt: 1 }], 1);
      }
      if (method === "sessions.patch") {
        return { ok: true };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const sessions = createSessions({ request } as unknown as GatewayBrowserClient, key);

    await sessions.refresh({
      agentId: "main",
      search: "filtered",
      archivedFilter: "archived",
      limit: 25,
      includeDerivedTitles: true,
      force: true,
    });
    await sessions.refresh({
      agentId: "other",
      limit: 5,
      backgroundHydrate: true,
      force: true,
    });
    await sessions.patch(key, { pinned: true }, { agentId: "main" });

    const listCalls = request.mock.calls.filter(([method]) => method === "sessions.list");
    expect(listCalls).toHaveLength(3);
    expect(listCalls[2]?.[1]).toMatchObject({
      agentId: "main",
      search: "filtered",
      archived: true,
      limit: 25,
      includeDerivedTitles: true,
    });
    sessions.dispose();
  });

  it("captures foreground list options before concurrent mutation refreshes", async () => {
    const key = "agent:main:concurrent";
    const firstList = deferred<SessionsListResult>();
    let listCalls = 0;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "sessions.list") {
        listCalls += 1;
        return listCalls === 1
          ? await firstList.promise
          : sessionsResult([{ key, kind: "direct", updatedAt: 2 }], 1);
      }
      if (method === "sessions.patch") {
        return { ok: true };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const sessions = createSessions({ request } as unknown as GatewayBrowserClient, key);

    const foreground = sessions.refresh({
      agentId: "main",
      search: "concurrent",
      limit: 30,
      includeDerivedTitles: true,
      force: true,
    });
    const mutation = sessions.patch(key, { pinned: true }, { agentId: "main" });
    firstList.resolve(sessionsResult([{ key, kind: "direct", updatedAt: 1 }], 1));
    await Promise.all([foreground, mutation]);

    const sessionLists = request.mock.calls.filter(([method]) => method === "sessions.list");
    expect(sessionLists).toHaveLength(2);
    expect(sessionLists[1]?.[1]).toMatchObject({
      agentId: "main",
      search: "concurrent",
      limit: 30,
      includeDerivedTitles: true,
    });
    sessions.dispose();
  });

  it("drops pagination while preserving filters when refreshing after session patches", async () => {
    const key = "agent:main:page-b";
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "sessions.list") {
        return sessionsResult(
          [
            {
              key,
              kind: "direct",
              updatedAt: 2,
              label: key,
              derivedTitle: "Readable second-page title",
            },
          ],
          2,
        );
      }
      if (method === "sessions.patch") {
        return { ok: true };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const sessions = createSessions({ request } as unknown as GatewayBrowserClient, key);

    const baseListOptions = {
      agentId: "main",
      activeMinutes: 0,
      limit: 1,
      includeGlobal: true,
      includeUnknown: true,
      configuredAgentsOnly: true,
      includeDerivedTitles: true,
      force: true,
    };
    await sessions.refresh(baseListOptions);
    await sessions.refresh({
      ...baseListOptions,
      offset: 1,
      append: true,
    });
    await sessions.patch(key, { unread: false }, { agentId: "main" });

    const listCalls = request.mock.calls.filter(([method]) => method === "sessions.list");
    expect(listCalls).toHaveLength(3);
    expect(listCalls[2]?.[1]).toMatchObject({
      agentId: "main",
      limit: 1,
      includeGlobal: true,
      includeUnknown: true,
      configuredAgentsOnly: true,
      includeDerivedTitles: true,
    });
    expect(listCalls[2]?.[1]).not.toHaveProperty("append");
    expect(listCalls[2]?.[1]).not.toHaveProperty("offset");
    sessions.dispose();
  });

  it("defers the canonical refresh for batch patches until the caller asks for it", async () => {
    const keys = ["agent:main:one", "agent:main:two", "agent:main:three"];
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "sessions.list") {
        return sessionsResult(
          keys.map((key) => ({ key, kind: "direct" as const, updatedAt: 1 })),
          1,
        );
      }
      if (method === "sessions.patch") {
        return { ok: true };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const sessions = createSessions(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:one",
    );

    await sessions.refresh({ agentId: "main", limit: 60, includeDerivedTitles: true, force: true });
    for (const key of keys) {
      await sessions.patch(key, { archived: true }, { agentId: "main", deferListRefresh: true });
    }
    const listCallsBeforeTail = request.mock.calls.filter(
      ([method]) => method === "sessions.list",
    ).length;
    await sessions.refreshReplacement("main");

    // One seeding list, none from the patches, one authoritative tail refresh.
    expect(listCallsBeforeTail).toBe(1);
    expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(3);
    sessions.dispose();
  });

  it("defers model override publication when the caller owns lifecycle validation", async () => {
    const pendingPatch = deferred<unknown>();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.patch") {
        return await pendingPatch.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const key = "global";
    const sessions = createSessions({ request } as unknown as GatewayBrowserClient, key);
    sessions.setModelOverride(key, "openai/gpt-old");

    const operation = sessions.patch(
      key,
      { model: "openai/gpt-new" },
      { deferListRefresh: true, deferModelOverride: true },
    );

    expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-old");
    pendingPatch.resolve({ ok: true, path: "", key, entry: {} });
    await expect(operation).resolves.toMatchObject({ ok: true, key });
    expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-old");
    sessions.dispose();
  });

  it.each(["resolve", "reject"] as const)(
    "retires an optimistic model patch after the UI owner changes and the request %s",
    async (outcome) => {
      const pendingPatch = deferred<unknown>();
      const request = vi.fn(async (method: string) => {
        if (method === "sessions.patch") {
          return await pendingPatch.promise;
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const key = "global";
      const sessions = createSessions({ request } as unknown as GatewayBrowserClient, key);
      let ownsModelOverride = true;
      sessions.setModelOverride(key, "openai/gpt-old");

      const operation = sessions.patch(
        key,
        { model: "openai/gpt-agent-a" },
        {
          deferListRefresh: true,
          ownsModelOverride: () => ownsModelOverride,
        },
      );
      expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-agent-a");

      ownsModelOverride = false;
      if (outcome === "resolve") {
        pendingPatch.resolve({ ok: true, path: "", key, entry: {} });
        await expect(operation).resolves.toMatchObject({ ok: true, key });
      } else {
        pendingPatch.reject(new Error("agent A patch failed"));
        await expect(operation).rejects.toThrow("agent A patch failed");
      }

      expect(sessions.state.modelOverrides[key]).toBeUndefined();
      expect(sessions.state.error).toBeNull();
      sessions.dispose();
    },
  );

  it.each(["resolve", "reject"] as const)(
    "preserves a replacement owner's equal-value model claim when an older request %s",
    async (outcome) => {
      const pendingPatch = deferred<unknown>();
      const request = vi.fn(async (method: string) => {
        if (method === "sessions.patch") {
          return await pendingPatch.promise;
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const key = "global";
      const sessions = createSessions({ request } as unknown as GatewayBrowserClient, key);
      let ownsModelOverride = true;

      const operation = sessions.patch(
        key,
        { model: "openai/gpt-shared" },
        {
          deferListRefresh: true,
          ownsModelOverride: () => ownsModelOverride,
        },
      );
      expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-shared");

      ownsModelOverride = false;
      sessions.setModelOverride(key, "openai/gpt-shared");
      if (outcome === "resolve") {
        pendingPatch.resolve({ ok: true, path: "", key, entry: {} });
        await expect(operation).resolves.toMatchObject({ ok: true, key });
      } else {
        pendingPatch.reject(new Error("agent A patch failed"));
        await expect(operation).rejects.toThrow("agent A patch failed");
      }

      expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-shared");
      expect(sessions.state.error).toBeNull();
      sessions.dispose();
    },
  );

  it("does not reuse a retired owner's model baseline for the next owner", async () => {
    const agentAPatch = deferred<unknown>();
    const agentBPatch = deferred<unknown>();
    let patchCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.patch") {
        patchCount += 1;
        return await (patchCount === 1 ? agentAPatch.promise : agentBPatch.promise);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const key = "global";
    const sessions = createSessions({ request } as unknown as GatewayBrowserClient, key);
    sessions.setModelOverride(key, "openai/gpt-agent-a-old");

    const agentAOperation = sessions.patch(
      key,
      { model: "openai/gpt-agent-a-new" },
      { deferListRefresh: true },
    );
    expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-agent-a-new");

    sessions.retireModelOverride(key);
    expect(sessions.state.modelOverrides[key]).toBeUndefined();

    const agentBOperation = sessions.patch(
      key,
      { model: "openai/gpt-agent-b" },
      { deferListRefresh: true },
    );
    expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-agent-b");

    agentBPatch.reject(new Error("agent B patch failed"));
    await expect(agentBOperation).rejects.toThrow("agent B patch failed");
    expect(sessions.state.modelOverrides[key]).toBeUndefined();

    agentAPatch.resolve({ ok: true, path: "", key, entry: {} });
    await expect(agentAOperation).resolves.toMatchObject({ ok: true, key });
    expect(sessions.state.modelOverrides[key]).toBeUndefined();
    sessions.dispose();
  });
});
