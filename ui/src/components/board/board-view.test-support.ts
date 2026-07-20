import { vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { BoardWidget } from "../../lib/board/types.ts";
import type { BoardViewCallbacks, BoardViewSnapshot } from "../../lib/board/view-types.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";

type OpenClawBoardView = HTMLElementTagNameMap["openclaw-board-view"];
type OpenClawBoardWidgetCell = HTMLElementTagNameMap["openclaw-board-widget-cell"];

export function boardWidget(overrides: Partial<BoardWidget> = {}): BoardWidget {
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

export function snapshot(overrides: Partial<BoardViewSnapshot> = {}): BoardViewSnapshot {
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

export function callbacks(overrides: Partial<BoardViewCallbacks> = {}): BoardViewCallbacks {
  return {
    applyOps: vi.fn(async () => undefined),
    grant: vi.fn(async () => undefined),
    selectTab: vi.fn(),
    ...overrides,
  };
}

export function gatewayContext(client: { request: ReturnType<typeof vi.fn> } | null) {
  return {
    gateway: {
      connection: { gatewayUrl: "" },
      snapshot: { client },
    },
  } as unknown as ApplicationContext<RouteId>;
}

export function deferred(): {
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

export function deferredValue<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

export async function settleCells(view: OpenClawBoardView): Promise<OpenClawBoardWidgetCell[]> {
  await view.updateComplete;
  const cells = [...view.querySelectorAll("openclaw-board-widget-cell")];
  await Promise.all(cells.map((cell) => cell.updateComplete));
  return cells;
}

export async function mount(
  options: {
    snapshot?: BoardViewSnapshot;
    activeTabId?: string;
    callbacks?: BoardViewCallbacks;
    widgetFrameUrl?: (name: string, revision: number) => string;
    sessions?: readonly GatewaySessionRow[];
    context?: ApplicationContext<RouteId>;
    canMutate?: boolean;
    canGrant?: boolean;
  } = {},
): Promise<OpenClawBoardView> {
  const view = document.createElement("openclaw-board-view");
  view.snapshot = options.snapshot ?? snapshot();
  view.activeTabId = options.activeTabId ?? "main";
  view.widgetFrameUrl = options.widgetFrameUrl ?? (() => "about:blank");
  view.callbacks = options.callbacks ?? callbacks();
  view.sessions = options.sessions ?? [];
  view.canMutate = options.canMutate ?? true;
  view.canGrant = options.canGrant ?? true;
  if (options.context) {
    const provider = createApplicationContextProvider(options.context);
    provider.append(view);
    document.body.append(provider);
  } else {
    document.body.append(view);
  }
  await settleCells(view);
  return view;
}
