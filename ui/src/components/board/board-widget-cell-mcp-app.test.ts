import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardWidgetAppViewState, BoardViewWidget } from "../../lib/board/view-types.ts";
import type { BoardWidgetCellCallbacks } from "./board-widget-cell.ts";
import "./board-widget-cell.ts";

class TestMcpAppView extends HTMLElement {
  sessionKey = "";
  viewId = "";
  height = 0;
  fixedHeight = false;
  override title = "";
}

if (!customElements.get("mcp-app-view")) {
  customElements.define("mcp-app-view", TestMcpAppView);
}

type BoardWidgetCell = HTMLElementTagNameMap["openclaw-board-widget-cell"];

function widget(overrides: Partial<BoardViewWidget> = {}): BoardViewWidget {
  return {
    name: "alpha",
    tabId: "main",
    title: "Alpha app",
    contentKind: "mcp-app",
    sizeW: 6,
    sizeH: 4,
    position: 0,
    grantState: "none",
    revision: 1,
    instanceId: "alpha-instance",
    ...overrides,
  } as BoardViewWidget;
}

function callbacks(overrides: Partial<BoardWidgetCellCallbacks> = {}): BoardWidgetCellCallbacks {
  const noAction = vi.fn(async () => undefined);
  return {
    grant: noAction,
    movePointerDown: vi.fn(),
    resizePointerDown: vi.fn(),
    moveToTab: noAction,
    resizeTo: noAction,
    setHeightMode: noAction,
    reportContentHeight: vi.fn(),
    remove: noAction,
    nudge: noAction,
    focus: vi.fn(),
    focusChanged: vi.fn(),
    frameLoadFailed: noAction,
    widgetAppView: vi.fn(async () => ({
      status: "ready" as const,
      viewId: "initial-view",
      expiresAtMs: Date.now() + 60_000,
    })),
    refreshWidgetAppView: vi.fn(async () => ({
      status: "ready" as const,
      viewId: "renewed-view",
      expiresAtMs: Date.now() + 60_000,
    })),
    ...overrides,
  };
}

async function mount(
  currentWidget: BoardViewWidget,
  currentCallbacks: BoardWidgetCellCallbacks,
): Promise<BoardWidgetCell> {
  const cell = document.createElement("openclaw-board-widget-cell");
  cell.widget = currentWidget;
  cell.rect = { name: currentWidget.name, x: 0, y: 0, w: 6, h: currentWidget.sizeH };
  cell.sessionKey = "agent:main:test";
  cell.callbacks = currentCallbacks;
  document.body.append(cell);
  await settle(cell);
  return cell;
}

