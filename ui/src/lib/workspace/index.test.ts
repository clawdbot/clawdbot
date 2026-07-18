import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  approveWidget,
  cancelWorkspaceLoadIntent,
  clearActiveDrag,
  getWorkspaceState,
  hideWidget,
  loadWorkspace,
  moveWidget,
  moveWidgetToTab,
  registerActiveDrag,
  removeWidgetFromTab,
  resolveBinding,
  setActiveWorkspaceSlug,
  updateWidgetTitle,
  startBindingPolling,
  stopWorkspace,
  subscribeToWorkspaceEvents,
} from "./index.ts";
import type { WorkspaceDocument } from "./types.ts";

type MockClient = Pick<GatewayBrowserClient, "request" | "addEventListener">;

function mockClient(overrides: Partial<MockClient> = {}): GatewayBrowserClient {
  return {
    request: vi.fn(async () => ({})),
    addEventListener: vi.fn(() => () => {}),
    ...overrides,
  } as unknown as GatewayBrowserClient;
}

const sampleDoc = {
  schemaVersion: 1,
  workspaceVersion: 3,
  tabs: [
    {
      slug: "main",
      title: "Main",
      hidden: false,
      widgets: [
        {
          id: "w1",
          kind: "builtin:stat-card",
          title: "Revenue",
          grid: { x: 0, y: 0, w: 4, h: 2 },
          collapsed: false,
          createdBy: "agent:finance",
        },
      ],
    },
    { slug: "archive", title: "Archive", hidden: true, widgets: [] },
  ],
  prefs: { tabOrder: ["archive", "main"] },
};

function sampleWorkspace(overrides: Partial<WorkspaceDocument> = {}): WorkspaceDocument {
  return {
    ...structuredClone(sampleDoc),
    widgetsRegistry: {},
    ...overrides,
  };
}

describe("approveWidget", () => {
  it("suppresses duplicate decisions while the first request is pending", async () => {
    const state = getWorkspaceState({});
    state.workspace = sampleWorkspace({
      widgetsRegistry: { "sales-map": { status: "pending" } },
    });
    let resolveRequest!: () => void;
    const request = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const client = mockClient({ request: request as never });

    const first = approveWidget(state, client, { name: "sales-map", decision: "approved" });
    const duplicate = approveWidget(state, client, { name: "sales-map", decision: "rejected" });

    expect(request).toHaveBeenCalledOnce();
    expect(state.pendingApprovalNames.has("sales-map")).toBe(true);
    await duplicate;
    resolveRequest();
    await first;
    expect(state.pendingApprovalNames.has("sales-map")).toBe(true);

    const refreshed = sampleWorkspace({
      workspaceVersion: 4,
      widgetsRegistry: { "sales-map": { status: "approved" } },
    });
    await loadWorkspace(
      state,
      mockClient({
        request: vi.fn(async () => ({ doc: refreshed, workspaceVersion: 4 })) as never,
      }),
    );
    expect(state.pendingApprovalNames.has("sales-map")).toBe(false);
  });

  it("unlocks a pending custom widget after a failed decision", async () => {
    const state = getWorkspaceState({});
    const client = mockClient({
      request: vi.fn(async () => {
        throw new Error("decision failed");
      }) as never,
    });

    await approveWidget(state, client, { name: "sales-map", decision: "approved" });

    expect(state.pendingApprovalNames.has("sales-map")).toBe(false);
    expect(state.actionError).toBe("decision failed");
  });
});

