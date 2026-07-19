import { t } from "../../i18n/index.ts";
import {
  buildAgentMainSessionKey,
  normalizeSessionKeyForUiComparison,
} from "../sessions/session-key.ts";
import type { BoardOp, BoardSnapshot, BoardTab } from "./types.ts";

type BoardCommand =
  | { kind: "focus_tab"; tabId: string }
  | { kind: "set_chat_dock"; dock: BoardTab["chatDock"] };

export type BoardCommandEvent = {
  sessionKey: string;
  command: BoardCommand;
};

type BoardSnapshotSignal = {
  readonly value: BoardSnapshot;
  subscribe(listener: () => void): () => void;
};

type BoardEventStream = {
  subscribe(listener: (event: BoardCommandEvent) => void): () => void;
};

export type BoardProvider = {
  readonly snapshot$: BoardSnapshotSignal;
  applyOps(ops: BoardOp[]): Promise<void>;
  grant(name: string, decision: "granted" | "rejected"): Promise<void>;
  readonly events: BoardEventStream;
};

export type BoardViewCallbacks = {
  applyOps(ops: BoardOp[]): Promise<void>;
  grant(name: string, decision: "granted" | "rejected"): Promise<void>;
  selectTab(tabId: string): void;
  pinRequest?: never;
};

class ValueSignal<T> {
  private readonly listeners = new Set<() => void>();