async function settle(cell: BoardWidgetCell): Promise<void> {
  await Promise.resolve();
  await cell.updateComplete;
  await Promise.resolve();
  await cell.updateComplete;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function stubVisibility(visible: (index: number) => boolean): {
  disconnect: ReturnType<typeof vi.fn>;
  observed: () => number;
} {
  let observed = 0;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        const isIntersecting = visible(observed);
        observed += 1;
        vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
          bottom: isIntersecting ? 200 : 5_200,
          top: isIntersecting ? 0 : 5_000,
        } as DOMRect);
        this.callback([{ isIntersecting, target } as IntersectionObserverEntry], this as never);
      }
      disconnect = disconnect;
      unobserve() {}
      takeRecords() {
        return [];
      }
    },
  );
  return { disconnect, observed: () => observed };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("board MCP App cell lifecycle", () => {
  it("uses the board height as fixed AppBridge host context", async () => {
    const cell = await mount(
      widget({ grantState: "pending" }),
      callbacks({
        widgetAppView: vi.fn(async () => ({
          status: "ready" as const,
          viewId: "fixed-view",
          expiresAtMs: Date.now() + 60_000,
        })),
      }),
    );
    await vi.waitFor(() => expect(cell.querySelector("mcp-app-view")).not.toBeNull());

    expect(cell.querySelector("mcp-app-view") as TestMcpAppView).toMatchObject({
      fixedHeight: true,
      height: 160,
      sessionKey: "agent:main:test",
      viewId: "fixed-view",
    });
    expect(cell.querySelector('[data-test-id="board-pending"]')).not.toBeNull();

    cell.widget = widget({ grantState: "granted" });
    await settle(cell);
    await vi.waitFor(() =>
      expect((cell.querySelector("mcp-app-view") as TestMcpAppView | null)?.height).toBe(222),
    );
    expect(cell.querySelector('[data-test-id="board-pending"]')).toBeNull();
  });

  it("treats the bridge expiry event as authoritative", async () => {
    const refreshWidgetAppView = vi.fn(async () => ({
      status: "stale" as const,
      error: "lease rejected",
    }));
    const cell = await mount(widget(), callbacks({ refreshWidgetAppView }));
    await vi.waitFor(() => expect(cell.querySelector("mcp-app-view")).not.toBeNull());

    cell
      .querySelector("mcp-app-view")
      ?.dispatchEvent(
        new CustomEvent("openclaw-mcp-app-view-expired", { bubbles: true, composed: true }),
      );
    await settle(cell);

    expect(cell.querySelector("mcp-app-view")).toBeNull();
    expect(cell.querySelector('[data-test-id="board-mcp-app-stale"]')).not.toBeNull();
  });

  it("keeps a short renewed lease until expiry without another refresh loop", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const refreshWidgetAppView = vi.fn(async () => ({
      status: "ready" as const,
      viewId: "short-renewed-view",
      expiresAtMs: 5_000,
    }));
    const cell = await mount(
      widget(),
      callbacks({
        widgetAppView: vi.fn(async () => ({
          status: "ready" as const,
          viewId: "near-expiry-view",
          expiresAtMs: 5_000,
        })),
        refreshWidgetAppView,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await settle(cell);

    expect(refreshWidgetAppView).toHaveBeenCalledOnce();
    expect(cell.querySelector("mcp-app-view")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(4_000);
    await settle(cell);

    expect(cell.querySelector('[data-test-id="board-mcp-app-stale"]')).not.toBeNull();
    expect(refreshWidgetAppView).toHaveBeenCalledOnce();
  });

  it("cleans up visibility when an MCP App cell becomes HTML", async () => {
    const visibility = stubVisibility(() => true);
    const widgetAppView = vi.fn(async () => ({
      status: "ready" as const,
      viewId: "converted-view",
      expiresAtMs: Date.now() + 60_000,
    }));
    const currentCallbacks = callbacks({ widgetAppView });
    const cell = await mount(widget({ contentKind: "html" }), currentCallbacks);

    cell.widget = widget();
    await settle(cell);
    await vi.waitFor(() => expect(widgetAppView).toHaveBeenCalledOnce());
    expect(visibility.observed()).toBe(1);

    cell.widget = widget({ contentKind: "html" });
    await settle(cell);
    expect(visibility.disconnect).toHaveBeenCalledOnce();
    expect(widgetAppView).toHaveBeenCalledOnce();
  });

  it("recovers when a slow renewal finishes after the expiry watchdog", async () => {
    vi.useFakeTimers({ now: 10_000 });
    const remint = deferred<BoardWidgetAppViewState>();
    const refreshWidgetAppView = vi.fn(() => remint.promise);
    const cell = await mount(
      widget(),
      callbacks({
        widgetAppView: vi.fn(async () => ({
          status: "ready" as const,
          viewId: "short-view",
          expiresAtMs: 11_000,
        })),
        refreshWidgetAppView,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await settle(cell);
    expect(refreshWidgetAppView).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    await settle(cell);
    expect(cell.querySelector('[data-test-id="board-mcp-app-stale"]')).not.toBeNull();

    remint.resolve({ status: "ready" as const, viewId: "late-view", expiresAtMs: 30_000 });
    await settle(cell);
    expect((cell.querySelector("mcp-app-view") as TestMcpAppView | null)?.viewId).toBe("late-view");
  });

  it("keeps a valid lease mounted when proactive renewal fails", async () => {
    vi.useFakeTimers({ now: 10_000 });
    const cell = await mount(
      widget(),
      callbacks({
        widgetAppView: vi.fn(async () => ({
          status: "ready" as const,
          viewId: "still-valid-view",
          expiresAtMs: 20_000,
        })),
        refreshWidgetAppView: vi.fn(async () => ({
          status: "stale" as const,
          error: "temporary gateway failure",
        })),
      }),
    );

    await vi.advanceTimersByTimeAsync(5_000);
    await settle(cell);
    expect((cell.querySelector("mcp-app-view") as TestMcpAppView | null)?.viewId).toBe(
      "still-valid-view",
    );

    await vi.advanceTimersByTimeAsync(5_000);
    await settle(cell);
    expect(cell.querySelector('[data-test-id="board-mcp-app-stale"]')).not.toBeNull();
  });

  it("keeps the expiry watchdog when a renewing app moves offscreen", async () => {
    vi.useFakeTimers({ now: 10_000 });
    let visible = true;
    let emitVisibility: () => void = () => undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(private readonly callback: IntersectionObserverCallback) {}
        observe(target: Element) {
          vi.spyOn(target, "getBoundingClientRect").mockImplementation(
            () => ({ bottom: visible ? 200 : 5_200, top: visible ? 0 : 5_000 }) as DOMRect,
          );
          emitVisibility = () =>
            this.callback(
              [{ isIntersecting: visible, target } as IntersectionObserverEntry],
              this as never,
            );
          emitVisibility();
        }
        disconnect() {}
        unobserve() {}
        takeRecords() {
          return [];
        }
      },
    );
    const remint = deferred<BoardWidgetAppViewState>();
    const refreshWidgetAppView = vi.fn(() => remint.promise);
    const cell = await mount(
      widget(),
      callbacks({
        widgetAppView: vi.fn(async () => ({
          status: "ready" as const,
          viewId: "short-view",
          expiresAtMs: 11_000,
        })),
        refreshWidgetAppView,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await settle(cell);

    visible = false;
    emitVisibility();
    await settle(cell);
    await vi.advanceTimersByTimeAsync(1_000);
    visible = true;
    emitVisibility();
    await settle(cell);

    expect(refreshWidgetAppView).toHaveBeenCalledOnce();
    expect(cell.querySelector('[data-test-id="board-mcp-app-stale"]')).not.toBeNull();
  });

  it("does not remint a short renewed lease when it returns onscreen", async () => {
    vi.useFakeTimers({ now: 10_000 });
    let visible = true;
    let emitVisibility: () => void = () => undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(private readonly callback: IntersectionObserverCallback) {}
        observe(target: Element) {
          vi.spyOn(target, "getBoundingClientRect").mockImplementation(
            () => ({ bottom: visible ? 200 : 5_200, top: visible ? 0 : 5_000 }) as DOMRect,
          );
          emitVisibility = () =>
            this.callback(
              [{ isIntersecting: visible, target } as IntersectionObserverEntry],
              this as never,
            );
          emitVisibility();
        }
        disconnect() {}
        unobserve() {}
        takeRecords() {
          return [];
        }
      },
    );
    const remint = deferred<BoardWidgetAppViewState>();
    const refreshWidgetAppView = vi.fn(() => remint.promise);
    const cell = await mount(
      widget(),
      callbacks({
        widgetAppView: vi.fn(async () => ({
          status: "ready" as const,
          viewId: "first-view",
          expiresAtMs: 20_000,
        })),
        refreshWidgetAppView,
      }),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    visible = false;
    emitVisibility();
    remint.resolve({ status: "ready" as const, viewId: "short-renewed", expiresAtMs: 18_000 });
    await settle(cell);

    visible = true;
    emitVisibility();
    await settle(cell);
    expect(refreshWidgetAppView).toHaveBeenCalledOnce();
    expect((cell.querySelector("mcp-app-view") as TestMcpAppView | null)?.viewId).toBe(
      "short-renewed",
    );

    await vi.advanceTimersByTimeAsync(3_000);
    await settle(cell);
    expect(cell.querySelector('[data-test-id="board-mcp-app-stale"]')).not.toBeNull();
    expect(refreshWidgetAppView).toHaveBeenCalledOnce();
  });

  it("materializes only near-viewport cells on a full board", async () => {
    const visibility = stubVisibility((index) => index < 2);
    const widgetAppView = vi.fn(async (name: string) => ({
      status: "ready" as const,
      viewId: `view-${name}`,
      expiresAtMs: Date.now() + 60_000,
    }));
    const currentCallbacks = callbacks({ widgetAppView });

    for (let index = 0; index < 48; index += 1) {
      await mount(
        widget({ name: `app-${index}`, instanceId: `instance-${index}` }),
        currentCallbacks,
      );
    }

    await vi.waitFor(() => expect(visibility.observed()).toBe(48));
    await vi.waitFor(() => expect(widgetAppView).toHaveBeenCalledTimes(2));
  });

  it("restarts materialization when a disconnected cell is reattached", async () => {
    const widgetAppView = vi.fn(async () => ({
      status: "ready" as const,
      viewId: "reattached-view",
      expiresAtMs: Date.now() + 60_000,
    }));
    const cell = await mount(widget(), callbacks({ widgetAppView }));
    await vi.waitFor(() => expect(widgetAppView).toHaveBeenCalledOnce());

    cell.remove();
    await Promise.resolve();
    document.body.append(cell);
    await settle(cell);

    await vi.waitFor(() => expect(widgetAppView).toHaveBeenCalledTimes(2));
    expect(cell.querySelector("mcp-app-view")).not.toBeNull();
  });
});
