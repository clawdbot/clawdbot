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
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createSessions(client: GatewayBrowserClient, key: string) {
  return createSessionCapability({
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
      showArchived: true,
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
});