  constructor(public value: T) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(value: T): void {
    this.value = value;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

class EventStream<T> {
  private readonly listeners = new Set<(event: T) => void>();

  subscribe(listener: (event: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: T): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function emptySnapshot(sessionKey: string): BoardSnapshot {
  return { sessionKey, revision: 0, tabs: [], widgets: [] };
}

function mockSnapshot(sessionKey: string): BoardSnapshot {
  return {
    sessionKey,
    revision: 1,
    tabs: [
      { tabId: "main", title: t("chat.board.mockOverview"), position: 0, chatDock: "right" },
      {
        tabId: "research",
        title: t("chat.board.mockResearch"),
        position: 1,
        chatDock: "bottom",
      },
    ],
    widgets: [
      {
        name: "session-status",
        tabId: "main",
        title: t("chat.board.mockSessionStatus"),
        contentKind: "html",
        sizeW: 4,
        sizeH: 3,
        position: 0,
        grantState: "granted",
        revision: 1,
      },
      {
        name: "recent-findings",
        tabId: "main",
        title: t("chat.board.mockRecentFindings"),
        contentKind: "mcp-app",
        sizeW: 8,
        sizeH: 6,
        position: 1,
        grantState: "pending",
        revision: 1,
      },
      {
        name: "source-map",
        tabId: "research",
        title: t("chat.board.mockSourceMap"),
        contentKind: "html",
        sizeW: 12,
        sizeH: 8,
        position: 0,
        grantState: "none",
        revision: 1,
      },
    ],
  };
}

export function boardExists(snapshot: BoardSnapshot): boolean {
  return snapshot.tabs.length > 0 || snapshot.widgets.length > 0;
}

class NullProvider implements BoardProvider {
  readonly snapshot$: BoardSnapshotSignal;
  readonly events: BoardEventStream = new EventStream<BoardCommandEvent>();

  constructor(sessionKey = "") {
    this.snapshot$ = new ValueSignal(emptySnapshot(sessionKey));
  }

  async applyOps(_ops: BoardOp[]): Promise<void> {}

  async grant(_name: string, _decision: "granted" | "rejected"): Promise<void> {}
}

class MockBoardProvider implements BoardProvider {
  readonly snapshot$: BoardSnapshotSignal;
  readonly events: BoardEventStream;
  private readonly snapshotSignal: ValueSignal<BoardSnapshot>;
  private readonly eventStream = new EventStream<BoardCommandEvent>();

  constructor(readonly sessionKey: string) {
    this.snapshotSignal = new ValueSignal(mockSnapshot(sessionKey));
    this.snapshot$ = this.snapshotSignal;
    this.events = this.eventStream;
  }

  async applyOps(ops: BoardOp[]): Promise<void> {
    let snapshot = this.snapshotSignal.value;
    for (const op of ops) {
      snapshot = normalizeMockSnapshot(applyMockOp(snapshot, op));
    }
    this.snapshotSignal.set({ ...snapshot, revision: snapshot.revision + 1 });
  }

  async grant(name: string, decision: "granted" | "rejected"): Promise<void> {
    const snapshot = this.snapshotSignal.value;
    const widgets = snapshot.widgets.slice();
    const widgetIndex = widgets.findIndex((widget) => widget.name === name);
    const widget = widgets[widgetIndex];
    if (widget) {
      widgets[widgetIndex] = { ...widget, grantState: decision };
    }
    this.snapshotSignal.set({
      ...snapshot,
      revision: snapshot.revision + 1,
      widgets,
    });
  }

  emitCommand(command: BoardCommand): void {
    this.eventStream.emit({ sessionKey: this.sessionKey, command });
  }
}

function normalizeMockSnapshot(snapshot: BoardSnapshot): BoardSnapshot {
  const tabs = snapshot.tabs
    .toSorted((left, right) => left.position - right.position)
    .map((tab, position) => Object.assign({}, tab, { position }));
  const tabPositions = new Map(tabs.map((tab) => [tab.tabId, tab.position]));
  const nextWidgetPosition = new Map<string, number>();
  const widgets = snapshot.widgets
    .toSorted((left, right) => {
      const tabDelta =
        (tabPositions.get(left.tabId) ?? Number.MAX_SAFE_INTEGER) -
        (tabPositions.get(right.tabId) ?? Number.MAX_SAFE_INTEGER);
      return tabDelta || left.position - right.position;
    })
    .map((widget) => {
      const position = nextWidgetPosition.get(widget.tabId) ?? 0;
      nextWidgetPosition.set(widget.tabId, position + 1);
      return Object.assign({}, widget, { position });
    });
  return { ...snapshot, tabs, widgets };
}

function applyMockOp(snapshot: BoardSnapshot, op: BoardOp): BoardSnapshot {
  switch (op.kind) {
    case "tab_create":
      if (snapshot.tabs.some((tab) => tab.tabId === op.tabId)) {
        return snapshot;
      }
      return {
        ...snapshot,
        tabs: [
          ...snapshot.tabs,
          {
            tabId: op.tabId,
            title: op.title,
            position: snapshot.tabs.length,
            chatDock: op.chatDock ?? "right",
          },
        ],
      };
    case "tab_update": {
      const orderedTabs = snapshot.tabs.toSorted((left, right) => left.position - right.position);
      const tabIndex = orderedTabs.findIndex((tab) => tab.tabId === op.tabId);
      if (tabIndex < 0) {
        return snapshot;
      }
      const [tab] = orderedTabs.splice(tabIndex, 1);
      const updated = {
        ...tab!,
        ...(op.title !== undefined ? { title: op.title } : {}),
        ...(op.chatDock !== undefined ? { chatDock: op.chatDock } : {}),
      };
      const position = Math.max(
        0,
        Math.min(
          op.position === undefined ? tabIndex : Math.trunc(op.position),
          orderedTabs.length,
        ),
      );
      orderedTabs.splice(position, 0, updated);
      return {
        ...snapshot,
        tabs: orderedTabs.map((candidate, nextPosition) =>
          Object.assign({}, candidate, { position: nextPosition }),
        ),
      };
    }
    case "tab_delete": {
      const remainingTabs = snapshot.tabs.filter((tab) => tab.tabId !== op.tabId);
      if (remainingTabs.length === 0 && snapshot.widgets.length > 0) {
        return snapshot;
      }
      const firstTabId = remainingTabs[0]?.tabId;
      return {
        ...snapshot,
        tabs: remainingTabs,
        widgets: snapshot.widgets.map((widget) =>
          widget.tabId === op.tabId && firstTabId
            ? { ...widget, tabId: firstTabId, position: Number.MAX_SAFE_INTEGER }
            : widget,
        ),
      };
    }
    case "tabs_reorder": {
      const requestedTabIds = new Set(op.tabIds);
      if (
        op.tabIds.length !== snapshot.tabs.length ||
        requestedTabIds.size !== snapshot.tabs.length ||
        snapshot.tabs.some((tab) => !requestedTabIds.has(tab.tabId))
      ) {
        return snapshot;
      }
      return {
        ...snapshot,
        tabs: op.tabIds.flatMap((tabId, position) => {
          const tab = snapshot.tabs.find((candidate) => candidate.tabId === tabId);
          return tab ? [{ ...tab, position }] : [];
        }),
      };
    }
    case "widget_move": {
      const moving = snapshot.widgets.find((widget) => widget.name === op.name);
      const anchor = op.after
        ? snapshot.widgets.find((widget) => widget.name === op.after)
        : undefined;
      if (!moving || (op.after && (!anchor || anchor.name === moving.name))) {
        return snapshot;
      }
      const targetTabId = op.tabId ?? moving.tabId;
      if (
        (op.position !== undefined && op.after !== undefined) ||
        !snapshot.tabs.some((tab) => tab.tabId === targetTabId) ||
        (anchor && anchor.tabId !== targetTabId)
      ) {
        return snapshot;
      }
      const remaining = snapshot.widgets.filter((widget) => widget.name !== moving.name);
      const targetWidgets = remaining
        .filter((widget) => widget.tabId === targetTabId)
        .toSorted((left, right) => left.position - right.position);
      const anchorIndex = anchor
        ? targetWidgets.findIndex((widget) => widget.name === anchor.name)
        : -1;
      const insertionIndex = anchor
        ? anchorIndex + 1
        : Math.max(0, Math.min(op.position ?? targetWidgets.length, targetWidgets.length));
      targetWidgets.splice(insertionIndex, 0, { ...moving, tabId: targetTabId });
      return {
        ...snapshot,
        widgets: snapshot.tabs.flatMap((tab) =>
          (tab.tabId === targetTabId
            ? targetWidgets
            : remaining
                .filter((widget) => widget.tabId === tab.tabId)
                .toSorted((left, right) => left.position - right.position)
          ).map((widget, position) => Object.assign({}, widget, { position })),
        ),
      };
    }
    case "widget_resize":
      return {
        ...snapshot,
        widgets: snapshot.widgets.map((widget) =>
          widget.name === op.name
            ? {
                ...widget,
                sizeW: Math.min(12, Math.max(1, Math.trunc(op.sizeW))),
                sizeH: Math.min(20, Math.max(1, Math.trunc(op.sizeH))),
              }
            : widget,
        ),
      };
    case "widget_remove":
      return { ...snapshot, widgets: snapshot.widgets.filter((widget) => widget.name !== op.name) };
  }
  return snapshot;
}

const nullProviders = new Map<string, NullProvider>();
const mockProviders = new Map<string, MockBoardProvider>();
let mockProviderScope: object | null = null;

function resolveMockBoardScope(): object | null {
  const location = globalThis.location;
  if (new URLSearchParams(location?.search ?? "").get("mockBoard") === "1") {
    return location;
  }
  return (
    (typeof document !== "undefined" &&
      document.querySelector("script[data-openclaw-control-ui-mock-gateway]")) ||
    null
  );
}

export function isMockBoardEnabled(): boolean {
  return resolveMockBoardScope() !== null;
}

function isMockBoardSession(sessionKey: string): boolean {
  return /^agent:[^:]+:[^:]+$/u.test(sessionKey);
}

function boardProviderCacheKey(sessionKey: string): string {
  const normalized = normalizeSessionKeyForUiComparison(sessionKey);
  return normalized === "main" ? buildAgentMainSessionKey({ agentId: "main" }) : normalized;
}

export function boardProviderForSession(sessionKey: string): BoardProvider {
  const key = boardProviderCacheKey(sessionKey);
  const mockScope = resolveMockBoardScope();
  if (mockScope && isMockBoardSession(key)) {
    if (mockScope !== mockProviderScope) {
      mockProviders.clear();
      mockProviderScope = mockScope;
    }
    let provider = mockProviders.get(key);
    if (!provider) {
      provider = new MockBoardProvider(key);
      mockProviders.set(key, provider);
    }
    return provider;
  }
  let provider = nullProviders.get(key);
  if (!provider) {
    provider = new NullProvider(key);
    nullProviders.set(key, provider);
  }
  return provider;
}

export function sessionHasBoard(sessionKey: string): boolean {
  return boardExists(boardProviderForSession(sessionKey).snapshot$.value);
}
