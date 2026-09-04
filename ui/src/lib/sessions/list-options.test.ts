import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionGoal, SessionsListResult } from "../../api/types.ts";
import { createSessionCapability } from "./index.ts";
import { sessionsResult } from "./session-capability.test-support.ts";

function createSessions(client: GatewayBrowserClient, key: string, ownerId?: string) {
  return createSessionCapability({
    snapshot: {
      client,
      phase: "connected" as const,
      sessionKey: key,
      assistantAgentId: "main",
      hello: null,
      selfUser: ownerId ? { id: ownerId } : null,
    },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  });
}

describe("session list replacement options", () => {
  it.each([
    { filter: "owner", options: { ownerId: "profile-bob" } },
    { filter: "involving me", options: { involvingMe: true } },
    { filter: "search", options: { search: "release" } },
  ])("keeps an explicit $filter query single-phase", async ({ options }) => {
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "sessions.list") {
        return sessionsResult([], 1);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const sessions = createSessions(
      { request } as unknown as GatewayBrowserClient,
      "agent:main:main",
      "profile-ada",
    );

    await sessions.refresh({ agentId: "main", ...options, force: true });

    const listCalls = request.mock.calls.filter(([method]) => method === "sessions.list");
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]?.[1]).toEqual(expect.objectContaining(options));
    sessions.dispose();
  });

  it("preserves sidebar metadata hydration when refreshing after session patches", async () => {
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
      includeLastMessage: true,
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
      includeLastMessage: true,
      limit: 50,
    });
    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key,
      agentId: "main",
      pinned: true,
    });
    sessions.dispose();
  });

  it("keeps derived titles when a foreground refresh queues behind an archive replacement", async () => {
    const key = "agent:main:untitled";
    const archiveReplacementStarted = createDeferred();
    const archiveReplacement = createDeferred<SessionsListResult>();
    let listCallCount = 0;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "sessions.list") {
        listCallCount += 1;
        const includeDerivedTitles =
          typeof params === "object" &&
          params !== null &&
          "includeDerivedTitles" in params &&
          params.includeDerivedTitles === true;
        const result = sessionsResult(
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
        if (listCallCount === 2) {
          archiveReplacementStarted.resolve();
          return await archiveReplacement.promise;
        }
        return result;
      }
      if (method === "sessions.patch") {
        return { ok: true };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const sessions = createSessions({ request } as unknown as GatewayBrowserClient, key);

    await sessions.refresh({ agentId: "main", includeDerivedTitles: true, force: true });
    let observedArchive = false;
    let archiveReverted = false;
    const stop = sessions.subscribe((state) => {
      const archived = state.result?.sessions.find((row) => row.key === key)?.archived;
      observedArchive ||= archived === true;
      archiveReverted ||= observedArchive && archived === false;
    });
    const archive = sessions.patch(key, { archived: true }, { agentId: "main" });
    await archiveReplacementStarted.promise;
    const foreground = sessions.refresh({ agentId: "main", force: true });
    archiveReplacement.resolve(
      sessionsResult(
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
      ),
    );
    await Promise.all([archive, foreground]);

    const listCalls = request.mock.calls.filter(([method]) => method === "sessions.list");
    expect(listCalls).toHaveLength(3);
    expect(listCalls[1]?.[1]).toMatchObject({ agentId: "main", includeDerivedTitles: true });
    expect(listCalls[2]?.[1]).toMatchObject({ agentId: "main", includeDerivedTitles: true });
    expect(sessions.state.result?.sessions[0]?.derivedTitle).toBe("Readable planning title");
    expect(sessions.state.result?.sessions[0]?.archived).toBe(true);
    expect(archiveReverted).toBe(false);
    stop();
    sessions.dispose();
  });

  it("retains the routed archived descriptor through its foreground replacement", async () => {
    const key = "agent:main:dashboard:archived";
    let listCallCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.patch") {
        return { ok: true };
      }
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      listCallCount += 1;
      return sessionsResult(
        listCallCount === 1
          ? [
              {
                key,
                kind: "direct",
                sessionId: "archived-session",
                updatedAt: 1,
                derivedTitle: "Readable archived title",
              },
            ]
          : [{ key: "agent:main:main", kind: "direct", updatedAt: 2 }],
        listCallCount,
      );
    });
    const sessions = createSessions({ request } as unknown as GatewayBrowserClient, key);

    await sessions.refresh({ agentId: "main", includeDerivedTitles: true, force: true });
    const titleHistory: Array<string | undefined> = [];
    const stop = sessions.subscribe((state) => {
      titleHistory.push(state.result?.sessions.find((row) => row.key === key)?.derivedTitle);
    });

    await sessions.patch(key, { archived: true }, { agentId: "main" });

    expect(titleHistory).not.toContain(undefined);
    expect(sessions.state.result?.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key,
          archived: true,
          derivedTitle: "Readable archived title",
        }),
      ]),
    );
    stop();
    sessions.dispose();
  });

  it("retains confirmed archive state after the routed row is evicted", async () => {
    const key = "agent:main:dashboard:archived";
    const otherKey = "agent:main:dashboard:other";
    const snapshot = {
      client: null as GatewayBrowserClient | null,
      phase: "connected" as const,
      sessionKey: key,
      assistantAgentId: "main",
      hello: null,
    };
    let listCallCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.patch") {
        return { ok: true, entry: { archivedAt: 20, updatedAt: 20 } };
      }
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      listCallCount += 1;
      if (listCallCount === 3) {
        return sessionsResult([{ key: otherKey, kind: "direct", updatedAt: 30 }], listCallCount);
      }
      return sessionsResult(
        [
          { key, kind: "direct", sessionId: "archived-session", updatedAt: 40, archived: false },
          { key: otherKey, kind: "direct", updatedAt: 30 },
        ],
        listCallCount,
      );
    });
    snapshot.client = { request } as unknown as GatewayBrowserClient;
    const sessions = createSessionCapability({
      snapshot,
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    });

    await sessions.refresh({ agentId: "main", force: true });
    await sessions.patch(key, { archived: true }, { agentId: "main" });
    snapshot.sessionKey = otherKey;
    await sessions.refresh({ agentId: "main", force: true });
    expect(sessions.state.result?.sessions.some((row) => row.key === key)).toBe(false);

    await sessions.refresh({ agentId: "main", force: true });
    expect(sessions.state.result?.sessions.find((row) => row.key === key)).toMatchObject({
      archived: true,
      archivedAt: 20,
    });

    sessions.reconcileChanged({
      sessionKey: key,
      key,
      kind: "direct",
      sessionId: "archived-session",
      updatedAt: 50,
      archived: false,
      archivedAt: null,
      reason: "update",
    });
    expect(sessions.state.result?.sessions.find((row) => row.key === key)?.archived).toBe(false);
    sessions.dispose();
  });

  it("does not carry confirmed archive state into a replacement session", async () => {
    const key = "agent:main:dashboard:replaced";
    let listCallCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.patch") {
        return {
          ok: true,
          entry: { sessionId: "archived-session", archivedAt: 20, updatedAt: 20 },
        };
      }
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      listCallCount += 1;
      if (listCallCount === 1) {
        return sessionsResult(
          [{ key, kind: "direct", sessionId: "archived-session", updatedAt: 10 }],
          listCallCount,
        );
      }
      if (listCallCount === 2) {
        return sessionsResult(
          [{ key, kind: "direct", updatedAt: 30, archived: false }],
          listCallCount,
        );
      }
      if (listCallCount === 3) {
        return sessionsResult(
          [
            {
              key,
              kind: "direct",
              sessionId: "replacement-session",
              updatedAt: 40,
              archived: false,
            },
          ],
          listCallCount,
        );
      }
      return sessionsResult(
        [{ key, kind: "direct", updatedAt: 50, archived: false }],
        listCallCount,
      );
    });
    const sessions = createSessions({ request } as unknown as GatewayBrowserClient, key);

    await sessions.refresh({ agentId: "main", force: true });
    await sessions.patch(key, { archived: true }, { agentId: "main" });
    expect(sessions.state.result?.sessions[0]).toMatchObject({
      archived: false,
    });
    expect(sessions.state.result?.sessions[0]?.sessionId).toBeUndefined();
    expect(sessions.archiveVisibility(key)).toBeUndefined();

    await sessions.refresh({ agentId: "main", force: true });
    expect(sessions.state.result?.sessions[0]).toMatchObject({
      sessionId: "replacement-session",
      archived: false,
    });
    expect(sessions.archiveVisibility(key)).toBeUndefined();

    await sessions.refresh({ agentId: "main", force: true });
    expect(sessions.state.result?.sessions[0]?.archived).toBe(false);
    sessions.dispose();
  });

  it("keeps derived titles while an enriched roster response is temporarily degraded", async () => {
    const key = "agent:main:dashboard:session-1";
    let listCallCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      listCallCount += 1;
      return sessionsResult(
        [
          {
            key,
            kind: "direct",
            sessionId: "session-1",
            updatedAt: listCallCount,
            ...(listCallCount === 1
              ? {
                  derivedTitle: "Readable planning title",
                  lastMessagePreview: "Latest visible reply",
                }
              : {}),
          },
        ],
        listCallCount,
      );
    });
    const sessions = createSessions({ request } as unknown as GatewayBrowserClient, key);

    await sessions.refresh({ agentId: "main", includeDerivedTitles: true, force: true });
    await sessions.refresh({ agentId: "main", includeDerivedTitles: true, force: true });

    expect(sessions.state.result?.sessions[0]).toMatchObject({
      key,
      updatedAt: 2,
      derivedTitle: "Readable planning title",
      lastMessagePreview: "Latest visible reply",
    });
    sessions.dispose();
  });

  it("does not preserve another agent's raw-global row through background hydration", async () => {
    const opsGoal: SessionGoal = {
      schemaVersion: 1,
      id: "goal-ops",
      objective: "Ops only",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
      tokenStart: 0,
      tokensUsed: 0,
      continuationTurns: 0,
    };
    let listCallCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      listCallCount += 1;
      return sessionsResult(
        listCallCount === 1
          ? [
              {
                key: "global",
                kind: "global",
                updatedAt: 1,
                owner: { actor: { type: "agent", id: "ops", label: "Ops" } },
                goal: opsGoal,
                status: "running",
              },
            ]
          : [],
        listCallCount,
      );
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const snapshot = {
      client,
      phase: "connected" as const,
      sessionKey: "global",
      assistantAgentId: "ops",
      hello: null,
    };
    const sessions = createSessionCapability({
      snapshot,
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    });

    await sessions.refresh({ agentId: "ops", force: true });
    expect(sessions.state.result?.sessions[0]).toMatchObject({
      key: "global",
      goal: opsGoal,
    });

    snapshot.assistantAgentId = "research";
    await sessions.refresh({ agentId: "research", backgroundHydrate: true, force: true });

    expect(sessions.state.agentId).toBe("research");
    expect(sessions.state.result?.sessions).toEqual([]);
    sessions.dispose();
  });

  it("does not preserve a derived title across a session reset", async () => {
    const key = "agent:main:dashboard:session";
    let listCallCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      listCallCount += 1;
      return sessionsResult(
        [
          {
            key,
            kind: "direct",
            sessionId: `session-${listCallCount}`,
            updatedAt: listCallCount,
            ...(listCallCount === 1 ? { derivedTitle: "Previous session title" } : {}),
          },
        ],
        listCallCount,
      );
    });
    const sessions = createSessions({ request } as unknown as GatewayBrowserClient, key);

    await sessions.refresh({ agentId: "main", includeDerivedTitles: true, force: true });
    await sessions.refresh({ agentId: "main", includeDerivedTitles: true, force: true });

    expect(sessions.state.result?.sessions[0]).toMatchObject({
      key,
      sessionId: "session-2",
      updatedAt: 2,
    });
    expect(sessions.state.result?.sessions[0]?.derivedTitle).toBeUndefined();
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
    const firstList = createDeferred<SessionsListResult>();
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
    const request = vi.fn(async (method: string, _params?: unknown, _options?: unknown) => {
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
      await sessions.patch(
        key,
        { archived: true },
        { agentId: "main", expectedSessionId: `id:${key}`, deferListRefresh: true },
      );
    }
    const listCallsBeforeTail = request.mock.calls.filter(
      ([method]) => method === "sessions.list",
    ).length;
    await sessions.refreshReplacement("main");

    // One seeding list, none from the patches, one authoritative tail refresh.
    expect(listCallsBeforeTail).toBe(1);
    expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(3);
    for (const call of request.mock.calls.filter(([method]) => method === "sessions.patch")) {
      expect(call[1]).toMatchObject({ expectedSessionId: expect.stringMatching(/^id:/) });
      expect(call[2]).toEqual({ timeoutMs: 10 * 60_000 });
    }
    sessions.dispose();
  });

  it("does not publish a model override when the captured UI owner is already retired", async () => {
    const pendingPatch = createDeferred<unknown>();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.patch") {
        return await pendingPatch.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const key = "global";
    const sessions = createSessions({ request } as unknown as GatewayBrowserClient, key);

    const operation = sessions.patch(
      key,
      { model: "openai/gpt-new" },
      { deferListRefresh: true, ownsModelOverride: () => false },
    );

    expect(sessions.state.modelOverrides[key]).toBeUndefined();
    pendingPatch.resolve({ ok: true, path: "", key, entry: {} });
    await expect(operation).resolves.toMatchObject({ ok: true, key });
    expect(sessions.state.modelOverrides[key]).toBeUndefined();
    sessions.dispose();
  });

  it.each(["resolve", "reject"] as const)(
    "retires an optimistic model patch after the UI owner changes and the request %s",
    async (outcome) => {
      const pendingPatch = createDeferred<unknown>();
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

  it.each([
    ["resolve", false],
    ["reject", false],
    ["resolve", true],
    ["reject", true],
  ] as const)(
    "preserves a newer equal-value model claim when an older request %s (owner active: %s)",
    async (outcome, ownerActive) => {
      const pendingPatch = createDeferred<unknown>();
      const replacementPatch = createDeferred<unknown>();
      let patchCount = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "sessions.patch") {
          return await (++patchCount === 1 ? pendingPatch.promise : replacementPatch.promise);
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

      ownsModelOverride = ownerActive;
      const replacement = sessions.patch(
        key,
        { model: "openai/gpt-shared" },
        { deferListRefresh: true },
      );
      if (outcome === "resolve") {
        pendingPatch.resolve({ ok: true, path: "", key, entry: {} });
        await expect(operation).resolves.toMatchObject({ ok: true, key });
      } else {
        pendingPatch.reject(new Error("agent A patch failed"));
        await expect(operation).rejects.toThrow("agent A patch failed");
      }

      expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-shared");
      expect(sessions.state.error).toBe(
        ownerActive && outcome === "reject" ? "agent A patch failed" : null,
      );
      replacementPatch.resolve({ ok: true, key, entry: {} });
      await replacement;
      sessions.dispose();
    },
  );

  it("does not reuse a retired owner's model baseline for the next owner", async () => {
    const agentAPatch = createDeferred<unknown>();
    const agentBPatch = createDeferred<unknown>();
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
