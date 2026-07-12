import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventListener } from "../../api/gateway.ts";
import {
  applyPointer,
  cancelActiveDrag,
  clearActiveDrag,
  WORKSPACE_POLL_INTERVAL_MS,
  getWorkspaceState,
  hiddenTabs,
  hideWidget,
  loadWorkspace,
  moveWidget,
  moveWidgetToTab,
  normalizeWorkspace,
  orderedTabs,
  registerActiveDrag,
  removeWidgetFromTab,
  resolveActiveSlug,
  resolveBinding,
  setWidgetCollapsed,
  updateWidgetTitle,
  startBindingPolling,
  stopBindingPolling,
  stopWorkspace,
  subscribeToWorkspaceEvents,
  visibleTabs,
} from "./index.ts";

type MockClient = Pick<GatewayBrowserClient, "request" | "addEventListener">;

function itemAt<T>(items: readonly T[], index: number, label: string): T {
  return expectDefined(items[index], `${label} ${index}`);
}

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

describe("normalizeWorkspace", () => {
  it("normalizes tabs, widgets, and prefs defensively", () => {
    const ws = normalizeWorkspace(sampleDoc);
    expect(ws.workspaceVersion).toBe(3);
    expect(ws.tabs).toHaveLength(2);
    expect(itemAt(itemAt(ws.tabs, 0, "workspace tab").widgets, 0, "workspace widget").grid).toEqual(
      { x: 0, y: 0, w: 4, h: 2 },
    );
    expect(ws.prefs.tabOrder).toEqual(["archive", "main"]);
  });

  it("drops malformed tabs and widgets", () => {
    const ws = normalizeWorkspace({
      tabs: [{ title: "no slug" }, { slug: "ok", widgets: [{ kind: "x" }, { id: "y" }] }],
    });
    expect(ws.tabs).toHaveLength(1);
    expect(itemAt(ws.tabs, 0, "workspace tab").slug).toBe("ok");
    expect(itemAt(ws.tabs, 0, "workspace tab").widgets).toHaveLength(0);
  });

  it("clamps out-of-range grid coordinates", () => {
    const ws = normalizeWorkspace({
      tabs: [
        {
          slug: "t",
          widgets: [{ id: "w", kind: "k", grid: { x: 20, y: -5, w: 99, h: 0 } }],
        },
      ],
    });
    expect(itemAt(itemAt(ws.tabs, 0, "workspace tab").widgets, 0, "workspace widget").grid).toEqual(
      { x: 0, y: 0, w: 12, h: 1 },
    );
  });
});