describe("loadWorkspace", () => {
  it("fetches and stores the workspace, seeding the active slug", async () => {
    const host = {};
    const state = getWorkspaceState(host);
    const client = mockClient({
      // Real gateway shape: workspaces.get returns { doc, workspaceVersion }.
      request: vi.fn(async () => ({ doc: sampleDoc, workspaceVersion: 3 })) as never,
    });
    await loadWorkspace(state, client, { requestedSlug: "archive" });
    expect(state.loaded).toBe(true);
    // The workspace actually populates (tabs present), not an empty fallback.
    expect(state.workspace?.workspaceVersion).toBe(3);
    expect(state.workspace?.tabs).toHaveLength(2);
    expect(state.activeSlug).toBe("archive");
  });

  it("keeps a newer workspace when an older reload finishes last", async () => {
    const state = getWorkspaceState({});
    const resolveRequests: Array<(value: unknown) => void> = [];
    const client = mockClient({
      request: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRequests.push(resolve);
          }),
      ) as never,
    });

    const olderLoad = loadWorkspace(state, client);
    const newerLoad = loadWorkspace(state, client, { silent: true });
    expect(resolveRequests).toHaveLength(2);

    const newer = sampleWorkspace({ workspaceVersion: 4 });
    expectDefined(newer.tabs[0], "newer tab").title = "Newest";
    resolveRequests[1]?.({ doc: newer, workspaceVersion: 4 });
    await newerLoad;
    expect(state.loading).toBe(false);

    resolveRequests[0]?.({ doc: sampleWorkspace(), workspaceVersion: 3 });
    await olderLoad;

    expect(state.workspace?.workspaceVersion).toBe(4);
    expect(state.workspace?.tabs[0]?.title).toBe("Newest");
  });

  it("accepts a higher workspace version from an older request without restoring its navigation", async () => {
    const state = getWorkspaceState({});
    state.workspace = sampleWorkspace();
    state.activeSlug = "main";
    const resolveRequests: Array<(value: unknown) => void> = [];
    const client = mockClient({
      request: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRequests.push(resolve);
          }),
      ) as never,
    });

    const olderLoad = loadWorkspace(state, client, { requestedSlug: "archive" });
    const newerLoad = loadWorkspace(state, client, { requestedSlug: null });

    resolveRequests[1]?.({
      doc: sampleWorkspace({ workspaceVersion: 4 }),
      workspaceVersion: 4,
    });
    await newerLoad;

    const highestVersion = sampleWorkspace({ workspaceVersion: 5 });
    expectDefined(highestVersion.tabs[0], "highest-version tab").title = "Latest";
    resolveRequests[0]?.({ doc: highestVersion, workspaceVersion: 5 });
    await olderLoad;

    expect(state.workspace?.workspaceVersion).toBe(5);
    expect(state.workspace?.tabs[0]?.title).toBe("Latest");
    expect(state.activeSlug).toBe("main");
  });

  it("preserves requested navigation when a silent reload supersedes it", async () => {
    const state = getWorkspaceState({});
    const resolveRequests: Array<(value: unknown) => void> = [];
    const client = mockClient({
      request: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRequests.push(resolve);
          }),
      ) as never,
    });

    const foregroundLoad = loadWorkspace(state, client, { requestedSlug: "archive" });
    const silentLoad = loadWorkspace(state, client, { requestedSlug: null, silent: true });

    resolveRequests[1]?.({
      doc: sampleWorkspace({ workspaceVersion: 4 }),
      workspaceVersion: 4,
    });
    await silentLoad;
    expect(state.activeSlug).toBe("archive");

    resolveRequests[0]?.({ doc: sampleWorkspace(), workspaceVersion: 3 });
    await foregroundLoad;
    expect(state.activeSlug).toBe("archive");
    expect(state.workspace?.workspaceVersion).toBe(4);
  });

  it("retains requested navigation after a superseding silent failure", async () => {
    const state = getWorkspaceState({});
    const requests: Array<{
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }> = [];
    const client = mockClient({
      request: vi.fn(
        () =>
          new Promise((resolve, reject) => {
            requests.push({ resolve, reject });
          }),
      ) as never,
    });

    const requestedLoad = loadWorkspace(state, client, { requestedSlug: "archive" });
    const failedSilentLoad = loadWorkspace(state, client, { silent: true });
    requests[1]?.reject(new Error("temporary failure"));
    await failedSilentLoad;

    const retryLoad = loadWorkspace(state, client, { silent: true });
    requests[2]?.resolve({
      doc: sampleWorkspace({ workspaceVersion: 4 }),
      workspaceVersion: 4,
    });
    await retryLoad;
    expect(state.activeSlug).toBe("archive");

    requests[0]?.resolve({ doc: sampleWorkspace(), workspaceVersion: 3 });
    await requestedLoad;
    expect(state.activeSlug).toBe("archive");
  });

  it("applies retained navigation when an older request supplies the first document", async () => {
    const state = getWorkspaceState({});
    const requests: Array<{
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }> = [];
    const client = mockClient({
      request: vi.fn(
        () =>
          new Promise((resolve, reject) => {
            requests.push({ resolve, reject });
          }),
      ) as never,
    });

    const requestedLoad = loadWorkspace(state, client, { requestedSlug: "archive" });
    const failedSilentLoad = loadWorkspace(state, client, { silent: true });
    requests[1]?.reject(new Error("temporary failure"));
    await failedSilentLoad;

    requests[0]?.resolve({ doc: sampleWorkspace(), workspaceVersion: 3 });
    await requestedLoad;

    expect(state.workspace?.workspaceVersion).toBe(3);
    expect(state.activeSlug).toBe("archive");
    expect(state.error).toBe("temporary failure");
  });

  it("invalidates captured navigation when the successful document lacks the requested tab", async () => {
    const state = getWorkspaceState({});
    const requests: Array<{
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }> = [];
    const client = mockClient({
      request: vi.fn(
        () =>
          new Promise((resolve, reject) => {
            requests.push({ resolve, reject });
          }),
      ) as never,
    });

    const requestedLoad = loadWorkspace(state, client, { requestedSlug: "future" });
    const silentLoad = loadWorkspace(state, client, { silent: true });
    requests[0]?.resolve({ doc: sampleWorkspace(), workspaceVersion: 3 });
    await requestedLoad;
    expect(state.activeSlug).toBe("main");

    const laterWorkspace = sampleWorkspace({
      workspaceVersion: 4,
      tabs: [
        ...sampleWorkspace().tabs,
        { slug: "future", title: "Future", hidden: false, widgets: [] },
      ],
    });
    requests[1]?.resolve({ doc: laterWorkspace, workspaceVersion: 4 });
    await silentLoad;

    expect(state.activeSlug).toBe("main");
  });

  it("cancels older navigation intent on a newer foreground reload", async () => {
    const state = getWorkspaceState({});
    state.workspace = sampleWorkspace();
    state.activeSlug = "main";
    const resolveRequests: Array<(value: unknown) => void> = [];
    const client = mockClient({
      request: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRequests.push(resolve);
          }),
      ) as never,
    });

    const requestedLoad = loadWorkspace(state, client, { requestedSlug: "archive" });
    const foregroundReload = loadWorkspace(state, client, { requestedSlug: null });

    resolveRequests[1]?.({
      doc: sampleWorkspace({ workspaceVersion: 4 }),
      workspaceVersion: 4,
    });
    await foregroundReload;
    expect(state.activeSlug).toBe("main");

    resolveRequests[0]?.({ doc: sampleWorkspace(), workspaceVersion: 3 });
    await requestedLoad;
    expect(state.activeSlug).toBe("main");
  });

  it("cancels pending navigation when the deep link returns to the active tab", async () => {
    const state = getWorkspaceState({});
    const workspace = sampleWorkspace();
    state.workspace = workspace;
    state.activeSlug = "main";
    let resolveRequest: ((value: unknown) => void) | undefined;
    const client = mockClient({
      request: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRequest = resolve;
          }),
      ) as never,
    });

    const reload = loadWorkspace(state, client, { requestedSlug: "archive" });
    setActiveWorkspaceSlug(state, workspace, "main");
    resolveRequest?.({ doc: sampleWorkspace({ workspaceVersion: 4 }), workspaceVersion: 4 });
    await reload;

    expect(state.activeSlug).toBe("main");
  });

  it("cancels pending navigation when the deep link is removed", async () => {
    const state = getWorkspaceState({});
    const workspace = sampleWorkspace();
    state.workspace = workspace;
    state.activeSlug = "main";
    const client = mockClient({
      request: vi.fn(async () => ({
        doc: sampleWorkspace({ workspaceVersion: 4 }),
        workspaceVersion: 4,
      })) as never,
    });

    const reload = loadWorkspace(state, client, { requestedSlug: "archive" });
    cancelWorkspaceLoadIntent(state);
    await reload;

    expect(state.activeSlug).toBe("main");
  });

  it("settles requested navigation against a newer current workspace", async () => {
    const state = getWorkspaceState({});
    state.workspace = sampleWorkspace({ workspaceVersion: 5 });
    state.activeSlug = "main";
    state.error = "previous failure";
    const client = mockClient({
      request: vi.fn(async () => ({
        doc: sampleWorkspace({ workspaceVersion: 4 }),
        workspaceVersion: 4,
      })) as never,
    });

    await loadWorkspace(state, client, { requestedSlug: "archive" });

    expect(state.workspace?.workspaceVersion).toBe(5);
    expect(state.activeSlug).toBe("archive");
    expect(state.error).toBeNull();
  });

  it("keeps the active tab when requested navigation fails and retries the intent", async () => {
    const state = getWorkspaceState({});
    state.workspace = sampleWorkspace();
    state.activeSlug = "main";
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("reload failed"))
      .mockResolvedValueOnce({
        doc: sampleWorkspace({ workspaceVersion: 4 }),
        workspaceVersion: 4,
      });
    const client = mockClient({ request: request as never });

    await loadWorkspace(state, client, { requestedSlug: "archive" });
    expect(state.activeSlug).toBe("main");

    await loadWorkspace(state, client, { requestedSlug: "archive" });
    expect(state.activeSlug).toBe("archive");
    expect(state.workspace?.workspaceVersion).toBe(4);
  });

  it("treats a null requested slug as absent during reload", async () => {
    const state = getWorkspaceState({});
    state.workspace = sampleWorkspace();
    state.activeSlug = "archive";
    const client = mockClient({
      request: vi.fn(async () => ({
        doc: sampleWorkspace({ workspaceVersion: 4 }),
        workspaceVersion: 4,
      })) as never,
    });

    await loadWorkspace(state, client, { requestedSlug: null });
    expect(state.activeSlug).toBe("archive");
  });

  it("preserves a newer tab selection while requested navigation is pending", async () => {
    const state = getWorkspaceState({});
    const workspace = sampleWorkspace({
      tabs: [
        ...sampleWorkspace().tabs,
        { slug: "other", title: "Other", hidden: false, widgets: [] },
      ],
    });
    state.workspace = workspace;
    state.activeSlug = "main";
    let resolveRequest: ((value: unknown) => void) | undefined;
    const client = mockClient({
      request: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRequest = resolve;
          }),
      ) as never,
    });

    const reload = loadWorkspace(state, client, { requestedSlug: "archive" });
    setActiveWorkspaceSlug(state, workspace, "other");
    setActiveWorkspaceSlug(state, workspace, "main");
    resolveRequest?.({
      doc: { ...workspace, workspaceVersion: 4 },
      workspaceVersion: 4,
    });
    await reload;

    expect(state.activeSlug).toBe("main");
  });

  it("defers matching deep-link reconciliation until the loaded tab exists", async () => {
    const state = getWorkspaceState({});
    const currentWorkspace = sampleWorkspace();
    state.workspace = currentWorkspace;
    state.activeSlug = "main";
    let resolveRequest: ((value: unknown) => void) | undefined;
    const client = mockClient({
      request: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRequest = resolve;
          }),
      ) as never,
    });

    const reload = loadWorkspace(state, client, { requestedSlug: "new-tab" });
    setActiveWorkspaceSlug(state, currentWorkspace, "new-tab");
    expect(state.activeSlug).toBe("main");

    resolveRequest?.({
      doc: sampleWorkspace({
        workspaceVersion: 4,
        tabs: [
          ...currentWorkspace.tabs,
          { slug: "new-tab", title: "New", hidden: false, widgets: [] },
        ],
      }),
      workspaceVersion: 4,
    });
    await reload;
    expect(state.activeSlug).toBe("new-tab");
  });

  it("keeps loading owned by the newest foreground reload", async () => {
    const state = getWorkspaceState({});
    const resolveRequests: Array<(value: unknown) => void> = [];
    const client = mockClient({
      request: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRequests.push(resolve);
          }),
      ) as never,
    });

    const olderLoad = loadWorkspace(state, client);
    const newerLoad = loadWorkspace(state, client);
    expect(state.loading).toBe(true);

    resolveRequests[0]?.({ doc: sampleWorkspace(), workspaceVersion: 3 });
    await olderLoad;
    expect(state.loading).toBe(true);

    resolveRequests[1]?.({
      doc: sampleWorkspace({ workspaceVersion: 4 }),
      workspaceVersion: 4,
    });
    await newerLoad;
    expect(state.loading).toBe(false);
    expect(state.workspace?.workspaceVersion).toBe(4);
  });

  it("ignores an older reload error after a newer workspace loads", async () => {
    const state = getWorkspaceState({});
    const requests: Array<{
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }> = [];
    const client = mockClient({
      request: vi.fn(
        () =>
          new Promise((resolve, reject) => {
            requests.push({ resolve, reject });
          }),
      ) as never,
    });

    const olderLoad = loadWorkspace(state, client);
    const newerLoad = loadWorkspace(state, client, { silent: true });
    expect(requests).toHaveLength(2);

    requests[1]?.resolve({ doc: sampleWorkspace({ workspaceVersion: 4 }), workspaceVersion: 4 });
    await newerLoad;
    requests[0]?.reject(new Error("stale failure"));
    await olderLoad;

    expect(state.workspace?.workspaceVersion).toBe(4);
    expect(state.error).toBeNull();
    expect(state.loading).toBe(false);
  });

  it("records an error on failure", async () => {
    const host = {};
    const state = getWorkspaceState(host);
    const client = mockClient({
      request: vi.fn(async () => {
        throw new Error("boom");
      }) as never,
    });
    await loadWorkspace(state, client);
    expect(state.error).toBe("boom");
    expect(state.loaded).toBe(false);
  });
});

