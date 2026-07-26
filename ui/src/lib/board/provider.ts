import type {
  BoardCommand,
  BoardCommandEvent,
  BoardOp,
  BoardSnapshot,
} from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import {
  buildAgentMainSessionKey,
  normalizeSessionKeyForUiComparison,
} from "../sessions/session-key.ts";
import { GatewayBoardProvider } from "./gateway-provider.ts";
import { applyMockBoardOp, normalizeMockBoardSnapshot } from "./mock-ops.ts";
import {
  EventStream,
  ValueSignal,
  type BoardEventStream,
  type BoardSnapshotSignal,
} from "./provider-signals.ts";
import type { BoardProvider } from "./provider-types.ts";
import type { BoardWidgetAppViewState } from "./view-types.ts";
import { canvasWidgetNameForDocument, mcpAppWidgetNameForViewId } from "./widget-names.ts";
export type { BoardCommandEvent };
export type { BoardProvider } from "./provider-types.ts";
export type { BoardViewCallbacks, BoardWidgetAppViewState } from "./view-types.ts";
export { canvasWidgetNameForDocument, mcpAppWidgetNameForViewId } from "./widget-names.ts";
export { GatewayBoardProvider } from "./gateway-provider.ts";

type BoardGatewayClient = Pick<GatewayBrowserClient, "request" | "addEventListener">;

type BoardPinPlacement = {
  title?: string;
  name?: string;
  tabId?: string;
  size?: "sm" | "md" | "lg" | "xl" | "full";
  after?: string;
};

type BoardPinWidgetInput = BoardPinPlacement & { docId: string };
type BoardPinMcpAppInput = BoardPinPlacement & { viewId: string };

function emptySnapshot(sessionKey: string): BoardSnapshot {
  return { sessionKey, revision: 0, tabs: [], widgets: [] };
}

function boardWidgetTitle(title: string | undefined): string | undefined {
  const normalized = title?.trim() ?? "";
  return normalized ? Array.from(normalized).slice(0, 80).join("") : undefined;
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
  readonly canMutate = false;
  readonly canGrant = false;
  readonly canPinWidgets = false;
  readonly canPinMcpApps = false;
  readonly snapshot$: BoardSnapshotSignal<BoardSnapshot>;
  readonly events: BoardEventStream<BoardCommandEvent> = new EventStream<BoardCommandEvent>();

  constructor(readonly sessionKey = "") {
    this.snapshot$ = new ValueSignal(emptySnapshot(sessionKey));
  }

  async applyOps(_ops: BoardOp[]): Promise<void> {}

  async grant(_name: string, _decision: "granted" | "rejected"): Promise<void> {}

  async pinWidget(_input: BoardPinWidgetInput): Promise<void> {
    throw new Error("Session dashboard unavailable");
  }

  async pinMcpApp(_input: BoardPinMcpAppInput): Promise<void> {
    throw new Error("Session dashboard unavailable");
  }

  widgetFrameUrl(_name: string, _revision: number): string {
    return "";
  }

  async refreshWidgetFrame(_name: string): Promise<void> {}

  async widgetAppView(_name: string, _revision: number): Promise<BoardWidgetAppViewState> {
    return { status: "stale", error: "Session dashboard unavailable" };
  }

  async refreshWidgetAppView(_name: string, _revision: number): Promise<BoardWidgetAppViewState> {
    return { status: "stale", error: "Session dashboard unavailable" };
  }
}

class MockBoardProvider implements BoardProvider {
  readonly canMutate = true;
  readonly canGrant = true;
  readonly canPinWidgets = true;
  readonly canPinMcpApps = true;
  readonly snapshot$: BoardSnapshotSignal<BoardSnapshot>;
  readonly events: BoardEventStream<BoardCommandEvent>;
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
      snapshot = normalizeMockBoardSnapshot(applyMockBoardOp(snapshot, op));
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

  async pinWidget(input: BoardPinWidgetInput): Promise<void> {
    const snapshot = this.snapshotSignal.value;
    const name = input.name ?? canvasWidgetNameForDocument(input.docId);
    const title = boardWidgetTitle(input.title);
    const tabId = input.tabId ?? snapshot.tabs[0]?.tabId ?? "main";
    const tabs = snapshot.tabs.length
      ? snapshot.tabs
      : [
          {
            tabId: "main",
            title: t("chat.board.defaultTab"),
            position: 0,
            chatDock: "right" as const,
          },
        ];
    const existing = snapshot.widgets.find((widget) => widget.name === name);
    const widgets = snapshot.widgets.filter((widget) => widget.name !== name);
    widgets.push({
      name,
      tabId,
      ...(title ? { title } : {}),
      contentKind: "html",
      sizeW: existing?.sizeW ?? 6,
      sizeH: existing?.sizeH ?? 4,
      position: existing?.position ?? widgets.filter((widget) => widget.tabId === tabId).length,
      grantState: "none",
      revision: (existing?.revision ?? 0) + 1,
      frameUrl: `about:blank#board-widget=${encodeURIComponent(name)}`,
    });
    this.snapshotSignal.set(
      normalizeMockBoardSnapshot({ ...snapshot, revision: snapshot.revision + 1, tabs, widgets }),
    );
  }

