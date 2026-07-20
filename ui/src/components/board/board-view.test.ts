import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { BoardSnapshot, BoardWidget } from "../../lib/board/types.ts";
import type {
  BoardViewCallbacks,
  BoardViewSnapshot,
  BoardViewWidget,
} from "../../lib/board/view-types.ts";
import { applyBoardFixtureOps } from "../../test-helpers/board-fixture.ts";
import "./board-view.ts";

type OpenClawBoardView = HTMLElementTagNameMap["openclaw-board-view"];
type OpenClawBoardWidgetCell = HTMLElementTagNameMap["openclaw-board-widget-cell"];

function boardWidget(overrides: Partial<BoardWidget> = {}): BoardWidget {
  return {
    name: "alpha",
    tabId: "main",
    title: "Alpha status",
    contentKind: "html",
    sizeW: 6,
    sizeH: 4,
    position: 0,
    grantState: "none",
    revision: 1,
    ...overrides,
  };
}

function snapshot(overrides: Partial<BoardViewSnapshot> = {}): BoardViewSnapshot {
  return {
    sessionKey: "agent:main:test",
    revision: 1,
    tabs: [
      { tabId: "main", title: "Main", position: 0, chatDock: "right" },
      { tabId: "ops", title: "Operations", position: 1, chatDock: "bottom" },
    ],
    widgets: [
      boardWidget(),
      boardWidget({
        name: "beta",
        title: "Beta chart",
        sizeW: 6,
        position: 1,
        revision: 2,
      }),
      boardWidget({
        name: "ops-only",
        title: "Queue depth",
        tabId: "ops",
        sizeW: 12,
      }),
    ],
    ...overrides,
  };
}