describe("tab ordering + resolution", () => {
  it("honors prefs.tabOrder then appends unordered tabs", () => {
    const ws = normalizeWorkspace({
      ...sampleDoc,
      prefs: { tabOrder: ["main"] },
    });
    expect(orderedTabs(ws).map((t) => t.slug)).toEqual(["main", "archive"]);
  });

  it("splits visible and hidden tabs", () => {
    const ws = normalizeWorkspace(sampleDoc);
    expect(visibleTabs(ws).map((t) => t.slug)).toEqual(["main"]);
    expect(hiddenTabs(ws).map((t) => t.slug)).toEqual(["archive"]);
  });

  it("resolves requested slug, falling back to first visible tab", () => {
    const ws = normalizeWorkspace(sampleDoc);
    expect(resolveActiveSlug(ws, "main")).toBe("main");
    expect(resolveActiveSlug(ws, "archive")).toBe("archive");
    expect(resolveActiveSlug(ws, "missing")).toBe("main");
    expect(resolveActiveSlug(ws, null)).toBe("main");
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

describe("optimistic mutations", () => {
  it("applies collapse optimistically and persists it", async () => {
    const host = {};
    const state = getWorkspaceState(host);
    state.workspace = normalizeWorkspace(sampleDoc);
    const request = vi.fn(async () => ({}));
    const client = mockClient({ request: request as never });
    await setWidgetCollapsed(state, client, { slug: "main", widgetId: "w1", collapsed: true });
    expect(state.workspace?.tabs.at(0)?.widgets.at(0)?.collapsed).toBe(true);
    // Wire contract: the gateway's workspaces.widget.update reads { tab, id, patch }.
    expect(request).toHaveBeenCalledWith("workspaces.widget.update", {
      tab: "main",
      id: "w1",
      patch: { collapsed: true },
    });
  });

  it("sends every widget mutation in the gateway's { tab, id, ... } param contract", async () => {
    // Regression guard for the UI↔gateway seam: the gateway readParams whitelists
    // are { tab, id, patch } (update), { tab, id, grid|toTab } (move), { tab, id }
    // (remove) — NOT the UI's internal { slug, widgetId }. These are asserted at the
    // wire so a drift back to { slug, widgetId, <field> } fails here rather than only
    // at runtime against the real gateway.
    const host = {};
    const state = getWorkspaceState(host);
    state.workspace = normalizeWorkspace(sampleDoc);
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

    state.workspace = normalizeWorkspace(sampleDoc);
    await removeWidgetFromTab(state, client, { slug: "main", widgetId: "w1" });
    expect(request).toHaveBeenLastCalledWith("workspaces.widget.remove", { tab: "main", id: "w1" });

    state.workspace = normalizeWorkspace(sampleDoc);
    await moveWidgetToTab(state, client, { fromSlug: "main", toSlug: "archive", widgetId: "w1" });
    expect(request).toHaveBeenLastCalledWith("workspaces.widget.move", {
      tab: "main",
      id: "w1",
      toTab: "archive",
    });
  });

  it("reverts and surfaces an error when the RPC rejects", async () => {
    const host = {};
    const state = getWorkspaceState(host);
    state.workspace = normalizeWorkspace(sampleDoc);
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
    // Reverted to original grid; error surfaced for the toast.
    expect(state.workspace?.tabs.at(0)?.widgets.at(0)?.grid).toEqual({ x: 0, y: 0, w: 4, h: 2 });
    expect(state.actionError).toBe("rejected");
    expect(state.pendingWidgetIds.has("w1")).toBe(false);
  });

  it("serializes overlapping optimistic writes so both failures fully revert", async () => {
    const host = {};
    const state = getWorkspaceState(host);
    state.workspace = normalizeWorkspace(sampleDoc);
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
    expect(request).toHaveBeenCalledTimes(1);

    rejectors[0]!(new Error("first rejected"));
    await vi.waitFor(() => expect(rejectors).toHaveLength(2));
    rejectors[1]!(new Error("second rejected"));
    await Promise.all([first, second]);

    expect(state.workspace?.tabs.at(0)?.widgets.at(0)).toMatchObject({
      title: "Revenue",
      grid: { x: 0, y: 0, w: 4, h: 2 },
    });
    expect(state.pendingWidgetIds.has("w1")).toBe(false);
  });

  it("does not stomp a fresher concurrent load when the mutation later rejects", async () => {
    const host = {};
    const state = getWorkspaceState(host);
    state.workspace = normalizeWorkspace(sampleDoc); // version 3

    // The mutation RPC hangs until we reject it, letting a concurrent refetch land.
    let rejectMutation!: (err: Error) => void;
    const client = mockClient({
      request: vi.fn(
        (method: string) =>
          new Promise((_resolve, reject) => {
            if (method === "workspaces.widget.move") {
              rejectMutation = reject;
            }
          }),
      ) as never,
    });

    const mutation = moveWidget(state, client, {
      slug: "main",
      widgetId: "w1",
      grid: { x: 8, y: 0, w: 4, h: 2 },
    });
    await vi.waitFor(() => expect(typeof rejectMutation).toBe("function"));

    // A concurrent broadcast refetch lands a FRESHER doc (version 4) mid-flight.
    const fresher = normalizeWorkspace({ ...sampleDoc, workspaceVersion: 4 });
    itemAt(itemAt(fresher.tabs, 0, "fresher workspace tab").widgets, 0, "fresher widget").title =
      "Revenue (v4)";
    state.workspace = fresher;

    // Now the in-flight mutation fails.
    rejectMutation(new Error("rejected"));
    await mutation;

    // The fresher doc must survive — no revert to the stale pre-mutation snapshot.
    expect(state.workspace).toBe(fresher);
    expect(state.workspace?.workspaceVersion).toBe(4);
    expect(state.workspace?.tabs.at(0)?.widgets.at(0)?.title).toBe("Revenue (v4)");
    expect(state.actionError).toBe("rejected");
  });
});

describe("live-update subscription", () => {
  it("refetches only on a strictly newer workspaceVersion", async () => {
    const host = {};
    const state = getWorkspaceState(host);
    state.workspace = normalizeWorkspace(sampleDoc); // version 3
    let listener: GatewayEventListener | null = null;
    const request = vi.fn(async () => ({ workspace: { ...sampleDoc, workspaceVersion: 4 } }));
    const client = mockClient({
      request: request as never,
      addEventListener: vi.fn((cb: GatewayEventListener) => {
        listener = cb;
        return () => {};
      }) as never,
    });
    subscribeToWorkspaceEvents(host, state, client);
    expect(listener).not.toBeNull();

    // Stale / own-echo version: no refetch.
    listener!({
      type: "event",
      event: "plugin.workspaces.changed",
      payload: { workspaceVersion: 3 },
    });
    expect(request).not.toHaveBeenCalled();

    // Unrelated event: ignored.
    listener!({ type: "event", event: "plugin.other", payload: { workspaceVersion: 9 } });
    expect(request).not.toHaveBeenCalled();

    // Newer version: refetch.
    listener!({
      type: "event",
      event: "plugin.workspaces.changed",
      payload: { workspaceVersion: 4 },
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    stopWorkspace(host);
  });

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

describe("applyPointer", () => {
  it("walks objects and arrays, returning undefined for misses", () => {
    const doc = { a: { b: [10, 20] } };
    expect(applyPointer(doc, "/a/b/1")).toBe(20);
    expect(applyPointer(doc, "/a/missing")).toBeUndefined();
    expect(applyPointer(doc, undefined)).toBe(doc);
  });

  it("decodes escaped pointer segments", () => {
    expect(applyPointer({ "a/b": 5 }, "/a~1b")).toBe(5);
    expect(applyPointer({ "a~b": 6 }, "/a~0b")).toBe(6);
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

  it("cancels the prior drag when a new one registers on the same host", () => {
    const host = {};
    const first = vi.fn();
    const second = vi.fn();
    registerActiveDrag(host, first);
    registerActiveDrag(host, second);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    cancelActiveDrag(host);
    expect(second).toHaveBeenCalledTimes(1);
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
  it("ticks on the interval while the document is visible", () => {
    vi.useFakeTimers();
    try {
      const host = {};
      const onTick = vi.fn();
      startBindingPolling(host, mockClient(), onTick, 10_000);
      vi.advanceTimersByTime(30_000);
      expect(onTick).toHaveBeenCalledTimes(3);
      stopBindingPolling(host);
    } finally {
      vi.useRealTimers();
    }
  });

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

  it("is idempotent — a re-render does not stack timers", () => {
    vi.useFakeTimers();
    try {
      const host = {};
      const onTick = vi.fn();
      startBindingPolling(host, mockClient(), onTick, 10_000);
      startBindingPolling(host, mockClient(), onTick, 10_000);
      vi.advanceTimersByTime(10_000);
      expect(onTick).toHaveBeenCalledTimes(1);
      stopBindingPolling(host);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the tick when the document is hidden", () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      const host = {};
      const onTick = vi.fn();
      startBindingPolling(host, mockClient(), onTick, 10_000);
      vi.advanceTimersByTime(30_000);
      expect(onTick).not.toHaveBeenCalled();
      stopBindingPolling(host);
    } finally {
      visibility.mockRestore();
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

  it("clamps sub-10s intervals up to the 10s floor", () => {
    vi.useFakeTimers();
    try {
      const host = {};
      const onTick = vi.fn();
      startBindingPolling(host, mockClient(), onTick, 1_000);
      vi.advanceTimersByTime(9_000);
      expect(onTick).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_000);
      expect(onTick).toHaveBeenCalledTimes(1);
      stopBindingPolling(host);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes a sane default interval within the spec window", () => {
    expect(WORKSPACE_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(30_000);
    expect(WORKSPACE_POLL_INTERVAL_MS).toBeLessThanOrEqual(60_000);
  });
});
