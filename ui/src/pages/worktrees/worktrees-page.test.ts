import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorktreeRecord } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { SESSION_FACE_PREFERENCE_PARAM } from "../../lib/sessions/route-navigation.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import "./worktrees-page.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));

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
  updateComplete: Promise<boolean>;
  requestUpdate: () => void;
  load: (options?: { preserveError?: boolean }) => Promise<void>;
  loadCreateBranches: () => void;
  createWorktree: () => Promise<void>;
  removeWorktree: (record: WorktreeRecord) => Promise<void>;
  restore: (record: WorktreeRecord) => Promise<void>;
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
    phase: connected ? "connected" : "stopped",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
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
      (snapshot as ApplicationGatewaySnapshot).phase = connected ? "connected" : "stopped";
      listener?.(snapshot as ApplicationGatewaySnapshot);
    },
    setScopes(scopes: string[]) {
      snapshot.hello = {
        type: "hello-ok",
        protocol: 1,
        auth: { role: "operator", scopes },
        features: { methods: ["worktrees.list", "worktrees.create"] },
      } as ApplicationGatewaySnapshot["hello"];
      listener?.(snapshot);
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
  vi.mocked(showConfirmDialog).mockReset();
  vi.restoreAllMocks();
});

describe("WorktreesPage lifecycle", () => {
  it("keeps read-only viewers in browsing mode without branch or mutation RPCs", async () => {
    const record = worktree();
    const request = vi.fn(async (method: string) =>
      method === "worktrees.list" ? { worktrees: [record] } : {},
    );
    const gateway = gatewayWithClient({ request } as unknown as GatewayBrowserClient);
    gateway.snapshot.hello = {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.read"] },
      features: {
        methods: ["worktrees.list", "worktrees.branches", "worktrees.remove", "worktrees.gc"],
      },
    } as ApplicationGatewaySnapshot["hello"];
    const page = document.createElement("openclaw-worktrees-page") as WorktreesPageTestElement;
    page.context = contextWithGateway(gateway);
    page.createRepoRoot = "/tmp/repo";
    document.body.append(page);

    await waitForFast(() => expect(page.records).toEqual([record]));
    await page.updateComplete;
    expect(page.querySelector(".callout.info")?.textContent).toContain(
      "Worktree changes require operator.admin access.",
    );
    const mutationButtons = [...page.querySelectorAll<HTMLButtonElement>("button")].filter(
      (button) =>
        ["New worktree", "Clean up now", "Delete"].includes(button.textContent?.trim() ?? ""),
    );
    expect(mutationButtons).toHaveLength(3);
    expect(mutationButtons.every((button) => button.disabled)).toBe(true);

    page.loadCreateBranches();
    await page.removeWorktree(record);
    expect(request.mock.calls.map(([method]) => method)).not.toContain("worktrees.branches");
    expect(request.mock.calls.map(([method]) => method)).not.toContain("worktrees.remove");
    expect(showConfirmDialog).not.toHaveBeenCalled();
  });

  it("closes an open create draft when admin access is lost", async () => {
    const request = vi.fn(async (method: string) =>
      method === "worktrees.list" ? { worktrees: [] } : {},
    );
    const source = mutableGateway({ request } as unknown as GatewayBrowserClient);
    const page = document.createElement("openclaw-worktrees-page") as WorktreesPageTestElement;
    page.context = contextWithGateway(source.gateway);
    page.createRepoRoot = "/tmp/repo";
    document.body.append(page);

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(
        "worktrees.list",
        {},
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await waitForFast(() => expect(page.loading).toBe(false));
    const newWorktreeButton = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "New worktree",
    );
    newWorktreeButton?.click();
    await page.updateComplete;
    expect(page.querySelectorAll('input.settings-input[type="text"]')).toHaveLength(3);

    source.setScopes(["operator.read"]);
    await page.updateComplete;

    expect(page.createOpen).toBe(false);
    expect(page.querySelectorAll('input.settings-input[type="text"]')).toHaveLength(0);
    expect(newWorktreeButton?.disabled).toBe(true);
    newWorktreeButton?.click();
    expect(request.mock.calls.map(([method]) => method)).not.toContain("worktrees.create");
  });

  it("navigates a session-owned worktree with the face-preference marker", async () => {
    // The owner key comes from a worktree record, not the cached session page, so its
    // face is a guess: the in-app click must carry the marker while href stays clean.
    const request = vi.fn(async (method: string) =>
      method === "worktrees.list"
        ? {
            worktrees: [
              {
                ...worktree(),
                ownerKind: "session" as const,
                ownerId: "agent:main:thread:12345678-90ab-cdef-1234-567890abcdef",
              },
            ],
          }
        : {},
    );
    const context = {
      ...contextWithGateway(gatewayWithClient({ request } as unknown as GatewayBrowserClient)),
      // No cached sessions: the owner key is only known to the worktree record.
      sessions: { state: { result: undefined } },
      agents: { state: { agentsList: { mainKey: "main" } } },
      agentSelection: { state: { selectedId: "main" } },
    } as unknown as ApplicationContext;
    const page = document.createElement("openclaw-worktrees-page") as WorktreesPageTestElement;
    page.context = context;
    document.body.append(page);
    await waitForFast(() => expect(page.records.length).toBe(1));
    await page.updateComplete;

    const docsLink = page.querySelector<HTMLAnchorElement>(".page-subtitle a");
    expect(docsLink?.textContent?.trim()).toBe("Learn more");
    expect(docsLink?.href).toBe("https://docs.openclaw.ai/concepts/managed-worktrees");

    const link = [...page.querySelectorAll("a")].find((anchor) =>
      anchor.getAttribute("href")?.includes("12345678"),
    );
    expect(link?.getAttribute("href")).toBe("/chat/main/12345678");
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(context.navigate).toHaveBeenCalledWith("chat", {
      pathname: "/chat/main/12345678",
      search: `?${SESSION_FACE_PREFERENCE_PARAM}=1`,
    });
  });

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
    await waitForFast(() => expect(page.records).toEqual([record]));
    await waitForFast(() => expect(page.loading).toBe(false));

    const refreshing = page.load();
    await waitForFast(() => expect(listRequests).toBe(2));
    await page.updateComplete;

    const deleteButton = page.querySelector<HTMLButtonElement>("button.danger");
    expect(deleteButton?.disabled).toBe(true);
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    await page.removeWorktree(record);
    expect(showConfirmDialog).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalledWith("worktrees.remove", { id: record.id });

    pendingList.resolve({ worktrees: [record] });
    await refreshing;

    await page.removeWorktree(record);
    expect(showConfirmDialog).toHaveBeenCalledOnce();
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
    await waitForFast(() => expect(firstRequest).toHaveBeenCalledOnce());
    expect(page.loading).toBe(true);

    page.remove();
    page.context = contextWithGateway(
      gatewayWithClient({ request: secondRequest } as unknown as GatewayBrowserClient),
    );
    document.body.append(page);

    await waitForFast(() => expect(secondRequest).toHaveBeenCalledOnce());
    await waitForFast(() => expect(page.loading).toBe(false));

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
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    document.body.append(page);
    await waitForFast(() =>
      expect(firstRequest).toHaveBeenCalledWith(
        "worktrees.list",
        {},
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );

    const removing = page.removeWorktree(worktree());
    await waitForFast(() =>
      expect(firstRequest).toHaveBeenCalledWith("worktrees.remove", { id: "worktree-1" }),
    );

    page.context = contextWithGateway(
      gatewayWithClient({ request: secondRequest } as unknown as GatewayBrowserClient),
    );
    page.requestUpdate();
    await page.updateComplete;
    pendingRemove.reject(new Error("snapshot failed: stale gateway"));
    await removing;

    expect(showConfirmDialog).toHaveBeenCalledOnce();
    expect(secondRequest).not.toHaveBeenCalledWith("worktrees.remove", {
      id: "worktree-1",
      force: true,
    });
    expect(page.error).toBeNull();
    expect(page.busyId).toBeNull();
  });

  it("does not remove through a replacement gateway after confirmation", async () => {
    const confirmation = deferred<boolean>();
    vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
    const firstRequest = vi.fn(async () => ({ worktrees: [] }));
    const secondRequest = vi.fn(async () => ({ worktrees: [] }));
    const page = document.createElement("openclaw-worktrees-page") as WorktreesPageTestElement;
    page.context = contextWithGateway(
      gatewayWithClient({ request: firstRequest } as unknown as GatewayBrowserClient),
    );
    document.body.append(page);
    await waitForFast(() => expect(firstRequest).toHaveBeenCalledOnce());

    const removing = page.removeWorktree(worktree());
    await waitForFast(() => expect(showConfirmDialog).toHaveBeenCalledOnce());
    page.context = contextWithGateway(
      gatewayWithClient({ request: secondRequest } as unknown as GatewayBrowserClient),
    );
    page.requestUpdate();
    await page.updateComplete;
    confirmation.resolve(true);
    await removing;

    expect(firstRequest).not.toHaveBeenCalledWith("worktrees.remove", { id: "worktree-1" });
    expect(secondRequest).not.toHaveBeenCalledWith("worktrees.remove", { id: "worktree-1" });
  });

  it("surfaces the snapshot failure after a forced removal", async () => {
    const request = vi.fn((method: string, params?: Record<string, unknown>) => {
      if (method === "worktrees.remove") {
        return params?.force
          ? Promise.resolve({ removed: true, snapshotError: "nested gitlink" })
          : Promise.resolve({ removed: false, snapshotError: "nested gitlink" });
      }
      return Promise.resolve({ worktrees: [] });
    });
    const page = document.createElement("openclaw-worktrees-page") as WorktreesPageTestElement;
    page.context = contextWithGateway(
      gatewayWithClient({ request } as unknown as GatewayBrowserClient),
    );
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    document.body.append(page);
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(
        "worktrees.list",
        {},
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );

    await page.removeWorktree(worktree());

    expect(request).toHaveBeenCalledWith("worktrees.remove", { id: "worktree-1" });
    expect(request).toHaveBeenCalledWith("worktrees.remove", { id: "worktree-1", force: true });
    expect(showConfirmDialog).toHaveBeenCalledTimes(2);
    expect(page.error).toBe("nested gitlink");
    await page.updateComplete;
    expect(page.querySelector(".callout.danger")?.textContent).toContain("nested gitlink");
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
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(
        "worktrees.list",
        {},
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );

    const restoring = page.restore(worktree());
    await waitForFast(() =>
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
        return Promise.reject(new Error("restore failed: OPENAI_API_KEY=sk-1234567890abcdef"));
      }
      return Promise.resolve({});
    });
    const page = document.createElement("openclaw-worktrees-page") as WorktreesPageTestElement;
    page.context = contextWithGateway(
      gatewayWithClient({ request } as unknown as GatewayBrowserClient),
    );
    document.body.append(page);
    await waitForFast(() => expect(listRequests).toBe(1));
    await waitForFast(() => expect(page.loading).toBe(false));

    await page.restore(record);

    expect(listRequests).toBe(2);
    expect(page.error).toBe("restore failed: OPENAI_API_KEY=sk-123...cdef");
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
    await waitForFast(() => expect(listRequests).toBe(1));
    await waitForFast(() => expect(page.loading).toBe(false));

    await page.restore(record);

    expect(listRequests).toBe(2);
    expect(page.error).toBe("list failed");
    expect(page.busyId).toBeNull();
  });

  it("surfaces an operation failure after an earlier list failure", async () => {
    let listRequests = 0;
    const request = vi.fn((method: string) => {
      if (method === "worktrees.list") {
        listRequests += 1;
        return listRequests === 1
          ? Promise.reject(new Error("stale list failure"))
          : Promise.resolve({ worktrees: [] });
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
    await waitForFast(() => expect(page.error).toBe("stale list failure"));

    await page.restore(worktree());

    expect(page.error).toBe("restore failed");
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
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(
        "worktrees.list",
        {},
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );

    const creating = page.createWorktree();
    await waitForFast(() =>
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

  it("clears GC loading across a same-client reconnect", async () => {
    const pendingGc = deferred<unknown>();
    let listRequests = 0;
    const request = vi.fn((method: string) => {
      if (method === "worktrees.gc") {
        return pendingGc.promise;
      }
      listRequests += 1;
      return Promise.resolve({ worktrees: [] });
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const source = mutableGateway(client);
    const page = document.createElement("openclaw-worktrees-page") as WorktreesPageTestElement;
    page.context = contextWithGateway(source.gateway);
    document.body.append(page);
    await waitForFast(() => expect(listRequests).toBe(1));

    const collecting = page.gc();
    await waitForFast(() => expect(request).toHaveBeenCalledWith("worktrees.gc", {}));
    expect(page.loading).toBe(true);
    source.emit(false);
    source.emit(true);

    await waitForFast(() => expect(listRequests).toBe(2));
    await waitForFast(() => expect(page.loading).toBe(false));
    pendingGc.resolve({});
    await collecting;
    expect(page.loading).toBe(false);
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
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(
        "worktrees.list",
        {},
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await waitForFast(() => expect(page.loading).toBe(false));

    const toggleButton = Array.from(page.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "New worktree",
    );
    const creating = page.createWorktree();
    toggleButton?.click();
    expect(page.createOpen).toBe(true);
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("worktrees.create", {
        baseRef: "main",
        name: "submitted-name",
        repoRoot: "/tmp/repo",
      }),
    );
    await page.updateComplete;

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
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(
        "worktrees.list",
        {},
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );

    page.loadCreateBranches();

    await waitForFast(() => expect(page.createBranches).toEqual(["main"]));
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
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(
        "worktrees.list",
        {},
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );

    page.loadCreateBranches();
    page.loadCreateBranches();
    await waitForFast(() => expect(page.createBranches).toEqual(["main"]));
    expect(page.createBaseRef).toBe("main");

    firstBranches.reject(new Error("stale branch failure"));
    await Promise.resolve();
    await Promise.resolve();

    expect(page.createBranches).toEqual(["main"]);
    expect(page.createBaseRef).toBe("main");
  });
});
