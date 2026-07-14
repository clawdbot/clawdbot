import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  clearActiveDrag,
  getWorkspaceState,
  hideWidget,
  loadWorkspace,
  moveWidget,
  moveWidgetToTab,
  registerActiveDrag,
  removeWidgetFromTab,
  resolveBinding,
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
