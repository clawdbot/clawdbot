import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createSessionCapability } from "./index.ts";

type ListParams = { archived?: true | "all"; limit?: number; offset?: number };

function listResult(keys: string[] = [], totalCount = keys.length, offset = 0): SessionsListResult {
  const nextOffset = offset + keys.length;
  return {
    ts: 1,
    path: "",
    count: keys.length,
    totalCount,
    hasMore: nextOffset < totalCount,
    nextOffset: nextOffset < totalCount ? nextOffset : null,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: keys.map((key, updatedAt) => ({ key, kind: "direct", updatedAt })),
  };
}

function sessionHarness(request: unknown) {
  const snapshot = {
    client: { request } as unknown as GatewayBrowserClient,
    phase: "connected" as "connected" | "reconnecting",
    sessionKey: "agent:main:main",
    assistantAgentId: "main",
    hello: null,
  };
  let listener: ((next: typeof snapshot) => void) | undefined;
  const sessions = createSessionCapability({
    snapshot,
    subscribe(next) {
      listener = next;
      return () => undefined;
    },
    subscribeEvents: () => () => undefined,
  });
  return {
    sessions,
    reconnect: () => {
      for (const phase of ["reconnecting", "connected"] as const) {
        snapshot.phase = phase;
        listener?.(snapshot);
      }
    },
  };
}

describe("session list requests", () => {
  it("forwards a trimmed parent key when listing child sessions", async () => {
    const request = vi.fn(async (_method: string, _params?: unknown) => listResult());
    const { sessions } = sessionHarness(request);
    const options = { agentId: "main", limit: 20, includeGlobal: false, includeUnknown: false };
    await sessions.list({ ...options, spawnedBy: "  agent:main:parent  " });
    expect(request).toHaveBeenCalledWith("sessions.list", {
      ...options,
      configuredAgentsOnly: true,
      spawnedBy: "agent:main:parent",
    });
    sessions.dispose();
  });

  it("maps archived status filters to the tri-state wire contract", async () => {
    const request = vi.fn(async (_method: string, _params?: unknown) => listResult());
    const { sessions } = sessionHarness(request);
    await sessions.list({ archivedFilter: "active", activeMinutes: 30 });
    await sessions.list({ archivedFilter: "archived", activeMinutes: 30 });
    await sessions.list({ archivedFilter: "all", activeMinutes: 30 });
    expect(request.mock.calls[0]?.[1]).toMatchObject({ activeMinutes: 30 });
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty("archived");
    expect(request.mock.calls[1]?.[1]).toMatchObject({ archived: true });
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("activeMinutes");
    expect(request.mock.calls[2]?.[1]).toMatchObject({ archived: "all" });
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("activeMinutes");
    sessions.dispose();
  });

  it("forwards the server-side face filter", async () => {
    const request = vi.fn(async () => listResult());
    const { sessions } = sessionHarness(request);
    await sessions.list({ boardFace: "dashboard" });
    expect(request).toHaveBeenCalledWith("sessions.list", {
      configuredAgentsOnly: true,
      boardFace: "dashboard",
      includeGlobal: true,
      includeUnknown: true,
      limit: 50,
    });
    sessions.dispose();
  });

  it("discards a list rejection from a retired same-client connection", async () => {
    let rejectStale!: (error: Error) => void;
    const staleRequest = new Promise<SessionsListResult>((_resolve, reject) => {
      rejectStale = reject;
    });
    const request = vi.fn(async () => staleRequest);
    const { sessions, reconnect } = sessionHarness(request);
    const retiredRequest = sessions.list({ boardFace: "dashboard" });
    reconnect();
    rejectStale(new Error("retired connection"));
    await expect(retiredRequest).resolves.toBeNull();
    sessions.dispose();
  });

  it("keeps filtered pages scoped without replacing the canonical active roster", async () => {
    const request = vi.fn(async (_method: string, params?: ListParams) => {
      const filter = params?.archived === true ? "archived" : params?.archived || "active";
      const offset = params?.offset ?? 0;
      const keys = Array.from({ length: 4 }, (_, index) => `agent:main:${filter}-${index}`);
      return listResult(keys.slice(offset, offset + (params?.limit ?? 50)), 4, offset);
    });
    const { sessions } = sessionHarness(request);
    const archivedScope = { agentId: "main", archivedFilter: "archived" as const };
    const allScope = { agentId: "main", archivedFilter: "all" as const };
    const observeSnapshot = vi.fn();
    const unsubscribe = sessions.subscribeList(archivedScope, observeSnapshot);
    await sessions.refreshList({ agentId: "main", limit: 1, force: true });
    const activeResult = sessions.state.result;
    await sessions.refreshList({ ...archivedScope, limit: 2 });
    await sessions.refreshList({ ...archivedScope, limit: 2, offset: 2, append: true });
    await sessions.refreshList({ ...allScope, limit: 1 });
    await sessions.refreshList({ ...archivedScope, limit: 2 });
    expect(request).toHaveBeenLastCalledWith(
      "sessions.list",
      expect.objectContaining({ agentId: "main", archived: true, limit: 4 }),
    );
    expect(sessions.listSnapshot(archivedScope).result?.sessions).toHaveLength(4);
    expect(sessions.listSnapshot(allScope).result?.sessions).toHaveLength(1);
    expect(sessions.state.result).toBe(activeResult);
    expect(sessions.canonicalListRevision).toBe(1);
    expect(observeSnapshot).toHaveBeenCalledWith(expect.objectContaining({ loading: true }));
    unsubscribe();
    sessions.dispose();
  });

  it("retires stale filtered snapshots across same-client reconnects without losing subscribers", async () => {
    let resolveStale!: (result: SessionsListResult) => void;
    const staleResult = new Promise<SessionsListResult>((resolve) => {
      resolveStale = resolve;
    });
    let archivedRequests = 0;
    const request = vi.fn(async (method: string, params?: { archived?: boolean }) => {
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (params?.archived) {
        archivedRequests += 1;
        return archivedRequests === 1 ? staleResult : listResult(["agent:main:current"]);
      }
      return listResult(["agent:main:active"]);
    });
    const { sessions, reconnect } = sessionHarness(request);
    const scope = { agentId: "main", archivedFilter: "archived" as const };
    const observed: Array<string | null> = [];
    const unsubscribe = sessions.subscribeList(scope, (next) =>
      observed.push(next.result?.sessions[0]?.key ?? null),
    );
    const retiredRequest = sessions.refreshList(scope);
    reconnect();
    resolveStale(listResult(["agent:main:stale"]));
    await retiredRequest;
    await sessions.refreshList(scope);
    expect(sessions.listSnapshot(scope).result?.sessions[0]?.key).toBe("agent:main:current");
    expect(observed).toContain(null);
    expect(observed).toContain("agent:main:current");
    expect(observed).not.toContain("agent:main:stale");
    unsubscribe();
    sessions.dispose();
  });
});