  async pinMcpApp(input: BoardPinMcpAppInput): Promise<void> {
    const snapshot = this.snapshotSignal.value;
    const name = input.name ?? mcpAppWidgetNameForViewId(input.viewId);
    const title = boardWidgetTitle(input.title);
    const tabId = input.tabId ?? snapshot.tabs[0]?.tabId ?? "main";
    const tabs = snapshot.tabs.length
      ? snapshot.tabs
      : [
          {
            tabId: "main",
            title: t("chat.board.defaultTab"),
            position: 0,
            chatDock: "right" as const,
          },
        ];
    const existing = snapshot.widgets.find((widget) => widget.name === name);
    const widgets = snapshot.widgets.filter((widget) => widget.name !== name);
    widgets.push({
      name,
      tabId,
      ...(title ? { title } : {}),
      contentKind: "mcp-app",
      sizeW: existing?.sizeW ?? 6,
      sizeH: existing?.sizeH ?? 4,
      position: existing?.position ?? widgets.filter((widget) => widget.tabId === tabId).length,
      grantState: "none",
      revision: (existing?.revision ?? 0) + 1,
    });
    this.snapshotSignal.set(
      normalizeMockBoardSnapshot({
        ...snapshot,
        revision: snapshot.revision + 1,
        tabs,
        widgets,
      }),
    );
  }

  widgetFrameUrl(name: string, revision: number): string {
    return (
      this.snapshotSignal.value.widgets.find(
        (widget) => widget.name === name && widget.revision === revision,
      )?.frameUrl ?? `about:blank#board-widget=${encodeURIComponent(name)}&revision=${revision}`
    );
  }

  async refreshWidgetFrame(_name: string): Promise<void> {}

  async widgetAppView(_name: string, _revision: number): Promise<BoardWidgetAppViewState> {
    return { status: "stale", error: "MCP App mock view unavailable" };
  }

  async refreshWidgetAppView(name: string, revision: number): Promise<BoardWidgetAppViewState> {
    return await this.widgetAppView(name, revision);
  }

  emitCommand(command: BoardCommand): void {
    this.eventStream.emit({ sessionKey: this.sessionKey, command });
  }
}

const nullProviders = new Map<string, NullProvider>();
const mockProviders = new Map<string, MockBoardProvider>();
const gatewayProviders = new Map<string, { provider: GatewayBoardProvider; consumers: number }>();
const boardAvailability = new Map<string, boolean>();
let mockProviderScope: object | null = null;

function resolveMockBoardScope(): object | null {
  const location = globalThis.location;
  if (new URLSearchParams(location?.search ?? "").get("mockBoard") === "1") {
    return location;
  }
  return null;
}

export function isMockBoardEnabled(): boolean {
  return resolveMockBoardScope() !== null;
}

function isMockBoardSession(sessionKey: string): boolean {
  return /^agent:[^:]+:[^:]+$/u.test(sessionKey);
}

export function boardProviderCacheKey(sessionKey: string): string {
  const normalized = normalizeSessionKeyForUiComparison(sessionKey);
  return normalized === "main" ? buildAgentMainSessionKey({ agentId: "main" }) : normalized;
}

export function boardProviderForSession(
  sessionKey: string,
  client?: BoardGatewayClient | null,
  available = true,
  connected = true,
  canPinWidgets = available,
  canPinMcpApps = false,
  canMutate = available,
  canGrant = available,
): BoardProvider {
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
  if (!available) {
    let provider = nullProviders.get(key);
    if (!provider) {
      provider = new NullProvider(key);
      nullProviders.set(key, provider);
    }
    return provider;
  }
  if (client) {
    let entry = gatewayProviders.get(key);
    if (!entry) {
      const provider = new GatewayBoardProvider(
        key,
        client,
        connected,
        canPinWidgets,
        canPinMcpApps,
        canMutate,
        canGrant,
      );
      entry = { provider, consumers: 0 };
      gatewayProviders.set(key, entry);
    } else {
      entry.provider.attachClient(
        client,
        connected,
        canPinWidgets,
        canPinMcpApps,
        canMutate,
        canGrant,
      );
    }
    return entry.provider;
  }
  const gatewayProvider = gatewayProviders.get(key)?.provider;
  if (gatewayProvider) {
    return gatewayProvider;
  }
  let provider = nullProviders.get(key);
  if (!provider) {
    provider = new NullProvider(key);
    nullProviders.set(key, provider);
  }
  return provider;
}

export type BoardProviderLease = {
  provider: BoardProvider;
  release: () => void;
};

export function acquireBoardProviderForSession(
  sessionKey: string,
  client: BoardGatewayClient,
  connected = true,
  canPinWidgets = true,
  canPinMcpApps = false,
  canMutate = true,
  canGrant = true,
): BoardProviderLease {
  const key = boardProviderCacheKey(sessionKey);
  const provider = boardProviderForSession(
    key,
    client,
    true,
    connected,
    canPinWidgets,
    canPinMcpApps,
    canMutate,
    canGrant,
  );
  const entry = gatewayProviders.get(key);
  if (!entry || entry.provider !== provider) {
    return { provider, release: () => undefined };
  }
  entry.consumers += 1;
  let released = false;
  return {
    provider,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      const current = gatewayProviders.get(key);
      if (!current || current.provider !== provider) {
        return;
      }
      current.consumers -= 1;
      if (current.consumers > 0) {
        return;
      }
      if (current.provider.hasLoadedSnapshot) {
        boardAvailability.set(key, boardExists(current.provider.snapshot$.value));
      }
      gatewayProviders.delete(key);
      current.provider.dispose();
    },
  };
}

export function recordSessionBoardAvailability(sessionKey: string, available: boolean): boolean {
  const key = boardProviderCacheKey(sessionKey);
  const previous = boardAvailability.get(key);
  boardAvailability.set(key, available);
  return previous !== available;
}

export function clearSessionBoardAvailability(): boolean {
  const changed = boardAvailability.size > 0;
  boardAvailability.clear();
  return changed;
}

export function sessionHasBoard(sessionKey: string): boolean {
  const key = boardProviderCacheKey(sessionKey);
  const provider = gatewayProviders.get(key)?.provider ?? mockProviders.get(key);
  return provider ? boardExists(provider.snapshot$.value) : (boardAvailability.get(key) ?? false);
}
