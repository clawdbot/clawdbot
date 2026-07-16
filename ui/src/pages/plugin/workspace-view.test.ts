import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { getWorkspaceState } from "../../lib/workspace/index.ts";
import { stopWorkspace } from "./workspace-controller.ts";
import { renderWorkspace } from "./workspace-view.ts";

function renderView(host: object): HTMLElement {
  const container = document.createElement("div");
  // The view queries `.workspace-grid` on the host for grid metrics.
  const el = container as unknown as object;
  render(renderWorkspace({ host: el, client: null, connected: false }), container);
  render(renderWorkspace({ host, client: null, connected: false }), container);
  return container;
}

const doc = {
  schemaVersion: 1,
  workspaceVersion: 1,
  tabs: [
    {
      slug: "main",
      title: "Main",
      hidden: false,
      widgets: [
        {
          id: "w1",
          kind: "builtin:markdown",
          title: "Notes",
          grid: { x: 0, y: 0, w: 6, h: 2 },
          collapsed: false,
          props: { markdown: "hello" },
        },
      ],
    },
    { slug: "hidden-one", title: "Hidden", hidden: true, widgets: [] },
    { slug: "empty", title: "Empty", hidden: false, widgets: [] },
  ],
  widgetsRegistry: {},
  prefs: { tabOrder: ["main", "empty", "hidden-one"] },
};

