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
  creating: boolean;
  createOpen: boolean;
  createRepoRoot: string;
  createName: string;
  createBaseRef: string;
  createBranches: string[];
  cleanupLoaded: boolean;
  cleanupMaxCount: number;
  cleanupMaxSizeGb: number;
  updateComplete: Promise<boolean>;
  requestUpdate: () => void;
  load: (options?: { preserveError?: boolean }) => Promise<void>;
  loadCreateBranches: () => void;
  createWorktree: () => Promise<void>;
  removeWorktree: (record: WorktreeRecord) => Promise<void>;
  restore: (record: WorktreeRecord) => Promise<void>;
  setCleanupLimit: (key: "maxCount" | "maxTotalSizeGb", value: number) => void;
  commitCleanupLimits: () => Promise<void>;
  gc: () => Promise<void>;
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

function runtimeConfigStub(cleanup?: { maxCount?: number; maxTotalSizeGb?: number }) {
  const state = {
    configSnapshot: { sourceConfig: cleanup ? { worktrees: { cleanup } } : {} },
    lastError: null as string | null,
  };
  const listeners = new Set<(next: typeof state) => void>();
  return {
    state,
    ensureLoaded: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    patch: vi.fn(async () => true),
    subscribe: (listener: (next: typeof state) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit() {
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
}

function contextWithConfig(
  gateway: ApplicationContext["gateway"],
  runtimeConfig: ReturnType<typeof runtimeConfigStub>,
): ApplicationContext {
  return {
    basePath: "",
    gateway,
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
    runtimeConfig,
  } as unknown as ApplicationContext;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("WorktreesPage lifecycle", () => {
  it("serializes list refreshes and row mutations", async () => {
    const record = worktree();
    const removedRecord = {
      ...record,
      removedAt: 2,
      snapshotRef: "refs/openclaw/worktree-snapshots/test",
    };
    const pendingList = deferred<{ worktrees: WorktreeRecord[] }>();
    let listRequests = 0;
    const request = vi.fn((method: string) => {
      if (method === "worktrees.list") {
        listRequests += 1;
        if (listRequests === 1) {
          return Promise.resolve({ worktrees: [record] });
        }
        return listRequests === 2
          ? pendingList.promise
          : Promise.resolve({ worktrees: [removedRecord] });
      }
      return Promise.resolve({ removed: true });
    });
    const page = document.createElement("openclaw-worktrees-page") as WorktreesPageTestElement;
    page.context = contextWithGateway(
      gatewayWithClient({ request } as unknown as GatewayBrowserClient),
    );
    document.body.append(page);
    await vi.waitFor(() => expect(page.records).toEqual([record]));
    await vi.waitFor(() => expect(page.loading).toBe(false));

    const refreshing = page.load();
    await vi.waitFor(() => expect(listRequests).toBe(2));
    await page.updateComplete;

    const deleteButton = page.querySelector<HTMLButtonElement>("button.danger");
    expect(deleteButton?.disabled).toBe(true);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await page.removeWorktree(record);
    expect(confirm).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalledWith("worktrees.remove", { id: record.id });

    pendingList.resolve({ worktrees: [record] });
    await refreshing;

    await page.removeWorktree(record);
    expect(confirm).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("worktrees.remove", { id: record.id });
    expect(listRequests).toBe(3);
    expect(page.records).toEqual([removedRecord]);
  });

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

  it("offers force removal when the gateway reports a snapshot failure", async () => {
    const request = vi.fn((method: string, params?: Record<string, unknown>) => {
      if (method === "worktrees.remove") {
        return params?.force
          ? Promise.resolve({ removed: true })
          : Promise.resolve({ removed: false, snapshotError: "nested gitlink" });
      }
      return Promise.resolve({ worktrees: [] });
    });
    const page = document.createElement("openclaw-worktrees-page") as WorktreesPageTestElement;
    page.context = contextWithGateway(
      gatewayWithClient({ request } as unknown as GatewayBrowserClient),
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    document.body.append(page);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("worktrees.list", {}));

    await page.removeWorktree(worktree());

    expect(request).toHaveBeenCalledWith("worktrees.remove", { id: "worktree-1" });
    expect(request).toHaveBeenCalledWith("worktrees.remove", { id: "worktree-1", force: true });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(page.error).toBeNull();
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

  it("keeps a restore error after the reconciliation refresh succeeds", async () => {
    const record = worktree();
    let listRequests = 0;
    const request = vi.fn((method: string) => {
      if (method === "worktrees.list") {
        listRequests += 1;
        return Promise.resolve({ worktrees: [record] });
      }
      if (method === "worktrees.restore") {
        return Promise.reject(new Error("restore failed"));
      }
      return Promise.resolve({});
    });
    const page = document.createElement("openclaw-worktrees-page") as WorktreesPageTestElement;
    page.context = contextWithGateway(
      gatewayWithClient({ request } as unknown as GatewayBrowserClient),
    );
    document.body.append(page);
    await vi.waitFor(() => expect(listRequests).toBe(1));
    await vi.waitFor(() => expect(page.loading).toBe(false));

    await page.restore(record);

    expect(listRequests).toBe(2);
    expect(page.error).toBe("Error: restore failed");
    expect(page.busyId).toBeNull();
  });

  it("replaces a mutation error when the reconciliation refresh also fails", async () => {
    const record = worktree();
    let listRequests = 0;
    const request = vi.fn((method: string) => {
      if (method === "worktrees.list") {
        listRequests += 1;
        return listRequests === 1
          ? Promise.resolve({ worktrees: [record] })
          : Promise.reject(new Error("list failed"));
      }
      if (method === "worktrees.restore") {
        return Promise.reject(new Error("restore failed"));
      }
      return Promise.resolve({});
    });
    const page = document.createElement("openclaw-worktrees-page") as WorktreesPageTestElement;
    page.context = contextWithGateway(
      gatewayWithClient({ request } as unknown as GatewayBrowserClient),
    );
    document.body.append(page);
    await vi.waitFor(() => expect(listRequests).toBe(1));
    await vi.waitFor(() => expect(page.loading).toBe(false));

    await page.restore(record);

    expect(listRequests).toBe(2);
    expect(page.error).toBe("Error: list failed");
    expect(page.busyId).toBeNull();
  });

  it("clears pending create state across a same-client reconnect", async () => {
    const pendingCreate = deferred<unknown>();
    const request = vi.fn((method: string) => {
      if (method === "worktrees.create") {
        return pendingCreate.promise;
      }
      return Promise.resolve({ worktrees: [] });
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const source = mutableGateway(client);
    const page = document.createElement("openclaw-worktrees-page") as WorktreesPageTestElement;
    page.context = contextWithGateway(source.gateway);
    page.createRepoRoot = "/tmp/repo";
    document.body.append(page);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("worktrees.list", {}));

    const creating = page.createWorktree();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("worktrees.create", { repoRoot: "/tmp/repo" }),
    );
    expect(page.creating).toBe(true);

    source.emit(false);
    source.emit(true);
    expect(page.creating).toBe(false);

    pendingCreate.reject(new Error("gateway closed"));
    await creating;
    expect(page.creating).toBe(false);
    expect(page.error).toBeNull();
  });

  it("locks the create draft and its toggle until create settles", async () => {
    const pendingCreate = deferred<unknown>();
    const request = vi.fn((method: string) => {
      if (method === "worktrees.create") {
        return pendingCreate.promise;
      }
      return Promise.resolve({ worktrees: [] });
    });
    const page = document.createElement("openclaw-worktrees-page") as WorktreesPageTestElement;
    page.context = contextWithGateway(
      gatewayWithClient({ request } as unknown as GatewayBrowserClient),
    );
    page.createOpen = true;
    page.createRepoRoot = "/tmp/repo";
    page.createName = "submitted-name";
    page.createBaseRef = "main";
    document.body.append(page);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("worktrees.list", {}));
    await vi.waitFor(() => expect(page.loading).toBe(false));

    const toggleButton = Array.from(page.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "New worktree",
    );
    const creating = page.createWorktree();
    toggleButton?.click();
    expect(page.createOpen).toBe(true);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("worktrees.create", {
        baseRef: "main",
        name: "submitted-name",
        repoRoot: "/tmp/repo",
      }),
    );
    await page.updateComplete;

    // type="text" scopes to the create-draft inputs; the cleanup section's
    // number inputs have their own disabled lifecycle.
    const draftInputs = Array.from(
      page.querySelectorAll<HTMLInputElement>('input.settings-input[type="text"]'),
    );
    const createButton = page.querySelector<HTMLButtonElement>(
      ".settings-group .settings-row button.btn--sm",
    );
    expect(draftInputs).toHaveLength(3);
    expect(draftInputs.every((input) => input.disabled)).toBe(true);
    expect(createButton?.disabled).toBe(true);
    expect(toggleButton?.disabled).toBe(true);

    toggleButton?.click();
    expect(page.createOpen).toBe(true);

    pendingCreate.resolve({});
    await creating;
    await page.updateComplete;
    expect(page.createOpen).toBe(false);
    expect(toggleButton?.disabled).toBe(false);

    toggleButton?.click();
    await page.updateComplete;
    const freshInputs = Array.from(
      page.querySelectorAll<HTMLInputElement>('input.settings-input[type="text"]'),
    );
    expect(freshInputs).toHaveLength(3);
    expect(freshInputs.every((input) => !input.disabled)).toBe(true);
  });

  it("renders cleanup limits from config and disables controls until config loads", async () => {
    const request = vi.fn(async () => ({ worktrees: [] }));
    const withConfig = document.createElement(
      "openclaw-worktrees-page",
    ) as WorktreesPageTestElement;
    withConfig.context = contextWithConfig(
      gatewayWithClient({ request } as unknown as GatewayBrowserClient),
      runtimeConfigStub({ maxCount: 25, maxTotalSizeGb: 50 }),
    );
    document.body.append(withConfig);
    await vi.waitFor(() => expect(withConfig.cleanupLoaded).toBe(true));
    await withConfig.updateComplete;

    expect(withConfig.cleanupMaxCount).toBe(25);
    expect(withConfig.cleanupMaxSizeGb).toBe(50);
    const inputs = Array.from(
      withConfig.querySelectorAll<HTMLInputElement>('input.settings-input[type="number"]'),
    );
    expect(inputs.map((input) => input.value)).toEqual(["25", "50"]);
    expect(inputs.every((input) => !input.disabled)).toBe(true);

    // Without a runtimeConfig capability the section stays visible but inert.
    const withoutConfig = document.createElement(
      "openclaw-worktrees-page",
    ) as WorktreesPageTestElement;
    withoutConfig.context = contextWithGateway(
      gatewayWithClient({ request } as unknown as GatewayBrowserClient),
    );
    document.body.append(withoutConfig);
    await withoutConfig.updateComplete;
    const inertInputs = Array.from(
      withoutConfig.querySelectorAll<HTMLInputElement>('input.settings-input[type="number"]'),
    );
    expect(inertInputs).toHaveLength(2);
    expect(inertInputs.every((input) => input.disabled)).toBe(true);
  });

  it("debounces stepper edits into one minimal config patch", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn(async () => ({ worktrees: [] }));
      const runtimeConfig = runtimeConfigStub({ maxCount: 25, maxTotalSizeGb: 50 });
      const page = document.createElement("openclaw-worktrees-page") as WorktreesPageTestElement;
      page.context = contextWithConfig(
        gatewayWithClient({ request } as unknown as GatewayBrowserClient),
        runtimeConfig,
      );
      document.body.append(page);
      await page.updateComplete;
      expect(page.cleanupLoaded).toBe(true);

      page.setCleanupLimit("maxCount", 26);
      page.setCleanupLimit("maxCount", 27);
      page.setCleanupLimit("maxTotalSizeGb", 49);
      expect(page.cleanupMaxCount).toBe(27);
      expect(page.cleanupMaxSizeGb).toBe(49);
      expect(runtimeConfig.patch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_100);

      expect(runtimeConfig.patch).toHaveBeenCalledOnce();
      expect(runtimeConfig.patch).toHaveBeenCalledWith({
        raw: { worktrees: { cleanup: { maxCount: 27, maxTotalSizeGb: 49 } } },
        note: "worktrees: update cleanup limits",
      });
      expect(runtimeConfig.refresh).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes pending cleanup edits before Clean up now", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const request = vi.fn(async (method: string) => {
        calls.push(method);
        return { worktrees: [] };
      });
      const runtimeConfig = runtimeConfigStub({ maxCount: 25 });
      runtimeConfig.patch = vi.fn(async () => {
        calls.push("config.patch");
        return true;
      });
      const page = document.createElement("openclaw-worktrees-page") as WorktreesPageTestElement;
      page.context = contextWithConfig(
        gatewayWithClient({ request } as unknown as GatewayBrowserClient),
        runtimeConfig,
      );
      document.body.append(page);
      await vi.advanceTimersByTimeAsync(0);
      expect(page.loading).toBe(false);

      page.setCleanupLimit("maxCount", 24);
      await page.gc();

      expect(
        calls.filter((method) => method === "config.patch" || method === "worktrees.gc"),
      ).toEqual(["config.patch", "worktrees.gc"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts Clean up now when the pending limit commit fails", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn(async () => ({ worktrees: [] }));
      const runtimeConfig = runtimeConfigStub({ maxCount: 25 });
      runtimeConfig.patch = vi.fn(async () => false);
      runtimeConfig.state.lastError = "save rejected";
      const page = document.createElement("openclaw-worktrees-page") as WorktreesPageTestElement;
      page.context = contextWithConfig(
        gatewayWithClient({ request } as unknown as GatewayBrowserClient),
        runtimeConfig,
      );
      document.body.append(page);
      await vi.advanceTimersByTimeAsync(0);

      page.setCleanupLimit("maxCount", 30);
      // The debounced save fails first; the draft must stay dirty so a later
      // Clean up now retries the save instead of running with stale limits.
      await vi.advanceTimersByTimeAsync(2_100);
      expect(runtimeConfig.patch).toHaveBeenCalledTimes(1);

      await page.gc();

      expect(runtimeConfig.patch).toHaveBeenCalledTimes(2);
      expect(request).not.toHaveBeenCalledWith("worktrees.gc", {});
      expect(page.error).toBe("save rejected");
      expect(page.loading).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a pending edit when the runtime-config source is replaced", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn(async () => ({ worktrees: [] }));
      const originalConfig = runtimeConfigStub({ maxCount: 25 });
      const page = document.createElement("openclaw-worktrees-page") as WorktreesPageTestElement;
      page.context = contextWithConfig(
        gatewayWithClient({ request } as unknown as GatewayBrowserClient),
        originalConfig,
      );
      document.body.append(page);
      await vi.advanceTimersByTimeAsync(0);

      page.setCleanupLimit("maxCount", 30);
      const replacementConfig = runtimeConfigStub({ maxCount: 25 });
      page.context = contextWithConfig(
        gatewayWithClient({ request } as unknown as GatewayBrowserClient),
        replacementConfig,
      );
      page.requestUpdate();
      await vi.advanceTimersByTimeAsync(2_100);

      expect(originalConfig.patch).not.toHaveBeenCalled();
      expect(replacementConfig.patch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps cleanup edits to non-negative integers and surfaces patch failures", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn(async () => ({ worktrees: [] }));
      const runtimeConfig = runtimeConfigStub({ maxCount: 1 });
      runtimeConfig.patch = vi.fn(async () => false);
      runtimeConfig.state.lastError = "config hash mismatch";
      const page = document.createElement("openclaw-worktrees-page") as WorktreesPageTestElement;
      page.context = contextWithConfig(
        gatewayWithClient({ request } as unknown as GatewayBrowserClient),
        runtimeConfig,
      );
      document.body.append(page);
      await page.updateComplete;

      page.setCleanupLimit("maxTotalSizeGb", 0.5);
      expect(page.cleanupMaxSizeGb).toBe(0.5);
      page.setCleanupLimit("maxCount", 5.7);
      expect(page.cleanupMaxCount).toBe(5);
      page.setCleanupLimit("maxCount", -5);
      expect(page.cleanupMaxCount).toBe(0);

      await vi.advanceTimersByTimeAsync(2_100);
      expect(runtimeConfig.patch).toHaveBeenCalledWith({
        raw: { worktrees: { cleanup: { maxCount: 0, maxTotalSizeGb: 0.5 } } },
        note: "worktrees: update cleanup limits",
      });
      expect(page.error).toBe("config hash mismatch");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the current branch when a repository has no remote default", async () => {
    const request = vi.fn((method: string) => {
      if (method === "worktrees.branches") {
        return Promise.resolve({ branches: [{ name: "main" }], headBranch: "main" });
      }
      return Promise.resolve({ worktrees: [] });
    });
    const page = document.createElement("openclaw-worktrees-page") as WorktreesPageTestElement;
    page.context = contextWithGateway(
      gatewayWithClient({ request } as unknown as GatewayBrowserClient),
    );
    page.createRepoRoot = "/tmp/repo";
    document.body.append(page);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("worktrees.list", {}));

    page.loadCreateBranches();

    await vi.waitFor(() => expect(page.createBranches).toEqual(["main"]));
    expect(page.createBaseRef).toBe("main");
  });

  it("ignores a stale branch failure after a newer request succeeds", async () => {
    const firstBranches = deferred<unknown>();
    let branchRequests = 0;
    const request = vi.fn((method: string) => {
      if (method === "worktrees.branches") {
        branchRequests += 1;
        return branchRequests === 1
          ? firstBranches.promise
          : Promise.resolve({ branches: [{ name: "main" }], headBranch: "main" });
      }
      return Promise.resolve({ worktrees: [] });
    });
    const page = document.createElement("openclaw-worktrees-page") as WorktreesPageTestElement;
    page.context = contextWithGateway(
      gatewayWithClient({ request } as unknown as GatewayBrowserClient),
    );
    page.createRepoRoot = "/tmp/repo";
    document.body.append(page);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("worktrees.list", {}));

    page.loadCreateBranches();
    page.loadCreateBranches();
    await vi.waitFor(() => expect(page.createBranches).toEqual(["main"]));
    expect(page.createBaseRef).toBe("main");

    firstBranches.reject(new Error("stale branch failure"));
    await Promise.resolve();
    await Promise.resolve();

    expect(page.createBranches).toEqual(["main"]);
    expect(page.createBaseRef).toBe("main");
  });
});