describe("optimistic workspace mutations", () => {
  it("uses the gateway tab/id wire contract for every widget mutation", async () => {
    const state = getWorkspaceState({});
    state.workspace = sampleWorkspace();
    const request = vi.fn(async () => ({}));
    const client = mockClient({ request: request as never });

    await moveWidget(state, client, {
      slug: "main",
      widgetId: "w1",
      grid: { x: 8, y: 0, w: 4, h: 2 },
    });
    expect(request).toHaveBeenLastCalledWith("workspaces.widget.move", {
      tab: "main",
      id: "w1",
      grid: { x: 8, y: 0, w: 4, h: 2 },
    });

    await updateWidgetTitle(state, client, { slug: "main", widgetId: "w1", title: "Renamed" });
    expect(request).toHaveBeenLastCalledWith("workspaces.widget.update", {
      tab: "main",
      id: "w1",
      patch: { title: "Renamed" },
    });

    await hideWidget(state, client, { slug: "main", widgetId: "w1" });
    expect(request).toHaveBeenLastCalledWith("workspaces.widget.update", {
      tab: "main",
      id: "w1",
      patch: { hidden: true },
    });

    state.workspace = sampleWorkspace();
    await removeWidgetFromTab(state, client, { slug: "main", widgetId: "w1" });
    expect(request).toHaveBeenLastCalledWith("workspaces.widget.remove", {
      tab: "main",
      id: "w1",
    });

    state.workspace = sampleWorkspace();
    await moveWidgetToTab(state, client, {
      fromSlug: "main",
      toSlug: "archive",
      widgetId: "w1",
    });
    expect(request).toHaveBeenLastCalledWith("workspaces.widget.move", {
      tab: "main",
      id: "w1",
      toTab: "archive",
    });
  });

  it("rolls back a rejected mutation and surfaces its error", async () => {
    const state = getWorkspaceState({});
    state.workspace = sampleWorkspace();
    const client = mockClient({
      request: vi.fn(async () => {
        throw new Error("rejected");
      }) as never,
    });

    await moveWidget(state, client, {
      slug: "main",
      widgetId: "w1",
      grid: { x: 8, y: 0, w: 4, h: 2 },
    });

    expect(state.workspace?.tabs[0]?.widgets[0]?.grid).toEqual({ x: 0, y: 0, w: 4, h: 2 });
    expect(state.actionError).toBe("rejected");
    expect(state.pendingWidgetIds.has("w1")).toBe(false);
  });

  it("serializes overlapping writes so both failures fully revert", async () => {
    const state = getWorkspaceState({});
    state.workspace = sampleWorkspace();
    const rejectors: Array<(error: Error) => void> = [];
    const request = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectors.push(reject);
        }),
    );
    const client = mockClient({ request: request as never });

    const first = moveWidget(state, client, {
      slug: "main",
      widgetId: "w1",
      grid: { x: 8, y: 0, w: 4, h: 2 },
    });
    await vi.waitFor(() => expect(rejectors).toHaveLength(1));
    const second = updateWidgetTitle(state, client, {
      slug: "main",
      widgetId: "w1",
      title: "Rejected title",
    });
    expect(request).toHaveBeenCalledOnce();

    rejectors[0]?.(new Error("first rejected"));
    await vi.waitFor(() => expect(rejectors).toHaveLength(2));
    rejectors[1]?.(new Error("second rejected"));
    await Promise.all([first, second]);

    expect(state.workspace?.tabs[0]?.widgets[0]).toMatchObject({
      title: "Revenue",
      grid: { x: 0, y: 0, w: 4, h: 2 },
    });
    expect(state.pendingWidgetIds.has("w1")).toBe(false);
  });

  it("does not overwrite a fresher reload when an older mutation rejects", async () => {
    const state = getWorkspaceState({});
    state.workspace = sampleWorkspace();
    let rejectMutation!: (error: Error) => void;
    const client = mockClient({
      request: vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            rejectMutation = reject;
          }),
      ) as never,
    });

    const mutation = moveWidget(state, client, {
      slug: "main",
      widgetId: "w1",
      grid: { x: 8, y: 0, w: 4, h: 2 },
    });
    await vi.waitFor(() => expect(typeof rejectMutation).toBe("function"));

    const fresher = sampleWorkspace({ workspaceVersion: 4 });
    expectDefined(fresher.tabs[0], "fresher tab").widgets[0]!.title = "Revenue (v4)";
    state.workspace = fresher;
    rejectMutation(new Error("rejected"));
    await mutation;

    expect(state.workspace).toBe(fresher);
    expect(state.workspace?.workspaceVersion).toBe(4);
    expect(state.workspace?.tabs[0]?.widgets[0]?.title).toBe("Revenue (v4)");
  });
});