function callbacks(overrides: Partial<BoardViewCallbacks> = {}): BoardViewCallbacks {
  return {
    applyOps: vi.fn(async () => undefined),
    grant: vi.fn(async () => undefined),
    selectTab: vi.fn(),
    ...overrides,
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function deferredValue<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function settleCells(view: OpenClawBoardView): Promise<OpenClawBoardWidgetCell[]> {
  await view.updateComplete;
  const cells = [...view.querySelectorAll("openclaw-board-widget-cell")];
  await Promise.all(cells.map((cell) => cell.updateComplete));
  return cells;
}

async function mount(
  options: {
    snapshot?: BoardViewSnapshot;
    activeTabId?: string;
    callbacks?: BoardViewCallbacks;
    widgetFrameUrl?: (name: string, revision: number) => string;
    sessions?: readonly GatewaySessionRow[];
  } = {},
): Promise<OpenClawBoardView> {
  const view = document.createElement("openclaw-board-view");
  view.snapshot = options.snapshot ?? snapshot();
  view.activeTabId = options.activeTabId ?? "main";
  view.widgetFrameUrl = options.widgetFrameUrl ?? (() => "about:blank");
  view.callbacks = options.callbacks ?? callbacks();
  view.sessions = options.sessions ?? [];
  document.body.append(view);
  await settleCells(view);
  return view;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("openclaw-board-view", () => {
  it("renders only the active tab widgets with sandboxed frames", async () => {
    const view = await mount();
    const cells = view.querySelectorAll('[data-test-id="board-widget"]');
    expect(cells).toHaveLength(2);
    expect([...cells].map((cell) => cell.getAttribute("data-widget-name"))).toEqual([
      "alpha",
      "beta",
    ]);
    const frames = view.querySelectorAll("iframe");
    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
      expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    }
  });

  it("renders the native swarm card without a frame or persisted widget controls", async () => {
    const swarm: BoardViewWidget = {
      name: "builtin:swarm",
      tabId: "builtin-swarm",
      title: "Swarm progress",
      contentKind: "builtin",
      builtin: "swarm",
      readOnly: true,
      sizeW: 12,
      sizeH: 4,
      position: 0,
      grantState: "granted",
      revision: 1,
    };
    const source = snapshot({
      sessionKey: "agent:main:parent",
      tabs: [{ tabId: "builtin-swarm", title: "Swarm progress", position: 0, chatDock: "right" }],
      widgets: [swarm],
    });
    const view = await mount({
      snapshot: source,
      activeTabId: "builtin-swarm",
      sessions: [
        {
          key: "agent:main:child",
          kind: "direct",
          updatedAt: 1,
          parentSessionKey: "agent:main:parent",
          swarmGroupId: "swarm:agent:main:parent:turn-42",
          label: "Worker A",
          status: "running",
        },
      ],
    });

    expect(view.querySelector("[data-test-id=swarm-widget]")).not.toBeNull();
    expect(view.querySelector("iframe")).toBeNull();
    expect(view.querySelector(".board-widget__menu")).toBeNull();
    expect(view.querySelector(".board-widget__resize-handle")).toBeNull();
  });

  it("requests a fresh frame ticket after iframe errors or 401 loads", async () => {
    const frameLoadFailed = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async () => new Response("expired", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const view = await mount({
      callbacks: callbacks({ frameLoadFailed }),
      snapshot: snapshot({ widgets: [boardWidget()] }),
      widgetFrameUrl: () => "/__openclaw__/board/session/status/index.html?bt=expired",
    });
    const frame = view.querySelector("iframe");

    frame?.dispatchEvent(new Event("error"));
    await vi.waitFor(() => expect(frameLoadFailed).toHaveBeenCalledTimes(1));
    frame?.dispatchEvent(new Event("load"));
    await vi.waitFor(() => expect(frameLoadFailed).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenCalledWith(
      "/__openclaw__/board/session/status/index.html?bt=expired",
      { cache: "no-store" },
    );
  });

  it("bounds repeated frame ticket refreshes after persistent 401 responses", async () => {
    const frameLoadFailed = vi.fn(async () => undefined);
    let frameStatus = 401;
    let frameUrl = "/__openclaw__/board/session/status/index.html?bt=expired";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(frameStatus === 401 ? "expired" : "ok", { status: frameStatus }),
      ),
    );
    const view = await mount({
      callbacks: callbacks({ frameLoadFailed }),
      snapshot: snapshot({ widgets: [boardWidget()] }),
      widgetFrameUrl: () => frameUrl,
    });
    const frame = view.querySelector("iframe");

    for (let attempt = 0; attempt < 4; attempt += 1) {
      frame?.dispatchEvent(new Event("load"));
      await Promise.resolve();
    }

    await vi.waitFor(() => expect(frameLoadFailed).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expect(view.querySelector('[data-test-id="board-widget-error"]')?.textContent).toContain(
        "repeated refresh attempts",
      ),
    );

    frameStatus = 200;
    frameUrl = "/__openclaw__/board/session/status/index.html?bt=fresh";
    view.snapshot = snapshot({ revision: 2, widgets: [boardWidget()] });
    await settleCells(view);
    const freshFrame = view.querySelector("iframe");
    expect(freshFrame?.getAttribute("src")).toBe(frameUrl);
    freshFrame?.dispatchEvent(new Event("load"));
    await vi.waitFor(() => expect(view.querySelector("iframe")).toBe(freshFrame));
    expect(frameLoadFailed).toHaveBeenCalledTimes(3);
  });

  it("ignores authorization results from a superseded widget frame", async () => {
    const frameLoadFailed = vi.fn(async () => undefined);
    let resolveProbe: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveProbe = resolve;
          }),
      ),
    );
    const view = await mount({
      callbacks: callbacks({ frameLoadFailed }),
      snapshot: snapshot({ widgets: [boardWidget()] }),
      widgetFrameUrl: (_name, revision) =>
        `/__openclaw__/board/session/status/index.html?revision=${revision}`,
    });
    const frame = view.querySelector("iframe");
    frame?.dispatchEvent(new Event("load"));

    view.snapshot = snapshot({
      revision: 2,
      widgets: [boardWidget({ revision: 2 })],
    });
    await settleCells(view);
    expect(frame?.getAttribute("src")).toContain("revision=2");
    resolveProbe?.(new Response("expired", { status: 401 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(frameLoadFailed).not.toHaveBeenCalled();
  });

  it("preserves each widget cell and iframe identity when order changes", async () => {
    const view = await mount();
    const before = [...view.querySelectorAll("openclaw-board-widget-cell")].find(
      (cell) => cell.widget?.name === "alpha",
    );
    const frame = before?.querySelector("iframe");
    const removedNodes: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        removedNodes.push(...record.removedNodes);
      }
    });
    observer.observe(view.querySelector(".board-grid")!, { childList: true });
    const reordered = snapshot();
    reordered.widgets = reordered.widgets.map((widget) =>
      widget.name === "alpha"
        ? { ...widget, position: 1 }
        : widget.name === "beta"
          ? { ...widget, position: 0 }
          : widget,
    );
    view.snapshot = reordered;
    const cells = await settleCells(view);
    const after = cells.find((cell) => cell.widget?.name === "alpha");
    expect(after).toBe(before);
    expect(after?.querySelector("iframe")).toBe(frame);
    expect(removedNodes).not.toContain(before);
    expect(after?.querySelector(".board-widget")?.getAttribute("aria-posinset")).toBe("2");
    expect(
      cells
        .find((cell) => cell.widget?.name === "beta")
        ?.querySelector(".board-widget")
        ?.getAttribute("aria-posinset"),
    ).toBe("1");
    observer.disconnect();

    view.snapshot = { ...snapshot(), sessionKey: "agent:main:other-session" };
    const sessionCells = await settleCells(view);
    const afterSessionChange = sessionCells.find((cell) => cell.widget?.name === "alpha");
    expect(afterSessionChange).not.toBe(before);
    expect(afterSessionChange?.querySelector("iframe")).not.toBe(frame);
  });

  it("routes tab selection and updates cells when the host changes the active prop", async () => {
    const selectTab = vi.fn();
    const view = await mount({ callbacks: callbacks({ selectTab }) });
    expect(selectTab).not.toHaveBeenCalled();
    view.querySelector(".board-tabs__track")?.dispatchEvent(
      new CustomEvent("wa-tab-show", {
        detail: { name: "ops" },
        bubbles: true,
      }),
    );
    expect(selectTab).toHaveBeenCalledWith("ops");

    view.activeTabId = "ops";
    const cells = await settleCells(view);
    expect(cells).toHaveLength(1);
    expect(cells[0]?.widget?.name).toBe("ops-only");
  });

  it("hides the tab strip when the board has only one tab", async () => {
    const source = snapshot();
    source.tabs = source.tabs.slice(0, 1);
    source.widgets = source.widgets.filter((widget) => widget.tabId === "main");
    const view = await mount({ snapshot: source });
    expect(view.querySelector(".board-tabs")).toBeNull();
  });

  it("calls applyOps from the kebab remove action", async () => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount({ callbacks: callbacks({ applyOps }) });
    const firstCell = view.querySelector("openclaw-board-widget-cell");
    firstCell?.querySelector<HTMLButtonElement>(".board-widget__menu-danger")?.click();
    await vi.waitFor(() => {
      expect(applyOps).toHaveBeenCalledWith([{ kind: "widget_remove", name: "alpha" }]);
    });
  });

  it("shows failed host operations in the board and originating cell", async () => {
    const applyOps = vi.fn(async () => {
      throw new Error("fixture write failed");
    });
    const view = await mount({ callbacks: callbacks({ applyOps }) });
    const frame = view.querySelector("iframe");
    view.querySelector<HTMLButtonElement>(".board-widget__menu-danger")?.click();
    await vi.waitFor(() => {
      expect(view.querySelector(".board-view__error")?.textContent).toContain("could not be saved");
      expect(
        view.querySelector('[data-test-id="board-widget-action-error"]')?.textContent,
      ).toContain("fixture write failed");
    });
    expect(view.querySelector("iframe")).toBe(frame);
    view.snapshot = { ...snapshot(), revision: 2 };
    await settleCells(view);
    expect(view.querySelector(".board-view__error")).toBeNull();
  });

  it("allows only one snapshot-derived board mutation at a time", async () => {
    const pending = deferred();
    const applyOps = vi.fn(() => pending.promise);
    const view = await mount({ callbacks: callbacks({ applyOps }) });
    const cells = [...view.querySelectorAll("openclaw-board-widget-cell")];
    cells[0]?.querySelector<HTMLButtonElement>(".board-widget__menu-danger")?.click();
    await vi.waitFor(() => expect(applyOps).toHaveBeenCalledTimes(1));
    await settleCells(view);
    const secondRemove = cells[1]?.querySelector<HTMLButtonElement>(".board-widget__menu-danger");
    expect(secondRemove?.disabled).toBe(true);
    secondRemove?.click();
    expect(applyOps).toHaveBeenCalledTimes(1);
    pending.resolve();
    await vi.waitFor(() => expect(secondRemove?.disabled).toBe(false));
  });

  it("ignores a late operation failure after switching sessions", async () => {
    const pending = deferred();
    const applyOps = vi.fn(() => pending.promise);
    const view = await mount({ callbacks: callbacks({ applyOps }) });
    view.querySelector<HTMLButtonElement>(".board-widget__menu-danger")?.click();
    await vi.waitFor(() => expect(applyOps).toHaveBeenCalledTimes(1));
    view.snapshot = { ...snapshot(), sessionKey: "agent:main:new-session" };
    await settleCells(view);
    pending.reject(new Error("old session failed"));
    await Promise.resolve();
    await Promise.resolve();
    expect(view.querySelector(".board-view__error")).toBeNull();
    expect(view.querySelector(".board-announcer")?.textContent?.trim()).toBe("");
  });

  it("renders pending approval without an iframe and routes both decisions", async () => {
    const grant = vi.fn(async () => undefined);
    const source = snapshot({
      widgets: [boardWidget({ grantState: "pending" })],
    });
    const view = await mount({ snapshot: source, callbacks: callbacks({ grant }) });
    expect(view.querySelector('[data-test-id="board-pending"]')).not.toBeNull();
    expect(view.querySelector("iframe")).toBeNull();

    const allow = view.querySelector<HTMLButtonElement>('[data-test-id="board-grant-allow"]');
    const reject = view.querySelector<HTMLButtonElement>('[data-test-id="board-grant-reject"]');
    allow?.click();
    await vi.waitFor(() => expect(grant).toHaveBeenCalledWith("alpha", "granted"));
    await vi.waitFor(() => expect(reject?.disabled).toBe(false));
    reject?.click();
    await vi.waitFor(() => expect(grant).toHaveBeenCalledWith("alpha", "rejected"));
  });

  it("renders MCP App widgets through the bridge element while approval is pending", async () => {
    if (!customElements.get("mcp-app-view")) {
      customElements.define("mcp-app-view", class extends HTMLElement {});
    }
    const widgetAppView = vi.fn(async () => ({
      status: "ready" as const,
      viewId: "mcp-app-board",
      expiresAtMs: Date.now() + 60_000,
    }));
    const refreshWidgetAppView = vi.fn(async () => ({
      status: "ready" as const,
      viewId: "mcp-app-renewed",
      expiresAtMs: Date.now() + 60_000,
    }));
    const source = snapshot({
      sessionKey: "agent:main:main",
      widgets: [boardWidget({ contentKind: "mcp-app", grantState: "pending" })],
    });
    const view = await mount({
      snapshot: source,
      callbacks: callbacks({ widgetAppView, refreshWidgetAppView }),
    });

    await vi.waitFor(() => expect(view.querySelector("mcp-app-view")).not.toBeNull());
    const app = view.querySelector<HTMLElement & { sessionKey: string; viewId: string }>(
      "mcp-app-view",
    );
    expect(app?.sessionKey).toBe("agent:main:main");
    expect(app?.viewId).toBe("mcp-app-board");
    expect(view.querySelector('[data-test-id="board-pending"]')).not.toBeNull();
    expect(view.querySelector("iframe")).toBeNull();
    app?.dispatchEvent(
      new CustomEvent("openclaw-mcp-app-view-expired", { bubbles: true, composed: true }),
    );
    await vi.waitFor(() =>
      expect(view.querySelector<HTMLElement & { viewId: string }>("mcp-app-view")?.viewId).toBe(
        "mcp-app-renewed",
      ),
    );
    expect(refreshWidgetAppView).toHaveBeenCalledWith("alpha", 1);
  });

  it("renews a mounted MCP App lease before it expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    if (!customElements.get("mcp-app-view")) {
      customElements.define("mcp-app-view", class extends HTMLElement {});
    }
    const widgetAppView = vi.fn(async () => ({
      status: "ready" as const,
      viewId: "mcp-app-board",
      expiresAtMs: 11_000,
    }));
    const refreshWidgetAppView = vi.fn(async () => ({
      status: "ready" as const,
      viewId: "mcp-app-renewed",
      expiresAtMs: 71_000,
    }));
    const source = snapshot({ widgets: [boardWidget({ contentKind: "mcp-app" })] });
    const view = await mount({
      snapshot: source,
      callbacks: callbacks({ widgetAppView, refreshWidgetAppView }),
    });
    await vi.advanceTimersByTimeAsync(0);
    await settleCells(view);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(refreshWidgetAppView).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settleCells(view);

    expect(refreshWidgetAppView).toHaveBeenCalledWith("alpha", 1);
    expect(view.querySelector<HTMLElement & { viewId: string }>("mcp-app-view")?.viewId).toBe(
      "mcp-app-renewed",
    );
    view.remove();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshWidgetAppView).toHaveBeenCalledTimes(1);
  });

  it("refreshes a near-expiry lease only once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const widgetAppView = vi.fn(async () => ({
      status: "ready" as const,
      viewId: "mcp-app-near-expiry",
      expiresAtMs: 5_000,
    }));
    const refreshWidgetAppView = vi.fn(async () => ({
      status: "ready" as const,
      viewId: "mcp-app-renewed",
      expiresAtMs: 5_000,
    }));
    const source = snapshot({ widgets: [boardWidget({ contentKind: "mcp-app" })] });
    const view = await mount({
      snapshot: source,
      callbacks: callbacks({ widgetAppView, refreshWidgetAppView }),
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(refreshWidgetAppView).toHaveBeenCalledOnce();
    view.remove();
  });

  it("does not schedule renewal when an in-flight MCP App load resolves after disconnect", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const pending = deferredValue<{
      status: "ready";
      viewId: string;
      expiresAtMs: number;
    }>();
    const widgetAppView = vi.fn(() => pending.promise);
    const refreshWidgetAppView = vi.fn(async () => ({
      status: "ready" as const,
      viewId: "mcp-app-renewed",
      expiresAtMs: 71_000,
    }));
    const source = snapshot({ widgets: [boardWidget({ contentKind: "mcp-app" })] });
    const view = await mount({
      snapshot: source,
      callbacks: callbacks({ widgetAppView, refreshWidgetAppView }),
    });
    expect(widgetAppView).toHaveBeenCalledWith("alpha", 1);

    view.remove();
    pending.resolve({ status: "ready", viewId: "late-view", expiresAtMs: 11_000 });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(refreshWidgetAppView).not.toHaveBeenCalled();
  });

  it("shows stale MCP Apps with retry and remove without breaking the board", async () => {
    if (!customElements.get("mcp-app-view")) {
      customElements.define("mcp-app-view", class extends HTMLElement {});
    }
    const widgetAppView = vi.fn(async () => ({
      status: "stale" as const,
      error: "origin transcript pruned",
    }));
    const refreshWidgetAppView = vi.fn(async () => ({
      status: "ready" as const,
      viewId: "mcp-app-retried",
      expiresAtMs: Date.now() + 60_000,
    }));
    const applyOps = vi.fn(async () => undefined);
    const source = snapshot({ widgets: [boardWidget({ contentKind: "mcp-app" })] });
    const view = await mount({
      snapshot: source,
      callbacks: callbacks({ applyOps, widgetAppView, refreshWidgetAppView }),
    });

    await vi.waitFor(() =>
      expect(view.querySelector('[data-test-id="board-mcp-app-stale"]')).not.toBeNull(),
    );
    const buttons = view.querySelectorAll<HTMLButtonElement>(
      '[data-test-id="board-mcp-app-stale"] button',
    );
    expect([...buttons].map((button) => button.textContent?.trim())).toEqual(["Retry", "Remove"]);
    buttons[1]?.click();
    await vi.waitFor(() =>
      expect(applyOps).toHaveBeenCalledWith([{ kind: "widget_remove", name: "alpha" }]),
    );
    buttons[0]?.click();
    await vi.waitFor(() =>
      expect(view.querySelector<HTMLElement & { viewId: string }>("mcp-app-view")?.viewId).toBe(
        "mcp-app-retried",
      ),
    );
    expect(refreshWidgetAppView).toHaveBeenCalledWith("alpha", 1);
  });

  it("renders declared approval details instead of the generic copy", async () => {
    const source = snapshot({
      widgets: [
        boardWidget({
          grantState: "pending",
          declaredSummary: ["Network: api.example.com", "Tools: lookup"],
        }),
      ],
    });
    const view = await mount({ snapshot: source });
    const pending = view.querySelector('[data-test-id="board-pending"]');

    expect(pending?.querySelectorAll(".board-widget__grant-summary li")).toHaveLength(2);
    expect(pending?.textContent).toContain("Network: api.example.com");
    expect(pending?.textContent).not.toContain("This widget requested additional access.");
  });

  it("serializes pending approval decisions while the callback is in flight", async () => {
    let finishGrant: (() => void) | undefined;
    const grant = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          finishGrant = resolve;
        }),
    );
    const source = snapshot({ widgets: [boardWidget({ grantState: "pending" })] });
    const view = await mount({ snapshot: source, callbacks: callbacks({ grant }) });
    const allow = view.querySelector<HTMLButtonElement>('[data-test-id="board-grant-allow"]');
    const reject = view.querySelector<HTMLButtonElement>('[data-test-id="board-grant-reject"]');
    allow?.click();
    reject?.click();
    expect(grant).toHaveBeenCalledTimes(1);
    const cell = view.querySelector("openclaw-board-widget-cell");
    await cell?.updateComplete;
    expect(allow?.disabled).toBe(true);
    expect(reject?.disabled).toBe(true);
    finishGrant?.();
    await vi.waitFor(() => expect(allow?.disabled).toBe(false));
  });

  it("keeps approval controls after a failed decision and clears the error on refresh", async () => {
    const grant = vi.fn(async () => {
      throw new Error("approval service unavailable");
    });
    const source = snapshot({ widgets: [boardWidget({ grantState: "pending" })] });
    const view = await mount({ snapshot: source, callbacks: callbacks({ grant }) });
    view.querySelector<HTMLButtonElement>('[data-test-id="board-grant-allow"]')?.click();
    await vi.waitFor(() => {
      expect(
        view.querySelector('[data-test-id="board-widget-action-error"]')?.textContent,
      ).toContain("approval service unavailable");
    });
    expect(view.querySelector('[data-test-id="board-grant-allow"]')).not.toBeNull();
    expect(view.querySelector('[data-test-id="board-grant-reject"]')).not.toBeNull();

    view.snapshot = structuredClone({ ...source, revision: source.revision + 1 });
    await settleCells(view);
    expect(view.querySelector('[data-test-id="board-widget-action-error"]')).toBeNull();
  });

  it("keeps a rejected widget inert and removable", async () => {
    const applyOps = vi.fn(async () => undefined);
    const source = snapshot({ widgets: [boardWidget({ grantState: "rejected" })] });
    const view = await mount({ snapshot: source, callbacks: callbacks({ applyOps }) });
    expect(view.querySelector('[data-test-id="board-rejected"]')).not.toBeNull();
    expect(view.querySelector("iframe")).toBeNull();
    view.querySelector<HTMLButtonElement>('[data-test-id="board-rejected"] button')?.click();
    await vi.waitFor(() =>
      expect(applyOps).toHaveBeenCalledWith([{ kind: "widget_remove", name: "alpha" }]),
    );
  });

  it("contains one resolver throw without breaking sibling cells", async () => {
    const view = await mount({
      widgetFrameUrl: (name) => {
        if (name === "alpha") {
          throw new Error("fixture resolver failed");
        }
        return "about:blank";
      },
    });
    const cells = view.querySelectorAll('[data-test-id="board-widget"]');
    expect(cells).toHaveLength(2);
    expect(view.querySelector('[data-test-id="board-widget-error"]')?.textContent).toContain(
      "fixture resolver failed",
    );
    expect(view.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("renders the friendly empty state", async () => {
    const view = await mount({ snapshot: snapshot({ widgets: [] }) });
    expect(view.querySelector('[data-test-id="board-empty"]')?.textContent).toContain(
      "Your agent can pin widgets here",
    );
  });

  it("keeps cell focus order stable and exposes move, resize, and menu labels", async () => {
    const view = await mount();
    const cells = [...view.querySelectorAll<HTMLElement>('[data-test-id="board-widget"]')];
    expect(cells.map((cell) => cell.getAttribute("tabindex"))).toEqual(["0", "-1"]);
    expect(cells.map((cell) => cell.getAttribute("aria-posinset"))).toEqual(["1", "2"]);
    expect(cells.map((cell) => cell.getAttribute("data-widget-name"))).toEqual(["alpha", "beta"]);
    for (const cell of cells) {
      expect(cell.getAttribute("aria-label")).toContain("Dashboard widget");
      expect(cell.querySelector(".board-widget__drag-handle")?.getAttribute("title")).toMatch(
        /^Move /u,
      );
      expect(cell.querySelector(".board-widget__drag-handle")?.getAttribute("tabindex")).toBeNull();
      expect(cell.querySelector(".board-widget__resize-handle")?.getAttribute("title")).toMatch(
        /^Resize /u,
      );
      expect(
        cell.querySelector(".board-widget__resize-handle")?.getAttribute("tabindex"),
      ).toBeNull();
      expect(cell.querySelector(".board-widget__menu-trigger")?.getAttribute("aria-label")).toBe(
        "Widget options",
      );
    }

    cells[0]?.focus();
    cells[0]?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      }),
    );
    await vi.waitFor(() => expect(document.activeElement).toBe(cells[1]));
    await vi.waitFor(() => expect(cells[1]?.getAttribute("tabindex")).toBe("0"));
  });

  it("uses Alt+Arrow as the keyboard reorder fallback and announces the move", async () => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount({ callbacks: callbacks({ applyOps }) });
    const secondCell = view.querySelectorAll<HTMLElement>('[data-test-id="board-widget"]')[1];
    secondCell?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowLeft",
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await vi.waitFor(() =>
      expect(applyOps).toHaveBeenCalledWith([{ kind: "widget_move", name: "beta", position: 0 }]),
    );
    await vi.waitFor(() =>
      expect(view.querySelector(".board-announcer")?.textContent).toContain("Moved Beta chart"),
    );
  });

  it("replaces live-region content for repeated identical announcements", async () => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount({ callbacks: callbacks({ applyOps }) });
    const secondCell = view.querySelectorAll<HTMLElement>('[data-test-id="board-widget"]')[1];
    const move = () =>
      secondCell?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowLeft",
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

    move();
    await vi.waitFor(() => expect(applyOps).toHaveBeenCalledTimes(1));
    await view.updateComplete;
    const firstAnnouncement = view.querySelector(".board-announcer > span");
    const cell = secondCell?.closest("openclaw-board-widget-cell");
    await vi.waitFor(() => expect(Reflect.get(cell ?? {}, "actionPending")).toBe(false));

    move();
    await vi.waitFor(() => expect(applyOps).toHaveBeenCalledTimes(2));
    await view.updateComplete;
    expect(view.querySelector(".board-announcer > span")).not.toBe(firstAnnouncement);
  });

  it("leaves arrow keys from nested widget controls untouched", async () => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount({ callbacks: callbacks({ applyOps }) });
    const menuButton = view.querySelector<HTMLButtonElement>(".board-widget__menu-danger");
    menuButton?.focus();
    menuButton?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await Promise.resolve();
    expect(document.activeElement).toBe(menuButton);
    expect(applyOps).not.toHaveBeenCalled();
  });

  it("moves widgets to another tab from the kebab menu", async () => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount({ callbacks: callbacks({ applyOps }) });
    const moveButton = [...view.querySelectorAll<HTMLElement>("wa-dropdown-item")].find(
      (button) => button.textContent?.trim() === "Operations",
    );
    view.querySelector(".board-widget__menu")?.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: moveButton },
        bubbles: true,
      }),
    );
    await vi.waitFor(() =>
      expect(applyOps).toHaveBeenCalledWith([
        { kind: "widget_move", name: "alpha", tabId: "ops", position: 1 },
      ]),
    );
  });

  it("places excess tabs in an accessible overflow menu", async () => {
    const source = snapshot({
      tabs: Array.from({ length: 8 }, (_entry, position) => ({
        tabId: `tab-${position}`,
        title: `Tab ${position}`,
        position,
        chatDock: "right" as const,
      })),
      widgets: [],
    });
    const selectTab = vi.fn();
    const view = await mount({
      snapshot: source,
      activeTabId: "tab-7",
      callbacks: callbacks({ selectTab }),
    });
    expect(view.querySelector(".board-tabs__overflow-trigger")?.getAttribute("aria-label")).toBe(
      "More dashboard tabs",
    );
    expect(view.querySelectorAll(".board-tabs__overflow > wa-dropdown-item")).toHaveLength(2);
    const firstOverflowTab = view.querySelector(".board-tabs__overflow > wa-dropdown-item");
    view.querySelector(".board-tabs__overflow")?.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: firstOverflowTab },
        bubbles: true,
      }),
    );
    expect(selectTab).toHaveBeenCalledWith(firstOverflowTab?.getAttribute("value"));
  });

  it("applies mock moves as insertion and shifts sibling positions", () => {
    const moved = applyBoardFixtureOps(snapshot() as BoardSnapshot, [
      { kind: "widget_move", name: "beta", position: 0 },
    ]);
    expect(
      moved.widgets
        .filter((widget) => widget.tabId === "main")
        .toSorted((left, right) => left.position - right.position)
        .map((widget) => `${widget.name}:${widget.position}`),
    ).toEqual(["beta:0", "alpha:1"]);
  });
});
