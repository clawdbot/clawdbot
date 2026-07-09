import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  configureCodexSessionsPolling,
  getCodexSessionsState,
  loadCodexSessions,
  loadMoreCodexSessions,
  setCodexSessionsSearch,
  stopCodexSessionsPolling,
  type CodexSessionsPayload,
} from "./codex-sessions-controller.ts";

function clientWithRequest(
  request: (method: string, params: unknown) => Promise<unknown>,
): GatewayBrowserClient {
  return { request } as GatewayBrowserClient;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function payload(
  sessions: Array<{ threadId: string; name: string }>,
  nextCursor?: string,
): CodexSessionsPayload {
  return {
    hosts: [
      {
        hostId: "node:macbook",
        label: "MacBook",
        kind: "node",
        connected: true,
        sessions: sessions.map((session) => ({
          ...session,
          archived: false,
          status: "idle",
        })),
        nextCursor,
      },
    ],
  };
}

describe("Codex sessions controller", () => {
  const hosts: object[] = [];

  afterEach(() => {
    for (const host of hosts.splice(0)) {
      stopCodexSessionsPolling(host);
    }
    vi.useRealTimers();
  });

  it("loads a first page with the active archive scope", async () => {
    const host = {};
    hosts.push(host);
    const request = vi.fn(async () => payload([{ threadId: "thread-1", name: "Fix tests" }]));
    const state = getCodexSessionsState(host);

    await loadCodexSessions(state, clientWithRequest(request));

    expect(request).toHaveBeenCalledWith("codex-supervisor.sessions.list", {
      archived: false,
      limitPerHost: 40,
    });
    expect(state.hosts[0]?.sessions[0]?.threadId).toBe("thread-1");
    expect(state.refreshedAtMs).not.toBeNull();
  });

  it("discards an older response as soon as the search changes", async () => {
    vi.useFakeTimers();
    const host = {};
    hosts.push(host);
    const first = deferred<CodexSessionsPayload>();
    const second = deferred<CodexSessionsPayload>();
    const request = vi
      .fn<() => Promise<CodexSessionsPayload>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const client = clientWithRequest(request);
    const state = getCodexSessionsState(host);
    const initialLoad = loadCodexSessions(state, client);

    setCodexSessionsSearch(state, client, "release");
    first.resolve(payload([{ threadId: "stale", name: "Stale" }]));
    await initialLoad;
    expect(state.hosts).toEqual([]);

    await vi.advanceTimersByTimeAsync(250);
    expect(request).toHaveBeenLastCalledWith("codex-supervisor.sessions.list", {
      search: "release",
      archived: false,
      limitPerHost: 40,
    });
    second.resolve(payload([{ threadId: "fresh", name: "Release" }]));
    await vi.runAllTimersAsync();
    await vi.waitFor(() => expect(state.hosts[0]?.sessions[0]?.threadId).toBe("fresh"));
  });

  it("appends one host page without duplicating overlapping sessions", async () => {
    const host = {};
    hosts.push(host);
    const state = getCodexSessionsState(host);
    state.hosts = payload([{ threadId: "thread-1", name: "First" }], "cursor-2").hosts;
    const request = vi.fn(async () =>
      payload(
        [
          { threadId: "thread-1", name: "First" },
          { threadId: "thread-2", name: "Second" },
        ],
        undefined,
      ),
    );

    await loadMoreCodexSessions(state, clientWithRequest(request), "node:macbook");

    expect(request).toHaveBeenCalledWith("codex-supervisor.sessions.list", {
      archived: false,
      limitPerHost: 40,
      hostIds: ["node:macbook"],
      cursors: { "node:macbook": "cursor-2" },
    });
    expect(state.hosts[0]?.sessions.map((session) => session.threadId)).toEqual([
      "thread-1",
      "thread-2",
    ]);
    expect(state.hosts[0]?.nextCursor).toBeUndefined();
  });

  it("stops pagination when the requested host disappears", async () => {
    const host = {};
    hosts.push(host);
    const state = getCodexSessionsState(host);
    state.hosts = payload([{ threadId: "thread-1", name: "First" }], "cursor-2").hosts;
    const request = vi.fn(async () => ({ hosts: [] }));

    await loadMoreCodexSessions(state, clientWithRequest(request), "node:macbook");

    expect(state.hosts[0]?.nextCursor).toBeUndefined();
    expect(state.hosts[0]?.error).toEqual({
      code: "PAGE_LOAD_FAILED",
      message: "Session catalog host is no longer available",
    });
    expect(state.hosts[0]?.sessions[0]?.threadId).toBe("thread-1");
  });

  it("preserves appended host pages during a silent refresh", async () => {
    const host = {};
    hosts.push(host);
    const state = getCodexSessionsState(host);
    state.hosts = payload(
      [
        { threadId: "thread-1", name: "First" },
        { threadId: "thread-2", name: "Second" },
      ],
      "cursor-3",
    ).hosts;
    state.paginatedHostIds = new Set(["node:macbook"]);
    const request = vi.fn(async () =>
      payload(
        [
          { threadId: "thread-new", name: "Newest" },
          { threadId: "thread-1", name: "First updated" },
        ],
        "cursor-2",
      ),
    );

    await loadCodexSessions(state, clientWithRequest(request), {
      preservePagination: true,
      silent: true,
    });

    expect(state.hosts[0]?.sessions.map((session) => session.threadId)).toEqual([
      "thread-new",
      "thread-1",
      "thread-2",
    ]);
    expect(state.hosts[0]?.sessions[1]?.name).toBe("First updated");
    expect(state.hosts[0]?.nextCursor).toBe("cursor-3");
  });

  it("waits for a slow poll before scheduling the next one", async () => {
    vi.useFakeTimers();
    const host = {};
    hosts.push(host);
    const first = deferred<CodexSessionsPayload>();
    const request = vi
      .fn<() => Promise<CodexSessionsPayload>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(payload([{ threadId: "fresh", name: "Fresh" }]));
    const client = clientWithRequest(request);
    const state = getCodexSessionsState(host);

    configureCodexSessionsPolling(state, client, true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(1);

    first.resolve(payload([{ threadId: "slow", name: "Slow" }]));
    await vi.waitFor(() => expect(state.hosts[0]?.sessions[0]?.threadId).toBe("slow"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("refreshes immediately after the first failed load reconnects", async () => {
    const host = {};
    hosts.push(host);
    const firstRequest = vi.fn(async () => {
      throw new Error("gateway not connected");
    });
    const secondRequest = vi.fn(async () =>
      payload([{ threadId: "reconnected", name: "Reconnected" }]),
    );
    const firstClient = clientWithRequest(firstRequest);
    const secondClient = clientWithRequest(secondRequest);
    const state = getCodexSessionsState(host);

    configureCodexSessionsPolling(state, firstClient, true);
    await loadCodexSessions(state, firstClient);
    expect(state.error).toBe("gateway not connected");

    configureCodexSessionsPolling(state, firstClient, false);
    configureCodexSessionsPolling(state, secondClient, true);

    await vi.waitFor(() => expect(state.hosts[0]?.sessions[0]?.threadId).toBe("reconnected"));
    expect(secondRequest).toHaveBeenCalledTimes(1);
    expect(state.error).toBeNull();
  });

  it("clears a pending search before refreshing a rebound client", async () => {
    vi.useFakeTimers();
    const host = {};
    hosts.push(host);
    const firstRequest = vi.fn(async () => payload([{ threadId: "initial", name: "Initial" }]));
    const secondRequest = vi.fn(async () => payload([{ threadId: "rebound", name: "Release" }]));
    const firstClient = clientWithRequest(firstRequest);
    const secondClient = clientWithRequest(secondRequest);
    const state = getCodexSessionsState(host);

    configureCodexSessionsPolling(state, firstClient, true);
    await loadCodexSessions(state, firstClient);
    setCodexSessionsSearch(state, firstClient, "release");
    configureCodexSessionsPolling(state, secondClient, true);

    await vi.waitFor(() => expect(secondRequest).toHaveBeenCalledTimes(1));
    expect(secondRequest).toHaveBeenCalledWith("codex-supervisor.sessions.list", {
      archived: false,
      limitPerHost: 40,
    });
    expect(state.search).toBe("");
    await vi.advanceTimersByTimeAsync(250);
    expect(firstRequest).toHaveBeenCalledTimes(1);
    expect(secondRequest).toHaveBeenCalledTimes(1);
  });

  it("does not retain catalog metadata when a rebound client fails", async () => {
    const host = {};
    hosts.push(host);
    const firstClient = clientWithRequest(
      vi.fn(async () => payload([{ threadId: "private-thread", name: "Private" }], "cursor-2")),
    );
    const secondRequest = vi.fn(async () => {
      throw new Error("new gateway unavailable");
    });
    const secondClient = clientWithRequest(secondRequest);
    const state = getCodexSessionsState(host);

    configureCodexSessionsPolling(state, firstClient, true);
    await loadCodexSessions(state, firstClient);
    state.search = "private search";
    state.paginatedHostIds = new Set(["node:macbook"]);

    configureCodexSessionsPolling(state, secondClient, true);

    await vi.waitFor(() => expect(state.error).toBe("new gateway unavailable"));
    expect(state.hosts).toEqual([]);
    expect(state.search).toBe("");
    expect(state.paginatedHostIds.size).toBe(0);
    expect(state.refreshedAtMs).toBeNull();
    expect(secondRequest).toHaveBeenCalledTimes(1);
  });

  it("clears catalog metadata when its plugin tab stops", async () => {
    const host = {};
    hosts.push(host);
    const state = getCodexSessionsState(host);
    state.hosts = payload([{ threadId: "private-thread", name: "Private" }], "cursor-2").hosts;
    state.search = "private search";
    state.error = "private error";
    state.refreshedAtMs = Date.now();
    state.paginatedHostIds = new Set(["node:macbook"]);

    stopCodexSessionsPolling(host);

    expect(state.hosts).toEqual([]);
    expect(state.search).toBe("");
    expect(state.error).toBeNull();
    expect(state.refreshedAtMs).toBeNull();
    expect(state.paginatedHostIds.size).toBe(0);
  });

  it("clears an invalidated loading state when the tab closes during search debounce", async () => {
    vi.useFakeTimers();
    const host = {};
    hosts.push(host);
    const first = deferred<CodexSessionsPayload>();
    const request = vi
      .fn<() => Promise<CodexSessionsPayload>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(payload([{ threadId: "fresh", name: "Fresh" }]));
    const client = clientWithRequest(request);
    const state = getCodexSessionsState(host);
    const initialLoad = loadCodexSessions(state, client);

    setCodexSessionsSearch(state, client, "fresh");
    stopCodexSessionsPolling(host);
    expect(state.loading).toBe(false);

    first.resolve(payload([{ threadId: "stale", name: "Stale" }]));
    await initialLoad;
    await vi.advanceTimersByTimeAsync(250);
    expect(request).toHaveBeenCalledTimes(1);

    await loadCodexSessions(state, client);
    expect(state.hosts[0]?.sessions[0]?.threadId).toBe("fresh");
  });
});