describe("renderWorkspace", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("shows the onboarding empty state with no tabs", () => {
    const host = {};
    const state = getWorkspaceState(host);
    state.loaded = true;
    state.workspace = {
      schemaVersion: 1,
      workspaceVersion: 1,
      tabs: [],
      widgetsRegistry: {},
      prefs: { tabOrder: [] },
    };
    const container = renderView(host);
    expect(container.querySelector('[data-test-id="workspace-empty"]')).not.toBeNull();
  });

  it("renders the tab strip with visible tabs and a hidden overflow", () => {
    const host = {};
    const state = getWorkspaceState(host);
    state.loaded = true;
    state.workspace = doc;
    state.activeSlug = "main";
    const container = renderView(host);
    const tabs = container.querySelectorAll('[data-test-id="workspace-tab"]');
    expect(tabs.length).toBe(2); // main + empty (hidden-one is in overflow)
    expect(container.querySelector(".workspace-tabs__hidden")).not.toBeNull();
    // Active tab's widget grid renders.
    expect(container.querySelector('[data-test-id="workspace-grid"]')).not.toBeNull();
  });

  it("renders the empty-tab hint for a tab with no widgets", () => {
    const host = {};
    const state = getWorkspaceState(host);
    state.loaded = true;
    state.workspace = doc;
    state.activeSlug = "empty";
    const container = renderView(host);
    expect(container.querySelector('[data-test-id="workspace-empty-tab"]')).not.toBeNull();
  });

  it("surfaces an action error toast", () => {
    const host = {};
    const state = getWorkspaceState(host);
    state.loaded = true;
    state.workspace = doc;
    state.activeSlug = "main";
    state.actionError = "move failed";
    const container = renderView(host);
    expect(container.querySelector(".workspace__toast")?.textContent).toContain("move failed");
  });

  it("honors workspace deep links and updates them from tab navigation", () => {
    window.history.replaceState({}, "", "/plugin?plugin=workspaces&id=workspaces&ws=empty");
    const host = document.createElement("div");
    document.body.append(host);
    const state = getWorkspaceState(host);
    state.loaded = true;
    state.workspace = doc;
    state.activeSlug = "main";
    const onPopState = vi.fn();
    window.addEventListener("popstate", onPopState);

    try {
      render(renderWorkspace({ host, client: null, connected: false }), host);
      expect(state.activeSlug).toBe("empty");
      host
        .querySelector<HTMLElement>("wa-tab-group")
        ?.dispatchEvent(new CustomEvent("wa-tab-show", { detail: { name: "main" } }));
      expect(new URLSearchParams(window.location.search).get("ws")).toBe("main");
      expect(onPopState).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener("popstate", onPopState);
      stopWorkspace(host);
      host.remove();
    }
  });

  it("cancels a removed deep link before the initial workspace finishes loading", async () => {
    window.history.replaceState({}, "", "/plugin?plugin=workspaces&id=workspaces&ws=empty");
    const host = document.createElement("div");
    document.body.append(host);
    let resolveWorkspace!: (value: unknown) => void;
    const request = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveWorkspace = resolve;
        }),
    );
    const client = {
      request,
      addEventListener: vi.fn(() => () => {}),
    } as unknown as GatewayBrowserClient;
    const state = getWorkspaceState(host);

    try {
      render(renderWorkspace({ host, client, connected: true }), host);
      expect(request).toHaveBeenCalledOnce();

      window.history.replaceState({}, "", "/plugin?plugin=workspaces&id=workspaces");
      render(renderWorkspace({ host, client, connected: true }), host);

      resolveWorkspace({ doc, workspaceVersion: doc.workspaceVersion });
      await vi.waitFor(() => expect(state.loaded).toBe(true));
      expect(state.activeSlug).toBe("main");
    } finally {
      stopWorkspace(host);
      host.remove();
    }
  });

  it("discards a stale binding result after the polling version advances", async () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);
    let resolveOld!: (value: unknown) => void;
    let resolveFresh!: (value: unknown) => void;
    const oldResult = new Promise((resolve) => {
      resolveOld = resolve;
    });
    const freshResult = new Promise((resolve) => {
      resolveFresh = resolve;
    });
    const request = vi.fn().mockReturnValueOnce(oldResult).mockReturnValueOnce(freshResult);
    const client = {
      request,
      addEventListener: vi.fn(() => () => {}),
    } as unknown as GatewayBrowserClient;
    const state = getWorkspaceState(host);
    state.loaded = true;
    state.activeSlug = "main";
    state.workspace = {
      schemaVersion: 1,
      workspaceVersion: 1,
      tabs: [
        {
          slug: "main",
          title: "Main",
          hidden: false,
          widgets: [
            {
              id: "cost",
              kind: "builtin:stat-card",
              title: "Cost",
              grid: { x: 0, y: 0, w: 4, h: 2 },
              collapsed: false,
              bindings: { value: { source: "rpc", method: "usage.cost" } },
            },
          ],
        },
      ],
      widgetsRegistry: {},
      prefs: { tabOrder: ["main"] },
    };

    try {
      render(renderWorkspace({ host, client, connected: true }), host);
      expect(request).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(60_000);
      render(renderWorkspace({ host, client, connected: true }), host);
      expect(request).toHaveBeenCalledTimes(2);

      resolveFresh(2);
      await freshResult;
      await vi.waitFor(() => {
        render(renderWorkspace({ host, client, connected: true }), host);
        expect(host.querySelector(".workspace-stat__value")?.textContent).toBe("2");
      });

      resolveOld(1);
      await oldResult;
      await Promise.resolve();
      render(renderWorkspace({ host, client, connected: true }), host);
      expect(host.querySelector(".workspace-stat__value")?.textContent).toBe("2");
    } finally {
      stopWorkspace(host);
      host.remove();
      vi.useRealTimers();
    }
  });

  it("reloads a custom-widget frame after workspace changes and reconnects", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const state = getWorkspaceState(host);
    const workspace = (workspaceVersion: number) => ({
      schemaVersion: 1,
      workspaceVersion,
      tabs: [
        {
          slug: "main",
          title: "Main",
          hidden: false,
          widgets: [
            {
              id: "custom",
              kind: "custom:revenue-chart",
              title: "Revenue",
              grid: { x: 0, y: 0, w: 6, h: 4 },
              collapsed: false,
            },
          ],
        },
      ],
      widgetsRegistry: { "revenue-chart": { status: "approved" as const } },
      prefs: { tabOrder: ["main"] },
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        frameToken: "1111111111111111111111111111111111111111111",
        frameExpiresAt: Date.now() + 60 * 60 * 1000,
        manifest: { entrypoint: "old.html", bindings: [], capabilities: ["prompt:send"] },
      })
      .mockResolvedValueOnce({
        frameToken: "2222222222222222222222222222222222222222222",
        frameExpiresAt: Date.now() + 60 * 60 * 1000,
        manifest: { entrypoint: "new.html", bindings: [], capabilities: [] },
      })
      .mockResolvedValueOnce({
        frameToken: "3333333333333333333333333333333333333333333",
        frameExpiresAt: Date.now() + 60 * 60 * 1000,
        manifest: { entrypoint: "new.html", bindings: [], capabilities: [] },
      });
    const client = {
      request,
      addEventListener: vi.fn(() => () => undefined),
    } as unknown as GatewayBrowserClient;
    state.loaded = true;
    state.activeSlug = "main";
    try {
      state.workspace = workspace(1);
      render(renderWorkspace({ host, client, connected: true }), host);
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => {
        render(renderWorkspace({ host, client, connected: true }), host);
        expect(host.querySelector("iframe")?.getAttribute("src")).toContain("old.html");
      });

      state.workspace = workspace(2);
      render(renderWorkspace({ host, client, connected: true }), host);
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => {
        render(renderWorkspace({ host, client, connected: true }), host);
        expect(host.querySelector("iframe")?.getAttribute("src")).toContain("new.html");
      });

      render(renderWorkspace({ host, client, connected: false }), host);
      render(renderWorkspace({ host, client, connected: true }), host);
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
      await vi.waitFor(() => {
        render(renderWorkspace({ host, client, connected: true }), host);
        expect(host.querySelector("iframe")?.getAttribute("src")).toContain(
          "3333333333333333333333333333333333333333333",
        );
      });
    } finally {
      stopWorkspace(host);
      host.remove();
    }
  });
});

