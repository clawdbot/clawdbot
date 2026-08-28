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
import { emptyBoardSnapshot, normalizeBoardWidgetTitle } from "./provider-helpers.ts";
import {
  EventStream,
  ValueSignal,
  type BoardEventStream,
  type BoardSnapshotSignal,
} from "./provider-signals.ts";
import type { BoardPinMcpAppInput, BoardPinWidgetInput, BoardProvider } from "./provider-types.ts";
import type { BoardWidgetAppViewState } from "./view-types.ts";
import { canvasWidgetNameForDocument, mcpAppWidgetNameForViewId } from "./widget-names.ts";
export type { BoardCommandEvent };
export type { BoardProvider } from "./provider-types.ts";
export type { BoardViewCallbacks, BoardWidgetAppViewState } from "./view-types.ts";
export { canvasWidgetNameForDocument, mcpAppWidgetNameForViewId } from "./widget-names.ts";

type BoardGatewayClient = Pick<GatewayBrowserClient, "request" | "addEventListener">;

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
  readonly appViewGeneration = 0;
  readonly canMutate = false;
  readonly canGrant = false;
  readonly canPinWidgets = false;
  readonly canPinMcpApps = false;
  readonly loadError$ = new ValueSignal<string | null>(null);
  readonly snapshot$: BoardSnapshotSignal<BoardSnapshot>;
  readonly events: BoardEventStream<BoardCommandEvent> = new EventStream<BoardCommandEvent>();

  constructor(readonly sessionKey = "") {
    this.snapshot$ = new ValueSignal(emptyBoardSnapshot(sessionKey));
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
  readonly appViewGeneration = 0;
  readonly canMutate = true;
  readonly canGrant = true;
  readonly canPinWidgets = true;
  readonly canPinMcpApps = true;
  readonly loadError$ = new ValueSignal<string | null>(null);
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
    const name = input.name ?? canvasWidgetNameForDocument(input.docId);
    this.pinMockBoardWidget(input, name, "html");
  }

  async pinMcpApp(input: BoardPinMcpAppInput): Promise<void> {
    const name = input.name ?? mcpAppWidgetNameForViewId(input.viewId);
    this.pinMockBoardWidget(input, name, "mcp-app");
  }

  private pinMockBoardWidget(
    input: BoardPinWidgetInput | BoardPinMcpAppInput,
    name: string,
    contentKind: "html" | "mcp-app",
  ): void {
    const snapshot = this.snapshotSignal.value;
    const title = normalizeBoardWidgetTitle(input.title);
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
      contentKind,
      sizeW: existing?.sizeW ?? 6,
      sizeH: existing?.sizeH ?? 4,
      position: existing?.position ?? widgets.filter((widget) => widget.tabId === tabId).length,
      grantState: "none",
      revision: (existing?.revision ?? 0) + 1,
      ...(contentKind === "html"
        ? { frameUrl: `about:blank#board-widget=${encodeURIComponent(name)}` }
        : {}),
    });
    this.snapshotSignal.set(
      normalizeMockBoardSnapshot({ ...snapshot, revision: snapshot.revision + 1, tabs, widgets }),
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

type BoardProviderCapabilities = Pick<
  BoardProvider,
  "canPinWidgets" | "canPinMcpApps" | "canMutate" | "canGrant"
>;

// Snapshots and gateway subscriptions are session-owned, but authority belongs
// to each live consumer; sharing it would let another dashboard widen an action.
class ScopedGatewayBoardProvider implements BoardProvider {
  readonly loadError$: BoardSnapshotSignal<string | null>;
  readonly snapshot$: BoardSnapshotSignal<BoardSnapshot>;
  readonly events: BoardEventStream<BoardCommandEvent>;
  private active = true;

  constructor(
    private readonly transport: GatewayBoardProvider,
    private capabilities: BoardProviderCapabilities,
  ) {
    this.loadError$ = transport.loadError$;
    this.snapshot$ = transport.snapshot$;
    this.events = transport.events;
  }

  get sessionKey(): string {
    return this.transport.sessionKey;
  }

  get appViewGeneration(): number {
    return this.transport.appViewGeneration;
  }

  get canPinWidgets(): boolean {
    return this.active && this.capabilities.canPinWidgets;
  }

  get canPinMcpApps(): boolean {
    return this.active && this.capabilities.canPinMcpApps;
  }

  get canMutate(): boolean {
    return this.active && this.capabilities.canMutate;
  }

  get canGrant(): boolean {
    return this.active && this.capabilities.canGrant;
  }

  get hasLoadedSnapshot(): boolean {
    return this.transport.hasLoadedSnapshot;
  }

  updateCapabilities(capabilities: BoardProviderCapabilities): void {
    if (this.active) {
      this.capabilities = capabilities;
    }
  }

  deactivate(): void {
    this.active = false;
  }

  async applyOps(ops: BoardOp[]): Promise<void> {
    if (!this.canMutate) {
      throw new Error("Session dashboard mutation unavailable");
    }
    await this.transport.applyOps(ops);
  }

  async grant(name: string, decision: "granted" | "rejected"): Promise<void> {
    if (!this.canGrant) {
      throw new Error("Session dashboard approval unavailable");
    }
    await this.transport.grant(name, decision);
  }

  async pinWidget(input: BoardPinWidgetInput): Promise<void> {
    if (!this.canMutate || !this.canPinWidgets) {
      throw new Error("Session dashboard widget pinning unavailable");
    }
    await this.transport.pinWidget(input);
  }

  async pinMcpApp(input: BoardPinMcpAppInput): Promise<void> {
    if (!this.canMutate || !this.canPinMcpApps) {
      throw new Error("Session dashboard MCP App pinning unavailable");
    }
    await this.transport.pinMcpApp(input);
  }

  widgetFrameUrl(name: string, revision: number): string {
    return this.transport.widgetFrameUrl(name, revision);
  }

  refreshWidgetFrame(name: string): Promise<void> {
    return this.transport.refreshWidgetFrame(name);
  }

  widgetAppView(name: string, revision: number): Promise<BoardWidgetAppViewState> {
    return this.transport.widgetAppView(name, revision);
  }

  refreshWidgetAppView(name: string, revision: number): Promise<BoardWidgetAppViewState> {
    return this.transport.refreshWidgetAppView(name, revision);
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

// Session lookups are read-only: only a lifecycle-owned lease may create and
// subscribe a gateway transport, so hidden panes cannot orphan subscriptions.
export function boardProviderForSession(sessionKey: string, available = true): BoardProvider {
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
  const gatewayProvider = available ? gatewayProviders.get(key)?.provider : undefined;
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
  update: (
    client: BoardGatewayClient,
    connected: boolean,
    capabilities: BoardProviderCapabilities,
  ) => void;
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
  const provider = boardProviderForSession(key);
  if (provider instanceof MockBoardProvider) {
    return { provider, update: () => undefined, release: () => undefined };
  }
  let entry = gatewayProviders.get(key);
  if (!entry) {
    entry = { provider: new GatewayBoardProvider(key, client, connected), consumers: 0 };
    gatewayProviders.set(key, entry);
  } else {
    entry.provider.attachClient(client, connected);
  }
  const scopedProvider = new ScopedGatewayBoardProvider(entry.provider, {
    canPinWidgets,
    canPinMcpApps,
    canMutate,
    canGrant,
  });
  entry.consumers += 1;
  let released = false;
  return {
    provider: scopedProvider,
    update: (nextClient, nextConnected, capabilities) => {
      if (released || gatewayProviders.get(key)?.provider !== entry.provider) {
        return;
      }
      scopedProvider.updateCapabilities(capabilities);
      entry.provider.attachClient(nextClient, nextConnected);
    },
    release: () => {
      if (released) {
        return;
      }
      released = true;
      scopedProvider.deactivate();
      const current = gatewayProviders.get(key);
      if (!current || current.provider !== entry.provider) {
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

export function hasLoadedBoardSnapshot(provider: BoardProvider): boolean {
  if (provider instanceof GatewayBoardProvider || provider instanceof ScopedGatewayBoardProvider) {
    return provider.hasLoadedSnapshot;
  }
  return true;
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
  // An unloaded gateway provider holds a placeholder, not an authoritative empty board.
  if (provider instanceof GatewayBoardProvider && !provider.hasLoadedSnapshot) {
    return boardAvailability.get(key) ?? false;
  }
  return provider ? boardExists(provider.snapshot$.value) : (boardAvailability.get(key) ?? false);
}
