import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  archiveCodexSession,
  configureCodexSessionsPolling,
  continueCodexSession,
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
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

type SessionFixture = {
  threadId: string;
  name: string;
  status?: string;
  openClawSessionKey?: string;
};

function payload(sessions: SessionFixture[], nextCursor?: string): CodexSessionsPayload {
  return {
    hosts: [
      {
        hostId: "node:macbook",
        label: "MacBook",
        kind: "node",
        connected: true,
        sessions: sessions.map(({ status = "idle", ...session }) => ({
          ...session,
          archived: false,
          status,
        })),
        nextCursor,
      },
    ],
  };
}

function gatewayPayload(sessions: SessionFixture[], nextCursor?: string): CodexSessionsPayload {
  const result = payload(sessions, nextCursor);
  const host = result.hosts[0];
  if (!host) {
    return result;
  }
  return {
    hosts: [
      {
        ...host,
        hostId: "gateway:local",
        label: "Gateway",
        kind: "gateway",
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

  it("loads a first page from the non-archived Codex catalog", async () => {
    const host = {};
    hosts.push(host);
    const request = vi.fn(async () => payload([{ threadId: "thread-1", name: "Fix tests" }]));
    const state = getCodexSessionsState(host);

    await loadCodexSessions(state, clientWithRequest(request));

    expect(request).toHaveBeenCalledWith("codex.sessions.list", {
      limitPerHost: 40,
    });
    expect(state.hosts[0]?.sessions[0]?.threadId).toBe("thread-1");
    expect(state.refreshedAtMs).not.toBeNull();
  });

  it("continues an idle Codex thread and returns its OpenClaw session key", async () => {
    const host = {};
    hosts.push(host);
    const state = getCodexSessionsState(host);
    state.hosts = gatewayPayload([{ threadId: "thread-1", name: "Fix tests" }]).hosts;
    const request = vi.fn(async () => ({
      sessionKey: "agent:main:codex-thread-1",
      disposition: "forked",
    }));
    const onContinue = vi.fn();

    await continueCodexSession(
      state,
      clientWithRequest(request),
      "gateway:local",
      "thread-1",
      onContinue,
    );

    expect(request).toHaveBeenCalledWith("codex.sessions.continue", {
      hostId: "gateway:local",
      threadId: "thread-1",
    });
    expect(onContinue).toHaveBeenCalledWith("agent:main:codex-thread-1");
    expect(state.pendingSessionActions.size).toBe(0);
    expect(state.actionError).toBeNull();
  });

  it("revalidates a mapped active session before opening its OpenClaw chat", async () => {
    const host = {};
    hosts.push(host);
    const state = getCodexSessionsState(host);
    state.hosts = gatewayPayload([
      {
        threadId: "thread-active",
        name: "Already supervised",
        status: "active",
        openClawSessionKey: "agent:main:stale-catalog-key",
      },
    ]).hosts;
    const request = vi.fn(async () => ({
      sessionKey: "agent:main:current-codex-session",
      disposition: "existing",
    }));
    const onContinue = vi.fn();

    await continueCodexSession(
      state,
      clientWithRequest(request),
      "gateway:local",
      "thread-active",
      onContinue,
    );

    expect(request).toHaveBeenCalledWith("codex.sessions.continue", {
      hostId: "gateway:local",
      threadId: "thread-active",
    });
    expect(onContinue).toHaveBeenCalledWith("agent:main:current-codex-session");
  });

  it("continues or confirmed-archives a not-loaded thread", async () => {
    const host = {};
    hosts.push(host);
    const state = getCodexSessionsState(host);
    state.hosts = gatewayPayload([
      { threadId: "thread-stored", name: "Stored work", status: "notLoaded" },
    ]).hosts;
    const request = vi.fn(async (method: string) => {
      if (method === "codex.sessions.continue") {
        return { sessionKey: "agent:main:codex-fork", disposition: "forked" };
      }
      if (method === "codex.sessions.archive") {
        return { archived: true };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const client = clientWithRequest(request);
    const onContinue = vi.fn();

    await continueCodexSession(state, client, "gateway:local", "thread-stored", onContinue);
    await archiveCodexSession(state, client, "gateway:local", "thread-stored", true);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith("codex.sessions.continue", {
      hostId: "gateway:local",
      threadId: "thread-stored",
    });
    expect(request).toHaveBeenCalledWith("codex.sessions.archive", {
      hostId: "gateway:local",
      threadId: "thread-stored",
      confirmNoOtherRunner: true,
    });
    expect(onContinue).toHaveBeenCalledWith("agent:main:codex-fork");
    expect(state.hosts[0]?.sessions).toEqual([]);
  });

  it("refuses actions for Codex sessions in an unsupported status", async () => {
    const host = {};
    hosts.push(host);
    const state = getCodexSessionsState(host);
    state.hosts = gatewayPayload([
      { threadId: "thread-error", name: "Broken work", status: "systemError" },
    ]).hosts;
    const request = vi.fn(async () => ({ sessionKey: "unexpected" }));
    const client = clientWithRequest(request);

    await continueCodexSession(state, client, "gateway:local", "thread-error", vi.fn());
    await archiveCodexSession(state, client, "gateway:local", "thread-error", true);

    expect(request).not.toHaveBeenCalled();
  });

  it("keeps paired-node sessions metadata-only even while the node is connected", async () => {
    const host = {};
    hosts.push(host);
    const state = getCodexSessionsState(host);
    state.hosts = payload([{ threadId: "thread-remote", name: "Remote work" }]).hosts;
    const request = vi.fn(async () => ({ sessionKey: "unexpected" }));
    const client = clientWithRequest(request);

    await continueCodexSession(state, client, "node:macbook", "thread-remote", vi.fn());
    await archiveCodexSession(state, client, "node:macbook", "thread-remote", true);

    expect(request).not.toHaveBeenCalled();
    expect(state.hosts[0]?.sessions[0]?.threadId).toBe("thread-remote");
  });

  it("keeps the canonical row while archiving and removes it after confirmation", async () => {
    const host = {};
    hosts.push(host);
    const state = getCodexSessionsState(host);
    state.hosts = gatewayPayload([{ threadId: "thread-1", name: "Fix tests" }]).hosts;
    const response = deferred<{ archived: boolean }>();
    const request = vi.fn(() => response.promise);
    const client = clientWithRequest(request);

    await archiveCodexSession(state, client, "gateway:local", "thread-1", false);
    expect(request).not.toHaveBeenCalled();
    expect(state.hosts[0]?.sessions[0]?.threadId).toBe("thread-1");

    const archiving = archiveCodexSession(state, client, "gateway:local", "thread-1", true);
    expect(state.hosts[0]?.sessions[0]?.threadId).toBe("thread-1");
    expect(state.pendingSessionActions.get('["gateway:local","thread-1"]')).toBe("archive");
    expect(request).toHaveBeenCalledWith("codex.sessions.archive", {
      hostId: "gateway:local",
      threadId: "thread-1",
      confirmNoOtherRunner: true,
    });

    response.resolve({ archived: true });
    await archiving;

    expect(state.hosts[0]?.sessions).toEqual([]);
    expect(state.pendingSessionActions.size).toBe(0);
  });

  it("does not resurrect a confirmed archive from an older first-page response", async () => {
    const host = {};
    hosts.push(host);
    const state = getCodexSessionsState(host);
    state.hosts = gatewayPayload([{ threadId: "thread-1", name: "Archived" }]).hosts;
    const listResponse = deferred<CodexSessionsPayload>();
    const request = vi.fn((method: string) => {
      if (method === "codex.sessions.list") {
        return listResponse.promise;
      }
      if (method === "codex.sessions.archive") {
        return Promise.resolve({ archived: true });
      }
      return Promise.reject(new Error(`Unexpected method: ${method}`));
    });
    const client = clientWithRequest(request);

    const loading = loadCodexSessions(state, client);
    await archiveCodexSession(state, client, "gateway:local", "thread-1", true);
    listResponse.resolve(
      gatewayPayload([
        { threadId: "thread-1", name: "Stale archived row" },
        { threadId: "thread-2", name: "Survivor" },
      ]),
    );
    await loading;

    expect(state.hosts[0]?.sessions.map((session) => session.threadId)).toEqual(["thread-2"]);
    expect(state.pendingSessionActions.size).toBe(0);
  });

  it("restores a refreshed row immediately when an in-flight archive fails", async () => {
    const host = {};
    hosts.push(host);
    const state = getCodexSessionsState(host);
    state.hosts = gatewayPayload([{ threadId: "thread-1", name: "Before refresh" }]).hosts;
    const archiveResponse = deferred<{ archived: boolean }>();
    const listResponse = deferred<CodexSessionsPayload>();
    const request = vi.fn((method: string) => {
      if (method === "codex.sessions.archive") {
        return archiveResponse.promise;
      }
      if (method === "codex.sessions.list") {
        return listResponse.promise;
      }
      return Promise.reject(new Error(`Unexpected method: ${method}`));
    });
    const client = clientWithRequest(request);

    const archiving = archiveCodexSession(state, client, "gateway:local", "thread-1", true);
    const loading = loadCodexSessions(state, client);
    listResponse.resolve(
      gatewayPayload([
        { threadId: "thread-1", name: "Refreshed while pending" },
        { threadId: "thread-2", name: "Second" },
      ]),
    );
    await loading;

    expect(state.hosts[0]?.sessions.map((session) => session.threadId)).toEqual([
      "thread-1",
      "thread-2",
    ]);
    expect(state.pendingSessionActions.get('["gateway:local","thread-1"]')).toBe("archive");

    archiveResponse.reject(new Error("thread is still active"));
    await archiving;

    expect(state.hosts[0]?.sessions.map((session) => session.name)).toEqual([
      "Refreshed while pending",
      "Second",
    ]);
    expect(state.actionError).toBe("thread is still active");
    expect(state.pendingSessionActions.size).toBe(0);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("shows a thread again after a fresh catalog reports it unarchived", async () => {
    const host = {};
    hosts.push(host);
    const state = getCodexSessionsState(host);
    state.hosts = gatewayPayload([{ threadId: "thread-1", name: "Before archive" }]).hosts;
    const request = vi.fn((method: string) => {
      if (method === "codex.sessions.archive") {
        return Promise.resolve({ archived: true });
      }
      if (method === "codex.sessions.list") {
        return Promise.resolve(
          gatewayPayload([{ threadId: "thread-1", name: "Unarchived elsewhere" }]),
        );
      }
      return Promise.reject(new Error(`Unexpected method: ${method}`));
    });
    const client = clientWithRequest(request);

    await archiveCodexSession(state, client, "gateway:local", "thread-1", true);
    expect(state.hosts[0]?.sessions).toEqual([]);

    await loadCodexSessions(state, client);

    expect(state.hosts[0]?.sessions[0]?.threadId).toBe("thread-1");
  });

  it("restores an optimistically archived row when the Gateway rejects it", async () => {
    const host = {};
    hosts.push(host);
    const state = getCodexSessionsState(host);
    state.hosts = gatewayPayload([
      { threadId: "thread-1", name: "First" },
      { threadId: "thread-2", name: "Second" },
    ]).hosts;
    const response = deferred<{ archived: boolean }>();

    const archiving = archiveCodexSession(
      state,
      clientWithRequest(() => response.promise),
      "gateway:local",
      "thread-1",
      true,
    );
    expect(state.hosts[0]?.sessions.map((session) => session.threadId)).toEqual([
      "thread-1",
      "thread-2",
    ]);

    response.reject(new Error("thread is still active"));
    await archiving;

    expect(state.hosts[0]?.sessions.map((session) => session.threadId)).toEqual([
      "thread-1",
      "thread-2",
    ]);
    expect(state.actionError).toBe("thread is still active");
    expect(state.pendingSessionActions.size).toBe(0);
  });

  it("does not restore a failed archive into a newer catalog result", async () => {
    const host = {};
    hosts.push(host);
    const state = getCodexSessionsState(host);
    state.hosts = gatewayPayload([{ threadId: "thread-old", name: "Old result" }]).hosts;
    const archiveResponse = deferred<{ archived: boolean }>();
    const archiveRequest = vi.fn(() => archiveResponse.promise);
    const archiving = archiveCodexSession(
      state,
      clientWithRequest(archiveRequest),
      "gateway:local",
      "thread-old",
      true,
    );
    expect(state.hosts[0]?.sessions[0]?.threadId).toBe("thread-old");

    await loadCodexSessions(
      state,
      clientWithRequest(async () =>
        gatewayPayload([{ threadId: "thread-new", name: "New result" }]),
      ),
    );
    archiveResponse.reject(new Error("thread is still active"));
    await archiving;

    expect(state.hosts[0]?.sessions.map((session) => session.threadId)).toEqual(["thread-new"]);
    expect(state.actionError).toBe("thread is still active");
    expect(state.pendingSessionActions.size).toBe(0);
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
    expect(request).toHaveBeenLastCalledWith("codex.sessions.list", {
      search: "release",
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

    expect(request).toHaveBeenCalledWith("codex.sessions.list", {
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

  it("does not resurrect a confirmed archive from an older host page", async () => {
    const host = {};
    hosts.push(host);
    const state = getCodexSessionsState(host);
    state.hosts = gatewayPayload(
      [
        { threadId: "thread-1", name: "Archived" },
        { threadId: "thread-2", name: "Survivor" },
      ],
      "cursor-2",
    ).hosts;
    const pageResponse = deferred<CodexSessionsPayload>();
    const request = vi.fn((method: string) => {
      if (method === "codex.sessions.list") {
        return pageResponse.promise;
      }
      if (method === "codex.sessions.archive") {
        return Promise.resolve({ archived: true });
      }
      return Promise.reject(new Error(`Unexpected method: ${method}`));
    });
    const client = clientWithRequest(request);

    const loadingMore = loadMoreCodexSessions(state, client, "gateway:local");
    await archiveCodexSession(state, client, "gateway:local", "thread-1", true);
    pageResponse.resolve(
      gatewayPayload([
        { threadId: "thread-1", name: "Stale archived row" },
        { threadId: "thread-3", name: "Next page" },
      ]),
    );
    await loadingMore;

    expect(state.hosts[0]?.sessions.map((session) => session.threadId)).toEqual([
      "thread-2",
      "thread-3",
    ]);
    expect(state.pendingSessionActions.size).toBe(0);
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
    expect(secondRequest).toHaveBeenCalledWith("codex.sessions.list", {
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