describe("drag ghost (#4)", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("renders a snapped drop-target ghost while a drag is in flight", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const client = {
      request: vi.fn(async () => ({})),
      addEventListener: vi.fn(() => () => {}),
    } as unknown as GatewayBrowserClient;
    const state = getWorkspaceState(host);
    state.loaded = true;
    state.workspace = doc;
    state.activeSlug = "main";
    try {
      render(renderWorkspace({ host, client, connected: true }), host);
      const grid = host.querySelector<HTMLElement>(".workspace-grid");
      Object.defineProperty(grid, "clientWidth", { value: 720, configurable: true });
      // No ghost before a drag begins.
      expect(host.querySelector('[data-test-id="workspace-drag-ghost"]')).toBeNull();
      const bar = host.querySelector<HTMLElement>(".workspace-widget__bar");
      bar!.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
      );
      render(renderWorkspace({ host, client, connected: true }), host);
      // The ghost is present during the drag.
      expect(host.querySelector('[data-test-id="workspace-drag-ghost"]')).not.toBeNull();
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: 10, clientY: 10 }));
      render(renderWorkspace({ host, client, connected: true }), host);
      // Ghost gone once the drag settles.
      expect(host.querySelector('[data-test-id="workspace-drag-ghost"]')).toBeNull();
    } finally {
      stopWorkspace(host);
      host.remove();
    }
  });
});

describe("mid-drag tab-switch cancellation", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("cancels an in-flight drag on stopWorkspace so a later pointerup is a no-op", () => {
    // The host IS the render container so gridMetrics/pointer targets resolve.
    const host = document.createElement("div");
    document.body.append(host);
    const request = vi.fn(async (..._args: unknown[]) => ({}));
    const client = {
      request,
      addEventListener: vi.fn(() => () => {}),
    } as unknown as GatewayBrowserClient;
    const state = getWorkspaceState(host);
    state.loaded = true;
    state.workspace = doc;
    state.activeSlug = "main";
    render(renderWorkspace({ host, client, connected: true }), host);

    // Grid clientWidth is 0 in jsdom; stub a real width so the drag begins.
    const grid = host.querySelector<HTMLElement>(".workspace-grid");
    expect(grid).not.toBeNull();
    Object.defineProperty(grid, "clientWidth", { value: 720, configurable: true });

    // Track window pointer listeners added during the drag.
    const added = new Set<string>();
    const originalAdd = window.addEventListener.bind(window);
    const originalRemove = window.removeEventListener.bind(window);
    const addSpy = vi
      .spyOn(window, "addEventListener")
      .mockImplementation((type: string, ...rest: unknown[]) => {
        if (type === "pointermove" || type === "pointerup") {
          added.add(type);
        }
        return (originalAdd as (t: string, ...r: unknown[]) => void)(type, ...rest);
      });
    const removeSpy = vi
      .spyOn(window, "removeEventListener")
      .mockImplementation((type: string, ...rest: unknown[]) => {
        if (type === "pointermove" || type === "pointerup") {
          added.delete(type);
        }
        return (originalRemove as (t: string, ...r: unknown[]) => void)(type, ...rest);
      });

    try {
      const bar = host.querySelector<HTMLElement>(".workspace-widget__bar");
      expect(bar).not.toBeNull();
      bar!.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
      );
      // The drag registered its window listeners.
      expect(added.has("pointermove")).toBe(true);
      expect(added.has("pointerup")).toBe(true);

      // Operator switches tabs mid-drag → the bundled view's stop hook fires.
      stopWorkspace(host);

      // Listeners are gone…
      expect(added.has("pointermove")).toBe(false);
      expect(added.has("pointerup")).toBe(false);

      // …and a late pointerup does not resolve a move against the stale tab/client.
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: 400, clientY: 200 }));
      expect(request.mock.calls.some(([method]) => method === "workspaces.widget.move")).toBe(
        false,
      );
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
      host.remove();
    }
  });
});
