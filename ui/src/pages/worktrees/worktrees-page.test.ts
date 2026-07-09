import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorktreeRecord } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import "./worktrees-page.ts";

type WorktreesPageTestElement = HTMLElement & {
  context: ApplicationContext;
  loading: boolean;
  records: WorktreeRecord[];
  error: string | null;
  busyId: string | null;
  updateComplete: Promise<boolean>;
  requestUpdate: () => void;
  removeWorktree: (record: WorktreeRecord) => Promise<void>;
  restore: (record: WorktreeRecord) => Promise<void>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function worktree(id = "worktree-1"): WorktreeRecord {
  return {
    id,
    name: id,
    repoFingerprint: "0123456789abcdef",
    repoRoot: "/tmp/repo",
    path: `/tmp/repo/.worktrees/${id}`,
    branch: "main",
    baseRef: "main",
    ownerKind: "manual",
    createdAt: 1,
    lastActiveAt: 1,
  };
}

function gatewayWithSnapshot(client: GatewayBrowserClient | null, connected: boolean) {
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    connected,
    reconnecting: false,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  return {
    snapshot,
    subscribe: () => () => undefined,
  } as unknown as ApplicationContext["gateway"];
}

function gatewayWithClient(client: GatewayBrowserClient) {
  return gatewayWithSnapshot(client, true);
}

function mutableGateway(client: GatewayBrowserClient) {
  const snapshot = gatewayWithClient(client).snapshot;
  let listener: ((snapshot: ApplicationGatewaySnapshot) => void) | undefined;
  const gateway = {
    snapshot,
    subscribe(next: (snapshot: ApplicationGatewaySnapshot) => void) {
      listener = next;
      return () => {
        if (listener === next) {
          listener = undefined;
        }
      };
    },
  } as unknown as ApplicationContext["gateway"];
  return {
    emit(connected: boolean) {
      (snapshot as ApplicationGatewaySnapshot).connected = connected;
      listener?.(snapshot as ApplicationGatewaySnapshot);
    },
    gateway,
  };
}

function contextWithGateway(gateway: ApplicationContext["gateway"]): ApplicationContext {
  return {
    basePath: "",
    gateway,
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as ApplicationContext;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("WorktreesPage lifecycle", () => {
  it("clears stale records when a null-client gateway source is replaced", async () => {
    const page = document.createElement("openclaw-worktrees-page") as WorktreesPageTestElement;
    page.records = [
      {
        id: "stale",
        name: "stale",
        repoFingerprint: "0123456789abcdef",
        repoRoot: "/tmp/repo",
        path: "/tmp/repo/.worktrees/stale",
        branch: "main",
        baseRef: "main",
        ownerKind: "manual",
        createdAt: 1,
        lastActiveAt: 1,
      },
    ];
    page.context = contextWithGateway(gatewayWithSnapshot(null, false));
    document.body.append(page);
    await page.updateComplete;
    expect(page.records).toHaveLength(1);

    page.context = contextWithGateway(gatewayWithSnapshot(null, false));
    page.requestUpdate();
    await page.updateComplete;

    expect(page.records).toEqual([]);
  });

  it("starts a replacement-client load after disconnecting during an in-flight load", async () => {
    let resolveFirst!: (value: { worktrees: [] }) => void;
    const firstRequest = vi.fn(
      () =>
        new Promise<{ worktrees: [] }>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const secondRequest = vi.fn(async () => ({ worktrees: [] }));
    const page = document.createElement("openclaw-worktrees-page") as WorktreesPageTestElement;
    page.context = contextWithGateway(
      gatewayWithClient({ request: firstRequest } as unknown as GatewayBrowserClient),
    );

    document.body.append(page);
    await vi.waitFor(() => expect(firstRequest).toHaveBeenCalledOnce());
    expect(page.loading).toBe(true);

    page.remove();
    page.context = contextWithGateway(
      gatewayWithClient({ request: secondRequest } as unknown as GatewayBrowserClient),
    );
    document.body.append(page);

    await vi.waitFor(() => expect(secondRequest).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(page.loading).toBe(false));

    resolveFirst({ worktrees: [] });
    await Promise.resolve();
    expect(page.loading).toBe(false);
  });

  it("never force-removes through a replacement gateway", async () => {
    const pendingRemove = deferred<unknown>();
    const firstRequest = vi.fn((method: string) => {
      if (method === "worktrees.remove") {
        return pendingRemove.promise;
      }
      return Promise.resolve({ worktrees: [] });
    });
    const secondRequest = vi.fn(async () => ({ worktrees: [] }));
    const page = document.createElement("openclaw-worktrees-page") as WorktreesPageTestElement;
    page.context = contextWithGateway(
      gatewayWithClient({ request: firstRequest } as unknown as GatewayBrowserClient),
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    document.body.append(page);
    await vi.waitFor(() => expect(firstRequest).toHaveBeenCalledWith("worktrees.list", {}));

    const removing = page.removeWorktree(worktree());
    await vi.waitFor(() =>
      expect(firstRequest).toHaveBeenCalledWith("worktrees.remove", { id: "worktree-1" }),
    );

    page.context = contextWithGateway(
      gatewayWithClient({ request: secondRequest } as unknown as GatewayBrowserClient),
    );
    page.requestUpdate();
    await page.updateComplete;
    pendingRemove.reject(new Error("snapshot failed: stale gateway"));
    await removing;

    expect(confirm).toHaveBeenCalledOnce();
    expect(secondRequest).not.toHaveBeenCalledWith("worktrees.remove", {
      id: "worktree-1",
      force: true,
    });
    expect(page.error).toBeNull();
    expect(page.busyId).toBeNull();
  });

  it("discards a restore error across a same-client reconnect", async () => {
    const pendingRestore = deferred<unknown>();
    const request = vi.fn((method: string) => {
      if (method === "worktrees.restore") {
        return pendingRestore.promise;
      }
      return Promise.resolve({ worktrees: [] });
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const source = mutableGateway(client);
    const page = document.createElement("openclaw-worktrees-page") as WorktreesPageTestElement;
    page.context = contextWithGateway(source.gateway);
    document.body.append(page);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("worktrees.list", {}));

    const restoring = page.restore(worktree());
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("worktrees.restore", { id: "worktree-1" }),
    );
    source.emit(false);
    source.emit(true);
    pendingRestore.reject(new Error("stale restore error"));
    await restoring;

    expect(page.error).toBeNull();
    expect(page.busyId).toBeNull();
  });
});
