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

function createSessions(
  client: GatewayBrowserClient,
  key: string,
  subscribeEvents: Parameters<typeof createSessionCapability>[0]["subscribeEvents"] = () => () =>
    undefined,
) {
  return createSessionCapability({
    snapshot: {
      client,
      phase: "connected" as const,
      sessionKey: key,
      assistantAgentId: "main",
      hello: null,
      selfUser: null,
    },
    subscribe: () => () => undefined,
    subscribeEvents,
  });
}

describe("session owner assignment list reconciliation", () => {
  it("keeps the confirmed owner and invalidates facets during reconciliation", async () => {
    const key = "agent:main:owner-facet";
    const ada = { type: "human" as const, id: "profile-ada", label: "Ada" };
    const bob = { type: "human" as const, id: "profile-bob", label: "Bob" };
    const assignedOwner = { actor: ada, assignedBy: ada, assignedAt: 20 };
    const replacement = deferred<SessionsListResult>();
    let listCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.assignOwner") {
        return { ok: true, key, owner: assignedOwner };
      }
      if (method === "sessions.list") {
        listCalls += 1;
        return listCalls === 1
          ? {
              ...sessionsResult(
                [{ key, kind: "direct", updatedAt: 10, owner: { actor: bob, assignedBy: bob } }],
                10,
              ),
              owners: [bob],
            }
          : await replacement.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const sessions = createSessions({ request } as unknown as GatewayBrowserClient, key);
    await sessions.refresh({ agentId: "main", force: true });

    await sessions.assignOwner(key, ada, { agentId: "main" });

    expect(sessions.state.result?.sessions[0]?.owner).toEqual(assignedOwner);
    expect(sessions.state.result?.owners).toBeUndefined();
    replacement.resolve({
      ...sessionsResult([{ key, kind: "direct", updatedAt: 20, owner: assignedOwner }], 20),
      owners: [ada],
    });
    sessions.dispose();
  });

  it("protects direct list responses started before assignment", async () => {
    const key = "agent:main:direct-owner";
    const ada = { type: "human" as const, id: "profile-ada" };
    const bob = { type: "human" as const, id: "profile-bob" };
    const assignedOwner = { actor: ada, assignedBy: ada, assignedAt: 20 };
    const staleList = deferred<SessionsListResult>();
    let listCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.assignOwner") {
        return { ok: true, key, owner: assignedOwner };
      }
      if (method === "sessions.list") {
        listCalls += 1;
        return listCalls === 2
          ? await staleList.promise
          : sessionsResult([{ key, kind: "direct", updatedAt: 20, owner: assignedOwner }], 20);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const sessions = createSessions({ request } as unknown as GatewayBrowserClient, key);
    await sessions.refresh({ agentId: "main", force: true });
    const directList = sessions.list({ agentId: "main" });
    await vi.waitFor(() => expect(listCalls).toBe(2));

    await sessions.assignOwner(key, ada, { agentId: "main" });
    staleList.resolve(
      sessionsResult(
        [{ key, kind: "direct", updatedAt: 10, owner: { actor: bob, assignedBy: bob } }],
        10,
      ),
    );

    await expect(directList).resolves.toMatchObject({
      sessions: [{ owner: assignedOwner }],
    });
    sessions.dispose();
  });

  it("accepts a newer owner event while assignment reconciliation is pending", async () => {
    const key = "agent:main:event-owner";
    const ada = { type: "human" as const, id: "profile-ada" };
    const bob = { type: "human" as const, id: "profile-bob" };
    const carol = { type: "human" as const, id: "profile-carol" };
    const assignedOwner = { actor: ada, assignedBy: ada, assignedAt: 20 };
    const newerOwner = { actor: carol, assignedBy: carol, assignedAt: 30 };
    const replacement = deferred<SessionsListResult>();
    let listener: Parameters<
      Parameters<typeof createSessionCapability>[0]["subscribeEvents"]
    >[0] = () => undefined;
    let listCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.assignOwner") {
        return { ok: true, key, owner: assignedOwner };
      }
      if (method === "sessions.list") {
        listCalls += 1;
        return listCalls === 1
          ? sessionsResult(
              [{ key, kind: "direct", updatedAt: 10, owner: { actor: bob, assignedBy: bob } }],
              10,
            )
          : await replacement.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const sessions = createSessions({ request } as unknown as GatewayBrowserClient, key, (next) => {
      listener = next;
      return () => undefined;
    });
    await sessions.refresh({ agentId: "main", force: true });
    await sessions.assignOwner(key, ada, { agentId: "main" });

    listener({
      type: "event",
      event: "sessions.changed",
      seq: 1,
      payload: {
        key,
        kind: "direct",
        updatedAt: 30,
        owner: newerOwner,
        archived: false,
        reason: "owner",
      },
    });

    expect(sessions.state.result?.sessions[0]?.owner).toEqual(newerOwner);
    replacement.resolve(
      sessionsResult([{ key, kind: "direct", updatedAt: 30, owner: newerOwner }], 30),
    );
    sessions.dispose();
  });

  it.each([
    { label: "without timestamps", assignedAt: undefined },
    { label: "with tied timestamps", assignedAt: 20 },
  ])("accepts a later assignment $label", async ({ assignedAt }) => {
    const key = "agent:main:equal-assignment-revisions";
    const ada = { type: "human" as const, id: "profile-ada", label: "Ada" };
    const bob = { type: "human" as const, id: "profile-bob", label: "Bob" };
    const carol = { type: "human" as const, id: "profile-carol", label: "Carol" };
    const oldOwner = { actor: bob, assignedBy: bob, assignedAt: 10 };
    const adaOwner = {
      actor: ada,
      assignedBy: ada,
      ...(assignedAt === undefined ? {} : { assignedAt }),
    };
    const carolOwner = {
      actor: carol,
      assignedBy: carol,
      ...(assignedAt === undefined ? {} : { assignedAt }),
    };
    const responses = [adaOwner, carolOwner];
    let serverOwner: NonNullable<SessionsListResult["sessions"][number]["owner"]> = oldOwner;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.assignOwner") {
        const owner = responses.shift();
        if (!owner) {
          throw new Error("missing assignment response");
        }
        serverOwner = owner;
        return { ok: true, key, owner };
      }
      if (method === "sessions.list") {
        return sessionsResult([{ key, kind: "direct", updatedAt: 20, owner: serverOwner }], 20);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const sessions = createSessions({ request } as unknown as GatewayBrowserClient, key);
    await sessions.refresh({ agentId: "main", force: true });

    await expect(sessions.assignOwner(key, ada, { agentId: "main" })).resolves.toEqual(adaOwner);
    await expect(sessions.assignOwner(key, carol, { agentId: "main" })).resolves.toEqual(
      carolOwner,
    );
    expect(sessions.state.result?.sessions[0]?.owner).toEqual(carolOwner);
    sessions.dispose();
  });

  it("serializes assignment requests so responses cannot arrive out of order", async () => {
    const key = "agent:main:reversed-assignments";
    const ada = { type: "human" as const, id: "profile-ada", label: "Ada" };
    const bob = { type: "human" as const, id: "profile-bob", label: "Bob" };
    const carol = { type: "human" as const, id: "profile-carol", label: "Carol" };
    const oldOwner = { actor: bob, assignedBy: bob, assignedAt: 10 };
    const adaOwner = { actor: ada, assignedBy: ada, assignedAt: 20 };
    const carolOwner = { actor: carol, assignedBy: carol, assignedAt: 30 };
    const firstResponse = deferred<typeof adaOwner>();
    const secondResponse = deferred<typeof carolOwner>();
    let assignmentCalls = 0;
    let serverOwner = oldOwner;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.assignOwner") {
        assignmentCalls += 1;
        const call = assignmentCalls;
        const owner = await (call === 1 ? firstResponse.promise : secondResponse.promise);
        if (call === 2) {
          serverOwner = owner;
        }
        return { ok: true, key, owner };
      }
      if (method === "sessions.list") {
        return sessionsResult([{ key, kind: "direct", updatedAt: 20, owner: serverOwner }], 20);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const sessions = createSessions({ request } as unknown as GatewayBrowserClient, key);
    await sessions.refresh({ agentId: "main", force: true });

    const first = sessions.assignOwner(key, ada, { agentId: "main" });
    await vi.waitFor(() => expect(assignmentCalls).toBe(1));
    const second = sessions.assignOwner(key, carol, { agentId: "main" });

    firstResponse.resolve(adaOwner);
    await expect(first).resolves.toEqual(adaOwner);
    await vi.waitFor(() => expect(assignmentCalls).toBe(2));
    secondResponse.resolve(carolOwner);
    await expect(second).resolves.toEqual(carolOwner);
    expect(sessions.state.result?.sessions[0]?.owner).toEqual(carolOwner);
    sessions.dispose();
  });

  it("keeps an earlier successful assignment when the queued request fails", async () => {
    const key = "agent:main:failed-queued-assignment";
    const ada = { type: "human" as const, id: "profile-ada", label: "Ada" };
    const carol = { type: "human" as const, id: "profile-carol", label: "Carol" };
    const adaOwner = { actor: ada, assignedBy: ada };
    const serverOwner = adaOwner;
    let assignmentCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.assignOwner") {
        assignmentCalls += 1;
        if (assignmentCalls === 2) {
          throw new Error("assignment rejected");
        }
        return { ok: true, key, owner: adaOwner };
      }
      if (method === "sessions.list") {
        return sessionsResult([{ key, kind: "direct", updatedAt: 20, owner: serverOwner }], 20);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const sessions = createSessions({ request } as unknown as GatewayBrowserClient, key);
    await sessions.refresh({ agentId: "main", force: true });

    await expect(sessions.assignOwner(key, ada, { agentId: "main" })).resolves.toEqual(adaOwner);
    await expect(sessions.assignOwner(key, carol, { agentId: "main" })).resolves.toBeNull();
    expect(sessions.state.result?.sessions[0]?.owner).toEqual(adaOwner);
    expect(assignmentCalls).toBe(2);
    sessions.dispose();
  });

  it("refreshes an active owner filter that gains the assigned session", async () => {
    const key = "agent:main:new-owner-filter";
    const ada = { type: "human" as const, id: "profile-ada", label: "Ada" };
    const bob = { type: "human" as const, id: "profile-bob", label: "Bob" };
    const assignedOwner = { actor: ada, assignedBy: ada, assignedAt: 20 };
    const replacement = deferred<SessionsListResult>();
    const managedScope = { agentId: "main", ownerId: ada.id };
    let managedCalls = 0;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "sessions.assignOwner") {
        return { ok: true, key, owner: assignedOwner };
      }
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      const managed =
        typeof params === "object" &&
        params !== null &&
        "ownerId" in params &&
        params.ownerId === ada.id;
      if (!managed) {
        return sessionsResult([{ key, kind: "direct", updatedAt: 20, owner: assignedOwner }], 20);
      }
      managedCalls += 1;
      return managedCalls === 1
        ? { ...sessionsResult([], 10), owners: [bob] }
        : await replacement.promise;
    });
    const sessions = createSessions({ request } as unknown as GatewayBrowserClient, key);
    const stop = sessions.subscribeList(managedScope, () => undefined);

    await sessions.refreshList({ ...managedScope, force: true });
    expect(sessions.listSnapshot(managedScope).result?.sessions).toHaveLength(0);

    await sessions.assignOwner(key, ada, { agentId: "main" });

    await vi.waitFor(() => expect(managedCalls).toBe(2));
    expect(sessions.listSnapshot(managedScope).result?.owners).toBeUndefined();

    replacement.resolve({
      ...sessionsResult([{ key, kind: "direct", updatedAt: 20, owner: assignedOwner }], 20),
      owners: [ada],
    });
    await vi.waitFor(() =>
      expect(sessions.listSnapshot(managedScope).result?.sessions[0]?.owner).toEqual(assignedOwner),
    );
    stop();
    sessions.dispose();
  });

  it("carries a newer owner through an older managed-list response", async () => {
    const key = "agent:main:superseded-managed-owner";
    const ada = { type: "human" as const, id: "profile-ada", label: "Ada" };
    const bob = { type: "human" as const, id: "profile-bob", label: "Bob" };
    const carol = { type: "human" as const, id: "profile-carol", label: "Carol" };
    const oldOwner = { actor: bob, assignedBy: bob, assignedAt: 10 };
    const assignedOwner = { actor: ada, assignedBy: ada, assignedAt: 20 };
    const supersedingOwner = { actor: carol, assignedBy: carol, assignedAt: 30 };
    const staleManagedResponse = deferred<SessionsListResult>();
    const managedReplacement = deferred<SessionsListResult>();
    const managedScope = { agentId: "main", search: "superseded-managed-owner" };
    let managedCalls = 0;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "sessions.assignOwner") {
        return { ok: true, key, owner: assignedOwner };
      }
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      const managed =
        typeof params === "object" &&
        params !== null &&
        "search" in params &&
        params.search === managedScope.search;
      if (!managed) {
        return {
          ...sessionsResult([{ key, kind: "direct", updatedAt: 30, owner: supersedingOwner }], 30),
          owners: [carol],
        };
      }
      managedCalls += 1;
      if (managedCalls === 2) {
        return await staleManagedResponse.promise;
      }
      if (managedCalls === 3) {
        return await managedReplacement.promise;
      }
      return {
        ...sessionsResult([{ key, kind: "direct", updatedAt: 10, owner: oldOwner }], 10),
        owners: [ada, bob],
      };
    });
    const sessions = createSessions({ request } as unknown as GatewayBrowserClient, key);
    const stop = sessions.subscribeList(managedScope, () => undefined);

    await sessions.refreshList({ ...managedScope, force: true });
    const staleRefresh = sessions.refreshList({ ...managedScope, force: true });
    await vi.waitFor(() => expect(managedCalls).toBe(2));
    await sessions.assignOwner(key, ada, { agentId: "main" });

    staleManagedResponse.resolve({
      ...sessionsResult([{ key, kind: "direct", updatedAt: 10, owner: oldOwner }], 10),
      owners: [ada, bob],
    });
    await vi.waitFor(() => expect(managedCalls).toBe(3));
    expect(sessions.listSnapshot(managedScope).result?.sessions[0]?.owner).toEqual(
      supersedingOwner,
    );
    expect(sessions.listSnapshot(managedScope).result?.owners).toBeUndefined();

    managedReplacement.resolve({
      ...sessionsResult([{ key, kind: "direct", updatedAt: 30, owner: supersedingOwner }], 30),
      owners: [carol],
    });
    await staleRefresh;
    expect(sessions.listSnapshot(managedScope).result?.owners).toEqual([carol]);
    stop();
    sessions.dispose();
  });

  it("retains the confirmed owner until the matching managed list catches up", async () => {
    const key = "agent:main:managed-owner";
    const ada = { type: "human" as const, id: "profile-ada", label: "Ada" };
    const bob = { type: "human" as const, id: "profile-bob", label: "Bob" };
    const oldOwner = { actor: bob, assignedBy: ada, assignedAt: 10 };
    const assignedOwner = { actor: ada, assignedBy: ada, assignedAt: 20 };
    const staleManagedResponse = deferred<SessionsListResult>();
    const managedReplacement = deferred<SessionsListResult>();
    const managedScope = { agentId: "main", search: "managed-owner" };
    let managedCalls = 0;
    let primaryCalls = 0;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "sessions.assignOwner") {
        return { ok: true, key, owner: assignedOwner };
      }
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      const managed =
        typeof params === "object" &&
        params !== null &&
        "search" in params &&
        params.search === managedScope.search;
      if (!managed) {
        primaryCalls += 1;
        return {
          ...sessionsResult([{ key, kind: "direct", updatedAt: 30, owner: assignedOwner }], 30),
          owners: [ada],
        };
      }
      managedCalls += 1;
      if (managedCalls === 2) {
        return await staleManagedResponse.promise;
      }
      if (managedCalls === 3) {
        return await managedReplacement.promise;
      }
      return {
        ...sessionsResult([{ key, kind: "direct", updatedAt: 10, owner: oldOwner }], 10),
        owners: [ada, bob],
      };
    });
    const sessions = createSessions({ request } as unknown as GatewayBrowserClient, key);
    const stop = sessions.subscribeList(managedScope, () => undefined);

    await sessions.refreshList({ ...managedScope, force: true });
    const staleRefresh = sessions.refreshList({ ...managedScope, force: true });
    await vi.waitFor(() => expect(managedCalls).toBe(2));
    await expect(sessions.assignOwner(key, ada, { agentId: "main" })).resolves.toEqual(
      assignedOwner,
    );
    await vi.waitFor(() => expect(primaryCalls).toBeGreaterThanOrEqual(1));

    staleManagedResponse.resolve({
      ...sessionsResult([{ key, kind: "direct", updatedAt: 10, owner: oldOwner }], 10),
      owners: [ada, bob],
    });
    await vi.waitFor(() => expect(managedCalls).toBe(3));
    expect(sessions.listSnapshot(managedScope).result?.sessions[0]?.owner).toEqual(assignedOwner);
    expect(sessions.listSnapshot(managedScope).result?.owners).toBeUndefined();

    managedReplacement.resolve({
      ...sessionsResult([{ key, kind: "direct", updatedAt: 20, owner: assignedOwner }], 20),
      owners: [ada],
    });
    await staleRefresh;
    expect(sessions.listSnapshot(managedScope).result?.sessions[0]?.owner).toEqual(assignedOwner);
    expect(sessions.listSnapshot(managedScope).result?.owners).toEqual([ada]);
    stop();
    sessions.dispose();
  });
});