describe("live-update subscription", () => {
  it("tears down the listener on stop", () => {
    const host = {};
    const state = getWorkspaceState(host);
    const unsubscribe = vi.fn();
    const client = mockClient({
      addEventListener: vi.fn(() => unsubscribe) as never,
    });
    subscribeToWorkspaceEvents(host, state, client);
    stopWorkspace(host);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("binding resolution", () => {
  it("resolves static bindings from the literal value", async () => {
    const result = await resolveBinding(null, { source: "static", value: 42 });
    expect(result).toEqual({ value: 42 });
  });

  it("resolves rpc bindings on the client and applies the pointer", async () => {
    const request = vi.fn(async () => ({ revenue: 1000 }));
    const client = mockClient({ request: request as never });
    const result = await resolveBinding(client, {
      source: "rpc",
      method: "workspaces.stats",
      params: { scope: "month" },
      pointer: "/revenue",
    });
    expect(result).toEqual({ value: 1000 });
    expect(request).toHaveBeenCalledWith("workspaces.stats", { scope: "month" });
  });

  it("resolves usage.cost bindings in the browser's local calendar day", async () => {
    const request = vi.fn(async () => ({ totals: { totalCost: 1 } }));
    const client = mockClient({ request: request as never });

    await resolveBinding(client, {
      source: "rpc",
      method: "usage.cost",
      params: { days: 1 },
    });

    expect(request).toHaveBeenCalledWith("usage.cost", {
      days: 1,
      mode: "specific",
      timeZone: expect.any(String),
      utcOffset: expect.stringMatching(/^UTC[+-]/),
    });
  });

  it("preserves an explicit usage.cost timezone mode", async () => {
    const request = vi.fn(async () => ({}));
    const client = mockClient({ request: request as never });

    await resolveBinding(client, {
      source: "rpc",
      method: "usage.cost",
      params: { days: 1, mode: "utc" },
    });

    expect(request).toHaveBeenCalledWith("usage.cost", { days: 1, mode: "utc" });
  });

  it("resolves file bindings via workspaces.data.read matching the real gateway contract", async () => {
    // Contract with the gateway (extensions/workspace gateway.ts + data-read.ts):
    //   - workspaces.data.read's readParams whitelist accepts ONLY `binding` and
    //     rejects any other top-level key, so the client MUST send the whole binding.
    //   - the server resolves the file AND applies the JSON pointer, returning the
    //     final value under `data`; the client MUST NOT re-apply the pointer.
    // This mirrors the server's real response shape (already-pointed `data`), so a
    // regression to the old `{ path, pointer }` + client-side re-apply would fail here.
    const request = vi.fn(async () => ({ data: 7 }));
    const client = mockClient({ request: request as never });
    const result = await resolveBinding(client, {
      source: "file",
      path: "q3.json",
      pointer: "/q3/total",
    });
    expect(request).toHaveBeenCalledWith("workspaces.data.read", {
      binding: { source: "file", path: "q3.json", pointer: "/q3/total" },
    });
    expect(result).toEqual({ value: 7 });
  });

  it("returns an error result when resolution throws", async () => {
    const client = mockClient({
      request: vi.fn(async () => {
        throw new Error("no data");
      }) as never,
    });
    const result = await resolveBinding(client, { source: "rpc", method: "x" });
    expect(result).toEqual({ error: "no data" });
  });
});

describe("active drag cancellation", () => {
  it("cancels a registered drag from stopWorkspace", () => {
    const host = {};
    const cancel = vi.fn();
    registerActiveDrag(host, cancel);
    stopWorkspace(host);
    expect(cancel).toHaveBeenCalledTimes(1);
    // Idempotent: a second stop does not re-invoke the (already cleared) teardown.
    stopWorkspace(host);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not cancel a drag that already settled and cleared itself", () => {
    const host = {};
    const cancel = vi.fn();
    registerActiveDrag(host, cancel);
    clearActiveDrag(host); // normal pointerup path clears without cancelling
    stopWorkspace(host);
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("data-refresh polling", () => {
  it("stops ticking after stopWorkspace — no orphan timer", () => {
    vi.useFakeTimers();
    try {
      const host = {};
      const onTick = vi.fn();
      startBindingPolling(host, mockClient(), onTick, 10_000);
      vi.advanceTimersByTime(10_000);
      expect(onTick).toHaveBeenCalledTimes(1);
      stopWorkspace(host); // tab-leave / disconnect
      vi.advanceTimersByTime(60_000);
      expect(onTick).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a null client stops any running timer", () => {
    vi.useFakeTimers();
    try {
      const host = {};
      const onTick = vi.fn();
      startBindingPolling(host, mockClient(), onTick, 10_000);
      startBindingPolling(host, null, onTick, 10_000); // disconnect
      vi.advanceTimersByTime(30_000);
      expect(onTick).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
